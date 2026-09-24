// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { describe, expect, it } from 'vitest';

import {
  androidAssetFlags,
  androidDeviceAbi,
  assetCompatibleWithDevice,
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

describe('pickAsset, heuristic selection', () => {
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

  // Regression matrix for "unknown device => universal ONLY": an unmarked
  // apk used to be accepted before the unknown check, so a generic
  // Fress_1.0.7_release.apk could win for a device whose ABI is exactly
  // the unknown we needed to resolve.
  describe('unknown device => universal only (never an unmarked gamble)', () => {
    it('unknown + generic unmarked apk => null', () => {
      expect(pickAsset([asset('Fress_1.0.7_release.apk')], 'android', undefined)).toBeNull();
    });

    it('unknown + gradle arm64 split named app-arm64-release.apk => null (never "universal" via ^app-)', () => {
      // The old universal rule (/universal|^app-|/) classified this as
      // universal just for starting with "app-".
      expect(pickAsset([asset('app-arm64-release.apk')], 'android', undefined)).toBeNull();
    });

    it('unknown + app-release.apk => null unless explicitly classified universal', () => {
      expect(pickAsset([asset('app-release.apk')], 'android', undefined)).toBeNull();
      expect(androidAssetFlags('app-release.apk').universal).toBe(false);
    });

    it('unknown + real universal apk => the universal apk', () => {
      expect(pickAsset([asset('Fress_1.0.7_universal.apk')], 'android', undefined)?.name).toBe(
        'Fress_1.0.7_universal.apk'
      );
      // gradle's raw universal name still classifies as universal
      expect(androidAssetFlags('app-universal-release.apk').universal).toBe(true);
    });

    it('unknown + unmarked apk beside a real universal => universal wins', () => {
      const pick = pickAsset(
        [asset('Fress_1.0.7_release.apk'), asset('Fress_1.0.7_universal.apk')],
        'android',
        undefined
      );
      expect(pick?.name).toBe('Fress_1.0.7_universal.apk');
    });

    it('a KNOWN device may still gamble on an unmarked apk (below universal, above nothing)', () => {
      // Unmarked apks remain a deliberate low-ranked fallback for devices
      // whose ABI is known - only the unknown path became universal-only.
      expect(pickAsset([asset('Fress_1.0.7_release.apk')], 'android', 'x86_64')?.name).toBe(
        'Fress_1.0.7_release.apk'
      );
    });
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

describe('pickAssetDetailed, override and confidence', () => {
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

  // Architecture compatibility is a HARD constraint that neither the
  // heuristic nor an assetPatterns override can bypass: an override is the
  // naming authority, never a license to declare an impossible
  // architecture installable.
  describe('hard architecture gate (heuristic AND override)', () => {
    it('an override pinning an arm64 split cannot serve it to an unknown-ABI browser', () => {
      // The override matches the split, but the gate drops it and the
      // fall-through heuristic refuses it too => null (releases page).
      const res = pickAssetDetailed(
        [asset('Fress_1.0.7_arm64.apk')],
        'android',
        undefined,
        { android: 'arm64' }
      );
      expect(res).toBeNull();
    });

    it('an override with a universal AND a split on an unknown device picks the universal', () => {
      const res = pickAssetDetailed(
        [asset('Fress_1.0.7_arm64.apk'), asset('Fress_1.0.7_universal.apk')],
        'android',
        undefined,
        { android: 'apk$' }
      );
      expect(res?.matchedBy).toBe('override');
      expect(res?.pick.name).toBe('Fress_1.0.7_universal.apk');
    });

    it('an override pinning a wrong-ABI split on a KNOWN device falls through to the right file', () => {
      const res = pickAssetDetailed(
        [asset('Tool_2.1_arm64.apk'), asset('Tool_2.1_x64.apk')],
        'android',
        'x86_64',
        { android: 'arm64' }
      );
      // The arm64 override match is gate-dropped; nothing else matches the
      // pattern, so the heuristic picks the x64 file.
      expect(res?.matchedBy).toBe('heuristic');
      expect(res?.pick.name).toBe('Tool_2.1_x64.apk');
    });

    it('an x86_64 Windows machine is never handed an arm64-only installer (heuristic)', () => {
      // Used to stay pickable at a weak positive score when it was the
      // only exe; now refused outright.
      expect(pickAsset([asset('Tool-2.1-arm64-setup.exe')], 'windows', 'x86_64')).toBeNull();
      // With a compatible exe present, the compatible one wins.
      expect(
        pickAsset([asset('Tool-2.1-arm64-setup.exe'), asset('Tool-2.1-x64-setup.exe')], 'windows', 'x86_64')?.name
      ).toBe('Tool-2.1-x64-setup.exe');
    });

    it('a 32-bit Windows host gets nothing marked arm64 or x64', () => {
      expect(pickAsset([asset('Tool-2.1-x64-setup.exe')], 'windows', 'x86')).toBeNull();
      expect(pickAsset([asset('Tool-2.1-arm64-setup.exe')], 'windows', 'i686')).toBeNull();
    });

    it('an Intel Mac is never handed an arm64-only dmg; Apple Silicon keeps Rosetta for Intel builds', () => {
      expect(pickAsset([asset('Tool-2.1-arm64.dmg')], 'mac', 'x86_64')).toBeNull();
      expect(pickAsset([asset('Tool-2.1-intel.dmg')], 'mac', 'aarch64')?.name).toBe('Tool-2.1-intel.dmg');
    });

    it('an ARM64 Linux machine gets NOTHING from an x86_64-only release (heuristic, was confident pick)', () => {
      // Used to score 7-2=5: confidently handed a non-runnable AppImage.
      expect(pickAsset([asset('tool-2.1-x86_64.AppImage')], 'linux', 'aarch64')).toBeNull();
      expect(pickAsset([asset('tool-2.1_amd64.deb')], 'linux', 'arm')).toBeNull();
    });

    it('an x86_64 Linux machine is never handed an arm build', () => {
      expect(pickAsset([asset('tool-2.1-arm64.AppImage')], 'linux', 'x86_64')).toBeNull();
    });

    it('a 32-bit x86 Linux host cannot run 64-bit-only builds', () => {
      expect(pickAsset([asset('tool-2.1-x86_64.AppImage')], 'linux', 'i686')).toBeNull();
    });

    it('compatible picks are unaffected by the gate', () => {
      // x86 apks run on x86_64 devices (32-bit compat), armv7 apks run on
      // arm64 devices, WoA runs x64 installers through emulation.
      expect(pickAsset([asset('Tool_2.1_x86.apk')], 'android', 'x86_64')?.name).toBe('Tool_2.1_x86.apk');
      expect(pickAsset([asset('Tool_2.1_arm.apk')], 'android', 'aarch64')?.name).toBe('Tool_2.1_arm.apk');
      expect(pickAsset([asset('Tool-2.1-x64-setup.exe')], 'windows', 'aarch64')?.name).toBe(
        'Tool-2.1-x64-setup.exe'
      );
    });

    it('the gate is exported so tests and future callers share one source of truth', () => {
      expect(assetCompatibleWithDevice('Fress_1.0.7_universal.apk', 'android', undefined)).toBe(true);
      expect(assetCompatibleWithDevice('Fress_1.0.7_arm64.apk', 'android', undefined)).toBe(false);
      expect(assetCompatibleWithDevice('Tool-2.1-arm64-setup.exe', 'windows', 'x86_64')).toBe(false);
      expect(assetCompatibleWithDevice('Tool-2.1-x64-setup.exe', 'windows', 'x86_64')).toBe(true);
      expect(assetCompatibleWithDevice('Tool-2.1-arm64.dmg', 'mac', 'x86_64')).toBe(false);
      expect(assetCompatibleWithDevice('tool-2.1-x86_64.AppImage', 'linux', 'aarch64')).toBe(false);
      // Unknown arch outside Android: nothing is proven, gate stays open.
      expect(assetCompatibleWithDevice('Tool-2.1-setup.exe', 'windows', undefined)).toBe(true);
    });
  });

  describe('hyphenated arch markers and CLI companions (v1.0.7-beta regressions)', () => {
    const localSendAssets = [
      'LocalSend-1.18.2-windows-x86-64-unsigned.exe',
      'LocalSend-1.18.2-windows-x86-64.exe',
      'LocalSend-1.18.2-windows-x86-64.zip',
      'LocalSend-1.18.2-windows-arm-64.zip',
      'LocalSend-CLI-1.18.2-windows-arm-64.exe',
      'LocalSend-CLI-1.18.2-windows-x86-64.exe',
      'LocalSend-1.18.2.dmg',
    ].map((n) => asset(n));

    it('on an ARM64 Windows host the real app wins over the CLI tool (was: CLI won)', () => {
      // The reported bug: hyphenated "arm-64" evaded the arm64 regexes, so
      // the CLI exe read as "unmarked + arm bonus" and beat the GUI app,
      // whose "x86-64" name was even penalized as 32-bit.
      expect(pickAsset(localSendAssets, 'windows', 'aarch64')?.name).toBe('LocalSend-1.18.2-windows-x86-64.exe');
    });

    it('on x86_64 Windows the signed installer wins over the unsigned one', () => {
      expect(pickAsset(localSendAssets, 'windows', 'x86_64')?.name).toBe('LocalSend-1.18.2-windows-x86-64.exe');
    });

    it('-cli- companions are never the pick, but "client"/"click" are not CLI', () => {
      const withCli = [asset('App-1.0-x64-setup.exe'), asset('App-CLI-1.0-x64.exe')];
      expect(pickAsset(withCli, 'windows', 'x86_64')?.name).toBe('App-1.0-x64-setup.exe');
      expect(pickAsset([asset('AppClient-1.0-x64-setup.exe')], 'windows', 'x86_64')?.name).toBe(
        'AppClient-1.0-x64-setup.exe'
      );
    });

    it('hyphenated arm-64 installers are hard-gated like arm64 (never served to x64)', () => {
      expect(assetCompatibleWithDevice('Tool-1.0-arm-64-setup.exe', 'windows', 'x86_64')).toBe(false);
      expect(pickAsset([asset('Tool-1.0-arm-64-setup.exe')], 'windows', 'x86_64')).toBeNull();
      // ...and are correctly recognized on the ARM host (WoA emulation aside).
      expect(pickAsset([asset('Tool-1.0-arm-64-setup.exe')], 'windows', 'aarch64')?.name).toBe(
        'Tool-1.0-arm-64-setup.exe'
      );
    });

    it('hyphenated x86-64 is 64-bit, not a 32-bit marker', () => {
      // 32-bit Windows host cannot run it (it IS x64), an ARM64 host can.
      expect(assetCompatibleWithDevice('Tool-1.0-x86-64-setup.exe', 'windows', 'x86')).toBe(false);
      expect(assetCompatibleWithDevice('Tool-1.0-x86-64-setup.exe', 'windows', 'aarch64')).toBe(true);
      // Android ABI classification agrees (v8a/arm-64 style names).
      expect(androidAssetFlags('app-arm-64-release.apk').arm64).toBe(true);
      expect(androidAssetFlags('app-arm-64-release.apk').arm32).toBe(false);
    });
  });
});
