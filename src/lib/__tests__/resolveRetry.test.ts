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
// successes or unrelated apps. The wrapper tests also prove the important
// half of the contract: a Retry performs a FRESH network request instead
// of handing back the cached rejected value.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import {
  evictFailedLookups,
  purgePersistedFailures,
  ghCache,
  fdCache,
  ghCacheKey,
} from '../release/resolveCache';
import {
  retryGitHubResolve,
  retryFdroidResolve,
  resolveGitHubDownload,
} from '../release/resolve';
import { retryOfficialResolve } from '../officialResolvers';
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
    // The key is the REAL computed key, so the eviction prefix proves it
    // covers exactly this lookup.
    const staleKey = ghCacheKey(app, 'windows', 'ente-io/ente');
    const stalePromise = Promise.resolve(null);
    ghCache.set(staleKey, stalePromise);
    seedPersisted({
      [`${staleKey}|arch-u`]: { t: Date.now(), url: null },
    });

    const result = await retryGitHubResolve(app, 'windows');
    // The retry re-resolved instead of reading the failure back: the memo
    // holds a NEW promise under the same key now.
    expect(ghCache.get(staleKey)).not.toBe(stalePromise);
    expect(result).toBeNull(); // no network in tests; the resolver answers null
    // The persisted failure was purged too, not re-written from the store.
    expect(readPersisted()[`${staleKey}|arch-u`]).toBeUndefined();
  });

  it('retry performs a FRESH network request and recovers when the API is back', async () => {
    // First run: the network is down. The resolver memoizes the failure.
    const offlineFetch = vi.fn(() => Promise.reject(new Error('network down (test)')));
    vi.stubGlobal('fetch', offlineFetch);
    const failed = await resolveGitHubDownload(app, 'windows');
    expect(failed).toBeNull();
    const callsAfterFailure = offlineFetch.mock.calls.length;
    expect(callsAfterFailure).toBeGreaterThan(0);

    // Second run THROUGH THE RETRY WRAPPER: the API answers. A retry that
    // only replayed the cached failure would never hit fetch again and
    // could never recover - this is the behavior the button exists for.
    const releasePayload = {
      tag_name: 'v5.0.4',
      name: 'Ente Auth 5.0.4',
      published_at: '2026-09-01T00:00:00Z',
      html_url: 'https://github.com/ente-io/ente/releases/tag/v5.0.4',
      assets: [
        { name: 'EnteAuth-Setup-5.0.4.exe', size: 9_000_000, browser_download_url: 'https://github.com/ente-io/ente/releases/download/v5.0.4/EnteAuth-Setup-5.0.4.exe' },
      ],
    };
    const listPayload = [releasePayload];
    const recoverFetch = vi.fn(async (input: string | URL | Request) => {
      const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (u.endsWith('/releases/latest')) {
        return new Response(JSON.stringify(releasePayload), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes('/releases?')) {
        return new Response(JSON.stringify(listPayload), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('Not Found', { status: 404 });
    });
    vi.stubGlobal('fetch', recoverFetch);

    const recovered = await retryGitHubResolve(app, 'windows');
    expect(recovered).not.toBeNull();
    expect(recovered!.url).toBe('https://github.com/ente-io/ente/releases/download/v5.0.4/EnteAuth-Setup-5.0.4.exe');
    expect(recovered!.filename).toBe('EnteAuth-Setup-5.0.4.exe');
    expect(recovered!.version).toBe('5.0.4');
    expect(recoverFetch.mock.calls.length).toBeGreaterThan(0);
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

  it('Signal Android malformed sha256sum resolves UNVERIFIED through the trusted gate (end to end)', async () => {
    // The Signal Android resolver used to assign latest.json's sha256sum
    // straight onto the download, bypassing attachTrustedDigests entirely -
    // a malformed value would have entered the engine looking trusted.
    // The retry wrapper is the clean way to drive the cached official path
    // (it evicts the failed memo, so this really fetches). The casing/
    // normalization half of this contract is pinned at the official()
    // constructor in officialResolvers.test.ts - a cached SUCCESS is never
    // evicted by a retry (by design), so a second variant needs its own
    // cache key and belongs at the constructor level.
    const signalApp = { id: 'signal', name: 'Signal', platforms: ['android'] } as unknown as AppItem;
    const latestJson = JSON.stringify({
      url: 'https://updates.signal.org/android/signal-android-8.28.0.apk',
      versionName: '8.28.0',
      sha256sum: 'definitely-not-a-digest',
    });
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(latestJson, { status: 200, headers: { 'Content-Type': 'application/json' } })
    ) as unknown as typeof fetch);

    const unverified = await retryOfficialResolve(signalApp, 'android');
    expect(unverified).not.toBeNull();
    expect(unverified!.url).toBe('https://updates.signal.org/android/signal-android-8.28.0.apk');
    expect(unverified!.filename).toBe('signal-android-8.28.0.apk');
    expect(unverified!.expectedSha256).toBeUndefined(); // malformed -> unverified, never trusted
  });
});
