// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { describe, expect, it, vi, afterEach } from 'vitest';

import {
  compareVersions,
  parseVersion,
  releaseMatchesChannel,
  pickOwnAsset,
  fetchOwnLatestRelease,
} from '../selfUpdate';
import type { OwnRelease } from '../selfUpdate';

describe('parseVersion', () => {
  it('parses plain versions', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
  });

  it('parses a leading v', () => {
    expect(parseVersion('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
  });

  it('parses prerelease identifiers', () => {
    expect(parseVersion('1.0.2-alpha')).toEqual({ major: 1, minor: 0, patch: 2, prerelease: ['alpha'] });
    expect(parseVersion('v1.0.2-alpha.1')).toEqual({ major: 1, minor: 0, patch: 2, prerelease: ['alpha', '1'] });
  });

  it('returns null for garbage', () => {
    expect(parseVersion('not-a-version')).toBeNull();
    expect(parseVersion('')).toBeNull();
    expect(parseVersion('1.2')).toBeNull();
  });
});

describe('compareVersions — the old code treated these all as [1,0,1]', () => {
  it('ranks stable above every prerelease of the same version', () => {
    expect(compareVersions('1.0.1', '1.0.1-alpha')).toBe(1);
    expect(compareVersions('1.0.1', '1.0.1-beta')).toBe(1);
    expect(compareVersions('1.0.1', '1.0.1-rc.1')).toBe(1);
  });

  it('orders alpha < beta < rc < stable', () => {
    expect(compareVersions('1.0.1-alpha', '1.0.1-beta')).toBe(-1);
    expect(compareVersions('1.0.1-beta', '1.0.1-rc.1')).toBe(-1);
    expect(compareVersions('1.0.1-rc.1', '1.0.1')).toBe(-1);
  });

  it('orders numbered prereleases numerically, not lexically', () => {
    expect(compareVersions('1.0.2-alpha.2', '1.0.2-alpha.10')).toBe(-1);
    expect(compareVersions('1.0.2-alpha.2', '1.0.2-alpha.2')).toBe(0);
  });

  it('still compares the numeric core first', () => {
    expect(compareVersions('1.0.2-alpha', '1.0.1')).toBe(1);
    expect(compareVersions('1.1.0-alpha', '1.0.9')).toBe(1);
    expect(compareVersions('2.0.0-alpha', '1.9.9')).toBe(1);
  });

  it('treats identical versions as equal', () => {
    expect(compareVersions('1.0.1-alpha', 'v1.0.1-alpha')).toBe(0);
    expect(compareVersions('1.2.3', 'v1.2.3')).toBe(0);
  });

  it('is exactly the updater decision the old comparison got wrong', () => {
    // Installed 1.0.1-alpha; stable 1.0.1 must be offered as an update.
    const installed = '1.0.1-alpha';
    const stable = '1.0.1';
    expect(compareVersions(stable, installed)).toBe(1);
  });
});

describe('releaseMatchesChannel', () => {
  it('stable channel hides every prerelease', () => {
    expect(releaseMatchesChannel('1.0.0', 'stable')).toBe(true);
    expect(releaseMatchesChannel('1.0.0-beta', 'stable')).toBe(false);
    expect(releaseMatchesChannel('1.0.0-alpha', 'stable')).toBe(false);
  });

  it('beta channel shows stable, beta and rc but not alpha', () => {
    expect(releaseMatchesChannel('1.0.0', 'beta')).toBe(true);
    expect(releaseMatchesChannel('1.0.0-beta', 'beta')).toBe(true);
    expect(releaseMatchesChannel('1.0.0-rc.2', 'beta')).toBe(true);
    expect(releaseMatchesChannel('1.0.0-alpha', 'beta')).toBe(false);
  });

  it('alpha channel sees everything', () => {
    expect(releaseMatchesChannel('1.0.0', 'alpha')).toBe(true);
    expect(releaseMatchesChannel('1.0.0-alpha', 'alpha')).toBe(true);
    expect(releaseMatchesChannel('1.0.0-dev.3', 'alpha')).toBe(true);
  });

  it('never hides unparsable versions (stay visible rather than silently dropped)', () => {
    expect(releaseMatchesChannel('weird', 'stable')).toBe(true);
  });
});

describe('pickOwnAsset — macOS assets', () => {
  const release = (names: string[]): OwnRelease => ({
    tag: 'v1.0.4-alpha',
    version: '1.0.4-alpha',
    publishedAt: '2026-09-22T00:00:00Z',
    htmlUrl: 'https://github.com/WasewaseX/Fress/releases/tag/v1.0.4-alpha',
    assets: names.map((name) => ({ name, size: 1000, url: `https://example.com/${name}` })),
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a pkg-only release still offers a direct download (was: nothing)', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15' });
    const asset = pickOwnAsset(release(['Fress_1.0.4-alpha_aarch64.pkg']));
    expect(asset?.name).toBe('Fress_1.0.4-alpha_aarch64.pkg');
  });

  it('dmg is still preferred over pkg when both exist', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15' });
    const asset = pickOwnAsset(
      release(['Fress_1.0.4-alpha_x64.pkg', 'Fress_1.0.4-alpha_x64.dmg'])
    );
    expect(asset?.name).toBe('Fress_1.0.4-alpha_x64.dmg');
  });

  it('uses the host arch hint: Apple Silicon gets the arm dmg (UA lies about Intel)', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15' });
    const asset = pickOwnAsset(
      release(['Fress_1.0.4-alpha_x64.dmg', 'Fress_1.0.4-alpha_aarch64.dmg']),
      'aarch64'
    );
    expect(asset?.name).toBe('Fress_1.0.4-alpha_aarch64.dmg');
  });

  it('an Intel Mac gets the x64 dmg with the hint', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15' });
    const asset = pickOwnAsset(
      release(['Fress_1.0.4-alpha_x64.dmg', 'Fress_1.0.4-alpha_aarch64.dmg']),
      'x86_64'
    );
    expect(asset?.name).toBe('Fress_1.0.4-alpha_x64.dmg');
  });

  it('an untyped-only dmg is still picked when it is the only candidate', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15' });
    const asset = pickOwnAsset(release(['Fress-1.0.4.dmg']), 'aarch64');
    expect(asset?.name).toBe('Fress-1.0.4.dmg');
  });
});

describe('pickOwnAsset — Android assets', () => {
  const release = (names: string[]): OwnRelease => ({
    tag: 'v1.0.4-alpha',
    version: '1.0.4-alpha',
    publishedAt: '2026-09-22T00:00:00Z',
    htmlUrl: 'https://github.com/WasewaseX/Fress/releases/tag/v1.0.4-alpha',
    assets: names.map((name) => ({ name, size: 1000, url: `https://example.com/${name}` })),
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const androidUA = () =>
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36' });

  it('an x86_64 Android device gets the x64 apk or universal, never arm64', () => {
    androidUA();
    expect(pickOwnAsset(release(['Fress_1.0.4-alpha_arm64.apk', 'Fress_1.0.4-alpha_universal.apk']), 'x86_64')?.name).toBe(
      'Fress_1.0.4-alpha_universal.apk'
    );
    expect(pickOwnAsset(release(['Fress_1.0.4-alpha_arm64.apk', 'Fress_1.0.4-alpha_x64.apk']), 'x86_64')?.name).toBe(
      'Fress_1.0.4-alpha_x64.apk'
    );
  });

  it('an arm64 Android device prefers the arm64 apk over universal', () => {
    androidUA();
    expect(pickOwnAsset(release(['Fress_1.0.4-alpha_universal.apk', 'Fress_1.0.4-alpha_arm64.apk']), 'aarch64')?.name).toBe(
      'Fress_1.0.4-alpha_arm64.apk'
    );
  });
});

describe('pickOwnAsset — Windows assets (setup is a bonus, never an early return)', () => {
  const release = (names: string[]): OwnRelease => ({
    tag: 'v1.0.5-alpha',
    version: '1.0.5-alpha',
    publishedAt: '2026-09-23T00:00:00Z',
    htmlUrl: 'https://github.com/WasewaseX/Fress/releases/tag/v1.0.5-alpha',
    assets: names.map((name) => ({ name, size: 1000, url: `https://example.com/${name}` })),
  });

  const windowsUA = () =>
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('an x64 machine picks the x64 installer even when the arm64 installer is listed first', () => {
    windowsUA();
    // Both setup files DO reach the arch check (the old suspicion that
    // `return 5` short-circuits them is wrong: "x64-setup" contains
    // "setup"). This locks that in forever.
    expect(
      pickOwnAsset(
        release(['Fress_1.0.5-alpha_arm64-setup.exe', 'Fress_1.0.5-alpha_x64-setup.exe']),
        'x86_64'
      )?.name
    ).toBe('Fress_1.0.5-alpha_x64-setup.exe');
  });

  it('a Windows-on-ARM machine picks the arm64 installer regardless of list order', () => {
    windowsUA();
    expect(
      pickOwnAsset(
        release(['Fress_1.0.5-alpha_x64-setup.exe', 'Fress_1.0.5-alpha_arm64-setup.exe']),
        'aarch64'
      )?.name
    ).toBe('Fress_1.0.5-alpha_arm64-setup.exe');
  });

  it('portable exes are architecture-matched too (they used to bypass the arch check entirely)', () => {
    windowsUA();
    // The old `if (!s.includes('setup')) return 5;` scored every portable an
    // arch-blind 5: two portables tied and list order decided. That was the
    // real bug behind the setup-early-return report.
    expect(
      pickOwnAsset(
        release(['Fress_1.0.5-alpha_arm64.exe', 'Fress_1.0.5-alpha_x64.exe']),
        'x86_64'
      )?.name
    ).toBe('Fress_1.0.5-alpha_x64.exe');
    expect(
      pickOwnAsset(
        release(['Fress_1.0.5-alpha_x64.exe', 'Fress_1.0.5-alpha_arm64.exe']),
        'aarch64'
      )?.name
    ).toBe('Fress_1.0.5-alpha_arm64.exe');
  });

  it('a setup installer outranks a portable of the same architecture', () => {
    windowsUA();
    expect(
      pickOwnAsset(
        release(['Fress_1.0.5-alpha_x64.exe', 'Fress_1.0.5-alpha_x64-setup.exe']),
        'x86_64'
      )?.name
    ).toBe('Fress_1.0.5-alpha_x64-setup.exe');
  });

  it('an x64 machine prefers an x64 portable over a wrong-arch installer', () => {
    windowsUA();
    // portable 0+10 beats arm64-setup 5+3: right-arch portable > wrong-arch
    // installer, even though the installer is the friendlier format.
    expect(
      pickOwnAsset(
        release(['Fress_1.0.5-alpha_arm64-setup.exe', 'Fress_1.0.5-alpha_x64.exe']),
        'x86_64'
      )?.name
    ).toBe('Fress_1.0.5-alpha_x64.exe');
  });
});

describe('pickOwnAsset — Linux assets (architecture-aware, refuses mismatches)', () => {
  const release = (names: string[]): OwnRelease => ({
    tag: 'v1.0.5-alpha',
    version: '1.0.5-alpha',
    publishedAt: '2026-09-23T00:00:00Z',
    htmlUrl: 'https://github.com/WasewaseX/Fress/releases/tag/v1.0.5-alpha',
    assets: names.map((name) => ({ name, size: 1000, url: `https://example.com/${name}` })),
  });

  const linuxUA = () =>
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('an x86_64 Linux machine gets the amd64 AppImage', () => {
    linuxUA();
    expect(
      pickOwnAsset(
        release([
          'Fress_1.0.5-alpha_amd64.deb',
          'Fress_1.0.5-alpha_amd64.AppImage',
          'Fress_1.0.5-alpha_x86_64.rpm',
        ]),
        'x86_64'
      )?.name
    ).toBe('Fress_1.0.5-alpha_amd64.AppImage');
  });

  it('an ARM64 Linux machine is offered NOTHING when only x86_64 builds exist', () => {
    // The arch-blind scoring handed the amd64 AppImage to ARM hosts: a
    // download that can never start (Linux has no emulation safety net).
    // Refusing beats silently downloading the wrong binary.
    linuxUA();
    expect(
      pickOwnAsset(
        release([
          'Fress_1.0.5-alpha_amd64.AppImage',
          'Fress_1.0.5-alpha_amd64.deb',
          'Fress_1.0.5-alpha_x86_64.rpm',
        ]),
        'aarch64'
      )
    ).toBeNull();
  });

  it('an ARM64 Linux machine gets an aarch64 build when one exists', () => {
    linuxUA();
    expect(
      pickOwnAsset(
        release(['Fress_1.0.5-alpha_amd64.AppImage', 'Fress_1.0.5-alpha_aarch64.AppImage']),
        'aarch64'
      )?.name
    ).toBe('Fress_1.0.5-alpha_aarch64.AppImage');
  });

  it('an x86_64 machine is never offered an arm build', () => {
    linuxUA();
    expect(pickOwnAsset(release(['Fress_1.0.5-alpha_aarch64.AppImage']), 'x86_64')).toBeNull();
  });

  it('a 32-bit x86 machine gets nothing it cannot run (64-bit-only releases)', () => {
    linuxUA();
    expect(pickOwnAsset(release(['Fress_1.0.5-alpha_amd64.AppImage']), 'i686')).toBeNull();
  });

  it('a tagged amd64 asset beats an untagged one on x86_64', () => {
    linuxUA();
    expect(
      pickOwnAsset(
        release(['Fress_1.0.5-alpha.AppImage', 'Fress_1.0.5-alpha_amd64.AppImage']),
        'x86_64'
      )?.name
    ).toBe('Fress_1.0.5-alpha_amd64.AppImage');
  });
});

describe('pickOwnAsset — Android assets (full ABI awareness, classification shared with the catalog)', () => {
  const release = (names: string[]): OwnRelease => ({
    tag: 'v1.0.5-alpha',
    version: '1.0.5-alpha',
    publishedAt: '2026-09-23T00:00:00Z',
    htmlUrl: 'https://github.com/WasewaseX/Fress/releases/tag/v1.0.5-alpha',
    assets: names.map((name) => ({ name, size: 1000, url: `https://example.com/${name}` })),
  });

  const androidUA = () =>
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36' });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('an ARMv7 Android device is never handed an x86_64 apk (archHint "arm" used to read as non-ARM)', () => {
    androidUA();
    expect(
      pickOwnAsset(
        release(['Fress_1.0.5-alpha_x64.apk', 'Fress_1.0.5-alpha_arm.apk']),
        'arm'
      )?.name
    ).toBe('Fress_1.0.5-alpha_arm.apk');
    // No matching split -> the universal apk, never a wrong-ABI one.
    expect(
      pickOwnAsset(
        release(['Fress_1.0.5-alpha_x64.apk', 'Fress_1.0.5-alpha_universal.apk']),
        'arm'
      )?.name
    ).toBe('Fress_1.0.5-alpha_universal.apk');
  });

  it('an x86 Android device prefers the x86 apk, then universal, never x64', () => {
    androidUA();
    expect(
      pickOwnAsset(
        release(['Fress_1.0.5-alpha_x64.apk', 'Fress_1.0.5-alpha_x86.apk']),
        'x86'
      )?.name
    ).toBe('Fress_1.0.5-alpha_x86.apk');
    expect(
      pickOwnAsset(
        release(['Fress_1.0.5-alpha_x64.apk', 'Fress_1.0.5-alpha_universal.apk']),
        'x86'
      )?.name
    ).toBe('Fress_1.0.5-alpha_universal.apk');
  });

  it('CI asset naming: Fress_*_x64.apk IS the x86_64 build', () => {
    androidUA();
    expect(
      pickOwnAsset(
        release(['Fress_1.0.5-alpha_universal.apk', 'Fress_1.0.5-alpha_x64.apk']),
        'x86_64'
      )?.name
    ).toBe('Fress_1.0.5-alpha_x64.apk');
  });

  it('an arm64 device still falls back to universal over a wrong-ABI split', () => {
    androidUA();
    expect(
      pickOwnAsset(
        release(['Fress_1.0.5-alpha_x64.apk', 'Fress_1.0.5-alpha_universal.apk']),
        'aarch64'
      )?.name
    ).toBe('Fress_1.0.5-alpha_universal.apk');
  });
});

describe('fetchOwnLatestRelease — atom fallback', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const atomXml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <entry>
    <id>tag:github.com,2008:Repository/123456/v1.0.5-alpha</id>
    <updated>2026-09-22T22:18:42Z</updated>
  </entry>
  <entry>
    <id>tag:github.com,2008:Repository/123456/v1.0.4-beta</id>
    <updated>2026-09-21T10:00:00Z</updated>
  </entry>
  <entry>
    <id>tag:github.com,2008:Repository/123456/v1.0.3</id>
    <updated>2026-09-20T10:00:00Z</updated>
  </entry>
</feed>`;

  const apiDownAtomUp = () =>
    vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('api.github.com')) return new Response('rate limited', { status: 403 });
      if (u.endsWith('releases.atom')) return new Response(atomXml, { status: 200 });
      return new Response('unexpected', { status: 404 });
    });

  it('the fallback scans the whole feed: beta channel finds 1.0.4-beta under a newest alpha', async () => {
    // The old fallback read only the FIRST entry, saw an alpha, and gave
    // up on the Beta channel even though 1.0.4-beta sat right below it.
    vi.stubGlobal('fetch', apiDownAtomUp() as unknown as typeof fetch);
    const r = await fetchOwnLatestRelease('beta');
    expect(r?.tag).toBe('v1.0.4-beta');
  });

  it('the stable channel finds the stable release, not the newest prerelease', async () => {
    vi.stubGlobal('fetch', apiDownAtomUp() as unknown as typeof fetch);
    const r = await fetchOwnLatestRelease('stable');
    expect(r?.tag).toBe('v1.0.3');
  });

  it('the alpha channel takes the newest entry', async () => {
    vi.stubGlobal('fetch', apiDownAtomUp() as unknown as typeof fetch);
    const r = await fetchOwnLatestRelease('alpha');
    expect(r?.tag).toBe('v1.0.5-alpha');
  });

  it('returns null when no entry matches the channel', async () => {
    const alphaOnlyXml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>tag:github.com,2008:Repository/123456/v1.0.5-alpha</id>
    <updated>2026-09-22T22:18:42Z</updated>
  </entry>
</feed>`;
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('api.github.com')) return new Response('rate limited', { status: 403 });
      if (u.endsWith('releases.atom')) return new Response(alphaOnlyXml, { status: 200 });
      return new Response('unexpected', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const r = await fetchOwnLatestRelease('stable');
    expect(r).toBeNull();
  });
});
