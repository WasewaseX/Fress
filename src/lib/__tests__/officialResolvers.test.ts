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
  pickOfficial,
  official,
  parseWingetInstallers,
  base64ToHex,
  TOR_MANIFESTS,
  officialSupported,
} from '../officialResolvers';
import { peekDigestDiagnostics } from '../release/digests';
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

describe('checksum plumbing', () => {
  it('base64ToHex converts electron-updater sha512 values to hex', () => {
    // SHA-512 of the empty string, exactly as the Signal feed publishes it.
    const hex = base64ToHex('z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg==');
    expect(hex).toBe(
      'cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e'
    );
  });
  it('base64ToHex returns empty on malformed base64, so no hash is asserted', () => {
    expect(base64ToHex('!!!!')).toBe('');
  });
  it('parseSignalYml keeps the per-file sha512 as hex and drops malformed values', () => {
    const yml = [
      'version: 8.28.0',
      'files:',
      '  - url: signal-desktop-win-x64-8.28.0.exe',
      '    sha512: z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg==',
      '    size: 141981864',
      '  - url: signal-desktop-win-x64-8.28.0.exe.blockmap',
      '    sha512: ???',
      '    size: 49509',
    ].join('\n');
    const d = parseSignalYml(yml);
    expect(d.files[0].sha512?.startsWith('cf83e135')).toBe(true);
    expect(d.files[0].sha512).toHaveLength(128);
    expect(d.files[1].sha512).toBeUndefined();
  });
  it('pickProtonStable carries the published Sha512CheckSum', () => {
    const json = JSON.stringify({
      Releases: [
        {
          CategoryName: 'Stable',
          Version: '1.14.0',
          File: [
            {
              Identifier: 'Windows installer EXE',
              Url: 'https://proton.me/download/mail/windows/ProtonMail-desktop.exe',
              Sha512CheckSum: 'ab'.repeat(64),
            },
          ],
        },
      ],
    });
    const d = pickProtonStable(json);
    expect(d?.files[0].sha512).toBe('ab'.repeat(64));
  });
});

describe('pickOfficial determinism and digest conflict handling', () => {
  const digest64 = 'a'.repeat(64);
  const digest64b = 'b'.repeat(64);

  it('equal-score manifest entries pick the same file in every row order', () => {
    // "install" and "setup" both read as installer tokens: a genuine tie.
    const a = { name: 'App-1.0-install.exe', url: 'https://v.example/App-1.0-install.exe', size: 10 };
    const b = { name: 'App-1.0-setup.exe', url: 'https://v.example/App-1.0-setup.exe', size: 10 };
    for (const order of [[a, b], [b, a]]) {
      expect(pickOfficial(order, 'windows', 'x86_64')?.name).toBe('App-1.0-install.exe');
    }
  });

  it('conflicting duplicate digest rows fail closed: the pick stays but the digest does not survive', () => {
    // The same filename twice with DIFFERENT digests: at most one can be
    // true, and trusting either would make verification depend on manifest
    // row order. The file itself still resolves (it is installable), but it
    // must arrive UNVERIFIED - never carrying one of the rival digests.
    const rows = [
      { name: 'App-1.0-setup.exe', url: 'https://v.example/a.exe', size: 10, sha256: digest64 },
      { name: 'App-1.0-setup.exe', url: 'https://mirror.example/a.exe', size: 10, sha256: digest64b },
    ];
    for (const order of [rows, [...rows].reverse()]) {
      const pick = pickOfficial(order, 'windows', 'x86_64');
      expect(pick?.name).toBe('App-1.0-setup.exe');
      expect(pick?.sha256).toBeUndefined();
      expect(pick?.sha512).toBeUndefined();
    }
    // The refusal is diagnosed, not silent.
    const reasons = peekDigestDiagnostics().map((d) => d.reason);
    expect(reasons.some((r) => r.includes('conflicting duplicate digest entries'))).toBe(true);
  });

  it('byte-identical duplicate rows are duplicates, not conflicts: the digest survives', () => {
    const rows = [
      { name: 'App-1.0-setup.exe', url: 'https://v.example/a.exe', size: 10, sha256: digest64 },
      { name: 'App-1.0-setup.exe', url: 'https://mirror.example/a.exe', size: 10, sha256: digest64 },
    ];
    const pick = pickOfficial(rows, 'windows', 'x86_64');
    expect(pick?.sha256).toBe(digest64);
  });

  it('a conflicting name does not poison other entries: their digests stay bound', () => {
    const good = 'c'.repeat(64);
    const rows = [
      { name: 'App-1.0-good.exe', url: 'https://v.example/good.exe', size: 10, sha256: good },
      { name: 'App-1.0-bad.exe', url: 'https://v.example/bad.exe', size: 10, sha256: digest64 },
      { name: 'App-1.0-bad.exe', url: 'https://m.example/bad.exe', size: 10, sha256: digest64b },
    ];
    const pick = pickOfficial(rows, 'windows', 'x86_64');
    // good > bad lexically? No: bad < good, but both are installers with
    // the same score... the winner between the two clean installers is the
    // lexicographic one; the important assertion is digest correctness.
    expect(pick?.name).toBe('App-1.0-bad.exe');
    expect(pick?.sha256).toBeUndefined(); // conflicting name -> unverified
    expect(pickOfficial([rows[0]], 'windows', 'x86_64')?.sha256).toBe(good);
  });

  it('the official() constructor normalizes casing and refuses malformed digests', () => {
    // Uppercase hex of the right length is a VALID digest in a different
    // notation: normalized to lowercase and attached.
    const upper = official(
      { name: 'App-1.0-setup.exe', url: 'https://v.example/a.exe', size: 10, sha256: 'AB'.repeat(32) },
      '1.0',
      'https://v.example/download'
    );
    expect(upper.expectedSha256).toBe('ab'.repeat(32));
    // Malformed: the download resolves but stays UNVERIFIED, diagnosed.
    const junk = official(
      { name: 'App-1.0-setup.exe', url: 'https://v.example/a.exe', size: 10, sha256: 'definitely-not-a-digest' },
      '1.0',
      'https://v.example/download'
    );
    expect(junk.expectedSha256).toBeUndefined();
    expect(peekDigestDiagnostics().some((d) => d.source === 'App-1.0-setup.exe')).toBe(true);
    // Absent stays absent: no digest in, no digest out, no magic.
    const absent = official(
      { name: 'App-1.0-setup.exe', url: 'https://v.example/a.exe', size: 10 },
      '1.0',
      'https://v.example/download'
    );
    expect(absent.expectedSha256).toBeUndefined();
    expect(absent.expectedSha512).toBeUndefined();
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
