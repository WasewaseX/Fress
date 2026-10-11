// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
/**
 * Workflow B - Command palette.
 *
 * Open via Ctrl+K; search using English and non-English action terms;
 * navigate with keyboard; activate a result; close via Escape; assert focus
 * returns to the opener.
 *
 * Note on "non-English action terms": the palette's ACTION keyword matching
 * is English-only BY DOCUMENTED INTENT (see CommandPalette.tsx: "the keyword
 * matching above stays English on purpose" - the intent is recorded in the
 * source). Action TITLES, the no-match message and every result row render
 * through the active dictionary. This workflow therefore asserts:
 *   - an English action term surfaces the action whose TITLE is localized,
 *   - a non-English term drives the localized no-match path without breaking
 *     keyboard navigation or focus handling.
 * If the product decides localized action keywords should match, that is a
 * feature change for the component owner - the suite flags it here.
 */
import { expect } from './fixtures';
import { sel, openPalette } from './selectors';
import { test } from './fixtures';
import { DICTS } from '../../src/lib/i18n';

test.describe('Workflow B: command palette', () => {
  test('Ctrl+K opens, English action term finds a localized action, keyboard activates it', async ({ gotoApp, page }) => {
    await gotoApp();

    // The opener: put focus on a real control before opening.
    await page.locator(sel.searchInput).focus();

    await openPalette(page);
    // The palette input exposes role="combobox" (a11y listbox pattern).
    const input = page.getByRole('combobox', { name: DICTS.en['palette.inputAria'] });
    await expect(input).toBeFocused();

    // English action term -> the export action, localized title from DICTS.
    await input.fill('export');
    const actionRow = page.locator('#palette-item-act-export');
    await expect(actionRow).toBeVisible();
    // The first result is highlighted by default (selectedIndex 0).
    await expect(actionRow).toHaveClass(/fr-chip-active/);

    // Keyboard navigation: ArrowDown moves the highlight, ArrowUp returns it
    // to the action row (wrap-aware); Enter activates the highlighted row.
    await input.press('ArrowDown');
    await input.press('ArrowUp');
    await expect(actionRow).toHaveClass(/fr-chip-active/);
    await input.press('Enter');

    // The activated action opens the Export modal (the palette closed with it).
    await expect(page.locator(sel.exportModal)).toBeVisible();
    await expect(page.locator(sel.paletteModal)).toHaveCount(0);

    // Focus moved INTO the newly opened modal (keepFocusInside chain): the
    // opener-restoration contract for closing WITHOUT opening something else
    // is asserted in the Escape test above.
    const exportFocused = await page.evaluate(() =>
      document.querySelector('#export-modal')?.contains(document.activeElement) ?? false
    );
    expect(exportFocused).toBe(true);
  });

  test('app search result opens the detail dialog via keyboard', async ({ gotoApp, page }) => {
    await gotoApp();
    await openPalette(page);
    const input = page.getByRole('combobox', { name: DICTS.en['palette.inputAria'] });

    await input.fill('LocalSend');
    const firstResult = page.locator(sel.paletteModal).getByText('LocalSend', { exact: true }).first();
    await expect(firstResult).toBeVisible();
    await input.press('Enter');

    // The detail dialog opened (aria-label carries the app name).
    const dialog = page.getByRole('dialog');
    await expect(dialog.first()).toBeVisible();
    await expect(page.locator(sel.paletteModal)).toHaveCount(0);
  });

  test('non-English action term: localized no-match path, Escape closes, focus returns to the opener', async ({ gotoApp, page }) => {
    await gotoApp();
    const d = DICTS.en;

    await page.locator(sel.searchInput).focus();
    await openPalette(page);
    const input = page.getByRole('combobox', { name: d['palette.inputAria'] });

    // A Persian action word: no English keyword matches, no catalog data
    // matches - the palette must answer with the localized no-match message.
    await input.fill('خروجی');
    const noMatch = d['palette.noMatch'].replace('{query}', 'خروجی');
    await expect(page.locator(sel.paletteModal).getByText(noMatch)).toBeVisible();

    // Escape closes and focus returns to the opener (modalFocus contract).
    await input.press('Escape');
    await expect(page.locator(sel.paletteModal)).toHaveCount(0);
    await expect(page.locator(sel.searchInput)).toBeFocused();

    // Ctrl+K toggles closed as well (second press on an open palette).
    await openPalette(page);
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.locator(sel.paletteModal)).toHaveCount(0);
  });
});
