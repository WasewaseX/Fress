// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { describe, expect, it } from 'vitest';

import { formatBytes, formatEta, formatSpeed } from '../format';
import { pickOwnAsset } from '../selfUpdate';
import type { OwnRelease } from '../selfUpdate';

describe('formatBytes', () => {
  it('formats the common download sizes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(1.5 * 1024 * 1024 * 1024)).toBe('1.5 GB');
  });
});

describe('formatSpeed / formatEta', () => {
  it('formats speeds through formatBytes', () => {
    expect(formatSpeed(1024 * 1024)).toBe('1.0 MB/s');
  });

  it('formats the countdown the download panel shows', () => {
    expect(formatEta(0)).toBe('');
    expect(formatEta(-5)).toBe('');
    expect(formatEta(Infinity)).toBe('');
    expect(formatEta(45)).toBe('45s left');
    expect(formatEta(125)).toBe('2m 5s left');
    expect(formatEta(7200)).toBe('2h 0m left');
  });
});

describe('pickOwnAsset, Fress picking its own update file', () => {
  const release = (names: string[]): OwnRelease => ({
    tag: 'v1.0.2-alpha',
    version: '1.0.2-alpha',
    publishedAt: '2026-09-22T00:00:00Z',
    htmlUrl: 'https://github.com/WasewaseX/Fress/releases/tag/v1.0.2-alpha',
    assets: names.map((name) => ({ name, size: 1000, url: `https://example.com/${name}` })),
  });

  it('prefers the setup exe on Windows, never the msi/zip side files', () => {
    // No navigator in Node 20 CI: pickOwnAsset falls back to the 'windows'
    // platform branch, which is exactly the branch under test here.
    const asset = pickOwnAsset(release([
      'Fress_1.0.2-alpha_x64_en-US.msi',
      'Fress_1.0.2-alpha_arm64-setup.exe',
      'Fress_1.0.2-alpha_x64-setup.exe',
      'Fress_1.0.2-alpha_x64-portable.zip',
      'SHA256SUMS.txt',
    ]));
    expect(asset?.name).toBe('Fress_1.0.2-alpha_x64-setup.exe');
  });

  it('skips junk assets entirely', () => {
    const asset = pickOwnAsset(release(['SHA256SUMS.txt', 'Fress_1.0.2-alpha_x64-setup.exe.blockmap']));
    expect(asset).toBeNull();
  });
});
