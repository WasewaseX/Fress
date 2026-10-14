// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { dirname } from '@tauri-apps/api/path';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener';
import { toast } from 'sonner';
import { formatBytes, formatSpeed, formatEta } from './format';
import { DownloadQueue, MAX_CONCURRENT_DOWNLOADS, QueuedDownload } from './downloadQueue';
import { serializeItems, deserializeItems, DOWNLOAD_ITEMS_KEY } from './downloadItemsStore';
import { createDownloadPersistence } from './downloadPersistence';
import { useI18n } from './i18n';

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
  /** Same contract for vendors that publish SHA-512 (Signal, Proton). */
  expectedSha512?: string;
  /** true = the digest matched the trusted hash. Never true when only
   * calculated. absent = no trusted reference was available. */
  verified?: boolean;
  /** Set on error/cancel when a .part file was kept and a resume can pick
   * up from where it stopped. */
  canResume?: boolean;
  startedAt: number;
}

const DIR_KEY = 'fress.downloadDir';

/** Storage ceiling for the quota-retry: keep the newest 20 durable entries
 * instead of the usual 60 when the first write is refused. */
const TRIMMED_PERSIST_LIMIT = 20;

/** Statuses that survive a restart, i.e. the ones whose appearance, change
 * or removal MUST reach storage promptly. Mirrors serializeItems' filter. */
const DURABLE_STATUSES = new Set<DownloadStatus>(['completed', 'error', 'cancelled', 'page']);

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

/** A completed download that is an Android package: the "open" action is
 * really an INSTALL (the open_path boundary hands it to the system package
 * installer through the scoped FileProvider), so the button says so. */
export function isAndroidApkArtifact(name: string): boolean {
  return isAndroidWebview() && /\.apk$/i.test(name);
}

/** Commands only. Every function here is referentially stable across the
 * provider's lifetime, so consumers that only need actions (detail modal,
 * footer, batch selection) NEVER rerender because download state moved. */
interface DownloadActionsValue {
  startDownload: (
    url: string,
    nameHint?: string,
    opts?: { expectedSha256?: string; expectedSha512?: string; resume?: boolean; dir?: string | null }
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

/** Lightweight facts: the active-transfer count and the target folder.
 * Byte-count/ETA updates change neither, so header badges and other
 * summary consumers stay quiet while transfers stream. */
interface DownloadSummaryValue {
  activeCount: number;
  downloadDir: string | null;
}

/** The live item list. Only the download manager should subscribe - it is
 * the one surface that must repaint on every progress event. */
interface DownloadItemsValue {
  items: DownloadItem[];
}

/** Identity of the currently active transfers: name and source URL only.
 * Updates when the active SET changes (start/finish/fail/cancel) - never
 * when an existing transfer's byte count, speed or ETA moves. */
export interface ActiveDownloadInfo {
  id: number;
  name: string;
  url: string;
}

const EMPTY_ACTIVE: ActiveDownloadInfo[] = [];

/**
 * Selector store for per-app download status.
 *
 * Context alone cannot skip rerenders: a context value change rerenders
 * EVERY consumer, memoized or not. Cards therefore subscribe through
 * useSyncExternalStore instead: the snapshot is the per-app boolean
 * itself, so a store notification whose snapshot did not flip (a
 * byte-count update, a start that matches some OTHER app) makes React
 * bail out without rendering the card at all. This is the
 * "selector-based subscription" option - strictly stronger than a
 * context that only updates on active-set changes.
 */
export class ActiveDownloadsStore {
  private snapshot: ActiveDownloadInfo[] = EMPTY_ACTIVE;
  private listeners = new Set<() => void>();

  /** The live active-download identity list. */
  getSnapshot = (): ActiveDownloadInfo[] => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Publish a new active list. Byte-count/ETA-driven recomputes produce
   * an equal list and are swallowed here - no notification, no rerender. */
  setActive(next: ActiveDownloadInfo[]): void {
    const prev = this.snapshot;
    if (
      prev.length === next.length &&
      prev.every((p, i) => {
        const n = next[i];
        return p.id === n.id && p.name === n.name && p.url === n.url;
      })
    ) {
      return;
    }
    this.snapshot = next;
    this.listeners.forEach((listener) => listener());
  }
}

const DownloadActionsContext = createContext<DownloadActionsValue | null>(null);
const DownloadSummaryContext = createContext<DownloadSummaryValue | null>(null);
const DownloadItemsContext = createContext<DownloadItemsValue | null>(null);
const DownloadActiveStoreContext = createContext<ActiveDownloadsStore | null>(null);

/** Pre-split aggregate kept for existing callers during the migration to
 * the focused hooks above. */
interface DownloadsContextValue extends DownloadActionsValue, DownloadSummaryValue {
  items: DownloadItem[];
}

/** Read side named the way the PR-12-era consumers expect: items, active
 * count and directory in one object. Implemented over the FOCUSED
 * subscriptions, so it adds no new coupling - but new code should prefer
 * useDownloadItems()/useDownloadSummary() to keep subscriptions narrow. */
export interface DownloadsStateValue extends DownloadSummaryValue {
  items: DownloadItem[];
}

export function DownloadsProvider({ children }: { children: React.ReactNode }) {
  // Toast wording follows the active language. The translator lives in a
  // ref so the command callbacks below keep their documented stable
  // identity (see DownloadActionsValue) instead of re-creating on every
  // language switch; the ref always holds the current t.
  const { t } = useI18n();
  const tRef = useRef(t);
  tRef.current = t;
  // The panel survives restarts: completed/failed entries come back (the
  // .part files and finished files are on disk). Ids are re-assigned to
  // fresh negatives so they can never collide with the Rust side's ids,
  // which restart at 0.
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
  const itemsRef = useRef<DownloadItem[]>(items);
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

  /** Persistence scheduler (see downloadPersistence.ts): terminal states
   * flush promptly, progress snapshots coalesce, identical payloads are
   * deduped, quota failures degrade without touching the download. */
  const [persistence] = useState(() => {
    let initial: string | undefined;
    try {
      initial = localStorage.getItem(DOWNLOAD_ITEMS_KEY) ?? undefined;
    } catch {
      initial = undefined;
    }
    return createDownloadPersistence({
      initial,
      read: () => serializeItems(itemsRef.current),
      readTrimmed: () => serializeItems(itemsRef.current, TRIMMED_PERSIST_LIMIT),
      write: (payload) => {
        localStorage.setItem(DOWNLOAD_ITEMS_KEY, payload);
      },
    });
  });

  /** Status of every item as of the last commit, for the durable-change
   * diff below. Cheap field comparison - no serialization on the hot path. */
  const persistedStatusRef = useRef<Map<number, DownloadStatus> | null>(null);

  useEffect(() => {
    const prev = persistedStatusRef.current;
    const next = new Map<number, DownloadStatus>();
    let durable = false;
    for (const it of items) {
      next.set(it.id, it.status);
      const before = prev?.get(it.id);
      if (before === undefined) {
        // A brand-new entry only matters to storage if it is (or can
        // become) a persisted one; active/queued/browser insertions do
        // not change the serialized payload.
        if (DURABLE_STATUSES.has(it.status)) durable = true;
      } else if (before !== it.status) {
        // A transition (active -> completed/error/cancelled, etc.) always
        // changes what the panel would restore after a restart.
        durable = true;
      }
    }
    if (prev) {
      for (const id of prev.keys()) {
        if (!next.has(id)) {
          // Removals (retry, clearFinished, queued-cancel) can drop
          // persisted entries. Erring toward flushing is free: the dedupe
          // below still skips writes whose payload did not change.
          durable = true;
          break;
        }
      }
    }
    persistedStatusRef.current = next;
    persistence.recordChange({ durable });
  }, [items, persistence]);

  // Unmount/pagehide safety: the debounced timer is cancelled, and the
  // most recent valid state is flushed once so quitting right after a
  // terminal event cannot lose it. The flush never sets state, so this is
  // safe even in StrictMode's dev double-mount.
  useEffect(() => {
    const flush = () => persistence.flushNow();
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      persistence.dispose();
    };
  }, [persistence]);

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
      const tt = tRef.current;
      if (p.verified === true) {
        toast.success(tt('downloads.toast.completedTitle').replace('{name}', item?.name || tt('downloads.toast.fileFallback')), {
          description: tt('downloads.toast.verifiedDesc').replace('{path}', p.path),
        });
      } else {
        toast.success(tt('downloads.toast.completedTitle').replace('{name}', item?.name || tt('downloads.toast.fileFallback')), {
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
      const tt = tRef.current;
      toast.info(tt('downloads.toast.reconnectingTitle').replace('{name}', item?.name || tt('downloads.toast.downloadFallback')).replace('{attempt}', String(p.attempt)), {
        description: tt('downloads.toast.reconnectingDesc'),
      });
    }).then((un) => unlisteners.push(un));

    listen<{ id: number; message: string; kind?: string }>('download-error', (event) => {
      const p = event.payload;
      // Every terminal Rust state (cancelled, failed, checksum-mismatch)
      // frees the slot this transfer occupied.
      activeSlotsRef.current = Math.max(0, activeSlotsRef.current - 1);
      const tt = tRef.current;
      if (p.message === 'Cancelled') {
        applyItemUpdate(p.id, (it) => ({ ...it, status: 'cancelled', canResume: true }));
        toast.info(tt('downloads.toast.pausedResume'));
      } else if (p.kind === 'checksum') {
        // The file failed verification and was deleted on disk. A resume is
        // pointless; the source itself must be retried.
        applyItemUpdate(p.id, (it) => ({ ...it, status: 'error', error: p.message, canResume: false, sha256: undefined }));
        toast.error(tt('downloads.toast.integrityFailed'), { description: p.message });
      } else if (p.kind === 'resume-invalid') {
        // The server answered the resume in a way that cannot be trusted
        // (protocol-invalid Content-Range, HTTP 416) and the staging bytes
        // were discarded. Offering Resume would replay the same broken
        // exchange - only a fresh Retry is sound.
        applyItemUpdate(p.id, (it) => ({ ...it, status: 'error', error: p.message, canResume: false }));
        toast.error(tt('downloads.toast.resumeInvalid'), { description: p.message });
      } else {
        applyItemUpdate(p.id, (it) => ({ ...it, status: 'error', error: p.message, canResume: true }));
        toast.error(tt('downloads.toast.failed'), { description: p.message });
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
    async (url: string, nameHint?: string, opts?: { expectedSha256?: string; expectedSha512?: string; resume?: boolean; dir?: string | null }): Promise<void> => {
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
          expectedSha512: opts?.expectedSha512 || null,
          resume: opts?.resume || false,
        });
        activeSlotsRef.current += 1;
        setItems((prev) => [
          {
            id,
            url,
            name: guessedName || tRef.current('downloads.toast.downloadFallback'),
            dir: dir || '',
            bytes: 0,
            total: 0,
            speed: 0,
            eta: 0,
            status: 'active',
            expectedSha256: opts?.expectedSha256,
            expectedSha512: opts?.expectedSha512,
            startedAt: Date.now(),
          },
          ...prev,
        ]);
      } catch (e) {
        toast.error(tRef.current('downloads.toast.startFailed'), { description: String(e) });
        throw e;
      }
    },
    []
  );

  const startDownload = useCallback(
    async (url: string, nameHint?: string, opts?: { expectedSha256?: string; expectedSha512?: string; resume?: boolean; dir?: string | null }) => {
      if (!url || !/^https?:\/\//i.test(url)) {
        toast.error(tRef.current('downloads.toast.notDirectLink'));
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
        toast.info(tRef.current('downloads.toast.browserTabTitle'), {
          description: tRef.current('downloads.toast.browserTabDesc'),
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
              name: guessedName || tRef.current('downloads.toast.downloadFallback'),
              dir: 'Queued',
              bytes: 0,
              total: 0,
              speed: 0,
              eta: 0,
              status: 'queued',
              expectedSha256: opts?.expectedSha256,
              expectedSha512: opts?.expectedSha512,
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
        toast.info(tRef.current('downloads.toast.startedTitle'), { description: nameHint || url });
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
          expectedSha512: item.expectedSha512,
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
      // The shared open_path boundary. On the desktop this delegates to the
      // opener plugin exactly like the old direct plugin call did; on
      // Android it validates the path against the download engine's
      // completed-artifact registry and routes APKs to the system package
      // installer through the scoped FileProvider (everything else goes to
      // Android's view flow with the share sheet as fallback). The refusal
      // is intentionally generic - the UI adds no detail the boundary did
      // not already decide to share.
      invoke('open_path', { path }).catch(() => toast.error(tRef.current('downloads.toast.openFileFailed')));
    }
  }, []);

  // openFolder reads the folder through a ref so its identity - and with
  // it the whole actions context value - stays stable while the user
  // changes the download directory.
  const downloadDirRef = useRef<string | null>(null);
  downloadDirRef.current = downloadDir;

  const openFolder = useCallback((path?: string) => {
    if (!isTauri()) return;
    const target = path || downloadDirRef.current;
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
          toast.error(tRef.current('downloads.toast.openFolderFailed'));
        }
      });
    } else {
      openPath(target).catch(() => toast.error(tRef.current('downloads.toast.openFolderFailed')));
    }
  }, []);

  const chooseFolder = useCallback(async () => {
    if (!isTauri()) {
      toast.info(tRef.current('downloads.toast.folderPickerDesktop'));
      return;
    }
    const selected = await openDialog({ directory: true, multiple: false, title: tRef.current('downloads.toast.chooseFolderTitle') });
    if (typeof selected === 'string') {
      setDownloadDir(selected);
      try {
        localStorage.setItem(DIR_KEY, selected);
      } catch {
        // ignore
      }
      toast.success(tRef.current('downloads.toast.folderUpdated'), { description: selected });
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
      toast.success(tRef.current('downloads.toast.folderReset'), { description: dir });
    } catch {
      setDownloadDir(null);
    }
  }, []);

  /** Selector store for card-level download status. Stable for the
   * provider's lifetime; see the class comment for why cards subscribe
   * through it instead of through a context value. */
  const [activeStore] = useState(() => new ActiveDownloadsStore());

  // Keep the selector store in sync with the committed item list. Progress
  // events land here too, but setActive's equality check turns them into
  // no-ops: only genuine active-SET changes notify subscribers.
  useEffect(() => {
    activeStore.setActive(
      items
        .filter((it) => it.status === 'active')
        .map((it) => ({ id: it.id, name: it.name, url: it.url }))
    );
  }, [items, activeStore]);

  // ---- Derived subscription slices ------------------------------------
  // Each value changes identity ONLY when the data its consumers care
  // about changed. A byte-count/ETA event updates `items` but leaves
  // activeCount, downloadDir, the actions and the active-download
  // identities untouched - so their subscribers skip the render entirely.

  const activeCount = useMemo(
    () => items.reduce((n, it) => (it.status === 'active' ? n + 1 : n), 0),
    [items]
  );

  const summaryValue = useMemo(
    () => ({ activeCount, downloadDir }),
    [activeCount, downloadDir]
  );

  const itemsValue = useMemo(() => ({ items }), [items]);

  const actionsValue = useMemo(
    () => ({ startDownload, recordExternalOpen, cancel, retry, clearFinished, openFile, openFolder, chooseFolder, resetFolder }),
    [startDownload, recordExternalOpen, cancel, retry, clearFinished, openFile, openFolder, chooseFolder, resetFolder]
  );

  return (
    <DownloadActionsContext.Provider value={actionsValue}>
      <DownloadSummaryContext.Provider value={summaryValue}>
        <DownloadItemsContext.Provider value={itemsValue}>
          <DownloadActiveStoreContext.Provider value={activeStore}>
            {children}
          </DownloadActiveStoreContext.Provider>
        </DownloadItemsContext.Provider>
      </DownloadSummaryContext.Provider>
    </DownloadActionsContext.Provider>
  );
}

/** Stable commands: start, cancel, retry, open, folder management. */
export function useDownloadActions(): DownloadActionsValue {
  const ctx = useContext(DownloadActionsContext);
  if (!ctx) throw new Error('useDownloadActions must be used inside DownloadsProvider');
  return ctx;
}

/** Active-transfer count and the download directory. */
export function useDownloadSummary(): DownloadSummaryValue {
  const ctx = useContext(DownloadSummaryContext);
  if (!ctx) throw new Error('useDownloadSummary must be used inside DownloadsProvider');
  return ctx;
}

/** The live item list. For the download manager (and compat callers). */
export function useDownloadItems(): DownloadItemsValue {
  const ctx = useContext(DownloadItemsContext);
  if (!ctx) throw new Error('useDownloadItems must be used inside DownloadsProvider');
  return ctx;
}

/** Identity of the active transfers; changes only when the set changes. */
export function useActiveDownloads(): ActiveDownloadInfo[] {
  const store = useContext(DownloadActiveStoreContext);
  if (!store) throw new Error('useActiveDownloads must be used inside DownloadsProvider');
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

/**
 * Does THIS app have a transfer in flight? Subscribes only to the active
 * download identity set: a byte-count or ETA update cannot flip it, so a
 * streaming download never rerenders cards that do not belong to it.
 * The panel names entries by the real file name ("VLC-3.0.2-win64.exe",
 * "Cake_Wallet_v5.9.0_Windows.exe"), which often does NOT start with the
 * app's display name ("VLC media player", "Cake Wallet"), so the stable app
 * id is matched inside the name or the source URL as well.
 */
export function useAppDownloadStatus(appId: string, appName: string): boolean {
  const store = useContext(DownloadActiveStoreContext);
  if (!store) throw new Error('useAppDownloadStatus must be used inside DownloadsProvider');
  // The snapshot IS the per-app boolean: React compares consecutive
  // snapshots with Object.is and skips the render entirely while this
  // app's status did not flip. A byte-count update on any transfer leaves
  // every boolean untouched - zero card renders.
  return useSyncExternalStore(store.subscribe, () => {
    const appIdLc = appId.toLowerCase();
    const active = store.getSnapshot();
    return active.some(
      (d) =>
        d.name.startsWith(appName) ||
        d.name.toLowerCase().includes(appIdLc) ||
        d.url.toLowerCase().includes(appIdLc)
    );
  });
}

/** Aggregate read side (items + activeCount + downloadDir). Compat shim
 * for consumers migrated to the PR-12 API; kept deliberately cheap. */
export function useDownloadState(): DownloadsStateValue {
  const { items } = useDownloadItems();
  const summary = useDownloadSummary();
  return useMemo(() => ({ items, ...summary }), [items, summary]);
}

/** Legacy aggregate. Unchanged contract; new code should prefer the three
 * focused hooks above so subscriptions stay as narrow as the data used. */
export function useDownloads(): DownloadsContextValue {
  const actions = useDownloadActions();
  const summary = useDownloadSummary();
  const { items } = useDownloadItems();
  return useMemo(
    () => ({ items, ...summary, ...actions }),
    [items, summary, actions]
  );
}
