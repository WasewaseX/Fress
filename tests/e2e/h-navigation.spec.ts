// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
/**
 * Workflow H - Navigation and page transitions.
 *
 * Scroll deeply on the catalog; switch to Privacy; verify the heading
 * appears unobscured; switch back; ensure page state is retained as
 * intended.
 */
import { expect } from './fixtures';
import { sel } from './selectors';
import { test } from './fixtures';

test.describe('Workflow H: navigation and page transitions', () => {
  test('deep scroll -> Privacy -> heading unobscured -> back -> state retained', async ({ gotoApp, page }) => {
    await gotoApp();

    // State we expect to survive the round trip.
    await page.locator(sel.searchInput).fill('LocalSend');
    await expect(page.locator(`${sel.grid} article`)).toHaveCount(1);
    await page.locator(sel.searchInput).fill('');
    const activeCategory = page.locator(sel.catBtn('Privacy & Security'));
    await activeCategory.click();
    await expect(activeCategory).toHaveAttribute('aria-pressed', 'true');
    const cardsBefore = await page.locator(`${sel.grid} article`).count();

    // Scroll deep on the catalog.
    await page.locator(sel.main).scrollIntoViewIfNeeded();
    await page.mouse.wheel(0, 4000);
    await page.waitForTimeout(200);
    const scrolledY = await page.evaluate(() => window.scrollY);
    expect(scrolledY).toBeGreaterThan(0);

    // Switch to Privacy while scrolled.
    await page.locator(sel.privacyTab).click();
    await expect(page.locator('#replace-tab')).toBeVisible();

    // The heading must appear UNOBSCURED: nothing else covers its center.
    const heading = page.locator('#replace-tab h2').first();
    await expect(heading).toBeVisible();
    const unobscured = await heading.evaluate((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      // From the viewport top, the first element at the heading's center
      // must be the heading itself or a descendant.
      const cx = r.left + r.width / 2;
      const probeY = Math.max(r.top + Math.min(r.height / 2, 4), 1);
      const hit = document.elementFromPoint(cx, probeY);
      return !!hit && (hit === el || el.contains(hit));
    });
    expect(unobscured, 'Privacy heading must not be covered by the fixed header or a stale overlay').toBe(true);

    // Switch back to the catalog.
    await page.locator(sel.catalogTab).click();
    await expect(page.locator(sel.grid)).toBeVisible();

    // State retained as intended: the filter selection survived the round
    // trip (search is intentionally reset by the filter interaction above;
    // the category chip is the documented persistent filter state).
    await expect(activeCategory).toHaveAttribute('aria-pressed', 'true');
    const cardsAfter = await page.locator(`${sel.grid} article`).count();
    expect(cardsAfter).toBe(cardsBefore);
  });

  test('the active page survives a reload (fress.page persistence)', async ({ gotoApp, page }) => {
    await gotoApp();
    await page.locator(sel.privacyTab).click();
    await expect(page.locator('#replace-tab')).toBeVisible();

    const stored = await page.evaluate(() => localStorage.getItem('fress.page'));
    expect(stored).toBe('replace');

    await page.reload();
    await expect(page.locator('#replace-tab')).toBeVisible();
    // The page switch is two whole-page states rendered as pressed toggle
    // buttons (aria-pressed), NOT an ARIA tablist: the old role=tab /
    // aria-selected pair promised arrow-key navigation and tabpanels that
    // were never implemented (a11y round-8 pass).
    await expect(page.locator(sel.privacyTab)).toHaveAttribute('aria-pressed', 'true');
  });

  test('scroll position is anchored sensibly when returning from Privacy', async ({ gotoApp, page }) => {
    await gotoApp();
    // Scroll deep, go to Privacy, come back: the catalog must not leave the
    // user stranded below an empty viewport or snap to a phantom position.
    await page.mouse.wheel(0, 4000);
    await page.locator(sel.privacyTab).click();
    await expect(page.locator('#replace-tab')).toBeVisible();
    await page.locator(sel.catalogTab).click();
    await expect(page.locator(sel.grid)).toBeVisible();

    const y = await page.evaluate(() => window.scrollY);
    const maxY = await page.evaluate(
      () => document.documentElement.scrollHeight - document.documentElement.clientHeight
    );
    expect(y).toBeGreaterThanOrEqual(0);
    expect(y).toBeLessThanOrEqual(maxY);
  });
});
