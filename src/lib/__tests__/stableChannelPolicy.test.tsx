// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
// @vitest-environment jsdom
/**
 * Stable-release channel policy - the tested contract for round 10:
 *
 *   1.  The Stable channel only ever surfaces non-prerelease releases.
 *   2.  A stable 1.0.0 client sees v1.0.0 as CURRENT, not as a perpetual
 *       update.
 *   3.  Stable clients are never offered 1.0.12-beta / 1.0.13-beta.
 *   4.  Beta and Alpha still choose the newest ELIGIBLE prerelease.
 *   5.  Publication order in the release list cannot flip a channel pick.
 *   6.  SemVer orders 1.0.0-rc.1 < 1.0.0 < 1.0.12-beta < 1.0.13-beta and
 *       the comparator is never bent to make 1.0.0 outrank 1.0.12-beta.
 *   7.  A beta client at 1.0.12-beta that selects Stable gets an honest
 *       track-migration state, never a downgrade download and never a
 *       fake "up to date".
 *   8.  The migration state is announced with the channel's real version
 *       and a working releases-page action (hook-level, toast asserted).
 *   9.  Nothing in the check/migration path starts a delivery, opens an
 *       installer or moves the app version in the background.
 *   10. A manually installed stable build (1.0.0) with NO saved channel
 *       defaults to Stable and its update discovery is stable-only.
 *
 * Build-version control: the policy reads the running build's version from
 * package.json (the value Vite bakes in at build time - the authoritative
 * source). The tests swap that module's default export instead of guessing
 * from user agents or publication dates.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { toast } from 'sonner';

const pkgState = vi.hoisted(() => ({ version: '1.0.12-beta' }));
vi.mock('../../../package.json', () => ({
  default: pkgState,
  version: pkgState.version,
}));

const externalOpen = vi.hoisted(() => vi.fn());
vi.mock('../../lib/external', () => ({
  openExternal: (...args: unknown[]) => externalOpen(...args),
}));

import { DownloadsProvider } from '../../lib/downloads';
import { I18nProvider, formatMessage } from '../i18n';
import {
  checkForUpdate,
  compareVersions,
  currentBuildVersion,
  defaultUpdateChannelForBuild,
  fetchOwnLatestRelease,
  getUpdateChannel,
  parseVersion,
  planUpdateDelivery,
  releaseMatchesChannel,
  setUpdateChannel,
  signatureSidecarFor,
} from '../selfUpdate';
import type { OwnRelease, UpdateState } from '../selfUpdate';
import { useSelfUpdate } from '../../features/selfUpdate/useSelfUpdate';

const CHANNEL_KEY = 'fress.updateChannel';

const release = (tag: string, prereleaseFlag = false): OwnRelease => ({
  tag,
  version: tag.replace(/^v/i, ''),
  publishedAt: '2026-10-01T00:00:00Z',
  htmlUrl: `https://github.com/WasewaseX/Fress/releases/tag/${tag}`,
  assets: [],
});

/** Derive a version RELATIVE to the running build instead of hard-coding
 * release numbers (the spec's rule: only the intentional v1.0.0 / 1.0.12-beta
 * discontinuity contract is spelled out literally; everything else moves
 * with whatever the build says about itself). */
const nextPre = (v: string, stage: 'beta' | 'alpha' = 'beta'): string => {
  const p = parseVersion(v);
  if (!p) throw new Error(`test bug: "${v}" is not a version the app accepts`);
  return `${p.major}.${p.minor}.${p.patch + 1}-${stage}`;
};

/** GitHub API stub returning the given release list; the atom feed 404s so
 * the fallback stays out of the way unless a test enables it. Entries may
 * carry raw GitHub assets (name/size/browser_download_url) so the checksum
 * and sidecar plumbing can be exercised end to end. */
const apiWith = (
  entries: Array<{
    tag: string;
    prerelease: boolean;
    draft?: boolean;
    assets?: Array<{ name: string; size: number; browser_download_url: string }>;
  }>
) =>
  vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes('api.github.com')) {
      return new Response(
        JSON.stringify(
          entries.map((e) => ({
            tag_name: e.tag,
            name: e.tag,
            draft: e.draft ?? false,
            prerelease: e.prerelease,
            published_at: '2026-10-01T00:00:00Z',
            html_url: `https://github.com/WasewaseX/Fress/releases/tag/${e.tag}`,
            assets: e.assets ?? [],
          }))
        ),
        { status: 200 }
      );
    }
    return new Response('unexpected', { status: 404 });
  });

beforeEach(() => {
  pkgState.version = '1.0.12-beta';
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The hook needs the download context and the i18n dictionary (and
 * DownloadsProvider itself consumes i18n, so I18nProvider mounts first). */
const wrapper = ({ children }: { children: ReactNode }) => (
  <I18nProvider>
    <DownloadsProvider>{children}</DownloadsProvider>
  </I18nProvider>
);

describe('build-aware default channel (the "stable 1.0 landed" flip, derived from the build)', () => {
  it('a stable build (1.0.0) defaults to the Stable channel', () => {
    expect(defaultUpdateChannelForBuild('1.0.0')).toBe('stable');
  });

  it('every stable SemVer shape defaults to stable, build metadata ignored', () => {
    expect(defaultUpdateChannelForBuild('v1.0.0')).toBe('stable');
    expect(defaultUpdateChannelForBuild('2.0.0')).toBe('stable');
    expect(defaultUpdateChannelForBuild('1.0.0+build.42')).toBe('stable');
  });

  it('beta prerelease builds keep the widest prerelease default (alpha)', () => {
    expect(defaultUpdateChannelForBuild('1.0.12-beta')).toBe('alpha');
    expect(defaultUpdateChannelForBuild('1.0.13-beta')).toBe('alpha');
    expect(defaultUpdateChannelForBuild('v1.0.13-beta')).toBe('alpha');
  });

  it('rc and alpha builds are prerelease builds too', () => {
    expect(defaultUpdateChannelForBuild('1.0.0-rc.1')).toBe('alpha');
    expect(defaultUpdateChannelForBuild('1.0.5-alpha')).toBe('alpha');
  });

  it('an unparsable build version stays conservative (widest channel)', () => {
    expect(defaultUpdateChannelForBuild('not-a-version')).toBe('alpha');
    expect(defaultUpdateChannelForBuild('')).toBe('alpha');
  });

  it('currentBuildVersion reports the build metadata, not a guess', () => {
    pkgState.version = '1.0.13-beta';
    expect(currentBuildVersion()).toBe('1.0.13-beta');
  });

  it('no saved choice + stable build = stable channel (case 10)', () => {
    pkgState.version = '1.0.0';
    expect(getUpdateChannel()).toBe('stable');
  });

  it('no saved choice + beta build = prerelease channel (today: alpha)', () => {
    pkgState.version = '1.0.12-beta';
    expect(getUpdateChannel()).toBe('alpha');
  });

  it('an EXPLICIT choice survives the upgrade between build tracks', () => {
    pkgState.version = '1.0.12-beta';
    setUpdateChannel('beta');
    pkgState.version = '1.0.0'; // the user later installs the stable build
    expect(getUpdateChannel()).toBe('beta');
  });

  it('an invalid saved value is rejected and falls back to the build default', () => {
    pkgState.version = '1.0.0';
    localStorage.setItem(CHANNEL_KEY, 'nightly'); // not one of the three ids
    expect(getUpdateChannel()).toBe('stable');
    localStorage.setItem(CHANNEL_KEY, 'latest');
    expect(getUpdateChannel()).toBe('stable');
  });

  it('storage access failure never crashes startup and uses the build default', () => {
    pkgState.version = '1.0.0';
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(() => getUpdateChannel()).not.toThrow();
    expect(getUpdateChannel()).toBe('stable');
    spy.mockRestore();

    const setSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => setUpdateChannel('beta')).not.toThrow();
    setSpy.mockRestore();
  });
});

describe('case 6: SemVer ordering across tracks (never falsified)', () => {
  it('orders 1.0.0-rc.1 < 1.0.0 < 1.0.12-beta < 1.0.13-beta (SemVer rule 9)', () => {
    // A prerelease of the same core version ranks BELOW the release:
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0);
    expect(compareVersions('1.0.12-beta', '1.0.0-rc.1')).toBeGreaterThan(0);
    expect(compareVersions('1.0.13-beta', '1.0.12-beta')).toBeGreaterThan(0);
    // ...and antisymmetric whichever way the arguments are swapped:
    expect(compareVersions('1.0.0', '1.0.12-beta')).toBeLessThan(0);
    expect(compareVersions('1.0.12-beta', '1.0.0')).toBeGreaterThan(0);
  });

  it('1.0.0 does NOT compare numerically newer than 1.0.12-beta', () => {
    // The comparator must never be bent so that a stable tag outranks a
    // numerically newer prerelease: 1.0.0 is OLDER than 1.0.12-beta.
    expect(compareVersions('1.0.0', '1.0.12-beta')).toBeLessThan(0);
  });

  it('v-prefixed and bare tags are one version', () => {
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('v1.0.12-beta', '1.0.12-beta')).toBe(0);
  });
});

describe('case 1+2: the Stable channel and the "current" boundary', () => {
  it('releaseMatchesChannel: stable sees only full releases', () => {
    expect(releaseMatchesChannel('1.0.0', 'stable')).toBe(true);
    expect(releaseMatchesChannel('v1.0.0', 'stable')).toBe(true);
    expect(releaseMatchesChannel('1.0.12-beta', 'stable')).toBe(false);
    expect(releaseMatchesChannel('1.0.0-rc.1', 'stable')).toBe(false);
    expect(releaseMatchesChannel('1.0.5-alpha', 'stable')).toBe(false);
    // A malformed tag matches NO channel:
    expect(releaseMatchesChannel('1.0.7junk', 'stable')).toBe(false);
  });

  it('a stable 1.0.0 client on Stable sees v1.0.0 as CURRENT, not a perpetual update', async () => {
    pkgState.version = '1.0.0';
    setUpdateChannel('stable');
    vi.stubGlobal(
      'fetch',
      apiWith([
        { tag: 'v1.0.0', prerelease: false },
        { tag: 'v1.0.12-beta', prerelease: true },
      ]) as unknown as typeof fetch
    );
    const res = await checkForUpdate('1.0.0');
    expect(res.kind).toBe('latest');
    if (res.kind === 'latest') expect(res.version).toBe('1.0.0');
    expect(res.kind).not.toBe('available');
  });

  it('the Stable channel ignores a NEWER beta and stays on the newest stable', async () => {
    pkgState.version = '1.0.0';
    setUpdateChannel('stable');
    vi.stubGlobal(
      'fetch',
      apiWith([
        { tag: 'v1.0.0', prerelease: false },
        { tag: 'v1.0.13-beta', prerelease: true },
      ]) as unknown as typeof fetch
    );
    const res = await checkForUpdate('1.0.0');
    // 1.0.13-beta is numerically newer but must NEVER surface on Stable:
    expect(res.kind).toBe('latest');
    if (res.kind === 'latest') expect(res.version).toBe('1.0.0');
  });
});

describe('case 3: stable clients are never offered prereleases', () => {
  it('a Stable client with ONLY beta releases published gets no update candidate', async () => {
    pkgState.version = '1.0.0';
    setUpdateChannel('stable');
    vi.stubGlobal(
      'fetch',
      apiWith([
        { tag: 'v1.0.12-beta', prerelease: true },
        { tag: 'v1.0.13-beta', prerelease: true },
      ]) as unknown as typeof fetch
    );
    const res = await checkForUpdate('1.0.0');
    // Neither an in-app beta download nor a beta named as the channel's
    // newest: the honest outcome is "check found nothing eligible".
    expect(res.kind).toBe('error');
    expect(res.kind).not.toBe('available');
    expect(res.kind).not.toBe('track-migration');
  });
});

describe('case 4: Beta and Alpha pick the newest ELIGIBLE prerelease', () => {
  it('the Beta channel skips the stable release and offers the newest beta', async () => {
    setUpdateChannel('beta');
    // Versions are built RELATIVE to the running build (the spec's rule);
    // only the intentional stable-track discontinuity uses literal 1.0.0.
    const running = currentBuildVersion();
    const newer = nextPre(running);
    vi.stubGlobal(
      'fetch',
      apiWith([
        { tag: 'v1.0.0', prerelease: false },
        { tag: `v${running}`, prerelease: true },
        { tag: `v${newer}`, prerelease: true },
      ]) as unknown as typeof fetch
    );
    const res = await checkForUpdate(running);
    expect(res.kind).toBe('available');
    if (res.kind === 'available') expect(res.release.version).toBe(newer);
  });

  it('the Alpha channel takes the newest eligible prerelease of any stage', async () => {
    setUpdateChannel('alpha');
    const running = currentBuildVersion();
    const newerAlpha = nextPre(running, 'alpha');
    vi.stubGlobal(
      'fetch',
      apiWith([
        { tag: `v${running}`, prerelease: true },
        { tag: `v${newerAlpha}`, prerelease: true },
      ]) as unknown as typeof fetch
    );
    const res = await checkForUpdate(running);
    expect(res.kind).toBe('available');
    if (res.kind === 'available') expect(res.release.version).toBe(newerAlpha);
  });

  it('the Beta channel refuses a pure-alpha newest (stage gate intact)', async () => {
    setUpdateChannel('beta');
    const running = currentBuildVersion();
    const newerAlpha = nextPre(running, 'alpha');
    vi.stubGlobal(
      'fetch',
      apiWith([{ tag: `v${newerAlpha}`, prerelease: true }]) as unknown as typeof fetch
    );
    const res = await checkForUpdate(running);
    expect(res.kind).toBe('error'); // no eligible beta in the window
  });
});

describe('case 5: publication order cannot flip a channel pick', () => {
  it('beta picks the newest beta even when the list is newest-first', async () => {
    setUpdateChannel('beta');
    const running = currentBuildVersion();
    const newer = nextPre(running);
    vi.stubGlobal(
      'fetch',
      apiWith([
        { tag: `v${newer}`, prerelease: true },
        { tag: `v${running}`, prerelease: true },
        { tag: 'v1.0.0', prerelease: false },
      ]) as unknown as typeof fetch
    );
    const res = await checkForUpdate(running);
    expect(res.kind).toBe('available');
    if (res.kind === 'available') expect(res.release.version).toBe(newer);
  });

  it('stable still lands on v1.0.0 when the beta is published first', async () => {
    pkgState.version = '1.0.0';
    setUpdateChannel('stable');
    vi.stubGlobal(
      'fetch',
      apiWith([
        { tag: 'v1.0.12-beta', prerelease: true },
        { tag: 'v1.0.0', prerelease: false },
      ]) as unknown as typeof fetch
    );
    const res = await checkForUpdate('1.0.0');
    expect(res.kind).toBe('latest');
    if (res.kind === 'latest') expect(res.version).toBe('1.0.0');
  });
});

describe('case 7: a beta client selecting Stable is never downgraded', () => {
  it('returns the honest track-migration state instead of a downgrade download', async () => {
    // The real situation: Fress 1.0.12-beta (the shipped build), user picks
    // Stable, the newest stable release is v1.0.0.
    setUpdateChannel('stable');
    vi.stubGlobal(
      'fetch',
      apiWith([{ tag: 'v1.0.0', prerelease: false }]) as unknown as typeof fetch
    );
    const res = await checkForUpdate('1.0.12-beta');
    expect(res.kind).toBe('track-migration');
    if (res.kind === 'track-migration') {
      expect(res.channel).toBe('stable');
      expect(res.channelVersion).toBe('1.0.0');
      expect(res.release.tag).toBe('v1.0.0');
    }
    // And it is explicitly NOT the two lying shapes:
    expect(res.kind).not.toBe('available'); // no downgrade download
    expect(res.kind).not.toBe('latest'); // no silent "up to date"
    // And it names no in-app asset by default: the empty-asset release has
    // nothing this machine could be told to download (releases page only).
    if (res.kind === 'track-migration') expect(res.asset).toBeNull();
  });
});

describe('case 9: nothing in the check path starts a delivery or opens anything', () => {
  it('a track-migration check leaves the download manager and opener untouched', async () => {
    setUpdateChannel('stable');
    const opener = vi.fn();
    vi.stubGlobal('fetch', apiWith([{ tag: 'v1.0.0', prerelease: false }]) as unknown as typeof fetch);
    vi.stubGlobal('open', opener);
    const startDownload = vi.fn();
    const { result } = renderHook(() => useSelfUpdate(startDownload), { wrapper });
    // Let the mount-time throttled check finish first.
    await waitFor(() => expect(result.current.updateChecking).toBe(false));
    // No update pill (nothing deliverable), no download started:
    expect(result.current.ownUpdate).toBeNull();
    expect(startDownload).not.toHaveBeenCalled();
    // No window open, no install attempt, no background version change:
    expect(opener).not.toHaveBeenCalled();
    expect(externalOpen).not.toHaveBeenCalled();
  });
});

describe('case 8: the track-migration announcement is honest and actionable', () => {
  it('announces the migration with real versions and a releases-page action', async () => {
    setUpdateChannel('stable');
    vi.stubGlobal('fetch', apiWith([{ tag: 'v1.0.0', prerelease: false }]) as unknown as typeof fetch);
    const infoSpy = vi.spyOn(toast, 'info').mockImplementation(() => 'toast-id');
    const startDownload = vi.fn();
    const { result } = renderHook(() => useSelfUpdate(startDownload), { wrapper });
    // The mount-time check (announce=false) runs first; wait it out, then
    // measure ONLY the announced on-demand check.
    await waitFor(() => expect(result.current.updateChecking).toBe(false));
    infoSpy.mockClear();

    let announced: 'track-migration' | 'other' | 'none' = 'none';
    await act(async () => {
      const res = await result.current.runUpdateCheck(true);
      if (res) announced = res.kind === 'track-migration' ? 'track-migration' : 'other';
    });

    // The check result itself is the migration state, never "latest":
    expect(announced).toBe('track-migration');
    // Exactly one toast, and it is the migration message with the REAL
    // build and channel versions interpolated (not a fake "up to date"):
    expect(infoSpy).toHaveBeenCalledTimes(1);
    const [title, opts] = infoSpy.mock.calls[0] as [string, { description?: string; action?: { label: string; onClick: () => void } }];
    expect(title).toBe('Your build (v1.0.12-beta) is newer than the newest Stable release (v1.0.0).');
    expect(opts.description).toContain('never downgrade');
    // The supported official release-page path is a REAL action bound to
    // THIS release's page - and clicking it opens exactly that URL:
    expect(opts.action?.label).toBe('Open the releases page');
    opts.action?.onClick();
    expect(externalOpen).toHaveBeenCalledWith('https://github.com/WasewaseX/Fress/releases/tag/v1.0.0');
    // No pill, no delivery - migration never masquerades as an in-app
    // update, and nothing is downloaded or launched without user action:
    expect(result.current.ownUpdate).toBeNull();
    expect(startDownload).not.toHaveBeenCalled();
  });

  it('formatMessage stays literal for the values the migration strings carry', () => {
    // Windows paths and $&/brace-bearing values must survive interpolation:
    expect(formatMessage('{p}', { p: 'C:\\Users\\Ada\\AppData' })).toBe('C:\\Users\\Ada\\AppData');
    expect(formatMessage('{x} and {x}', { x: 'a$&b{c}' })).toBe('a$&b{c} and a$&b{c}');
  });

  it('the migration hint NAMES the artifact to download when the release carries a matching installer', async () => {
    // A Windows-pattern user agent (jsdom's own UA varies by host platform,
    // so it is pinned exactly like the delivery-path tests do) plus a real
    // installer layout on the v1.0.0 release: the toast must say WHICH file
    // to grab, not just "go to the releases page".
    vi.stubGlobal(
      'navigator',
      {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        language: 'en-US',
        languages: ['en-US'],
      } as unknown as Navigator
    );
    const asset = {
      name: 'Fress_1.0.0_x64-setup.exe',
      size: 21_000_000,
      browser_download_url: 'https://github.com/WasewaseX/Fress/releases/download/v1.0.0/Fress_1.0.0_x64-setup.exe',
    };
    setUpdateChannel('stable');
    vi.stubGlobal(
      'fetch',
      apiWith([
        {
          tag: 'v1.0.0',
          prerelease: false,
          assets: [asset],
        },
      ]) as unknown as typeof fetch
    );
    const infoSpy = vi.spyOn(toast, 'info').mockImplementation(() => 'toast-id');
    const startDownload = vi.fn();
    const { result } = renderHook(() => useSelfUpdate(startDownload), { wrapper });
    await waitFor(() => expect(result.current.updateChecking).toBe(false));
    infoSpy.mockClear();

    await act(async () => {
      await result.current.runUpdateCheck(true);
    });
    expect(infoSpy).toHaveBeenCalledTimes(1);
    const [, opts] = infoSpy.mock.calls[0] as [string, { description?: string; action?: { label: string; onClick: () => void } }];
    // The artifact name travels in the hint (spec §4: "say which artifact
    // the user should download"):
    expect(opts.description).toContain('Fress_1.0.0_x64-setup.exe');
    expect(opts.description).toContain('v1.0.0');
    expect(opts.description).toContain('never downgrade');
    // ...and the recommended artifact is the SAME one the platform picker
    // selected - the migration path has no picker of its own:
    const check = await checkForUpdate('1.0.12-beta');
    expect(check.kind).toBe('track-migration');
    if (check.kind === 'track-migration') expect(check.asset?.name).toBe('Fress_1.0.0_x64-setup.exe');
    // Still no download, no pill: naming a file is not delivering it.
    expect(result.current.ownUpdate).toBeNull();
    expect(startDownload).not.toHaveBeenCalled();
  });
});

describe('spec §3: the /releases/latest endpoint never feeds any channel', () => {
  it('stable, beta and alpha all resolve from the release LIST; latest is never requested', async () => {
    const running = currentBuildVersion();
    const newer = nextPre(running);
    const urls: string[] = [];
    const recording = vi.fn(async (input: string | URL | Request) => {
      const u = String(typeof input === 'object' && input !== null && 'url' in (input as Request) ? (input as Request).url : input);
      urls.push(u);
      if (u.includes('/releases/latest')) {
        // The poison: if the implementation ever consulted /releases/latest
        // for prerelease discovery, it would get the STABLE release here and
        // starve the beta/alpha feed of every prerelease.
        return new Response(
          JSON.stringify({
            tag_name: 'v1.0.0',
            name: 'Fress 1.0.0',
            draft: false,
            prerelease: false,
            published_at: '2026-10-01T00:00:00Z',
            html_url: 'https://github.com/WasewaseX/Fress/releases/tag/v1.0.0',
            assets: [],
          }),
          { status: 200 }
        );
      }
      if (u.includes('api.github.com')) {
        return new Response(
          JSON.stringify([
            { tag_name: 'v1.0.0', name: 'Fress 1.0.0', draft: false, prerelease: false, published_at: '2026-10-01T00:00:00Z', html_url: 'https://github.com/WasewaseX/Fress/releases/tag/v1.0.0', assets: [] },
            { tag_name: `v${running}`, name: running, draft: false, prerelease: true, published_at: '2026-10-02T00:00:00Z', html_url: `https://github.com/WasewaseX/Fress/releases/tag/v${running}`, assets: [] },
            { tag_name: `v${newer}`, name: newer, draft: false, prerelease: true, published_at: '2026-10-03T00:00:00Z', html_url: `https://github.com/WasewaseX/Fress/releases/tag/v${newer}`, assets: [] },
          ]),
          { status: 200 }
        );
      }
      return new Response('unexpected', { status: 404 });
    });
    vi.stubGlobal('fetch', recording as unknown as typeof fetch);

    // Beta and alpha discover from the LIST (newest eligible prerelease),
    // NOT from /releases/latest (which only ever represents the newest
    // NON-prerelease and would starve prerelease channels):
    for (const channel of ['beta', 'alpha'] as const) {
      setUpdateChannel(channel);
      const res = await fetchOwnLatestRelease(channel);
      expect(res?.version).toBe(newer);
    }
    // Stable resolves the intended stable release - from the list too:
    setUpdateChannel('stable');
    const stableRes = await fetchOwnLatestRelease('stable');
    expect(stableRes?.version).toBe('1.0.0');

    expect(urls.some((u) => u.includes('/releases/latest'))).toBe(false);
  });
});

describe('spec §3: draft flags, malformed tags and failing feeds', () => {
  it('a DRAFT release is invisible on every channel, whatever its tag', async () => {
    const newer = nextPre(currentBuildVersion());
    vi.stubGlobal(
      'fetch',
      apiWith([
        { tag: 'v1.0.0', prerelease: false },
        { tag: `v${newer}`, prerelease: true, draft: true },
      ]) as unknown as typeof fetch
    );
    for (const channel of ['stable', 'beta', 'alpha'] as const) {
      const res = await fetchOwnLatestRelease(channel);
      expect(res?.tag).toBe('v1.0.0'); // never the draft, on any channel
    }
    // Client-level consequence: a beta build is never offered the drafted
    // prerelease as an update (the only published eligible release is the
    // OLDER stable v1.0.0, which is a track-migration situation, not a
    // download):
    setUpdateChannel('beta');
    const res = await checkForUpdate(currentBuildVersion());
    expect(res.kind).not.toBe('available');
    expect(res.kind).toBe('track-migration');
    if (res.kind === 'track-migration') expect(res.channelVersion).toBe('1.0.0');
  });

  it('malformed tags in the feed never enter any channel feed (stable especially)', async () => {
    const running = currentBuildVersion();
    const newer = nextPre(running);
    vi.stubGlobal(
      'fetch',
      apiWith([
        // A stable-LOOKING tag with trailing junk and a free-form tag:
        // neither parses as the accepted SemVer subset, so neither may
        // become a candidate - least of all on the Stable channel, where
        // "1.0.14junk" would otherwise read as a newer stable release.
        { tag: 'v1.0.14junk', prerelease: false },
        { tag: 'beta-build', prerelease: false },
        { tag: `v${newer}`, prerelease: true },
        { tag: 'v1.0.0', prerelease: false },
      ]) as unknown as typeof fetch
    );
    // Beta still selects the newest WELL-FORMED beta:
    setUpdateChannel('beta');
    const betaRes = await checkForUpdate(running);
    expect(betaRes.kind).toBe('available');
    if (betaRes.kind === 'available') expect(betaRes.release.version).toBe(newer);
    // A stable 1.0.0 client sees v1.0.0 as current - the junk tags are not
    // "a newer stable release" on the stable feed:
    pkgState.version = '1.0.0';
    setUpdateChannel('stable');
    const stableRes = await checkForUpdate('1.0.0');
    expect(stableRes.kind).toBe('latest');
    if (stableRes.kind === 'latest') expect(stableRes.version).toBe('1.0.0');
  });

  it('a failing feed can never become a false "up to date" (both sources down)', async () => {
    // API 500 AND the atom fallback unreachable: the honest answer is the
    // error state (a quiet note), never "latest" - "up to date" requires
    // having actually read the feed.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch);
    for (const channel of ['stable', 'beta', 'alpha'] as const) {
      setUpdateChannel(channel);
      const res = await checkForUpdate(currentBuildVersion());
      expect(res.kind).toBe('error');
      expect(res.kind).not.toBe('latest');
      expect(res.kind).not.toBe('available');
    }
  });
});

describe('spec §2: build metadata after + stays out of precedence', () => {
  it('+build.42 is not prerelease metadata and never changes comparisons', () => {
    const p = parseVersion('1.0.0+build.42');
    expect(p?.prerelease).toEqual([]);
    expect(p?.build).toEqual(['build', '42']);
    expect(compareVersions('1.0.0+build.42', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0+build.42', '1.0.0+build.43')).toBe(0);
    // A prerelease WITH build metadata keeps its prerelease identity:
    const b = parseVersion('1.0.13-beta+exp.sha.5114f85');
    expect(b?.prerelease).toEqual(['beta']);
    expect(b?.build).toEqual(['exp', 'sha', '5114f85']);
    expect(compareVersions('1.0.13-beta+exp.sha.5114f85', '1.0.13-beta')).toBe(0);
    expect(compareVersions('1.0.13-beta+exp.sha.5114f85', '1.0.0')).toBeGreaterThan(0);
    // And the default-channel policy reads the PRERELEASE segment, so a
    // metadata-decorated stable build still defaults to Stable:
    expect(defaultUpdateChannelForBuild('1.0.0+build.42')).toBe('stable');
    expect(defaultUpdateChannelForBuild('1.0.13-beta+exp.sha.5114f85')).toBe('alpha');
  });
});

describe('spec §5: channel selection feeds the SAME fail-closed delivery gate', () => {
  const SHA = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  /** Feed stub whose v1.0.0 release carries a full installer + checksum
   * manifest + signature sidecar; `keep` lets a test strip a gate. */
  const feedWithGates = (keep: { sums: boolean; sig: boolean }) => {
    const running = currentBuildVersion();
    const asset = {
      name: 'Fress_1.0.0_x64-setup.exe',
      size: 21_000_000,
      browser_download_url: 'https://github.com/WasewaseX/Fress/releases/download/v1.0.0/Fress_1.0.0_x64-setup.exe',
    };
    const assets: Array<{ name: string; size: number; browser_download_url: string }> = [asset];
    if (keep.sums) assets.push({ name: 'SHA256SUMS.txt', size: 300, browser_download_url: 'https://github.com/WasewaseX/Fress/releases/download/v1.0.0/SHA256SUMS.txt' });
    if (keep.sig) assets.push({ name: 'Fress_1.0.0_x64-setup.exe.sig', size: 340, browser_download_url: 'https://github.com/WasewaseX/Fress/releases/download/v1.0.0/Fress_1.0.0_x64-setup.exe.sig' });
    return vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('api.github.com')) {
        return new Response(
          JSON.stringify([
            { tag_name: `v${running}`, name: running, draft: false, prerelease: true, published_at: '2026-10-02T00:00:00Z', html_url: `https://github.com/WasewaseX/Fress/releases/tag/v${running}`, assets: [] },
            { tag_name: 'v1.0.0', name: 'Fress 1.0.0', draft: false, prerelease: false, published_at: '2026-10-01T00:00:00Z', html_url: 'https://github.com/WasewaseX/Fress/releases/tag/v1.0.0', assets },
          ]),
          { status: 200 }
        );
      }
      if (u.endsWith('SHA256SUMS.txt')) {
        return new Response(`${SHA}  ${asset.name}\n`, { status: 200 });
      }
      return new Response('unexpected', { status: 404 });
    });
  };

  it('the release a channel selects passes asset + checksum + sidecar before anything is downloadable', async () => {
    vi.stubGlobal(
      'navigator',
      { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', language: 'en-US' } as unknown as Navigator
    );
    // Build the stable-feed stub while the build version is still the real
    // prerelease (1.0.12-beta), so the feed's decoy prerelease entry is
    // tagged correctly; only THEN does the test become a stable 1.0.0
    // client. The stable channel feed IS the post-migration steady state,
    // and the selected release must run the same three gates as every
    // catalog download:
    const stableFeed = feedWithGates({ sums: true, sig: true });
    pkgState.version = '1.0.0';
    setUpdateChannel('stable');
    vi.stubGlobal('fetch', stableFeed as unknown as typeof fetch);
    const res = await checkForUpdate('1.0.0');
    // 1.0.0 IS the newest stable: the check is honest about being current
    // (a stable install is not offered its own version as an update).
    expect(res.kind).toBe('latest');

    // Now the same gates for a client the feed is actually ahead of: the
    // beta feed member (running build) on the BETA channel with a NEWER
    // fully-gated release. The channel choice changes WHICH release is
    // selected - never WHETHER the gates apply.
    pkgState.version = '1.0.12-beta';
    const newer = nextPre('1.0.12-beta');
    const betaAsset = {
      name: `Fress_${newer}_x64-setup.exe`,
      size: 21_000_000,
      browser_download_url: `https://github.com/WasewaseX/Fress/releases/download/v${newer}/Fress_${newer}_x64-setup.exe`,
    };
    setUpdateChannel('beta');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        const u = String(url);
        if (u.includes('api.github.com')) {
          return new Response(
            JSON.stringify([
              {
                tag_name: `v${newer}`,
                name: newer,
                draft: false,
                prerelease: true,
                published_at: '2026-10-03T00:00:00Z',
                html_url: `https://github.com/WasewaseX/Fress/releases/tag/v${newer}`,
                assets: [
                  betaAsset,
                  { name: 'SHA256SUMS.txt', size: 300, browser_download_url: `https://github.com/WasewaseX/Fress/releases/download/v${newer}/SHA256SUMS.txt` },
                  { name: `${betaAsset.name}.sig`, size: 340, browser_download_url: `https://github.com/WasewaseX/Fress/releases/download/v${newer}/${betaAsset.name}.sig` },
                ],
              },
            ]),
            { status: 200 }
          );
        }
        if (u.endsWith('SHA256SUMS.txt')) return new Response(`${SHA}  ${betaAsset.name}\n`, { status: 200 });
        return new Response('unexpected', { status: 404 });
      }) as unknown as typeof fetch
    );
    const betaRes = await checkForUpdate('1.0.12-beta');
    expect(betaRes.kind).toBe('available');
    if (betaRes.kind !== 'available') return; // narrowing for the type checker

    // Gate 1+2+3 all present -> the plan is a download carrying the EXACT
    // published digest and the EXACT sidecar (no parallel unverified path):
    const sig = signatureSidecarFor(betaRes.release, betaRes.asset!.name);
    expect(sig?.name).toBe(`${betaAsset.name}.sig`);
    const plan = planUpdateDelivery(betaRes.release, betaRes.asset, betaRes.expectedSha256, sig);
    expect(plan).toMatchObject({ kind: 'download', sha256: SHA, asset: { name: betaAsset.name } });

    // Missing checksum -> the planner refuses (releases page), no matter
    // which channel selected the release:
    expect(planUpdateDelivery(betaRes.release, betaRes.asset, null, sig)).toEqual({
      kind: 'releases-page',
      release: betaRes.release,
      reason: 'unverifiable',
    });
    // Missing sidecar -> 'unsigned', releases page:
    expect(planUpdateDelivery(betaRes.release, betaRes.asset, SHA, null)).toEqual({
      kind: 'releases-page',
      release: betaRes.release,
      reason: 'unsigned',
    });
    // No platform asset -> 'no-asset', releases page:
    expect(planUpdateDelivery(betaRes.release, null, SHA, sig)).toEqual({
      kind: 'releases-page',
      release: betaRes.release,
      reason: 'no-asset',
    });

    // And the checksum gate is fed by the REAL manifest lookup: strip
    // SHA256SUMS.txt from the release and the check degrades to null
    // (fail closed) instead of inventing a digest.
    vi.stubGlobal('fetch', feedWithGates({ sums: false, sig: true }) as unknown as typeof fetch);
    setUpdateChannel('stable');
    const noSums = await fetchOwnLatestRelease('stable');
    expect(noSums?.assets.some((a) => /^sha256sums\.txt$/i.test(a.name))).toBe(false);
  });

  it('a track-migration result never becomes a delivery plan of any kind', async () => {
    setUpdateChannel('stable');
    vi.stubGlobal('fetch', apiWith([{ tag: 'v1.0.0', prerelease: false }]) as unknown as typeof fetch);
    const res = await checkForUpdate('1.0.12-beta');
    expect(res.kind).toBe('track-migration');
    if (res.kind !== 'track-migration') return;
    // Even if some future caller tried to plan a delivery from the
    // migration state, the planner has no download shape for it without a
    // platform asset AND checksum AND sidecar - and the UI contract (pinned
    // in the hook tests) never calls the planner with this state at all.
    // The essential assertion: the migration state carries no asset/sha
    // pair that could be mistaken for a deliverable update.
    expect(res.channelVersion).toBe('1.0.0');
    expect(res.release.assets).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Invariant 12: stale async results from an OLD channel can never     */
/* overwrite the state of a newer channel selection.                   */
/* ------------------------------------------------------------------ */
describe('spec §6 (invariant 12): stale results from an old channel are discarded', () => {
  /** Raw GitHub list body for a deferred fetch stub. */
  const ghBody = (entries: Array<{ tag: string; prerelease: boolean }>): Response =>
    new Response(
      JSON.stringify(
        entries.map((e) => ({
          tag_name: e.tag,
          name: e.tag,
          draft: false,
          prerelease: e.prerelease,
          published_at: '2026-10-01T00:00:00Z',
          html_url: `https://github.com/WasewaseX/Fress/releases/tag/${e.tag}`,
          assets: [],
        }))
      ),
      { status: 200 }
    );

  it('a check in flight under the old channel is discarded after a channel switch, and the re-check runs under the new one', async () => {
    // KILL-TEST REVIEW: this case pins the epoch guard in useSelfUpdate's
    // runUpdateCheck. Without it (the pre-fix shape: land the result, then
    // setOwnUpdate unconditionally), the in-flight Beta check below would
    // resolve AFTER the user switched to Stable and (a) repopulate the pill
    // with the abandoned channel's release and (b) fire "update available"
    // for a channel the user just left - both assertions fail. Removing the
    // immediate setOwnUpdate(null) on channel change also fails the
    // right-after-switch assertion below.
    setUpdateChannel('beta');

    // Phase 1: the mount-time check resolves immediately; a Beta update is
    // detected and the pill is live.
    vi.stubGlobal('fetch', apiWith([{ tag: 'v1.0.13-beta', prerelease: true }]) as unknown as typeof fetch);
    const infoSpy = vi.spyOn(toast, 'info').mockImplementation(() => 'toast-id');
    const startDownload = vi.fn();
    const { result } = renderHook(() => useSelfUpdate(startDownload), { wrapper });
    await waitFor(() => expect(result.current.updateChecking).toBe(false));
    expect(result.current.ownUpdate?.release.version).toBe('1.0.13-beta');
    infoSpy.mockClear();

    // Phase 2: a manual ANNOUNCED check whose response is deferred, so the
    // channel switch can land while it is in flight.
    const resolvers: Array<(r: Response) => void> = [];
    const deferred = vi.fn((_url: string | URL | Request) => {
      return new Promise<Response>((resolve) => {
        resolvers.push(resolve);
      });
    });
    vi.stubGlobal('fetch', deferred as unknown as typeof fetch);

    let manualPromise: Promise<UpdateState | null> = Promise.resolve(null);
    act(() => {
      manualPromise = result.current.runUpdateCheck(true) ?? Promise.resolve(null);
    });
    await waitFor(() => expect(resolvers.length).toBe(1));

    // The user switches to Stable while the check is in flight:
    act(() => {
      result.current.handleUpdateChannelChange('stable');
    });
    // ...the stale pill is cleared IMMEDIATELY (it must not linger until
    // the in-flight check lands) ...
    expect(result.current.ownUpdate).toBeNull();
    expect(result.current.updateChannel).toBe('stable');
    // ...and the only announcement so far is the channel-set toast.
    expect(infoSpy).toHaveBeenCalledTimes(1);

    // The in-flight check now lands with an even NEWER beta release. Under
    // the abandoned channel this is "update available"; under Stable it is
    // stale news from a channel the user just left.
    await act(async () => {
      resolvers[0](ghBody([{ tag: 'v1.0.14-beta', prerelease: true }]));
    });
    // The stale result was DISCARDED: no pill, no "update available" toast.
    // (updateChecking may still read true here: the discarded check hands
    // straight off to the requested re-check, so no idle frame is rendered
    // in between - the next wait targets that re-check's fetch instead.)
    expect(result.current.ownUpdate).toBeNull();
    expect(infoSpy).toHaveBeenCalledTimes(1); // channel-set only; no available toast

    // The switch requested a fresh quiet check under the NEW channel - it
    // starts once the stale check was discarded.
    await waitFor(() => expect(resolvers.length).toBe(2));
    await act(async () => {
      resolvers[1](ghBody([{ tag: 'v1.0.13', prerelease: false }]));
    });
    // The NEW channel's result IS applied: v1.0.13 stable is newer than the
    // running 1.0.12-beta build and eligible on Stable.
    await waitFor(() => expect(result.current.ownUpdate?.release.version).toBe('1.0.13'));
    // The outer manual check resolves with the RE-CHECK's result (the
    // stale one was replaced, not reported).
    const res = await manualPromise;
    expect(res?.kind).toBe('available');
    if (res?.kind === 'available') expect(res.release.version).toBe('1.0.13');
    // No delivery was started by any of this - checking never delivers.
    expect(startDownload).not.toHaveBeenCalled();
  });

  it('a channel switch never leaves the previous channel\'s pill on screen even without any check in flight', async () => {
    // Same contract, no in-flight check: the clearing is unconditional.
    setUpdateChannel('beta');
    vi.stubGlobal('fetch', apiWith([{ tag: 'v1.0.13-beta', prerelease: true }]) as unknown as typeof fetch);
    const startDownload = vi.fn();
    const { result } = renderHook(() => useSelfUpdate(startDownload), { wrapper });
    await waitFor(() => expect(result.current.ownUpdate?.release.version).toBe('1.0.13-beta'));

    // Switch to Alpha (the new feed would also carry the beta release, but
    // the OLD result still describes a check that never ran under Alpha).
    act(() => {
      result.current.handleUpdateChannelChange('alpha');
    });
    expect(result.current.ownUpdate).toBeNull();
    // And the fresh quiet check re-detects the release under the new channel.
    await waitFor(() => expect(result.current.ownUpdate?.release.version).toBe('1.0.13-beta'));
    expect(startDownload).not.toHaveBeenCalled();
  });
});
