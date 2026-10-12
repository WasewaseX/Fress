// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
/**
 * The header update pill's TRUTHFULNESS contract, pinned state by state.
 *
 * pillStatusFor() is the single mapping from the delivery lifecycle onto
 * the pill's label override - the pill is the one surface the user reads
 * while an update is in flight, so every phase must render an HONEST
 * label:
 *   - busy phases say what is happening (downloading / checking / verifying);
 *   - the verified phase is the ONLY one allowed to say "ready";
 *   - a post-download failure says retry or see-releases;
 *   - and a PLAN-LEVEL refusal ('no-asset' | 'unverifiable' | 'unsigned')
 *     must say "see releases" - never the plain available label, which
 *     implies in-app delivery is still on the table after the planner
 *     just proved it is not (the why travels with the refusal toast).
 *
 * The translator is the REAL English dictionary, so a renamed or removed
 * i18n key fails here instead of rendering a raw key to users.
 */
import { describe, expect, it } from 'vitest';

import { DICTS } from '../../../lib/i18n';
import type { UpdateDeliveryState } from '../updateDelivery';
import { pillStatusFor } from '../useSelfUpdate';

const t = (key: string) => DICTS.en[key] ?? key;
const VERSION = '1.0.9-beta';

function labelFor(state: UpdateDeliveryState): { label: string; busy: boolean } | null {
  return pillStatusFor(state, VERSION, t);
}

describe('pill truthfulness: busy and terminal phases', () => {
  it('idle renders no override (the pill keeps its plain available label)', () => {
    expect(labelFor({ phase: 'idle' })).toBeNull();
  });

  it('fetching-signature and downloading are busy transfer labels naming the version', () => {
    for (const phase of ['fetching-signature', 'downloading'] as const) {
      const status = labelFor({ phase, name: 'Fress_1.0.9_amd64.AppImage' } as UpdateDeliveryState);
      expect(status).toEqual({ label: DICTS.en['header.updatePillDownloading'].replace('{v}', VERSION), busy: true });
    }
  });

  it('verifying-checksum and verifying-signature are busy and distinct', () => {
    const checksum = labelFor({ phase: 'verifying-checksum', name: 'a' } as UpdateDeliveryState);
    expect(checksum).toEqual({ label: DICTS.en['header.updatePillVerifyingChecksum'].replace('{v}', VERSION), busy: true });
    const signature = labelFor({ phase: 'verifying-signature', name: 'a' } as UpdateDeliveryState);
    expect(signature).toEqual({ label: DICTS.en['header.updatePillVerifyingSignature'].replace('{v}', VERSION), busy: true });
    expect(checksum!.label).not.toBe(signature!.label);
  });

  it('verified is the only phase allowed to claim ready, and it is not busy', () => {
    const status = labelFor({ phase: 'verified', name: 'a', path: '/downloads/a' } as UpdateDeliveryState);
    expect(status).toEqual({ label: DICTS.en['header.updatePillReady'].replace('{v}', VERSION), busy: false });
  });

  it('a post-download failure says retry when retryable and see-releases when fallback', () => {
    const retryable = labelFor({ phase: 'failed', name: 'a', reason: 'download', fallback: false });
    expect(retryable).toEqual({ label: DICTS.en['header.updatePillRetry'], busy: false });
    const fallback = labelFor({ phase: 'failed', name: 'a', reason: 'signature', fallback: true });
    expect(fallback).toEqual({ label: DICTS.en['header.updatePillSeeReleases'], busy: false });
  });
});

describe('pill truthfulness: plan-level refusals must not look deliverable', () => {
  // The planner refused BEFORE any download: 'no-asset' (nothing runnable),
  // 'unverifiable' (no published digest) and 'unsigned' (no sidecar). All
  // three render the see-releases label, never busy, never the plain
  // available label, and never any verified/progress phrasing.
  it.each(['no-asset', 'unverifiable', 'unsigned'] as const)(
    'fallback reason %s renders the see-releases label (busy=false)',
    (reason) => {
      const status = labelFor({ phase: 'fallback', name: 'Fress_1.0.9_amd64.AppImage', reason });
      expect(status).toEqual({ label: DICTS.en['header.updatePillSeeReleases'], busy: false });
      expect(status!.label).not.toBe(DICTS.en['header.updatePill'].replace('{v}', VERSION));
      expect(status!.label).not.toContain(DICTS.en['header.updatePillDownloading']);
      expect(status!.label).not.toBe(DICTS.en['header.updatePillReady'].replace('{v}', VERSION));
    }
  );

  it('the see-releases label is distinct from the plain available label', () => {
    // The regression this pins: the fallback phase used to fall through to
    // null, silently reverting the pill to header.updatePill ("Update
    // v...") - a deliverable-looking label on a refused update.
    expect(DICTS.en['header.updatePillSeeReleases']).not.toBe(
      DICTS.en['header.updatePill'].replace('{v}', VERSION)
    );
  });
});
