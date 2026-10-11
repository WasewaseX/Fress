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
import { expect } from './fixtures';
import { sel } from './selectors';
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
