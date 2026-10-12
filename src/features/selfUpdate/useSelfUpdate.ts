// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { useEffect, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { revealItemInDir } from '@tauri-apps/plugin-opener';

import { useI18n } from '../../lib/i18n';
import { openExternal } from '../../lib/external';
import { useDownloadActions, useDownloadItems } from '../../lib/downloads';
import {
  checkForUpdate,
  getUpdateChannel,
  setUpdateChannel,
  OwnRelease,
  UpdateChannel,
  UpdateState,
} from '../../lib/selfUpdate';
import {
  getDeliveryState,
  isDelivering,
  setDeliveryTranslator,
  startOwnUpdateDelivery,
  subscribeDelivery,
  syncDeliveryItems,
  UpdateDeliveryState,
} from './updateDelivery';
import pkg from '../../../package.json';

/**
 * In-app self-update state: compares this install against the newest
 * GitHub release. Checked automatically at most once every 24 hours, plus
 * on demand from the menu. When an update exists, the header shows a pill;
 * tapping it starts the delivery lifecycle (updateDelivery.ts): checksum
 * expectation, signature sidecar, verified download - and the in-app flow
 * only calls the result "verified" after the native signature check passed
 * on the completed file.
 *
 * The hook receives `startDownload` from the downloads context so the
 * update asset goes through the same verified download pipeline as every
 * other file. The download manager's item list is mirrored into the
 * delivery module so a terminal download event can be bound to THIS update
 * through the manager's own id->url records.
 */

export interface SelfUpdateUi {
  ownUpdate: { release: OwnRelease; asset: { name: string; size: number; url: string } | null; expectedSha256: string | null } | null;
  updateChecking: boolean;
  updateChannel: UpdateChannel;
  handleUpdateChannelChange: (channel: UpdateChannel) => void;
  runUpdateCheck: (announce: boolean) => Promise<UpdateState | null>;
  handleHeaderUpdateClick: () => void;
  /** Live delivery status for the header pill (label override + busy);
   * null when the pill should show its default "Update {v}" text. */
  updatePillStatus: { label: string; busy: boolean } | null;
}

/** Maps the delivery state onto the pill's label override. Kept beside the
 * hook (not inside the delivery module) so every label comes from i18n and
 * carries the release version the pill already names.
 *
 * Exported for the updater UI-state tests: this mapping IS the pill's
 * truthfulness contract, so every phase (including every plan-level
 * refusal reason) is pinned in isolation, not only through the rendered
 * header. */
export function pillStatusFor(
  delivery: UpdateDeliveryState,
  version: string,
  t: (key: string) => string
): { label: string; busy: boolean } | null {
  const v = (key: string) => t(key).replace('{v}', version);
  switch (delivery.phase) {
    case 'fetching-signature':
    case 'downloading':
      return { label: v('header.updatePillDownloading'), busy: true };
    case 'verifying-checksum':
      return { label: v('header.updatePillVerifyingChecksum'), busy: true };
    case 'verifying-signature':
      return { label: v('header.updatePillVerifyingSignature'), busy: true };
    case 'verified':
      return { label: v('header.updatePillReady'), busy: false };
    case 'failed':
      return delivery.fallback
        ? { label: t('header.updatePillSeeReleases'), busy: false }
        : { label: t('header.updatePillRetry'), busy: false };
    case 'fallback':
      // A PLAN-LEVEL refusal ('no-asset' | 'unverifiable' | 'unsigned'):
      // the planner just proved this update cannot be delivered in-app,
      // so the pill must say where to get it instead of reverting to the
      // plain available label - that label implies in-app delivery is
      // still on the table. The WHY travels through the refusal toast
      // (noAssetHint / unverifiableHint / unsignedHint) raised with the
      // fallback; the pill stays non-busy and clicking it re-runs the
      // planner (which re-opens the official Releases page, or delivers
      // for real if the release gained the missing gate in the meantime).
      return { label: t('header.updatePillSeeReleases'), busy: false };
    default:
      return null;
  }
}

export function useSelfUpdate(
  startDownload: (url: string, nameHint?: string, opts?: { expectedSha256?: string }) => void
): SelfUpdateUi {
  const { t } = useI18n();

  const [ownUpdate, setOwnUpdate] = useState<{ release: OwnRelease; asset: { name: string; size: number; url: string } | null; expectedSha256: string | null } | null>(null);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateChannel, setUpdateChannelState] = useState<UpdateChannel>(() => getUpdateChannel());

  // Delivery lifecycle: subscribe for the pill, translate module toasts,
  // and mirror the download manager's items so terminal download events
  // can be bound to this update through the manager's own records.
  const deliveryState = useSyncExternalStore(subscribeDelivery, getDeliveryState);
  const { items } = useDownloadItems();

  useEffect(() => {
    setDeliveryTranslator(t);
  }, [t]);

  useEffect(() => {
    syncDeliveryItems(
      items.map((it) => ({
        id: it.id,
        url: it.url,
        status: it.status,
        path: it.path,
        verified: it.verified,
      }))
    );
  }, [items]);

  const handleUpdateChannelChange = (channel: UpdateChannel) => {
    setUpdateChannelState(channel);
    setUpdateChannel(channel);
    toast.info(t('update.channelSet').replace('{channel}', channel), {
      description: t('update.channelSetHint'),
    });
  };

  const runUpdateCheck = async (announce: boolean): Promise<UpdateState | null> => {
    if (updateChecking) return null;
    setUpdateChecking(true);
    const res = await checkForUpdate(pkg.version);
    setOwnUpdate(res.kind === 'available' ? { release: res.release, asset: res.asset, expectedSha256: res.expectedSha256 } : null);
    if (announce) {
      if (res.kind === 'available') {
        toast.info(t('update.availableToast').replace('{version}', res.release.version), {
          description: t('update.availableToastHint'),
        });
      } else if (res.kind === 'latest') {
        toast.success(t('update.latestToast').replace('{version}', pkg.version));
      } else {
        // Both the API and the atom fallback failed (offline, firewall). This
        // is normal and must not look like the app is broken: quiet note, no
        // red error.
        toast.info(t('update.unavailable'), {
          description: t('update.unavailableHint'),
        });
      }
    }
    setUpdateChecking(false);
    return res;
  };

  // Startup check, throttled to once a day so the GitHub API is not hammered.
  // The throttle stamp is only saved AFTER a check that actually completed:
  // a failed check (rate limit, offline) returns { kind: 'error' } rather
  // than throwing, so an unconditional .then() used to stamp the timer on
  // failures too and suppressed every automatic check for the next 24h.
  useEffect(() => {
    try {
      const last = Number(localStorage.getItem('fress.last_update_check') || '0');
      if (Date.now() - last < 24 * 60 * 60 * 1000) return;
    } catch {
      return;
    }
    void runUpdateCheck(false).then((res) => {
      if (!res || res.kind === 'error') return; // let the next launch retry
      try {
        localStorage.setItem('fress.last_update_check', String(Date.now()));
      } catch {
        // ignore
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleHeaderUpdateClick = () => {
    if (!ownUpdate) return;
    if (deliveryState.phase === 'verified') {
      // Reveal - never auto-launch. Verification established trust in the
      // bytes; the user decides when (and whether) to run the installer.
      void revealItemInDir(deliveryState.path);
      return;
    }
    if (isDelivering()) {
      toast.info(t('update.alreadyInProgress'), {
        description: t('update.alreadyInProgressHint'),
      });
      return;
    }
    // One delivery entry point for the pill: runs the shared three-gate
    // plan (asset + checksum + signature sidecar), fetches the signature
    // document for real, and hands the asset to the download manager. A
    // failed attempt is retried here too - the retry re-runs every gate
    // with FRESH fetches, never a cached answer.
    void startOwnUpdateDelivery(
      {
        release: ownUpdate.release,
        asset: ownUpdate.asset,
        expectedSha256: ownUpdate.expectedSha256,
      },
      { startDownload, openExternal, revealItemInDir }
    );
  };

  return {
    ownUpdate,
    updateChecking,
    updateChannel,
    handleUpdateChannelChange,
    runUpdateCheck,
    handleHeaderUpdateClick,
    updatePillStatus: pillStatusFor(
      deliveryState,
      ownUpdate ? ownUpdate.release.version : '',
      t
    ),
  };
}
