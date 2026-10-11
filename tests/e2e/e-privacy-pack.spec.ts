// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
/**
 * Workflow E - Privacy Pack (ReplaceTab).
 *
 * Choose an alternative using only the keyboard; confirm the counter
 * increments, selection reaches the batch state, and every dropdown close
 * path (pick, Escape) returns focus to the trigger.
 *
 * The dropdown is a real ARIA listbox (ReplaceTab PpDropdown):
 *   - opening moves focus to the selected option, or the first option when
 *     nothing is selected yet,
 *   - ArrowUp/Down/Home/End move within the list,
 *   - every close path funnels through one cleanup that refocuses the
 *     trigger - the focus bug this suite used to pin with test.fail was
 *     fixed by the a11y integration, so the contract is asserted directly.
 */
import { expect } from './fixtures';
import { sel } from './selectors';
import { test } from './fixtures';
import { DICTS } from '../../src/lib/i18n';
import type { Locator } from '@playwright/test';

const d = DICTS.en;

/** The first Privacy Pack category id (Mail) and an alternative that is a
 * vetted catalog app, so selection must reach the batch selection state. */
const CAT_ID = 'mail';
const CATALOG_ALT = 'proton_mail';

/** The visible counter span (the aria-hidden twin) plus the sr-only line,
 * so both the painted text and what a screen reader hears are asserted. */
function expectCounter(counter: Locator, n: number): Promise<void> {
  return Promise.all([
    expect(counter.locator('span[aria-hidden="true"]')).toHaveText(`${n}/3`),
    expect(counter.locator('.sr-only')).toHaveText(
      d['pp.counterAria'].replace('{n}', String(n)).replace('{max}', '3')
    ),
  ]).then(() => undefined);
}

test.describe('Workflow E: Privacy Pack', () => {
  test('keyboard-only pick: counter increments, batch state reached, dropdown dismisses', async ({ gotoApp, page }) => {
    await gotoApp();

    // Navigate to the Privacy tab (role=tab, keyboard accessible).
    await page.locator(sel.privacyTab).click();
    await expect(page.locator('#replace-tab')).toBeVisible();

    const picker = page.locator(sel.ppPicker(CAT_ID));
    const counter = page.locator(sel.ppCounter(CAT_ID));
    await expectCounter(counter, 0);

    // Open the alternatives dropdown with the keyboard only.
    await picker.focus();
    await expect(picker).toBeFocused();
    await picker.press('Enter');
    const dropdown = page.locator(sel.ppDropdown(CAT_ID));
    await expect(dropdown).toBeVisible();
    await expect(picker).toHaveAttribute('aria-expanded', 'true');

    // The listbox moves focus to the first option by itself - the next key
    // starts from somewhere meaningful. The first mail alternative is
    // proton_mail (privacyPack.ts order), still unselected.
    const option = page.locator(sel.ppOption(CAT_ID, CATALOG_ALT));
    await expect(option).toBeFocused();

    // Pick it with Enter - a pure keyboard path, no pointer, no programmatic
    // focus moves. The popup is MULTI-SELECT by design: it stays open so
    // several alternatives can be picked in one pass (ReplaceTab onPick).
    await option.press('Enter');

    // Selection applied: the picked chip exists and the counter incremented
    // (both the painted number and what a screen reader hears).
    await expect(page.locator(sel.ppPicked(CAT_ID, CATALOG_ALT))).toBeVisible();
    await expectCounter(counter, 1);
    // The option reflects the selection while the popup stays open.
    await expect(option).toHaveAttribute('aria-selected', 'true');

    // Batch state reached: the floating batch action bar appeared for the
    // catalog-backed alternative.
    await expect(page.locator(sel.batchBar)).toBeVisible();
    await expect(page.locator(sel.batchBar)).toContainText('1');

    // Escape closes the multi-select popup and focus returns to the trigger
    // (same contract as a native select popup); the pick survives.
    await page.keyboard.press('Escape');
    await expect(page.locator(sel.ppDropdown(CAT_ID))).toHaveCount(0);
    await expect(picker).toBeFocused();
    await expectCounter(counter, 1);
  });

  test('a11y contract: dismissing the picker returns focus to the trigger', async ({ gotoApp, page }) => {
    // History: this was pinned as test.fail against the v1.0.6 dropdown,
    // which unmounted while holding focus and dumped keyboard users at the
    // top of the page. The a11y integration (five-language dialog system,
    // stacked focus contract) fixed it - the annotation was lifted and the
    // contract is now asserted as a hard requirement in BOTH close paths.
    await gotoApp();
    await page.locator(sel.privacyTab).click();
    const picker = page.locator(sel.ppPicker(CAT_ID));

    // Escape path.
    await picker.focus();
    await picker.press('Enter');
    const dropdown = page.locator(sel.ppDropdown(CAT_ID));
    await expect(dropdown).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dropdown).toHaveCount(0);
    await expect(picker).toBeFocused();

    // Tab path closes while focus moves on (a listbox is not a trap).
    await picker.press('Enter');
    await expect(dropdown).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(dropdown).toHaveCount(0);
  });

  test('third pick is refused at the cap and Clear resets the counter and batch state', async ({ gotoApp, page }) => {
    await gotoApp();
    await page.locator(sel.privacyTab).click();
    await expect(page.locator('#replace-tab')).toBeVisible();

    const counter = page.locator(sel.ppCounter(CAT_ID));
    const picker = page.locator(sel.ppPicker(CAT_ID));

    // Mail alternatives in data order: proton_mail, tuta_mail, disroot...
    // The popup is multi-select: it stays open across picks, focus stays on
    // the option that was toggled, and Escape is the explicit close.
    // Pick #1: focus starts on proton_mail.
    await picker.focus();
    await picker.press('Enter');
    await page.locator(sel.ppOption(CAT_ID, 'proton_mail')).press('Enter');
    await expectCounter(counter, 1);

    // Pick #2: one ArrowDown from proton_mail reaches tuta_mail.
    await page.locator(sel.ppOption(CAT_ID, 'proton_mail')).press('ArrowDown');
    await page.locator(sel.ppOption(CAT_ID, 'tuta_mail')).press('Enter');
    await expectCounter(counter, 2);

    // A third pick brings the category to MAX_PICKS_PER_CATEGORY (3):
    // one more ArrowDown reaches disroot_webmail.
    await page.locator(sel.ppOption(CAT_ID, 'tuta_mail')).press('ArrowDown');
    await page.locator(sel.ppOption(CAT_ID, 'disroot_webmail')).press('Enter');
    await expectCounter(counter, 3);

    // Close, then Clear: counter back to zero, batch state released.
    await page.keyboard.press('Escape');
    await expect(page.locator(sel.ppDropdown(CAT_ID))).toHaveCount(0);
    await page.locator(sel.ppClear(CAT_ID)).click();
    await expectCounter(counter, 0);
    // The picked chips are gone with the reset.
    await expect(page.locator(sel.ppPicked(CAT_ID, CATALOG_ALT))).toHaveCount(0);
  });
});
