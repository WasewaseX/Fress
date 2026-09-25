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
import { DownloadQueue, MAX_CONCURRENT_DOWNLOADS, QueuedDownload } from './downloadQueue';
import { serializeItems, deserializeItems, DOWNLOAD_ITEMS_KEY } from './downloadItemsStore';

export { formatBytes, formatSpeed, formatEta };

export type DownloadStatus = 'active' | 'queued' | 'completed' | 'error' | 'cancelled' | 'browser' | 'page';

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
  // The panel survives restarts: completed/failed entries come back (the
  // .part files and finished files are on disk), and a download that was
  // mid-flight when the app closed is restored as resumable, because that
  // is exactly what it is. Ids are re-assigned to fresh negatives so they
  // can never collide with the Rust side's ids, which restart at 0.
  const [items, setItems] = useState<DownloadItem[]>(() => {
    try {
      return deserializeItems(localStorage.getItem(DOWNLOAD_ITEMS_KEY)).map((it) => ({
        ...it,
        id: makeLocalItemId(),
      }));
    } catch {
      return [];
    }
  });
  const [downloadDir, setDownloadDir] = useState<string | null>(null);
  useEffect(() => {
    try {
      localStorage.setItem(DOWNLOAD_ITEMS_KEY, serializeItems(items));
    } catch {
      // Storage full/blocked: the panel simply forgets on close.
    }
  }, [items]);
  const itemsRef = useRef<DownloadItem[]>([]);
  itemsRef.current = items;
  /** Downloads waiting for a free slot (max MAX_CONCURRENT_DOWNLOADS run at
   * once). FIFO; entries carry everything startDownload received so a
   * promotion is a plain re-dispatch. */
  const queueRef = useRef<DownloadQueue>(new DownloadQueue());
  /** Re-entrancy guard: promotions run from event handlers; while one
   * promotion is dispatching, the others must wait their turn. */
  const promotingRef = useRef(false);
  /** Authoritative count of in-flight Rust transfers. itemsRef can be stale
   * between two rapid startDownload calls (React has not committed yet),
   * which would let a batch overshoot the limit; this counter is updated at
   * the exact moments a slot is taken (start succeeded) and freed (Rust
   * reported completion/error/cancel). */
  const activeSlotsRef = useRef(0);
  /** Events that arrived for a download whose item was not inserted yet
   * (the file can finish before start_download's invoke resolves). Keyed
   * by id, drained by startDownload right after the item is inserted. */
  const pendingEventsRef = useRef<Map<number, Array<(it: DownloadItem) => DownloadItem>>>(new Map());

  /** How many Rust downloads are transferring right now. */
  const activeTauriCount = (): number => activeSlotsRef.current;

  /** Start the next queued download(s) while slots are free. Called after
   * every state change that can free a slot: completion, error, cancel,
   * and a failed start. */
  const promoteQueued = useCallback((): void => {
    if (promotingRef.current) return;
    promotingRef.current = true;
    const pump = async (): Promise<void> => {
      try {
        while (queueRef.current.size > 0 && activeTauriCount() < MAX_CONCURRENT_DOWNLOADS) {
          const next = queueRef.current.shift();
          if (!next) break;
          // The queued placeholder item (negative local id) is replaced by
          // the real item startDownload creates for the Rust transfer.
          setItems((prev) => prev.filter((it) => !(it.status === 'queued' && it.url === next.url)));
          await startTauriDownload(next.url, next.name, next.opts);
        }
      } finally {
        promotingRef.current = false;
      }
    };
    void pump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      activeSlotsRef.current = Math.max(0, activeSlotsRef.current - 1);
      if (p.verified === true) {
        toast.success(`Downloaded ${item?.name || 'file'}`, {
          description: `SHA-256 verified against the published checksum. ${p.path}`,
        });
      } else {
        toast.success(`Downloaded ${item?.name || 'file'}`, {
          description: p.path,
        });
      }
      promoteQueued();
    }).then((un) => unlisteners.push(un));

    // The Rust side resumes automatically after a dropped connection. A quiet
    // note explains why the progress bar jumped backwards instead of an
    // error toast implying the download was lost.
    listen<{ id: number; attempt: number; message: string }>('download-retrying', (event) => {
      const p = event.payload;
      const item = itemsRef.current.find((it) => it.id === p.id);
      applyItemUpdate(p.id, (it) => ({ ...it, status: 'active', canResume: false }));
      toast.info(`Reconnecting ${item?.name || 'download'} (attempt ${p.attempt})`, {
        description: 'The connection dropped. Continuing from where it stopped.',
      });
    }).then((un) => unlisteners.push(un));

    listen<{ id: number; message: string; kind?: string }>('download-error', (event) => {
      const p = event.payload;
      // Every terminal Rust state (cancelled, failed, checksum-mismatch)
      // frees the slot this transfer occupied.
      activeSlotsRef.current = Math.max(0, activeSlotsRef.current - 1);
      if (p.message === 'Cancelled') {
        applyItemUpdate(p.id, (it) => ({ ...it, status: 'cancelled', canResume: true }));
        toast.info('Download paused. Use Resume to continue');
      } else if (p.kind === 'checksum') {
        // The file failed verification and was deleted on disk. A resume is
        // pointless; the source itself must be retried.
        applyItemUpdate(p.id, (it) => ({ ...it, status: 'error', error: p.message, canResume: false, sha256: undefined }));
        toast.error('Integrity check failed', { description: p.message });
      } else if (p.kind === 'resume-invalid') {
        // The server answered the resume in a way that cannot be trusted
        // (protocol-invalid Content-Range, HTTP 416) and the staging bytes
        // were discarded. Offering Resume would replay the same broken
        // exchange - only a fresh Retry is sound.
        applyItemUpdate(p.id, (it) => ({ ...it, status: 'error', error: p.message, canResume: false }));
        toast.error('Resume not possible', { description: p.message });
      } else {
        applyItemUpdate(p.id, (it) => ({ ...it, status: 'error', error: p.message, canResume: true }));
        toast.error('Download failed', { description: p.message });
      }
      // A finished (or failed) transfer frees a slot for the next in line.
      promoteQueued();
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

  /** The direct invoke path: hand one download to Rust and insert its item.
   * No queue logic here - callers above decide WHEN this may run. */
  const startTauriDownload = useCallback(
    async (url: string, nameHint?: string, opts?: { expectedSha256?: string; resume?: boolean; dir?: string | null }): Promise<void> => {
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
        activeSlotsRef.current += 1;
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
      } catch (e) {
        toast.error('Could not start download', { description: String(e) });
        throw e;
      }
    },
    []
  );

  const startDownload = useCallback(
    async (url: string, nameHint?: string, opts?: { expectedSha256?: string; resume?: boolean; dir?: string | null }) => {
      if (!url || !/^https?:\/\//i.test(url)) {
        toast.error('This link is not a direct download');
        return;
      }

      if (!isTauri()) {
        // Browser fallback (web preview / dev in a normal tab):
        // open a NEW tab, record it in the panel, explain. Never navigate away.
        let guessedName: string | undefined;
        try {
          guessedName =
            nameHint || decodeURIComponent(url.split('/').pop()?.split('?')[0] || '') || undefined;
        } catch {
          guessedName = nameHint || undefined;
        }
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

      // Concurrency gate: at most MAX_CONCURRENT_DOWNLOADS transfer at
      // once. Everything else waits in a FIFO queue shown in the manager.
      // A batch of thirty used to start thirty parallel streams that fought
      // for bandwidth; now each one gets a real share and the queue drains
      // automatically as slots free up.
      if (activeTauriCount() >= MAX_CONCURRENT_DOWNLOADS) {
        let guessedName: string | undefined;
        try {
          guessedName =
            nameHint || decodeURIComponent(url.split('/').pop()?.split('?')[0] || '') || undefined;
        } catch {
          guessedName = nameHint || undefined;
        }
        const payload: QueuedDownload = { url, name: nameHint, opts };
        if (queueRef.current.push(payload)) {
          setItems((prev) => [
            {
              id: makeLocalItemId(),
              url,
              name: guessedName || 'download',
              dir: 'Queued',
              bytes: 0,
              total: 0,
              speed: 0,
              eta: 0,
              status: 'queued',
              expectedSha256: opts?.expectedSha256,
              startedAt: Date.now(),
            },
            ...prev,
          ]);
        }
        return;
      }

      try {
        await startTauriDownload(url, nameHint, opts);
        // Only a transfer that actually started announces itself; queued
        // entries are visible in the manager and would only spam toasts.
        toast.info('Download started', { description: nameHint || url });
      } catch {
        // The start failed; the error toast is already up. A slot may have
        // been conceptually freed (nothing is running in its place).
        promoteQueued();
      }
    },
    [startTauriDownload, promoteQueued]
  );

  const cancel = useCallback((id: number) => {
    const item = itemsRef.current.find((it) => it.id === id);
    if (item && item.status === 'queued') {
      // Still waiting: no Rust transfer exists yet. Drop it from the line.
      queueRef.current.removeWhere((q) => q.url === item.url);
      setItems((prev) => prev.filter((it) => it.id !== id));
      return;
    }
    invoke('cancel_download', { id })
      .catch(() => undefined)
      .finally(() => promoteQueued());
  }, [promoteQueued]);

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
    setItems((prev) => prev.filter((it) => it.status === 'active' || it.status === 'queued'));
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
