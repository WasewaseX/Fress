// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { describe, expect, it } from 'vitest';

import {
  cleanVersion,
  parseGithubRepo,
  pickAsset,
  pickAssetDetailed,
} from '../releaseFetch';
import type { ReleaseAsset } from '../releaseFetch';

const asset = (name: string, size = 10_000): ReleaseAsset => ({ name, size, downloadUrl: `https://example.com/${name}` });

describe('parseGithubRepo', () => {
  it('extracts owner/repo from common URL shapes', () => {
    expect(parseGithubRepo('https://github.com/localsend/localsend')).toBe('localsend/localsend');
    expect(parseGithubRepo('https://github.com/localsend/localsend/releases')).toBe('localsend/localsend');
    expect(parseGithubRepo('https://github.com/localsend/localsend.git')).toBe('localsend/localsend');
    expect(parseGithubRepo('https://gitlab.com/librewolf-community/browser/bsys6')).toBeNull();
    expect(parseGithubRepo(undefined)).toBeNull();
  });
});

describe('cleanVersion', () => {
  it('strips common tag prefixes', () => {
    expect(cleanVersion('v1.2.3')).toBe('1.2.3');
    expect(cleanVersion('ver4.5')).toBe('4.5');
    expect(cleanVersion('2026.09.01')).toBe('2026.09.01');
  });
});

describe('pickAsset — heuristic selection', () => {
  it('picks the x64 setup exe on x86_64 Windows, not the arm64 one', () => {
    const pick = pickAsset(
      [asset('Tool-2.1-arm64-setup.exe'), asset('Tool-2.1-x64-setup.exe'), asset('Tool-2.1.msi')],
      'windows',
      'x86_64'
    );
    expect(pick?.name).toBe('Tool-2.1-x64-setup.exe');
  });

  it('picks the arm64 exe on aarch64 Windows', () => {
    const pick = pickAsset(
      [asset('Tool-2.1-arm64-setup.exe'), asset('Tool-2.1-x64-setup.exe')],
      'windows',
      'aarch64'
    );
    expect(pick?.name).toBe('Tool-2.1-arm64-setup.exe');
  });

  it('picks the apple silicon dmg on aarch64 mac', () => {
    const pick = pickAsset(
      [asset('Tool-2.1-intel.dmg'), asset('Tool-2.1-arm64.dmg'), asset('Tool-2.1-win.exe')],
      'mac',
      'aarch64'
    );
    expect(pick?.name).toBe('Tool-2.1-arm64.dmg');
  });

  it('prefers universal and arm64 apks over play-store flavors', () => {
    const pick = pickAsset(
      [asset('Tool_2.1_api26-arm64-v8a.apk'), asset('Tool_2.1_PlayStore.apk'), asset('Tool_2.1_universal.apk')],
      'android',
      'aarch64'
    );
    expect(pick?.name).toBe('Tool_2.1_universal.apk');
  });

  it('prefers appimage over deb/rpm on linux', () => {
    const pick = pickAsset(
      [asset('tool_2.1_amd64.deb'), asset('tool-2.1-x86_64.AppImage'), asset('tool-2.1.x86_64.rpm')],
      'linux',
      'x86_64'
    );
    expect(pick?.name).toBe('tool-2.1-x86_64.AppImage');
  });

  it('never picks checksums, blockmaps, sigs or latest.json', () => {
    const pick = pickAsset(
      [
        asset('tool-setup.exe.blockmap'),
        asset('tool-setup.exe.sig'),
        asset('SHA256SUMS.txt'),
        asset('latest.json'),
        asset('tool-setup.exe'),
      ],
      'windows',
      'x86_64'
    );
    expect(pick?.name).toBe('tool-setup.exe');
  });
});

describe('pickAssetDetailed — override and confidence', () => {
  it('an assetPatterns override outranks the heuristic', () => {
    const res = pickAssetDetailed(
      [asset('weird-name-x64.zip'), asset('ToolSetup.exe'), asset('ToolSetup.arm64.exe')],
      'windows',
      'x86_64',
      { windows: '^weird-name-x64\\.zip$' }
    );
    expect(res?.matchedBy).toBe('override');
    expect(res?.pick.name).toBe('weird-name-x64.zip');
    expect(res?.weak).toBe(false);
  });

  it('an override that matches nothing falls through to the heuristic', () => {
    const res = pickAssetDetailed(
      [asset('ToolSetup.exe')],
      'windows',
      'x86_64',
      { windows: '^does-not-exist\\.exe$' }
    );
    expect(res?.matchedBy).toBe('heuristic');
    expect(res?.pick.name).toBe('ToolSetup.exe');
  });

  it('an invalid override regex never kills the download path', () => {
    const res = pickAssetDetailed([asset('ToolSetup.exe')], 'windows', 'x86_64', { windows: '(' });
    expect(res?.pick.name).toBe('ToolSetup.exe');
  });

  it('flags weak heuristic picks instead of presenting them as sure', () => {
    // A bare .tar.gz on linux scores 1: the only candidate, but odd.
    const res = pickAssetDetailed([asset('tool-2.1.tar.gz')], 'linux', 'x86_64');
    expect(res?.pick.name).toBe('tool-2.1.tar.gz');
    expect(res?.matchedBy).toBe('heuristic');
    expect(res?.weak).toBe(true);
  });

  it('a solid heuristic pick is not weak', () => {
    const res = pickAssetDetailed([asset('tool-2.1-x86_64.AppImage')], 'linux', 'x86_64');
    expect(res?.weak).toBe(false);
  });
});
