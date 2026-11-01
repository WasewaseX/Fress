// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
// @vitest-environment jsdom
//
// Issue #127: a WEAK GitHub pick used to return immediately on desktop,
// because the old gate `gh && (!gh.weak || !fdAllowed)` was always true
// there (`!fdAllowed` - Android-only guard). The vendor's official
// manifest - which the resolver's own documentation ranks ABOVE a weak
// GitHub guess - never got its turn. These tests pin the restored order
// of trust on desktop, using the REAL registered VLC resolver:
//   - weak GitHub pick + an answering official manifest -> official wins;
//   - weak GitHub pick + an empty official manifest -> the weak pick is
//     still returned (flagged), never dropped;
//   - resolveWithOutcome reports the same answers through the typed
//     contract (confident for official, unconfident for the weak pick).

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import { resolveDownloadFor, resolveWithOutcome } from '../release/resolve';
import { __clearOfficialCacheForTests } from '../officialResolvers';
import { ghCache } from '../release/resolveCache';
import { AppItem } from '../../types';

function makeApp(over: Partial<AppItem>): AppItem {
  return {
    id: 'vlc',
    name: 'VLC',
    tagline: '',
    description: '',
    whyItsAwesome: '',
    githubUrl: 'https://github.com/videolan/vlc',
    websiteUrl: 'https://www.videolan.org',
    downloadUrl: undefined,
    category: 'Utilities & System',
    platforms: ['windows', 'linux'],
    license: 'GPL-2.0',
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

const htmlResponse = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html' } });

// The GitHub repo ships ONLY a portable zip on windows: a score-0 asset,
// so the GitHub picker flags its pick weak (the same shape the
// weak-scan-fallback tests use).
const WEAK_LIST = [
  {
    tag_name: 'v3.0.21',
    name: 'VLC 3.0.21',
    published_at: '2026-06-01T00:00:00Z',
    html_url: 'https://github.com/videolan/vlc/releases/tag/v3.0.21',
    assets: [
      {
        name: 'vlc-3.0.21-portable.zip',
        size: 9,
        browser_download_url:
          'https://github.com/videolan/vlc/releases/download/v3.0.21/vlc-3.0.21-portable.zip',
      },
    ],
  },
];

const VLC_DIR_PAGE = (files: string[]) =>
  // The real videolan index lists bare relative filenames; the resolver's
  // anchored regex (^vlc-[\d.]+-win64\.exe$) only matches those.
  `<html><body>${files.map((f) => `<a href="${f}">${f}</a>`).join('')}</body></html>`;

function routerFetch(opts: { latest: unknown; list: unknown; vlcDir?: string[] | null }): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (u.endsWith('/releases/latest')) return jsonResponse(opts.latest);
    if (u.includes('/releases?')) return jsonResponse(opts.list);
    if (u.startsWith('https://get.videolan.org/vlc/last/win64/')) {
      return opts.vlcDir === null
        ? htmlResponse('<html><body></body></html>')
        : htmlResponse(VLC_DIR_PAGE(opts.vlcDir ?? []));
    }
    return jsonResponse('nope', 404);
  }) as unknown as typeof fetch;
}

describe('issue #127: an official manifest outranks a weak GitHub pick on desktop', () => {
  beforeEach(() => {
    ghCache.clear();
    __clearOfficialCacheForTests();
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a weak GitHub pick survives when the official manifest answers nothing', async () => {
    vi.stubGlobal(
      'fetch',
      routerFetch({
        latest: { tag_name: 'v3.0.21', assets: [] },
        list: WEAK_LIST,
        vlcDir: [],
      })
    );
    const r = await resolveDownloadFor(makeApp({}), 'windows');
    expect(r).not.toBeNull();
    expect(r!.filename).toBe('vlc-3.0.21-portable.zip');
    expect(r!.weak).toBe(true);
  });

  it('resolveWithOutcome still reports the weak pick (unconfident) when the official manifest is empty', async () => {
    vi.stubGlobal(
      'fetch',
      routerFetch({
        latest: { tag_name: 'v3.0.21', assets: [] },
        list: WEAK_LIST,
        vlcDir: null,
      })
    );
    const out = await resolveWithOutcome(makeApp({}), 'windows');
    expect(out.status).toBe('resolved');
    if (out.status === 'resolved') {
      expect(out.download.filename).toBe('vlc-3.0.21-portable.zip');
      expect(out.confident).toBe(false);
    }
  });

  it('a confident GitHub pick still wins outright (order of trust untouched)', async () => {
    const confident = [
      {
        tag_name: 'v3.0.21',
        name: 'VLC 3.0.21',
        published_at: '2026-06-01T00:00:00Z',
        html_url: 'https://github.com/videolan/vlc/releases/tag/v3.0.21',
        assets: [
          {
            name: 'vlc-3.0.21-win64.exe',
            size: 40_000_000,
            browser_download_url:
              'https://github.com/videolan/vlc/releases/download/v3.0.21/vlc-3.0.21-win64.exe',
          },
        ],
      },
    ];
    vi.stubGlobal(
      'fetch',
      routerFetch({
        latest: { tag_name: 'v3.0.21', assets: [] },
        list: confident,
        vlcDir: ['vlc-3.0.20-win64.exe'],
      })
    );
    const r = await resolveDownloadFor(makeApp({}), 'windows');
    expect(r).not.toBeNull();
    expect(r!.source).not.toBe('official');
    expect(r!.filename).toBe('vlc-3.0.21-win64.exe');
  });

  it('the official installer wins over a weak GitHub guess (windows)', async () => {
    vi.stubGlobal(
      'fetch',
      routerFetch({
        latest: { tag_name: 'v3.0.21', assets: [] },
        list: WEAK_LIST,
        vlcDir: ['vlc-3.0.21-win64.exe'],
      })
    );
    const r = await resolveDownloadFor(makeApp({}), 'windows');
    expect(r).not.toBeNull();
    expect(r!.source).toBe('official');
    expect(r!.filename).toBe('vlc-3.0.21-win64.exe');
    expect(r!.weak).toBeFalsy();
  });

  it('resolveWithOutcome mirrors the same precedence in its typed answer', async () => {
    vi.stubGlobal(
      'fetch',
      routerFetch({
        latest: { tag_name: 'v3.0.21', assets: [] },
        list: WEAK_LIST,
        vlcDir: ['vlc-3.0.21-win64.exe'],
      })
    );
    const out = await resolveWithOutcome(makeApp({}), 'windows');
    expect(out.status).toBe('resolved');
    if (out.status === 'resolved') {
      expect(out.download.source).toBe('official');
      expect(out.confident).toBe(true);
    }
  });


});
