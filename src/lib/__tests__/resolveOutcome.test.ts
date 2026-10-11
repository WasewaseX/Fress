// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
// @vitest-environment jsdom
//
// The typed outcome contract (ResolveOutcome). The plain resolver API
// answers `ResolvedDownload | null`; resolveWithOutcome says WHY. These
// tests pin the distinction the UI depends on:
//   - a failed lookup (rate limit / network / api) is NOT "no match";
//   - a genuine "no compatible asset" must not be reported as failed just
//     because an EARLIER run hit an error (fresh-run clearing);
//   - unsupported platforms never hit the network at all;
//   - the official-page fallback is an outcome, not a guess in the UI.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import { resolveWithOutcome, retryGitHubResolve } from '../release/resolve';
import { ghCache } from '../release/resolveCache';
import { AppItem, Platform } from '../../types';

function makeApp(over: Partial<AppItem>): AppItem {
  return {
    id: 'tool',
    name: 'Tool',
    tagline: '',
    description: '',
    whyItsAwesome: '',
    githubUrl: 'https://github.com/example/tool',
    websiteUrl: 'https://example.com',
    downloadUrl: undefined,
    category: 'Utilities & System',
    platforms: ['windows', 'linux'],
    license: 'MIT',
    stars: 1,
    isOwnerPick: false,
    isTrendingToday: false,
    tags: ['test'],
    addedAt: '2026-01-01',
    ...over,
  } as AppItem;
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const RELEASE = {
  tag_name: 'v1.2.3',
  name: 'Tool 1.2.3',
  published_at: '2026-08-01T00:00:00Z',
  html_url: 'https://github.com/example/tool/releases/tag/v1.2.3',
  assets: [
    { name: 'Tool-1.2.3-setup-x64.exe', size: 8_000_000, browser_download_url: 'https://github.com/example/tool/releases/download/v1.2.3/Tool-1.2.3-setup-x64.exe' },
  ],
};

const LIST = [RELEASE];

function apiMock(latest: unknown, list: unknown): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (u.endsWith('/releases/latest')) return jsonResponse(latest);
    if (u.includes('/releases?')) return jsonResponse(list);
    return jsonResponse('nope', 404);
  }) as unknown as typeof fetch;
}

describe('resolveWithOutcome (typed resolver contract)', () => {
  beforeEach(() => {
    ghCache.clear();
    localStorage.clear();
    vi.stubGlobal('fetch', apiMock(RELEASE, LIST));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a confident direct pick resolves with confident: true', async () => {
    const app = makeApp({});
    const out = await resolveWithOutcome(app, 'windows');
    expect(out.status).toBe('resolved');
    if (out.status === 'resolved') {
      expect(out.confident).toBe(true);
      expect(out.download.filename).toBe('Tool-1.2.3-setup-x64.exe');
    }
  });

  it('web/ios (and unconfigured platforms) are unsupported without touching the network', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const out = await resolveWithOutcome(makeApp({}), 'web');
    expect(out.status).toBe('unsupported');
    // An app with a repo but a platform with no resolver configured:
    const out2 = await resolveWithOutcome(makeApp({ platforms: ['web'] }), 'web');
    expect(out2.status).toBe('unsupported');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a rate limit is failed/rate-limit, never no-match', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse('API rate limit exceeded', 403)) as unknown as typeof fetch
    );
    const app = makeApp({ downloadUrl: 'https://example.com/download' });
    const out = await resolveWithOutcome(app, 'windows');
    expect(out.status).toBe('failed');
    if (out.status === 'failed') {
      expect(out.kind).toBe('rate-limit');
      expect(out.message.toLowerCase()).toContain('rate limit');
    }
  });

  it('a network outage is failed/network', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch
    );
    const out = await resolveWithOutcome(makeApp({}), 'linux');
    expect(out.status).toBe('failed');
    if (out.status === 'failed') expect(out.kind).toBe('network');
  });

  it('a failed run does not shadow a later genuine no-match (fresh-run clearing)', async () => {
    const app = makeApp({});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse('API rate limit exceeded', 403)) as unknown as typeof fetch
    );
    expect((await resolveWithOutcome(app, 'windows')).status).toBe('failed');

    // The outage is over; the repo genuinely has no Linux build. The stale
    // rate-limit record must not make THIS run look failed. (A GitHub app
    // lands on official-page - the releases page is the designed fallback
    // - but the FAILED status must be gone.)
    const empty = { tag_name: 'v1.2.3', name: 'x', published_at: '', html_url: '', assets: [] };
    vi.stubGlobal('fetch', apiMock(empty, [empty]));
    const afterRetry = await retryGitHubResolve(app, 'linux');
    expect(afterRetry).toBeNull();
    const out = await resolveWithOutcome(app, 'linux');
    expect(out.status).toBe('official-page');
    if (out.status === 'official-page') expect(out.why).toBe('no-direct-asset');
  });

  it('a genuine no-match (nothing compatible, no page fallback) is not failed', async () => {
    // F-Droid-only app (no repo, no website/download page): the F-Droid
    // lookup finds the package page but the API 404s => honest no-match.
    const app = makeApp({
      githubUrl: '',
      downloadUrl: undefined,
      websiteUrl: '',
      platforms: ['android'],
      fdroidId: 'org.example.missing',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse('Not Found', 404)) as unknown as typeof fetch
    );
    const out = await resolveWithOutcome(app, 'android');
    expect(out.status).toBe('no-match');
  });

  it('no direct asset anywhere yields the official-page fallback with its URL', async () => {
    const empty = { tag_name: 'v1.2.3', name: 'x', published_at: '', html_url: '', assets: [] };
    vi.stubGlobal('fetch', apiMock(empty, [empty]));
    const app = makeApp({ downloadUrl: 'https://example.com/download' });
    const out = await resolveWithOutcome(app, 'linux');
    expect(out.status).toBe('official-page');
    if (out.status === 'official-page') {
      expect(out.why).toBe('no-direct-asset');
      expect(out.pageUrl).toBe('https://example.com/download');
    }
  });

  it('an override change cannot read a pick cached under the old override', async () => {
    // One repo, two installable files: the installer and a portable build.
    const both = {
      tag_name: 'v1.2.3',
      name: 'Tool 1.2.3',
      published_at: '2026-08-01T00:00:00Z',
      html_url: 'https://github.com/example/tool/releases/tag/v1.2.3',
      assets: [
        { name: 'Tool-1.2.3-setup-x64.exe', size: 8_000_000, browser_download_url: 'https://github.com/example/tool/releases/download/v1.2.3/Tool-1.2.3-setup-x64.exe' },
        { name: 'Tool-1.2.3-portable-x64.zip', size: 7_000_000, browser_download_url: 'https://github.com/example/tool/releases/download/v1.2.3/Tool-1.2.3-portable-x64.zip' },
      ],
    };
    vi.stubGlobal('fetch', apiMock(both, [both]));

    const app = makeApp({});
    const first = await resolveWithOutcome(app, 'windows');
    expect(first.status).toBe('resolved');
    if (first.status === 'resolved') expect(first.download.filename).toBe('Tool-1.2.3-setup-x64.exe');

    // Same app identity, same repo - but the catalog author now pins the
    // portable family. If the cache key ignored asset overrides, this call
    // would come back from the SESSION memo with the setup exe picked under
    // the old configuration.
    const pinned = makeApp({ assetPatterns: { windows: '^Tool-.*-portable-x64\\.zip$' } });
    const second = await resolveWithOutcome(pinned, 'windows');
    expect(second.status).toBe('resolved');
    if (second.status === 'resolved') {
      expect(second.download.filename).toBe('Tool-1.2.3-portable-x64.zip');
      expect(second.download.matchedBy).toBe('override');
    }
  });
});

// Keep the Platform import referenced for consumers of this fixture shape.
void (null as unknown as Platform);
