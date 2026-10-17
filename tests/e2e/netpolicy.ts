// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
/**
 * Deterministic network policy for the E2E suite (Task 1 / Task 4 rule:
 * "no mandatory live GitHub, vendor or F-Droid calls").
 *
 * Two layers:
 *  1. Storage seeds (init script, runs before any app code):
 *     - `fress.seen_version` -> the WhatsNew modal never auto-opens
 *     - `fress.last_update_check` -> the 24h self-update probe never fires
 *     - `fress.stars.v1` -> star counts come from cache, zero network
 *  2. Route layer: every resolver/vendor endpoint that can still be reached
 *     (detail modal, live search opened explicitly, self-update manual
 *     check) is answered from fixtures; everything else external is ABORTED
 *     so a surprise request fails loudly instead of hanging or leaking.
 */
import type { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { INITIAL_APPS } from '../../src/data/appsData';
import { ALL_EXTRA_APPS } from '../../src/data/appsDataExtra';
import { RELEASES_LOCALSEND, SIGNAL_LATEST_YML, type GhReleaseFixture } from './fixtures/data';

export const STAR_COUNT = 1234;

/** The app's own version, read Node-side (JSON imports need an import
 * attribute in modern Node; the file read keeps the config tool-agnostic). */
export const APP_VERSION: string = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
).version;

/** Star-cache entries for every shipped catalog repo, computed Node-side and
 * passed into the page through the init-script argument (init scripts are
 * serialized: they can never close over module scope). */
export function buildStarSeed(): Record<string, { n: number; t: number }> {
  const starCache: Record<string, { n: number; t: number }> = {};
  const repoKey = (url?: string): string | null => {
    const m = url?.match(/^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
    return m ? `gh:${m[1]}/${m[2]}`.toLowerCase() : null;
  };
  for (const app of [...INITIAL_APPS, ...ALL_EXTRA_APPS]) {
    const key = repoKey(app.githubUrl);
    if (key) starCache[key] = { n: app.stars ?? 0, t: 0 };
  }
  for (let i = 0; i < 600; i++) {
    starCache[`gh:perf-fixtures/app-${String(i).padStart(4, '0')}`] = { n: 4321, t: 0 };
  }
  return starCache;
}

/** Per-repo release fixtures used by the browser-mode resolver. */
export const RELEASE_FIXTURES: Record<string, GhReleaseFixture[]> = {
  'localsend/localsend': RELEASES_LOCALSEND,
};

function ghReleaseBody(rel: GhReleaseFixture) {
  return {
    tag_name: rel.tag,
    name: rel.name,
    published_at: rel.published_at,
    html_url: rel.html_url,
    prerelease: rel.prerelease ?? false,
    assets: rel.assets.map((a) => ({
      name: a.name,
      size: a.size,
      browser_download_url: a.download_url,
    })),
  };
}

export interface NetworkPolicyOptions {
  /** Release fixtures per repo (defaults: LocalSend). */
  releases?: Record<string, GhReleaseFixture[]>;
  /** Force every resolver answer to fail like a shared-quota rate limit. */
  rateLimitResolver?: boolean;
  /** The app's OWN release feed (self-update probe). Default: no releases,
   * so a stray self-update probe resolves to "nothing available". */
  ownReleases?: GhReleaseFixture[];
  /** Body served for the self-update SHA256SUMS.txt release asset. Omit it
   * to simulate a release whose checksum document is missing/unreachable. */
  ownSums?: string;
  /** Body served for the self-update minisign signature sidecars
   * ("<asset>.sig" release assets). Omit it to simulate a release whose
   * sidecar document is unreachable; the delivery plan gate then fails
   * closed exactly as it would against a broken release. */
  ownSigs?: string;
}

/** Installs the route layer on a page. Call after context creation, before goto.
 *
 * Route precedence: Playwright consults handlers LAST-registered first, so
 * the deny-all fallback goes in FIRST and every fixture route registered
 * after it shadows it for its own URLs. A resolver request that misses every
 * fixture route (a repo we do not stub) falls through to the deny-all and
 * fails loudly instead of leaking to the network. */
export async function installNetworkPolicy(page: Page, opts: NetworkPolicyOptions = {}): Promise<void> {
  const releases = { ...RELEASE_FIXTURES, ...(opts.releases ?? {}) };
  const ownReleases = opts.ownReleases ?? [];
  const ownSums = opts.ownSums;
  const ownSigs = opts.ownSigs;

  const apiRe = /https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/?]+)(\/releases\/latest|\/releases[^/]*?)?(\?.*)?$/;

  // 1) Deny-all fallback: everything external that no fixture route claims
  //    is aborted, so a surprise request fails loudly instead of hanging or
  //    leaking into a live network.
  await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (route) => route.abort('blockedbyclient'));

  // 2) GitHub API: releases (resolver) and repo metadata (stars).
  await page.route(apiRe, (route) => {
    const url = route.request().url();
    const m = apiRe.exec(url);
    const owner = m?.[1] ?? '';
    const repo = m?.[2] ?? '';
    const slug = `${owner}/${repo}`.toLowerCase();
    const path = m?.[3] ?? '';

    // Self-updater probes the Fress repo itself. With ownReleases the feed
    // answers from fixtures (Workflows I/J); without, an empty feed keeps
    // every incidental probe at "no update" instead of leaking live.
    if (slug === 'wasewasex/fress') {
      if (path.startsWith('/releases')) {
        if (path === '/releases/latest') {
          return ownReleases.length > 0
            ? route.fulfill({ status: 200, body: JSON.stringify(ghReleaseBody(ownReleases[0])), contentType: 'application/json' })
            : route.fulfill({ status: 200, body: '[]', contentType: 'application/json' });
        }
        const count = Number(new URL(url).searchParams.get('per_page') ?? '20');
        return route.fulfill({ status: 200, body: JSON.stringify(ownReleases.slice(0, count).map(ghReleaseBody)), contentType: 'application/json' });
      }
      return route.fulfill({ status: 200, body: JSON.stringify({ stargazers_count: STAR_COUNT }), contentType: 'application/json' });
    }

    if (path === '/releases/latest' || path.startsWith('/releases?')) {
      if (opts.rateLimitResolver) {
        return route.fulfill({
          status: 403,
          contentType: 'application/json',
          headers: { 'x-ratelimit-remaining': '0' },
          body: JSON.stringify({ message: "API rate limit exceeded for 127.0.0.1." }),
        });
      }
      const list = releases[slug];
      if (!list || list.length === 0) return route.fulfill({ status: 404, body: '{"message":"Not Found"}', contentType: 'application/json' });
      if (path === '/releases/latest') return route.fulfill({ status: 200, body: JSON.stringify(ghReleaseBody(list[0])), contentType: 'application/json' });
      const count = Number(new URL(url).searchParams.get('per_page') ?? '20');
      return route.fulfill({ status: 200, body: JSON.stringify(list.slice(0, count).map(ghReleaseBody)), contentType: 'application/json' });
    }

    // Repo metadata (star counts for anything not pre-seeded).
    return route.fulfill({ status: 200, body: JSON.stringify({ stargazers_count: STAR_COUNT }), contentType: 'application/json' });
  });

  // F-Droid package index.
  await page.route(/https:\/\/f-droid\.org\/api\/v1\/packages\/[^/]+$/, (route) => {
    const pkg = decodeURIComponent(route.request().url().split('/').pop() ?? '');
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        packages: [{ versionCode: 101000, versionName: '1.1.0' }],
        suggestedVersionCode: 101000,
        packageName: pkg,
      }),
    });
  });

  // Signal's official update manifest (carries the trusted sha512 that the
  // Workflow D checksum contract verifies against).
  await page.route(/^https:\/\/updates\.signal\.org\/desktop\/(latest|latest-linux|latest-mac)\.yml$/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/yaml', body: SIGNAL_LATEST_YML })
  );

  // Updater atom-feed fallback.
  await page.route(/https:\/\/github\.com\/WasewaseX\/Fress\/releases\.atom$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/atom+xml; charset=utf-8',
      body: '<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>',
    })
  );

  // Self-update checksum document (fetch_self_update_text proxies it through
  // the page fetch, which the route layer answers). The minisign signature
  // sidecars answer from the same rails. Any other self-update asset URL is
  // never fetched - the download engine is passive in tests - so it falls
  // through to deny-all and any surprise fails loudly.
  await page.route(/https:\/\/github\.com\/WasewaseX\/Fress\/releases\/download\/[^/]+\/SHA256SUMS\.txt$/, (route) => {
    if (ownSums === undefined) {
      return route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
    }
    return route.fulfill({ status: 200, contentType: 'text/plain; charset=utf-8', body: ownSums });
  });
  await page.route(/https:\/\/github\.com\/WasewaseX\/Fress\/releases\/download\/[^/]+\/[^/]+\.sig$/, (route) => {
    if (ownSigs === undefined) {
      return route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
    }
    return route.fulfill({ status: 200, contentType: 'text/plain; charset=utf-8', body: ownSigs });
  });
}

/** Storage seeds + optional fixture injection. Runs before app scripts.
 * EVERYTHING this function touches arrives through the argument: Playwright
 * serializes the function body, so module-scope closures would be lost. */
export function storageSeeds(options: {
  appVersion?: string;
  starSeed?: Record<string, { n: number; t: number }>;
  customItems?: Array<Record<string, unknown>>;
  theme?: 'light' | 'dark';
  lang?: string;
  updateChannel?: 'stable' | 'beta' | 'alpha';
} = {}): void {
  const appVersion = options.appVersion ?? '0.0.0-test';
  try {
    localStorage.setItem('fress.seen_version', appVersion);
    localStorage.setItem('fress.last_update_check', String(Date.now()));
    // Star cache: fresh entries so no card fetches star counts live.
    const starCache: Record<string, { n: number; t: number }> = options.starSeed ?? {};
    const now = Date.now();
    for (const entry of Object.values(starCache)) entry.t = now;
    localStorage.setItem('fress.stars.v1', JSON.stringify(starCache));
    if (options.customItems) {
      localStorage.setItem('fress_custom_items', JSON.stringify(options.customItems));
    }
    if (options.theme) {
      localStorage.setItem('fress.theme', options.theme);
    }
    if (options.lang) {
      localStorage.setItem('fress.lang', options.lang);
    }
    if (options.updateChannel) {
      localStorage.setItem('fress.updateChannel', options.updateChannel);
    }
  } catch {
    // Storage refused: tests will surface the consequence themselves.
  }
}
