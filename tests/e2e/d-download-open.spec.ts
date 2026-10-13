// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
/**
 * Workflow D2 - Download-to-open integration (Tauri bridge mode).
 *
 * Owns the OPEN half of the download journey: the completed file must be
 * openable, the open action must reach the native opener with the EXACT
 * path of THAT download, and every failure (opener rejection, reveal
 * rejection, premature or invalid state) must be handled without false
 * claims, stuck controls or unhandled rejections.
 *
 * The contract below was read off the implementation (coordination with the
 * implementation owner; nothing here invents a parallel UI contract):
 *   - completion:  'download-complete' {id, path, bytes, sha256, verified?}
 *     -> item status 'completed', row [data-status="completed"]
 *   - Open control: accessible name i18n 'downloads.openFile' ("Open file"),
 *     rendered ONLY for completed items carrying a path; never disabled
 *   - Show in folder: i18n 'downloads.showFolder' ("Show in folder"),
 *     rendered on completed rows except under isAndroidWebview()
 *   - native boundary: plugin:opener|open_path {path} for Open;
 *     plugin:opener|reveal_item_in_dir {paths:[path]} for Show in folder,
 *     falling back to openPath(plugin:path|dirname) when the reveal rejects
 *   - feedback: failure toasts 'Could not open the file' / 'Could not open
 *     the folder'; a SUCCESSFUL open is silent by design (the OS taking
 *     over is not something the webview can truthfully confirm)
 *
 * Honesty boundary of this suite: a green test here proves the FRONTEND
 * passed the exact completed path to the opener adapter and handled its
 * result. It does NOT prove a real installer launched, a real file manager
 * revealed anything, or Android's PackageInstaller took an intent - those
 * are native surfaces covered by docs/testing/download-open-smoke.md.
 */
import { expect, bridge, test, waitForCatalogReady } from './fixtures';
import { sel, openDownloads } from './selectors';
import type { Locator, Page } from '@playwright/test';
import { DICTS } from '../../src/lib/i18n';

test.use({ tauriMode: true });

const d = DICTS.en;
const OPEN_FILE = d['downloads.openFile'];
const SHOW_FOLDER = d['downloads.showFolder'];
const OPEN_FAILED = d['downloads.toast.openFileFailed'];
const FOLDER_FAILED = d['downloads.toast.openFolderFailed'];

/** Realistic Android webview identity for the Android routing scenario
 * (scenario H): matches the app's isAndroidWebview()/isAndroidDevice check
 * (/android/i on navigator.userAgent) like a real device build does. */
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

// ---------------------------------------------------------------------------
// Helpers. The start-from-detail flow follows the proven pattern of
// d-download-states.spec.ts (toast interception between starts, registration
// polling); the toast/observation helpers are local to this file.
// ---------------------------------------------------------------------------

/** Starts a transfer from the detail modal's resolved download button. */
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
  await drainToasts(page);
  if (awaitRegistered !== undefined) {
    await expect
      .poll(async () => (await registeredIds(page)).length, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(awaitRegistered);
  }
}

/** Engine-registered download ids, in registration order. */
async function registeredIds(page: Page): Promise<number[]> {
  const b = (await bridge(page))!;
  return Object.keys(b.downloads).map(Number);
}

/** Delivers a completion event exactly as the Rust engine would. */
async function complete(
  page: Page,
  id: number,
  path: string | undefined,
  bytes: number,
  sha256: string,
  verified?: boolean
): Promise<void> {
  await page.evaluate(
    ({ did, p, b, s, v }) => window.__fressTest!.emitComplete(did, p as string, b, s, v),
    { did: id, p: path, b: bytes, s: sha256, v: verified }
  );
}

/** Waits for the sonner toast queue to empty (toasts overlay the panel). */
async function drainToasts(page: Page): Promise<void> {
  await expect
    .poll(async () => await page.locator('[data-sonner-toast]').count(), { timeout: 10_000 })
    .toBe(0);
}

/** Installs a MutationObserver that records every toast that mounts from
 * now on (resets both counters). `__toastMounts` counts toast ELEMENTS (so
 * two identical messages from a leaked duplicate listener count twice);
 * `__toastLog` keeps the unique texts for content assertions. No sleeps:
 * after a deterministic render settle, the log IS the complete set of
 * messages the UI produced since tracking started. */
async function trackToasts(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __toastLog?: string[];
      __toastMounts?: number;
      __toastObs?: MutationObserver;
    };
    w.__toastObs?.disconnect();
    w.__toastLog = [];
    w.__toastMounts = 0;
    w.__toastObs = new MutationObserver((muts) => {
      for (const m of muts) {
        m.addedNodes.forEach((n) => {
          if (!(n instanceof HTMLElement)) return;
          const toast = n.matches('[data-sonner-toast]') ? n : n.querySelector('[data-sonner-toast]');
          if (!toast) return;
          w.__toastMounts = (w.__toastMounts ?? 0) + 1;
          const t = (toast.textContent || '').trim();
          if (t && !w.__toastLog!.includes(t)) w.__toastLog!.push(t);
        });
      }
    });
    w.__toastObs.observe(document.body, { childList: true, subtree: true });
  });
}

/** Toast elements mounted since trackToasts(). */
async function toastMounts(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __toastMounts?: number }).__toastMounts ?? 0);
}

async function toastLog(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __toastLog?: string[] }).__toastLog ?? []);
}

/** Two animation frames: every synchronous state update React schedules in
 * response to a click has been committed after this (no timed sleeps). */
async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
}

/** Paths handed to plugin:opener|open_path, in call order. The shared
 * bridge records the unified { cmd, id, path, with } tuple (one array for
 * the opener boundary AND the validated AppImage launcher); D2's
 * assertions read the flat path values, so project them here. */
async function openCalls(page: Page): Promise<string[]> {
  const b = (await bridge(page))!;
  return b.openedPaths.map((r) => r.path);
}

/** Paths handed to plugin:opener|reveal_item_in_dir, in call order
 * (each reveal record carries the paths array it was invoked with). */
async function revealCalls(page: Page): Promise<string[]> {
  const b = (await bridge(page))!;
  return b.revealedPaths.map((r) => r.paths).flat();
}

/** A completed row identified by content (filename or sha prefix). */
function completedRow(page: Page, text: string): Locator {
  return page.locator(sel.downloadRow('completed')).filter({ hasText: text });
}

function openBtnOf(row: Locator): Locator {
  return row.getByRole('button', { name: OPEN_FILE });
}

function showBtnOf(row: Locator): Locator {
  return row.getByRole('button', { name: SHOW_FOLDER });
}

/** Asserts the opener plugin has seen NO opening/reveal traffic at all. */
async function expectNoOpenerTraffic(page: Page): Promise<void> {
  const b = (await bridge(page))!;
  expect(b.calls.filter((c) => c.cmd === 'plugin:opener|open_path')).toHaveLength(0);
  expect(b.calls.filter((c) => c.cmd === 'plugin:opener|reveal_item_in_dir')).toHaveLength(0);
  expect(b.openedPaths).toEqual([]);
  expect(b.revealedPaths).toEqual([]);
}

const BYTES = 25_165_824;

// ---------------------------------------------------------------------------
// A - Successful completion opens the exact final path
// ---------------------------------------------------------------------------

test.describe('Workflow D2: download-to-open', () => {
  test('A: completed download opens the exact final path; the UI claims nothing while the native call is pending', async ({ gotoApp, page }) => {
    await gotoApp();
    await startFromDetail(page, 'localsend', 'LocalSend-1.17.0-windows-x64.exe', 1);
    await openDownloads(page);
    const [id] = await registeredIds(page);
    const PATH = '/home/test/Downloads/LocalSend-1.17.0-windows-x64.exe';
    const SHA = 'a'.repeat(64);

    // Mid-flight: progress renders from the native payload and Open does
    // not exist yet.
    await page.evaluate(
      (p) => window.__fressTest!.emitProgress(p.did, p.downloaded, p.total, p.speed, p.eta),
      { did: id, downloaded: 12_582_912, total: BYTES, speed: 4_194_304, eta: 3 }
    );
    const activeRow = page.locator(sel.downloadRow('active')).first();
    await expect(activeRow.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
    await expect(openBtnOf(activeRow)).toHaveCount(0);

    // Verified completion with a known id/path/size/digest.
    await complete(page, id, PATH, BYTES, SHA, true);
    const done = completedRow(page, 'LocalSend-1.17.0-windows-x64.exe');
    await expect(done).toHaveCount(1);
    await expect(done).toContainText(d['downloads.verified']);
    await expect(done).toContainText(SHA.slice(0, 24));
    await expect(openBtnOf(done)).toBeEnabled();

    // The completion toast is download feedback, not open feedback; drain
    // it so the assertions below observe ONLY open-related messages.
    await drainToasts(page);
    await trackToasts(page);

    // Park the native adapter as pending, then Open.
    await page.evaluate(() => window.__fressTest!.setHoldOpenPath(true));
    await openBtnOf(done).click();
    await settle(page);

    // The opener adapter received the EXACT path from that item's
    // completion event - first argument, byte for byte.
    expect(await openCalls(page)).toEqual([PATH]);
    // And while the native call is in flight the UI has produced NO
    // message at all: no success claim, no premature failure.
    expect(await toastLog(page)).toEqual([]);

    // The adapter resolves (launch handed off to the OS). The design is
    // silent on success - the UI must still not have claimed anything.
    await page.evaluate(() => window.__fressTest!.releaseOpenPath());
    await settle(page);
    expect(await toastLog(page)).toEqual([]);
    await page.evaluate(() => window.__fressTest!.setHoldOpenPath(false));
  });

  // -------------------------------------------------------------------------
  // B - Two concurrent downloads, out-of-order completion
  // -------------------------------------------------------------------------

  test('B: two downloads with distinct names open their own paths after out-of-order completion', async ({ gotoApp, page }) => {
    await gotoApp();
    await startFromDetail(page, 'localsend', 'LocalSend-1.17.0-windows-x64.exe', 1);
    await startFromDetail(page, 'vlc', 'vlc-3.0.21-win64.exe', 2);
    await openDownloads(page);
    const ids = await registeredIds(page);
    const idA = ids[0]; // LocalSend - completed SECOND
    const idB = ids[1]; // VLC - completed FIRST
    const PATH_A = '/home/test/Downloads/LocalSend-1.17.0-windows-x64.exe';
    const PATH_B = '/home/test/Downloads/vlc-3.0.21-win64.exe';

    await complete(page, idB, PATH_B, 41_000_000, 'b'.repeat(64), true);
    await complete(page, idA, PATH_A, BYTES, 'a'.repeat(64), true);

    const rowA = completedRow(page, 'LocalSend-1.17.0-windows-x64.exe');
    const rowB = completedRow(page, 'vlc-3.0.21-win64.exe');
    await expect(rowA).toHaveCount(1);
    await expect(rowB).toHaveCount(1);

    // Completion order was B then A; the user opens A FIRST. The opener
    // must receive A's path (not the most recently completed B path).
    await openBtnOf(rowA).click();
    expect(await openCalls(page)).toEqual([PATH_A]);

    await openBtnOf(rowB).click();
    expect(await openCalls(page)).toEqual([PATH_A, PATH_B]);
  });

  test('B: duplicate display names with collision-safe destinations open their own paths', async ({ gotoApp, page }) => {
    await gotoApp();
    // Two transfers of the SAME asset: identical display names, distinct
    // engine ids, and (as on real disks) collision-safe destination paths.
    await startFromDetail(page, 'vlc', 'vlc-3.0.21-win64.exe', 1);
    await startFromDetail(page, 'vlc', 'vlc-3.0.21-win64.exe', 2);
    await openDownloads(page);
    const ids = await registeredIds(page);
    const PATH_1 = '/home/test/Downloads/vlc-3.0.21-win64.exe';
    const PATH_2 = '/home/test/Downloads/vlc-3.0.21-win64 (1).exe';
    const SHA_1 = 'c'.repeat(64);
    const SHA_2 = 'd'.repeat(64);

    await complete(page, ids[0], PATH_1, 41_000_000, SHA_1, false);
    await complete(page, ids[1], PATH_2, 41_000_000, SHA_2, true);

    // Same visible filename -> disambiguate rows by their sha content.
    const row1 = completedRow(page, SHA_1.slice(0, 24));
    const row2 = completedRow(page, SHA_2.slice(0, 24));
    await expect(row1).toHaveCount(1);
    await expect(row2).toHaveCount(1);

    // Open the NEWER transfer first: no "last completed path" shortcut.
    await openBtnOf(row2).click();
    expect(await openCalls(page)).toEqual([PATH_2]);

    await openBtnOf(row1).click();
    expect(await openCalls(page)).toEqual([PATH_2, PATH_1]);
  });

  // -------------------------------------------------------------------------
  // C - Open is forbidden before (and outside) completion
  // -------------------------------------------------------------------------

  test('C: queued/active/verifying/failed/cancelled rows offer no Open and keyboard activation never reaches the opener', async ({ gotoApp, page }) => {
    await gotoApp();
    // Fill all three engine slots, then let a fourth transfer queue.
    await startFromDetail(page, 'localsend', 'LocalSend-1.17.0-windows-x64.exe', 1);
    await startFromDetail(page, 'vlc', 'vlc-3.0.21-win64.exe', 2);
    await startFromDetail(page, 'obsidian', 'Obsidian-1.10.0.exe', 3);
    await startFromDetail(page, 'sharex', 'ShareX-17.1.0-setup.exe'); // queued
    await openDownloads(page);

    // QUEUED: no Open control in the row at all - a control that is not in
    // the DOM cannot be keyboard-activated either.
    const queuedRow = page.locator(sel.downloadRow('queued')).filter({ hasText: 'ShareX-17.1.0-setup.exe' });
    await expect(queuedRow).toHaveCount(1);
    await expect(openBtnOf(queuedRow)).toHaveCount(0);
    await expect(showBtnOf(queuedRow)).toHaveCount(0);

    // Completion frees a slot; ShareX promotes to ACTIVE.
    const ids = await registeredIds(page);
    const localsendId = ids[0];
    await complete(page, localsendId, '/home/test/Downloads/LocalSend-1.17.0-windows-x64.exe', BYTES, 'a'.repeat(64), true);
    await expect
      .poll(async () => (await registeredIds(page)).length, { timeout: 10_000 })
      .toBe(4);
    // The promoted transfer's engine id exists only after the promotion.
    const sharexId = (await registeredIds(page))[3];
    const activeSharex = page.locator(sel.downloadRow('active')).filter({ hasText: 'ShareX-17.1.0-setup.exe' });
    await expect(activeSharex).toHaveCount(1);
    await expect(openBtnOf(activeSharex)).toHaveCount(0);

    // VERIFYING window: every byte is on disk but the commit decision is
    // pending - the row is still active and must not offer Open.
    await page.evaluate((did) => window.__fressTest!.emitProgress(did, 8_000_000, 8_000_000, 0, 0), sharexId);
    await expect(activeSharex.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
    await expect(page.locator(sel.downloadRow('completed'))).toHaveCount(1); // only LocalSend
    await expect(openBtnOf(activeSharex)).toHaveCount(0);

    // FAILED: terminal network error keeps resumable bytes; no Open.
    await page.evaluate((did) => window.__fressTest!.emitError(did, 'Network error: connection lost', 'network'), sharexId);
    const failedSharex = page.locator(sel.downloadRow('error')).filter({ hasText: 'ShareX-17.1.0-setup.exe' });
    await expect(failedSharex).toHaveCount(1);
    await expect(openBtnOf(failedSharex)).toHaveCount(0);

    // Keyboard probe on a non-Open control of a non-completed row: Enter
    // activates Resume (a fresh engine dispatch) - never the opener.
    await failedSharex.getByRole('button', { name: d['downloads.resume'] }).focus();
    await page.keyboard.press('Enter');
    await expect
      .poll(async () => {
        const b = (await bridge(page))!;
        const starts = b.calls.filter((c) => c.cmd === 'start_download');
        return (starts.length > 0 && (starts[starts.length - 1].args as { resume?: boolean } | null)?.resume === true) as boolean;
      })
      .toBe(true);

    // CANCELLED via keyboard too: Space on Cancel ends VLC's transfer.
    const activeVlc = page.locator(sel.downloadRow('active')).filter({ hasText: 'vlc-3.0.21-win64.exe' });
    await activeVlc.getByRole('button', { name: d['downloads.cancel'] }).focus();
    await page.keyboard.press('Space');
    const cancelledVlc = page.locator(sel.downloadRow('cancelled')).filter({ hasText: 'vlc-3.0.21-win64.exe' });
    await expect(cancelledVlc).toHaveCount(1);
    await expect(openBtnOf(cancelledVlc)).toHaveCount(0);

    // Contrast: the ONE completed row does offer Open (still not clicked),
    // and the opener adapter was never contacted during the whole journey.
    await expect(openBtnOf(completedRow(page, 'LocalSend-1.17.0-windows-x64.exe'))).toBeEnabled();
    await expectNoOpenerTraffic(page);
  });

  // -------------------------------------------------------------------------
  // D - Opener failure: surfaced, recoverable, silent on retry, no leaks
  // -------------------------------------------------------------------------

  test('D: opener rejection shows a useful error, keeps the row openable, and retries without re-downloading', async ({ gotoApp, page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    await gotoApp();
    await startFromDetail(page, 'localsend', 'LocalSend-1.17.0-windows-x64.exe', 1);
    await openDownloads(page);
    const [id] = await registeredIds(page);
    const PATH = '/home/test/Downloads/LocalSend-1.17.0-windows-x64.exe';
    await complete(page, id, PATH, BYTES, 'a'.repeat(64), true);
    await drainToasts(page);

    const done = completedRow(page, 'LocalSend-1.17.0-windows-x64.exe');
    const openBtn = openBtnOf(done);

    // The native adapter rejects (representative OS error).
    await page.evaluate(() => window.__fressTest!.setFailOpenPath('No such file or directory (os error 2)'));
    await trackToasts(page);
    await openBtn.click();
    await expect(page.locator('[data-sonner-toast]').filter({ hasText: OPEN_FAILED })).toHaveCount(1);

    // The row does NOT report a successful opening: the chip still tells
    // the truth about the download, and the control is usable again.
    await expect(done).toContainText(d['downloads.verified']);
    await expect(openBtn).toBeEnabled();
    expect(await openCalls(page)).toEqual([PATH]);

    // Retry: a second click reaches the adapter again; no new download was
    // started for it.
    await drainToasts(page);
    await openBtn.click();
    await expect(page.locator('[data-sonner-toast]').filter({ hasText: OPEN_FAILED })).toHaveCount(1);
    expect(await openCalls(page)).toEqual([PATH, PATH]);
    const b1 = (await bridge(page))!;
    expect(b1.calls.filter((c) => c.cmd === 'start_download')).toHaveLength(1);

    // The fault clears; the next open resolves. No NEW failure message is
    // produced for a successful open (silent success by design).
    await page.evaluate(() => window.__fressTest!.setFailOpenPath(null));
    await drainToasts(page);
    await trackToasts(page);
    await openBtn.click();
    await settle(page);
    expect(await toastLog(page)).not.toContain(OPEN_FAILED);
    expect(await openCalls(page)).toEqual([PATH, PATH, PATH]);
    const b2 = (await bridge(page))!;
    expect(b2.calls.filter((c) => c.cmd === 'start_download')).toHaveLength(1);

    // The rejection was handled (toast) - no unhandled promise rejection
    // reached the page.
    expect(pageErrors).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // E - Show in folder: exact reveal, parent-dir fallback, both failing
  // -------------------------------------------------------------------------

  test('E: Show in folder reveals the exact file, falls back to the parent directory, and reports when both fail', async ({ gotoApp, page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    await gotoApp();
    await startFromDetail(page, 'localsend', 'LocalSend-1.17.0-windows-x64.exe', 1);
    await openDownloads(page);
    const [id] = await registeredIds(page);
    const PATH = '/home/test/Downloads/LocalSend-1.17.0-windows-x64.exe';
    const DIR = '/home/test/Downloads';
    await complete(page, id, PATH, BYTES, 'a'.repeat(64), true);
    await drainToasts(page);

    const row = completedRow(page, 'LocalSend-1.17.0-windows-x64.exe');
    const showBtn = showBtnOf(row);
    await expect(showBtn).toBeEnabled();

    // 1. Happy path: reveal receives the EXACT completed file path.
    await showBtn.click();
    await settle(page);
    expect(await revealCalls(page)).toEqual([PATH]);
    expect(await openCalls(page)).toEqual([]);

    // 2. Reveal fails (e.g. a Windows build without the shell integration):
    //    the parent DIRECTORY is opened instead - never the file itself.
    await page.evaluate(() => window.__fressTest!.setFailReveal('Explorer integration missing'));
    await drainToasts(page);
    await trackToasts(page);
    await showBtn.click();
    await settle(page);
    expect(await revealCalls(page)).toEqual([PATH, PATH]);
    expect(await openCalls(page)).toEqual([DIR]);
    expect(await toastLog(page)).toEqual([]); // fallback succeeded: no error

    // 3. Both operations fail: an understandable error is shown.
    await page.evaluate(() => window.__fressTest!.setFailOpenPath('Permission denied'));
    await drainToasts(page);
    await trackToasts(page);
    await showBtn.click();
    await settle(page);
    // The shipped failure toast renders the title WITH its typed
    // description appended, so match the title as a substring.
    expect(await toastLog(page)).toEqual([expect.stringContaining(FOLDER_FAILED)])

    // Call order at the adapter boundary: every reveal precedes its own
    // fallback open; no other opener traffic exists.
    const b = (await bridge(page))!;
    const seq = b.calls
      .filter((c) => c.cmd === 'plugin:opener|reveal_item_in_dir' || c.cmd === 'plugin:opener|open_path')
      .map((c) => c.cmd);
    expect(seq).toEqual([
      'plugin:opener|reveal_item_in_dir',
      'plugin:opener|reveal_item_in_dir',
      'plugin:opener|open_path',
      'plugin:opener|reveal_item_in_dir',
      'plugin:opener|open_path',
    ]);
    expect(pageErrors).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // F - Integrity and invalid-payload protection
  // -------------------------------------------------------------------------

  test('F: a checksum-mismatched (deleted) artifact is never openable; the offered recovery is a fresh retry', async ({ gotoApp, page }) => {
    await gotoApp();
    await startFromDetail(page, 'localsend', 'LocalSend-1.17.0-windows-x64.exe', 1);
    await openDownloads(page);
    const [id] = await registeredIds(page);

    // All bytes on disk, then the engine's digest gate trips: the corrupt
    // artifact is deleted and a terminal checksum error lands.
    await page.evaluate(
      (p) => window.__fressTest!.emitProgress(p.did, p.downloaded, p.total, 0, 0),
      { did: id, downloaded: BYTES, total: BYTES }
    );
    await page.evaluate(
      (did) => window.__fressTest!.emitError(did, 'SHA-512 mismatch: artifact is corrupt and was deleted', 'checksum'),
      id
    );

    const errRow = page.locator(sel.downloadRow('error')).filter({ hasText: 'LocalSend-1.17.0-windows-x64.exe' });
    await expect(errRow).toContainText(d['downloads.failed']);
    await expect(errRow).toContainText('SHA-512 mismatch');

    // No completed row, no Open control, zero opener traffic: a file that
    // failed verification can never be launched as a completed download.
    await expect(page.locator(sel.downloadRow('completed'))).toHaveCount(0);
    await expect(openBtnOf(errRow)).toHaveCount(0);
    await expect(showBtnOf(errRow)).toHaveCount(0);
    await expectNoOpenerTraffic(page);

    // The sound recovery is a FRESH download (bytes are gone), which is
    // again a non-completed transfer: still no Open.
    await errRow.getByRole('button', { name: d['downloads.retry'] }).click();
    await expect
      .poll(async () => (await registeredIds(page)).length, { timeout: 10_000 })
      .toBe(2);
    const b = (await bridge(page))!;
    const starts = b.calls.filter((c) => c.cmd === 'start_download');
    expect((starts[starts.length - 1].args as { resume?: boolean } | null)?.resume).toBe(false);
    await expect(openBtnOf(page.locator(sel.downloadRow('active')).filter({ hasText: 'LocalSend-1.17.0-windows-x64.exe' }))).toHaveCount(0);
    await expectNoOpenerTraffic(page);
  });

  test('F: completed rows without a usable path offer no Open; unverified-but-completed files open and never claim Verified', async ({ gotoApp, page }) => {
    await gotoApp();
    // Start all three BEFORE opening the panel: an open panel intercepts
    // catalog clicks (the proven Workflow-D constraint).
    await startFromDetail(page, 'vlc', 'vlc-3.0.21-win64.exe', 1);
    await startFromDetail(page, 'obsidian', 'Obsidian-1.10.0.exe', 2);
    await startFromDetail(page, 'sharex', 'ShareX-17.1.0-setup.exe', 3);
    await openDownloads(page);
    const ids = await registeredIds(page);

    // (1) Empty completion path: the engine reported completion but no
    // usable destination - no Open control may appear.
    await complete(page, ids[0], '', 41_000_000, 'c'.repeat(64), true);
    const emptyPathRow = page.locator(sel.downloadRow('completed')).filter({ hasText: 'vlc-3.0.21-win64.exe' });
    await expect(emptyPathRow).toHaveCount(1);
    await expect(openBtnOf(emptyPathRow)).toHaveCount(0);
    await expect(showBtnOf(emptyPathRow)).toHaveCount(0);

    // (2) Completion payload without any path field at all.
    await complete(page, ids[1], undefined, 90_000_000, 'e'.repeat(64), true);
    const noPathRow = page.locator(sel.downloadRow('completed')).filter({ hasText: 'Obsidian-1.10.0.exe' });
    await expect(noPathRow).toHaveCount(1);
    await expect(openBtnOf(noPathRow)).toHaveCount(0);
    await expect(showBtnOf(noPathRow)).toHaveCount(0);

    // (3) Unverified completion (digest computed, no trusted reference -
    // verified absent, NOT false): the design opens the file but the chip
    // must never claim Verified. Pins the intended labeling so a future
    // change cannot silently start launching untrusted files as "verified".
    const PATH = '/home/test/Downloads/ShareX-17.1.0-setup.exe';
    await complete(page, ids[2], PATH, 8_000_000, 'f'.repeat(64), undefined);
    const unverifiedRow = page.locator(sel.downloadRow('completed')).filter({ hasText: 'ShareX-17.1.0-setup.exe' });
    await expect(unverifiedRow).toContainText(d['downloads.completed']);
    await expect(unverifiedRow).not.toContainText(d['downloads.verified']);
    await drainToasts(page);
    await openBtnOf(unverifiedRow).click();
    expect(await openCalls(page)).toEqual([PATH]);

    // Exactly one opener attempt in this whole scenario: the unverified
    // open. The two invalid payloads produced none.
    const b = (await bridge(page))!;
    expect(b.calls.filter((c) => c.cmd === 'plugin:opener|open_path')).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // G - Paths as values + event-listener lifecycle
  // -------------------------------------------------------------------------

  test('G: paths with spaces, Unicode, parentheses and shell-fragment punctuation pass through byte-exact', async ({ gotoApp, page }) => {
    await gotoApp();
    const CASES = [
      { path: '/home/test/Downloads/My Tools (v1.2)/LocalSend setup 1.17.exe' },
      { path: '/home/test/Downloads/برنامه-های من/LocalSend-1.17.0.exe' },
      { path: "/home/test/Downloads/$(rm -rf ~); `cmd` |&.exe" },
      { path: '/home/test/Downloads/报告 (最终版) [x64].exe' },
    ];
    // Four transfers of the same asset (distinct engine ids): three fill
    // the engine slots, the fourth queues and promotes once a slot frees.
    await startFromDetail(page, 'localsend', 'LocalSend-1.17.0-windows-x64.exe', 1);
    await startFromDetail(page, 'localsend', 'LocalSend-1.17.0-windows-x64.exe', 2);
    await startFromDetail(page, 'localsend', 'LocalSend-1.17.0-windows-x64.exe', 3);
    await startFromDetail(page, 'localsend', 'LocalSend-1.17.0-windows-x64.exe');
    await openDownloads(page);
    const ids = await registeredIds(page);

    await drainToasts(page);
    // Completion order is deliberately NOT start order: the queued fourth
    // transfer (registered only once a slot frees) finishes second.
    await complete(page, ids[0], CASES[0].path, BYTES, '1'.repeat(64), true);
    await expect
      .poll(async () => (await registeredIds(page)).length, { timeout: 10_000 })
      .toBe(4);
    const queuedId = (await registeredIds(page))[3];
    await complete(page, queuedId, CASES[1].path, BYTES, '2'.repeat(64), true);
    await complete(page, ids[1], CASES[2].path, BYTES, '3'.repeat(64), true);
    await complete(page, ids[2], CASES[3].path, BYTES, '4'.repeat(64), true);
    await drainToasts(page);

    for (let i = 0; i < CASES.length; i++) {
      const row = completedRow(page, String(i + 1).repeat(24));
      await expect(row).toHaveCount(1);
      await openBtnOf(row).click();
      // The path is passed as a VALUE through the native API: byte-exact,
      // not tokenized, not shell-interpolated, not reconstructed.
      const calls = await openCalls(page);
      expect(calls).toHaveLength(i + 1);
      expect(calls[i]).toBe(CASES[i].path);
    }
  });

  test('G: one completion listener, single-fire completion feedback, and stale events cannot cross-wire rows', async ({ gotoApp, page }) => {
    await gotoApp();

    // Lifecycle: exactly ONE listener registration per download event after
    // boot (the production build does not double-invoke effects; a leaked
    // duplicate would show up here as a second registration).
    const b0 = (await bridge(page))!;
    for (const ev of ['download-progress', 'download-complete', 'download-retrying', 'download-error']) {
      const regs = b0.calls.filter(
        (c) => c.cmd === 'plugin:event|listen' && (c.args as { event?: string } | null)?.event === ev
      );
      expect(regs, `exactly one listener for ${ev}`).toHaveLength(1);
    }

    await startFromDetail(page, 'localsend', 'LocalSend-1.17.0-windows-x64.exe', 1);
    await startFromDetail(page, 'vlc', 'vlc-3.0.21-win64.exe', 2);
    await openDownloads(page);
    const ids = await registeredIds(page);
    const PATH_A = '/home/test/Downloads/LocalSend-1.17.0-windows-x64.exe';
    const SHA_A = 'a'.repeat(64);
    await complete(page, ids[0], PATH_A, BYTES, SHA_A, true);
    await drainToasts(page);

    // A duplicated completion event (as a leaked second listener would
    // effectively produce) must fire the user-visible feedback EXACTLY once.
    await trackToasts(page);
    await complete(page, ids[0], PATH_A, BYTES, SHA_A, true);
    await settle(page);
    expect(await toastMounts(page)).toBe(1);
    expect((await toastLog(page)).some((t) => t.includes('Downloaded'))).toBe(true);
    await expect(page.locator(sel.downloadRow('completed'))).toHaveCount(1);
    await drainToasts(page);

    // B completes; then A's OLD event replays.
    const PATH_B = '/home/test/Downloads/vlc-3.0.21-win64.exe';
    const SHA_B = 'b'.repeat(64);
    await complete(page, ids[1], PATH_B, 41_000_000, SHA_B, true);
    await expect(page.locator(sel.downloadRow('completed'))).toHaveCount(2);
    await drainToasts(page);

    await complete(page, ids[0], PATH_A, BYTES, SHA_A, true); // stale replay of A
    await settle(page);
    const rowA = completedRow(page, SHA_A.slice(0, 24));
    const rowB = completedRow(page, SHA_B.slice(0, 24));
    await expect(rowA).toHaveCount(1);
    await expect(rowB).toHaveCount(1);

    // Opening still maps A->A and B->B; the old event did not reassign or
    // activate anything else.
    await openBtnOf(rowA).click();
    expect(await openCalls(page)).toEqual([PATH_A]);
    await openBtnOf(rowB).click();
    expect(await openCalls(page)).toEqual([PATH_A, PATH_B]);

    // A completion for an id the engine never issued must not conjure a
    // row or an opening attempt.
    await complete(page, 424_242, '/etc/passwd', 1, 'f'.repeat(64), true);
    await settle(page);
    await expect(page.locator(sel.downloadRow('completed'))).toHaveCount(2);
    expect(await openCalls(page)).toEqual([PATH_A, PATH_B]);
  });

  test('G: a remounted provider (app restart) keeps one completion listener and restored rows still open their own path', async ({ gotoApp, page }) => {
    await gotoApp();
    await startFromDetail(page, 'localsend', 'LocalSend-1.17.0-windows-x64.exe', 1);
    await openDownloads(page);
    const [id] = await registeredIds(page);
    const PATH = '/home/test/Downloads/LocalSend-1.17.0-windows-x64.exe';
    const SHA = 'a'.repeat(64);
    await complete(page, id, PATH, BYTES, SHA, true);
    await drainToasts(page);

    // A completed row is durable history: the restart restores exactly
    // what storage holds, so wait for the persisted payload first (the
    // terminal transition flushes synchronously - this poll is a state
    // wait, not a sleep).
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('fress.downloadItems.v1') ?? ''))
      .toContain('"status":"completed"');

    // REMOUNT = the app restarting. All in-memory state dies; the init
    // scripts (the test bridge included) re-run, and the panel restores
    // from storage with fresh NEGATIVE local ids.
    await page.reload();
    await waitForCatalogReady(page);

    // (a) The remounted provider registered EXACTLY one listener per
    // download event - a duplicate registration would double every
    // completion from here on.
    const b1 = (await bridge(page))!;
    for (const ev of ['download-progress', 'download-complete', 'download-retrying', 'download-error']) {
      const regs = b1.calls.filter(
        (c) => c.cmd === 'plugin:event|listen' && (c.args as { event?: string } | null)?.event === ev
      );
      expect(regs, `exactly one listener for ${ev} after remount`).toHaveLength(1);
    }

    // (b) The restored row (fresh negative id, no engine identity) still
    // hands ITS OWN exact completed path to the opener - restore cannot
    // reassign or lose the path.
    await openDownloads(page);
    const restored = completedRow(page, SHA.slice(0, 24));
    await expect(restored).toHaveCount(1);
    await expect(restored).toContainText(d['downloads.verified']);
    await openBtnOf(restored).click();
    expect(await openCalls(page)).toEqual([PATH]);

    // (c) A fresh download started after the remount completes with
    // single-fire feedback (one toast, one new row) and opens ITS own
    // path: the remount left no duplicated completion handling behind,
    // and restored vs freshly-registered rows stay independent.
    await page.locator(sel.downloadsPanel).getByRole('button', { name: d['common.close'] }).click();
    await expect(page.locator(sel.downloadsPanel)).toHaveCount(0);
    await startFromDetail(page, 'vlc', 'vlc-3.0.21-win64.exe', 1);
    await openDownloads(page);
    const freshId = (await registeredIds(page)).find((n) => n > 0)!;
    const PATH_VLC = '/home/test/Downloads/vlc-3.0.21-win64.exe';
    const SHA_VLC = 'b'.repeat(64);
    await drainToasts(page);
    await trackToasts(page);
    await complete(page, freshId, PATH_VLC, 41_000_000, SHA_VLC, true);
    await settle(page);
    expect(await toastMounts(page)).toBe(1);
    await expect(page.locator(sel.downloadRow('completed'))).toHaveCount(2);
    await drainToasts(page);
    const freshRow = completedRow(page, SHA_VLC.slice(0, 24));
    await openBtnOf(freshRow).click();
    expect(await openCalls(page)).toEqual([PATH, PATH_VLC]);
  });

  // -------------------------------------------------------------------------
  // H - Platform routing at the frontend/native adapter boundary
  // -------------------------------------------------------------------------

  /** Runs four artifact-class completions through one engine (three slots
   * + one queued promotion) and asserts each class's reported path reaches
   * the opener adapter byte-exact. Routing BY CLASS happens inside the
   * native opener plugin (Rust); the frontend contract under test is the
   * unmodified pass-through of the engine-reported path plus the absence
   * of any frontend shell/exec shortcut. A green result here does NOT
   * prove a real installer launched - see docs/testing/download-open-smoke.md. */
  async function runArtifactClassMatrix(
    page: Page,
    classes: Array<{ label: string; path: string }>
  ): Promise<void> {
    await startFromDetail(page, 'localsend', 'LocalSend-1.17.0-windows-x64.exe', 1);
    await startFromDetail(page, 'localsend', 'LocalSend-1.17.0-windows-x64.exe', 2);
    await startFromDetail(page, 'localsend', 'LocalSend-1.17.0-windows-x64.exe', 3);
    await startFromDetail(page, 'localsend', 'LocalSend-1.17.0-windows-x64.exe');
    await openDownloads(page);
    const ids = await registeredIds(page);
    await drainToasts(page);

    await complete(page, ids[0], classes[0].path, BYTES, '1'.repeat(64), true);
    await expect
      .poll(async () => (await registeredIds(page)).length, { timeout: 10_000 })
      .toBe(4);
    const queuedId = (await registeredIds(page))[3]; // promoted 4th transfer
    await complete(page, queuedId, classes[1].path, BYTES, '2'.repeat(64), true);
    await complete(page, ids[1], classes[2].path, BYTES, '3'.repeat(64), true);
    await complete(page, ids[2], classes[3].path, BYTES, '4'.repeat(64), true);
    await drainToasts(page);

    for (let i = 0; i < classes.length; i++) {
      const row = completedRow(page, String(i + 1).repeat(24));
      await expect(row).toHaveCount(1);
      await openBtnOf(row).click();
      const calls = await openCalls(page);
      expect(calls).toHaveLength(i + 1);
      expect(calls[i]).toBe(classes[i].path);
    }
  }

  test('H: installer/archive/AppImage/deb artifact classes pass through to the opener unmodified', async ({ gotoApp, page }) => {
    await gotoApp();
    await runArtifactClassMatrix(page, [
      { label: 'Windows installer', path: '/home/test/Downloads/LocalSend-1.17.0-windows-x64.exe' },
      { label: 'Windows MSI package', path: '/home/test/Downloads/LocalSend-1.17.0-x64.msi' },
      { label: 'ordinary archive', path: '/home/test/Downloads/LocalSend-1.17.0.zip' },
      { label: 'Linux AppImage', path: '/home/test/Downloads/LocalSend-1.17.0-x86_64.AppImage' },
    ]);
    // No frontend shell shortcut exists: the ONLY native opening channel is
    // the opener plugin (a regression that execs something would appear as
    // a foreign recorded command).
    const b = (await bridge(page))!;
    const foreign = b.calls.map((c) => c.cmd).filter((cmd) => /shell|spawn|execute|Command|process\.run/.test(cmd));
    expect(foreign).toEqual([]);
  });

  test('H: deb/dmg/pkg/apk artifact classes pass through to the opener unmodified', async ({ gotoApp, page }) => {
    await gotoApp();
    await runArtifactClassMatrix(page, [
      { label: 'Linux deb package', path: '/home/test/Downloads/localsend_1.17.0_amd64.deb' },
      { label: 'macOS disk image', path: '/home/test/Downloads/LocalSend-1.17.0.dmg' },
      { label: 'macOS installer package', path: '/home/test/Downloads/LocalSend-1.17.0.pkg' },
      { label: 'Android APK', path: '/data/user/0/com.fress.app/files/LocalSend-1.17.0.apk' },
    ]);
    const b = (await bridge(page))!;
    const foreign = b.calls.map((c) => c.cmd).filter((cmd) => /shell|spawn|execute|Command|process\.run/.test(cmd));
    expect(foreign).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// H (Android): the same open journey under an Android webview identity.
// The frontend must keep Open and DROP Show in folder (app-private storage
// is invisible to file managers); the APK path still reaches the adapter
// byte-exact. The native PackageInstaller handoff itself sits BEHIND the
// adapter (native owner's surface) and is NOT proven by this mock.
// ---------------------------------------------------------------------------

test.describe('Workflow D2: download-to-open on Android (UA override)', () => {
  test.use({ userAgent: ANDROID_UA });

  test('H: Android offers Open without Show in folder and hands the exact APK path to the adapter', async ({ gotoApp, page }) => {
    // The catalog remembers the last platform choice (raw-string storage
    // key); seed it so this test exercises the open journey, not filter
    // defaults that differ per device class.
    await page.addInitScript(() => {
      try {
        localStorage.setItem('fress_platform_filter', 'all');
      } catch {
        /* ignore */
      }
    });
    await gotoApp();
    await startFromDetail(page, 'localsend', 'LocalSend-1.17.0-windows-x64.exe', 1);
    await openDownloads(page);
    const [id] = await registeredIds(page);
    const PATH = '/data/user/0/com.fress.app/files/LocalSend-1.17.0.apk';
    await complete(page, id, PATH, BYTES, 'a'.repeat(64), true);
    await drainToasts(page);

    const done = completedRow(page, 'LocalSend-1.17.0-windows-x64.exe');
    await expect(done).toHaveCount(1);
    await expect(openBtnOf(done)).toBeEnabled();
    // Android saves into app-private storage no file manager can browse:
    // Show in folder must not be offered there.
    await expect(showBtnOf(done)).toHaveCount(0);
    // The desktop-only folder picker is absent from the panel footer too.
    await expect(page.getByRole('button', { name: d['downloads.changeFolder'] })).toHaveCount(0);

    await openBtnOf(done).click();
    expect(await openCalls(page)).toEqual([PATH]);
  });
});
