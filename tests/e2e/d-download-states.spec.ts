// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
/**
 * Workflow D - Download state integration (Tauri bridge mode).
 *
 * Injects a deterministic native download stream and covers the full state
 * surface the UI can observe: queued, active (progress), cancellation,
 * failure, retry, verifying -> verified completion, unverified completion.
 * Confirms the panel labels exactly match the native payloads.
 *
 * The checksum-mismatch case is NOT tested by asserting only the label: the
 * test verifies the engine/contract end to end - the item must end in the
 * error state with NO verified flag and NO sha256 advertised, and the
 * persisted download history (the same data a restart would show) must not
 * contain a completed/verified record for that transfer
 * (docs/download-lifecycle.md section 5: "Computing is not verifying").
 */
import { expect, bridge } from './fixtures';
import { sel, openDownloads } from './selectors';
import { test } from './fixtures';
import type { Page } from '@playwright/test';
import { DICTS } from '../../src/lib/i18n';

test.use({ tauriMode: true });

const d = DICTS.en;

/** Starts a transfer from the detail modal's resolved download button.
 * Headless Linux Chromium opens the Linux tab first, so the helper switches
 * to Windows where the seeded fixture answers with a confident pick.
 * `awaitRegistered` polls until the bridge has registered that many
 * downloads (queued transfers never register - pass the current count). */
async function startFromDetail(page: Page, appId: string, assetName: string, awaitRegistered?: number): Promise<void> {
  await page.locator(`#app-title-${appId}`).click();
  const box = page.locator(sel.detailDownloadBox);
  await expect(box).toBeVisible();
  await box.getByRole('button', { name: 'Windows' }).click();
  await expect(box.getByText(assetName, { exact: false })).toBeVisible({ timeout: 15_000 });
  await box.getByRole('button', { name: new RegExp(assetName) }).click();
  await page.keyboard.press('Escape');
  await expect(box).toHaveCount(0);
  // The 'Download started' toast floats top-right for a few seconds and can
  // intercept the next title click - let the toast queue drain first.
  await expect
    .poll(async () => (await page.locator('[data-sonner-toast]').count()), { timeout: 10_000 })
    .toBe(0);
  if (awaitRegistered !== undefined) {
    await expect
      .poll(async () => (await registeredDownloadIds(page)).length, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(awaitRegistered);
  }
}

async function registeredDownloadIds(page: Page): Promise<number[]> {
  const b = (await bridge(page))!;
  return Object.keys(b.downloads).map(Number);
}

/** Lets the toast queue drain: toasts float top-right and would intercept
 * the next click (Workflow D/K convention). */
async function drainToasts(page: Page): Promise<void> {
  await expect
    .poll(async () => page.locator('[data-sonner-toast]').count(), { timeout: 15_000 })
    .toBe(0);
}

test.describe('Workflow D: download state integration', () => {
  test('active transfer shows progress values from the native payloads, then verified completion', async ({ gotoApp, page }) => {
    await gotoApp();
    await startFromDetail(page, 'localsend', 'LocalSend-1.17.0-windows-x64.exe', 1);
    await openDownloads(page);
    await expect(page.locator(sel.downloadRow('active'))).toHaveCount(1);

    const [id] = await registeredDownloadIds(page);
    const row = page.locator(sel.downloadRow('active')).first();

    // Labels match the native state and payload; no fabricated numbers.
    await expect(row).toContainText(d['downloads.active']);
    await expect(row).toContainText('LocalSend-1.17.0-windows-x64.exe');

    await page.evaluate((did) => window.__fressTest!.emitProgress(did, 12_582_912, 25_165_824, 4_194_304, 3), id);
    const bar = row.getByRole('progressbar');
    await expect(bar).toHaveAttribute('aria-valuenow', '50');
    await expect(row).toContainText('4.0 MB/s');

    // Verification window: bytes are all on disk, the commit decision is
    // pending - the UI must NOT claim completion early.
    await page.evaluate((did) => window.__fressTest!.emitProgress(did, 25_165_824, 25_165_824, 0, 0), id);
    await expect(bar).toHaveAttribute('aria-valuenow', '100');
    await expect(page.locator(sel.downloadRow('completed'))).toHaveCount(0);
    await expect(page.locator(sel.downloadRow('active'))).toHaveCount(1);

    // Verified completion: verified=true in the native payload (the sha256
    // below is a fixed fixture digest; the UI renders what the engine sent).
    await page.evaluate(
      (did) =>
        window.__fressTest!.emitComplete(
          did,
          '/home/test/Downloads/LocalSend-1.17.0-windows-x64.exe',
          25_165_824,
          '9f2c0d3b7a1e5f8c6b4d2e0a9f7c3b5d1e8f6a4c2b0d3e5f7a9c1b3d5e7f9a0b',
          true
        ),
      id
    );
    await expect(page.locator(sel.downloadRow('completed'))).toHaveCount(1);
    const done = page.locator(sel.downloadRow('completed')).first();
    await expect(done).toContainText(d['downloads.verified']);
    await expect(done).toContainText('9f2c0d3b7a1e5f8c6b4d2e0a9f7c3b5d');

    // The active-count badge in the header cleared.
    await expect(page.locator(sel.downloadsActiveBadge)).toHaveCount(0);
  });

  test('unverified completion is labelled Done, never Verified', async ({ gotoApp, page }) => {
    await gotoApp();
    await startFromDetail(page, 'localsend', 'LocalSend-1.17.0-windows-x64.exe', 1);
    await openDownloads(page);
    const [id] = await registeredDownloadIds(page);

    // verified is absent (not false): the engine computed a digest but no
    // trusted reference existed - exactly the Unverified contract.
    await page.evaluate(
      (did) =>
        window.__fressTest!.emitComplete(
          did,
          '/home/test/Downloads/LocalSend-1.17.0-windows-x64.exe',
          25_165_824,
          '9f2c0d3b7a1e5f8c6b4d2e0a9f7c3b5d1e8f6a4c2b0d3e5f7a9c1b3d5e7f9a0b',
          undefined
        ),
      id
    );
    const done = page.locator(sel.downloadRow('completed')).first();
    await expect(done).toContainText(d['downloads.completed']);
    await expect(done).not.toContainText(d['downloads.verified']);
  });

  test('cancellation reaches the engine, ends in Cancelled and offers Resume', async ({ gotoApp, page }) => {
    await gotoApp();
    await startFromDetail(page, 'localsend', 'LocalSend-1.17.0-windows-x64.exe');
    await openDownloads(page);
    const [id] = await registeredDownloadIds(page);

    await page.locator(sel.downloadRow('active')).first().getByRole('button', { name: d['downloads.cancel'] }).click();

    // The engine received cancel_download for exactly this id, and the
    // terminal Cancelled event lands as the cancelled state.
    await expect
      .poll(async () => {
        const cur = (await bridge(page))!;
        const call = cur.calls.filter((c) => c.cmd === 'cancel_download');
        return call.length > 0 && (call[call.length - 1].args as { id?: number } | null)?.id === id;
      })
      .toBe(true);
    await expect(page.locator(sel.downloadRow('cancelled'))).toHaveCount(1);
    await expect(page.locator(sel.downloadRow('cancelled')).first()).toContainText(d['downloads.cancelled']);
    await expect(page.locator(sel.downloadRow('cancelled')).first().getByRole('button', { name: d['downloads.resume'] })).toBeVisible();

    // Resume re-dispatches with resume=true and the ORIGINAL url.
    await page.locator(sel.downloadRow('cancelled')).first().getByRole('button', { name: d['downloads.resume'] }).click();
    await expect
      .poll(async () => {
        const cur = (await bridge(page))!;
        const calls = cur.calls.filter((c) => c.cmd === 'start_download');
        const last = calls[calls.length - 1]?.args as { resume?: boolean; url?: string } | null;
        return calls.length >= 2 && last?.resume === true && last?.url === 'https://github.com/localsend/localsend/releases/download/v1.17.0/LocalSend-1.17.0-windows-x64.exe';
      })
      .toBe(true);
  });

  test('checksum mismatch: the item NEVER reports verified completion, in UI and in persisted history', async ({ gotoApp, page }) => {
    await gotoApp();

    // Signal is the app whose OFFICIAL resolver carries a trusted digest
    // (sha512 from updates.signal.org/latest.yml - the route fixture). That
    // is the path where the app can genuinely verify a payload, so it is the
    // path where a mismatch contract can be exercised end to end.
    await page.locator('#app-title-signal').click();
    const box = page.locator(sel.detailDownloadBox);
    await expect(box).toBeVisible();
    await box.getByRole('button', { name: 'Windows' }).click();
    await expect(box.getByText('signal-desktop-win-x64-7.20.0.exe', { exact: false })).toBeVisible({ timeout: 15_000 });
    await box.getByRole('button', { name: /signal-desktop-win-x64-7\.20\.0\.exe/ }).click();
    await page.keyboard.press('Escape');
    await expect(box).toHaveCount(0);

    await openDownloads(page);
    const [id] = await registeredDownloadIds(page);
    const b0 = (await bridge(page))!;
    // The official resolver handed the engine the trusted digest.
    expect(b0.downloads[id].expectedSha512, 'resolver must hand the engine a trusted digest').toBeTruthy();

    await page.evaluate((did) => window.__fressTest!.emitProgress(did, 178_257_920, 178_257_920, 0, 0), id);
    // Engine: mismatch with kind=checksum (corrupt artifact deleted on disk;
    // resume is pointless, only a fresh retry is sound).
    await page.evaluate((did) => window.__fressTest!.emitError(did, 'SHA-512 mismatch: artifact is corrupt and was deleted', 'checksum'), id);

    const errRow = page.locator(sel.downloadRow('error')).first();
    await expect(errRow).toContainText(d['downloads.failed']);
    await expect(errRow).toContainText('SHA-512 mismatch');

    // The contract, not just the label:
    // 1. no completed event was ever delivered to the UI,
    const cur = (await bridge(page))!;
    expect(cur.emits.filter((e) => e.event === 'download-complete')).toHaveLength(0);
    // 2. the panel holds NO completed row,
    await expect(page.locator(sel.downloadRow('completed'))).toHaveCount(0);
    // 3. the persisted history (what a restart would show) records an error,
    //    never a verified completion, for this transfer.
    const persisted = await page.evaluate(() => localStorage.getItem('fress.downloadItems.v1') ?? '');
    expect(persisted).toContain('"status":"error"');
    expect(persisted).not.toContain('"status":"completed"');
    expect(persisted).not.toContain('"verified":true');

    // The offered action is Retry (fresh), not Resume (bytes were deleted).
    await expect(errRow.getByRole('button', { name: d['downloads.retry'] })).toBeVisible();
    await expect(errRow.getByRole('button', { name: d['downloads.resume'] })).toHaveCount(0);

    // Retry re-dispatches a FRESH download (resume=false).
    await errRow.getByRole('button', { name: d['downloads.retry'] }).click();
    await expect
      .poll(async () => {
        const cur2 = (await bridge(page))!;
        const calls = cur2.calls.filter((c) => c.cmd === 'start_download');
        const last = calls[calls.length - 1]?.args as { resume?: boolean } | null;
        return calls.length >= 2 && last?.resume === false;
      })
      .toBe(true);
  });

  test('network failure keeps a resumable transfer; retrying event keeps the row active', async ({ gotoApp, page }) => {
    await gotoApp();
    await startFromDetail(page, 'localsend', 'LocalSend-1.17.0-windows-x64.exe');
    await openDownloads(page);
    const [id] = await registeredDownloadIds(page);

    // The engine announces an automatic retry (section 8 of the lifecycle
    // doc); the UI stays active and explains the reconnect.
    await page.evaluate((did) => window.__fressTest!.emitProgress(did, 5_242_880, 25_165_824, 2_097_152, 10), id);
    await page.evaluate((did) => window.__fressTest!.emitRetrying(did, 1, 'connection reset'), id);
    await expect(page.locator(sel.downloadRow('active'))).toHaveCount(1);

    // Budget exhausted: terminal failure, resumable bytes kept on disk.
    await page.evaluate((did) => window.__fressTest!.emitError(did, 'Network error: connection lost', 'network'), id);
    const errRow = page.locator(sel.downloadRow('error')).first();
    await expect(errRow).toContainText(d['downloads.failed']);
    await expect(errRow.getByRole('button', { name: d['downloads.resume'] })).toBeVisible();
  });

  test('queue: three run at once, the rest wait, promotion and queued-removal behave', async ({ gotoApp, page }) => {
    await gotoApp();

    // Fill all three slots.
    await startFromDetail(page, 'localsend', 'LocalSend-1.17.0-windows-x64.exe', 1);
    await startFromDetail(page, 'vlc', 'vlc-3.0.21-win64.exe', 2);
    await startFromDetail(page, 'obsidian', 'Obsidian-1.10.0.exe', 3);
    // A fourth transfer waits in the FIFO queue (never reaches the engine)...
    await startFromDetail(page, 'sharex', 'ShareX-17.1.0-setup.exe');
    // ...and a fifth joins the line behind it. Both happen BEFORE the panel
    // opens: the open panel would intercept the next title click. Neither
    // queued transfer ever registers in the engine (count stays 3).
    await startFromDetail(page, 'vlc', 'vlc-3.0.21-win64.exe');

    await openDownloads(page);
    await expect(page.locator(sel.downloadRow('active'))).toHaveCount(3);
    await expect(page.locator(sel.downloadRow('queued'))).toHaveCount(2);
    await expect(page.locator(sel.downloadRow('queued')).first()).toContainText(d['downloads.queued']);

    // Completing one transfer frees ONE slot: the FIFO head (ShareX)
    // promotes into it; the second queued entry keeps waiting.
    const [localsendId] = await registeredDownloadIds(page);
    await page.evaluate((did) => window.__fressTest!.emitComplete(did, '/tmp/localsend.exe', 25_165_824, 'a'.repeat(64), false), localsendId);
    await expect(page.locator(sel.downloadRow('completed'))).toHaveCount(1);
    await expect
      .poll(async () => (await registeredDownloadIds(page)).length, { timeout: 10_000 })
      .toBe(4);
    await expect(page.locator(sel.downloadRow('active'))).toHaveCount(3);
    await expect(page.locator(sel.downloadRow('queued'))).toHaveCount(1);

    // Cancelling the still-queued entry removes it from the line WITHOUT
    // touching the engine (no Rust transfer exists yet to cancel).
    const cancelsBefore = ((await bridge(page))!.calls).filter((c) => c.cmd === 'cancel_download').length;
    await page.locator(sel.downloadRow('queued')).first().getByRole('button', { name: d['downloads.cancel'] }).click();
    await expect(page.locator(sel.downloadRow('queued'))).toHaveCount(0);
    expect(((await bridge(page))!.calls).filter((c) => c.cmd === 'cancel_download').length).toBe(cancelsBefore);
  });
});

/* ------------------------------------------------------------------ */
/* Workflow D2 - the native identity boundary (release qualification)  */
/* ------------------------------------------------------------------ */
/* The contracts the stable-release qualification pins on top of
 * Workflow D above, all reading the bridge's RECORDED traffic rather
 * than labels alone:
 *   - the direct-artifact path is native end to end: start_download is
 *     the ONLY dispatch, and the browser/opener boundaries stay silent;
 *   - a rapid double-click on the same resolved pick starts exactly ONE
 *     transfer (the detail dialog's re-entry guard);
 *   - a native start failure is truthful (typed toast, no row, no
 *     browser fallback) and remains retryable once the engine recovers;
 *   - a restored download-history row is honoured as a record but can
 *     only ever act through the same opener boundary - it never starts
 *     a transfer and never fakes success when the OS refuses;
 *   - a platform switch and a modal dismissal can never apply a stale
 *     resolver result: superseded picks disappear and no transfer is
 *     dispatched from an old key.
 * This suite runs against the mocked bridge (tauri-bridge.ts) in a
 * desktop Chromium: it proves the FRONTEND contract, not a real
 * installer launching - that remains the packaged-app smoke matrix. */

test.describe('Workflow D2: the native identity boundary', () => {
  test('D2-1 - a valid direct artifact is dispatched natively; the browser and opener boundaries stay silent', async ({ gotoApp, page }) => {
    await gotoApp();
    await startFromDetail(page, 'localsend', 'LocalSend-1.17.0-windows-x64.exe', 1);
    await openDownloads(page);

    // The engine received exactly one dispatch for the resolved asset...
    const b = (await bridge(page))!;
    const starts = b.calls.filter((c) => c.cmd === 'start_download');
    expect(starts).toHaveLength(1);
    expect((starts[0].args as { url?: string }).url).toBe(
      'https://github.com/localsend/localsend/releases/download/v1.17.0/LocalSend-1.17.0-windows-x64.exe'
    );

    // ...and NOTHING else: no external-page handoff, no opener traffic -
    // an installed Tauri runtime never routes a direct download through
    // window.open / openExternal / the file opener.
    expect(b.openedUrls, 'a direct download must never open the browser').toEqual([]);
    expect(b.openedPaths).toHaveLength(0);
    expect(b.revealedPaths).toHaveLength(0);

    // The boundary stays silent while the transfer progresses.
    const [id] = Object.keys(b.downloads).map(Number);
    await page.evaluate((did) => window.__fressTest!.emitProgress(did, 12_582_912, 25_165_824, 4_194_304, 3), id);
    const row = page.locator(sel.downloadRow('active')).first();
    await expect(row.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
    expect(((await bridge(page))!).openedUrls).toEqual([]);
  });

  test('D2-2 - a rapid double-click on the same resolved pick starts exactly one transfer', async ({ gotoApp, page }) => {
    await gotoApp();
    await page.locator('#app-title-localsend').click();
    const box = page.locator(sel.detailDownloadBox);
    await expect(box).toBeVisible();
    await box.getByRole('button', { name: 'Windows' }).click();
    const asset = box.getByRole('button', { name: /LocalSend-1\.17\.0-windows-x64\.exe/ });
    await expect(asset).toBeVisible({ timeout: 15_000 });

    // Two activations inside the re-entry window (1500 ms): the second is
    // a no-op by contract - one URL, one transfer.
    await asset.click();
    await asset.click();
    await page.keyboard.press('Escape');
    await expect(box).toHaveCount(0);
    await drainToasts(page);

    await expect
      .poll(async () => (await bridge(page))!.calls.filter((c) => c.cmd === 'start_download').length, { timeout: 10_000 })
      .toBe(1);
    expect(Object.keys((await bridge(page))!.downloads)).toHaveLength(1);
  });

  test('D2-3 - a native start failure is truthful: typed error, no row, no browser fallback, and it stays retryable', async ({ gotoApp, page }) => {
    await gotoApp();
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(String((e as Error)?.message ?? e)));
    await page.locator('#app-title-localsend').click();
    const box = page.locator(sel.detailDownloadBox);
    await expect(box).toBeVisible();
    await box.getByRole('button', { name: 'Windows' }).click();
    const asset = box.getByRole('button', { name: /LocalSend-1\.17\.0-windows-x64\.exe/ });
    await expect(asset).toBeVisible({ timeout: 15_000 });

    // The engine refuses the dispatch: the user learns the truth (the
    // typed toast carries the engine's own message), no row is inserted,
    // and the failure never degrades into "open the page in a browser".
    await page.evaluate(() => window.__fressTest!.setFailStart('engine: disk I/O failed'));
    await asset.click();
    const failureToast = page.locator('[data-sonner-toast]').first();
    await expect(failureToast).toBeVisible();
    await expect(failureToast).toContainText(d['downloads.toast.startFailed']);
    await expect(failureToast).toContainText('engine: disk I/O failed');

    const b = (await bridge(page))!;
    expect(Object.keys(b.downloads)).toHaveLength(0);
    expect(b.openedUrls, 'a failed start must not fall back to the browser').toEqual([]);

    // The rejection was a handled promise, and the panel shows no row.
    await drainToasts(page);
    expect(pageErrors).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(page.locator(sel.detailDownloadBox)).toHaveCount(0);
    await openDownloads(page);
    await expect(page.locator(sel.downloadRow('active'))).toHaveCount(0);
    await expect(page.locator(sel.downloadRow('error'))).toHaveCount(0);

    // Once the engine recovers, the SAME pick starts - the failure was a
    // dead end, not a disabled button (past the 1500 ms re-entry window).
    await page.evaluate(() => window.__fressTest!.setFailStart(null));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1_600);
    await page.locator('#app-title-localsend').click();
    const box2 = page.locator(sel.detailDownloadBox);
    await expect(box2).toBeVisible();
    await box2.getByRole('button', { name: 'Windows' }).click();
    const asset2 = box2.getByRole('button', { name: /LocalSend-1\.17\.0-windows-x64\.exe/ });
    await expect(asset2).toBeVisible({ timeout: 15_000 });
    await asset2.click();
    await expect
      .poll(async () => Object.keys((await bridge(page))!.downloads).length, { timeout: 10_000 })
      .toBe(1);
    const started = ((await bridge(page))!.calls.filter((c) => c.cmd === 'start_download').pop()!.args) as { url?: string };
    expect(started.url).toBe('https://github.com/localsend/localsend/releases/download/v1.17.0/LocalSend-1.17.0-windows-x64.exe');
  });

  test('D2-4 - a restored download-history row acts only through the opener boundary and never fakes success', async ({ gotoApp, page }) => {
    // A history row the running app never produced: whoever (or whatever)
    // wrote it into the persisted store, the restored panel may only ever
    // act on it through the same recorded boundary as any other row - no
    // transfer restart, no fabricated success when the OS refuses.
    const FORGED_PATH = '/home/test/Downloads/LocalSend-1.17.0-windows-x64.exe';
    const FORGED_ROW = [
      {
        url: 'https://github.com/localsend/localsend/releases/download/v1.17.0/LocalSend-1.17.0-windows-x64.exe',
        name: 'LocalSend-1.17.0-windows-x64.exe',
        dir: '/home/test/Downloads',
        bytes: 25_165_824,
        total: 25_165_824,
        status: 'completed',
        path: FORGED_PATH,
        sha256: 'c'.repeat(64),
        verified: true,
        startedAt: 1_700_000_000_000,
      },
    ];
    await page.context().addInitScript((rows) => {
      localStorage.setItem('fress.downloadItems.v1', JSON.stringify(rows));
    }, FORGED_ROW);

    await gotoApp();
    await openDownloads(page);
    const row = page.locator(sel.downloadRow('completed')).first();
    await expect(row).toBeVisible();
    await expect(row).toContainText('LocalSend-1.17.0-windows-x64.exe');

    // The OS refuses the open: the restored row reports the failure
    // honestly and stays a record - it cannot conjure a success.
    await page.evaluate(() => window.__fressTest!.setFailOpenPath('Permission denied'));
    await row.getByRole('button', { name: d['downloads.openFile'] }).click();
    await expect(page.getByText(d['downloads.toast.openFileFailed'])).toBeVisible();

    // Exactly ONE boundary invocation with the row's OWN path as a value,
    // and nothing else: no browser handoff, no transfer restart.
    const traffic = page.evaluate(() => ({
      open: window.__fressTest!.openedPaths,
      urls: window.__fressTest!.openedUrls,
    }));
    expect((await traffic).open).toHaveLength(1);
    expect((await traffic).open[0].path).toBe(FORGED_PATH);
    expect((await traffic).urls).toEqual([]);
    expect(Object.keys((await bridge(page))!.downloads)).toHaveLength(0);

    // When the OS allows it, the same single boundary call carries the
    // same exact path - the restored record never gains any other route.
    await drainToasts(page);
    await page.evaluate(() => window.__fressTest!.setFailOpenPath(null));
    await row.getByRole('button', { name: d['downloads.openFile'] }).click();
    await expect
      .poll(async () => (await page.evaluate(() => window.__fressTest!.openedPaths)).length, { timeout: 10_000 })
      .toBe(2);
    expect((await page.evaluate(() => window.__fressTest!.openedPaths))[1].path).toBe(FORGED_PATH);
    expect(Object.keys((await bridge(page))!.downloads)).toHaveLength(0);
  });

  test('D2-5 - a platform switch and a modal dismissal can never apply a stale resolver result', async ({ gotoApp, page }) => {
    await gotoApp();
    await page.locator('#app-title-localsend').click();
    const box = page.locator(sel.detailDownloadBox);
    await expect(box).toBeVisible();
    await box.getByRole('button', { name: 'Windows' }).click();
    await expect(box.getByText('LocalSend-1.17.0-windows-x64.exe', { exact: false })).toBeVisible({ timeout: 15_000 });

    // Switch to macOS: the Windows pick is superseded. Its button must be
    // GONE (a stale result can neither stay clickable nor start), and the
    // fixture's macOS side honestly reports no ready-made file.
    await box.getByRole('button', { name: 'macOS' }).click();
    await expect(box.getByText('LocalSend-1.17.0-windows-x64.exe', { exact: false })).toHaveCount(0, { timeout: 15_000 });
    await expect(box.getByRole('button', { name: /LocalSend-1\.17\.0-windows-x64\.exe/ })).toHaveCount(0);

    // Dismiss the dialog mid-resolution and reopen on the original
    // platform: a fresh resolve answers, the pick is the same asset, and
    // the whole journey so far dispatched nothing.
    await page.keyboard.press('Escape');
    await expect(box).toHaveCount(0);
    await page.locator('#app-title-localsend').click();
    const box2 = page.locator(sel.detailDownloadBox);
    await expect(box2).toBeVisible();
    await box2.getByRole('button', { name: 'Windows' }).click();
    const asset = box2.getByRole('button', { name: /LocalSend-1\.17\.0-windows-x64\.exe/ });
    await expect(asset).toBeVisible({ timeout: 15_000 });

    const b0 = (await bridge(page))!;
    expect(b0.calls.filter((c) => c.cmd === 'start_download'), 'no stale dispatch during switches').toHaveLength(0);
    expect(b0.openedUrls).toEqual([]);

    // The pick that finally starts is the freshly resolved one.
    await asset.click();
    await expect
      .poll(async () => Object.keys((await bridge(page))!.downloads).length, { timeout: 10_000 })
      .toBe(1);
    const started = ((await bridge(page))!.calls.filter((c) => c.cmd === 'start_download').pop()!.args) as { url?: string };
    expect(started.url).toBe('https://github.com/localsend/localsend/releases/download/v1.17.0/LocalSend-1.17.0-windows-x64.exe');
  });
});
