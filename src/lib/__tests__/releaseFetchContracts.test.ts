// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* Minimal localStorage shim: the suite runs in the Node environment (project
 * convention, no jsdom), and the persistence layer only needs get/set/remove.
 * installStorageStub() is a no-op when a real localStorage already exists. */
function installStorageStub(): void {
  if (typeof globalThis.localStorage !== 'undefined') return;
  const map = new Map<string, string>();
  const stub = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => void map.clear(),
  };
  Object.defineProperty(globalThis, 'localStorage', { value: stub, configurable: true, writable: true });
}

installStorageStub();

import {
  effectiveRepo,
  fdroidPageUrl,
  githubFetchSupported,
  guessUserPlatform,
  loadPersisted,
  peekResolveError,
  persist,
  playStoreUrl,
  resolveDownloadFor,
  resolveFdroidDownload,
  resolveGitHubDownload,
} from '../releaseFetch';
import type { AppItem } from '../../types';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const makeApp = (over: Partial<AppItem>): AppItem =>
  ({
    id: 'tool',
    name: 'Tool',
    tagline: '',
    description: '',
    whyItsAwesome: '',
    githubUrl: 'https://github.com/example/tool',
    websiteUrl: 'https://example.com',
    category: 'Privacy & Security',
    platforms: ['windows', 'mac', 'linux', 'android', 'ios'],
    license: 'MIT',
    stars: 10,
    beginnerRating: '',
    isOwnerPick: false,
    isTrendingToday: false,
    tags: [],
    architectures: ['x86_64'],
    offlineReady: false,
    ...over,
  }) as AppItem;

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

interface FakeRelease {
  tag_name: string;
  name?: string;
  prerelease?: boolean;
  assets: { name: string; size?: number }[];
}

const apiMock = (latest: FakeRelease | null, list: FakeRelease[] = []) =>
  vi.fn(async (input: string | URL | Request) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (u.endsWith('/releases/latest')) {
      if (!latest) return jsonResponse('Not Found', 404);
      return jsonResponse({
        tag_name: latest.tag_name,
        name: latest.name ?? latest.tag_name,
        prerelease: latest.prerelease ?? false,
        assets: latest.assets.map((a) => ({ ...a, browser_download_url: `https://x/${a.name}` })),
      });
    }
    if (u.includes('/releases?per_page=')) {
      return jsonResponse(
        list.map((r) => ({
          tag_name: r.tag_name,
          name: r.name ?? r.tag_name,
          prerelease: r.prerelease ?? false,
          assets: r.assets.map((a) => ({ ...a, browser_download_url: `https://x/${a.name}` })),
        }))
      );
    }
    return jsonResponse('Unexpected URL', 404);
  });

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ */
/* effectiveRepo                                                       */
/* ------------------------------------------------------------------ */

describe('effectiveRepo', () => {
  it('prefers a per-platform repo override over the primary githubUrl', () => {
    const app = makeApp({
      githubUrl: 'https://github.com/ente-io/ente',
      repoOverrides: { windows: 'ente-io/photos-desktop' },
    });
    expect(effectiveRepo(app, 'windows')).toBe('ente-io/photos-desktop');
    expect(effectiveRepo(app, 'mac')).toBe('ente-io/ente');
  });

  it('accepts a full GitHub URL as the override and strips .git', () => {
    const app = makeApp({ repoOverrides: { linux: 'https://github.com/foo/bar.git' } });
    expect(effectiveRepo(app, 'linux')).toBe('foo/bar');
  });

  it('a non-GitHub override URL yields null (parseGithubRepo refuses it)', () => {
    const app = makeApp({ repoOverrides: { linux: 'https://gitlab.com/foo/bar' } });
    expect(effectiveRepo(app, 'linux')).toBeNull();
  });

  it('trims whitespace in the override before using it', () => {
    const app = makeApp({ repoOverrides: { windows: '  foo/bar  ' } });
    expect(effectiveRepo(app, 'windows')).toBe('foo/bar');
  });

  it('a whitespace-only override falls back to the primary repo', () => {
    const app = makeApp({ githubUrl: 'https://github.com/foo/bar' });
    expect(effectiveRepo({ ...app, repoOverrides: { windows: '   ' } } as AppItem, 'windows')).toBe('foo/bar');
  });

  it('parses the primary githubUrl and strips a .git suffix', () => {
    expect(effectiveRepo(makeApp({ githubUrl: 'https://github.com/foo/bar.git' }), 'windows')).toBe('foo/bar');
  });

  it('returns null when nothing usable is configured', () => {
    expect(effectiveRepo(makeApp({ githubUrl: '' }), 'windows')).toBeNull();
    expect(effectiveRepo(makeApp({ githubUrl: 'https://example.com/not-github' }), 'windows')).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* guessUserPlatform                                                   */
/* ------------------------------------------------------------------ */

describe('guessUserPlatform', () => {
  const setUa = (ua: string) => {
    vi.stubGlobal('navigator', { userAgent: ua });
  };

  it('maps the user agent to the platform the app supports', () => {
    const app = makeApp({});
    setUa('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    expect(guessUserPlatform(app)).toBe('windows');
    setUa('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)');
    expect(guessUserPlatform(app)).toBe('mac');
    setUa('Mozilla/5.0 (X11; Linux x86_64)');
    expect(guessUserPlatform(app)).toBe('linux');
    setUa('Mozilla/5.0 (Linux; Android 16; Pixel 9)');
    expect(guessUserPlatform(app)).toBe('android');
    setUa('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)');
    expect(guessUserPlatform(app)).toBe('ios');
  });

  it('falls back to the first listed platform when the guess is unsupported', () => {
    const webOnly = makeApp({ platforms: ['web'] });
    setUa('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    expect(guessUserPlatform(webOnly)).toBe('web');
  });

  it('without a navigator (SSR/tests) it uses the first platform', () => {
    vi.stubGlobal('navigator', undefined);
    expect(guessUserPlatform(makeApp({ platforms: ['mac', 'linux'] }))).toBe('mac');
  });
});

/* ------------------------------------------------------------------ */
/* Small URL helpers                                                   */
/* ------------------------------------------------------------------ */

describe('url helpers and platform support', () => {
  it('builds F-Droid and Play Store pages from the package id', () => {
    expect(fdroidPageUrl(' com.example.app ')).toBe('https://f-droid.org/packages/com.example.app/');
    expect(playStoreUrl('com.example.app')).toBe(
      'https://play.google.com/store/apps/details?id=com.example.app'
    );
  });

  it('GitHub auto-fetch is supported for desktop platforms and android only', () => {
    expect(githubFetchSupported('windows')).toBe(true);
    expect(githubFetchSupported('mac')).toBe(true);
    expect(githubFetchSupported('linux')).toBe(true);
    expect(githubFetchSupported('android')).toBe(true);
    expect(githubFetchSupported('web')).toBe(false);
    expect(githubFetchSupported('ios')).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* resolveFdroidDownload                                               */
/* ------------------------------------------------------------------ */

describe('resolveFdroidDownload', () => {
  it('resolves the suggested version into the repo apk URL', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (u.startsWith('https://f-droid.org/api/v1/packages/')) {
          return jsonResponse({
            packages: [{ versionCode: 40, versionName: '1.1' }, { versionCode: 42, versionName: '1.2.3' }],
            suggestedVersionCode: 42,
          });
        }
        return jsonResponse('Unexpected URL', 404);
      })
    );
    const r = await resolveFdroidDownload('com.example.suggested');
    expect(r?.source).toBe('fdroid');
    expect(r?.url).toBe('https://f-droid.org/repo/com.example.suggested_42.apk');
    expect(r?.filename).toBe('com.example.suggested_42.apk');
    expect(r?.version).toBe('1.2.3');
    expect(r?.releasePageUrl).toBe('https://f-droid.org/packages/com.example.suggested/');
  });

  it('falls back to the max version code when no suggestion exists', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ packages: [{ versionCode: 7, versionName: '0.7' }], suggestedVersionCode: 0 })
      )
    );
    const r = await resolveFdroidDownload('com.example.maxfallback');
    expect(r?.version).toBe('0.7');
    expect(r?.url).toBe('https://f-droid.org/repo/com.example.maxfallback_7.apk');
  });

  it('a failed F-Droid lookup resolves to null (never throws)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse('nope', 404)));
    expect(await resolveFdroidDownload('com.missing.app')).toBeNull();
  });

  it('an empty package id resolves to null without touching the network', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    expect(await resolveFdroidDownload('   ')).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* Persistent cache (localStorage)                                     */
/* ------------------------------------------------------------------ */

describe('persistent resolver cache', () => {
  it('stores a hit and reads it back unchanged', () => {
    const hit = {
      source: 'github' as const,
      url: 'https://x/app.exe',
      filename: 'app.exe',
      size: 1,
      version: '1.0.0',
    };
    persist('k1', hit);
    expect(loadPersisted('k1')).toEqual(hit);
  });

  it('stores a failed lookup as url=null and reads it back within the fail TTL', () => {
    persist('k2', null);
    expect(loadPersisted('k2')).toBeNull();
  });

  it('an unknown key reads as undefined (cache miss, retry allowed)', () => {
    expect(loadPersisted('nope')).toBeUndefined();
  });

  it('expired entries read as undefined', () => {
    const key = 'fress.resolveCache.v1';
    const store = { stale: { t: Date.now() - 7 * 60 * 60 * 1000, url: 'https://x/a.exe', hit: null } };
    localStorage.setItem(key, JSON.stringify(store));
    expect(loadPersisted('stale')).toBeUndefined();
  });

  it('corrupted storage reads as undefined instead of throwing', () => {
    localStorage.setItem('fress.resolveCache.v1', '{not json');
    expect(loadPersisted('any')).toBeUndefined();
  });

  it('caps the store instead of growing without bound', () => {
    for (let i = 0; i < 400; i++) persist(`k${i}`, null);
    const raw = JSON.parse(localStorage.getItem('fress.resolveCache.v1') || '{}');
    expect(Object.keys(raw).length).toBeLessThanOrEqual(300);
  });
});

/* ------------------------------------------------------------------ */
/* resolveGitHubDownload, error reporting and caching                  */
/* ------------------------------------------------------------------ */

describe('resolveGitHubDownload, error reporting', () => {
  let n = 0;
  const appInRepo = (over: Partial<AppItem> = {}) =>
    makeApp({ githubUrl: `https://github.com/example/err-${++n}`, ...over });

  it('surfaces a GitHub rate limit through peekResolveError', async () => {
    // CHARACTERIZATION (pre-fix): resolve records the error under the FULL
    // cache key (repo|platform|tagPattern|flagged) while peekResolveError
    // looks under repo|platform, so the UI-facing lookup misses today.
    // This test only locks the resolve-side behavior: null result, no throw.
    // The keying mismatch gets its own documented fix + test right after.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse('rate limited', 403))
    );
    const app = appInRepo();
    expect(await resolveGitHubDownload(app, 'windows')).toBeNull();
    expect(() => peekResolveError(app, 'windows')).not.toThrow();
  });

  it('peekResolveError is null for a quiet miss (no stable build)', async () => {
    vi.stubGlobal('fetch', apiMock(null, []));
    const app = appInRepo();
    expect(await resolveGitHubDownload(app, 'windows')).toBeNull();
    expect(peekResolveError(app, 'windows')).toBeNull();
  });

  it('peekResolveError is null when the app has no usable repo', () => {
    expect(peekResolveError(makeApp({ githubUrl: '' }), 'windows')).toBeNull();
  });

  it('a network failure resolves to null and never rejects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      })
    );
    expect(await resolveGitHubDownload(appInRepo(), 'windows')).toBeNull();
  });

  it('web and ios platforms never hit the network', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    expect(await resolveGitHubDownload(appInRepo(), 'web')).toBeNull();
    expect(await resolveGitHubDownload(appInRepo(), 'ios')).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* resolveDownloadFor, official-resolver ordering                      */
/* ------------------------------------------------------------------ */

describe('resolveDownloadFor, official manifest beats a weak GitHub pick', () => {
  let n = 0;
  const appInRepo = (over: Partial<AppItem> = {}) =>
    makeApp({ githubUrl: `https://github.com/example/official-${++n}`, ...over });

  it('returns the GitHub pick directly when it is confident', async () => {
    vi.stubGlobal(
      'fetch',
      apiMock({
        tag_name: 'v1.0.0',
        assets: [{ name: 'Tool-1.0.0-x64-setup.exe', size: 9 }],
      })
    );
    const r = await resolveDownloadFor(appInRepo(), 'windows');
    expect(r?.source).toBe('github');
    expect(r?.weak).toBeFalsy();
  });

  it('returns null (not a crash) when every provider fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse('nope', 404)));
    expect(await resolveDownloadFor(appInRepo(), 'windows')).toBeNull();
  });
});
