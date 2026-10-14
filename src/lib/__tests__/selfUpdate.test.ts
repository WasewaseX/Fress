// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';

import {
  compareVersions,
  parseVersion,
  releaseMatchesChannel,
  pickOwnAsset,
  fetchOwnLatestRelease,
  fetchOwnAssetSignature,
  planUpdateDelivery,
  signatureSidecarFor,
  checkForUpdate,
  setUpdateChannel,
} from '../selfUpdate';
import type { OwnRelease } from '../selfUpdate';

/** Shared fixture asset name (the file every delivery-plan test plans around). */
const ASSET_NAME = 'Fress_1.0.7-alpha_x64-setup.exe';

describe('parseVersion', () => {
  it('parses plain versions', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [], build: [] });
  });

  it('parses a leading v (lower and upper case)', () => {
    expect(parseVersion('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [], build: [] });
    expect(parseVersion('V1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [], build: [] });
  });

  it('parses prerelease identifiers', () => {
    expect(parseVersion('1.0.2-alpha')).toEqual({ major: 1, minor: 0, patch: 2, prerelease: ['alpha'], build: [] });
    expect(parseVersion('v1.0.2-alpha.1')).toEqual({ major: 1, minor: 0, patch: 2, prerelease: ['alpha', '1'], build: [] });
  });

  it('parses build metadata and carries it separately from the prerelease', () => {
    expect(parseVersion('1.0.7+build.9')).toEqual({ major: 1, minor: 0, patch: 7, prerelease: [], build: ['build', '9'] });
    expect(parseVersion('1.0.7-beta.2+exp.sha.5114f85')).toEqual({
      major: 1, minor: 0, patch: 7, prerelease: ['beta', '2'], build: ['exp', 'sha', '5114f85'],
    });
  });

  it('accepts every documented tag shape from the release feed', () => {
    // The exact acceptance list the updater trust audit requires.
    for (const tag of ['v1.0.7', '1.0.7', '1.0.7-beta.2', '1.0.7-rc.1', '1.0.7+build.9']) {
      expect(parseVersion(tag)).not.toBeNull();
    }
  });

  it('rejects trailing junk instead of truncating it away', () => {
    // The old pattern was start-anchored only, so "1.0.7junk" matched the
    // "1.0.7" prefix and entered the candidate list as a stable release.
    expect(parseVersion('1.0.7junk')).toBeNull();
    // Note: "1.0.7-beta.2x" is VALID (alphanumeric prerelease identifier
    // "2x"); junk here means characters the grammar does not allow at all.
    expect(parseVersion('1.0.7-x_y')).toBeNull();
    expect(parseVersion('1.0.7 NOT-A-VERSION')).toBeNull();
    expect(parseVersion('1.0.7-beta.2!')).toBeNull();
  });

  it('rejects empty identifiers and empty segments', () => {
    expect(parseVersion('1.0.7-beta..2')).toBeNull();
    expect(parseVersion('1.0.7-')).toBeNull();
    expect(parseVersion('1.0.7+')).toBeNull();
    expect(parseVersion('1.0.7-beta.')).toBeNull();
  });

  it('rejects an empty version and whitespace-only input', () => {
    expect(parseVersion('')).toBeNull();
    expect(parseVersion('   ')).toBeNull();
  });

  it('rejects leading zeros in the core components', () => {
    expect(parseVersion('01.2.3')).toBeNull();
    expect(parseVersion('1.02.3')).toBeNull();
    expect(parseVersion('1.2.03')).toBeNull();
    expect(parseVersion('v01.0.7')).toBeNull();
  });

  it('rejects malformed numeric prerelease identifiers', () => {
    // Numeric prerelease identifiers follow the same no-leading-zero rule;
    // alphanumeric ones may start with a digit (official SemVer grammar).
    expect(parseVersion('1.0.7-beta.02')).toBeNull();
    expect(parseVersion('1.0.7-rc.01.2')).toBeNull();
    expect(parseVersion('1.0.7-beta.02a')).not.toBeNull();
  });

  it('rejects incomplete cores and other garbage', () => {
    expect(parseVersion('not-a-version')).toBeNull();
    expect(parseVersion('1.2')).toBeNull();
    expect(parseVersion('1.2.3.4')).toBeNull();
    expect(parseVersion('1.2.3-+build')).toBeNull();
  });
});

describe('compareVersions, the old code treated these all as [1,0,1]', () => {
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

  it('is antisymmetric and deterministic even when a side is unparsable', () => {
    // The old fallback returned -1 in BOTH directions for mixed input,
    // which let sort order depend on input order. Whatever the arguments,
    // swapping them must flip the sign.
    const pairs: Array<[string, string]> = [
      ['1.0.7', '1.0.8'],
      ['1.0.7', 'weird-tag'],
      ['weird-tag', '1.0.7'],
      ['junk-a', 'junk-b'],
      ['1.0.7+build.9', '1.0.7'],
    ];
    for (const [a, b] of pairs) {
      // Sign sum: opposite signs cancel to 0, and two zeros (equal from
      // both directions) also sum to 0 - dodging Object.is's -0 quirk.
      expect(Math.sign(compareVersions(a, b)) + Math.sign(compareVersions(b, a))).toBe(0);
    }
    // Equal normalized forms compare equal from both directions.
    expect(compareVersions('v1.0.7', '1.0.7')).toBe(0);
    expect(compareVersions('1.0.7', 'v1.0.7')).toBe(0);
  });

  it('build metadata never changes precedence (SemVer rule 10)', () => {
    expect(compareVersions('1.0.7+build.9', '1.0.7')).toBe(0);
    expect(compareVersions('1.0.7', '1.0.7+build.9')).toBe(0);
    expect(compareVersions('1.0.7-alpha.1+exp.1', '1.0.7-alpha.1+exp.2')).toBe(0);
    expect(compareVersions('1.0.7-alpha.1+exp.1', '1.0.7-alpha.1')).toBe(0);
  });

  it('orders numeric prerelease identifiers by value, not lexically, across boundaries', () => {
    expect(compareVersions('1.0.7-beta.2', '1.0.7-beta.10')).toBe(-1);
    expect(compareVersions('1.0.9', '1.1.0')).toBe(-1);
    expect(compareVersions('1.0.10', '1.1.0')).toBe(-1);
    expect(compareVersions('1.9.9', '2.0.0')).toBe(-1);
    expect(compareVersions('2.0.0-alpha', '2.0.0')).toBe(-1);
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

  it('an unparsable tag matches NO channel (policy boundary is fail-closed)', () => {
    // The old "stay visible" shape made malformed tags eligible on every
    // channel INCLUDING stable. The channel gate is exactly where malformed
    // tags must be rejected - and fetchFromApi/fetchFromAtom drop them from
    // the candidate list entirely before sorting.
    expect(releaseMatchesChannel('weird', 'stable')).toBe(false);
    expect(releaseMatchesChannel('weird', 'beta')).toBe(false);
    expect(releaseMatchesChannel('weird', 'alpha')).toBe(false);
    expect(releaseMatchesChannel('1.0.7junk', 'alpha')).toBe(false);
  });
});

describe('pickOwnAsset, macOS assets', () => {
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

  it('a pkg-only release still offers a direct download when the arch is known', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15' });
    const asset = pickOwnAsset(release(['Fress_1.0.4-alpha_aarch64.pkg']), 'aarch64');
    expect(asset?.name).toBe('Fress_1.0.4-alpha_aarch64.pkg');
  });

  it('dmg is still preferred over pkg when both exist (same arch)', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15' });
    const asset = pickOwnAsset(
      release(['Fress_1.0.4-alpha_x64.pkg', 'Fress_1.0.4-alpha_x64.dmg']),
      'x86_64'
    );
    expect(asset?.name).toBe('Fress_1.0.4-alpha_x64.dmg');
  });

  it('uses the arch hint: Apple Silicon gets the arm dmg (UA lies about Intel)', () => {
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

  it('an ARM64-only dmg is INELIGIBLE on an Intel Mac, even when it is the only asset', () => {
    // The old scoring gave it a merely negative score (-3); alone in the
    // release it beat the -Infinity scan floor and was offered to an Intel
    // Mac. Eligibility now excludes it outright.
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15' });
    expect(pickOwnAsset(release(['Fress_1.0.4-alpha_aarch64.dmg']), 'x86_64')).toBeNull();
  });

  it('an x64-only dmg is INELIGIBLE on Apple Silicon (no Rosetta side-step by self-update)', () => {
    // archHint is the Fress PROCESS architecture on macOS. An arm64-native
    // process never gets an x64-only artifact: self-update never moves a
    // native install onto the emulated side of the fence. (An x64 Fress
    // process under Rosetta reports x86_64 and keeps updating as x64 - a
    // deliberate, documented, fixture-tested policy.)
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15' });
    expect(pickOwnAsset(release(['Fress_1.0.4-alpha_x64.dmg']), 'aarch64')).toBeNull();
  });

  it('a universal dmg is eligible on both architectures, below a marked match', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15' });
    expect(
      pickOwnAsset(release(['Fress_1.0.4-alpha_universal.dmg', 'Fress_1.0.4-alpha_aarch64.dmg']), 'aarch64')?.name
    ).toBe('Fress_1.0.4-alpha_aarch64.dmg');
    expect(
      pickOwnAsset(release(['Fress_1.0.4-alpha_universal.dmg', 'Fress_1.0.4-alpha_x64.dmg']), 'x86_64')?.name
    ).toBe('Fress_1.0.4-alpha_x64.dmg');
    expect(pickOwnAsset(release(['Fress_1.0.4-alpha_universal.dmg']), 'aarch64')?.name).toBe(
      'Fress_1.0.4-alpha_universal.dmg'
    );
    expect(pickOwnAsset(release(['Fress_1.0.4-alpha_universal.dmg']), 'x86_64')?.name).toBe(
      'Fress_1.0.4-alpha_universal.dmg'
    );
  });

  it('with NO arch signal (browser mode) marked dmgs are ineligible; unmarked stays a last resort', () => {
    // A Mac WebView UA claims "Intel" even on Apple Silicon, so the absence
    // of a Tauri arch hint means UNKNOWN, never x64. Unknown gets universal
    // and unmarked artifacts only; anything marked is a guess this picker
    // refuses to make, and the UI falls back to the releases page.
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15' });
    expect(pickOwnAsset(release(['Fress_1.0.4-alpha_aarch64.dmg', 'Fress_1.0.4-alpha_x64.dmg']), undefined)).toBeNull();
    expect(pickOwnAsset(release(['Fress-1.0.4.dmg']), undefined)?.name).toBe('Fress-1.0.4.dmg');
  });

  it('an untyped-only dmg is still picked when it is the only candidate', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15' });
    const asset = pickOwnAsset(release(['Fress-1.0.4.dmg']), 'aarch64');
    expect(asset?.name).toBe('Fress-1.0.4.dmg');
  });
});

describe('pickOwnAsset, Android assets', () => {
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

  // Regression matrix for "unknown device => universal ONLY" in the
  // self-updater: the unmarked-apk gamble (score 4) used to be accepted
  // BEFORE the unknown check, so an arch-less browser session could be
  // handed Fress_1.0.7_release.apk whose ABI is precisely the unknown.
  describe('unknown device => universal only (self-updater)', () => {
    it('unknown + generic unmarked apk => null', () => {
      androidUA();
      expect(pickOwnAsset(release(['Fress_1.0.7_release.apk']), undefined)).toBeNull();
    });

    it('unknown + gradle split app-arm64-release.apk => null (not "universal" via ^app-)', () => {
      androidUA();
      expect(pickOwnAsset(release(['app-arm64-release.apk']), undefined)).toBeNull();
    });

    it('unknown + app-release.apk => null (unmarked, not classified universal)', () => {
      androidUA();
      expect(pickOwnAsset(release(['app-release.apk']), undefined)).toBeNull();
    });

    it('unknown + real universal apk => the universal apk', () => {
      androidUA();
      expect(pickOwnAsset(release(['Fress_1.0.7_universal.apk']), undefined)?.name).toBe(
        'Fress_1.0.7_universal.apk'
      );
      expect(pickOwnAsset(release(['app-universal-release.apk']), undefined)?.name).toBe(
        'app-universal-release.apk'
      );
    });

    it('unknown + unmarked apk beside a real universal => universal wins', () => {
      androidUA();
      const pick = pickOwnAsset(
        release(['Fress_1.0.7_release.apk', 'Fress_1.0.7_universal.apk']),
        undefined
      );
      expect(pick?.name).toBe('Fress_1.0.7_universal.apk');
    });

    it('a KNOWN device may still gamble on an unmarked apk (below universal, below exact ABI)', () => {
      androidUA();
      expect(
        pickOwnAsset(release(['Fress_1.0.7_release.apk', 'Fress_1.0.7_universal.apk']), 'x86_64')
          ?.name
      ).toBe('Fress_1.0.7_universal.apk');
      expect(pickOwnAsset(release(['Fress_1.0.7_release.apk']), 'x86_64')?.name).toBe(
        'Fress_1.0.7_release.apk'
      );
    });
  });
});

describe('pickOwnAsset, Windows assets (setup is a bonus, never an early return)', () => {
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
    // The arm64 installer is not merely out-ranked - it is INELIGIBLE on a
    // native x64 host (WoA emulates x64, not the reverse), so the only
    // survivor is the right-arch portable.
    expect(
      pickOwnAsset(
        release(['Fress_1.0.5-alpha_arm64-setup.exe', 'Fress_1.0.5-alpha_x64.exe']),
        'x86_64'
      )?.name
    ).toBe('Fress_1.0.5-alpha_x64.exe');
  });

  it('an ARM64-only release is INELIGIBLE on x64 Windows: the pick is null, not the ARM64 exe', () => {
    // The exact regression the two-phase rewrite exists for: the old scan
    // started at -Infinity and gave the ARM64 exe a low POSITIVE score, so
    // a release carrying ONLY the ARM64 installer handed it to an x64
    // machine. A name ending in .exe alone is not an x64 marker.
    windowsUA();
    expect(
      pickOwnAsset(release(['Fress_1.0.5-alpha_arm64-setup.exe']), 'x86_64')
    ).toBeNull();
    expect(
      pickOwnAsset(release(['Fress_1.0.5-alpha_arm64.exe']), 'x86_64')
    ).toBeNull();
  });

  it('on ARM64 Windows the native ARM64 build outranks the emulated x64 one, and x64 stays eligible', () => {
    windowsUA();
    expect(
      pickOwnAsset(release(['Fress_1.0.5-alpha_x64-setup.exe']), 'aarch64')?.name
    ).toBe('Fress_1.0.5-alpha_x64-setup.exe');
    expect(
      pickOwnAsset(release(['Fress_1.0.5-alpha_x64.exe', 'Fress_1.0.5-alpha_arm64.exe']), 'aarch64')?.name
    ).toBe('Fress_1.0.5-alpha_arm64.exe');
  });

  it('a 32-bit Windows host is not offered arm64 or x64 exes', () => {
    windowsUA();
    expect(pickOwnAsset(release(['Fress_1.0.5-alpha_x64-setup.exe']), 'x86')).toBeNull();
    expect(pickOwnAsset(release(['Fress_1.0.5-alpha_arm64-setup.exe']), 'i686')).toBeNull();
  });

  it('a CLI companion is never the app installer candidate, even when it is the only exe', () => {
    windowsUA();
    // LocalSend-style naming: the CLI is a 2 MB console tool next to the
    // GUI installer. The token rule (cli at a separator boundary) must not
    // match "client"/"click".
    expect(
      pickOwnAsset(release(['fress-cli-1.0.5-windows-x64.exe']), 'x86_64')
    ).toBeNull();
    expect(
      pickOwnAsset(
        release(['Fress-CLI-1.0.5-windows-arm-64.exe', 'Fress_1.0.5-alpha_x64-setup.exe']),
        'x86_64'
      )?.name
    ).toBe('Fress_1.0.5-alpha_x64-setup.exe');
  });
});

describe('pickOwnAsset, Linux assets (architecture-aware, refuses mismatches)', () => {
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

describe('pickOwnAsset, Android assets (full ABI awareness, classification shared with the catalog)', () => {
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

  it('a wrong-ABI-only release is INELIGIBLE: null, never a low-scored wrong apk', () => {
    androidUA();
    expect(
      pickOwnAsset(release(['Fress_1.0.5-alpha_x64.apk']), 'aarch64')
    ).toBeNull();
    expect(
      pickOwnAsset(release(['Fress_1.0.5-alpha_arm64.apk']), 'x86')
    ).toBeNull();
  });

  it('an x86_64 device accepts a 32-bit x86 apk only as the documented cross-ABI fallback', () => {
    androidUA();
    expect(
      pickOwnAsset(release(['Fress_1.0.5-alpha_x86.apk', 'Fress_1.0.5-alpha_universal.apk']), 'x86_64')?.name
    ).toBe('Fress_1.0.5-alpha_universal.apk');
    expect(
      pickOwnAsset(release(['Fress_1.0.5-alpha_x86.apk']), 'x86_64')?.name
    ).toBe('Fress_1.0.5-alpha_x86.apk');
  });

  it('a browser that cannot know the ABI (reduced UA) gets universal, never a split', () => {
    // Modern Android browsers hide the CPU arch entirely ("Linux; Android
    // 16; Pixel 9"), and the old browser fallback guessed x86_64 - handing
    // ARM phones an x86_64-only apk that cannot install. archHint undefined
    // is the browser-mode signal for "unknown".
    androidUA();
    expect(
      pickOwnAsset(
        release([
          'Fress_1.0.5-alpha_x64.apk',
          'Fress_1.0.5-alpha_arm64.apk',
          'Fress_1.0.5-alpha_universal.apk',
        ]),
        undefined
      )?.name
    ).toBe('Fress_1.0.5-alpha_universal.apk');
  });

  it('an unknown-ABI browser with no universal apk is offered NOTHING (releases page), not a guess', () => {
    androidUA();
    expect(
      pickOwnAsset(
        release(['Fress_1.0.5-alpha_x64.apk', 'Fress_1.0.5-alpha_arm64.apk']),
        undefined
      )
    ).toBeNull();
  });
});

describe('pickOwnAsset, incompatible-only releases (the two-phase regression matrix)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const mkRelease = (names: string[]): OwnRelease => ({
    tag: 'v1.0.7-beta',
    version: '1.0.7-beta',
    publishedAt: '2026-10-11T00:00:00Z',
    htmlUrl: 'https://github.com/WasewaseX/Fress/releases/tag/v1.0.7-beta',
    assets: names.map((name) => ({ name, size: 1000, url: `https://example.com/${name}` })),
  });

  /** Every permutation of `names` (n! is tiny for these fixtures) must
   * produce the same pick: candidate identities and priorities are fixed
   * by the names, never by the position in the assets array. */
  const pickForEveryPermutation = (names: string[], archHint?: string): Array<string | null> => {
    const results = new Set<string | null>();
    const permute = (prefix: string[], rest: string[]) => {
      if (rest.length === 0) {
        const pick = pickOwnAsset(mkRelease(prefix), archHint);
        results.add(pick ? pick.name : null);
        return;
      }
      for (let i = 0; i < rest.length; i++) {
        permute([...prefix, rest[i]], [...rest.slice(0, i), ...rest.slice(i + 1)]);
      }
    };
    permute([], names);
    return [...results];
  };

  it('ARM64-only EXE on x64 Windows -> null and the releases-page fallback', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' });
    const release = mkRelease(['Fress_1.0.7-beta_arm64-setup.exe']);
    expect(pickOwnAsset(release, 'x86_64')).toBeNull();
    expect(planUpdateDelivery(release, pickOwnAsset(release, 'x86_64'), 'a'.repeat(64), null)).toMatchObject({
      kind: 'releases-page',
      reason: 'no-asset',
    });
  });

  it('x64 EXE on Intel Windows -> the x64 installer is offered', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' });
    expect(pickOwnAsset(mkRelease(['Fress_1.0.7-beta_x64-setup.exe']), 'x86_64')?.name).toBe(
      'Fress_1.0.7-beta_x64-setup.exe'
    );
  });

  it('ARM64-only DMG on Intel macOS -> null and the releases-page fallback', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15' });
    const release = mkRelease(['Fress_1.0.7-beta_aarch64.dmg']);
    expect(pickOwnAsset(release, 'x86_64')).toBeNull();
    expect(planUpdateDelivery(release, pickOwnAsset(release, 'x86_64'), 'a'.repeat(64), null)).toMatchObject({
      kind: 'releases-page',
      reason: 'no-asset',
    });
  });

  it('x64-only DMG on Apple Silicon -> null and the releases-page fallback', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15' });
    const release = mkRelease(['Fress_1.0.7-beta_x64.dmg']);
    expect(pickOwnAsset(release, 'aarch64')).toBeNull();
    expect(planUpdateDelivery(release, pickOwnAsset(release, 'aarch64'), 'a'.repeat(64), null)).toMatchObject({
      kind: 'releases-page',
      reason: 'no-asset',
    });
  });

  it('APK with only a wrong ABI -> null and the releases-page fallback', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36' });
    const release = mkRelease(['Fress_1.0.7-beta_x64.apk']);
    expect(pickOwnAsset(release, 'aarch64')).toBeNull();
    expect(planUpdateDelivery(release, pickOwnAsset(release, 'aarch64'), 'a'.repeat(64), null)).toMatchObject({
      kind: 'releases-page',
      reason: 'no-asset',
    });
  });

  it('APK with a supported ABI plus an incompatible decoy -> the supported one wins', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36' });
    const names = ['Fress_1.0.7-beta_x86.apk', 'Fress_1.0.7-beta_arm64.apk'];
    expect(pickOwnAsset(mkRelease(names), 'aarch64')?.name).toBe('Fress_1.0.7-beta_arm64.apk');
    expect(pickForEveryPermutation(names, 'aarch64')).toEqual(['Fress_1.0.7-beta_arm64.apk']);
  });

  it('Linux AppImage with an incompatible architecture -> null and the releases-page fallback', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' });
    const release = mkRelease(['Fress_1.0.7-beta_aarch64.AppImage']);
    expect(pickOwnAsset(release, 'x86_64')).toBeNull();
    expect(planUpdateDelivery(release, pickOwnAsset(release, 'x86_64'), 'a'.repeat(64), null)).toMatchObject({
      kind: 'releases-page',
      reason: 'no-asset',
    });
  });

  it('a CLI asset and a GUI asset together -> the GUI asset wins, in every order', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' });
    const names = ['Fress-CLI-1.0.7-windows-arm-64.exe', 'Fress_1.0.7-beta_x64-setup.exe'];
    expect(pickOwnAsset(mkRelease(names), 'x86_64')?.name).toBe('Fress_1.0.7-beta_x64-setup.exe');
    expect(pickForEveryPermutation(names, 'x86_64')).toEqual(['Fress_1.0.7-beta_x64-setup.exe']);
  });

  it('only an incompatible asset (mixed-platform release, this platform excluded) -> null', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' });
    // A release that carries only a Windows installer: nothing on this
    // Linux host is eligible, no matter how the array is ordered.
    expect(pickOwnAsset(mkRelease(['Fress_1.0.7-beta_x64-setup.exe']), 'x86_64')).toBeNull();
  });

  it('no compatible direct installer at all (unknown ABI, no universal) -> releases-page fallback', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36' });
    const release = mkRelease(['Fress_1.0.7-beta_arm64.apk', 'Fress_1.0.7-beta_x64.apk']);
    expect(pickOwnAsset(release, undefined)).toBeNull();
    expect(planUpdateDelivery(release, pickOwnAsset(release, undefined), null, null)).toMatchObject({
      kind: 'releases-page',
      reason: 'no-asset',
    });
  });

  it('asset order can never change the selection (full permutation sweep over mixed releases)', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' });
    const windowsNames = [
      'Fress_1.0.7-beta_arm64-setup.exe',
      'Fress_1.0.7-beta_x64.exe',
      'Fress_1.0.7-beta_x64-setup.exe',
      'Fress-CLI-1.0.7-windows-x64.exe',
    ];
    expect(pickForEveryPermutation(windowsNames, 'x86_64')).toEqual(['Fress_1.0.7-beta_x64-setup.exe']);
    expect(pickForEveryPermutation(windowsNames, 'aarch64')).toEqual(['Fress_1.0.7-beta_arm64-setup.exe']);

    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15' });
    const macNames = ['Fress_1.0.7-beta_x64.dmg', 'Fress_1.0.7-beta_aarch64.dmg', 'Fress_1.0.7-beta_universal.dmg'];
    expect(pickForEveryPermutation(macNames, 'aarch64')).toEqual(['Fress_1.0.7-beta_aarch64.dmg']);
    expect(pickForEveryPermutation(macNames, 'x86_64')).toEqual(['Fress_1.0.7-beta_x64.dmg']);
  });

  it('candidates that rank identically are broken by name, not by list position', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' });
    // Two unmarked portables rank identically on a known-x64 host; the
    // lexicographic tie-break makes the outcome order-independent.
    expect(pickForEveryPermutation(['Fress_beta.exe', 'Fress_alpha.exe'], 'x86_64')).toEqual(['Fress_alpha.exe']);
  });
});

describe('fetchFromApi, GitHub prerelease flag is a stability signal', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** API whose releases list carries a stable-LOOKING tag (v1.0.7) that
   * GitHub itself flags prerelease=true - the exact manual-release shape
   * the tag-only filter used to trust. */
  const apiWithFlaggedStable = () =>
    vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('api.github.com')) {
        return new Response(
          JSON.stringify([
            {
              tag_name: 'v1.0.7',
              name: '1.0.7',
              draft: false,
              prerelease: true,
              published_at: '2026-09-22T00:00:00Z',
              html_url: 'https://github.com/WasewaseX/Fress/releases/tag/v1.0.7',
              assets: [],
            },
          ]),
          { status: 200 }
        );
      }
      return new Response('unexpected', { status: 404 });
    });

  it('the stable channel rejects a prerelease-flagged stable-looking tag (atom cannot help either)', async () => {
    vi.stubGlobal('fetch', apiWithFlaggedStable() as unknown as typeof fetch);
    // The API path yields no acceptable release; the atom fallback refuses
    // to serve Stable at all (no prerelease flag there), so the result is
    // null and the UI links to the releases page instead of guessing.
    const r = await fetchOwnLatestRelease('stable');
    expect(r).toBeNull();
  });

  it('the alpha channel still sees the prerelease-flagged release', async () => {
    vi.stubGlobal('fetch', apiWithFlaggedStable() as unknown as typeof fetch);
    const r = await fetchOwnLatestRelease('alpha');
    expect(r?.tag).toBe('v1.0.7');
  });
});

describe('fetchOwnLatestRelease, atom fallback', () => {
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

  it('the stable channel is NOT served from the atom feed at all (no prerelease flag there)', async () => {
    // A stable-LOOKING atom tag cannot prove stability: a manual prerelease
    // tagged v1.0.4 would have been served as a stable update when the API
    // was down. Stable now requires API metadata - atom only ever serves
    // Beta/Alpha, where the tag pattern is the channel contract.
    vi.stubGlobal('fetch', apiDownAtomUp() as unknown as typeof fetch);
    const r = await fetchOwnLatestRelease('stable');
    expect(r).toBeNull();
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

describe('planUpdateDelivery, the fail-closed delivery rule shared by both update buttons', () => {
  // A well-formed sidecar reference, exactly what signatureSidecarFor
  // returns for a release that carries the .sig next to the artifact.
  const SIDE_CAR = { name: `${ASSET_NAME}.sig`, url: `https://example.com/${ASSET_NAME}.sig` };
  const release = (assets: OwnRelease['assets'] = []): OwnRelease => ({
    tag: 'v1.0.7-alpha',
    version: '1.0.7-alpha',
    publishedAt: '2026-10-11T00:00:00Z',
    htmlUrl: 'https://github.com/WasewaseX/Fress/releases',
    assets,
  });
  const asset = { name: ASSET_NAME, size: 1000, url: 'https://example.com/x' };

  it('downloads ONLY when a published checksum entry AND a signature sidecar are in hand', () => {
    const plan = planUpdateDelivery(release([asset, { name: SIDE_CAR.name, size: 420, url: SIDE_CAR.url }]), asset, 'a'.repeat(64), SIDE_CAR);
    expect(plan.kind).toBe('download');
    if (plan.kind === 'download') {
      expect(plan.sha256).toBe('a'.repeat(64));
      expect(plan.asset.name).toBe(asset.name);
      // The signature travels in the plan: it is part of what the
      // post-download verification will be run against.
      expect(plan.signature.name).toBe(`${ASSET_NAME}.sig`);
    }
  });

  it('a missing checksum NEVER becomes a download (releases page instead)', () => {
    // The pre-audit behavior delivered the installer unverified whenever
    // SHA256SUMS.txt was absent, listed the asset under a different name,
    // or could not be fetched at all. Delivery now fails closed.
    const plan = planUpdateDelivery(release([asset]), asset, null, SIDE_CAR);
    expect(plan).toMatchObject({ kind: 'releases-page', reason: 'unverifiable' });
  });

  it('a missing signature sidecar NEVER becomes a download (unsigned, releases page)', () => {
    // The macOS dmg / Android APK situation: integrity could be checked,
    // publisher authenticity could not. The honest route is the releases
    // page with the 'unsigned' reason - NOT a download that would be
    // presented as if it were publisher-authenticated.
    const plan = planUpdateDelivery(release([asset]), asset, 'a'.repeat(64), null);
    expect(plan).toMatchObject({ kind: 'releases-page', reason: 'unsigned' });
  });

  it('no platform asset at all goes to the releases page (no-asset)', () => {
    const plan = planUpdateDelivery(release(), null, 'a'.repeat(64), SIDE_CAR);
    expect(plan).toMatchObject({ kind: 'releases-page', reason: 'no-asset' });
  });
});

describe('signatureSidecarFor, the exact-filename sidecar binding', () => {
  const mkRelease = (names: string[]): OwnRelease => ({
    tag: 'v1.0.7-beta',
    version: '1.0.7-beta',
    publishedAt: '2026-10-11T00:00:00Z',
    htmlUrl: 'https://github.com/WasewaseX/Fress/releases/tag/v1.0.7-beta',
    assets: names.map((name) => ({ name, size: 420, url: `https://example.com/${name}` })),
  });

  it('finds the sidecar published next to the artifact', () => {
    const release = mkRelease(['Fress_1.0.7-beta_x64-setup.exe', 'Fress_1.0.7-beta_x64-setup.exe.sig']);
    expect(signatureSidecarFor(release, 'Fress_1.0.7-beta_x64-setup.exe')).toEqual({
      name: 'Fress_1.0.7-beta_x64-setup.exe.sig',
      url: 'https://example.com/Fress_1.0.7-beta_x64-setup.exe.sig',
    });
  });

  it('a sidecar for ANOTHER filename, version or architecture is not the one', () => {
    const release = mkRelease([
      'Fress_1.0.7-beta_x64-setup.exe',
      // Sidecars that exist but authenticate OTHER artifacts.
      'Fress_1.0.8-beta_x64-setup.exe.sig',
      'Fress_1.0.7-beta_arm64-setup.exe.sig',
      'Fress_1.0.7-beta_amd64.AppImage.sig',
      'signature.sig',
    ]);
    expect(signatureSidecarFor(release, 'Fress_1.0.7-beta_x64-setup.exe')).toBeNull();
  });

  it('a release without sidecars yields null (unsigned artifact)', () => {
    const release = mkRelease(['Fress_1.0.7-beta_x64.dmg', 'SHA256SUMS.txt']);
    expect(signatureSidecarFor(release, 'Fress_1.0.7-beta_x64.dmg')).toBeNull();
  });
});

describe('fetchOwnAssetSignature, the plan-time shape gate (browser fallback path)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A Tauri/minisign .sig sidecar: ONE outer-base64 line decoding to the
   * four-line document (untrusted comment / 74-byte cryptobuf with the ED
   * prehashed algorithm id / trusted comment / 64-byte global signature). */
  const innerDoc = [
    'untrusted comment: signature from tauri secret key',
    Buffer.concat([Buffer.from('ED'), Buffer.alloc(72, 7)]).toString('base64'),
    'trusted comment: timestamp:1791744131\tfile:Fress_1.0.7-beta_x64-setup.exe',
    Buffer.alloc(64, 9).toString('base64'),
  ].join('\n');
  const SIDECAR_B64 = Buffer.from(innerDoc, 'utf8').toString('base64');

  const releaseWithSidecar = (sidecarBody: string): OwnRelease => ({
    tag: 'v1.0.7-beta',
    version: '1.0.7-beta',
    publishedAt: '2026-10-11T00:00:00Z',
    htmlUrl: 'https://github.com/WasewaseX/Fress/releases/tag/v1.0.7-beta',
    assets: [
      { name: 'Fress_1.0.7-beta_x64-setup.exe', size: 1000, url: 'https://example.com/exe' },
      { name: 'Fress_1.0.7-beta_x64-setup.exe.sig', size: 420, url: 'https://example.com/exe.sig' },
    ],
  });

  it('a well-formed sidecar document is returned verbatim for the verifier', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        if (String(url).endsWith('.sig')) return new Response(SIDECAR_B64, { status: 200 });
        return new Response('unexpected', { status: 404 });
      }) as unknown as typeof fetch
    );
    const res = await fetchOwnAssetSignature(releaseWithSidecar(SIDECAR_B64), 'Fress_1.0.7-beta_x64-setup.exe');
    expect(res).toEqual({ status: 'ok', document: SIDECAR_B64 });
  });

  it('no sidecar on the release -> missing (an unsigned artifact, not a network problem)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('unexpected', { status: 404 })) as unknown as typeof fetch
    );
    const release = { ...releaseWithSidecar(SIDECAR_B64), assets: [releaseWithSidecar(SIDECAR_B64).assets[0]] };
    const res = await fetchOwnAssetSignature(release, 'Fress_1.0.7-beta_x64-setup.exe');
    expect(res).toEqual({ status: 'missing' });
  });

  it('an unreachable sidecar document -> unreachable (retryable)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('gone', { status: 404 })) as unknown as typeof fetch
    );
    const res = await fetchOwnAssetSignature(releaseWithSidecar(SIDECAR_B64), 'Fress_1.0.7-beta_x64-setup.exe');
    expect(res).toEqual({ status: 'unreachable' });
  });

  it('a malformed document (not a minisign signature) is refused at the plan gate', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        if (String(url).endsWith('.sig')) return new Response('<html>blocked</html>', { status: 200 });
        return new Response('unexpected', { status: 404 });
      }) as unknown as typeof fetch
    );
    const res = await fetchOwnAssetSignature(releaseWithSidecar(SIDECAR_B64), 'Fress_1.0.7-beta_x64-setup.exe');
    expect(res).toEqual({ status: 'malformed' });
  });

  it('a truncated or wrong-cryptobuf document is malformed, never "ok"', async () => {
    const badDocs = [
      // Truncated outer base64.
      SIDECAR_B64.slice(0, SIDECAR_B64.length - 12),
      // Wrong sig cryptobuf length (not 74 bytes).
      Buffer.from(
        [
          'untrusted comment: x',
          Buffer.alloc(60, 7).toString('base64'),
          'trusted comment: t',
          Buffer.alloc(64, 9).toString('base64'),
        ].join('\n'),
        'utf8'
      ).toString('base64'),
      // Legacy (non-prehashed) algorithm id is refused like the native verifier refuses it.
      Buffer.from(
        [
          'untrusted comment: x',
          Buffer.concat([Buffer.from('Ed'), Buffer.alloc(72, 7)]).toString('base64'),
          'trusted comment: t',
          Buffer.alloc(64, 9).toString('base64'),
        ].join('\n'),
        'utf8'
      ).toString('base64'),
    ];
    for (const bad of badDocs) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string | URL | Request) => {
          if (String(url).endsWith('.sig')) return new Response(bad, { status: 200 });
          return new Response('unexpected', { status: 404 });
        }) as unknown as typeof fetch
      );
      const res = await fetchOwnAssetSignature(releaseWithSidecar(bad), 'Fress_1.0.7-beta_x64-setup.exe');
      expect(res).toEqual({ status: 'malformed' });
    }
  });
});

describe('checkForUpdate checksum plumbing (browser fallback path)', () => {
  beforeEach(() => {
    // These tests pin the browser checksum plumbing, not channel policy:
    // pin the widest prerelease channel explicitly so the feed fixture (a
    // prerelease release) stays visible regardless of the running build's
    // own version. A stable 1.0.0 build would otherwise default to the
    // 'stable' channel, which correctly hides prerelease feeds — the
    // build-aware default from the stable-channel policy — and these
    // assertions would never reach the checksum code under test. This file
    // runs in the node environment (no DOM), so the storage surface itself
    // is stubbed with the minimal contract getUpdateChannel uses.
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    setUpdateChannel('alpha');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const releaseWithSums = (sumsBody: string) =>
    vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('api.github.com')) {
        return new Response(
          JSON.stringify([
            {
              tag_name: 'v1.0.7-alpha',
              name: '1.0.7-alpha',
              draft: false,
              prerelease: true,
              published_at: '2026-10-11T00:00:00Z',
              html_url: 'https://github.com/WasewaseX/Fress/releases/tag/v1.0.7-alpha',
              assets: [
                { name: 'Fress_1.0.7-alpha_x64-setup.exe', size: 1000, browser_download_url: 'https://github.com/WasewaseX/Fress/releases/download/v1.0.7-alpha/Fress_1.0.7-alpha_x64-setup.exe' },
                { name: 'SHA256SUMS.txt', size: 100, browser_download_url: 'https://github.com/WasewaseX/Fress/releases/download/v1.0.7-alpha/SHA256SUMS.txt' },
              ],
            },
          ]),
          { status: 200 }
        );
      }
      if (u.endsWith('SHA256SUMS.txt')) return new Response(sumsBody, { status: 200 });
      return new Response('unexpected', { status: 404 });
    });

  it('returns expectedSha256 when SHA256SUMS.txt lists the picked asset', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' });
    const sums = `0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef  Fress_1.0.7-alpha_x64-setup.exe\nffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff  other.bin\n`;
    vi.stubGlobal('fetch', releaseWithSums(sums) as unknown as typeof fetch);
    const res = await checkForUpdate('1.0.6-beta');
    expect(res.kind).toBe('available');
    if (res.kind === 'available') {
      expect(res.expectedSha256).toBe('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
    }
  });

  it('degrades to null (unverified, and delivery then fails closed) when the entry is missing', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' });
    vi.stubGlobal('fetch', releaseWithSums('ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff  other.bin\n') as unknown as typeof fetch);
    const res = await checkForUpdate('1.0.6-beta');
    expect(res.kind).toBe('available');
    if (res.kind === 'available') {
      expect(res.expectedSha256).toBeNull();
    }
  });

  it('degrades to null when the checksum document is unreachable', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' });
    const failing = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('SHA256SUMS.txt')) throw new TypeError('Failed to fetch');
      if (String(url).includes('api.github.com')) {
        return new Response(
          JSON.stringify([
            {
              tag_name: 'v1.0.7-alpha',
              name: '1.0.7-alpha',
              draft: false,
              prerelease: true,
              published_at: '2026-10-11T00:00:00Z',
              html_url: 'https://github.com/WasewaseX/Fress/releases/tag/v1.0.7-alpha',
              assets: [
                { name: 'Fress_1.0.7-alpha_x64-setup.exe', size: 1000, browser_download_url: 'https://github.com/WasewaseX/Fress/releases/download/v1.0.7-alpha/Fress_1.0.7-alpha_x64-setup.exe' },
                { name: 'SHA256SUMS.txt', size: 100, browser_download_url: 'https://github.com/WasewaseX/Fress/releases/download/v1.0.7-alpha/SHA256SUMS.txt' },
              ],
            },
          ]),
          { status: 200 }
        );
      }
      return new Response('unexpected', { status: 404 });
    });
    vi.stubGlobal('fetch', failing as unknown as typeof fetch);
    const res = await checkForUpdate('1.0.6-beta');
    expect(res.kind).toBe('available');
    if (res.kind === 'available') {
      expect(res.expectedSha256).toBeNull();
    }
  });
});

describe('fetchExpectedSha256 hardening (via checkForUpdate, browser path)', () => {
  beforeEach(() => {
    // Same contract coupling as the checksum-plumbing describe above: the
    // fixture feed is a prerelease, so the widest channel is pinned
    // explicitly (via the same minimal node-env storage stub) instead of
    // relying on the running build's default.
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    setUpdateChannel('alpha');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const A = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const B = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
  const ASSET = 'Fress_1.0.7-alpha_x64-setup.exe';

  /** API mock whose SHA256SUMS.txt body is controllable per call, and which
   * records every checksum-document hit so tests can prove a retry performs
   * an ACTUAL fresh lookup rather than replaying a cached answer. */
  const sumsServingApi = (bodies: string[]) => {
    let sumsCalls = 0;
    const fn = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('api.github.com')) {
        return new Response(
          JSON.stringify([
            {
              tag_name: 'v1.0.7-alpha',
              name: '1.0.7-alpha',
              draft: false,
              prerelease: true,
              published_at: '2026-10-11T00:00:00Z',
              html_url: 'https://github.com/WasewaseX/Fress/releases/tag/v1.0.7-alpha',
              assets: [
                { name: ASSET, size: 1000, browser_download_url: `https://github.com/WasewaseX/Fress/releases/download/v1.0.7-alpha/${ASSET}` },
                { name: 'SHA256SUMS.txt', size: 100, browser_download_url: 'https://github.com/WasewaseX/Fress/releases/download/v1.0.7-alpha/SHA256SUMS.txt' },
              ],
            },
          ]),
          { status: 200 }
        );
      }
      if (u.endsWith('SHA256SUMS.txt')) {
        const body = bodies[Math.min(sumsCalls, bodies.length - 1)];
        sumsCalls += 1;
        return new Response(body, { status: 200 });
      }
      return new Response('unexpected', { status: 404 });
    });
    return { fetchMock: fn, getSumsCalls: () => sumsCalls };
  };

  const windowsUA = () =>
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' });

  it('malformed lines can never yield a digest; a valid entry still verifies', async () => {
    windowsUA();
    const sums = [
      'not-a-hash-line at all',
      'zzzz  ' + ASSET, // non-hex "hash"
      A.slice(0, 63) + '  ' + ASSET, // 63-char hash: malformed, skipped
      `${A}  ${ASSET}`, // the one real entry
      `${B}  other.bin`,
    ].join('\n');
    const { fetchMock } = sumsServingApi([sums]);
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const res = await checkForUpdate('1.0.6-beta');
    expect(res.kind).toBe('available');
    if (res.kind === 'available') expect(res.expectedSha256).toBe(A);
  });

  it('duplicate entries with the SAME digest agree and verify', async () => {
    windowsUA();
    const sums = `${A}  ${ASSET}\n${A}  ${ASSET}\n`;
    const { fetchMock } = sumsServingApi([sums]);
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const res = await checkForUpdate('1.0.6-beta');
    expect(res.kind).toBe('available');
    if (res.kind === 'available') expect(res.expectedSha256).toBe(A);
  });

  it('duplicate entries with CONFLICTING digests fail closed (null, no download)', async () => {
    windowsUA();
    const sums = `${A}  ${ASSET}\n${B}  ${ASSET}\n`;
    const { fetchMock } = sumsServingApi([sums]);
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const res = await checkForUpdate('1.0.6-beta');
    expect(res.kind).toBe('available');
    if (res.kind === 'available') {
      expect(res.expectedSha256).toBeNull();
      // The fail-closed delivery rule turns this into a releases-page route.
      expect(planUpdateDelivery(res.release, res.asset, res.expectedSha256, null)).toMatchObject({
        kind: 'releases-page',
        reason: 'unverifiable',
      });
    }
  });

  it('an entry for a DIFFERENT filename never satisfies the selected asset', async () => {
    windowsUA();
    const sums = `${A}  Fress_1.0.7-alpha_arm64-setup.exe\n${A}  ./Fress_1.0.7-alpha_x64-setup.exe\n`;
    const { fetchMock } = sumsServingApi([sums]);
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const res = await checkForUpdate('1.0.6-beta');
    expect(res.kind).toBe('available');
    if (res.kind === 'available') expect(res.expectedSha256).toBeNull();
  });

  it('a retry performs an ACTUAL fresh checksum lookup, not a cached answer', async () => {
    windowsUA();
    // First check sees A; the manifest then "changes" to B. A second check
    // must observe B (fresh lookup), and the document must be fetched twice.
    const { fetchMock, getSumsCalls } = sumsServingApi([`${A}  ${ASSET}`, `${B}  ${ASSET}`]);
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const first = await checkForUpdate('1.0.6-beta');
    expect(first.kind).toBe('available');
    if (first.kind === 'available') expect(first.expectedSha256).toBe(A);
    const second = await checkForUpdate('1.0.6-beta');
    expect(second.kind).toBe('available');
    if (second.kind === 'available') expect(second.expectedSha256).toBe(B);
    expect(getSumsCalls()).toBe(2);
  });
});
