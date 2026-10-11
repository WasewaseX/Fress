// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { useI18n } from '../../lib/i18n';
import { openExternal } from '../../lib/external';
import {
  checkForUpdate,
  getUpdateChannel,
  setUpdateChannel,
  planUpdateDelivery,
  OwnRelease,
  UpdateChannel,
  UpdateState,
} from '../../lib/selfUpdate';
import pkg from '../../../package.json';

/**
 * In-app self-update state: compares this install against the newest
 * GitHub release. Checked automatically at most once every 24 hours, plus
 * on demand from the menu. When an update exists, the header shows a pill;
 * tapping it downloads the platform file (an APK update on Android keeps
 * all apps and data, no reinstall needed).
 *
 * The hook receives `startDownload` from the downloads context so the
 * update asset goes through the same verified download pipeline as every
 * other file.
 */

export interface SelfUpdateUi {
  ownUpdate: { release: OwnRelease; asset: { name: string; size: number; url: string } | null; expectedSha256: string | null } | null;
  updateChecking: boolean;
  updateChannel: UpdateChannel;
  handleUpdateChannelChange: (channel: UpdateChannel) => void;
  runUpdateCheck: (announce: boolean) => Promise<UpdateState | null>;
  handleHeaderUpdateClick: () => void;
}

export function useSelfUpdate(
  startDownload: (url: string, nameHint?: string, opts?: { expectedSha256?: string }) => void
): SelfUpdateUi {
  const { t } = useI18n();

  const [ownUpdate, setOwnUpdate] = useState<{ release: OwnRelease; asset: { name: string; size: number; url: string } | null; expectedSha256: string | null } | null>(null);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateChannel, setUpdateChannelState] = useState<UpdateChannel>(() => getUpdateChannel());

  const handleUpdateChannelChange = (channel: UpdateChannel) => {
    setUpdateChannelState(channel);
    setUpdateChannel(channel);
    toast.info(`Update channel: ${channel}`, {
      description: 'Re-check for updates to apply the new channel.',
    });
  };

  const runUpdateCheck = async (announce: boolean): Promise<UpdateState | null> => {
    if (updateChecking) return null;
    setUpdateChecking(true);
    const res = await checkForUpdate(pkg.version);
    setOwnUpdate(res.kind === 'available' ? { release: res.release, asset: res.asset, expectedSha256: res.expectedSha256 } : null);
    if (announce) {
      if (res.kind === 'available') {
        toast.info(`Fress v${res.release.version} is available.`, {
          description: 'Use the Update button in the header. Your apps and data are kept.',
        });
      } else if (res.kind === 'latest') {
        toast.success(`You are on the latest version (v${pkg.version}).`);
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
    // ONE decision for both update buttons (this hook and the footer's
    // UpdateButton): download only when the asset's published SHA-256 is
    // in hand, otherwise open the releases page instead of shipping an
    // unverified installer. A missing checksum never becomes a successful
    // update - the file the user already has keeps working until they
    // choose to verify and install manually from the releases page.
    const plan = planUpdateDelivery(ownUpdate.release, ownUpdate.asset, ownUpdate.expectedSha256);
    if (plan.kind === 'download') {
      void startDownload(plan.asset.url, plan.asset.name, { expectedSha256: plan.sha256 });
      toast.success('Update downloading…', {
        description: 'When it finishes, open the file to update Fress. Your apps and data stay.',
      });
    } else {
      toast.info('Opening the releases page instead', {
        description:
          plan.reason === 'unverifiable'
            ? 'This update could not be verified against the published SHA256SUMS.txt, so it will not be downloaded automatically. Verify manually, then install.'
            : 'No file for this platform could be picked automatically. Download it from the releases page.',
      });
      void openExternal(plan.release.htmlUrl);
    }
  };

  return {
    ownUpdate,
    updateChecking,
    updateChannel,
    handleUpdateChannelChange,
    runUpdateCheck,
    handleHeaderUpdateClick,
  };
}
