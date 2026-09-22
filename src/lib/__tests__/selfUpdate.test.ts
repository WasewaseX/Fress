import { describe, expect, it } from 'vitest';

import {
  compareVersions,
  parseVersion,
  releaseMatchesChannel,
} from '../selfUpdate';

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
