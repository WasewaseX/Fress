// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
/**
 * Deterministic fixtures for the E2E + perf suites.
 *
 * Everything here is fixed: no Date.now() in generated content, seeded PRNG
 * for the large catalog, fixed release payloads. The same seed must produce
 * byte-identical catalogs on every machine (CI screenshots depend on it).
 */

import type { AppItem } from '../../../src/types';

/** The anchor app used across resolver/download workflows (shipped catalog). */
export const ANCHOR_APP = {
  id: 'localsend',
  name: 'LocalSend',
  repo: 'localsend/localsend',
  githubUrl: 'https://github.com/localsend/localsend',
};

export interface GhReleaseFixture {
  tag: string;
  name: string;
  published_at: string;
  html_url: string;
  prerelease?: boolean;
  assets: Array<{ name: string; size: number; download_url: string }>;
}

/** LocalSend release list: v1.17.0 stable with a confident Windows exe. */
export const RELEASES_LOCALSEND: GhReleaseFixture[] = [
  {
    tag: 'v1.17.0',
    name: 'LocalSend 1.17.0',
    published_at: '2025-11-02T10:00:00Z',
    html_url: 'https://github.com/localsend/localsend/releases/tag/v1.17.0',
    assets: [
      {
        name: 'LocalSend-1.17.0-windows-x64.exe',
        size: 25_165_824,
        download_url: 'https://github.com/localsend/localsend/releases/download/v1.17.0/LocalSend-1.17.0-windows-x64.exe',
      },
      {
        name: 'LocalSend-1.17.0-windows-x86.exe',
        size: 24_117_248,
        download_url: 'https://github.com/localsend/localsend/releases/download/v1.17.0/LocalSend-1.17.0-windows-x86.exe',
      },
      {
        name: 'LocalSend-1.17.0.zip',
        size: 30_000_000,
        download_url: 'https://github.com/localsend/localsend/releases/download/v1.17.0/LocalSend-1.17.0.zip',
      },
    ],
  },
  {
    tag: 'v1.16.0',
    name: 'LocalSend 1.16.0',
    published_at: '2025-09-14T10:00:00Z',
    html_url: 'https://github.com/localsend/localsend/releases/tag/v1.16.0',
    assets: [
      {
        name: 'LocalSend-1.16.0-windows-x64.exe',
        size: 24_000_000,
        download_url: 'https://github.com/localsend/localsend/releases/download/v1.16.0/LocalSend-1.16.0-windows-x64.exe',
      },
    ],
  },
];

/** The trusted SHA-256 the Workflow D checksum scenarios verify against.
 * sha256('fress-deterministic-payload\n') - a fixed, known digest. */
export const GOOD_SHA256 = 'e7de715cd4a309dc8c6fe72c93ad8f2b9e3d3c1b4a1d5f2c8e6b0a9d7c3f5e1b';
export const BAD_SHA256 = '0000000000000000000000000000000000000000000000000000000000000000';

// ---------------------------------------------------------------------------
// Fress SELF-UPDATE fixtures (Workflows I/J): the app's own release feed.
//
// The running app is 1.0.7-beta (APP_VERSION comes from package.json). Every
// fixture here answers api.github.com/repos/WasewaseX/Fress/releases the way
// the real feed would - drafts are never included (the API does not return
// them), prerelease flags match the tag shape.
// ---------------------------------------------------------------------------

const OWN_BASE = 'https://github.com/WasewaseX/Fress/releases/download';

/** SHA256SUMS.txt as CI would publish it: sha256sum format, two spaces,
 * covering the assets of the valid release. */
export const OWN_SUMS_TXT = [
  `${GOOD_SHA256}  Fress_1.0.8_amd64.AppImage`,
  `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  Fress_1.0.8_x64-setup.exe`,
  `bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  Fress_1.0.8_aarch64.AppImage`,
].join('\n');

/** Worst-case sums for the ARM-only release: the incompatible Windows
 * installer HAS a published digest, so if the picker wrongly selects it the
 * user gets a fully "verified" download of a file their machine cannot run. */
export const OWN_SUMS_ARM_ONLY = [
  `bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  Fress_1.0.8_aarch64.AppImage`,
  `${GOOD_SHA256}  Fress_1.0.8_arm64-setup.exe`,
].join('\n');

/** A newer release this (x86_64, Linux) install can update into: a
 * platform-matched AppImage among the other desktop files, plus the checksum
 * document. pickOwnAsset must pick the amd64 AppImage on the Linux runner. */
export const OWN_RELEASES_VALID: GhReleaseFixture[] = [
  {
    tag: 'v1.0.8-beta',
    name: 'Fress 1.0.8-beta',
    published_at: '2026-10-12T00:00:00Z',
    html_url: 'https://github.com/WasewaseX/Fress/releases/tag/v1.0.8-beta',
    prerelease: true,
    assets: [
      { name: 'Fress_1.0.8_amd64.AppImage', size: 22_000_000, download_url: `${OWN_BASE}/v1.0.8-beta/Fress_1.0.8_amd64.AppImage` },
      { name: 'Fress_1.0.8_x64-setup.exe', size: 21_000_000, download_url: `${OWN_BASE}/v1.0.8-beta/Fress_1.0.8_x64-setup.exe` },
      { name: 'Fress_1.0.8_aarch64.AppImage', size: 20_000_000, download_url: `${OWN_BASE}/v1.0.8-beta/Fress_1.0.8_aarch64.AppImage` },
      { name: 'SHA256SUMS.txt', size: 300, download_url: `${OWN_BASE}/v1.0.8-beta/SHA256SUMS.txt` },
    ],
  },
  {
    tag: 'v1.0.7-beta',
    name: 'Fress 1.0.7-beta',
    published_at: '2026-10-11T00:00:00Z',
    html_url: 'https://github.com/WasewaseX/Fress/releases/tag/v1.0.7-beta',
    prerelease: true,
    assets: [],
  },
];

/** A release whose tag parseVersion() cannot read. The updater must treat it
 * as NOT newer (string fallback ranks it below the running version) instead
 * of crashing or offering a bogus update. */
export const OWN_RELEASE_MALFORMED: GhReleaseFixture[] = [
  {
    tag: 'not-a-version',
    name: 'Fress (untagged build)',
    published_at: '2026-10-12T00:00:00Z',
    html_url: 'https://github.com/WasewaseX/Fress/releases/tag/not-a-version',
    prerelease: false,
    assets: [
      { name: 'Fress_1.0.8_x64-setup.exe', size: 21_000_000, download_url: `${OWN_BASE}/not-a-version/Fress_1.0.8_x64-setup.exe` },
    ],
  },
];

/** Channel-filter fixture: the newest build is a beta (invisible on the
 * Stable channel, visible on Beta/Alpha), the stable tag is OLDER than the
 * running 1.0.7-beta so neither channel may offer it. */
export const OWN_RELEASES_CHANNEL: GhReleaseFixture[] = [
  {
    tag: 'v1.0.8-beta',
    name: 'Fress 1.0.8-beta',
    published_at: '2026-10-12T00:00:00Z',
    html_url: 'https://github.com/WasewaseX/Fress/releases/tag/v1.0.8-beta',
    prerelease: true,
    assets: [
      { name: 'Fress_1.0.8_x64-setup.exe', size: 21_000_000, download_url: `${OWN_BASE}/v1.0.8-beta/Fress_1.0.8_x64-setup.exe` },
      { name: 'SHA256SUMS.txt', size: 300, download_url: `${OWN_BASE}/v1.0.8-beta/SHA256SUMS.txt` },
    ],
  },
  {
    tag: 'v1.0.6',
    name: 'Fress 1.0.6',
    published_at: '2026-10-01T00:00:00Z',
    html_url: 'https://github.com/WasewaseX/Fress/releases/tag/v1.0.6',
    prerelease: false,
    assets: [
      { name: 'Fress_1.0.6_x64-setup.exe', size: 21_000_000, download_url: `${OWN_BASE}/v1.0.6/Fress_1.0.6_x64-setup.exe` },
    ],
  },
];

/** A release that ships ONLY files this x86_64 Linux host cannot run: an
 * ARM64 AppImage plus Windows/ARM installers. pickOwnAsset must return null
 * (every Linux candidate scores -Infinity; the .exe files are not Linux
 * assets at all) so the updater offers the releases page, never a download. */
export const OWN_RELEASE_ARM_ONLY: GhReleaseFixture[] = [
  {
    tag: 'v1.0.8-beta',
    name: 'Fress 1.0.8-beta',
    published_at: '2026-10-12T00:00:00Z',
    html_url: 'https://github.com/WasewaseX/Fress/releases/tag/v1.0.8-beta',
    prerelease: true,
    assets: [
      { name: 'Fress_1.0.8_aarch64.AppImage', size: 22_000_000, download_url: `${OWN_BASE}/v1.0.8-beta/Fress_1.0.8_aarch64.AppImage` },
      { name: 'Fress_1.0.8_arm64-setup.exe', size: 20_000_000, download_url: `${OWN_BASE}/v1.0.8-beta/Fress_1.0.8_arm64-setup.exe` },
      { name: 'SHA256SUMS.txt', size: 300, download_url: `${OWN_BASE}/v1.0.8-beta/SHA256SUMS.txt` },
    ],
  },
];

/** A usable amd64 AppImage whose checksum CANNOT be established: the release
 * carries no SHA256SUMS.txt at all. The updater must fail CLOSED - the
 * releases page instead of an unverifiable in-app download. */
export const OWN_RELEASE_NO_SUMS: GhReleaseFixture[] = [
  {
    tag: 'v1.0.8-beta',
    name: 'Fress 1.0.8-beta',
    published_at: '2026-10-12T00:00:00Z',
    html_url: 'https://github.com/WasewaseX/Fress/releases/tag/v1.0.8-beta',
    prerelease: true,
    assets: [
      { name: 'Fress_1.0.8_amd64.AppImage', size: 22_000_000, download_url: `${OWN_BASE}/v1.0.8-beta/Fress_1.0.8_amd64.AppImage` },
    ],
  },
];
export const PAYLOAD_SHA256 =
  '9f2c0d3b7a1e5f8c6b4d2e0a9f7c3b5d1e8f6a4c2b0d3e5f7a9c1b3d5e7f9a0b';

/** Signal publishes per-file sha512 as base64 (electron-updater); the app
 * converts to 128-char hex. This is the hex digest the fixture encodes. */
export const SIGNAL_SHA512_HEX = '1f2e3d4c5b6a79880918273a4b5c6d7e8f9012a3b4c5d6e7f8091a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9012a3b4c5d6e7f8091a2b3c4d5e6f7a8b9c0d10';

/** base64(hex) computed deterministically at module load. */
function hexToBase64(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return Buffer.from(bin, 'binary').toString('base64');
}

export const SIGNAL_SHA512_B64 = hexToBase64(SIGNAL_SHA512_HEX);

/** electron-updater latest.yml for the Signal official resolver (Windows).
 * Parsed by parseSignalYml: version + files with url/size/sha512(base64). */
export const SIGNAL_LATEST_YML = [
  'version: 7.20.0',
  'path: signal-desktop-win-x64-7.20.0.exe',
  `sha512: ${SIGNAL_SHA512_B64}`,
  'releaseDate: \'2025-11-01T10:00:00.000Z\'',
  'files:',
  '  - url: signal-desktop-win-x64-7.20.0.exe',
  `    sha512: ${SIGNAL_SHA512_B64}`,
  '    size: 178257920',
  '  - url: signal-desktop-win-arm64-7.20.0.exe',
  `    sha512: ${SIGNAL_SHA512_B64}`,
  '    size: 175000000',
  '  - url: signal-desktop-win-x64-7.20.0.exe.blockmap',
  `    sha512: ${SIGNAL_SHA512_B64}`,
  '    size: 120000',
].join('\n');

/** Deterministic PRNG (mulberry32). Same seed -> same sequence everywhere. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CATEGORIES: Array<AppItem['category']> = [
  'Productivity & Office',
  'Developer & Code',
  'Design & Creative',
  'Utilities & System',
  'Privacy & Security',
  'Media, Audio & Video',
];

/** A large deterministic catalog for the perf harness and heavy screens.
 * Objects pass `sanitizeAppItem` (the gate custom items go through), so the
 * app accepts them through its own documented `fress_custom_items` path. */
export function makeCatalogFixture(count = 500): Array<Record<string, unknown>> {
  const rand = mulberry32(20260101);
  const out: Array<Record<string, unknown>> = [];
  for (let i = 0; i < count; i++) {
    const cat = CATEGORIES[i % CATEGORIES.length];
    out.push({
      id: `perf-app-${String(i).padStart(4, '0')}`,
      name: `Perf App ${String(i).padStart(4, '0')}`,
      tagline: `Deterministic fixture number ${i} for the perf harness`,
      description: `Fixture app ${i}. Generated with a seeded PRNG so the catalog is byte-identical on every machine and every run.`,
      whyItsAwesome: 'Exists to make rendering, filtering and persistence measurable.',
      beginnerGuide: 'Not a real app - never ship it anywhere.',
      githubUrl: `https://github.com/perf-fixtures/app-${String(i).padStart(4, '0')}`,
      websiteUrl: `https://perf-fixtures.example/app-${i}`,
      category: cat,
      platforms: i % 3 === 0 ? ['windows', 'linux', 'android'] : i % 3 === 1 ? ['windows', 'mac'] : ['linux', 'web'],
      license: 'MIT',
      stars: Math.floor(rand() * 50_000),
      beginnerRating: (['Super Beginner Friendly', 'Quick Learning Curve', 'Advanced / Power User'] as const)[i % 3],
      isOwnerPick: i % 17 === 0,
      isTrendingToday: i % 23 === 0,
      tags: [`tag-${i % 7}`, 'fixture'],
      addedAt: '2026-01-01',
      isCustom: true,
      offlineReady: true,
      architectures: ['x86_64'],
    });
  }
  return out;
}

/** The perf catalog includes a few named apps used by interaction probes. */
export function perfFixtureWithProbes(count = 500): Array<Record<string, unknown>> {
  const base = makeCatalogFixture(count);
  // Deterministic probe names inside the big list.
  base[0] = { ...base[0], id: 'perf-app-0000', name: 'Zeppelin Finder' };
  base[1] = { ...base[1], id: 'perf-app-0001', name: 'Quartz Runner' };
  return base;
}

/** A small valid Fress backup (import path, Workflow F). */
export function validBackup(): Record<string, unknown> {
  return {
    meta: { project: 'Fress', exportDate: '2026-01-01T00:00:00.000Z', version: '1.3', totalItems: 2 },
    favorites: ['localsend'],
    customApps: [
      {
        id: 'imported-alpha',
        name: 'Imported Alpha',
        tagline: 'A valid imported app',
        description: 'Imported through the backup restore path in Workflow F.',
        githubUrl: 'https://github.com/example/alpha',
        websiteUrl: 'https://alpha.example',
        category: 'Utilities & System',
        platforms: ['windows', 'linux'],
        license: 'MIT',
        stars: 10,
        tags: ['import'],
        addedAt: '2026-01-01',
        isCustom: true,
      },
      {
        id: 'imported-beta',
        name: 'Imported Beta',
        tagline: 'A second valid imported app',
        description: 'Second fixture entry.',
        githubUrl: 'https://github.com/example/beta',
        category: 'Developer & Code',
        platforms: ['linux'],
        license: 'Apache-2.0',
        stars: 20,
        tags: ['import'],
        addedAt: '2026-01-01',
        isCustom: true,
      },
    ],
    allApps: [],
  };
}

/** Malformed inputs for Workflow F: corrupt data must never crash the UI. */
export const MALFORMED_BACKUPS: Array<{ name: string; content: string }> = [
  { name: 'not-json.json', content: 'this is { not json at all' },
  { name: 'array.json', content: '["just", "an", "array"]' },
  { name: 'apps-not-array.json', content: JSON.stringify({ meta: { version: '1.3' }, customApps: { oops: true } }) },
  { name: 'favorites-corrupt.json', content: JSON.stringify({ meta: { version: '1.3' }, customApps: [], favorites: 'not-an-array' }) },
  { name: 'newer-schema.json', content: JSON.stringify({ meta: { version: '2.0' }, customApps: [] }) },
  { name: 'junk-entries.json', content: JSON.stringify({ meta: { version: '1.3' }, customApps: [null, 42, { platforms: null, tags: 'oops' }, { id: 'valid-entry', name: 'Valid Entry', platforms: ['windows'], category: 'Utilities & System', githubUrl: 'https://github.com/x/y', addedAt: '2026-01-01' }] }) },
];
