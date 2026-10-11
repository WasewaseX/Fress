// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
// @vitest-environment jsdom
//
// The retry plumbing behind the detail modal's explicit failure state:
// evictFailedLookups drops only failed session-memo entries under a prefix,
// purgePersistedFailures drops only persisted failures, and the retry*
// wrappers re-run exactly one app|platform lookup without touching cached
// successes or unrelated apps.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import {
  evictFailedLookups,
  purgePersistedFailures,
  ghCache,
  fdCache,
} from '../release/resolveCache';
import { retryGitHubResolve, retryFdroidResolve } from '../release/resolve';
import { AppItem } from '../../types';

const CACHE_KEY = 'fress.resolveCache.v1';

function seedPersisted(entries: Record<string, { t: number; url: string | null }>): void {
  localStorage.setItem(CACHE_KEY, JSON.stringify(entries));
}

function readPersisted(): Record<string, { t: number; url: string | null }> {
  return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
}

const app = {
  id: 'ente-auth',
  name: 'Ente Auth',
  githubUrl: 'https://github.com/ente-io/ente',
  platforms: ['windows', 'android'],
} as unknown as AppItem;

describe('evictFailedLookups', () => {
  beforeEach(() => {
    ghCache.clear();
    fdCache.clear();
    localStorage.removeItem(CACHE_KEY);
  });

  it('removes only failed (null) entries under the prefix, keeps successes', async () => {
    const okKey = 'repo|windows|stream-a|';
    const failKey = 'repo|windows|stream-b|';
    const otherKey = 'other|windows|x|';
    ghCache.set(okKey, Promise.resolve({ url: 'https://x/file.exe' } as never));
    ghCache.set(failKey, Promise.resolve(null));
    ghCache.set(otherKey, Promise.resolve(null));

    await evictFailedLookups(ghCache, 'repo|windows|');

    expect(ghCache.has(okKey)).toBe(true);
    expect(ghCache.has(failKey)).toBe(false);
    // A failure outside the prefix is not this retry's business.
    expect(ghCache.has(otherKey)).toBe(true);
  });

  it('treats a rejected memo entry as a failure and evicts it', async () => {
    ghCache.set('repo|linux|x|', Promise.reject(new Error('network gone')));
    await evictFailedLookups(ghCache, 'repo|linux|');
    expect(ghCache.has('repo|linux|x|')).toBe(false);
  });

  it('is a no-op when nothing matches', async () => {
    ghCache.set('a|windows|x|', Promise.resolve(null));
    await evictFailedLookups(ghCache, 'zzz|');
    expect(ghCache.has('a|windows|x|')).toBe(true);
  });
});

describe('purgePersistedFailures', () => {
  beforeEach(() => {
    localStorage.removeItem(CACHE_KEY);
  });

  it('removes persisted failures under the prefix and keeps successes', () => {
    seedPersisted({
      'repo|windows|stream|arch-a': { t: Date.now(), url: null },
      'repo|windows|stream|arch-b': { t: Date.now(), url: 'https://x/f.exe' },
      'repo|linux|x|arch': { t: Date.now(), url: null },
    });
    purgePersistedFailures('repo|windows|');
    const store = readPersisted();
    expect(store['repo|windows|stream|arch-a']).toBeUndefined();
    expect(store['repo|windows|stream|arch-b']).toBeDefined();
    expect(store['repo|linux|x|arch']).toBeDefined();
  });

  it('does not throw on missing or malformed store', () => {
    localStorage.removeItem(CACHE_KEY);
    expect(() => purgePersistedFailures('repo|')).not.toThrow();
    localStorage.setItem(CACHE_KEY, '{not json');
    expect(() => purgePersistedFailures('repo|')).not.toThrow();
  });
});

describe('retry wrappers', () => {
  beforeEach(() => {
    ghCache.clear();
    fdCache.clear();
    localStorage.removeItem(CACHE_KEY);
    // Deterministic offline resolver: no real network in unit tests (the
    // sandbox has one, which would make these tests slow and flaky).
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline (test)'))));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('retryGitHubResolve evicts the failed lookup so a re-resolve really happens', async () => {
    // Simulate the failed lookup the modal saw (failure TTL keeps it cached
    // for 30s, so a plain re-call would return the cached null instantly).
    const staleKey = 'ente-io/ente|windows|src|';
    const stalePromise = Promise.resolve(null);
    ghCache.set(staleKey, stalePromise);
    seedPersisted({
      'ente-io/ente|windows|src|arch-u': { t: Date.now(), url: null },
    });

    const result = await retryGitHubResolve(app, 'windows');
    // The retry re-resolved instead of reading the failure back: the memo
    // holds a NEW promise under the same key now.
    expect(ghCache.get(staleKey)).not.toBe(stalePromise);
    expect(result).toBeNull(); // no network in tests; the resolver answers null
    // The persisted failure was purged too, not re-written from the store.
    expect(readPersisted()['ente-io/ente|windows|src|arch-u']).toBeUndefined();
  });

  it('retryFdroidResolve evicts the failed F-Droid lookup', async () => {
    const stalePromise = Promise.resolve(null);
    fdCache.set('org.fossify.calendar', stalePromise);
    const result = await retryFdroidResolve('org.fossify.calendar');
    expect(fdCache.get('org.fossify.calendar')).not.toBe(stalePromise);
    expect(result).toBeNull();
  });

  it('retry leaves unrelated apps and successful lookups alone', async () => {
    const okPromise = Promise.resolve({ url: 'https://x/f.exe' } as never);
    ghCache.set('ente-io/ente|windows|src|', okPromise);
    ghCache.set('other/repo|windows|src|', Promise.resolve(null));

    await retryGitHubResolve({ ...app, githubUrl: 'https://github.com/other/repo' } as AppItem, 'windows');

    expect(ghCache.get('ente-io/ente|windows|src|')).toBe(okPromise);
  });
});
