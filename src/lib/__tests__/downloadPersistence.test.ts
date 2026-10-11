// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
// Unit tests for the coalescing persistence scheduler (downloadPersistence).
// Fake timers verify the exact policy the download panel relies on:
// rapid progress events produce a BOUNDED number of storage writes, and
// terminal state changes are never lost waiting for the interval.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createDownloadPersistence,
  DOWNLOAD_PERSIST_INTERVAL_MS,
} from '../downloadPersistence';

describe('downloadPersistence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the coalescing window inside the 500-1000ms contract', () => {
    expect(DOWNLOAD_PERSIST_INTERVAL_MS).toBeGreaterThanOrEqual(500);
    expect(DOWNLOAD_PERSIST_INTERVAL_MS).toBeLessThanOrEqual(1000);
  });

  it('several rapid progress events produce a bounded number of storage writes', () => {
    const writes: string[] = [];
    const p = createDownloadPersistence({
      read: () => `payload-${writes.length}`,
      write: (payload) => writes.push(payload),
    });

    // Simulate a fast transfer: 50 progress events in quick succession.
    for (let i = 0; i < 50; i++) {
      p.recordChange({ durable: false });
      expect(writes).toHaveLength(0); // nothing synchronous on the hot path
    }

    // One trailing write per interval - not one per event.
    vi.advanceTimersByTime(DOWNLOAD_PERSIST_INTERVAL_MS);
    expect(writes).toHaveLength(1);

    // Advancing further without changes writes nothing more.
    vi.advanceTimersByTime(DOWNLOAD_PERSIST_INTERVAL_MS * 10);
    expect(writes).toHaveLength(1);
  });

  it('a continuous progress stream writes at most once per interval (no starvation)', () => {
    const writes: string[] = [];
    const p = createDownloadPersistence({
      read: () => `payload-${writes.length}`,
      write: (payload) => writes.push(payload),
    });

    // 10 intervals' worth of continuous events: the timer is never reset by
    // later events, so the stream is coalesced, not postponed forever.
    for (let i = 0; i < 10; i++) {
      p.recordChange({ durable: false });
      vi.advanceTimersByTime(DOWNLOAD_PERSIST_INTERVAL_MS);
      p.recordChange({ durable: false });
    }
    vi.advanceTimersByTime(DOWNLOAD_PERSIST_INTERVAL_MS);
    expect(writes.length).toBeLessThanOrEqual(12);
    expect(writes.length).toBeGreaterThanOrEqual(10);
  });

  it('terminal state changes flush immediately and are not lost', () => {
    const writes: string[] = [];
    const p = createDownloadPersistence({
      read: () => '{"status":"completed"}',
      write: (payload) => writes.push(payload),
    });

    p.recordChange({ durable: true });
    expect(writes).toHaveLength(1); // no timer advance needed

    // The durable flush also cancels the pending coalescing window: no
    // duplicate write fires afterwards.
    vi.advanceTimersByTime(DOWNLOAD_PERSIST_INTERVAL_MS * 5);
    expect(writes).toHaveLength(1);
  });

  it('a durable change during a pending coalescing window flushes now, not later', () => {
    const writes: string[] = [];
    let payload = 'progress';
    const p = createDownloadPersistence({
      read: () => payload,
      write: (p2) => writes.push(p2),
    });

    p.recordChange({ durable: false });
    payload = 'completed';
    p.recordChange({ durable: true });
    expect(writes).toEqual(['completed']);

    // The cancelled window must not write the (identical) payload again.
    vi.advanceTimersByTime(DOWNLOAD_PERSIST_INTERVAL_MS * 3);
    expect(writes).toEqual(['completed']);
  });

  it('identical payloads never touch storage twice', () => {
    const writes: string[] = [];
    const p = createDownloadPersistence({
      read: () => 'same',
      write: (payload) => writes.push(payload),
    });

    p.recordChange({ durable: true });
    p.recordChange({ durable: true });
    p.flushNow();
    p.recordChange({ durable: false });
    vi.advanceTimersByTime(DOWNLOAD_PERSIST_INTERVAL_MS * 2);
    expect(writes).toHaveLength(1);
  });

  it('restored payload counts as already written (clean mount performs zero writes)', () => {
    const writes: string[] = [];
    const p = createDownloadPersistence({
      read: () => 'restored-state',
      write: (payload) => writes.push(payload),
      initial: 'restored-state',
    });

    p.recordChange({ durable: true });
    p.recordChange({ durable: false });
    vi.advanceTimersByTime(DOWNLOAD_PERSIST_INTERVAL_MS * 2);
    expect(writes).toHaveLength(0);
  });

  it('dispose flushes the latest state and stops the timer', () => {
    const writes: string[] = [];
    const p = createDownloadPersistence({
      read: () => 'final',
      write: (payload) => writes.push(payload),
    });

    p.recordChange({ durable: false });
    expect(writes).toHaveLength(0);
    p.dispose();
    expect(writes).toEqual(['final']);

    // The pending window died with dispose; late changes are ignored too.
    vi.advanceTimersByTime(DOWNLOAD_PERSIST_INTERVAL_MS * 5);
    p.recordChange({ durable: true });
    expect(writes).toEqual(['final']);
  });

  it('quota errors retry once with the trimmed payload and never throw', () => {
    const writes: string[] = [];
    let payload = 'x'.repeat(1000);
    const p = createDownloadPersistence({
      read: () => payload,
      readTrimmed: () => {
        payload = 'trimmed';
        return payload;
      },
      write: (p2) => {
        if (p2.length > 100) throw new Error('QuotaExceededError');
        writes.push(p2);
      },
    });

    expect(() => p.recordChange({ durable: true })).not.toThrow();
    expect(writes).toEqual(['trimmed']);
  });

  it('a refused write without a trimmed fallback degrades silently', () => {
    const p = createDownloadPersistence({
      read: () => 'big',
      write: () => {
        throw new Error('QuotaExceededError');
      },
    });

    expect(() => {
      p.recordChange({ durable: true });
      p.flushNow();
    }).not.toThrow();
  });

  it('when even the trimmed write fails the download keeps flowing', () => {
    let readCount = 0;
    const p = createDownloadPersistence({
      read: () => {
        readCount += 1;
        return `payload-${readCount}`;
      },
      readTrimmed: () => 'trimmed-but-still-too-big',
      write: () => {
        throw new Error('QuotaExceededError');
      },
    });

    expect(() => p.recordChange({ durable: true })).not.toThrow();
    // lastWritten was never poisoned: a later successful flush retries.
    expect(() => p.flushNow()).not.toThrow();
  });

  it('a read() that throws degrades to a no-op instead of breaking the caller', () => {
    const p = createDownloadPersistence({
      read: () => {
        throw new Error('serializer exploded');
      },
      write: () => undefined,
    });

    expect(() => {
      p.recordChange({ durable: true });
      p.recordChange({ durable: false });
      vi.advanceTimersByTime(DOWNLOAD_PERSIST_INTERVAL_MS);
    }).not.toThrow();
  });
});
