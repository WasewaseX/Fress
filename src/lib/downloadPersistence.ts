// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
/**
 * Coalescing scheduler for download-panel persistence.
 *
 * The provider used to write the serialized item list to localStorage on
 * EVERY items change inside a synchronous effect. Progress events update an
 * item's byte count, speed and ETA several times a second, so a single
 * transfer meant a serialize+write storm on the main thread - while the
 * serialized payload itself was identical every time (only terminal states
 * survive a restart; an in-flight byte count does not).
 *
 * This module owns the write policy, as pure logic so it can be unit-tested
 * without React, Tauri or a DOM:
 *
 *   - durable changes (new/changed terminal entries, removals) flush
 *     immediately: completion, failure, cancellation and removal must be
 *     on disk before anything else can go wrong;
 *   - ordinary progress snapshots coalesce on DOWNLOAD_PERSIST_INTERVAL_MS:
 *     at most one write per interval no matter how fast events arrive
 *     (a trailing write, never a reset timer - a continuous stream must
 *     still be written, not starved);
 *   - identical payloads never touch storage twice (the common case: a
 *     byte-count update does not change what would be persisted at all);
 *   - a refused write (quota / blocked storage) is retried once with the
 *     trimmed payload; if even that fails the panel degrades to forgetting
 *     on close - the download itself is never touched;
 *   - dispose() clears the pending timer and performs one final flush, so
 *     unmounting can neither lose the latest state nor fire a timer into a
 *     dead component.
 */

/** How often ordinary progress snapshots may hit storage. Within the
 *  500-1000ms window: fast enough that a crash loses almost nothing that
 *  matters, slow enough to stay off the hot path. */
export const DOWNLOAD_PERSIST_INTERVAL_MS = 750;

export interface DownloadPersistenceOptions {
  /** Serialize the current durable state. Pure read, no I/O. */
  read: () => string;
  /** Perform the storage write. May throw (quota, blocked storage). */
  write: (payload: string) => void;
  /** Reduced payload for the one-shot quota retry (e.g. newest entries
   * only). Optional; without it a refused write simply gives up. */
  readTrimmed?: () => string;
  /** Payload already on disk (what the panel was restored from). Identical
   * flushes are skipped, so a clean mount performs zero writes. */
  initial?: string;
  /** Overrides for tests. Defaults to the global timer functions, which
   * fake timers (vi.useFakeTimers) patch transparently. */
  scheduleTimer?: (fn: () => void, ms: number) => unknown;
  cancelTimer?: (handle: unknown) => void;
}

export interface DownloadPersistence {
  /** Report that the item list changed. `durable` marks a change that is
   * (or may be) reflected in the persisted payload - status transitions,
   * terminal insertions, removals. Plain progress snapshots pass false. */
  recordChange(change: { durable: boolean }): void;
  /** Write the current payload now (deduped, quota-safe). */
  flushNow(): void;
  /** Stop scheduling and flush the latest state one last time. */
  dispose(): void;
}

export function createDownloadPersistence(options: DownloadPersistenceOptions): DownloadPersistence {
  const {
    read,
    write,
    readTrimmed,
    initial,
    scheduleTimer = (fn, ms) => setTimeout(fn, ms),
    cancelTimer = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  } = options;

  let lastWritten: string | null = initial ?? null;
  let timer: unknown = null;
  let disposed = false;

  const attemptWrite = (payload: string): boolean => {
    try {
      write(payload);
      lastWritten = payload;
      return true;
    } catch {
      return false;
    }
  };

  const flushNow = (): void => {
    let payload: string;
    try {
      payload = read();
    } catch {
      // Serialization blew up (never expected): degrade to not persisting
      // this round instead of breaking the caller's flow.
      return;
    }
    if (payload === lastWritten) return;
    if (attemptWrite(payload)) return;
    // Storage refused the write (quota full / blocked). One retry with a
    // trimmed payload keeps the newest durable entries; if that also fails
    // the panel simply forgets on close, which the UI already tolerates.
    if (!readTrimmed) return;
    let trimmed: string;
    try {
      trimmed = readTrimmed();
    } catch {
      return;
    }
    if (trimmed === lastWritten) return;
    attemptWrite(trimmed);
  };

  const onTimer = (): void => {
    timer = null;
    if (disposed) return;
    flushNow();
  };

  return {
    recordChange({ durable }) {
      if (disposed) return;
      if (durable) {
        // Terminal transitions are rare and precious: cancel the pending
        // coalescing window and write immediately.
        if (timer !== null) {
          cancelTimer(timer);
          timer = null;
        }
        flushNow();
        return;
      }
      // Ordinary snapshot: schedule at most one write per interval. The
      // timer is NOT reset by later events (that would starve a continuous
      // stream of transfers); it fires once and the next change re-arms it.
      if (timer === null) {
        timer = scheduleTimer(onTimer, DOWNLOAD_PERSIST_INTERVAL_MS);
      }
    },

    flushNow,

    dispose() {
      disposed = true;
      if (timer !== null) {
        cancelTimer(timer);
        timer = null;
      }
      flushNow();
    },
  };
}
