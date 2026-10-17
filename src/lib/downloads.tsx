// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { dirname } from '@tauri-apps/api/path';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { toast } from 'sonner';
import { formatBytes, formatSpeed, formatEta } from './format';
import { DownloadQueue, MAX_CONCURRENT_DOWNLOADS, QueuedDownload } from './downloadQueue';
import { serializeItems, deserializeItems, DOWNLOAD_ITEMS_KEY } from './downloadItemsStore';
import { createDownloadPersistence } from './downloadPersistence';
import { formatMessage, useI18n } from './i18n';
import {
  openCompletedArtifact,
  revealCompletedArtifact,
  parseOpenError,
  type CompletedArtifactRef,
  type OpenFailureKind,
  type OpenOutcome,
} from './artifactOpen';

export { formatBytes, formatSpeed, formatEta };

export type DownloadStatus = 'active' | 'queued' | 'completed' | 'error' | 'cancelled' | 'browser' | 'page';

export interface DownloadItem {
  id: number;
  url: string;
  name: string;
  /** The exact filename hint this transfer's start carried to Rust (the
   * `filename` argument of the start_download invoke). Absent = Rust
   * derives the name from the response itself. Retry re-sends THIS, never
   * the display name: the display name falls back to a localized
   * placeholder word when nothing could be guessed, and Rust lets a
   * requested name outrank Content-Disposition - a retry that passed the
   * placeholder word would save the file under a literal "Download"
   * instead of the server-provided name. */
  filename?: string;
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
  /** Hands the completed artifact to the OS: the opener plugin's
   * OS-default-handler open with the EXACT completed path, and - only on
   * rejection, only for a .AppImage on desktop Linux - the registry-
   * validated launch command. Bound to the download id; resolves an
   * outcome instead of throwing so the row can leave the busy state and
   * offer a retry. Repeat activations while one launch is pending are
   * IGNORED (no toast, no second native call). */
  openFile: (artifact: CompletedArtifactRef) => Promise<OpenOutcome>;
  /** Reveals the completed file in its folder (containing-folder fallback,
   * then an honest error). Same id binding, busy and outcome contract. */
  openFolder: (artifact: CompletedArtifactRef) => Promise<OpenOutcome>;
  chooseFolder: () => Promise<void>;
  resetFolder: () => Promise<void>;
}

/** Localized message per typed open failure. The toast TITLE stays the
 * long-standing generic key (the E2E contract asserts that text); the
 * classified reason becomes the description and explains what the user
 * can do next. Keys live in i18n.tsx (Agent 2 owns wording). */
function openFailureDescription(kind: OpenFailureKind, t: (key: string) => string): string | undefined {
  switch (kind) {
    case 'missing': return t('downloads.toast.openMissing');
    case 'not-a-file': return t('downloads.toast.openNotFile');
    case 'unregistered': return t('downloads.toast.openUnregistered');
    case 'cross-wired': return t('downloads.toast.openCrossWired');
    case 'replaced': return t('downloads.toast.openReplaced');
    case 'no-handler': return t('downloads.toast.openNoHandler');
    case 'permission': return t('downloads.toast.openPermission');
    default: return undefined;
  }
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
const DownloadBusyStoreContext = createContext<ArtifactActionBusyStore | null>(null);

const EMPTY_ID_SET: ReadonlySet<number> = new Set();

/**
 * Selector store for the per-row artifact actions' busy state.
 *
 * Same pattern as ActiveDownloadsStore: context alone would rerender every
 * consumer on each transition, so the panel subscribes through
 * useSyncExternalStore and the snapshot is the busy-id set itself. The
 * snapshot identity only changes when a row actually enters or leaves the
 * busy state, so open/reveal activity on OTHER rows repaints nothing.
 *
 * Why a store and not disabled attributes: the E2E-pinned contract (K-G1)
 * is that repeated activation while one native launch is pending produces
 * exactly ONE invoke. The authoritative guard is therefore in the action
 * itself (synchronous check-then-set before any await); the store lets the
 * row RENDER the busy state (dimmed + aria-busy) while the control STAYS
 * interactive - a second activation lands and is swallowed by the guard
 * instead of hanging on a non-interactive control.
 */
export class ArtifactActionBusyStore {
  private openBusy = new Set<number>();
  private revealBusy = new Set<number>();
  private openSnapshot: ReadonlySet<number> = EMPTY_ID_SET;
  private revealSnapshot: ReadonlySet<number> = EMPTY_ID_SET;
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** The set of download ids whose Open action is pending. */
  getOpenSnapshot = (): ReadonlySet<number> => this.openSnapshot;

  /** The set of download ids whose Show-in-folder action is pending. */
  getRevealSnapshot = (): ReadonlySet<number> => this.revealSnapshot;

  /** Marks `id` busy for `action`. Returns false when it was ALREADY busy -
   * the caller treats that as "activation ignored". Synchronous by design:
   * two rapid clicks cannot interleave between the check and the set. */
  begin(id: number, action: 'open' | 'reveal'): boolean {
    const set = action === 'open' ? this.openBusy : this.revealBusy;
    if (set.has(id)) return false;
    set.add(id);
    this.publish();
    return true;
  }

  end(id: number, action: 'open' | 'reveal'): void {
    const set = action === 'open' ? this.openBusy : this.revealBusy;
    if (!set.delete(id)) return;
    this.publish();
  }

  private publish(): void {
    const nextOpen = this.openBusy.size > 0 ? new Set(this.openBusy) : EMPTY_ID_SET;
    const nextReveal = this.revealBusy.size > 0 ? new Set(this.revealBusy) : EMPTY_ID_SET;
    if (nextOpen === this.openSnapshot && nextReveal === this.revealSnapshot) return;
    this.openSnapshot = nextOpen;
    this.revealSnapshot = nextReveal;
    this.listeners.forEach((listener) => listener());
  }
}

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
  /** Slot ownership for the concurrency gate, keyed by the Rust download id.
   * A plain counter raced the event channel: a fast-completing transfer can
   * deliver download-complete BEFORE start_download's invoke resolves (the
   * pendingEvents buffer below exists for exactly that timing), so the
   * handler's decrement hit a count the start had not raised yet - the
   * later increment then leaked the slot, the gate read permanently high
   * and the queue stalled with free capacity. Per-id ownership is
   * order-proof: whichever of {start resolved, terminal observed} lands
   * first records the id, the other signal clears it, and a repeated
   * terminal event cannot free a second slot. itemsRef staleness between
   * rapid startDownload calls (React has not committed yet) does not
   * matter here: this set is updated at the exact moments a slot is taken
   * (start resolved) and freed (Rust reported completion/error/cancel). */
  const activeSlotIdsRef = useRef<Set<number>>(new Set());
  /** Terminal events that arrived for an id whose start had not resolved
   * yet (so its slot was never taken). Consumed by the start path, which
   * would otherwise resurrect the slot after the fact. */
  const terminalBeforeStartRef = useRef<Set<number>>(new Set());
  /** A queued row the user cancelled while its entry was already shifted
   * out of the line and its Rust transfer was still starting. The pump
   * consumes the marker the moment the real id is known and cancels the
   * transfer, instead of letting a "cancelled" download run on unnamed. */
  const cancelledWhileStartingRef = useRef<Set<number>>(new Set());
  /** The transfer takes its slot exactly once, at whichever of the two
   * signals arrives first. */
  const noteSlotTaken = (id: number): void => {
    if (!terminalBeforeStartRef.current.delete(id)) activeSlotIdsRef.current.add(id);
  };
  /** The terminal event gives the slot back exactly once, no matter how
   * the start/terminal ordering played out. */
  const noteSlotReleased = (id: number): void => {
    if (!activeSlotIdsRef.current.delete(id)) terminalBeforeStartRef.current.add(id);
  };
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
  const activeTauriCount = (): number => activeSlotIdsRef.current.size;

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
          // Matched by identity: a sibling row may share this URL (the same
          // file queued for two folders) and must stay in the line.
          setItems((prev) =>
            prev.filter((it) => !(it.status === 'queued' && it.id === next.localId))
          );
          let startedId: number | null = null;
          try {
            startedId = await startTauriDownload(next.url, next.name, next.opts);
          } catch {
            // startTauriDownload already showed the error toast and did not
            // take a slot. The pump itself must survive: letting this
            // rejection escape killed the whole promotion loop with an
            // unhandled rejection and left every later queued entry stuck
            // until some unrelated event happened to fire promoteQueued.
          }
          // Consume the cancel marker for THIS entry whether or not the
          // start succeeded: with a transfer running, the marker means
          // cancel_download for the fresh id (the terminal event then moves
          // the row into the cancelled state the user asked for); without
          // one, the marker is simply retired.
          if (cancelledWhileStartingRef.current.delete(next.localId) && startedId !== null) {
            void invoke('cancel_download', { id: startedId }).catch(() => undefined);
          }
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
      noteSlotReleased(p.id);
      const tt = tRef.current;
      // formatMessage, not .replace: a value is inserted LITERALLY, so a
      // name or a Windows path carrying `$&`/`$$`-style replacement
      // patterns cannot corrupt the very toast announcing it (and a token
      // used twice in a translation is replaced everywhere).
      const completedTitle = formatMessage(tt('downloads.toast.completedTitle'), {
        name: item?.name || tt('downloads.toast.fileFallback'),
      });
      if (p.verified === true) {
        toast.success(completedTitle, {
          description: formatMessage(tt('downloads.toast.verifiedDesc'), { path: p.path }),
        });
      } else {
        toast.success(completedTitle, {
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
      // Literal interpolation for the same reason as the completion toast:
      // the display name is untrusted content (URL/Content-Disposition).
      toast.info(
        formatMessage(tt('downloads.toast.reconnectingTitle'), {
          name: item?.name || tt('downloads.toast.downloadFallback'),
          attempt: p.attempt,
        }),
        {
          description: tt('downloads.toast.reconnectingDesc'),
        }
      );
    }).then((un) => unlisteners.push(un));

    listen<{ id: number; message: string; kind?: string }>('download-error', (event) => {
      const p = event.payload;
      // Every terminal Rust state (cancelled, failed, checksum-mismatch)
      // releases the slot this transfer occupied - exactly once, and in a
      // race-proof order (see noteSlotReleased): a terminal event that
      // beats the start's invoke resolution must not free a slot the start
      // would later take.
      noteSlotReleased(p.id);
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
   * No queue logic here - callers above decide WHEN this may run. Returns
   * the Rust id on success; a rejected start has already shown the error
   * toast and resolves to nothing (throws) without ever taking a slot. */
  const startTauriDownload = useCallback(
    async (url: string, nameHint?: string, opts?: { expectedSha256?: string; expectedSha512?: string; resume?: boolean; dir?: string | null }): Promise<number> => {
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
        noteSlotTaken(id);
        setItems((prev) => [
          {
            id,
            url,
            name: guessedName || tRef.current('downloads.toast.downloadFallback'),
            // Remember what was actually sent to Rust, so a retry re-sends
            // the SAME hint (or none) instead of the display fallback word.
            filename: guessedName || undefined,
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
        return id;
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
        // The queue entry carries the panel row's identity (localId), not
        // just its URL: the same file can legitimately be queued for two
        // folders, and an identity-less entry made cancel/promotion evict
        // the wrong sibling.
        const localId = makeLocalItemId();
        const payload: QueuedDownload = { url, name: nameHint, opts, localId };
        if (queueRef.current.push(payload)) {
          setItems((prev) => [
            {
              id: localId,
              url,
              name: guessedName || tRef.current('downloads.toast.downloadFallback'),
              filename: nameHint || undefined,
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
      // Still waiting: no Rust transfer exists yet. Drop it from the line
      // by the row's identity - a URL match would evict a sibling row that
      // queued the same file for a different folder. removeById returning
      // zero means the entry is mid-promotion: the pump already shifted it
      // and its start_download is in flight, while this row still reads
      // 'queued'. The marker makes the pump cancel the transfer the moment
      // the real id is known - without it, a download the user cancelled
      // silently ran to completion in the background.
      const removed = queueRef.current.removeById(id);
      setItems((prev) => prev.filter((it) => it.id !== id));
      if (removed === 0) cancelledWhileStartingRef.current.add(id);
      return;
    }
    invoke('cancel_download', { id })
      .catch(() => undefined)
      .finally(() => promoteQueued());
  }, [promoteQueued]);

  const retry = useCallback(
    (id: number, resume?: boolean) => {
      const item = itemsRef.current.find((it) => it.id === id);
      if (!item) return;
      // Retry is a terminal-state action. A live transfer is cancel(), not
      // retry(): removing an active row would orphan a transfer that keeps
      // downloading with no panel entry while a duplicate starts, and
      // removing a queued row would race the promotion pump.
      if (item.status === 'active' || item.status === 'queued') return;
      setItems((prev) => prev.filter((it) => it.id !== id));
      // The WIRE hint (item.filename), not the display name: the display
      // name falls back to a localized placeholder word when nothing was
      // guessable, and a requested name outranks Content-Disposition on
      // the Rust side - passing the placeholder would save the retried
      // file under a literal "Download" instead of the server's name.
      void startDownload(item.url, item.filename, {
        expectedSha256: item.expectedSha256,
        expectedSha512: item.expectedSha512,
        resume: resume || false,
        // Retry the SAME download: it belongs to the folder it started
        // in. Resume without this would hunt for the .part file in the
        // currently selected folder and silently start over.
        dir: item.dir || undefined,
      });
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

  // ---- The download-to-open boundary ------------------------------------
  // One busy store for both artifact actions; the actions below are its
  // only writers, the panel subscribes through useArtifactActionBusy().
  // Created lazily once so the actions' identities stay stable (the
  // documented contract of this context).
  const busyStoreRef = useRef<ArtifactActionBusyStore | null>(null);
  if (!busyStoreRef.current) busyStoreRef.current = new ArtifactActionBusyStore();
  const busyStore = busyStoreRef.current;

  /** Where the registry-validated AppImage launch command exists: a
   * desktop Linux build. Android never launches AppImages (its adapter
   * owns the APK handoff below the SAME open_path boundary); Windows and
   * macOS have their OS associations. */
  const appImageLaunchSupported =
    isTauri() && !isAndroidWebview() && /linux/i.test(navigator.userAgent);

  // ---- The native open/reveal bindings -----------------------------------
  // ONE registry-validated native boundary for every platform: the exact
  // completion-event path crosses as ONE value, the session registry
  // admits it natively (canonical stability, regular file, committed
  // size - the same discipline as the updater's signature verification),
  // and the OS is only asked from the Rust side afterwards. Desktop
  // dispatch runs the opener plugin's Rust API; on Android the fress-open
  // adapter owns the APK installer / viewer handoff through a FileProvider
  // content URI. The webview itself holds NO path-opening capability at
  // all: the blanket opener open-path / reveal-item-in-dir grants are
  // gone (docs/security/tauri-security.md), so a compromised frontend can
  // no longer open or reveal arbitrary pre-existing local files. Errors
  // surface in the open-artifact/<code> typed namespace the boundary
  // already parses.
  const artifactOpenPath = useCallback(
    (path: string) => invoke('open_downloaded_file', { path }).then(() => undefined),
    []
  );
  const artifactRevealItem = useCallback(
    (path: string) => invoke('reveal_download_file', { path }).then(() => undefined),
    []
  );
  const artifactOpenDir = useCallback(
    (dir: string) => invoke('open_download_dir', { dir }).then(() => undefined),
    []
  );

  const openFile = useCallback(
    async (artifact: CompletedArtifactRef): Promise<OpenOutcome> => {
      if (!isTauri()) return { ok: false, kind: 'unknown' };
      if (!artifact.path) return { ok: false, kind: 'missing' };
      // Airtight repeat-activation guard: check-then-set SYNCHRONOUSLY,
      // before any await, so two rapid clicks cannot interleave. A second
      // activation while one launch is pending is IGNORED - no toast, no
      // second native call (the E2E-pinned single-launch contract).
      if (!busyStore.begin(artifact.id, 'open')) return { ok: false, kind: 'busy' };
      try {
        const outcome = await openCompletedArtifact(artifact, {
          openPath: artifactOpenPath,
          launchAppImage: ({ id, path }) => invoke('launch_app_image_artifact', { id, path }),
          appImageLaunchSupported,
          warn: (message, detail) => console.warn(`[download-open] ${message}`, detail),
        });
        if (!outcome.ok) {
          // The TITLE is the long-standing generic message (the contract
          // the tests and other surfaces rely on); the classified reason
          // explains what to do next; the raw native detail went to the
          // console inside the operation. The row stays completed and the
          // action stays retryable - only the open attempt failed.
          toast.error(tRef.current('downloads.toast.openFileFailed'), {
            description: openFailureDescription(outcome.kind, tRef.current),
          });
        }
        return outcome;
      } finally {
        busyStore.end(artifact.id, 'open');
      }
    },
    [busyStore, appImageLaunchSupported, artifactOpenPath]
  );

  // openFolder reads the folder through a ref so its identity - and with
  // it the whole actions context value - stays stable while the user
  // changes the download directory.
  const downloadDirRef = useRef<string | null>(null);
  downloadDirRef.current = downloadDir;

  const openFolder = useCallback(
    async (artifact: CompletedArtifactRef): Promise<OpenOutcome> => {
      if (!isTauri()) return { ok: false, kind: 'unknown' };
      const path = artifact.path || downloadDirRef.current;
      if (!path) return { ok: false, kind: 'missing' };
      if (!busyStore.begin(artifact.id, 'reveal')) return { ok: false, kind: 'busy' };
      try {
        if (artifact.path) {
          // Reveal the file inside its folder; on refusal fall back to the
          // file's CONTAINING folder - never the file itself; on total
          // refusal an honest error. The artifact stays completed.
          const outcome = await revealCompletedArtifact(artifact, {
            revealItemInDir: artifactRevealItem,
            openPath: artifactOpenDir,
            dirname,
            warn: (message, detail) => console.warn(`[download-reveal] ${message}`, detail),
          });
          if (!outcome.ok) {
            toast.error(tRef.current('downloads.toast.openFolderFailed'), {
              description: openFailureDescription(outcome.kind, tRef.current),
            });
          }
          return outcome;
        }
        // No exact file known (defensive): open the configured directory
        // through the folder admission (default download folder, a folder
        // that holds a completed artifact, or one picked this session).
        try {
          await artifactOpenDir(path);
          return { ok: true, kind: 'unknown' };
        } catch (e) {
          const parsed = parseOpenError(e);
          console.warn('[download-reveal] directory open failed', e);
          toast.error(tRef.current('downloads.toast.openFolderFailed'), {
            description: openFailureDescription(parsed.kind, tRef.current),
          });
          return { ok: false, kind: parsed.kind, detail: parsed.detail };
        }
      } finally {
        busyStore.end(artifact.id, 'reveal');
      }
    },
    [busyStore]
  );

  const chooseFolder = useCallback(async () => {
    if (!isTauri()) {
      toast.info(tRef.current('downloads.toast.folderPickerDesktop'));
      return;
    }
    const selected = await openDialog({ directory: true, multiple: false, title: tRef.current('downloads.toast.chooseFolderTitle') });
    if (typeof selected === 'string') {
      setDownloadDir(selected);
      // Session admission for the freshly picked folder: "Open folder" and
      // the reveal fallback work before the first download lands there.
      // Best effort - the boundary refuses honestly if this ever failed.
      void invoke('record_download_directory', { dir: selected }).catch(() => undefined);
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
            <DownloadBusyStoreContext.Provider value={busyStore}>
              {children}
            </DownloadBusyStoreContext.Provider>
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

/** The artifact actions' busy state, as two id sets (Open and Show in
 * folder). The snapshot identity changes only when a row enters or leaves
 * the busy state, so a pending launch rerenders exactly the rows it
 * belongs to. The row renders the dimmed/aria-busy presentation from this;
 * the action itself still owns the authoritative single-launch guard. */
export function useArtifactActionBusy(): { openBusy: ReadonlySet<number>; revealBusy: ReadonlySet<number> } {
  const store = useContext(DownloadBusyStoreContext);
  if (!store) throw new Error('useArtifactActionBusy must be used inside DownloadsProvider');
  const openBusy = useSyncExternalStore(store.subscribe, store.getOpenSnapshot);
  const revealBusy = useSyncExternalStore(store.subscribe, store.getRevealSnapshot);
  return { openBusy, revealBusy };
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
