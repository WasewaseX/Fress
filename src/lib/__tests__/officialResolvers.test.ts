// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { describe, it, expect } from 'vitest';
import {
  hrefs,
  parseVersion,
  newestVersion,
  versionFromName,
  parseSignalYml,
  pickProtonStable,
  parseWingetInstallers,
  TOR_MANIFESTS,
  officialSupported,
} from '../officialResolvers';
import { INITIAL_APPS } from '../../data/appsData';

describe('parseVersion', () => {
  it('splits numeric versions', () => {
    expect(parseVersion('5.3.2.1')).toEqual([5, 3, 2, 1]);
    expect(parseVersion('26.08')).toEqual([26, 8]);
    expect(parseVersion('v3.0.24/')).toEqual([3, 0, 24]);
  });
  it('rejects non-numeric noise', () => {
    expect(parseVersion('Blender4.5')).toBeNull();
    expect(parseVersion('latest')).toBeNull();
  });
});

describe('newestVersion', () => {
  it('compares numerically, not lexically', () => {
    expect(newestVersion(['26.08', '5.9', '25.8'])).toBe('26.08');
    expect(newestVersion(['5.3.4', '6.0.2.1', '5.10'])).toBe('6.0.2.1');
    expect(newestVersion(['3.0.21', '3.0.24'])).toBe('3.0.24');
  });
  it('ignores junk entries and returns null for none', () => {
    expect(newestVersion(['Blender1.0/', 'bogus'])).toBeNull();
    expect(newestVersion([])).toBeNull();
  });
  it('picks the newest Blender-style directory number', () => {
    expect(newestVersion(['1.60', '4.5', '2.93', '4.10'])).toBe('4.10');
  });
});

describe('versionFromName', () => {
  it('extracts the first dotted version', () => {
    expect(versionFromName('vlc-3.0.24-win64.exe')).toBe('3.0.24');
    expect(versionFromName('ProtonVPN_v5.1.8_x64.exe')).toBe('5.1.8');
    expect(versionFromName('installer')).toBe('');
  });
});

describe('hrefs', () => {
  it('extracts and dedupes hrefs, unescaping entities', () => {
    const html = '<a href="a.exe">x</a><a href="a.exe">y</a><a href="b&amp;c.exe">z</a>';
    expect(hrefs(html)).toEqual(['a.exe', 'b&c.exe']);
  });
});

describe('parseSignalYml', () => {
  it('reads version and file list from the electron-updater feed', () => {
    const yml = [
      'version: 8.28.0',
      'files:',
      '  - url: signal-desktop-win-x64-8.28.0.exe',
      '    sha512: abc',
      '    size: 141981864',
      '  - url: signal-desktop-win-x64-8.28.0.exe.blockmap',
      '    sha512: def',
      '    size: 49509',
      'path: signal-desktop-win-x64-8.28.0.exe',
      'sha512: abc',
      'releaseDate: 2026-09-01',
    ].join('\n');
    const d = parseSignalYml(yml);
    expect(d.version).toBe('8.28.0');
    expect(d.files).toHaveLength(2);
    expect(d.files[0]).toEqual({ url: 'signal-desktop-win-x64-8.28.0.exe', size: 141981864 });
  });
});

describe('pickProtonStable', () => {
  it('skips EarlyAccess and takes the Stable channel', () => {
    const json = JSON.stringify({
      Releases: [
        {
          CategoryName: 'EarlyAccess',
          Version: '1.15.0',
          File: [{ Identifier: 'Windows installer EXE', Url: 'https://proton.me/download/mail/windows/beta.exe' }],
        },
        {
          CategoryName: 'Stable',
          Version: '1.14.0',
          File: [
            { Identifier: 'Windows installer EXE', Url: 'https://proton.me/download/mail/windows/ProtonMail-desktop.exe' },
            { Identifier: 'Deb package', Url: 'https://proton.me/download/mail/linux/1.14.0/ProtonMail-desktop-beta.deb' },
          ],
        },
      ],
    });
    const d = pickProtonStable(json);
    expect(d?.version).toBe('1.14.0');
    expect(d?.files).toHaveLength(2);
    expect(d?.files[0].url).toContain('ProtonMail-desktop.exe');
  });
  it('returns null on garbage or missing version', () => {
    expect(pickProtonStable('not json')).toBeNull();
    expect(pickProtonStable('{"Releases": []}')).toBeNull();
  });
});

describe('parseWingetInstallers', () => {
  it('pairs Architecture with the InstallerUrl that follows it', () => {
    const yaml = [
      'Installers:',
      '  - InstallerLocale: en-US',
      '    Architecture: x64',
      '    InstallerType: exe',
      '    InstallerUrl: https://media.inkscape.org/media/resources/file/12ab/Inkscape-1.4.4-x64.exe',
      '    InstallerSha256: abc',
      '  - Architecture: arm64',
      '    InstallerType: exe',
      '    InstallerUrl: https://media.inkscape.org/media/resources/file/34cd/Inkscape-1.4.4-arm64.exe',
    ].join('\n');
    const files = parseWingetInstallers(yaml);
    expect(files).toHaveLength(2);
    expect(files[0].name).toBe('Inkscape-1.4.4-x64.exe');
    expect(files[1].name).toBe('Inkscape-1.4.4-arm64.exe');
    expect(files.every((f) => f.url.startsWith('https://media.inkscape.org/'))).toBe(true);
  });
});

describe('TOR_MANIFESTS', () => {
  it('maps every known device ABI to its own manifest', () => {
    expect(TOR_MANIFESTS['windows|x86_64']).toBe('download-windows-x86_64.json');
    expect(TOR_MANIFESTS['android|arm64']).toBe('download-android-aarch64.json');
    expect(TOR_MANIFESTS['android|arm']).toBe('download-android-armv7.json');
    expect(TOR_MANIFESTS['android|unknown']).toBeUndefined();
    expect(TOR_MANIFESTS['linux|aarch64']).toBe('download-linux-aarch64.json');
  });
});

describe('officialSupported', () => {
  it('covers every catalog app that ships no GitHub-resolvable platform', () => {
    const byId = new Map(INITIAL_APPS.map((a) => [a.id, a]));
    // Vendor-manifest resolvers (desktop outside GitHub).
    expect(officialSupported(byId.get('vlc')!, 'windows')).toBe(true);
    expect(officialSupported(byId.get('vlc')!, 'mac')).toBe(true);
    expect(officialSupported(byId.get('vlc')!, 'linux')).toBe(false);
    expect(officialSupported(byId.get('signal')!, 'windows')).toBe(true);
    expect(officialSupported(byId.get('signal')!, 'android')).toBe(true);
    expect(officialSupported(byId.get('tor-browser')!, 'android')).toBe(true);
    expect(officialSupported(byId.get('proton-mail')!, 'mac')).toBe(true);
    expect(officialSupported(byId.get('zotero')!, 'linux')).toBe(true);
    expect(officialSupported(byId.get('nextcloud')!, 'mac')).toBe(true);
    expect(officialSupported(byId.get('element')!, 'mac')).toBe(true);
    expect(officialSupported(byId.get('librewolf')!, 'windows')).toBe(true);
    expect(officialSupported(byId.get('sumatra')!, 'windows')).toBe(true);
    expect(officialSupported(byId.get('gimp')!, 'mac')).toBe(true);
    expect(officialSupported(byId.get('blender')!, 'linux')).toBe(true);
    expect(officialSupported(byId.get('krita')!, 'windows')).toBe(true);
    expect(officialSupported(byId.get('krita')!, 'linux')).toBe(false);
    expect(officialSupported(byId.get('kdenlive')!, 'linux')).toBe(true);
    expect(officialSupported(byId.get('libreoffice')!, 'linux')).toBe(true);
    expect(officialSupported(byId.get('inkscape')!, 'windows')).toBe(true);
  });
});
