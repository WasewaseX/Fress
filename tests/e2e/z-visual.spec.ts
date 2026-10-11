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
import { sel, openPalette, openDownloads, dict } from './selectors';
import { DICTS } from '../../src/lib/i18n';
import { PAYLOAD_SHA256 } from './fixtures/data';

const VIEWPORTS = [390, 768, 1366, 1600, 1920];

async function shoot(page: import('@playwright/test').Page, name: string): Promise<void> {
  await fontsReady(page);
  await expect(page).toHaveScreenshot([`${name}.png`], { fullPage: false });
}

test.describe('visual: catalog', () => {
  test('main catalog, light theme', async ({ gotoApp, page }) => {
    await gotoApp();
    await shoot(page, 'catalog-light');
  });

  test('main catalog, dark theme', async ({ gotoApp, page }) => {
    await gotoApp();
    await page.getByRole('button', { name: DICTS.en['header.moreMenu'] }).first().click();
    await page.getByRole('button', { name: DICTS.en['header.dark'] }).first().click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await shoot(page, 'catalog-dark');
  });

  for (const width of VIEWPORTS) {
    test(`main catalog at ${width} CSS pixels`, async ({ gotoApp, page }) => {
      await page.setViewportSize({ width, height: 900 });
      await gotoApp();
      await shoot(page, `catalog-${width}`);
    });
  }
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
    await page.getByRole('button', { name: DICTS.en['header.moreMenu'] }).first().click();
    await page.getByRole('button', { name: DICTS.en['header.dark'] }).first().click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await shoot(page, 'privacy-dark');
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
    const input = page.getByRole('textbox', { name: dict()['palette.inputAria'] });
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
