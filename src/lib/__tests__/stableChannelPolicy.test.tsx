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
  getUpdateChannel,
  releaseMatchesChannel,
  setUpdateChannel,
} from '../selfUpdate';
import type { OwnRelease } from '../selfUpdate';
import { useSelfUpdate } from '../../features/selfUpdate/useSelfUpdate';

const CHANNEL_KEY = 'fress.updateChannel';

const release = (tag: string, prereleaseFlag = false): OwnRelease => ({
  tag,
  version: tag.replace(/^v/i, ''),
  publishedAt: '2026-10-01T00:00:00Z',
  htmlUrl: `https://github.com/WasewaseX/Fress/releases/tag/${tag}`,
  assets: [],
});

/** GitHub API stub returning the given release list; the atom feed 404s so
 * the fallback stays out of the way unless a test enables it. */
const apiWith = (
  entries: Array<{ tag: string; prerelease: boolean; draft?: boolean }>
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
            assets: [],
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
    vi.stubGlobal(
      'fetch',
      apiWith([
        { tag: 'v1.0.0', prerelease: false },
        { tag: 'v1.0.11-beta', prerelease: true },
        { tag: 'v1.0.12-beta', prerelease: true },
      ]) as unknown as typeof fetch
    );
    const res = await checkForUpdate('1.0.11-beta');
    expect(res.kind).toBe('available');
    if (res.kind === 'available') expect(res.release.version).toBe('1.0.12-beta');
  });

  it('the Alpha channel takes the newest eligible prerelease of any stage', async () => {
    setUpdateChannel('alpha');
    vi.stubGlobal(
      'fetch',
      apiWith([
        { tag: 'v1.0.12-beta', prerelease: true },
        { tag: 'v1.0.13-alpha', prerelease: true },
      ]) as unknown as typeof fetch
    );
    const res = await checkForUpdate('1.0.12-beta');
    expect(res.kind).toBe('available');
    if (res.kind === 'available') expect(res.release.version).toBe('1.0.13-alpha');
  });

  it('the Beta channel refuses a pure-alpha newest (stage gate intact)', async () => {
    setUpdateChannel('beta');
    vi.stubGlobal(
      'fetch',
      apiWith([{ tag: 'v1.0.13-alpha', prerelease: true }]) as unknown as typeof fetch
    );
    const res = await checkForUpdate('1.0.12-beta');
    expect(res.kind).toBe('error'); // no eligible beta in the window
  });
});

describe('case 5: publication order cannot flip a channel pick', () => {
  it('beta picks the newest beta even when the list is newest-first', async () => {
    setUpdateChannel('beta');
    vi.stubGlobal(
      'fetch',
      apiWith([
        { tag: 'v1.0.12-beta', prerelease: true },
        { tag: 'v1.0.11-beta', prerelease: true },
        { tag: 'v1.0.0', prerelease: false },
      ]) as unknown as typeof fetch
    );
    const res = await checkForUpdate('1.0.11-beta');
    expect(res.kind).toBe('available');
    if (res.kind === 'available') expect(res.release.version).toBe('1.0.12-beta');
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
});
