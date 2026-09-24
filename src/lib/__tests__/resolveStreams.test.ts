// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  pickAssetDetailed,
  resolveDownloadFor,
  resolveGitHubDownload,
} from '../releaseFetch';
import { sanitizeAppItem } from '../appValidation';
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
  name?: string;
  prerelease?: boolean;
  assets: { name: string; size?: number }[];
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Mock shaped like the real APIs: /releases/latest answers with ONE release
 * object, /releases?per_page=N with an array, f-droid.org/api with the
 * package index. */
const apiMock = (latest: FakeRelease | null, list: FakeRelease[] = [], fdroid: Record<string, unknown> = {}) =>
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
    if (u.startsWith('https://f-droid.org/api/v1/packages/')) {
      const pkg = u.replace('https://f-droid.org/api/v1/packages/', '');
      if (fdroid[pkg]) return jsonResponse(fdroid[pkg]);
      return jsonResponse('Not Found', 404);
    }
    return jsonResponse('Unexpected URL', 404);
  });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ */
/* Scoring: cross-OS guards, archive tiers, legacy penalty             */
/* ------------------------------------------------------------------ */

describe('scoreAsset via pickAssetDetailed, cross-OS and archive rules', () => {
  const pick = (names: string[], platform: Parameters<typeof pickAssetDetailed>[1], arch = 'x86_64') =>
    pickAssetDetailed(
      names.map((name) => ({ name, size: 1, downloadUrl: `https://x/${name}` })),
      platform,
      arch
    );

  it('a macos-tagged zip never wins Windows over the windows zip', () => {
    const r = pick(['syncthing-macos-amd64-v2.1.5.zip', 'syncthing-windows-amd64-v2.1.5.zip'], 'windows');
    expect(r?.pick.name).toBe('syncthing-windows-amd64-v2.1.5.zip');
  });

  it('a linux-tagged zip is refused on mac; the osx zip wins', () => {
    const r = pick(['devtoys_linux_x64_portable.zip', 'devtoys_osx_x64.zip'], 'mac');
    expect(r?.pick.name).toBe('devtoys_osx_x64.zip');
  });

  it('a windows zip is refused on mac', () => {
    const r = pick(['app-windows-x64.zip', 'app-mac-universal.zip'], 'mac');
    expect(r?.pick.name).toBe('app-mac-universal.zip');
  });

  it('a darwin tarball is refused on linux; the linux tarball wins', () => {
    const r = pick(['ollama-darwin.tgz', 'ollama-linux-amd64.tar.zst'], 'linux');
    expect(r?.pick.name).toBe('ollama-linux-amd64.tar.zst');
  });

  it('linux accepts .tar.zst and .txz archives', () => {
    expect(pick(['app-9.15.0-x86_64.txz'], 'linux')?.pick.name).toBe('app-9.15.0-x86_64.txz');
    expect(pick(['app-linux-x64.tar.xz'], 'linux')?.pick.name).toBe('app-linux-x64.tar.xz');
  });

  it('the current installer beats the LegacyWindows build', () => {
    const r = pick(['KeePassXC-2.7.12-Win64-LegacyWindows.msi', 'KeePassXC-2.7.12-Win64.msi'], 'windows');
    expect(r?.pick.name).toBe('KeePassXC-2.7.12-Win64.msi');
  });

  it('zip and 7z are scoreable on Windows for repos that ship no installer', () => {
    expect(pick(['WhisperDesktop.zip'], 'windows')?.pick.name).toBe('WhisperDesktop.zip');
    expect(pick(['LosslessCut-win-x64.7z'], 'windows')?.pick.name).toBe('LosslessCut-win-x64.7z');
    expect(pick(['LosslessCut-win-arm64.7z'], 'windows', 'x86_64')).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Tag-stream patterns                                                 */
/* ------------------------------------------------------------------ */

describe('resolveGitHubDownload, tag-stream patterns', () => {
  let n = 0;
  const appInRepo = (over: Partial<AppItem> = {}) =>
    makeApp({ githubUrl: `https://github.com/example/streams-${++n}`, ...over });

  it('drops a latest release from the wrong stream and scans for the right one', async () => {
    vi.stubGlobal(
      'fetch',
      apiMock(
        { tag_name: 'ensu-v0.1.20', assets: [{ name: 'Ensu_0.1.20_x64-setup.exe', size: 9 }] },
        [
          { tag_name: 'ensu-v0.1.20', assets: [{ name: 'Ensu_0.1.20_x64-setup.exe', size: 9 }] },
          { tag_name: 'photos-v1.3.63', assets: [{ name: 'ente-photos-v1.3.63.apk', size: 9 }] },
        ]
      )
    );
    const app = appInRepo({ tagPatterns: { windows: '^photos-' } });
    const r = await resolveGitHubDownload(app, 'windows');
    expect(r).toBeNull(); // the photos stream has no exe: nothing for windows
    vi.unstubAllGlobals();
  });

  it('finds the pinned stream for android and never another product\u2019s apk', async () => {
    vi.stubGlobal(
      'fetch',
      apiMock(
        { tag_name: 'ensu-v0.1.20', assets: [{ name: 'ensu-v0.1.20.apk', size: 9 }] },
        [
          { tag_name: 'ensu-v0.1.20', assets: [{ name: 'ensu-v0.1.20.apk', size: 9 }] },
          { tag_name: 'locker-v1.0.9', assets: [{ name: 'ente-locker-v1.0.9.apk', size: 9 }] },
          { tag_name: 'photos-v1.3.63', assets: [{ name: 'ente-photos-v1.3.63.apk', size: 9 }] },
        ]
      )
    );
    const app = appInRepo({ tagPatterns: { android: '^photos-' } });
    const r = await resolveGitHubDownload(app, 'android', );
    // unmarked apk on an unknown-arch browser is refused by design, but it
    // must NOT fall back to the ensu or locker apk either
    expect(r).toBeNull();
    vi.unstubAllGlobals();
  });

  it('scans past wrong-stream releases to the stream the platform needs', async () => {
    // Tuta shape: the newest tag is the web stream (no assets), then the
    // android stream, then the desktop stream. A windows user must end at
    // the desktop installer, not at nothing or at the calendar apk.
    vi.stubGlobal(
      'fetch',
      apiMock({ tag_name: 'tutanota-release-360.0', assets: [] }, [
        { tag_name: 'tutanota-release-360.0', assets: [] },
        { tag_name: 'tutanota-ios-release-360.0', assets: [] },
        { tag_name: 'tuta-calendar-android-release-360.0', assets: [{ name: 'calendar-tutao-release-360.0.apk', size: 9 }] },
        { tag_name: 'tutanota-android-release-360.0', assets: [{ name: 'tutanota-app-tutao-release-360.0.apk', size: 9 }] },
        { tag_name: 'tutanota-desktop-release-360.0', assets: [{ name: 'tutanota-desktop-win.exe', size: 9 }] },
      ])
    );
    const app = appInRepo({ tagPatterns: { windows: '^tutanota-desktop-' } });
    const r = await resolveGitHubDownload(app, 'windows');
    expect(r?.filename).toBe('tutanota-desktop-win.exe');
    vi.unstubAllGlobals();
  });
});

/* ------------------------------------------------------------------ */
/* Weak-scan fallback                                                  */
/* ------------------------------------------------------------------ */

describe('resolveGitHubDownload, weak picks beat a dead end', () => {
  let n = 0;
  const appInRepo = (over: Partial<AppItem> = {}) =>
    makeApp({ githubUrl: `https://github.com/example/weak-${++n}`, ...over });

  it('returns a flagged weak pick when no confident pick exists anywhere', async () => {
    // Unknown host arch (the browser view) refuses every unmarked android
    // apk by design, so the weak-scan fallback is exercised on windows:
    // a portable zip scores 0 (weak) and must be returned flagged rather
    // than dropped, because it is the only file the repo ships.
    vi.stubGlobal(
      'fetch',
      apiMock(
        { tag_name: 'v2.0', assets: [] },
        [
          { tag_name: 'v2.0', assets: [] },
          { tag_name: 'v1.0', assets: [{ name: 'tool-1.0-portable.zip', size: 9 }] },
        ]
      )
    );
    const r = await resolveGitHubDownload(appInRepo(), 'windows');
    expect(r?.filename).toBe('tool-1.0-portable.zip');
    expect(r?.weak).toBe(true);
    vi.unstubAllGlobals();
  });
});

/* ------------------------------------------------------------------ */
/* Flagged (mislabelled prerelease) releases                           */
/* ------------------------------------------------------------------ */

describe('resolveGitHubDownload, includeFlaggedReleases', () => {
  let n = 0;
  const appInRepo = (over: Partial<AppItem> = {}) =>
    makeApp({ githubUrl: `https://github.com/example/flagged-${++n}`, ...over });

  const flaggedRepo = () =>
    apiMock(null, [
      { tag_name: 'v2.0.9.0', prerelease: true, assets: [{ name: 'devtoys_win_x64.exe', size: 9 }] },
    ]);

  it('ignores flagged releases by default', async () => {
    vi.stubGlobal('fetch', flaggedRepo());
    const r = await resolveGitHubDownload(appInRepo(), 'windows');
    expect(r).toBeNull();
    vi.unstubAllGlobals();
  });

  it('resolves flagged releases for an app that vouches for the repo', async () => {
    vi.stubGlobal('fetch', flaggedRepo());
    const r = await resolveGitHubDownload(appInRepo({ includeFlaggedReleases: true }), 'windows');
    expect(r?.filename).toBe('devtoys_win_x64.exe');
    vi.unstubAllGlobals();
  });
});

/* ------------------------------------------------------------------ */
/* resolveDownloadFor, F-Droid confidence ordering                    */
/* ------------------------------------------------------------------ */

describe('resolveDownloadFor, F-Droid beats a weak GitHub pick', () => {
  let n = 0;
  const appInRepo = (over: Partial<AppItem> = {}) =>
    makeApp({ githubUrl: `https://github.com/example/order-${++n}`, ...over });

  const fdroidIndex = {
    'com.example.app': {
      packages: [{ versionCode: 42, versionName: '1.2.3' }],
      suggestedVersionCode: 42,
    },
  };

  it('a weak unmarked github apk yields to the F-Droid build', async () => {
    vi.stubGlobal(
      'fetch',
      apiMock(
        { tag_name: 'v3.4.3', assets: [{ name: 'aegis-v3.4.3.apk', size: 9 }] },
        [{ tag_name: 'v3.4.3', assets: [{ name: 'aegis-v3.4.3.apk', size: 9 }] }],
        fdroidIndex
      )
    );
    const r = await resolveDownloadFor(appInRepo({ fdroidId: 'com.example.app' }), 'android');
    expect(r?.source).toBe('fdroid');
    expect(r?.filename).toBe('com.example.app_42.apk');
    vi.unstubAllGlobals();
  });

  it('a confident universal github apk still outranks F-Droid', async () => {
    // universal apks stay confident even for an unknown-arch browser, the
    // arch the test environment presents.
    vi.stubGlobal(
      'fetch',
      apiMock(
        { tag_name: 'v6.4.5', assets: [{ name: 'app-universal-release.apk', size: 9 }] },
        [{ tag_name: 'v6.4.5', assets: [{ name: 'app-universal-release.apk', size: 9 }] }],
        fdroidIndex
      )
    );
    const r = await resolveDownloadFor(appInRepo({ fdroidId: 'com.example.app' }), 'android');
    expect(r?.source).toBe('github');
    expect(r?.filename).toBe('app-universal-release.apk');
    vi.unstubAllGlobals();
  });

  it('the F-Droid fallback never fires off android', async () => {
    vi.stubGlobal('fetch', apiMock(null, []));
    const r = await resolveDownloadFor(appInRepo({ fdroidId: 'com.example.app' }), 'windows');
    expect(r).toBeNull();
    vi.unstubAllGlobals();
  });
});

/* ------------------------------------------------------------------ */
/* Validation of the new catalog fields                                */
/* ------------------------------------------------------------------ */

describe('sanitizeAppItem, tagPatterns and includeFlaggedReleases', () => {
  it('keeps valid tag patterns and the flagged-releases vouch', () => {
    const out = sanitizeAppItem(
      makeApp({
        tagPatterns: { windows: '^desktop-', android: '^photos-' },
        includeFlaggedReleases: true,
      })
    ).app;
    expect(out?.tagPatterns).toEqual({ windows: '^desktop-', android: '^photos-' });
    expect(out?.includeFlaggedReleases).toBe(true);
  });

  it('drops invalid regexes and non-boolean vouches', () => {
    const out = sanitizeAppItem(
      makeApp({
        tagPatterns: { windows: '(' },
        includeFlaggedReleases: 'yes' as unknown as boolean,
      })
    ).app;
    expect(out?.tagPatterns).toBeUndefined();
    expect(out?.includeFlaggedReleases).toBeUndefined();
  });
});
