// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
/**
 * Task 2 - Visual regression suite.
 *
 * Screenshots are captured only after fonts are ready, with deterministic
 * fixture data (star values pre-seeded, no live fetches) and animations
 * disabled. Thresholds live in playwright.config.ts (maxDiffPixelRatio
 * 0.02) so one antialiasing pixel between operating systems cannot fail
 * CI - real layout regressions move far more than 2% of pixels. Unexpected
 * diffs are reviewed via the HTML report (npx playwright show-report).
 *
 * NOTE for CI: baselines were generated on Linux (Chromium headless). The
 * visual job therefore runs on ubuntu-latest; macOS/Windows render text
 * with different rasterizers and are NOT part of the visual gate (see
 * docs/quality-gates.md, "What still requires manual device testing").
 */
import { expect, test, fontsReady, bridge, PERF_CATALOG } from './fixtures';
import { sel, openPalette, openDownloads, paletteInput } from './selectors';
import { DICTS } from '../../src/lib/i18n';

const VIEWPORTS = [320, 390, 768, 1366, 1600, 1920];

/** Deterministic usability measurements that pair with a screenshot:
 *  a snapshot alone cannot catch a clipped primary action or sideways
 *  document scroll, so the 320px-floor guards assert the geometry. */
async function expectNoDocOverflow(page: import('@playwright/test').Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
  }));
  expect(
    overflow.scrollW,
    `document scrollWidth (${overflow.scrollW}) exceeds clientWidth (${overflow.clientW}) at the 320px floor`
  ).toBeLessThanOrEqual(overflow.clientW + 1);
}

async function expectInsideWidth(page: import('@playwright/test').Page, selector: string, width: number): Promise<void> {
  const box = await page.locator(selector).first().boundingBox();
  expect(box, `${selector} has a bounding box`).not.toBeNull();
  expect(box!.x, `${selector} start edge`).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width, `${selector} end edge past the ${width}px viewport`).toBeLessThanOrEqual(width + 1);
}

async function shoot(
  page: import('@playwright/test').Page,
  name: string,
  expected: 'light' | 'dark' = 'light',
): Promise<void> {
  // Theme authenticity: the capture must show the theme its filename claims.
  // Both signals are asserted immediately before the screenshot - the app's
  // own theme class AND the computed colorScheme token the browser resolves
  // from it (a filename alone proved nothing once: an earlier dark baseline
  // had the settings popover baked in and still "passed").
  if (expected === 'dark') {
    await expect(page.locator('html')).toHaveClass(/dark/);
    await expect
      .poll(async () =>
        page.evaluate(() => getComputedStyle(document.documentElement).colorScheme),
      )
      .toBe('dark');
  } else {
    await expect(page.locator('html')).not.toHaveClass(/dark/);
    await expect
      .poll(async () =>
        page.evaluate(() => getComputedStyle(document.documentElement).colorScheme),
      )
      .toBe('light');
  }
  await fontsReady(page);
  await expect(page).toHaveScreenshot([`${name}.png`], { fullPage: false });
}

/**
 * Switch to dark via the settings menu and CLOSE the menu before capture.
 * The menu stays open after picking a theme (by design - the user may want
 * to change the language next), so an earlier baseline baked the open
 * popover into the "dark catalog" screenshot. Every dark capture must show
 * the actual page surface; the open menu belongs to no required view.
 */
async function switchToDark(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: DICTS.en['header.moreMenu'] }).first().click();
  await page.getByRole('button', { name: DICTS.en['header.dark'] }).first().click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  // Dismiss the popover (single-layer Escape contract) and wait until it is
  // really gone before the capture.
  await page.keyboard.press('Escape');
  await page
    .getByRole('button', { name: DICTS.en['header.dark'] })
    .first()
    .waitFor({ state: 'hidden' });
}

test.describe('visual: catalog', () => {
  test('main catalog, light theme', async ({ gotoApp, page }) => {
    await gotoApp();
    await shoot(page, 'catalog-light');
  });

  test('main catalog, dark theme', async ({ gotoApp, page }) => {
    await gotoApp();
    await switchToDark(page);
    await shoot(page, 'catalog-dark', 'dark');
  });

  for (const width of VIEWPORTS) {
    test(`main catalog at ${width} CSS pixels`, async ({ gotoApp, page }) => {
      await page.setViewportSize({ width, height: 900 });
      await gotoApp();
      await shoot(page, `catalog-${width}`);
    });
  }
});

test.describe('visual: 320px floor regression guards', () => {
  // The 320px floor is the smallest supported viewport. These guards pair
  // the catalog-320 screenshot with the measurements a snapshot cannot
  // express: no sideways document scroll, and primary actions neither
  // clipped by their card nor pushed past the viewport edge.
  test('catalog at 320: no overflow, header and card actions inside the viewport', async ({ gotoApp, page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await gotoApp();
    await shoot(page, 'catalog-320');
    await expectNoDocOverflow(page);
    for (const id of ['header-add-app-btn', 'header-downloads-btn', 'header-more-menu-btn']) {
      await expect(page.locator(`#${id}`)).toBeVisible();
      await expectInsideWidth(page, `#${id}`, 320);
    }
    await expectInsideWidth(page, '[id^="download-btn-"]', 320);
    await expectInsideWidth(page, '[id^="app-card-"]', 320);
  });

  test('batch action bar at 320 wraps and stays inside its pill', async ({ gotoApp, page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await gotoApp();
    // Select two apps: the floating bar appears with all four controls.
    const boxes = page.locator('input[id^="batch-check-"]');
    await boxes.nth(0).click();
    await boxes.nth(1).click();
    const bar = page.locator('#floating-batch-action-bar');
    await expect(bar).toBeVisible();
    // The bar's own pill must not exceed the viewport, and every control
    // inside it must sit within the pill (the pre-wrap bar spilled its
    // buttons past the rounded border at this width, and in German up to
    // ~520px).
    await expectInsideWidth(page, '#floating-batch-action-bar', 320);
    const barBox = (await bar.boundingBox())!;
    for (const btn of await bar.locator('button').all()) {
      const bb = (await btn.boundingBox())!;
      expect(bb.x, 'bar control start edge').toBeGreaterThanOrEqual(barBox.x - 1);
      expect(bb.x + bb.width, 'bar control end edge').toBeLessThanOrEqual(barBox.x + barBox.width + 1);
    }
    await expectNoDocOverflow(page);
    await shoot(page, 'batch-bar-320');
  });

  test('export modal at 320: footer actions stay reachable', async ({ gotoApp, page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await gotoApp();
    await page.keyboard.press('e');
    await expect(page.locator('#export-modal')).toBeVisible();
    await expectNoDocOverflow(page);
    // The primary export action must be fully visible (it was clipped by
    // the panel's overflow-hidden before the footer wrapped). The default
    // format is markdown, so the filename appears in the button label.
    const download = page.getByRole('button', { name: 'Download README.md' });
    await expect(download).toBeVisible();
    const db = (await download.boundingBox())!;
    const panel = (await page.locator('#export-modal').boundingBox())!;
    expect(db.y + db.height, 'export Download button bottom inside the panel').toBeLessThanOrEqual(panel.y + panel.height + 1);
    await shoot(page, 'export-320');
  });

  test('manual add-app modal at 320: form and primary action reachable', async ({ gotoApp, page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await gotoApp();
    // 'a' opens the add flow (LiveSearch); the Manual tab swaps the dialog.
    await page.keyboard.press('a');
    await expect(page.locator('#live-search-modal-backdrop')).toBeVisible();
    await page.getByRole('button', { name: 'Enter manually' }).click();
    await expect(page.locator('#add-app-modal-backdrop')).toBeVisible();
    await expectNoDocOverflow(page);
    // Name field visible, the primary action inside the viewport, and the
    // stars field reachable (the form's validation UI changed in the
    // a11y round-8 pass: no native constraint bubbles, translated errors).
    const nameInput = page.locator('#input-app-name');
    await expect(nameInput).toBeVisible();
    await expectInsideWidth(page, '#input-app-name', 320);
    // The save/cancel row is PINNED below the form's scroll region (the
    // round-8 fix; before it the buttons sat at the end of a scrollable
    // form, off-panel at this height). Fully inside the viewport, always.
    const submit = page.locator('#add-app-modal-backdrop button[type="submit"]');
    await expect(submit).toBeVisible();
    const sb = (await submit.boundingBox())!;
    const vh = await page.evaluate(() => document.documentElement.clientHeight);
    expect(sb.y, 'pinned add-app submit top inside the viewport').toBeGreaterThanOrEqual(-1);
    expect(sb.y + sb.height, 'pinned add-app submit fully inside the viewport').toBeLessThanOrEqual(vh + 1);
    await expect(page.locator('#input-stars')).toBeVisible();
    await shoot(page, 'add-app-320');
  });
});

test.describe('visual: 320px RTL floor guard', () => {
  test.use({ lang: 'fa' });

  test('RTL (fa) catalog at 320: no horizontal overflow', async ({ gotoApp, page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await gotoApp();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expectNoDocOverflow(page);
    await expectInsideWidth(page, '[id^="download-btn-"]', 320);
  });
});

test.describe('visual: privacy pack', () => {
  test('privacy pack, light theme', async ({ gotoApp, page }) => {
    await gotoApp();
    await page.locator(sel.privacyTab).click();
    await expect(page.locator('#replace-tab')).toBeVisible();
    await shoot(page, 'privacy-light');
  });

  test('privacy pack, dark theme', async ({ gotoApp, page }) => {
    await gotoApp();
    await page.locator(sel.privacyTab).click();
    await expect(page.locator('#replace-tab')).toBeVisible();
    await switchToDark(page);
    await shoot(page, 'privacy-dark', 'dark');
  });
});

test.describe('visual: app detail modal', () => {
  test('detail modal with resolved download', async ({ gotoApp, page }) => {
    await gotoApp();
    await page.locator('#app-title-localsend').click();
    const dialog = page.getByRole('dialog').first();
    await expect(dialog).toBeVisible();
    // Headless Linux opens the Linux tab; switch to Windows for the fixture asset.
    await page.locator('#detail-download-box').getByRole('button', { name: 'Windows' }).click();
    await expect(page.locator('#detail-download-box').getByText('LocalSend-1.17.0-windows-x64.exe', { exact: false })).toBeVisible({ timeout: 15_000 });
    await shoot(page, 'detail-modal');
  });
});

test.describe('visual: download manager', () => {
  test.use({ tauriMode: true });

  test('download manager with active and failed items', async ({ gotoApp, page }) => {
    await gotoApp();

    // One active transfer mid-progress and one terminal failure.
    const startViaDetail = async (appId: string, assetName: string): Promise<void> => {
      await page.locator(`#app-title-${appId}`).click();
      const box = page.locator('#detail-download-box');
      await box.getByRole('button', { name: 'Windows' }).click();
      await expect(box.getByText(assetName, { exact: false })).toBeVisible({ timeout: 15_000 });
      await box.getByRole('button', { name: new RegExp(assetName.replace(/\./g, '\\.')) }).click();
      await page.keyboard.press('Escape');
    };
    await startViaDetail('localsend', 'LocalSend-1.17.0-windows-x64.exe');
    await startViaDetail('vlc', 'vlc-3.0.21-win64.exe');

    await openDownloads(page);
    const ids = Object.keys((await bridge(page))!.downloads).map(Number);
    await page.evaluate((did) => window.__fressTest!.emitProgress(did, 6_291_456, 25_165_824, 2_097_152, 9), ids[0]);
    await page.evaluate((did) => window.__fressTest!.emitError(did, 'Network error: connection lost', 'network'), ids[1]);

    await expect(page.locator(sel.downloadRow('active'))).toHaveCount(1);
    await expect(page.locator(sel.downloadRow('error'))).toHaveCount(1);
    await shoot(page, 'download-manager-mixed');
  });
});

test.describe('visual: command palette', () => {
  test('palette with a highlighted result', async ({ gotoApp, page }) => {
    await gotoApp();
    await openPalette(page);
    const input = paletteInput(page);
    await input.fill('local');
    await expect(page.locator(sel.paletteModal).getByText('LocalSend', { exact: true }).first()).toBeVisible();
    // The first row is highlighted by default (selectedIndex 0).
    await shoot(page, 'command-palette-result');
  });
});

test.describe('visual: Persian RTL', () => {
  test.use({ lang: 'fa' });

  test('RTL catalog', async ({ gotoApp, page }) => {
    await gotoApp();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await shoot(page, 'rtl-catalog-fa');
  });

  test('RTL command palette', async ({ gotoApp, page }) => {
    await gotoApp();
    await openPalette(page);
    await shoot(page, 'rtl-palette-fa');
  });

  test('RTL detail dialog', async ({ gotoApp, page }) => {
    await gotoApp();
    await page.locator('#app-title-localsend').click();
    await expect(page.getByRole('dialog').first()).toBeVisible();
    await shoot(page, 'rtl-detail-fa');
  });

  test('RTL download manager', async ({ gotoApp, page }) => {
    await gotoApp();
    await openDownloads(page, 'fa');
    await shoot(page, 'rtl-downloads-fa');
  });

  test('RTL privacy pack', async ({ gotoApp, page }) => {
    await gotoApp();
    await page.locator(sel.privacyTab).click();
    await expect(page.locator('#replace-tab')).toBeVisible();
    await shoot(page, 'rtl-privacy-fa');
  });
});

test.describe('visual: perf-scale catalog (500 entries)', () => {
  test.use({ customItems: PERF_CATALOG });

  test('500-app catalog at desktop width', async ({ gotoApp, page }) => {
    await gotoApp();
    await shoot(page, 'catalog-500-scale');
  });
});
