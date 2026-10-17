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
