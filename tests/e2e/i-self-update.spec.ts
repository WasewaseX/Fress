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
  OWN_RELEASES_NO_SIG,
  OWN_SUMS_WRONG_HASH,
  OWN_SUMS_PARTIAL,
  OWN_SIG_TXT,
  GOOD_SHA256,
} from './fixtures/data';

const d = DICTS.en;
const VALID_RELEASE_URL = 'https://github.com/WasewaseX/Fress/releases/tag/v1.0.9-beta';

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

/** Ids the engine has registered so far (the bridge is the source of truth). */
async function registeredDownloadIds(page: import('@playwright/test').Page): Promise<number[]> {
  const b = (await bridge(page))!;
  return Object.keys(b.downloads).map(Number);
}

test.describe('Workflow I: valid release fixture', () => {
  test.use({ ownReleases: { list: OWN_RELEASES_VALID } });

  test('valid newer tag: pill appears, clicking starts a checksummed download', async ({ gotoApp, page }) => {
    await gotoApp();

    await checkForUpdates(page);

    // The available toast names the exact version (tag without the v).
    const toast = page.locator('[data-sonner-toast]').first();
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(d['update.availableToast'].replace('{version}', '1.0.9-beta'));

    // The header pill is on screen and names the version.
    const pill = page.locator('#header-update-pill');
    await expect(pill).toBeVisible();
    await expect(pill).toContainText(d['header.updatePill'].replace('{v}', '1.0.9-beta'));
    await expect(pill).toHaveAttribute('title', d['header.updatePillTitle'].replace('{v}', '1.0.9-beta'));

    await drainToasts(page);

    // Clicking the pill hands the asset to the download engine WITH the
    // published SHA-256 (the machine-truth contract: verified, not merely
    // calculated) - and never opens the releases page.
    await pill.click();
    const b = (await bridge(page))!;
    const entries = Object.values(b.downloads);
    expect(entries).toHaveLength(1);
    expect(entries[0].url).toBe('https://github.com/WasewaseX/Fress/releases/download/v1.0.9-beta/Fress_1.0.9_amd64.AppImage');
    expect(entries[0].expectedSha256).not.toBeNull();
    expect(entries[0].filename).toBe('Fress_1.0.9_amd64.AppImage');
    expect(b.openedUrls).toEqual([]);

    // The transfer is a real download-manager row (same pipeline as any app).
    await openDownloads(page);
    await expect(page.locator(sel.downloadsPanel)).toContainText('Fress_1.0.9_amd64.AppImage');
  });

  /** Workflow I, second half: the post-download signature gate. The native
   * engine confirms the checksum (verified: true), and BEFORE the app can
   * call the update "verified", `verify_self_update_signature` must run
   * against the ENGINE-reported completion path with the release's sidecar
   * document. Only then may the verified state appear. */
  test('completed download is signature-verified before the app claims verified', async ({ gotoApp, page }) => {
    await gotoApp();
    await checkForUpdates(page);
    await drainToasts(page);

    await page.locator('#header-update-pill').click();
    const b = (await bridge(page))!;
    const id = Number(Object.keys(b.downloads)[0]);
    const finalPath = '/home/test/Downloads/Fress_1.0.9_amd64.AppImage';

    // The engine finishes and CONFIRMS the published digest. (The bridge's
    // emit methods only exist inside the page - functions do not survive
    // page.evaluate's structured clone - so they are called in-page, and
    // every value travels through the argument object.)
    await page.evaluate(
      ({ id, path, sha }) => window.__fressTest!.emitComplete(id, path, 22_000_000, sha, true),
      { id, path: finalPath, sha: GOOD_SHA256 }
    );

    // The native verifier ran against the exact completed bytes with the
    // release sidecar document - the machine-truth binding contract.
    await expect
      .poll(async () => (await bridge(page))!.calls.filter((c) => c.cmd === 'verify_self_update_signature').length, { timeout: 10_000 })
      .toBe(1);
    const b2 = (await bridge(page))!;
    const verify = b2.calls.find((c) => c.cmd === 'verify_self_update_signature');
    expect(verify?.args.filePath).toBe(finalPath);
    expect(verify?.args.signatureBase64).toBe(OWN_SIG_TXT);

    // Only now does the app render the verified outcome: the success toast
    // names the verified state, and the pill flips to its ready label.
    const verifiedToast = page.locator('[data-sonner-toast]', { hasText: d['update.verifiedReady'] });
    await expect(verifiedToast.first()).toBeVisible();
    await expect(page.locator('#header-update-pill')).toContainText(
      d['header.updatePillReady'].replace('{v}', '1.0.9-beta')
    );
    // No fallback and no auto-launch anywhere in the happy path.
    expect(b2.openedUrls).toEqual([]);
  });

  /** The mirror contract: a failed signature verification (foreign key,
   * tampered bytes - the Rust suite covers the crypto, this covers the
   * FLOW) must surface as an explained failure with the releases-page
   * fallback, never as a verified update. */
  test('a rejected signature is an explained failure with the releases-page fallback', async ({ gotoApp, page }) => {
    await gotoApp();
    await checkForUpdates(page);
    await drainToasts(page);

    const b0 = (await bridge(page))!;
    await page.evaluate(() =>
      window.__fressTest!.setFailVerify('Updater signature verification failed')
    );

    await page.locator('#header-update-pill').click();
    // The download registry only exists AFTER the click started the
    // delivery - the earlier snapshot was taken before it, so re-read it.
    const b1 = (await bridge(page))!;
    const id = Number(Object.keys(b1.downloads)[0]);
    await page.evaluate(
      ({ id, path, sha }) => window.__fressTest!.emitComplete(id, path, 22_000_000, sha, true),
      { id, path: '/home/test/Downloads/Fress_1.0.9_amd64.AppImage', sha: GOOD_SHA256 }
    );

    const failedToast = page.locator('[data-sonner-toast]', { hasText: d['update.signatureFailed'] });
    await expect(failedToast.first()).toBeVisible({ timeout: 10_000 });
    // The pill tells the truth about what is deliverable, and the official
    // releases page opened as the fallback.
    await expect(page.locator('#header-update-pill')).toContainText(
      d['header.updatePillSeeReleases']
    );
    await expect
      .poll(async () => (await bridge(page))!.openedUrls ?? [], { timeout: 10_000 })
      .toEqual(['https://github.com/WasewaseX/Fress/releases/tag/v1.0.9-beta']);
  });
});

test.describe('Workflow I: malformed tag fixture', () => {
  test.use({ ownReleases: { list: OWN_RELEASE_MALFORMED } });

  test('malformed tag: never offered as an update, check does not crash', async ({ gotoApp, page }) => {
    await gotoApp();

    await checkForUpdates(page);

    // The updater FAILS CLOSED on a feed with zero parsable tags: the tag
    // drops out of the candidate list (selfUpdate drops unparsable tags
    // before sorting), the feed filters to empty, and the pre-existing
    // "No published releases" contract reports the check as UNAVAILABLE -
    // the honest machine-truth answer (claiming "you are on the latest
    // version" would be a guess about a feed we could not read). No pill,
    // no download, no releases-page open, no crash. (Before the strict
    // parser, this fixture produced the "latest" toast by ranking garbage
    // below the running version; that leniency is what the updater no
    // longer has.)
    const toast = page.locator('[data-sonner-toast]').first();
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(d['update.unavailable']);
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

    // On the Stable channel the only newer build (v1.0.9-beta, flagged
    // prerelease) is invisible; the stable v1.0.6 is OLDER than the running
    // 1.0.8-beta. The check must report "latest".
    await checkForUpdates(page);
    const toast = page.locator('[data-sonner-toast]').first();
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(d['update.latestToast'].replace('{version}', '1.0.8-beta'));
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
    await expect(available).toContainText(d['update.availableToast'].replace('{version}', '1.0.9-beta'));
    await expect(page.locator('#header-update-pill')).toBeVisible();
  });
});

test.describe('Workflow J: incompatible-asset release', () => {
  // The sums file deliberately carries a digest for the incompatible
  // installer: if the picker wrongly selects it, the user gets a fully
  // "verified" download of a file their machine cannot run (worst case).
  test.use({ ownReleases: { list: OWN_RELEASE_ARM_ONLY }, ownSums: OWN_SUMS_ARM_ONLY });

  /**
   * CONTRACT (Workflow 10): when a release contains ONLY files the running
   * machine cannot use (wrong architecture, wrong platform), the updater
   * must still detect the update but offer NO direct download - the pill
   * opens the releases page (planUpdateDelivery reason 'no-asset').
   *
   * This was pinned as test.fail against the v1.0.7-beta picker (a
   * best-candidate loop that accepted any score above -Infinity, so an
   * ARM-only release resolved to an uninstallable file on an x64 host).
   * The two-phase picker (PR #29) made eligibility a hard gate: every
   * asset in this fixture is refused, pickOwnAsset returns null, and the
   * delivery planner routes to the releases page - the annotation is
   * lifted exactly as its original instruction required. The SHA256SUMS
   * fixture below keeps the worst case covered: even a digest published
   * for the incompatible file cannot make it downloadable.
   */
  test('ARM-only release: pill shows, clicking opens the releases page, no download starts', async ({ gotoApp, page }) => {
    await gotoApp();

    await checkForUpdates(page);
    // The update itself is real: the pill appears.
    await expect(page.locator('#header-update-pill')).toBeVisible();
    await drainToasts(page);

    // The fail-closed contract: no platform-matched asset -> the releases
    // page opens (with the "no asset" hint), the download registry stays
    // EMPTY, and the "downloading" toast never appears.
    //
    // openExternal records through an async dynamic import, so the bridge
    // read must POLL for the recorded URL instead of racing it (CI runners
    // lost this race once; the toast assertion below auto-waits already).
    await page.locator('#header-update-pill').click();
    await expect
      .poll(async () => (await bridge(page))?.openedUrls ?? [], { timeout: 10_000 })
      .toEqual([VALID_RELEASE_URL]);
    const b = (await bridge(page))!;
    expect(Object.keys(b.downloads)).toHaveLength(0);

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

    // Same poll discipline as the ARM-only sibling above: the opener
    // records through an async import, never race the bridge read.
    await page.locator('#header-update-pill').click();
    await expect
      .poll(async () => (await bridge(page))?.openedUrls ?? [], { timeout: 10_000 })
      .toEqual([VALID_RELEASE_URL]);
    const b = (await bridge(page))!;
    expect(Object.keys(b.downloads)).toHaveLength(0);

    const toast = page.locator('[data-sonner-toast]').first();
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(d['update.releasesPage']);
    await expect(toast).toContainText(d['update.unverifiableHint']);
  });
});

test.describe('Workflow J: published digest is wrong (corrupted release)', () => {
  // The manifest exists, the line for the platform-matched AppImage exists,
  // and the published hash is simply NOT the digest of the artifact. This is
  // the delivery-layer integrity contract: the engine compares the fetched
  // bytes' digest against THE PUBLISHED reference and refuses on mismatch -
  // a corrupted or substituted update can never complete as "verified",
  // never open anything, and the only sound recovery is a fresh Retry.
  test.use({ ownReleases: { list: OWN_RELEASES_VALID }, ownSums: OWN_SUMS_WRONG_HASH });

  test('wrong published hash: transfer fails with kind=checksum, never verified, retry is a fresh request', async ({ gotoApp, page }) => {
    await gotoApp();

    await checkForUpdates(page);
    await expect(page.locator('#header-update-pill')).toBeVisible();
    await drainToasts(page);

    // The planner hands the engine the PUBLISHED (wrong) digest as the
    // verification reference - the trust root is the release manifest,
    // exactly as in production. The registry records that reference.
    await page.locator('#header-update-pill').click();
    await expect
      .poll(async () => (await registeredDownloadIds(page)).length, { timeout: 10_000 })
      .toBe(1);
    await openDownloads(page);
    const [id] = await registeredDownloadIds(page);
    const b0 = (await bridge(page))!;
    expect(b0.downloads[id].expectedSha256).toBe('d'.repeat(64));
    expect(b0.downloads[id].filename).toBe('Fress_1.0.9_amd64.AppImage');

    // The engine fetches the artifact, computes its real digest, compares,
    // refuses: kind=checksum, corrupt bytes deleted, resume is pointless.
    await page.evaluate((did) => window.__fressTest!.emitProgress(did, 22_000_000, 22_000_000, 0, 0), id);
    await page.evaluate((did) => window.__fressTest!.emitError(did, 'SHA-256 mismatch: artifact is corrupt and was deleted', 'checksum'), id);

    // UI state: failed row with the mismatch message; no completed row.
    const errRow = page.locator(sel.downloadRow('error')).first();
    await expect(errRow).toContainText(d['downloads.failed']);
    await expect(errRow).toContainText('SHA-256 mismatch');
    await expect(page.locator(sel.downloadRow('completed'))).toHaveCount(0);
    // No row may claim the verified label either (verified rows carry their
    // own status marker; zero completed rows already implies it, asserted
    // for a precise failure message if the contract ever breaks).
    expect(await page.locator(sel.downloadRows).allTextContents())
      .not.toContain(d['downloads.verified']);

    // Registry state: no download-complete event ever reached the UI.
    const cur = (await bridge(page))!;
    expect(cur.emits.filter((e) => e.event === 'download-complete')).toHaveLength(0);

    // Persisted history (what a restart would show): an error, never a
    // verified completion, for this update transfer.
    const persisted = await page.evaluate(() => localStorage.getItem('fress.downloadItems.v1') ?? '');
    expect(persisted).toContain('"status":"error"');
    expect(persisted).not.toContain('"status":"completed"');
    expect(persisted).not.toContain('"verified":true');

    // No external escape hatch fired: the failure stays in the manager.
    // A corrupted TRANSFER is retryable (a fresh request re-downloads and
    // re-checks), so the row's Retry is the recovery path - the delivery
    // layer reports a non-fallback checksum failure and opens nothing.
    // The artifact itself is never launched, and no verified claim exists.
    expect(cur.openedUrls).toEqual([]);
    const checksumToast = page.locator('[data-sonner-toast]').first();
    await expect(checksumToast).toContainText(d['update.checksumFailed']);
    await expect(checksumToast).toContainText(d['update.checksumFailedHint']);

    // The offered action is Retry (fresh), not Resume - and the fresh
    // request targets the same update asset.
    await expect(errRow.getByRole('button', { name: d['downloads.retry'] })).toBeVisible();
    await expect(errRow.getByRole('button', { name: d['downloads.resume'] })).toHaveCount(0);
    await errRow.getByRole('button', { name: d['downloads.retry'] }).click();
    await expect
      .poll(async () => {
        const cur2 = (await bridge(page))!;
        const calls = cur2.calls.filter((c) => c.cmd === 'start_download');
        const last = calls[calls.length - 1]?.args as { resume?: boolean; url?: string } | null;
        return calls.length >= 2 && last?.resume === false && last?.url === 'https://github.com/WasewaseX/Fress/releases/download/v1.0.9-beta/Fress_1.0.9_amd64.AppImage';
      })
      .toBe(true);
  });
  /** The user stops the transfer on purpose. Cancellation is NOT a
   * failure: the delivery layer goes back to idle with no failure
   * theatre - no error toast, no releases-page fallback, no verified
   * claim - and the pill returns to its plain "update available" label
   * because the update itself is still detected and still available. */
  test('cancelling the update transfer is quiet: back to available, no fallback, no verified claim', async ({ gotoApp, page }) => {
    await gotoApp();
    await checkForUpdates(page);
    await expect(page.locator('#header-update-pill')).toBeVisible();
    await drainToasts(page);

    await page.locator('#header-update-pill').click();
    await expect
      .poll(async () => Object.keys((await bridge(page))!.downloads).length, { timeout: 10_000 })
      .toBe(1);

    // The user cancels from the download manager - the same surface as
    // any other download. The bridge emits the terminal 'Cancelled'
    // error on cancel_download, so the real event path is exercised.
    await openDownloads(page);
    await page.locator(sel.downloadRow('active')).first().getByRole('button', { name: d['downloads.cancel'] }).click();

    // The engine received the cancel for this transfer...
    await expect
      .poll(async () => (await bridge(page))!.calls.filter((c) => c.cmd === 'cancel_download').length, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(1);
    // ...and the delivery layer reacts to 'Cancelled' exactly as
    // designed: idle phase, plain pill, zero fallbacks, zero failure
    // toasts, zero verified rows.
    await expect(page.locator('#header-update-pill')).toContainText(
      d['header.updatePill'].replace('{v}', '1.0.9-beta'), { timeout: 10_000 }
    );
    const cur = (await bridge(page))!;
    expect(cur.openedUrls).toEqual([]);
    for (const key of [d['update.signatureFailed'], d['update.checksumFailed'], d['update.releasesPage']]) {
      await expect(page.locator('[data-sonner-toast]', { hasText: key })).toHaveCount(0);
    }
    // The registry tells the truth: a cancelled row, never a completed or
    // verified one.
    await expect(page.locator(sel.downloadRow('cancelled'))).toHaveCount(1);
    expect(await page.locator(sel.downloadRows).allTextContents())
      .not.toContain(d['downloads.verified']);
  });
});

test.describe('Workflow J: SHA256SUMS.txt omits the chosen asset (partial manifest)', () => {
  // Sibling of the 404 case above, but the manifest EXISTS and answers 200:
  // it simply carries no line for the platform-matched AppImage (truncated
  // or partially published). "The file exists" is not the contract - the
  // LINE for the chosen asset is. Delivery must fail closed to the releases
  // page with the unverifiable reason, never start an unreferenceable
  // download.
  test.use({ ownReleases: { list: OWN_RELEASES_VALID }, ownSums: OWN_SUMS_PARTIAL });

  test('partial manifest: releases page with unverifiable hint, no download', async ({ gotoApp, page }) => {
    await gotoApp();

    await checkForUpdates(page);
    await expect(page.locator('#header-update-pill')).toBeVisible();
    await drainToasts(page);

    await page.locator('#header-update-pill').click();
    await expect
      .poll(async () => (await bridge(page))?.openedUrls ?? [], { timeout: 10_000 })
      .toEqual([VALID_RELEASE_URL]);
    const b = (await bridge(page))!;
    expect(Object.keys(b.downloads)).toHaveLength(0);

    const toast = page.locator('[data-sonner-toast]').first();
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(d['update.releasesPage']);
    await expect(toast).toContainText(d['update.unverifiableHint']);
  });
});

test.describe('Workflow J: unsigned platform artifact (no signature sidecar)', () => {
  // The macOS/Android matrix row as a release: the platform-matched asset
  // and its published checksum line EXIST, but the release ships no
  // <asset>.sig sidecar. The third delivery gate fails closed - no
  // in-app download of a file that cannot be publisher-verified; the
  // official releases page opens with the exact 'unsigned' reason.
  test.use({ ownReleases: { list: OWN_RELEASES_NO_SIG } });

  test('release without a sidecar: releases page with the unsigned reason, no download', async ({ gotoApp, page }) => {
    await gotoApp();

    await checkForUpdates(page);
    await expect(page.locator('#header-update-pill')).toBeVisible();
    await drainToasts(page);

    await page.locator('#header-update-pill').click();
    // The official releases page opens as the fallback...
    await expect
      .poll(async () => (await bridge(page))?.openedUrls ?? [], { timeout: 10_000 })
      .toEqual([VALID_RELEASE_URL]);
    // ...and NO in-app delivery may start: the download registry stays
    // empty, so nothing can ever be presented as a verified update.
    const b = (await bridge(page))!;
    expect(Object.keys(b.downloads)).toHaveLength(0);
    // The honest reason, explained in the UI, localized like every other
    // updater string.
    const toast = page.locator('[data-sonner-toast]').first();
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(d['update.releasesPage']);
    await expect(toast).toContainText(d['update.unsignedHint']);
    // The pill must never claim an outcome the delivery cannot deliver:
    // no "verified · ready", no fake progress - the plain available label
    // is the current contract. (Truthfulness improvement routed to the
    // self-update owner: after a plan-level refusal the pill could carry
    // the see-releases label like a post-download failure does; tracked
    // in docs/quality-gates.md, owner: self-update.)
    await expect(page.locator('#header-update-pill')).not.toContainText(
      d['header.updatePillReady'].replace('{v}', '1.0.9-beta')
    );
    await expect(page.locator('#header-update-pill')).not.toContainText(d['header.updatePillDownloading']);
  });
});
