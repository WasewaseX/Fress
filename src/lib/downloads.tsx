import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { translate, useI18n } from './i18n';

export type DownloadStatus = 'active' | 'completed' | 'error' | 'cancelled' | 'browser' | 'page';

export interface DownloadItem {
  id: number;
  url: string;
  name: string;
  dir: string;
  /** Catalog id that requested this download (used to show per-app state). */
  appRef?: string;
  bytes: number;
  total: number;
  speed: number;
  eta: number;
  status: DownloadStatus;
  error?: string;
  path?: string;
  sha256?: string;
  /** Publisher hash this download is verified against (kept for retry). */
  expectedSha256?: string;
  /** True when the finished file matched the publisher's own checksum. */
  verified?: boolean;
  startedAt: number;
}

const DIR_KEY = 'fress.downloadDir';

/** Monotonic id for panel entries that never hit the Rust registry. */
let externalEntryId = -1;
function nextExternalId(): number {
  externalEntryId -= 1;
  return externalEntryId;
}

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** Stable action surface — the identity of every function never changes. */
interface DownloadsActions {
  startDownload: (url: string, nameHint?: string, appRef?: string, expectedSha256?: string) => Promise<boolean>;
  recordExternalOpen: (name: string, url: string) => void;
  cancel: (id: number) => void;
  retry: (id: number) => void;
  clearFinished: () => void;
  openFile: (path: string) => void;
  openFolder: (path?: string) => void;
  chooseFolder: () => Promise<void>;
  resetFolder: () => Promise<void>;
}

/** Volatile state surface — changes as downloads progress. */
interface DownloadsState {
  items: DownloadItem[];
  activeCount: number;
  downloadDir: string | null;
}

const DownloadsActionsContext = createContext<DownloadsActions | null>(null);
const DownloadsStateContext = createContext<DownloadsState | null>(null);

export function DownloadsProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<DownloadItem[]>([]);
  const [downloadDir, setDownloadDir] = useState<string | null>(null);
  const itemsRef = useRef<DownloadItem[]>([]);
  itemsRef.current = items;
  // External selectors (useSyncExternalStore) read this snapshot; it is kept
  // in sync during render, and subscribers are notified after each commit.
  snapshotRef.current = items;
  downloadDirSnapshot.current = downloadDir;
  const { t } = useI18n();
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    notifyItems();
  }, [items]);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    // A listener that resolves after cleanup must unregister itself at once,
    // or unmount (StrictMode double-mount, fast navigation) leaks duplicates
    // that fire every event twice.
    const register = (p: Promise<() => void>) => {
      p.then((un) => {
        if (disposed) {
          un();
        } else {
          unlisteners.push(un);
        }
      }).catch(() => undefined);
    };

    invoke<string>('default_download_dir')
      .then((dir) => {
        try {
          const saved = localStorage.getItem(DIR_KEY);
          setDownloadDirNotified(saved || dir);
        } catch {
          setDownloadDirNotified(dir);
        }
      })
      .catch(() => setDownloadDirNotified(null));

    register(
      listen<{ id: number; downloaded: number; total: number; speed_bps: number; eta_secs: number }>(
        'download-progress',
        (event) => {
          const p = event.payload;
          setItems((prev) =>
            prev.map((it) =>
              it.id === p.id
                ? {
                    ...it,
                    bytes: p.downloaded,
                    total: p.total,
                    speed: p.speed_bps,
                    eta: p.eta_secs,
                  }
                : it
            )
          );
        }
      )
    );

    register(
      listen<{ id: number; path: string; bytes: number; sha256: string; verified?: boolean }>('download-complete', (event) => {
        const p = event.payload;
        const finishedName = p.path.split(/[\\/]/).pop() || 'download';
        // Upsert: a very fast download can complete before the optimistic entry
        // is added, so map-only updates would silently drop it from the panel.
        setItems((prev) => {
          const existing = prev.find((it) => it.id === p.id);
          if (existing) {
            return prev.map((it) =>
              it.id === p.id ? { ...it, status: 'completed' as const, path: p.path, bytes: p.bytes, sha256: p.sha256, verified: p.verified === true, total: p.bytes, speed: 0, eta: 0 } : it
            );
          }
          return [
            {
              id: p.id,
              url: '',
              name: finishedName,
              dir: '',
              bytes: p.bytes,
              total: p.bytes,
              speed: 0,
              eta: 0,
              status: 'completed' as const,
              path: p.path,
              sha256: p.sha256,
              verified: p.verified === true,
              startedAt: Date.now(),
            },
            ...prev,
          ];
        });
        toast.success(tRef.current('toast.downloadComplete').replace('{name}', finishedName), {
          description: p.verified === true
            ? tRef.current('toast.downloadVerified')
            : p.path,
        });
      })
    );

    register(
      listen<{ id: number; message: string }>('download-error', (event) => {
        const p = event.payload;
        if (p.message === 'Cancelled') {
          setItems((prev) => prev.map((it) => (it.id === p.id ? { ...it, status: 'cancelled' } : it)));
          toast.info(tRef.current('toast.downloadCancelled'));
        } else {
          setItems((prev) =>
            prev.some((it) => it.id === p.id)
              ? prev.map((it) => (it.id === p.id ? { ...it, status: 'error', error: p.message } : it))
              : prev
          );
          toast.error(tRef.current('toast.downloadFailed'), { description: p.message });
        }
      })
    );

    return () => {
      disposed = true;
      unlisteners.forEach((un) => un());
    };
  }, []);

  const startDownload = useCallback(
    async (url: string, nameHint?: string, appRef?: string, expectedSha256?: string): Promise<boolean> => {
      if (!url || !/^https?:\/\//i.test(url)) {
        toast.error(tRef.current('toast.notDirectLink'));
        return false;
      }

      const guessedName = (() => {
        const raw = nameHint || url.split('/').pop()?.split('?')[0] || '';
        try {
          return decodeURIComponent(raw) || undefined;
        } catch {
          return raw || undefined;
        }
      })();

      if (!isTauri()) {
        // Browser fallback (web preview / dev in a normal tab):
        // open a NEW tab, record it in the panel, explain. Never navigate away.
        const opened = window.open(url, '_blank', 'noopener,noreferrer');
        if (!opened) {
          // Popup blocked: say the truth (nothing opened) instead of claiming
          // a tab was opened, and leave the panel empty so retry is clean.
          toast.error(tRef.current('toast.popupBlocked'), {
            description: tRef.current('toast.allowPopups'),
          });
          return false;
        }
        setItems((prev) => [
          {
            id: nextExternalId(),
            url,
            name: guessedName || url,
            dir: 'Browser downloads folder',
            appRef,
            bytes: 0,
            total: 0,
            speed: 0,
            eta: 0,
            status: 'browser',
            startedAt: Date.now(),
          },
          ...prev,
        ]);
        toast.info(tRef.current('toast.browserFallbackTitle'), {
          description: tRef.current('toast.browserFallbackBody'),
        });
        return true;
      }

      let dir: string;
      try {
        const saved = localStorage.getItem(DIR_KEY);
        dir = saved || (await invoke<string>('default_download_dir'));
      } catch {
        // The command itself never fails in practice; if it did, let the
        // Rust side pick its own default by passing no directory at all.
        dir = '';
      }

      try {
        const id = await invoke<number>('start_download', {
          url,
          filename: guessedName || null,
          directory: dir || null,
          expectedSha256: expectedSha256 || null,
        });
        setItems((prev) => [
          {
            id,
            url,
            name: guessedName || 'download',
            dir,
            appRef,
            bytes: 0,
            total: 0,
            speed: 0,
            eta: 0,
            status: 'active',
            expectedSha256,
            startedAt: Date.now(),
          },
          ...prev,
        ]);
        toast.info(tRef.current('toast.downloadStarted'), { description: guessedName || url });
        return true;
      } catch (e) {
        toast.error(tRef.current('toast.couldNotStart'), { description: String(e) });
        return false;
      }
    },
    []
  );

  const cancel = useCallback((id: number) => {
    invoke('cancel_download', { id }).catch(() => undefined);
  }, []);

  const retry = useCallback(
    (id: number) => {
      const item = itemsRef.current.find((it) => it.id === id);
      if (item) {
        // Keep the old entry until the new run is confirmed started, so a
        // rejection (cap reached, stale folder) does not lose the failure.
        // The publisher hash travels with the retry — verification must not
        // silently downgrade to "unchecked".
        void startDownload(item.url, item.name, item.appRef, item.expectedSha256).then((ok) => {
          if (ok) {
            setItems((prev) => prev.filter((it) => it.id !== id));
          }
        });
      }
    },
    [startDownload]
  );

  const recordExternalOpen = useCallback((name: string, url: string) => {
    setItems((prev) => [
      {
        id: nextExternalId(),
        url,
        name,
        dir: 'Official website',
        bytes: 0,
        total: 0,
        speed: 0,
        eta: 0,
        status: 'page',
        startedAt: Date.now(),
      },
      ...prev.filter((it) => it.url !== url || it.status !== 'page'),
    ]);
  }, []);

  const clearFinished = useCallback(() => {
    setItems((prev) => prev.filter((it) => it.status === 'active'));
  }, []);

  const openFile = useCallback((path: string) => {
    if (isTauri()) {
      // Rust-side command: only paths the engine wrote can be opened.
      invoke('open_downloaded_file', { path }).catch(() =>
        toast.error(tRef.current('toast.couldNotOpenFile'))
      );
    }
  }, []);

  const openFolder = useCallback((path?: string) => {
    if (!isTauri()) return;
    if (path) {
      invoke('reveal_downloaded_file', { path }).catch(() =>
        toast.error(tRef.current('toast.couldNotOpenFolder'))
      );
    } else {
      invoke('open_download_folder', { dir: downloadDir || null }).catch(() =>
        toast.error(tRef.current('toast.couldNotOpenFolder'))
      );
    }
  }, [downloadDir]);

  const setDownloadDirNotified = useCallback((next: string | null) => {
    downloadDirSnapshot.current = next;
    setDownloadDir(next);
    notifyItems();
  }, []);

  const chooseFolder = useCallback(async () => {
    if (!isTauri()) {
      toast.info(tRef.current('toast.folderPickerDesktopOnly'));
      return;
    }
    // Rust shows the native dialog and registers the result as the only
    // approved download root — the webview cannot declare paths itself.
    try {
      const selected = await invoke<string | null>('pick_download_dir');
      if (typeof selected === 'string' && selected) {
        setDownloadDirNotified(selected);
        try {
          localStorage.setItem(DIR_KEY, selected);
        } catch {
          // ignore
        }
        toast.success(tRef.current('toast.folderUpdated'), { description: selected });
      }
    } catch (e) {
      // The picker is cooldown-guarded; a rejected invoke must never surface
      // as an unhandled promise rejection.
      toast.error(tRef.current('toast.couldNotPickFolder'), { description: String(e) });
    }
  }, [setDownloadDirNotified]);

  const resetFolder = useCallback(async () => {
    if (!isTauri()) {
      toast.info(tRef.current('toast.folderSettingsDesktopOnly'));
      return;
    }
    try {
      localStorage.removeItem(DIR_KEY);
      // Also revoke every folder approved through the native picker.
      await invoke('revoke_approved_dirs');
    } catch {
      // ignore
    }
    try {
      const dir = await invoke<string>('default_download_dir');
      setDownloadDirNotified(dir);
      toast.success(tRef.current('toast.folderReset'), { description: dir });
    } catch {
      setDownloadDirNotified(null);
    }
  }, [setDownloadDirNotified]);

  const activeCount = items.filter((it) => it.status === 'active').length;

  const actions = useMemo<DownloadsActions>(
    () => ({ startDownload, recordExternalOpen, cancel, retry, clearFinished, openFile, openFolder, chooseFolder, resetFolder }),
    [startDownload, recordExternalOpen, cancel, retry, clearFinished, openFile, openFolder, chooseFolder, resetFolder]
  );
  const state = useMemo<DownloadsState>(() => ({ items, activeCount, downloadDir }), [items, activeCount, downloadDir]);

  return (
    <DownloadsActionsContext.Provider value={actions}>
      <DownloadsStateContext.Provider value={state}>
        {children}
      </DownloadsStateContext.Provider>
    </DownloadsActionsContext.Provider>
  );
}

/** Actions only — components that never read progress skip all re-renders. */
export function useDownloadActions(): DownloadsActions {
  const ctx = useContext(DownloadsActionsContext);
  if (!ctx) throw new Error('useDownloadActions must be used inside DownloadsProvider');
  return ctx;
}

/** Full state + actions — for the download manager panel itself. */
export function useDownloads(): DownloadsActions & DownloadsState {
  const actions = useDownloadActions();
  const state = useContext(DownloadsStateContext);
  if (!state) throw new Error('useDownloads must be used inside DownloadsProvider');
  return { ...actions, ...state };
}

// ---- external store -------------------------------------------------------
// Progress events arrive ~10x per second; a context consumer re-renders on
// every one of them. Subscribing through useSyncExternalStore with a selector
// lets a component react ONLY when its selected slice actually changes: a
// card re-renders when its own download flips state, the header when the
// active count changes — the other 56 cards sit still.

type Listener = () => void;
const listeners = new Set<Listener>();

function subscribeItems(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyItems() {
  listeners.forEach((l) => l());
}

export function useDownloadSelector<T>(selector: (items: DownloadItem[]) => T): T {
  const getSnapshot = () => selector(itemsRefSnapshot());
  return useSyncExternalStore(subscribeItems, getSnapshot, getSnapshot);
}

// The selector reads through a ref that the provider keeps fresh; events
// mutate state, and every state commit notifies the subscribed selectors.
const snapshotRef: { current: DownloadItem[] } = { current: [] };
const downloadDirSnapshot: { current: string | null } = { current: null };
function itemsRefSnapshot(): DownloadItem[] {
  return snapshotRef.current;
}

/** Number of running downloads — a primitive, so the header stays quiet. */
export function useActiveDownloadCount(): number {
  return useDownloadSelector((items) => items.filter((it) => it.status === 'active').length);
}

/** Current download folder — changes only when the user changes it. */
export function useDownloadDir(): string | null {
  return useDownloadSelector((items) => downloadDirSnapshot.current);
}

/** Whether THIS app has a running download (primitive boolean). */
export function useAppDownloadActive(appRef: string | undefined): boolean {
  return useDownloadSelector((items) =>
    appRef ? items.some((it) => it.status === 'active' && it.appRef === appRef) : false
  );
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatSpeed(bps: number): string {
  return `${formatBytes(bps)}/s`;
}

export function formatEta(secs: number): string {
  if (!secs || !isFinite(secs) || secs <= 0) return '';
  if (secs < 60) return `${Math.ceil(secs)}s ${translate('time.left')}`;
  const m = Math.floor(secs / 60);
  const s = Math.ceil(secs % 60);
  if (m < 60) return `${m}m ${s}s ${translate('time.left')}`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ${translate('time.left')}`;
}
