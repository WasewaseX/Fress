// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { dirname } from '@tauri-apps/api/path';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener';
import { toast } from 'sonner';
import { formatBytes, formatSpeed, formatEta } from './format';

export { formatBytes, formatSpeed, formatEta };

export type DownloadStatus = 'active' | 'completed' | 'error' | 'cancelled' | 'browser' | 'page';

export interface DownloadItem {
  id: number;
  url: string;
  name: string;
  dir: string;
  bytes: number;
  total: number;
  speed: number;
  eta: number;
  status: DownloadStatus;
  error?: string;
  path?: string;
  sha256?: string;
  /** Trusted hash this download is being verified against, if one is known. */
  expectedSha256?: string;
  /** true = the digest matched the trusted hash. Never true when only
   * calculated. absent = no trusted reference was available. */
  verified?: boolean;
  /** Set on error/cancel when a .part file was kept and a resume can pick
   * up from where it stopped. */
  canResume?: boolean;
  startedAt: number;
}

const DIR_KEY = 'fress.downloadDir';

/** Local-only panel entries (browser fallback, "opened official page") have
 * no Rust download id. Negative counting ids can never collide with the
 * Rust side's positive ids - or with each other, which Date.now() could:
 * several entries recorded in one burst (browser-mode batch download)
 * produced duplicate React keys. */
let localItemId = -1;
const makeLocalItemId = (): number => localItemId--;

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** True when running inside the Android app (used to adapt desktop-only UI,
 * like the folder picker, to what Android's storage model actually allows). */
export function isAndroidWebview(): boolean {
  return typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent);
}

interface DownloadsContextValue {
  items: DownloadItem[];
  activeCount: number;
  downloadDir: string | null;
  startDownload: (
    url: string,
    nameHint?: string,
    opts?: { expectedSha256?: string; resume?: boolean; dir?: string | null }
  ) => Promise<void>;
  recordExternalOpen: (name: string, url: string) => void;
  cancel: (id: number) => void;
  retry: (id: number, resume?: boolean) => void;
  clearFinished: () => void;
  openFile: (path: string) => void;
  openFolder: (path?: string) => void;
  chooseFolder: () => Promise<void>;
  resetFolder: () => Promise<void>;
}

const DownloadsContext = createContext<DownloadsContextValue | null>(null);

export function DownloadsProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<DownloadItem[]>([]);
  const [downloadDir, setDownloadDir] = useState<string | null>(null);
  const itemsRef = useRef<DownloadItem[]>([]);
  itemsRef.current = items;
  /** Events that arrived for a download whose item was not inserted yet
   * (the file can finish before start_download's invoke resolves). Keyed
   * by id, drained by startDownload right after the item is inserted. */
  const pendingEventsRef = useRef<Map<number, Array<(it: DownloadItem) => DownloadItem>>>(new Map());

  useEffect(() => {
    if (!isTauri()) return;
    let unlisteners: Array<() => void> = [];

    /** Apply an event to a download item. If the item is not inserted yet
     * (Rust emitted the event before start_download's invoke resolved and
     * React state updated), buffer the update instead of dropping it -
     * `setItems(prev => prev.map(...))` over a list without the item used
     * to silently swallow fast-completing downloads. */
    const applyItemUpdate = (id: number, fn: (it: DownloadItem) => DownloadItem): void => {
      if (itemsRef.current.some((it) => it.id === id)) {
        setItems((prev) => prev.map((it) => (it.id === id ? fn(it) : it)));
      } else {
        const queue = pendingEventsRef.current.get(id) ?? [];
        queue.push(fn);
        // Cap progress-event spam for items that never get inserted.
        if (queue.length > 64) queue.shift();
        pendingEventsRef.current.set(id, queue);
      }
    };

    invoke<string>('default_download_dir')
      .then((dir) => {
        try {
          const saved = localStorage.getItem(DIR_KEY);
          setDownloadDir(saved || dir);
        } catch {
          setDownloadDir(dir);
        }
      })
      .catch(() => setDownloadDir(null));

    listen<{ id: number; downloaded: number; total: number; speed_bps: number; eta_secs: number }>(
      'download-progress',
      (event) => {
        const p = event.payload;
        applyItemUpdate(p.id, (it) => ({
          ...it,
          bytes: p.downloaded,
          total: p.total,
          speed: p.speed_bps,
          eta: p.eta_secs,
        }));
      }
    ).then((un) => unlisteners.push(un));

    listen<{ id: number; path: string; bytes: number; sha256: string; verified?: boolean }>('download-complete', (event) => {
      const p = event.payload;
      applyItemUpdate(p.id, (it) => ({ ...it, status: 'completed', path: p.path, bytes: p.bytes, sha256: p.sha256, verified: p.verified === true ? true : undefined, total: p.bytes, speed: 0, eta: 0, canResume: false }));
      const item = itemsRef.current.find((it) => it.id === p.id);
      if (p.verified === true) {
        toast.success(`Downloaded ${item?.name || 'file'}`, {
          description: `SHA-256 verified against the published checksum. ${p.path}`,
        });
      } else {
        toast.success(`Downloaded ${item?.name || 'file'}`, {
          description: p.path,
        });
      }
    }).then((un) => unlisteners.push(un));

    // The Rust side resumes automatically after a dropped connection. A quiet
    // note explains why the progress bar jumped backwards instead of an
    // error toast implying the download was lost.
    listen<{ id: number; attempt: number; message: string }>('download-retrying', (event) => {
      const p = event.payload;
      const item = itemsRef.current.find((it) => it.id === p.id);
      applyItemUpdate(p.id, (it) => ({ ...it, status: 'active', canResume: false }));
      toast.info(`Reconnecting ${item?.name || 'download'} (attempt ${p.attempt})`, {
        description: 'The connection dropped — continuing from where it stopped.',
      });
    }).then((un) => unlisteners.push(un));

    listen<{ id: number; message: string; kind?: string }>('download-error', (event) => {
      const p = event.payload;
      if (p.message === 'Cancelled') {
        applyItemUpdate(p.id, (it) => ({ ...it, status: 'cancelled', canResume: true }));
        toast.info('Download paused — use Resume to continue');
      } else if (p.kind === 'checksum') {
        // The file failed verification and was deleted on disk. A resume is
        // pointless; the source itself must be retried.
        applyItemUpdate(p.id, (it) => ({ ...it, status: 'error', error: p.message, canResume: false, sha256: undefined }));
        toast.error('Integrity check failed', { description: p.message });
      } else {
        applyItemUpdate(p.id, (it) => ({ ...it, status: 'error', error: p.message, canResume: true }));
        toast.error('Download failed', { description: p.message });
      }
    }).then((un) => unlisteners.push(un));

    return () => {
      unlisteners.forEach((un) => un());
    };
  }, []);

  // Drain buffered download events after every commit. A completion/error
  // event can race ahead of the item insertion in startDownload; once the
  // item exists in committed state (this effect runs after that render),
  // every buffered update is applied in arrival order. This covers every
  // timing, including events that land between scheduling the insert and
  // React actually committing it.
  useEffect(() => {
    const pending = pendingEventsRef.current;
    if (pending.size === 0) return;
    const queued = Array.from(pending.entries());
    pending.clear();
    setItems((prev) => {
      let next = prev;
      for (const [id, fns] of queued) {
        next = next.map((it) => {
          if (it.id !== id) return it;
          let merged = it;
          for (const fn of fns) merged = fn(merged);
          return merged;
        });
      }
      return next;
    });
  }, [items]);

  const startDownload = useCallback(
    async (url: string, nameHint?: string, opts?: { expectedSha256?: string; resume?: boolean; dir?: string | null }) => {
      if (!url || !/^https?:\/\//i.test(url)) {
        toast.error('This link is not a direct download');
        return;
      }

      // A malformed %-escape (e.g. a URL containing a bare "%") makes
      // decodeURIComponent throw - BEFORE the invoke try-block below is
      // entered, so startDownload would reject with a raw URIError instead
      // of the normal download-error path. A bad URL must degrade to the
      // raw last segment, not crash the flow.
      let guessedName: string | undefined;
      try {
        guessedName =
          nameHint || decodeURIComponent(url.split('/').pop()?.split('?')[0] || '') || undefined;
      } catch {
        guessedName = nameHint || undefined;
      }

      if (!isTauri()) {
        // Browser fallback (web preview / dev in a normal tab):
        // open a NEW tab, record it in the panel, explain. Never navigate away.
        window.open(url, '_blank', 'noopener,noreferrer');
        setItems((prev) => [
          {
            id: makeLocalItemId(),
            url,
            name: guessedName || url,
            dir: 'Browser downloads folder',
            bytes: 0,
            total: 0,
            speed: 0,
            eta: 0,
            status: 'browser',
            startedAt: Date.now(),
          },
          ...prev,
        ]);
        toast.info('Opened the download in a new browser tab', {
          description: 'The Fress desktop app adds a download manager with live progress and SHA-256 verification.',
        });
        return;
      }

      // Resolve the target folder. An explicit `opts.dir` wins: resume and
      // retry MUST look for the .part file where the ORIGINAL download put
      // it, not in whatever folder happens to be selected now (changing
      // the folder between a failure and a resume used to orphan the
      // partial file). If anything goes wrong we do NOT fail: a null
      // directory makes the Rust side fall back to the platform's own
      // Downloads folder.
      let dir: string | null = null;
      try {
        dir = opts?.dir || localStorage.getItem(DIR_KEY) || (await invoke<string>('default_download_dir'));
      } catch {
        dir = opts?.dir || null;
      }

      try {
        const id = await invoke<number>('start_download', {
          url,
          filename: guessedName || null,
          directory: dir,
          expectedSha256: opts?.expectedSha256 || null,
          resume: opts?.resume || false,
        });
        setItems((prev) => [
          {
            id,
            url,
            name: guessedName || 'download',
            dir: dir || '',
            bytes: 0,
            total: 0,
            speed: 0,
            eta: 0,
            status: 'active',
            expectedSha256: opts?.expectedSha256,
            startedAt: Date.now(),
          },
          ...prev,
        ]);
        toast.info('Download started', { description: guessedName || url });
      } catch (e) {
        toast.error('Could not start download', { description: String(e) });
      }
    },
    []
  );

  const cancel = useCallback((id: number) => {
    invoke('cancel_download', { id }).catch(() => undefined);
  }, []);

  const retry = useCallback(
    (id: number, resume?: boolean) => {
      const item = itemsRef.current.find((it) => it.id === id);
      if (item) {
        setItems((prev) => prev.filter((it) => it.id !== id));
        void startDownload(item.url, item.name, {
          expectedSha256: item.expectedSha256,
          resume: resume || false,
          // Retry the SAME download: it belongs to the folder it started
          // in. Resume without this would hunt for the .part file in the
          // currently selected folder and silently start over.
          dir: item.dir || undefined,
        });
      }
    },
    [startDownload]
  );

  const recordExternalOpen = useCallback((name: string, url: string) => {
    setItems((prev) => [
      {
        id: makeLocalItemId(),
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
      openPath(path).catch(() => toast.error('Could not open the file'));
    }
  }, []);

  const openFolder = useCallback((path?: string) => {
    if (!isTauri()) return;
    const target = path || downloadDir;
    if (!target) return;
    if (path) {
      // Reveal the file inside its folder. When the reveal fails (Windows
      // builds without the explorer integration), fall back to opening the
      // file's CONTAINING folder - the old fallback opened `path` itself,
      // which just launched the downloaded file instead of showing where
      // it lives.
      revealItemInDir(path).catch(async () => {
        try {
          await openPath(await dirname(path));
        } catch {
          toast.error('Could not open the folder');
        }
      });
    } else {
      openPath(target).catch(() => toast.error('Could not open the folder'));
    }
  }, [downloadDir]);

  const chooseFolder = useCallback(async () => {
    if (!isTauri()) {
      toast.info('Folder picker is available in the desktop app');
      return;
    }
    const selected = await openDialog({ directory: true, multiple: false, title: 'Choose download folder' });
    if (typeof selected === 'string') {
      setDownloadDir(selected);
      try {
        localStorage.setItem(DIR_KEY, selected);
      } catch {
        // ignore
      }
      toast.success('Download folder updated', { description: selected });
    }
  }, []);

  const resetFolder = useCallback(async () => {
    try {
      localStorage.removeItem(DIR_KEY);
    } catch {
      // ignore
    }
    try {
      const dir = await invoke<string>('default_download_dir');
      setDownloadDir(dir);
      toast.success('Download folder reset to your Downloads folder', { description: dir });
    } catch {
      setDownloadDir(null);
    }
  }, []);

  const activeCount = items.filter((it) => it.status === 'active').length;

  return (
    <DownloadsContext.Provider
      value={{ items, activeCount, downloadDir, startDownload, recordExternalOpen, cancel, retry, clearFinished, openFile, openFolder, chooseFolder, resetFolder }}
    >
      {children}
    </DownloadsContext.Provider>
  );
}

export function useDownloads(): DownloadsContextValue {
  const ctx = useContext(DownloadsContext);
  if (!ctx) throw new Error('useDownloads must be used inside DownloadsProvider');
  return ctx;
}
