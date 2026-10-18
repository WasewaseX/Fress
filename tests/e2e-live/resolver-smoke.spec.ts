// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
/**
 * Live resolver smoke (network-smoke.yml ONLY - never a PR gate).
 *
 * Probes the real endpoints the browser-mode resolver uses, through the real
 * UI, with generous timeouts. Each probe logs the HTTP status it observed so
 * a run report can distinguish "Fress is broken" from "GitHub is rate
 * limiting the runner" (expected eventually - unauthenticated quota).
 *
 * Storage seeds (no update popup, no WhatsNew modal) still apply - they are
 * local-only and keep the smoke deterministic in every other respect.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { storageSeeds } from '../e2e/netpolicy';

const APP_VERSION: string = (
  // This spec lives at tests/e2e-live/ - the root package.json is TWO levels
  // up. ('../package.json' resolved to tests/package.json, which does not
  // exist, so the scheduled live-smoke workflow failed collection with
  // ENOENT before a single probe ran - caught by its first scheduled run,
  // 2026-10-12, run 38271362011.)
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
).version;

test.beforeEach(async ({ context }) => {
  await context.addInitScript(storageSeeds, { appVersion: APP_VERSION });
});

test('catalog renders from the shipped data', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (document.getElementById('apps-catalog-grid')?.querySelectorAll('article').length ?? 0) > 0, undefined, { timeout: 60_000 });
  await expect(page.locator('#app-title-localsend')).toBeVisible();
});

test('GitHub Releases API answers the resolver', async ({ request }) => {
  const resp = await request.get('https://api.github.com/repos/localsend/localsend/releases/latest', {
    headers: { Accept: 'application/vnd.github+json' },
  });
  // 403 means the runner's shared quota is exhausted - report it loudly so
  // the run log distinguishes quota from breakage, and fail soft for THAT
  // case only (an expected, non-actionable outcome).
  if (resp.status() === 403 || resp.status() === 429) {
    test.info().annotations.push({ type: 'notice', description: 'GitHub API rate-limited this runner; resolver probe skipped.' });
    return;
  }
  expect(resp.ok()).toBeTruthy();
  const body = (await resp.json()) as { tag_name?: string };
  expect(body.tag_name).toBeTruthy();
});

test('detail modal settles on a real resolver answer', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (document.getElementById('apps-catalog-grid')?.querySelectorAll('article').length ?? 0) > 0, undefined, { timeout: 60_000 });
  await page.locator('#app-title-localsend').click();
  // LocalSend ships real Windows installers on GitHub Releases; the resolver
  // should surface a confident pick (or the honest none/rate-limit state).
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const el = document.getElementById('detail-download-box');
          if (!el) return 'no-box';
          const text = el.textContent ?? '';
          if (/\.exe|\.AppImage|\.dmg|rate-limiting|No ready-made file/i.test(text)) return 'settled';
          return 'resolving';
        }),
      { timeout: 90_000, intervals: [1_000, 2_000, 5_000] }
    )
    .toBe('settled');
});

test('F-Droid index answers', async ({ request }) => {
  const resp = await request.get('https://f-droid.org/api/v1/packages/org.localsend.localsend_app');
  if (resp.status() >= 500) {
    test.info().annotations.push({ type: 'notice', description: `F-Droid answered ${resp.status()}; upstream outage likely.` });
  }
  expect(resp.status()).toBeLessThan(500);
});

// ---------------------------------------------------------------------------
// Quota-free document probes (the 2026-10 "atom-first" source order).
// These pin the wire shapes the desktop resolver now depends on FIRST:
// api.github.com is spent last, so the github.com documents must answer,
// carry real asset anchors, and agree with the API on the newest stable
// tag. A zero-anchor fragment here is the page-shell regression that
// silently emptied the fallback and pushed users to the browser.
// ---------------------------------------------------------------------------

const STAGE_UNSTABLE = /(beta|rc|alpha|nightly|canary|snapshot|dev|preview|prerelease)/i;

test('releases.atom answers fast with stable entries (quota-free)', async ({ request }) => {
  const started = Date.now();
  const resp = await request.get('https://github.com/localsend/localsend/releases.atom');
  const elapsed = Date.now() - started;
  expect(resp.status()).toBe(200);
  expect(resp.headers()['content-type']).toContain('xml');
  // The quota-free documents are CDN-served static files; they must beat
  // the API's worst case by a wide margin even on a cold runner.
  expect(elapsed).toBeLessThan(10_000);
  const body = await resp.text();
  expect(body).toContain('<entry>');
  const hrefs = [...body.matchAll(/href="https:\/\/github\.com\/localsend\/localsend\/releases\/tag\/([^"]+)"/g)].map(
    (m) => decodeURIComponent(m[1])
  );
  const stable = hrefs.filter((t) => !STAGE_UNSTABLE.test(t));
  expect(stable.length).toBeGreaterThan(0);
  test.info().annotations.push({ type: 'notice', description: `atom newest stable tag: ${stable[0]} (${elapsed}ms)` });
  // Hand the tag to the fragment probe below.
  (globalThis as Record<string, unknown>).__lsTag = stable[0];
});

test('expanded_assets NEW shape serves real asset anchors', async ({ request }) => {
  const tag = (globalThis as Record<string, unknown>).__lsTag as string | undefined;
  test.skip(!tag, 'atom probe did not yield a stable tag');
  const resp = await request.get(`https://github.com/localsend/localsend/releases/expanded_assets/${tag}`);
  expect(resp.status()).toBe(200);
  const body = await resp.text();
  const anchors = body.match(/href="\/localsend\/localsend\/releases\/download\/[^"]+"/g) ?? [];
  expect(anchors.length).toBeGreaterThan(0);
});

test('expanded_assets OLD shape status observed (rollback path)', async ({ request }) => {
  // Informational: the app tries the NEW shape first and falls back to
  // this one when the new answer carries zero anchors. Whatever GitHub
  // answers here, the run log should record it.
  const tag = (globalThis as Record<string, unknown>).__lsTag as string | undefined;
  test.skip(!tag, 'atom probe did not yield a stable tag');
  const resp = await request.get(`https://github.com/localsend/localsend/releases/tag/${tag}/expanded_assets`);
  const body = resp.status() === 200 ? await resp.text() : '';
  const anchors = body.match(/href="\/localsend\/localsend\/releases\/download\/[^"]+"/g) ?? [];
  test.info().annotations.push({
    type: 'notice',
    description: `old fragment shape: HTTP ${resp.status()}, ${anchors.length} anchors (0 = rollout shell, the app's new-first order handles it)`,
  });
  expect(resp.status()).toBeLessThan(500);
});

test('updater chain: latest.json is live, signed and platform-complete', async ({ request }) => {
  const started = Date.now();
  const resp = await request.get('https://github.com/WasewaseX/Fress/releases/latest/download/latest.json');
  const elapsed = Date.now() - started;
  expect(resp.status()).toBe(200);
  expect(elapsed).toBeLessThan(15_000);
  const doc = (await resp.json()) as {
    version?: string;
    pub_date?: string;
    platforms?: Record<string, { signature?: string; url?: string }>;
  };
  expect(doc.version).toMatch(/^\d+\.\d+\.\d+$/);
  expect(Number.isNaN(Date.parse(doc.pub_date ?? ''))).toBeFalsy();
  const keys = Object.keys(doc.platforms ?? {});
  expect(keys.length).toBeGreaterThanOrEqual(8);
  for (const k of keys) {
    expect(doc.platforms?.[k]?.signature, `platform ${k} signature`).toBeTruthy();
    expect(doc.platforms?.[k]?.url, `platform ${k} url`).toBeTruthy();
  }
});

test('updater chain: SHA256SUMS.txt satisfies the strict grammar', async ({ request }) => {
  const resp = await request.get('https://github.com/WasewaseX/Fress/releases/latest/download/SHA256SUMS.txt');
  expect(resp.status()).toBe(200);
  const lines = (await resp.text()).split('\n').filter((l) => l.trim().length > 0);
  expect(lines.length).toBeGreaterThanOrEqual(10);
  for (const line of lines) {
    expect(line).toMatch(/^[0-9a-f]{64}\s+\*?.+/i);
  }
});

test('cross-source consistency: API and atom agree on the newest stable tag', async ({ request }) => {
  const tag = (globalThis as Record<string, unknown>).__lsTag as string | undefined;
  test.skip(!tag, 'atom probe did not yield a stable tag');
  const resp = await request.get('https://api.github.com/repos/localsend/localsend/releases/latest');
  if (resp.status() === 403 || resp.status() === 429) {
    test.info().annotations.push({ type: 'notice', description: 'GitHub API quota exhausted; consistency check skipped (atom already proven).' });
    return;
  }
  expect(resp.status()).toBe(200);
  const body = (await resp.json()) as { tag_name?: string };
  expect(body.tag_name).toBe(tag);
});
