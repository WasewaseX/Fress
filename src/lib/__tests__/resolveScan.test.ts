// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveGitHubDownload } from '../releaseFetch';
import { bestDownloadFor, getDownloadOptions } from '../appDownloads';
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

interface FakeRelease {
  tag_name: string;
  name: string;
  prerelease?: boolean;
  assets: { name: string; size: number; browser_download_url: string }[];
}

const withBrowserDownloadUrls = (r: FakeRelease) =>
  r.assets.map((a) => ({ ...a, browser_download_url: a.browser_download_url }));

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Mock shaped like the real GitHub API: /releases/latest answers with ONE
 * release object, /releases?per_page=N with an array. */
const ghApi = (latest: FakeRelease | null, list: FakeRelease[] = []) =>
  vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.endsWith('/releases/latest')) {
      if (!latest) return jsonResponse('Not Found', 404);
      return jsonResponse({ ...latest, assets: withBrowserDownloadUrls(latest) });
    }
    if (u.includes('/releases?per_page=')) {
      return jsonResponse(list.map((r) => ({ ...r, assets: withBrowserDownloadUrls(r) })));
    }
    return jsonResponse('Unexpected URL', 404);
  });

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/* getDownloadOptions, fallback ordering                              */
/* ------------------------------------------------------------------ */

describe('getDownloadOptions, fallback ordering', () => {
  it('offers the official download page before the forge releases page', () => {
    const app = makeApp({ downloadUrl: 'https://example.com/download' });
    const options = getDownloadOptions(app, 'windows');
    expect(options[0].label).toBe('Official download page');
    expect(options[1].label).toBe('GitHub Releases');
  });

  it('still offers the releases page when no official page exists', () => {
    const app = makeApp({ downloadUrl: undefined });
    const options = getDownloadOptions(app, 'windows');
    expect(options.map((o) => o.label)).toContain('GitHub Releases');
  });

  it('never offers a releases page for platforms the curated table covers', () => {
    // tor-browser has curated entries and its primary repo is only a
    // launcher mirror: a dead "GitHub Releases" link must not appear.
    const tor = { ...makeApp({}), id: 'tor-browser', downloadUrl: undefined } as AppItem;
    expect(getDownloadOptions(tor, 'windows').map((o) => o.label)).toEqual(['Windows bundle']);
  });

  it('the best download for an Android-only repo user is the official page', () => {
    // proton-mail's GitHub repo only ships Android APKs; a Windows user must
    // land on the official page, not the (Android) releases list.
    const app = makeApp({
      id: 'proton-mail',
      githubUrl: 'https://github.com/ProtonMail/proton-mail-android',
      downloadUrl: 'https://proton.me/mail/download',
    });
    const best = bestDownloadFor(app, 'windows');
    expect(best?.label).toBe('Official download page');
  });
});

/* ------------------------------------------------------------------ */
/* resolveGitHubDownload, recent-releases scan                        */
/* ------------------------------------------------------------------ */

describe('resolveGitHubDownload, recent-releases scan', () => {
  // The resolver caches per repo|platform for the whole session, so every
  // test uses its own repo slug to stay independent.
  let n = 0;
  const appInRepo = (over: Partial<AppItem> = {}) =>
    makeApp({ githubUrl: `https://github.com/example/scan-${++n}`, ...over });

  it('resolves from /releases/latest when it has a match (1 request)', async () => {
    const fetchMock = ghApi({
      tag_name: 'v2.0.0',
      name: 'Tool 2.0.0',
      assets: [{ name: 'Tool-2.0.0-x64-setup.exe', size: 100, browser_download_url: 'https://example.com/x.exe' }],
    });
    vi.stubGlobal('fetch', fetchMock);
    const r = await resolveGitHubDownload(appInRepo(), 'windows');
    expect(r?.filename).toBe('Tool-2.0.0-x64-setup.exe');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('scans recent releases when the latest release is the wrong stream', async () => {
    // Obsidian-style repo: the latest release is the mobile stream; the
    // desktop installer only appears under a different tag.
    const fetchMock = ghApi(
      {
        tag_name: 'mobile-v1.8.10',
        name: 'Mobile 1.8.10',
        assets: [{ name: 'Tool-mobile-1.8.10.apk', size: 100, browser_download_url: 'https://example.com/m.apk' }],
      },
      [
        {
          tag_name: 'mobile-v1.8.10',
          name: 'Mobile 1.8.10',
          assets: [{ name: 'Tool-mobile-1.8.10.apk', size: 100, browser_download_url: 'https://example.com/m.apk' }],
        },
        {
          tag_name: 'v1.13.7',
          name: 'Desktop 1.13.7',
          assets: [{ name: 'Tool-1.13.7.exe', size: 100, browser_download_url: 'https://example.com/d.exe' }],
        },
      ]
    );
    vi.stubGlobal('fetch', fetchMock);
    const r = await resolveGitHubDownload(appInRepo(), 'windows');
    expect(r?.filename).toBe('Tool-1.13.7.exe');
    expect(r?.version).toBe('1.13.7');
    vi.unstubAllGlobals();
  });

  it('scans recent releases when /releases/latest is a 404 (no stable release)', async () => {
    const fetchMock = ghApi(
      null,
      [
        {
          tag_name: 'v0.9.0',
          name: 'Tool 0.9.0',
          assets: [{ name: 'tool-0.9.0-x86_64.AppImage', size: 100, browser_download_url: 'https://example.com/a.AppImage' }],
        },
      ]
    );
    vi.stubGlobal('fetch', fetchMock);
    const r = await resolveGitHubDownload(appInRepo(), 'linux');
    expect(r?.filename).toBe('tool-0.9.0-x86_64.AppImage');
    vi.unstubAllGlobals();
  });

  it('skips prerelease entries while scanning', async () => {
    const fetchMock = ghApi(
      null,
      [
        {
          tag_name: 'v2.0.0-beta.1',
          name: 'Beta',
          prerelease: true,
          assets: [{ name: 'Tool-beta-x64-setup.exe', size: 100, browser_download_url: 'https://example.com/beta.exe' }],
        },
        {
          tag_name: 'v1.9.0',
          name: 'Stable',
          assets: [{ name: 'Tool-1.9.0-x64-setup.exe', size: 100, browser_download_url: 'https://example.com/stable.exe' }],
        },
      ]
    );
    vi.stubGlobal('fetch', fetchMock);
    const r = await resolveGitHubDownload(appInRepo(), 'windows');
    expect(r?.filename).toBe('Tool-1.9.0-x64-setup.exe');
    vi.unstubAllGlobals();
  });

  it('returns null when neither latest nor the scan has a match', async () => {
    const onlyApk: FakeRelease = {
      tag_name: 'v1.0.0',
      name: 'Tool 1.0.0',
      assets: [{ name: 'Tool-1.0.0.apk', size: 100, browser_download_url: 'https://example.com/x.apk' }],
    };
    vi.stubGlobal('fetch', ghApi(onlyApk, [onlyApk]));
    const r = await resolveGitHubDownload(appInRepo(), 'windows');
    expect(r).toBeNull();
    vi.unstubAllGlobals();
  });

  it('a confident pick in the scan outranks a weak pick in the latest release', async () => {
    // The latest release only carries an odd low-confidence tarball; an
    // older release has the real installer. Both resolution paths now run
    // the same confidence rule, so the weak latest pick loses to the
    // confident scan pick instead of short-circuiting the resolve.
    const latest: FakeRelease = {
      tag_name: 'v2.1.0',
      name: 'Tool 2.1.0',
      assets: [{ name: 'tool-2.1.0.tar.gz', size: 100, browser_download_url: 'https://example.com/t.tar.gz' }],
    };
    const older: FakeRelease = {
      tag_name: 'v2.0.0',
      name: 'Tool 2.0.0',
      assets: [{ name: 'tool-2.0.0-x86_64.AppImage', size: 100, browser_download_url: 'https://example.com/app.AppImage' }],
    };
    vi.stubGlobal('fetch', ghApi(latest, [latest, older]));
    const r = await resolveGitHubDownload(appInRepo(), 'linux');
    expect(r?.filename).toBe('tool-2.0.0-x86_64.AppImage');
    expect(r?.weak).toBeFalsy();
    vi.unstubAllGlobals();
  });

  it('falls back to the weak latest pick (flagged) when nothing confident exists', async () => {
    // No release carries a confident match: the weak pick from the latest
    // release is still a real download, so it is returned - flagged, so
    // the UI shows the caution instead of pretending it is a sure thing.
    const latest: FakeRelease = {
      tag_name: 'v2.1.0',
      name: 'Tool 2.1.0',
      assets: [{ name: 'tool-2.1.0.tar.gz', size: 100, browser_download_url: 'https://example.com/t.tar.gz' }],
    };
    vi.stubGlobal('fetch', ghApi(latest, [latest]));
    const r = await resolveGitHubDownload(appInRepo(), 'linux');
    expect(r?.filename).toBe('tool-2.1.0.tar.gz');
    expect(r?.weak).toBe(true);
    vi.unstubAllGlobals();
  });
});
