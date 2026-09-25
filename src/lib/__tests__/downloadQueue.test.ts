// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { describe, expect, it } from 'vitest';
import { DownloadQueue, MAX_CONCURRENT_DOWNLOADS } from '../downloadQueue';

describe('DownloadQueue — the download manager concurrency gate', () => {
  it('keeps a sane concurrency limit', () => {
    // 3 is the classic download-manager default; if this ever changes the
    // decision should be deliberate, not a typo.
    expect(MAX_CONCURRENT_DOWNLOADS).toBe(3);
    expect(MAX_CONCURRENT_DOWNLOADS).toBeGreaterThan(0);
  });

  it('is FIFO: the first download queued is the first promoted', () => {
    const q = new DownloadQueue();
    q.push({ url: 'https://example.com/a.exe' });
    q.push({ url: 'https://example.com/b.exe' });
    q.push({ url: 'https://example.com/c.exe' });
    expect(q.size).toBe(3);
    expect(q.shift()?.url).toBe('https://example.com/a.exe');
    expect(q.shift()?.url).toBe('https://example.com/b.exe');
    expect(q.shift()?.url).toBe('https://example.com/c.exe');
    expect(q.shift()).toBeNull();
  });

  it('never queues the same target twice (double-click / batch overlap)', () => {
    const q = new DownloadQueue();
    expect(q.push({ url: 'https://example.com/a.exe', name: 'a' })).toBe(true);
    expect(q.push({ url: 'https://example.com/a.exe', name: 'a' })).toBe(false);
    expect(q.size).toBe(1);
    // The same URL into a DIFFERENT folder is a different download.
    expect(q.push({ url: 'https://example.com/a.exe', name: 'a', opts: { dir: '/tmp/other' } })).toBe(true);
  });

  it('removeWhere drops a cancelled entry and keeps the rest', () => {
    const q = new DownloadQueue();
    q.push({ url: 'https://example.com/a.exe' });
    q.push({ url: 'https://example.com/b.exe' });
    const removed = q.removeWhere((x) => x.url === 'https://example.com/a.exe');
    expect(removed).toBe(1);
    expect(q.size).toBe(1);
    expect(q.shift()?.url).toBe('https://example.com/b.exe');
    // The dedupe key is gone too: re-queueing the cancelled URL works.
    expect(q.push({ url: 'https://example.com/a.exe' })).toBe(true);
  });

  it('carries everything startDownload needs for a faithful promotion', () => {
    const q = new DownloadQueue();
    q.push({ url: 'https://example.com/big.exe', name: 'big.exe', opts: { expectedSha256: 'abc', dir: '/downloads' } });
    const promoted = q.shift();
    expect(promoted).toEqual({
      url: 'https://example.com/big.exe',
      name: 'big.exe',
      opts: { expectedSha256: 'abc', dir: '/downloads' },
    });
  });

  it('clear() empties both the line and the dedupe set', () => {
    const q = new DownloadQueue();
    q.push({ url: 'https://example.com/a.exe' });
    q.clear();
    expect(q.size).toBe(0);
    expect(q.push({ url: 'https://example.com/a.exe' })).toBe(true);
  });
});
