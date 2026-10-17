// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { revealItemInDir } from '@tauri-apps/plugin-opener';

import { useI18n, formatMessage } from '../../lib/i18n';
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
  // formatMessage (split/join): literal insertion, every occurrence - the
  // version is SemVer-gated today, but the pill mapping must stay safe by
  // construction, not by an upstream validation it does not control.
  const v = (key: string) => formatMessage(t(key), { v: version });
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

  // In-flight-check bookkeeping. `checkEpochRef` counts every check start;
  // a channel switch bumps it WITHOUT starting a check, which marks any
  // check already in flight as stale. `recheckAfterStaleRef` remembers
  // that a channel switch wants a fresh (quiet) check even though one was
  // still running at the moment it happened. `checkingRef` is the in-flight
  // guard itself - a ref, not the state: state updates are asynchronous, so
  // two calls in one tick (or the stale-recheck path re-entering before the
  // re-render) could both read a stale `updateChecking` and run concurrent
  // checks; a ref makes the guard exact.
  const checkEpochRef = useRef(0);
  const recheckAfterStaleRef = useRef(false);
  const checkingRef = useRef(false);
  // The version the CURRENT delivery-lifecycle state describes. Pinned when
  // a delivery is started from the pill; a detection that arrives while a
  // delivery is underway (or after one finished) must NOT re-seed it, or a
  // newer release would relabel the old transfer - "Downloading v1.0.14"
  // while 1.0.13-beta transfers, or a "Ready v1.0.14" for bytes that were
  // never verified. A channel switch also clears ownUpdate - the DETECTED
  // update of the old channel is stale - while the delivery in flight for
  // that release is not: its pill label keeps naming the version actually
  // being downloaded and verified instead of interpolating an empty {v}.
  const deliveredVersionRef = useRef('');
  // Set for the lifetime of the mounted hook. A check that lands after
  // unmount applies no state and fires no announcement: the component is
  // gone, and a late "update available" toast from a dead instance is
  // stale news by definition (React would silently no-op the setState -
  // the side effects are the part that needs the guard).
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Delivery lifecycle: subscribe for the pill, translate module toasts,
  // and mirror the download manager's items so terminal download events
  // can be bound to this update through the manager's own records.
  const deliveryState = useSyncExternalStore(subscribeDelivery, getDeliveryState);
  const { items } = useDownloadItems();

  useEffect(() => {
    setDeliveryTranslator(t);
  }, [t]);

  // Seed (never re-seed over a delivery) the delivered-version pin: while
  // the delivery lifecycle is idle, a detection describes the update the
  // pill would deliver; once a delivery exists, its version stays pinned
  // until a NEW delivery replaces it (pinned again at its own start).
  useEffect(() => {
    if (ownUpdate && deliveryState.phase === 'idle') {
      deliveredVersionRef.current = ownUpdate.release.version;
    }
  }, [ownUpdate, deliveryState]);

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
    // The preference change is the exact moment every result of the OLD
    // channel becomes stale: an in-flight check was started under the old
    // channel (checkForUpdate pins the channel when the fetch starts), and
    // a still-rendered pill from the old channel would keep offering an
    // update the new channel may not even carry. Invalidate the epoch (the
    // in-flight result will be discarded when it lands), clear the stale
    // pill NOW, and ask for a fresh quiet check under the new channel.
    checkEpochRef.current += 1;
    recheckAfterStaleRef.current = true;
    setOwnUpdate(null);
    void runUpdateCheck(false);
    // The channel NAME is localized (the raw id is an internal value, not
    // user-facing wording - "stable" showed as-is in Persian before).
    // formatMessage (split/join) for the interpolation, same as everywhere.
    const label = t(`header.channel.${channel}`);
    toast.info(formatMessage(t('update.channelSet'), { channel: label }), {
      description: t('update.channelSetHint'),
    });
  };

  const runUpdateCheck = async (announce: boolean): Promise<UpdateState | null> => {
    if (checkingRef.current) return null;
    checkingRef.current = true;
    setUpdateChecking(true);
    const epoch = ++checkEpochRef.current;
    const res = await checkForUpdate(pkg.version);
    checkingRef.current = false;
    setUpdateChecking(false);
    if (epoch !== checkEpochRef.current) {
      // The channel changed while THIS check was in flight: the result
      // describes the OLD channel, so it must never overwrite the state of
      // the newer channel selection (and its announce toast, if one was
      // requested, must not fire either - "update available" for a channel
      // the user just left is exactly the stale-news lie this guard is
      // here to prevent). If the switch asked for a refresh, run it now
      // under the new channel - a mounted hook only; a dead instance
      // fetches nothing.
      if (mountedRef.current && recheckAfterStaleRef.current) {
        recheckAfterStaleRef.current = false;
        return runUpdateCheck(false);
      }
      return res;
    }
    if (!mountedRef.current) {
      // The component went away while the check ran: apply no state and
      // fire no announcement (the branches below). The promise still
      // resolves so the startup throttle can stamp the completed check.
      return res;
    }
    setOwnUpdate(res.kind === 'available' ? { release: res.release, asset: res.asset, expectedSha256: res.expectedSha256 } : null);
    if (announce) {
      if (res.kind === 'available') {
        toast.info(formatMessage(t('update.availableToast'), { version: res.release.version }), {
          description: t('update.availableToastHint'),
        });
      } else if (res.kind === 'latest') {
        toast.success(formatMessage(t('update.latestToast'), { version: pkg.version }));
      } else if (res.kind === 'track-migration') {
        // A beta client that selected Stable while the newest stable release
        // is OLDER than the running build. "Up to date" would be a lie, a
        // downgrade download would be destructive: the toast says plainly
        // that the build is ahead of the channel, that nothing is downgraded,
        // and offers the official releases page (the supported path for
        // moving to the stable track) as a real action button. When the
        // release carries an installer this machine can run, the hint NAMES
        // it - the user should never have to guess which file v1.0.0 means.
        const channelLabel = t(`header.channel.${res.channel}`);
        toast.info(
          formatMessage(t('update.trackMigration'), {
            bv: pkg.version,
            cv: res.channelVersion,
            channel: channelLabel,
          }),
          {
            description: res.asset
              ? formatMessage(t('update.trackMigrationHintAsset'), {
                  channel: channelLabel,
                  asset: res.asset.name,
                  cv: res.channelVersion,
                })
              : formatMessage(t('update.trackMigrationHint'), {
                  channel: channelLabel,
                }),
            action: {
              label: t('update.releasesPageAction'),
              onClick: () => void openExternal(res.release.htmlUrl),
            },
          }
        );
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
    // The delivery-lifecycle state describes ONE pinned version (the one
    // its delivery was started for). Only the VERIFIED reveal is bound to
    // that version: clicking "Update v1.0.14" must never reveal the file a
    // finished 1.0.13-beta delivery verified - the reveal must come from a
    // pill whose update IS the delivered release. Everything else falls
    // through to the guards below / a fresh (or retried) start.
    const deliveryIsForThisUpdate =
      deliveryState.phase !== 'idle' && deliveredVersionRef.current === ownUpdate.release.version;
    if (deliveryIsForThisUpdate && deliveryState.phase === 'verified') {
      // Reveal - never auto-launch. Verification established trust in the
      // bytes; the user decides when (and whether) to run the installer.
      void revealItemInDir(deliveryState.path);
      return;
    }
    if (isDelivering()) {
      // ANY in-flight transfer blocks a new start (the delivery module
      // enforces the same guard). This must run BEFORE the version pin
      // below: a refused start must not re-pin the pill's version to the
      // new release while the old transfer keeps running.
      toast.info(t('update.alreadyInProgress'), {
        description: t('update.alreadyInProgressHint'),
      });
      return;
    }
    // The version this delivery (or its retry) names - pinned BEFORE the
    // async start so every pill label from here on interpolates the real
    // release even if a channel switch clears ownUpdate mid-transfer.
    deliveredVersionRef.current = ownUpdate.release.version;
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

  // The lifecycle override describes the DELIVERY, so it may only label
  // the update it was started for: a delivery pinned to version A must
  // never render its phases ("Downloading"/"Verifying"/"Ready"/"Retry")
  // under a NEWER detection B - that would announce progress for bytes
  // the transfer knows nothing about, or "Ready" for a release that was
  // never verified (a false success pill). With no delivery underway the
  // mapping is null anyway; with one underway and no current detection
  // (channel switched mid-transfer), the pinned version keeps naming
  // itself instead of interpolating an empty {v}.
  const deliveredVersion = deliveredVersionRef.current;
  const overrideActive =
    deliveryState.phase !== 'idle' &&
    deliveredVersion !== '' &&
    (!ownUpdate || ownUpdate.release.version === deliveredVersion);
  return {
    ownUpdate,
    updateChecking,
    updateChannel,
    handleUpdateChannelChange,
    runUpdateCheck,
    handleHeaderUpdateClick,
    updatePillStatus: overrideActive ? pillStatusFor(deliveryState, deliveredVersion, t) : null,
  };
}
