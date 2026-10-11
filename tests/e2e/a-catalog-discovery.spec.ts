// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
/**
 * Workflow A - Catalog discovery.
 *
 * Open the application; search for a known app; activate a category/platform
 * filter; switch grid/table view; verify the result list, count, category
 * translation and selected states agree.
 */
import { expect } from './fixtures';
import { sel } from './selectors';
import { test } from './fixtures';
import { DICTS } from '../../src/lib/i18n';

const ANCHOR_ID = 'localsend';

test.describe('Workflow A: catalog discovery', () => {
  test('search finds a known app and the count indicator agrees with the list', async ({ gotoApp, page }) => {
    await gotoApp();

    // Baseline: the shipped catalog renders as cards.
    const baselineCards = await page.locator(`${sel.grid} article`).count();
    expect(baselineCards).toBeGreaterThan(0);
    const baselineCount = await page.locator(sel.countIndicator('desktop')).textContent();
    expect(baselineCount ?? '').toContain(String(baselineCards));

    // Search for a known app (LocalSend ships in the catalog).
    await page.locator(sel.searchInput).fill('LocalSend');
    await expect(page.locator(`${sel.grid} article`)).toHaveCount(1, { timeout: 10_000 });
    await expect(page.locator(sel.cardTitle(ANCHOR_ID))).toHaveText('LocalSend');
    await expect(page.locator(sel.catBadge(ANCHOR_ID))).toHaveText('Utilities & System');

    // The visible count now agrees with the (single) result: "1 / 75".
    const indicator = await page.locator(sel.countIndicator('desktop')).textContent();
    const [shown, total] = (indicator ?? '').split('/').map((s) => parseInt(s.trim(), 10));
    expect(shown).toBe(1);
    expect(total).toBe(baselineCards);
  });

  test('category filter selects the chip, filters the list and the translated chip label matches the dictionary', async ({ gotoApp, page }) => {
    await gotoApp();

    const d = DICTS.en;
    const developerBtn = page.locator(sel.catBtn('Developer & Code'));
    await developerBtn.click();

    // Selected state: aria-pressed on the chip.
    await expect(developerBtn).toHaveAttribute('aria-pressed', 'true');
    // Translation agreement: the chip label equals the dictionary string.
    await expect(developerBtn).toHaveText(d['filter.categories.developer']);

    // Every visible card belongs to the filtered category.
    const catBadges = page.locator(`${sel.grid} [id^="app-cat-badge-"]`);
    const n = await catBadges.count();
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) {
      await expect(catBadges.nth(i)).toHaveText('Developer & Code');
    }

    // The count indicator agrees with the card count ("{shown} / {total}").
    const cards = await page.locator(`${sel.grid} article`).count();
    const indicator = await page.locator(sel.countIndicator('desktop')).textContent();
    const [shownAfter, totalAfter] = (indicator ?? '').split('/').map((s) => parseInt(s.trim(), 10));
    expect(shownAfter).toBe(cards);
    expect(totalAfter).toBeGreaterThan(cards);

    // Reset returns the full catalog.
    await page.getByRole('button', { name: d['filter.reset'] }).first().click();
    const after = await page.locator(`${sel.grid} article`).count();
    expect(after).toBeGreaterThan(cards);
  });

  test('platform filter keeps only apps for that platform', async ({ gotoApp, page }) => {
    await gotoApp();
    const d = DICTS.en;

    await page.locator(sel.platformChip('desktop', 'android')).click();
    await expect(page.locator(sel.platformChip('desktop', 'android'))).toHaveAttribute('aria-pressed', 'true');

    // LocalSend supports Android -> stays visible; sharex (Windows-only) must go.
    await expect(page.locator(sel.card(ANCHOR_ID))).toBeVisible();
    await expect(page.locator(sel.card('sharex'))).toHaveCount(0);

    // Switching back restores it.
    await page.locator(sel.platformChip('desktop', 'windows')).click();
    await expect(page.locator(sel.card('sharex'))).toBeVisible();
    expect(d['filter.platforms']).toBeTruthy();
  });

  test('grid/table view switch renders the same catalog in both views and persists', async ({ gotoApp, page }) => {
    await gotoApp();
    const d = DICTS.en;

    const gridCount = await page.locator(`${sel.grid} article`).count();
    expect(gridCount).toBeGreaterThan(0);

    await page.locator(sel.viewToggle).getByRole('button').nth(1).click();
    await expect(page.locator(sel.table)).toBeVisible();
    const rows = await page.locator(`${sel.table} tbody tr`).count();
    expect(rows).toBe(gridCount);

    // The view preference is persisted (useViewPreferences -> localStorage).
    const stored = await page.evaluate(() => localStorage.getItem('awesome_free_apps_view_mode'));
    expect(stored).toBe('table');

    // Reload: the table view must survive a restart (documented behavior).
    await page.reload();
    await expect(page.locator(sel.table)).toBeVisible();

    // And back to grid.
    await page.locator(sel.viewToggle).getByRole('button').nth(0).click();
    await expect(page.locator(sel.grid)).toBeVisible();
    await expect(page.locator(`${sel.grid} article`).first()).toBeVisible();
  });
});
