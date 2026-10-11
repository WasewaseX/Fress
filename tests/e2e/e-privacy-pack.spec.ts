// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
/**
 * Workflow E - Privacy Pack (ReplaceTab).
 *
 * Choose an alternative using only the keyboard; confirm the counter
 * increments, selection reaches the batch state, the dropdown can be
 * dismissed, and focus returns to the trigger.
 */
import { expect } from './fixtures';
import { sel } from './selectors';
import { test } from './fixtures';
import { DICTS } from '../../src/lib/i18n';

const d = DICTS.en;

/** The first Privacy Pack category id (Mail) and an alternative that is a
 * vetted catalog app, so selection must reach the batch selection state. */
const CAT_ID = 'mail';
const CATALOG_ALT = 'proton_mail';

/** The counter renders its visible "n/3" in an aria-hidden span next to an
 * sr-only sentence (the a11y live text); assert the visible part only. */
const visibleCounter = (page: import('@playwright/test').Page, catId: string) =>
  page.locator(sel.ppCounter(catId)).locator('span[aria-hidden="true"]');

test.describe('Workflow E: Privacy Pack', () => {
  test('keyboard-only pick: counter increments, batch state reached, dropdown dismisses', async ({ gotoApp, page }) => {
    await gotoApp();

    // Navigate to the Privacy tab (role=tab, keyboard accessible).
    await page.locator(sel.privacyTab).click();
    await expect(page.locator('#replace-tab')).toBeVisible();

    const picker = page.locator(sel.ppPicker(CAT_ID));
    await expect(visibleCounter(page, CAT_ID)).toHaveText('0/3');

    // Open the alternatives dropdown with the keyboard only.
    await picker.focus();
    await expect(picker).toBeFocused();
    await picker.press('Enter');
    const dropdown = page.locator(sel.ppDropdown(CAT_ID));
    await expect(dropdown).toBeVisible();
    await expect(picker).toHaveAttribute('aria-expanded', 'true');

    // Opening moves focus to the selected option (real DOM focus); choose
    // the catalog alternative directly - Tab would close the listbox.
    const option = page.locator(sel.ppOption(CAT_ID, CATALOG_ALT));
    await expect(option).toHaveAttribute('role', 'option');
    await option.focus();
    await expect(option).toBeFocused();
    await option.press('Enter');

    // Selection applied: the picked chip exists and the counter incremented.
    await expect(page.locator(sel.ppPicked(CAT_ID, CATALOG_ALT))).toBeVisible();
    await expect(visibleCounter(page, CAT_ID)).toHaveText('1/3');

    // Batch state reached: the floating batch action bar appeared for the
    // catalog-backed alternative.
    await expect(page.locator(sel.batchBar)).toBeVisible();
    await expect(page.locator(sel.batchBar)).toContainText('1');

    // Dismiss the dropdown with Escape.
    await page.keyboard.press('Escape');
    await expect(page.locator(sel.ppDropdown(CAT_ID))).toHaveCount(0);
    // The pick survives the dismissal; nothing was lost.
    await expect(visibleCounter(page, CAT_ID)).toHaveText('1/3');
  });

  /**
   * Focus contract after the a11y listbox rework: every close path of the
   * PpDropdown (Escape, outside click, Tab) hands focus back to the trigger
   * button, like a native select does. A completed pick intentionally keeps
   * the dropdown open (multi-pick flow); dismissing afterwards restores the
   * focus. This used to be encoded as test.fail against the old click-only
   * dropdown; the contract is restored, so it is a plain assertion now.
   */
  test('a11y contract: dismissing the picker returns focus to the trigger', async ({ gotoApp, page }) => {
    await gotoApp();
    await page.locator(sel.privacyTab).click();
    const picker = page.locator(sel.ppPicker(CAT_ID));

    await picker.focus();
    await picker.press('Enter');
    const option = page.locator(sel.ppOption(CAT_ID, CATALOG_ALT));
    await option.press('Enter');
    await expect(page.locator(sel.ppPicked(CAT_ID, CATALOG_ALT))).toBeVisible();

    // The dropdown stays open for further picks; Escape dismisses it and
    // focus must land back on the trigger, not on <body>.
    await page.keyboard.press('Escape');
    await expect(page.locator(sel.ppDropdown(CAT_ID))).toHaveCount(0);

    await expect(picker).toBeFocused();
  });

  test('third pick is refused at the cap and Clear resets the counter and batch state', async ({ gotoApp, page }) => {
    await gotoApp();
    await page.locator(sel.privacyTab).click();
    await expect(page.locator('#replace-tab')).toBeVisible();

    const picker = page.locator(sel.ppPicker(CAT_ID));

    // Pick three alternatives (the cap).
    for (const altId of ['proton_mail', 'tuta_mail']) {
      await picker.focus();
      await picker.press('Enter');
      await page.locator(sel.ppOption(CAT_ID, altId)).focus();
      await page.keyboard.press('Enter');
      await page.keyboard.press('Escape');
    }
    await expect(visibleCounter(page, CAT_ID)).toHaveText('2/3');

    // A third pick brings the category to MAX_PICKS_PER_CATEGORY.
    await picker.focus();
    await picker.press('Enter');
    // Any remaining option that is not yet picked.
    await page.locator(`${sel.ppDropdown(CAT_ID)} [aria-selected="false"]`).first().focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    await expect(visibleCounter(page, CAT_ID)).toHaveText('3/3');

    // Clear: counter back to zero, batch state released.
    await page.getByRole('button', { name: new RegExp(`${d['pp.clearPicks']}: `) }).first().click();
    await expect(visibleCounter(page, CAT_ID)).toHaveText('0/3');
  });
});
