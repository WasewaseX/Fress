// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
/**
 * Workflow C - Resolver failure and retry.
 *
 * Mock a GitHub rate limit; verify the modal presents a SPECIFIC error (the
 * rate-limit message, not the generic "no auto download" lie) and that a
 * retry action returns a successful result; confirm no request remains
 * stuck and the official-page fallback remains available.
 *
 * Mode A (browser mode, route-level 403) exercises the fetch provider path.
 * Mode B (Tauri bridge, fetch_*_release rejects) exercises the in-app path.
 *
 * Retry mechanics (documented in src/lib/release/resolveCache.ts): failures
 * expire after FAIL_TTL_MS (30s) in the session memo; a PLATFORM SWITCH is
 * keyed differently, so switching platforms re-queries immediately - that is
 * the user-visible retry action the detail modal offers without a dedicated
 * button. The test drives that exact action.
 */
import { expect, bridge } from './fixtures';
import { sel, openDownloads } from './selectors';
import { test } from './fixtures';
import { DICTS } from '../../src/lib/i18n';

test.describe('Workflow C: resolver failure and retry (browser mode, route-level 403)', () => {
  test.use({ rateLimitResolver: true });

  test('rate-limited GitHub shows the specific error; retry via platform switch succeeds; official page fallback stays available', async ({ gotoApp, page }) => {
    await gotoApp();
    const d = DICTS.en;

    // Open the detail dialog for the anchor app (LocalSend). Headless Linux
    // Chromium resolves the default platform tab to Linux (detectUserPlatform).
    await page.locator('#app-title-localsend').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.first()).toBeVisible();

    const downloadBox = page.locator(sel.detailDownloadBox);

    // After the 403s: the SPECIFIC rate-limit message (not the generic
    // noAutoDownload text that would lie about the app).
    await expect(downloadBox.getByText(d['detail.rateLimited'], { exact: false })).toBeVisible({ timeout: 15_000 });
    await expect(downloadBox.getByText(d['detail.noAutoDownload'])).toHaveCount(0);

    // No request remains stuck: no "checking" state is left on screen.
    await expect(downloadBox.getByText(d['detail.checkingStable'])).toHaveCount(0);

    // The official-page fallback remains available: the GitHub releases page
    // link (label rendered through the dictionary) and the browser-mode hint
    // that official links stay open.
    await expect(downloadBox.getByText(d['detail.allReleases'])).toBeVisible();
    await expect(downloadBox.getByText(d['detail.downloadsHintBrowser'], { exact: false })).toBeVisible();

    // RETRY: switch platform (different cache key -> immediate re-query) with
    // the route now answering from fixtures.
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    const { installNetworkPolicy } = await import('./netpolicy');
    await installNetworkPolicy(page, {});

    // Switch to Windows: fresh key, fixture answers, confident pick.
    await downloadBox.getByRole('button', { name: 'Windows' }).click();
    await expect(downloadBox.getByText('LocalSend-1.17.0-windows-x64.exe', { exact: false })).toBeVisible({ timeout: 15_000 });
    await expect(downloadBox.getByText(d['detail.latestStableGithub'], { exact: false })).toBeVisible();

    // And the rate-limit message is gone.
    await expect(downloadBox.getByText(d['detail.rateLimited'], { exact: false })).toHaveCount(0);
  });
});

test.describe('Workflow C: resolver failure and retry (Tauri bridge mode)', () => {
  test.use({ tauriMode: true });

  test('in-app resolver failure surfaces the same contract; retry returns a successful result', async ({ gotoApp, page }) => {
    await gotoApp();
    const d = DICTS.en;
    await page.locator('#app-title-localsend').click();
    const downloadBox = page.locator(sel.detailDownloadBox);

    // Headless Linux Chromium opens the Linux tab by default; switch to
    // Windows, where the bridge's fixture answers with a confident pick.
    await downloadBox.getByRole('button', { name: 'Windows' }).click();
    await expect(downloadBox.getByText('LocalSend-1.17.0-windows-x64.exe', { exact: false })).toBeVisible({ timeout: 15_000 });

    // Flip the bridge into rate-limit mode; a platform switch re-queries.
    //
    // FINDING (routed to the resolver owner): Tauri v2 rejects command
    // errors as PLAIN STRINGS (Result<T, String> serializes Err verbatim),
    // and resolve.ts reads `(e as Error).message` - which is undefined for a
    // string. The specific rateLimited message is therefore browser-mode
    // only; in-app the same failure honestly degrades to the generic
    // noAutoDownload text with the official fallbacks intact. The bridge
    // rejects with the same string shape the real Rust engine produces, and
    // this test pins the ACTUAL in-app behavior.
    await page.evaluate(() => window.__fressTest!.setResolver('rate-limit'));
    await downloadBox.getByRole('button', { name: 'macOS' }).click();
    await expect(downloadBox.getByText(d['detail.noAutoDownload'])).toBeVisible({ timeout: 15_000 });
    // Not stuck: no lingering checking state; fallbacks stay available.
    await expect(downloadBox.getByText(d['detail.checkingStable'])).toHaveCount(0);
    await expect(downloadBox.getByText(d['detail.allReleases'])).toBeVisible();

    // Recover: resolver ok again, retry returns the successful result.
    await page.evaluate(() => window.__fressTest!.setResolver('ok'));
    await downloadBox.getByRole('button', { name: 'Windows' }).click();
    await expect(downloadBox.getByText('LocalSend-1.17.0-windows-x64.exe', { exact: false })).toBeVisible({ timeout: 15_000 });
    await expect(downloadBox.getByText(d['detail.checkingStable'])).toHaveCount(0);
  });
});

/* ------------------------------------------------------------------ */
/* Workflow C2 - the failure boundary (release qualification)          */
/* ------------------------------------------------------------------ */
/* The contracts the stable-release qualification adds on top of
 * Workflow C above. A resolver failure is NEVER allowed to become a
 * browser handoff or a transfer; a persistent failure never upgrades
 * itself into a different answer; and recovery starts the CORRECT
 * transfer. Every boundary assertion reads the RECORDED traffic
 * (openedUrls, start_download calls, the download registry), never
 * labels alone.
 *
 * Mode notes (both pinned by the tests below):
 *   - Tauri bridge mode: the thrown command error loses its message on
 *     the plain-string Err channel, so the failure honestly degrades to
 *     the generic noAutoDownload state with the official fallbacks
 *     intact (Workflow C's existing FINDING). Re-queries happen on a
 *     platform switch; failed session-memo entries expire after 30 s.
 *   - Browser mode: the fetch provider preserves the error message, so
 *     a rate limit reaches the actionable error state with its explicit
 *     Retry control - the one path where a fast post-failure retry is
 *     user-visible. */

test.describe('Workflow C2: resolver failure never becomes a browser handoff', () => {
  test.use({ tauriMode: true });

  test('C-N1 - a failed lookup keeps the official fallback, opens no browser and starts no transfer', async ({ gotoApp, page }) => {
    await gotoApp();
    const d = DICTS.en;

    // The resolver is already failing when the dialog opens; a platform
    // switch re-queries under the same failure.
    await page.evaluate(() => window.__fressTest!.setResolver('rate-limit'));
    await page.locator('#app-title-localsend').click();
    const downloadBox = page.locator(sel.detailDownloadBox);
    await expect(downloadBox).toBeVisible();
    await downloadBox.getByRole('button', { name: 'Windows' }).click();

    // The honest degradation: no ready-made file claim, no stuck
    // "checking" indicator, and the official fallbacks still offered.
    await expect(downloadBox.getByText(d['detail.noAutoDownload']))?.toBeVisible({ timeout: 15_000 });
    await expect(downloadBox.getByText(d['detail.checkingStable'])).toHaveCount(0);
    await expect(downloadBox.getByText(d['detail.otherWays'])).toBeVisible();

    // The boundary contract: the failed lookup produced NO browser
    // handoff and NO transfer. A lookup failure is neither a page-open
    // answer nor a download - it stays a retryable in-app state.
    const b = (await bridge(page))!;
    expect(b.openedUrls, 'a failed lookup must never open the browser').toEqual([]);
    expect(Object.keys(b.downloads), 'a failed lookup must never start a transfer').toHaveLength(0);
  });

  test('C-N2 - the failure persists across repeated re-queries: same honest state, no browser, no transfer', async ({ gotoApp, page }) => {
    await gotoApp();
    const d = DICTS.en;

    await page.evaluate(() => window.__fressTest!.setResolver('rate-limit'));
    await page.locator('#app-title-localsend').click();
    const downloadBox = page.locator(sel.detailDownloadBox);
    await expect(downloadBox).toBeVisible();

    // Three re-queries across three platform keys while the outage
    // persists: every one lands on the SAME honest state. A persistent
    // failure can never morph into a pick, a page handoff or a transfer.
    await downloadBox.getByRole('button', { name: 'Windows' }).click();
    await expect(downloadBox.getByText(d['detail.noAutoDownload'])).toBeVisible({ timeout: 15_000 });
    await downloadBox.getByRole('button', { name: 'macOS' }).click();
    await expect(downloadBox.getByText(d['detail.noAutoDownload'])).toBeVisible({ timeout: 15_000 });
    await downloadBox.getByRole('button', { name: 'Windows' }).click();
    await expect(downloadBox.getByText(d['detail.noAutoDownload'])).toBeVisible({ timeout: 15_000 });

    await expect(downloadBox.getByText(d['detail.checkingStable'])).toHaveCount(0);
    await expect(downloadBox.getByText(d['detail.otherWays'])).toBeVisible();
    const b = (await bridge(page))!;
    expect(b.openedUrls, 'a persistent failure must not degrade into a browser handoff').toEqual([])
    expect(Object.keys(b.downloads)).toHaveLength(0);
  });

  test('C-N3 - recovery after a transient failure starts the CORRECT native transfer with real progress', async ({ gotoApp, page }) => {
    await gotoApp();
    const d = DICTS.en;

    await page.locator('#app-title-localsend').click();
    const downloadBox = page.locator(sel.detailDownloadBox);
    await expect(downloadBox).toBeVisible();
    await downloadBox.getByRole('button', { name: 'Windows' }).click();
    await expect(downloadBox.getByText('LocalSend-1.17.0-windows-x64.exe', { exact: false })).toBeVisible({ timeout: 15_000 });

    // The resolver breaks; the user switches platform and sees the honest
    // failure state.
    await page.evaluate(() => window.__fressTest!.setResolver('rate-limit'));
    await downloadBox.getByRole('button', { name: 'macOS' }).click();
    await expect(downloadBox.getByText(d['detail.noAutoDownload'])).toBeVisible({ timeout: 15_000 });

    // The outage ends; the platform switch (the documented user-visible
    // retry) lands on the correct pick again.
    await page.evaluate(() => window.__fressTest!.setResolver('ok'));
    await downloadBox.getByRole('button', { name: 'Windows' }).click();
    const asset = downloadBox.getByRole('button', { name: /LocalSend-1\.17\.0-windows-x64\.exe/ });
    await expect(asset).toBeVisible({ timeout: 15_000 });

    // Starting the recovered pick hands the engine THE resolved asset's
    // own URL - the retry path must land on exactly the transfer the
    // resolver named, never a page handoff.
    await asset.click();
    await page.keyboard.press('Escape');
    await expect(downloadBox).toHaveCount(0);
    await expect
      .poll(async () => (await bridge(page))!.calls.filter((c) => c.cmd === 'start_download').length, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(1);
    const started = ((await bridge(page))!.calls.filter((c) => c.cmd === 'start_download').pop()!.args) as { url?: string };
    expect(started.url).toBe('https://github.com/localsend/localsend/releases/download/v1.17.0/LocalSend-1.17.0-windows-x64.exe');

    // The whole journey stayed in-app: zero browser handoffs across the
    // failure AND the recovered transfer.
    expect(((await bridge(page))!).openedUrls).toEqual([]);

    // Real progress renders from the engine's payloads (Workflow D's
    // labels-from-payloads contract, on the recovered transfer).
    await openDownloads(page);
    const [id] = Object.keys((await bridge(page))!.downloads).map(Number);
    const row = page.locator(sel.downloadRow('active')).first();
    await expect(row).toBeVisible();
    await page.evaluate((did) => window.__fressTest!.emitProgress(did, 12_582_912, 25_165_824, 4_194_304, 3), id);
    await expect(row.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
  });
});

test.describe('Workflow C2: the rate-limited Retry control in browser mode', () => {
  test.use({ rateLimitResolver: true });

  test('C-N4 - repeated rate limits after Retry stay the same actionable error, never a browser handoff; recovery yields the pick', async ({ gotoApp, page }) => {
    await gotoApp();
    const d = DICTS.en;

    // A window.open spy BEFORE any app script runs: in browser mode the
    // ONLY sanctioned browser handoff is a deliberate user action - the
    // failure paths below must record NOTHING.
    await page.context().addInitScript(() => {
      const recorded: string[] = [];
      (window as unknown as { __fressBrowserOpens: string[] }).__fressBrowserOpens = recorded;
      window.open = ((url?: string | URL) => {
        recorded.push(String(url ?? ''));
        return null;
      }) as typeof window.open;
    });
    await page.reload();

    await page.locator('#app-title-localsend').click();
    const downloadBox = page.locator(sel.detailDownloadBox);
    await expect(downloadBox).toBeVisible();

    // Work the WINDOWS key end to end: the modal opens on the headless
    // Linux tab; switching re-queries (403 again) and pins the platform
    // every later assertion reads.
    await downloadBox.getByRole('button', { name: 'Windows' }).click();

    // The 403 reaches the SPECIFIC, actionable error state with Retry.
    await expect(downloadBox.getByText(d['detail.rateLimited'], { exact: false })).toBeVisible({ timeout: 15_000 });
    const retry = downloadBox.getByRole('button', { name: d['downloads.retry'] });
    await expect(retry).toBeVisible();

    // Retry while the outage persists: the same error comes back - never
    // a browser handoff, never a silent "no match" upgrade.
    await retry.click();
    await expect(downloadBox.getByText(d['detail.rateLimited'], { exact: false })).toBeVisible({ timeout: 15_000 });
    expect(await page.evaluate(() => (window as unknown as { __fressBrowserOpens: string[] }).__fressBrowserOpens)).toEqual([]);

    // The resolver recovers (the 403 route is lifted, fixtures answer):
    // the SAME Retry control performs the fresh lookup and the resolved
    // pick appears - the failure path ends where it began, in-app.
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    const { installNetworkPolicy } = await import('./netpolicy');
    await installNetworkPolicy(page, {});
    await retry.click();
    await expect(downloadBox.getByRole('button', { name: /LocalSend-1\.17\.0-windows-x64\.exe/ })).toBeVisible({ timeout: 15_000 });
    expect(await page.evaluate(() => (window as unknown as { __fressBrowserOpens: string[] }).__fressBrowserOpens)).toEqual([]);
  });
});

test.describe('Workflow C2: repeated HTTP 500 in browser mode', () => {
  test('C-N5 - repeated 500s across re-queries stay the honest fallback state, never a browser handoff', async ({ gotoApp, page }) => {
    await gotoApp();
    const d = DICTS.en;

    // A persistent 500 on the repo's whole releases API (both the latest
    // lookup and the recent-release scan), registered AFTER the fixture
    // layer so it wins.
    await page.route(/https:\/\/api\.github\.com\/repos\/localsend\/localsend\/releases/, (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"Internal Server Error"}' })
    );

    await page.context().addInitScript(() => {
      const recorded: string[] = [];
      (window as unknown as { __fressBrowserOpens: string[] }).__fressBrowserOpens = recorded;
      window.open = ((url?: string | URL) => {
        recorded.push(String(url ?? ''));
        return null;
      }) as typeof window.open;
    });
    await page.reload();

    await page.locator('#app-title-localsend').click();
    const downloadBox = page.locator(sel.detailDownloadBox);
    await expect(downloadBox).toBeVisible();
    await downloadBox.getByRole('button', { name: 'Windows' }).click();
    await expect(downloadBox.getByText(d['detail.noAutoDownload'])).toBeVisible({ timeout: 15_000 });

    // A second re-query hits the same 500s: the state stays honest, and
    // the server failure never opens a browser or starts a transfer.
    await downloadBox.getByRole('button', { name: 'macOS' }).click();
    await expect(downloadBox.getByText(d['detail.noAutoDownload'])).toBeVisible({ timeout: 15_000 });
    await expect(downloadBox.getByText(d['detail.checkingStable'])).toHaveCount(0);
    await expect(downloadBox.getByText(d['detail.allReleases'])).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __fressBrowserOpens: string[] }).__fressBrowserOpens)).toEqual([]);
  });
});
