// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { describe, expect, it } from 'vitest';

import {
  androidDeviceAbi,
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

  it('prefers the device ABI apk over universal on arm64 (smaller, optimized)', () => {
    const pick = pickAsset(
      [asset('Tool_2.1_api26-arm64-v8a.apk'), asset('Tool_2.1_PlayStore.apk'), asset('Tool_2.1_universal.apk')],
      'android',
      'aarch64'
    );
    expect(pick?.name).toBe('Tool_2.1_api26-arm64-v8a.apk');
  });

  it('never hands an arm64 apk to an x86_64 Android device (universal wins)', () => {
    // The arch-blind scoring ranked arm64 (5) above everything except
    // universal markers it happened to recognize - an x86_64 device got a
    // file that cannot install.
    const pick = pickAsset(
      [asset('Tool_2.1_arm64-v8a.apk'), asset('Tool_2.1_universal.apk')],
      'android',
      'x86_64'
    );
    expect(pick?.name).toBe('Tool_2.1_universal.apk');
  });

  it('never hands an arm64 apk to an ARMv7 device (the arm split wins)', () => {
    const pick = pickAsset(
      [asset('Tool_2.1_arm64-v8a.apk'), asset('Fress_1.0.4-alpha_arm.apk')],
      'android',
      'arm'
    );
    expect(pick?.name).toBe('Fress_1.0.4-alpha_arm.apk');
  });

  it('picks the x86_64 apk on an x86_64 Android device, not arm64', () => {
    const pick = pickAsset(
      [asset('Tool_2.1_arm64-v8a.apk'), asset('Tool_2.1_x86_64.apk')],
      'android',
      'x86_64'
    );
    expect(pick?.name).toBe('Tool_2.1_x86_64.apk');
  });

  it('an arm64 device can still fall back to the universal apk', () => {
    const pick = pickAsset([asset('Tool_2.1_universal.apk')], 'android', 'aarch64');
    expect(pick?.name).toBe('Tool_2.1_universal.apk');
  });

  it('an unknown device ABI is not a disguised x86_64', () => {
    expect(androidDeviceAbi(undefined)).toBe('unknown');
    expect(androidDeviceAbi('')).toBe('unknown');
    expect(androidDeviceAbi('weird')).toBe('unknown');
    expect(androidDeviceAbi('aarch64')).toBe('arm64');
    expect(androidDeviceAbi('x86_64')).toBe('x86_64');
  });

  it('a browser without arch info (reduced UA) gets universal, never a split it cannot install', () => {
    // arch undefined = the browser fallback could not determine the ABI.
    // The old x86_64 guess made ARM phones pick x86_64-only apks.
    const pick = pickAsset(
      [asset('App_1.0_arm64-v8a.apk'), asset('App_1.0_x86_64.apk'), asset('App_1.0_universal.apk')],
      'android',
      undefined
    );
    expect(pick?.name).toBe('App_1.0_universal.apk');
  });

  it('an unknown-ABI browser is offered nothing when only ABI splits exist (releases page instead)', () => {
    const pick = pickAsset(
      [asset('App_1.0_arm64-v8a.apk'), asset('App_1.0_x86_64.apk')],
      'android',
      undefined
    );
    expect(pick).toBeNull();
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
