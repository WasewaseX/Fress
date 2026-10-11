// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
/**
 * Workflows I & J - the app's own self-update against release fixtures.
 *
 * Everything runs in Tauri mode: the self-update chain is a native-surface
 * feature (host_arch, fetch_self_update_text, opener plugin, verified
 * download engine). The release feed, the checksum document and the arch
 * probe all answer from deterministic fixtures; no live GitHub call.
 *
 * Workflow I (release-tag truth):
 *   - a valid newer tag surfaces the pill and delivers a VERIFIED in-app
 *     download (the published SHA-256 travels with the request),
 *   - a malformed tag is never offered as an update (string ordering ranks
 *     it below the running version) and never crashes the check,
 *   - wrong-channel tags stay invisible: a prerelease never reaches the
 *     Stable channel, and switching the channel surfaces it again.
 *
 * Workflow J (asset truth - fail closed):
 *   - a release with ONLY incompatible-architecture files is still detected
 *     as an update, but the button opens the releases page; no direct
 *     download is ever offered (pickOwnAsset -> null -> 'no-asset'),
 *   - a usable asset whose checksum cannot be established is ALSO refused
 *     in-app (fail closed): releases page with the "unverifiable" reason,
 *     no download (planUpdateDelivery -> 'unverifiable').
 *
 * The observable results are asserted - bridge download registry, opener
 * log, pill visibility, toasts - not the mere firing of a mocked call.
 */
import { expect, bridge } from './fixtures';
import { sel, openDownloads } from './selectors';
import { test } from './fixtures';
import { DICTS } from '../../src/lib/i18n';
import {
  OWN_RELEASES_VALID,
  OWN_RELEASE_MALFORMED,
  OWN_RELEASES_CHANNEL,
  OWN_RELEASE_ARM_ONLY,
  OWN_SUMS_ARM_ONLY,
  OWN_RELEASE_NO_SUMS,
} from './fixtures/data';

const d = DICTS.en;
const VALID_RELEASE_URL = 'https://github.com/WasewaseX/Fress/releases/tag/v1.0.8-beta';

test.use({ tauriMode: true });

/** Opens the header more-menu (idempotent: the popover may already be open)
 * and fires the manual update check. */
async function openMoreMenu(page: import('@playwright/test').Page) {
  const btn = page.getByRole('button', { name: d['header.moreMenu'] }).first();
  if ((await btn.getAttribute('aria-expanded')) !== 'true') {
    await btn.click();
  }
  await expect(btn).toHaveAttribute('aria-expanded', 'true');
  return btn;
}

async function checkForUpdates(page: import('@playwright/test').Page): Promise<void> {
  await openMoreMenu(page);
  await page.getByRole('button', { name: d['header.checkUpdates'] }).first().click();
}

/** Lets the toast queue drain so the next click cannot be intercepted. */
async function drainToasts(page: import('@playwright/test').Page): Promise<void> {
  await expect
    .poll(async () => page.locator('[data-sonner-toast]').count(), { timeout: 15_000 })
    .toBe(0);
}

test.describe('Workflow I: valid release fixture', () => {
  test.use({ ownReleases: { list: OWN_RELEASES_VALID } });

  test('valid newer tag: pill appears, clicking starts a checksummed download', async ({ gotoApp, page }) => {
    await gotoApp();

    await checkForUpdates(page);

    // The available toast names the exact version (tag without the v).
    const toast = page.locator('[data-sonner-toast]').first();
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(d['update.availableToast'].replace('{version}', '1.0.8-beta'));

    // The header pill is on screen and names the version.
    const pill = page.locator('#header-update-pill');
    await expect(pill).toBeVisible();
    await expect(pill).toContainText(d['header.updatePill'].replace('{v}', '1.0.8-beta'));
    await expect(pill).toHaveAttribute('title', d['header.updatePillTitle'].replace('{v}', '1.0.8-beta'));

    await drainToasts(page);

    // Clicking the pill hands the asset to the download engine WITH the
    // published SHA-256 (the machine-truth contract: verified, not merely
    // calculated) - and never opens the releases page.
    await pill.click();
    const b = (await bridge(page))!;
    const entries = Object.values(b.downloads);
    expect(entries).toHaveLength(1);
    expect(entries[0].url).toBe('https://github.com/WasewaseX/Fress/releases/download/v1.0.8-beta/Fress_1.0.8_amd64.AppImage');
    expect(entries[0].expectedSha256).not.toBeNull();
    expect(entries[0].filename).toBe('Fress_1.0.8_amd64.AppImage');
    expect(b.openedUrls).toEqual([]);

    // The transfer is a real download-manager row (same pipeline as any app).
    await openDownloads(page);
    await expect(page.locator(sel.downloadsPanel)).toContainText('Fress_1.0.8_amd64.AppImage');
  });
});

test.describe('Workflow I: malformed tag fixture', () => {
  test.use({ ownReleases: { list: OWN_RELEASE_MALFORMED } });

  test('malformed tag: never offered as an update, check does not crash', async ({ gotoApp, page }) => {
    await gotoApp();

    await checkForUpdates(page);

    // The updater reports "latest" - the malformed tag ranks below the
    // running version - and no pill, no download, no releases-page open.
    const toast = page.locator('[data-sonner-toast]').first();
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(d['update.latestToast'].replace('{version}', '1.0.7-beta'));
    await expect(page.locator('#header-update-pill')).toHaveCount(0);

    const b = (await bridge(page))!;
    expect(Object.keys(b.downloads)).toHaveLength(0);
    expect(b.openedUrls).toEqual([]);
  });
});

test.describe('Workflow I: wrong-channel fixtures', () => {
  test.use({ ownReleases: { list: OWN_RELEASES_CHANNEL }, updateChannel: 'stable' });

  test('Stable hides the prerelease, switching channels surfaces it', async ({ gotoApp, page }) => {
    await gotoApp();

    // On the Stable channel the only newer build (v1.0.8-beta, flagged
    // prerelease) is invisible; the stable v1.0.6 is OLDER than the running
    // 1.0.7-beta. The check must report "latest".
    await checkForUpdates(page);
    const toast = page.locator('[data-sonner-toast]').first();
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(d['update.latestToast'].replace('{version}', '1.0.7-beta'));
    await expect(page.locator('#header-update-pill')).toHaveCount(0);

    await drainToasts(page);

    // Switch to the Beta channel through the menu (aria-pressed toggle).
    await openMoreMenu(page);
    await page.getByRole('button', { name: 'beta', exact: true }).first().click();
    const channelToast = page.locator('[data-sonner-toast]').first();
    await expect(channelToast).toBeVisible();
    await expect(channelToast).toContainText(d['update.channelSet'].replace('{channel}', 'beta'));
    await expect
      .poll(async () => page.evaluate(() => localStorage.getItem('fress.updateChannel')))
      .toBe('beta');

    await drainToasts(page);

    // The same feed now yields the update.
    await checkForUpdates(page);
    const available = page.locator('[data-sonner-toast]').first();
    await expect(available).toBeVisible();
    await expect(available).toContainText(d['update.availableToast'].replace('{version}', '1.0.8-beta'));
    await expect(page.locator('#header-update-pill')).toBeVisible();
  });
});

test.describe('Workflow J: incompatible-asset release', () => {
  // The sums file deliberately carries a digest for the incompatible
  // installer: if the picker wrongly selects it, the user gets a fully
  // "verified" download of a file their machine cannot run (worst case).
  test.use({ ownReleases: { list: OWN_RELEASE_ARM_ONLY }, ownSums: OWN_SUMS_ARM_ONLY });

  /**
   * KNOWN DEFECT - pinned with test.fail, routed to the self-update owner.
   *
   * CONTRACT (Workflow 10): when a release contains ONLY files the running
   * machine cannot use (wrong architecture, wrong platform), the updater
   * must still detect the update but offer NO direct download - the pill
   * opens the releases page (planUpdateDelivery reason 'no-asset').
   *
   * ACTUAL: pickOwnAsset's best-candidate loop accepts ANY score above
   * -Infinity, and "not a Linux format" scores -1 while "wrong Windows
   * arch" scores 3 (arm64 on an x64 host; 5 more if the name says setup).
   * So on an x86_64 Linux host the ARM-only release below resolves to
   * Fress_1.0.8_arm64-setup.exe, and on an x64 WINDOWS host the same class
   * of release resolves to the arm64 installer (score 8). With the digest
   * published in SHA256SUMS.txt (this fixture) the result is a fully
   * "verified" in-app download of a file the machine cannot run - the
   * exact outcome Workflow 10 forbids.
   *
   * Reproduction (unit level, no browser needed):
   *   pickOwnAsset(release(['Fress_1.0.8_arm64-setup.exe']), 'x86_64')
   *   with a Windows UA -> returns the arm64 installer; expected null.
   * (The Linux -Infinity path already refuses correctly when the asset is
   * at least a Linux format - it is the cross-format leak at -1/3 that
   * defeats the contract.)
   *
   * Encoded as test.fail: the suite stays honest in BOTH directions. The
   * moment pickOwnAsset refuses incompatible-only releases this test passes
   * unexpectedly, CI turns red, and the annotation MUST be lifted.
   */
  test.fail('ARM-only release: pill shows, clicking opens the releases page, no download starts', async ({ gotoApp, page }) => {
    await gotoApp();

    await checkForUpdates(page);
    // The update itself is real: the pill appears.
    await expect(page.locator('#header-update-pill')).toBeVisible();
    await drainToasts(page);

    // The fail-closed contract: no platform-matched asset -> the releases
    // page opens (with the "no asset" hint), the download registry stays
    // EMPTY, and the "downloading" toast never appears.
    await page.locator('#header-update-pill').click();
    const b = (await bridge(page))!;
    expect(Object.keys(b.downloads)).toHaveLength(0);
    expect(b.openedUrls).toEqual([VALID_RELEASE_URL]);

    const toast = page.locator('[data-sonner-toast]').first();
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(d['update.releasesPage']);
    await expect(toast).toContainText(d['update.noAssetHint']);
  });
});

test.describe('Workflow J: unverifiable asset (checksum fail-closed)', () => {
  // ownReleases without ownSums: the checksum document 404s, so the
  // published digest cannot be established.
  test.use({ ownReleases: { list: OWN_RELEASE_NO_SUMS }, ownSums: undefined });

  test('missing SHA256SUMS.txt: releases page, no in-app download', async ({ gotoApp, page }) => {
    await gotoApp();

    await checkForUpdates(page);
    await expect(page.locator('#header-update-pill')).toBeVisible();
    await drainToasts(page);

    await page.locator('#header-update-pill').click();
    const b = (await bridge(page))!;
    expect(Object.keys(b.downloads)).toHaveLength(0);
    expect(b.openedUrls).toEqual([VALID_RELEASE_URL]);

    const toast = page.locator('[data-sonner-toast]').first();
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(d['update.releasesPage']);
    await expect(toast).toContainText(d['update.unverifiableHint']);
  });
});
