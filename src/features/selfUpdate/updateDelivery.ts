// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
/**
 * The self-update DELIVERY lifecycle: everything that happens between "the
 * user tapped the update button" and "the update artifact is on disk and
 * proven to be ours" (or an honest, explained refusal).
 *
 * THE CONTRACT (why this module exists)
 * -------------------------------------
 * A direct in-app update is presented as verified ONLY after every gate has
 * passed against the artifact that is actually being delivered:
 *
 *   1. Gate plan (planUpdateDelivery, shared by both update buttons):
 *      platform-matched asset + published SHA-256 entry + a well-formed
 *      minisign signature sidecar for THIS exact filename on THIS release.
 *      Any missing gate routes to the official Releases page with a reason
 *      ('no-asset' | 'unverifiable' | 'unsigned') instead of a download.
 *   2. The native download engine streams the file and verifies the SHA-256
 *      expectation itself; a mismatch never surfaces as a completed file.
 *   3. On completion - and BEFORE any "verified" state is shown - the native
 *      `verify_self_update_signature` command checks the completed file's
 *      BYTES against the signature document fetched in step 1.
 *   4. Only all-three-passed renders as "verified and ready". A missing,
 *      unreachable, malformed or mismatching signature renders as an
 *      explained failure with the Releases-page fallback - never as success,
 *      and never as "no update available".
 *
 * BINDING RULES
 * -------------
 * - The verifier is invoked with the `path` from the download-complete event
 *   payload (the engine's own completion record), correlated to this update
 *   through the download manager's item list (id -> url) - never with a path
 *   derived from a UI label or reconstructed by guesswork.
 * - The verifier is VERIFY-ONLY and this module only ever passes paths that
 *   the download engine itself reported for the registered update artifact.
 *   It is not a general filesystem API and is not used as one.
 * - Verification success establishes trust in the bytes. It does NOT launch
 *   the installer: the user stays in control of when (and whether) to run it.
 * - The signature document is fetched through the same native policy path as
 *   the checksum manifest (host allowlist, repo pin, size cap) - a missing
 *   signature can never talk the flow into an unauthorized URL.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { toast } from 'sonner';

import { isTauri } from '../../lib/downloads';
import {
  fetchOwnAssetSignature,
  OwnRelease,
  planUpdateDelivery,
  signatureSidecarFor,
} from '../../lib/selfUpdate';

/* ------------------------------------------------------------------ */
/* i18n                                                                */
/* ------------------------------------------------------------------ */

/** Minimal shape of the i18n translator, injected once by the React layer
 * (useSelfUpdate) so this module never imports the i18n context directly.
 * Defaults to the key itself, which keeps unit tests readable. */
export type DeliveryTranslate = (key: string) => string;
let t: DeliveryTranslate = (key) => key;

export function setDeliveryTranslator(translate: DeliveryTranslate): void {
  t = translate;
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

/** The delivery lifecycle, kept EXPLICITLY distinct so the UI can always
 * answer "what is happening to my update, and why". These states mirror the
 * product contract one-to-one: a missing signature is NOT "no update", and
 * a valid checksum with an invalid signature is NOT a verified update. */
export type UpdateDeliveryState =
  | { phase: 'idle' }
  /** Sidecar document being fetched before the download starts. */
  | { phase: 'fetching-signature'; name: string }
  /** Artifact transferring through the native engine; the engine verifies
   * the SHA-256 expectation as part of this phase. */
  | { phase: 'downloading'; name: string }
  /** Completion record received; the checksum claim is being evaluated. */
  | { phase: 'verifying-checksum'; name: string }
  /** Checksum confirmed; the native minisign verifier is running. */
  | { phase: 'verifying-signature'; name: string }
  /** ALL gates passed. `path` is the engine-reported artifact path. */
  | { phase: 'verified'; name: string; path: string }
  /** Delivery failed. `reason` says what failed; `fallback` is true when
   * the only honest path left is the official Releases page. */
  | {
      phase: 'failed';
      name: string;
      reason: 'signature' | 'checksum' | 'download' | 'signature-fetch';
      fallback: boolean;
    }
  /** Delivery refused at the plan gate; the update EXISTS but cannot be
   * delivered in-app ('no-asset' | 'unverifiable' | 'unsigned'). */
  | { phase: 'fallback'; name: string; reason: 'no-asset' | 'unverifiable' | 'unsigned' };

/** One registered update delivery. The signature document, the expected
 * digest and the exact asset identity are retained TOGETHER (the update
 * plan) so the post-download verification describes the same file the user
 * was promised. */
interface UpdatePlan {
  releaseTag: string;
  releaseHtmlUrl: string;
  assetName: string;
  assetUrl: string;
  sha256: string;
  /** Exact sidecar document content (outer-base64 minisign document). */
  signatureBase64: string;
  /** Where the sidecar came from (audit trail, also a test seam). */
  signatureUrl: string;
}

let state: UpdateDeliveryState = { phase: 'idle' };
let plan: UpdatePlan | null = null;
const listeners = new Set<(s: UpdateDeliveryState) => void>();

function setState(next: UpdateDeliveryState): void {
  state = next;
  listeners.forEach((l) => l(state));
}

export function getDeliveryState(): UpdateDeliveryState {
  return state;
}

export function subscribeDelivery(listener: (s: UpdateDeliveryState) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** True while a delivery is in one of the active phases. */
export function isDelivering(): boolean {
  return (
    state.phase === 'fetching-signature' ||
    state.phase === 'downloading' ||
    state.phase === 'verifying-checksum' ||
    state.phase === 'verifying-signature'
  );
}

/* ------------------------------------------------------------------ */
/* Download-manager correlation (id -> url)                            */
/* ------------------------------------------------------------------ */

/** Mirrors the download manager's item list (id + url + status + final
 * path) so a terminal download event can be matched to THIS update plan
 * through the manager's OWN records - never inferred from a UI label.
 * Synced by the React hook from useDownloadItems(). */
export interface DeliveryItemFacts {
  id: number;
  url: string;
  status: string;
  path?: string;
  /** The manager's own checksum verdict for a completed item. */
  verified?: boolean;
}

let itemFacts: DeliveryItemFacts[] = [];

function urlForDownloadId(id: number): string | null {
  const item = itemFacts.find((it) => it.id === id);
  return item ? item.url : null;
}

/** Called by the React hook whenever the download manager's item list
 * changes. Two jobs: refresh the id->url mapping, and RECONCILE a terminal
 * state that arrived while this module's event listeners were still
 * registering (a download that completed in that window would otherwise
 * leave the delivery stuck in "downloading" forever). The reconciliation
 * reads the manager's item record - the same authoritative path the
 * download-complete event carries - and is idempotent with it. */
export function syncDeliveryItems(items: DeliveryItemFacts[]): void {
  itemFacts = items;
  if (!plan || !isTauri()) return;
  if (state.phase !== 'downloading') return;
  const item = items.find((it) => it.url === plan?.assetUrl);
  if (!item) return;
  if (item.status === 'completed' && item.path) {
    // The item's OWN checksum verdict is passed through - never assumed.
    handleCompleteForPlan({ path: item.path, verified: item.verified === true });
  } else if (item.status === 'cancelled') {
    // The user stopped the transfer while the delivery's own listeners were
    // still registering (or the event was lost to the race window entirely).
    // The manager's item list is authoritative: a cancelled update is a
    // QUIET return to idle - never a failure, never a fallback - exactly
    // like the download-error path treats an explicit Cancelled message.
    handleErrorForPlan({ message: 'Cancelled' });
  } else if (item.status === 'error') {
    // Reconciled errors carry the manager's row but not the engine's error
    // KIND, so this reports the generic retryable transfer failure - the
    // event path stays authoritative for the precise kind (checksum vs
    // network) whenever its event did land. Never a false verified, never
    // a fallback: the row keeps its fresh Retry.
    handleErrorForPlan({ message: 'download failed', kind: 'network' });
  }
}

/* ------------------------------------------------------------------ */
/* Native event listeners                                              */
/* ------------------------------------------------------------------ */

type UnlistenFn = () => void;
let unlisteners: UnlistenFn[] | null = null;

/** Registers the download terminal-event listeners exactly once per
 * session, on the first real delivery. Tauri events broadcast to every
 * listener, so this never disturbs the download manager's own handlers. */
async function ensureListeners(): Promise<void> {
  if (unlisteners || !isTauri()) return;
  const results = await Promise.all([
    listen<{ id: number; path: string; bytes: number; sha256: string; verified?: boolean }>(
      'download-complete',
      (event) => onDownloadComplete(event.payload)
    ),
    listen<{ id: number; message: string; kind?: string }>('download-error', (event) =>
      onDownloadError(event.payload)
    ),
  ]);
  unlisteners = results;
}

function onDownloadComplete(payload: {
  id: number;
  path: string;
  bytes: number;
  sha256: string;
  verified?: boolean;
}): void {
  if (!plan) return;
  // Bind the event to THIS update through the download manager's id->url
  // record: a catalog download completing at the same moment must never
  // trigger (or suppress) update verification.
  if (urlForDownloadId(payload.id) !== plan.assetUrl) return;
  handleCompleteForPlan(payload);
}

function onDownloadError(payload: { id: number; message: string; kind?: string }): void {
  if (!plan) return;
  if (urlForDownloadId(payload.id) !== plan.assetUrl) return;
  handleErrorForPlan(payload);
}

/** Post-download verification for the registered plan.
 * `payload.path` is the ENGINE-reported completion path - the exact bytes
 * that were downloaded, not a name the UI chose. */
function handleCompleteForPlan(payload: { path: string; verified?: boolean }): void {
  const current = plan;
  if (!current) return; // already handled - idempotent by design
  setState({ phase: 'verifying-checksum', name: current.assetName });
  // Checksum gate: the engine compares against the published digest we
  // attached. A completion that arrives WITHOUT a verified flag means the
  // file was never checked against our expectation - fail closed. This is
  // a transfer-level integrity failure: the recovery is a FRESH transfer
  // from the download manager (or the pill's retry), so no releases-page
  // redirect fires here - the failure stays honest and retryable.
  if (payload.verified !== true) {
    failDelivery('checksum', false);
    return;
  }
  setState({ phase: 'verifying-signature', name: current.assetName });
  void invoke('verify_self_update_signature', {
    filePath: payload.path,
    signatureBase64: current.signatureBase64,
  })
    .then(() => {
      // All three gates passed. Trust established for the bytes at
      // `payload.path` - but nothing is executed or opened automatically.
      plan = null;
      setState({ phase: 'verified', name: current.assetName, path: payload.path });
      // split/join interpolation: an asset name can never corrupt the
      // message the way String.prototype.replace("$&") would.
      toast.success(t('update.verifiedReady').split('{name}').join(current.assetName), {
        description: t('update.verifiedReadyHint'),
      });
    })
    .catch(() => {
      // The completed bytes do not match the release signature (or the
      // verification could not run). Never a verified outcome; the artifact
      // must not be presented as installable. The Releases page is the
      // fallback path for getting a genuine build.
      failDelivery('signature', true);
    });
}

function handleErrorForPlan(payload: { message: string; kind?: string }): void {
  if (!plan) return;
  if (payload.message === 'Cancelled') {
    // The user stopped the download on purpose. The update is still
    // detected and still available - back to idle, no failure theatre.
    plan = null;
    setState({ phase: 'idle' });
    return;
  }
  if (payload.kind === 'checksum') {
    // The engine deleted the file: the transferred bytes did not match the
    // published digest. A corrupted TRANSFER is retryable (a fresh request
    // re-downloads and re-checks); a corrupted RELEASE will simply fail the
    // same way, and the checksum-failure hint points at the Releases page
    // for that case. Either way the failure stays in the download manager:
    // the row offers Retry (fresh), the pill offers the same, and nothing
    // is opened automatically.
    failDelivery('checksum', false);
    return;
  }
  // Network/protocol failure before verification ever ran.
  failDelivery('download', false);
}

/** Terminal failure. Owns the plan cleanup: every caller leaves the
 * teardown to this function so the Releases-page fallback still knows
 * WHICH release to point at. */
function failDelivery(
  reason: 'signature' | 'checksum' | 'download' | 'signature-fetch',
  fallback: boolean
): void {
  const current = plan;
  const name = current?.assetName ?? (state.phase === 'idle' ? '' : (state as { name?: string }).name ?? '');
  const htmlUrl = current?.releaseHtmlUrl;
  plan = null;
  setState({ phase: 'failed', name, reason, fallback });
  if (reason === 'signature') {
    toast.error(t('update.signatureFailed'), {
      description: t('update.signatureFailedHint'),
    });
  } else if (reason === 'checksum') {
    toast.error(t('update.checksumFailed'), {
      description: t('update.checksumFailedHint'),
    });
  } else if (reason === 'signature-fetch') {
    toast.error(t('update.signatureFetchFailed'), {
      description: t('update.signatureFetchFailedHint'),
    });
  } else {
    toast.error(t('update.downloadFailed'), {
      description: t('update.downloadFailedHint'),
    });
  }
  if (fallback) {
    const url = htmlUrl ?? 'https://github.com/WasewaseX/Fress/releases';
    void openExternalFn(url);
  }
}

/** Injected opener (module var so event-driven failures can use it too). */
let openExternalFn: (url: string) => unknown = () => undefined;

/* ------------------------------------------------------------------ */
/* Delivery entry points                                               */
/* ------------------------------------------------------------------ */

export interface DeliveryDeps {
  /** The download manager's startDownload - the update goes through the
   * SAME verified pipeline as every other download. */
  startDownload: (
    url: string,
    nameHint?: string,
    opts?: { expectedSha256?: string }
  ) => Promise<void> | void;
  openExternal: (url: string) => unknown;
  revealItemInDir: (path: string) => unknown;
}

/** Starts (or retries) the delivery of a detected update.
 *
 * Runs the shared three-gate plan, then fetches the sidecar document for
 * real (a retry performs a FRESH fetch - never a cached answer), registers
 * the update plan and hands the asset to the download manager. Any gate
 * that fails routes to the official Releases page with the exact reason.
 * A null asset (the release offers nothing this machine can run) routes
 * through the same planner, so every refusal keeps ONE explanation. */
export async function startOwnUpdateDelivery(
  input: {
    release: OwnRelease;
    asset: { name: string; size: number; url: string } | null;
    expectedSha256: string | null;
  },
  deps: DeliveryDeps
): Promise<void> {
  if (isDelivering()) {
    toast.info(t('update.alreadyInProgress'), {
      description: t('update.alreadyInProgressHint'),
    });
    return;
  }
  openExternalFn = (url: string) => deps.openExternal(url);

  // The shared fail-closed decision: asset + checksum + signature sidecar.
  // signatureSidecarFor scans THIS release's own assets, so the plan can
  // only reference a document published next to the artifact.
  const sidecar = input.asset ? signatureSidecarFor(input.release, input.asset.name) : null;
  const delivery = planUpdateDelivery(input.release, input.asset, input.expectedSha256, sidecar);
  if (delivery.kind === 'releases-page') {
    setState({
      phase: 'fallback',
      name: input.asset ? input.asset.name : input.release.tag,
      reason: delivery.reason,
    });
    if (delivery.reason === 'unverifiable') {
      toast.info(t('update.releasesPage'), {
        description: t('update.unverifiableHint'),
      });
    } else if (delivery.reason === 'unsigned') {
      toast.info(t('update.releasesPage'), {
        description: t('update.unsignedHint'),
      });
    } else {
      toast.info(t('update.releasesPage'), {
        description: t('update.noAssetHint'),
      });
    }
    void deps.openExternal(delivery.release.htmlUrl);
    return;
  }

  // Gate 3 fetch: the sidecar document itself. This is a REAL network read
  // through the native policy path - every attempt (including retries)
  // re-fetches, so a document that appears on the release later is picked
  // up on the next try instead of a stale "unreachable".
  // (delivery.kind === 'download' narrows the asset to non-null.)
  const asset = delivery.asset;
  setState({ phase: 'fetching-signature', name: asset.name });
  const sig = await fetchOwnAssetSignature(input.release, asset.name);
  if (sig.status === 'missing' || sig.status === 'malformed') {
    // No sidecar (a race with a re-published release) or a broken document:
    // fail closed to the Releases page. Retrying cannot fix a missing or
    // malformed document, so this is a fallback, not a retryable failure.
    setState({
      phase: 'failed',
      name: asset.name,
      reason: 'signature',
      fallback: true,
    });
    toast.error(t('update.signatureFailed'), {
      description: t('update.signatureFailedHint'),
    });
    void deps.openExternal(input.release.htmlUrl);
    return;
  }
  if (sig.status === 'unreachable') {
    // Transient: a retry performs a real fresh fetch. NOT a fallback - the
    // release may be perfectly fine and the network merely flaky.
    setState({
      phase: 'failed',
      name: asset.name,
      reason: 'signature-fetch',
      fallback: false,
    });
    toast.error(t('update.signatureFetchFailed'), {
      description: t('update.signatureFetchFailedHint'),
    });
    return;
  }

  // Register the plan BEFORE the download starts so the completion event
  // can never arrive before the correlation data exists.
  plan = {
    releaseTag: input.release.tag,
    releaseHtmlUrl: input.release.htmlUrl,
    assetName: asset.name,
    assetUrl: asset.url,
    sha256: delivery.sha256,
    signatureBase64: sig.document,
    signatureUrl: sidecar ? sidecar.url : '',
  };
  setState({ phase: 'downloading', name: asset.name });
  void ensureListeners();
  try {
    await deps.startDownload(asset.url, asset.name, {
      expectedSha256: delivery.sha256,
    });
    toast.info(t('update.downloading'), {
      description: t('update.downloadingHint'),
    });
  } catch {
    // startDownload already showed its own error toast. If the start was
    // refused outright (no transfer, no terminal event will come), fail
    // honestly instead of waiting forever.
    if (plan && state.phase === 'downloading') {
      plan = null;
      setState({ phase: 'failed', name: asset.name, reason: 'download', fallback: false });
      toast.error(t('update.downloadFailed'), {
        description: t('update.downloadFailedHint'),
      });
    }
  }
}

/** Test/debug reset: clears plan, state and listener registrations. */
export function resetDeliveryForTest(): void {
  plan = null;
  itemFacts = [];
  unlisteners?.forEach((un) => un());
  unlisteners = null;
  setState({ phase: 'idle' });
}
