// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { describe, it, expect } from 'vitest';
import { evictFailedLookups, cacheSet } from '../release/resolveCache';
import { ResolvedDownload } from '../release/types';

const ok = (url: string): ResolvedDownload => ({
  source: 'github',
  url,
  filename: 'file.bin',
  size: 1,
  version: '1.0.0',
});

describe('evictFailedLookups', () => {
  it('removes a failed session entry so Retry really refetches', async () => {
    const cache = new Map<string, Promise<ResolvedDownload | null>>();
    const failing = Promise.resolve<ResolvedDownload | null>(null);
    cache.set('repo|windows|', failing);
    await evictFailedLookups(cache, 'repo|windows|');
    expect(cache.has('repo|windows|')).toBe(false);
  });

  it('removes a rejected entry and leaves successes untouched', async () => {
    const cache = new Map<string, Promise<ResolvedDownload | null>>();
    cache.set('a|1', Promise.reject(new Error('network')));
    cache.set('a|2', Promise.resolve(ok('https://x')));
    await evictFailedLookups(cache, 'a|');
    expect(cache.has('a|1')).toBe(false);
    expect(cache.get('a|2')).toBeDefined();
  });

  it('does not evict a replacement set while the failed promise was awaited', async () => {
    // The regression: the evictor awaited the OLD promise, but by the time
    // it settled, cacheSet had already stored a fresh lookup under the same
    // key. Deleting by key alone would drop the NEW promise - the Retry the
    // user asked for would be thrown away instead of the stale failure.
    const cache = new Map<string, Promise<ResolvedDownload | null>>();
    let settleFirst: (r: ResolvedDownload | null) => void = () => undefined;
    const first = new Promise<ResolvedDownload | null>((resolve) => {
      settleFirst = resolve;
    });
    cache.set('k', first);

    const eviction = evictFailedLookups(cache, 'k');

    // Replacement arrives while the eviction is still awaiting `first`.
    const replacement = Promise.resolve(ok('https://fresh'));
    cacheSet(cache, 'k', replacement);

    settleFirst(null);
    await eviction;

    expect(cache.get('k')).toBe(replacement);
  });

  it('never touches keys outside the prefix', async () => {
    const cache = new Map<string, Promise<ResolvedDownload | null>>();
    cache.set('other|1', Promise.resolve<ResolvedDownload | null>(null));
    await evictFailedLookups(cache, 'repo|');
    expect(cache.has('other|1')).toBe(true);
  });
});
