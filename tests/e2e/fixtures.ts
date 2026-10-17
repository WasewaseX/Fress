// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
/**
 * Test fixtures: environment seeding, Tauri-mode injection, app navigation.
 *
 * Every test starts from a DETERMINISTIC environment:
 *  - storage seeds (no update probes, no WhatsNew popup, cached stars)
 *  - fixture-backed network (or a rate-limit simulation on demand)
 *  - optional Tauri bridge (Workflow D and the perf harness)
 * Tests opt in per file via `test.use({ tauriMode: true })` / seed options.
 */
import { test as base, expect, type Page } from '@playwright/test';
import { bridgeSource, type FressTestBridge } from './tauri-bridge';
import { installNetworkPolicy, storageSeeds, buildStarSeed, APP_VERSION } from './netpolicy';
import {
  perfFixtureWithProbes,
  RELEASES_LOCALSEND,
  OWN_SUMS_TXT,
  OWN_SIG_TXT,
  type GhReleaseFixture,
} from './fixtures/data';

/** Release fixtures pre-seeded into the Tauri bridge so the in-app resolver
 * answers deterministically for every app the workflows touch. */
export const TAURI_RELEASE_SEED: Record<string, GhReleaseFixture[]> = {
  'localsend/localsend': RELEASES_LOCALSEND,
  'videolan/vlc': [
    {
      tag: '3.0.21',
      name: 'VLC 3.0.21',
      published_at: '2025-10-01T00:00:00Z',
      html_url: 'https://github.com/videolan/vlc/releases/tag/3.0.21',
      assets: [
        { name: 'vlc-3.0.21-win64.exe', size: 41_000_000, download_url: 'https://github.com/videolan/vlc/releases/download/3.0.21/vlc-3.0.21-win64.exe' },
      ],
    },
  ],
  'obsidianmd/obsidian-releases': [
    {
      tag: 'v1.10.0',
      name: 'Obsidian 1.10.0',
      published_at: '2025-11-05T00:00:00Z',
      html_url: 'https://github.com/obsidianmd/obsidian-releases/releases/tag/v1.10.0',
      assets: [
        { name: 'Obsidian-1.10.0.exe', size: 90_000_000, download_url: 'https://github.com/obsidianmd/obsidian-releases/releases/download/v1.10.0/Obsidian-1.10.0.exe' },
      ],
    },
  ],
  'sharex/sharex': [
    {
      tag: 'v17.1.0',
      name: 'ShareX 17.1.0',
      published_at: '2025-11-10T00:00:00Z',
      html_url: 'https://github.com/ShareX/ShareX/releases/tag/v17.1.0',
      assets: [
        { name: 'ShareX-17.1.0-setup.exe', size: 8_000_000, download_url: 'https://github.com/ShareX/ShareX/releases/download/v17.1.0/ShareX-17.1.0-setup.exe' },
      ],
    },
  ],
};

export interface SeedOptions {
  /** Inject window.__TAURI_INTERNALS__ before app code runs (in-app mode). */
  tauri?: boolean;
  /** Pre-seed the custom catalog (fress_custom_items). */
  customItems?: Array<Record<string, unknown>>;
  /** Initial theme (fress.theme). */
  theme?: 'light' | 'dark';
  /** Initial language (fress.lang). */
  lang?: string;
  /** Make every resolver answer look like a shared-quota rate limit. */
  rateLimitResolver?: boolean;
  /** Initial update channel (fress.updateChannel) - Workflows I/J. */
  updateChannel?: 'stable' | 'beta' | 'alpha';
  /** The app's own release feed for the self-update probe (Workflows I/J).
   * WRAPPED in an object on purpose: Playwright reads a two-element ARRAY
   * passed to test.use() as a [value, options] tuple, so a bare list would
   * silently lose its second release. */
  ownReleases?: { list: GhReleaseFixture[] };
  /** Body for the self-update SHA256SUMS.txt asset; omit to simulate a
   * release whose checksum document is missing (fail-closed path). */
  ownSums?: string;
  /** Body for the self-update minisign sidecar ("*.sig") assets; omit to
   * simulate a release whose signature document is unreachable. */
  ownSigs?: string;
}

export type TestFixtures = {
  /** Granular per-test options (set via test.use). */
  tauriMode: boolean;
  lang: string | undefined;
  theme: 'light' | 'dark' | undefined;
  customItems: Array<Record<string, unknown>> | undefined;
  rateLimitResolver: boolean;
  updateChannel: 'stable' | 'beta' | 'alpha' | undefined;
  ownReleases: { list: GhReleaseFixture[] } | undefined;
  ownSums: string | undefined;
  ownSigs: string | undefined;
  /** Navigates to the app with all seeding already in place. */
  gotoApp: (path?: string) => Promise<Page>;
};

export const test = base.extend<TestFixtures>({
  tauriMode: [false, { option: true }],
  lang: [undefined, { option: true }],
  theme: [undefined, { option: true }],
  customItems: [undefined, { option: true }],
  rateLimitResolver: [false, { option: true }],
  updateChannel: [undefined, { option: true }],
  ownReleases: [undefined, { option: true }],
  ownSums: [undefined, { option: true }],
  ownSigs: [undefined, { option: true }],

  gotoApp: async (
    { page, tauriMode, lang, theme, customItems, rateLimitResolver, updateChannel, ownReleases, ownSums, ownSigs },
    use
  ) => {
    // The init script is serialized: every value it needs must be in the
    // argument object, never a module-scope closure.
    await page.context().addInitScript(storageSeeds, {
      appVersion: APP_VERSION,
      starSeed: buildStarSeed(),
      customItems,
      theme,
      lang,
      updateChannel,
    });
    if (tauriMode) {
      await page.context().addInitScript({ content: bridgeSource({
        hostArch: 'x86_64',
        defaultDir: '/home/test/Downloads',
        releases: TAURI_RELEASE_SEED,
      }) });
    }
    await installNetworkPolicy(page, {
      rateLimitResolver,
      ownReleases: ownReleases?.list,
      ownSums: ownSums ?? (ownReleases ? OWN_SUMS_TXT : undefined),
      ownSigs: ownSigs ?? (ownReleases ? OWN_SIG_TXT : undefined),
    });

    await use(async (path = '/') => {
      await page.goto(path);
      await waitForCatalogReady(page);
      return page;
    });
  },
});

export { expect };

/** The catalog has rendered: grid, table or the empty state. */
export async function waitForCatalogReady(page: Page): Promise<void> {
  await page.waitForSelector('#main-content', { state: 'attached' });
  await page.waitForSelector('#apps-catalog-grid article, #apps-data-table tbody tr, #main-content', {
    state: 'attached',
  });
  await page.waitForFunction(() => {
    const grid = document.getElementById('apps-catalog-grid');
    return !!grid && grid.querySelectorAll('article').length > 0;
  });
}

/** Fonts are loaded - required before any visual snapshot. */
export async function fontsReady(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
}

/** Bridge accessor for Tauri-mode tests. */
export async function bridge(page: Page): Promise<FressTestBridge | null> {
  return page.evaluate(() => window.__fressTest ?? null);
}

/** Convenience: the perf fixture (500+ entries) as custom catalog items. */
export const PERF_CATALOG = perfFixtureWithProbes(500);
