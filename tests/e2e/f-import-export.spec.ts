// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
/**
 * Workflow F - Import/export and recovery.
 *
 * Import valid and malformed catalog data; confirm corrupt data does not
 * crash the UI and every rejection carries its specific reason. Test export
 * download behavior, and the download-directory failure path where a stable
 * mock can reproduce it (Tauri bridge: start_download fails).
 */
import { expect, bridge } from './fixtures';
import { sel } from './selectors';
import { test } from './fixtures';
import { DICTS } from '../../src/lib/i18n';
import { validBackup, MALFORMED_BACKUPS } from './fixtures/data';

const d = DICTS.en;

test.describe('Workflow F: import/export and recovery', () => {
  test('valid backup import adds its apps and favorites survive', async ({ gotoApp, page }) => {
    await gotoApp();

    await page.locator('#hidden-catalog-file-input').setInputFiles({
      name: 'fress-backup.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(validBackup())),
    });

    // The imported apps appear in the catalog.
    await expect(page.locator('#app-card-imported-alpha')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#app-card-imported-beta')).toBeVisible();
    // The imported favorite reached the favorites filter count: "Bookmarks (1)".
    await expect(page.getByRole('button', { name: `${d['filter.favorites']} (1)` }).first()).toBeVisible({ timeout: 10_000 });
  });

  for (const bad of MALFORMED_BACKUPS) {
    // junk-entries.json carries ONE valid entry on purpose: the catalog grows
    // by exactly one while every junk shape is dropped (that is the
    // sanitizer's contract, exercised end to end).
    const expectCardsDelta = bad.name === 'junk-entries.json' ? 1 : 0;
    test(`malformed import "${bad.name}" is handled with a reason and the UI survives`, async ({ gotoApp, page }) => {
      await gotoApp();
      const cardsBefore = await page.locator(`${sel.grid} article`).count();

      await page.locator('#hidden-catalog-file-input').setInputFiles({
        name: bad.name,
        mimeType: 'application/json',
        buffer: Buffer.from(bad.content),
      });

      // A specific toast appears (error for rejections, success for the
      // partially-valid file - both with concrete counts).
      const toast = page.locator('[data-sonner-toast]');
      await expect(toast.first()).toBeVisible({ timeout: 10_000 });
      const text = (await toast.first().textContent()) ?? '';
      expect(text.length).toBeGreaterThan(0);
      expect(text).toMatch(/backup|JSON|schema|Invalid|corrupted|Failed|imported/i);

      // No crash; the catalog changed by exactly the sanctioned amount.
      await expect(page.locator(sel.root)).toBeVisible();
      expect(await page.locator(`${sel.grid} article`).count()).toBe(cardsBefore + expectCardsDelta);
      await page.locator(sel.searchInput).fill('LocalSend');
      await expect(page.locator('#app-title-localsend')).toBeVisible();
    });
  }

  test('junk entries inside a valid backup are dropped; valid ones survive the sanitizer', async ({ gotoApp, page }) => {
    await gotoApp();
    const junk = MALFORMED_BACKUPS.find((b) => b.name === 'junk-entries.json')!;
    await page.locator('#hidden-catalog-file-input').setInputFiles({
      name: junk.name,
      mimeType: 'application/json',
      buffer: Buffer.from(junk.content),
    });

    // "Valid Entry" passed the sanitizer; the junk shapes were dropped.
    await expect(page.locator('#app-card-valid-entry')).toBeVisible({ timeout: 10_000 });
    // The sanitizer stripped the dangerous fields (no platforms -> defaulted;
    // tags string ignored). The card renders.
    await expect(page.locator('#app-title-valid-entry')).toHaveText('Valid Entry');
  });

  test('export produces a downloadable file with the expected name', async ({ gotoApp, page }) => {
    await gotoApp();

    // Open the export modal from the header More menu (aria via dictionary).
    await page.getByRole('button', { name: d['header.moreMenu'] }).first().click();
    await page.getByRole('button', { name: d['header.exportReadme'] }).click();
    await expect(page.locator(sel.exportModal)).toBeVisible();

    const downloadPromise = page.waitForEvent('download', { timeout: 15_000 });
    await page.locator(`${sel.exportModal} button`).filter({ hasText: 'Download' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/README\.md|\.csv|\.json$/);
  });
});

test.describe('Workflow F: download-directory failure paths (Tauri mode)', () => {
  test.use({ tauriMode: true });

  test('start_download permission failure surfaces a clear error, never a stuck active row', async ({ gotoApp, page }) => {
    await gotoApp();
    // Disk full / permission denied on the download directory is a stable,
    // reproducible mock here (real Rust would fail the same way).
    await page.evaluate(() => window.__fressTest!.setFailStart('EACCES: permission denied, open /home/test/Downloads'));

    await page.locator('#app-title-localsend').click();
    const box = page.locator(sel.detailDownloadBox);
    await box.getByRole('button', { name: 'Windows' }).click();
    await expect(box.getByText('LocalSend-1.17.0-windows-x64.exe', { exact: false })).toBeVisible({ timeout: 15_000 });
    await box.getByRole('button', { name: 'LocalSend-1.17.0-windows-x64.exe' }).click();

    const toast = page.locator('[data-sonner-toast]');
    await expect(toast.first()).toBeVisible();
    await expect(page.locator(sel.root)).toBeVisible();

    // Nothing registered engine-side; no stuck active row.
    const b = (await bridge(page))!;
    expect(Object.keys(b.downloads)).toHaveLength(0);
    await page.keyboard.press('Escape');
    await page.locator(sel.downloadsBtn).click();
    await expect(page.locator(sel.downloadsPanel)).toBeVisible();
    await expect(page.locator(sel.downloadRow('active'))).toHaveCount(0);
  });

  test('a denied folder choice does not wedge the manager; a successful choice updates the path', async ({ gotoApp, page }) => {
    await gotoApp();

    // The folder picker fails (permission denied is a stable mock).
    await page.evaluate(() => window.__fressTest!.setFailDialog('EACCES: permission denied'));
    await page.locator(sel.downloadsBtn).click();
    await expect(page.locator(sel.downloadsPanel)).toBeVisible();

    await page.locator(sel.downloadsPanel).getByRole('button', { name: d['downloads.changeFolder'] }).click();
    // The picker failed; the panel stays open and usable, showing the fallback dir.
    await expect(page.locator(sel.downloadsPanel)).toBeVisible();
    await expect(page.locator(sel.downloadsPanel)).toContainText(d['downloads.folder']);

    // And a successful choice updates the footer path.
    await page.evaluate(() => {
      window.__fressTest!.setFailDialog(null);
      window.__fressTest!.setDialogDir('/home/test/pick');
    });
    await page.locator(sel.downloadsPanel).getByRole('button', { name: d['downloads.changeFolder'] }).click();
    await expect(page.locator(sel.downloadsPanel)).toContainText('/home/test/pick');
  });
});
