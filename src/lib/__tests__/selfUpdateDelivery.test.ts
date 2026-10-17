// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
/**
 * Integration tests for the self-update DELIVERY lifecycle
 * (src/features/selfUpdate/updateDelivery.ts) - the piece that connects
 * release selection to the native signature verifier in the REAL flow.
 *
 * Mocked seams (and ONLY these):
 *   - @tauri-apps/api/core invoke  (start_download results, the native text
 *     fetch for the sidecar, and verify_self_update_signature itself)
 *   - @tauri-apps/api/event listen (terminal download events are dispatched
 *     by the tests, deterministically)
 *   - sonner toasts                (asserted, never silent)
 *   - the downloads module's isTauri (true - the delivery is a native path)
 *
 * Everything between the seams is the production code under test: the
 * three-gate plan, the real sidecar fetch, the update-plan registry, the
 * id->url correlation against the download manager's items, the
 * post-download verifier invocation and every honest fallback.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import {
  getDeliveryState,
  isDelivering,
  resetDeliveryForTest,
  startOwnUpdateDelivery,
  syncDeliveryItems,
  subscribeDelivery,
} from '../../features/selfUpdate/updateDelivery';
import type { DeliveryDeps } from '../../features/selfUpdate/updateDelivery';
import type { OwnRelease } from '../selfUpdate';

/* ------------------------------------------------------------------ */
/* Mocks                                                               */
/* ------------------------------------------------------------------ */

const invokeMock = vi.hoisted(() => vi.fn());
const listenMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: (_event: string, handler: (e: unknown) => void) => {
    listenMock(_event, handler);
    return Promise.resolve(() => undefined);
  },
}));

const toastInfo = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({
  toast: { info: toastInfo, success: toastSuccess, error: toastError },
}));

vi.mock('../downloads', () => ({
  isTauri: () => true,
}));

/** The captured Tauri event handlers, by event name. */
let eventHandlers: Map<string, Array<(e: { payload: unknown }) => void>>;

function emit(event: string, payload: unknown): void {
  for (const handler of eventHandlers.get(event) ?? []) handler({ payload });
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const ASSET = 'Fress_1.0.9_x64-setup.exe';
const GOOD_SHA = 'e7de715cd4a309dc8c6fe72c93ad8f2b9e3d3c1b4a1d5f2c8e6b0a9d7c3f5e1b';

/** A well-formed Tauri/minisign signature document (74-byte "ED" prehashed
 * cryptobuf + 64-byte global signature), outer-base64 encoded - the exact
 * shape a release .sig sidecar has and the native verifier accepts. */
function makeSidecarDocument(): string {
  const doc = [
    'untrusted comment: signature from tauri secret key',
    Buffer.concat([Buffer.from('ED'), Buffer.alloc(72, 7)]).toString('base64'),
    'trusted comment: timestamp:1791744131\tfile:' + ASSET,
    Buffer.alloc(64, 9).toString('base64'),
  ].join('\n');
  return Buffer.from(doc, 'utf8').toString('base64');
}

function makeRelease(opts?: { withSidecar?: boolean; extraSidecarNames?: string[]; dmg?: boolean }): OwnRelease {
  const assetName = opts?.dmg ? 'Fress_1.0.9_aarch64.dmg' : ASSET;
  const assets: OwnRelease['assets'] = [
    { name: assetName, size: 21_000_000, url: `https://github.com/WasewaseX/Fress/releases/download/v1.0.9-beta/${assetName}` },
    { name: 'SHA256SUMS.txt', size: 300, url: `https://github.com/WasewaseX/Fress/releases/download/v1.0.9-beta/SHA256SUMS.txt` },
  ];
  if (opts?.withSidecar !== false) {
    assets.push({
      name: `${assetName}.sig`,
      size: 420,
      url: `https://github.com/WasewaseX/Fress/releases/download/v1.0.9-beta/${assetName}.sig`,
    });
  }
  for (const extra of opts?.extraSidecarNames ?? []) {
    assets.push({ name: extra, size: 420, url: `https://github.com/WasewaseX/Fress/releases/download/v1.0.9-beta/${extra}` });
  }
  return {
    tag: 'v1.0.9-beta',
    version: '1.0.9-beta',
    publishedAt: '2026-10-12T00:00:00Z',
    htmlUrl: 'https://github.com/WasewaseX/Fress/releases/tag/v1.0.9-beta',
    assets,
  };
}

const ASSET_URL = makeRelease().assets[0].url;

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

interface Harness {
  deps: DeliveryDeps & {
    startDownload: ReturnType<typeof vi.fn>;
    openExternal: ReturnType<typeof vi.fn>;
    revealItemInDir: ReturnType<typeof vi.fn>;
  };
  start: (release?: OwnRelease) => Promise<void>;
  /** Registers the manager's item list the way useSelfUpdate does. */
  registerItem: (id: number, url: string, status?: string, path?: string, verified?: boolean) => void;
  /** Configures the native side: what the sidecar fetch returns and how
   * verify_self_update_signature resolves. */
  native: (opts: {
    sidecarBody?: string | null; // null = fetch fails (unreachable)
    verifyResult?: 'ok' | 'reject';
  }) => void;
  verifyCalls: () => Array<{ cmd: string; args: Record<string, unknown> }>;
}

function makeHarness(): Harness {
  const startDownload = vi.fn(async () => undefined);
  const openExternal = vi.fn(async () => undefined);
  const revealItemInDir = vi.fn(async () => undefined);
  const deps = { startDownload, openExternal, revealItemInDir };
  const release = makeRelease();
  let sidecarBody: string | null = makeSidecarDocument();
  let verifyResult: 'ok' | 'reject' = 'ok';
  let itemsSnapshot: Array<{ id: number; url: string; status: string; path?: string; verified?: boolean }> = [];

  invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'fetch_self_update_text') {
      const url = String(args?.url ?? '');
      if (!url.endsWith('.sig')) {
        return { status: 404, body: '', truncated: false };
      }
      if (sidecarBody === null) throw 'network unreachable';
      return { status: 200, body: sidecarBody, truncated: false };
    }
    if (cmd === 'verify_self_update_signature') {
      if (verifyResult === 'ok') return null;
      throw 'Updater signature verification failed: the downloaded file does not match the release signature';
    }
    return null;
  });

  return {
    deps: deps as Harness['deps'],
    async start(rel?: OwnRelease) {
      await startOwnUpdateDelivery(
        {
          release: rel ?? release,
          asset: (rel ?? release).assets[0],
          expectedSha256: GOOD_SHA,
        },
        deps
      );
    },
    registerItem(id: number, url: string, status = 'active', path?: string, verified?: boolean) {
      // useSelfUpdate always syncs the FULL manager list, so ids accumulate
      // here the same way the real panel's item list does.
      itemsSnapshot = [
        ...itemsSnapshot.filter((it) => it.id !== id),
        { id, url, status, path, verified },
      ];
      syncDeliveryItems(itemsSnapshot);
    },
    native(opts) {
      if ('sidecarBody' in opts) sidecarBody = opts.sidecarBody ?? null;
      if (opts.verifyResult) verifyResult = opts.verifyResult;
    },
    verifyCalls() {
      return invokeMock.mock.calls
        .filter(([cmd]) => cmd === 'verify_self_update_signature')
        .map(([cmd, args]) => ({ cmd, args }));
    },
  };
}

beforeEach(async () => {
  resetDeliveryForTest();
  invokeMock.mockClear();
  listenMock.mockClear();
  toastInfo.mockClear();
  toastSuccess.mockClear();
  toastError.mockClear();
  eventHandlers = new Map();
  listenMock.mockImplementation((event: string, handler: (e: { payload: unknown }) => void) => {
    const list = eventHandlers.get(event) ?? [];
    list.push(handler);
    eventHandlers.set(event, list);
    return Promise.resolve(() => undefined);
  });
});

afterEach(() => {
  resetDeliveryForTest();
});

/** Lets the (void) listener registration settle so events can be emitted. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/* ------------------------------------------------------------------ */
/* The complete delivery path                                          */
/* ------------------------------------------------------------------ */

describe('the complete in-app delivery path (Task 6 contract)', () => {
  it('a valid matching artifact and signature end verified, with the verifier invoked on the exact completed bytes', async () => {
    const h = makeHarness();
    await h.start();
    // Signature fetched for real, then the download handed to the manager
    // WITH the published digest (the checksum gate travels with it).
    expect(getDeliveryState().phase).toBe('downloading');
    expect(h.deps.startDownload).toHaveBeenCalledWith(ASSET_URL, ASSET, { expectedSha256: GOOD_SHA });
    expect(h.deps.openExternal).not.toHaveBeenCalled();

    h.registerItem(7, ASSET_URL);
    await flush();
    emit('download-complete', { id: 7, path: '/downloads/Fress_1.0.9_x64-setup.exe', bytes: 21_000_000, sha256: GOOD_SHA, verified: true });
    // The verifier runs against the ENGINE-reported path with the plan's
    // signature document - not a UI label, not another file.
    const calls = h.verifyCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual({
      filePath: '/downloads/Fress_1.0.9_x64-setup.exe',
      signatureBase64: makeSidecarDocument(),
    });
    await flush();
    expect(getDeliveryState()).toMatchObject({
      phase: 'verified',
      name: ASSET,
      path: '/downloads/Fress_1.0.9_x64-setup.exe',
    });
    expect(toastSuccess).toHaveBeenCalled();
    // No fallback, and nothing auto-launched: verification trusts the
    // bytes, it does not execute them.
    expect(h.deps.openExternal).not.toHaveBeenCalled();
    expect(h.deps.revealItemInDir).not.toHaveBeenCalled();
  });

  it('a tampered artifact with otherwise valid metadata is NEVER verified (releases-page fallback)', async () => {
    const h = makeHarness();
    h.native({ verifyResult: 'reject' });
    await h.start();
    h.registerItem(7, ASSET_URL);
    await flush();
    emit('download-complete', { id: 7, path: '/downloads/tampered.exe', bytes: 21_000_000, sha256: GOOD_SHA, verified: true });
    await flush();
    expect(getDeliveryState()).toMatchObject({
      phase: 'failed',
      reason: 'signature',
      fallback: true,
    });
    expect(toastError).toHaveBeenCalled();
    expect(h.deps.openExternal).toHaveBeenCalledWith('https://github.com/WasewaseX/Fress/releases/tag/v1.0.9-beta');
    // The failure is visible in the download registry's own terms too: the
    // delivery left the "downloading" phase, so no pending claim remains.
    expect(isDelivering()).toBe(false);
  });

  it('a signature from a FOREIGN key fails the same honest way (never verified)', async () => {
    // The Rust suite proves the cryptography; this pins the FLOW contract:
    // any verifier rejection (wrong key included) is a signature failure.
    const h = makeHarness();
    h.native({ verifyResult: 'reject' });
    await h.start();
    h.registerItem(7, ASSET_URL);
    await flush();
    emit('download-complete', { id: 7, path: '/downloads/foreign.exe', bytes: 21_000_000, sha256: GOOD_SHA, verified: true });
    await flush();
    expect(getDeliveryState().phase).toBe('failed');
    expect(h.verifyCalls()).toHaveLength(1);
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('a missing signature document never downloads (unsigned -> releases page)', async () => {
    const h = makeHarness();
    const release = makeRelease({ withSidecar: false });
    await h.start(release);
    expect(getDeliveryState()).toMatchObject({ phase: 'fallback', reason: 'unsigned' });
    expect(h.deps.startDownload).not.toHaveBeenCalled();
    expect(h.deps.openExternal).toHaveBeenCalledWith(release.htmlUrl);
    expect(invokeMock).not.toHaveBeenCalledWith('verify_self_update_signature', expect.anything());
  });

  it('an unsigned platform asset (macOS dmg without a sidecar) falls back honestly', async () => {
    const h = makeHarness();
    const release = makeRelease({ withSidecar: false, dmg: true });
    await h.start(release);
    expect(getDeliveryState()).toMatchObject({ phase: 'fallback', reason: 'unsigned' });
    expect(h.deps.startDownload).not.toHaveBeenCalled();
    expect(h.deps.openExternal).toHaveBeenCalledWith(release.htmlUrl);
  });

  it('a signature document for another filename/version is not the one (no sidecar binding escape)', async () => {
    const h = makeHarness();
    const release = makeRelease({
      withSidecar: false,
      extraSidecarNames: ['Fress_1.0.10_x64-setup.exe.sig', 'Fress_1.0.9_arm64-setup.exe.sig'],
    });
    await h.start(release);
    expect(getDeliveryState()).toMatchObject({ phase: 'fallback', reason: 'unsigned' });
    expect(h.deps.startDownload).not.toHaveBeenCalled();
  });

  it('a malformed signature document fails closed at the plan gate', async () => {
    const h = makeHarness();
    h.native({ sidecarBody: Buffer.from('<html>proxy error page</html>', 'utf8').toString('base64') });
    await h.start();
    expect(getDeliveryState()).toMatchObject({
      phase: 'failed',
      reason: 'signature',
      fallback: true,
    });
    expect(h.deps.startDownload).not.toHaveBeenCalled();
    expect(h.deps.openExternal).toHaveBeenCalled();
  });

  it('a download failure before verification is a download failure (no verify, no fallback)', async () => {
    const h = makeHarness();
    await h.start();
    h.registerItem(7, ASSET_URL);
    await flush();
    emit('download-error', { id: 7, message: 'connection reset' });
    await flush();
    expect(getDeliveryState()).toMatchObject({ phase: 'failed', reason: 'download', fallback: false });
    expect(h.verifyCalls()).toHaveLength(0);
    expect(h.deps.openExternal).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalled();
  });

  it('a user cancellation before verification is NOT a failure: back to available, quietly', async () => {
    const h = makeHarness();
    await h.start();
    h.registerItem(7, ASSET_URL);
    await flush();
    emit('download-error', { id: 7, message: 'Cancelled' });
    await flush();
    expect(getDeliveryState()).toEqual({ phase: 'idle' });
    expect(h.verifyCalls()).toHaveLength(0);
    expect(toastError).not.toHaveBeenCalled();
    expect(h.deps.openExternal).not.toHaveBeenCalled();
  });

  it('retrying a failed signature fetch performs a REAL fresh fetch, not a cached answer', async () => {
    const h = makeHarness();
    h.native({ sidecarBody: null }); // the sidecar document is unreachable
    await h.start();
    expect(getDeliveryState()).toMatchObject({
      phase: 'failed',
      reason: 'signature-fetch',
      fallback: false,
    });
    expect(h.deps.startDownload).not.toHaveBeenCalled();
    expect(h.deps.openExternal).not.toHaveBeenCalled();

    // The release "recovers" (CI re-uploads the sidecar). A retry must
    // actually re-read it: invoke for the sidecar runs a second time and
    // the delivery proceeds past the gate it failed before.
    h.native({ sidecarBody: makeSidecarDocument() });
    const fetchCallsBefore = invokeMock.mock.calls.filter(([cmd]) => cmd === 'fetch_self_update_text').length;
    await h.start();
    const fetchCallsAfter = invokeMock.mock.calls.filter(([cmd]) => cmd === 'fetch_self_update_text').length;
    expect(fetchCallsAfter).toBe(fetchCallsBefore + 1);
    expect(getDeliveryState().phase).toBe('downloading');
    expect(h.deps.startDownload).toHaveBeenCalledWith(ASSET_URL, ASSET, { expectedSha256: GOOD_SHA });
  });

  it('a verified checksum with an INVALID signature is a signature failure, not a verified update', async () => {
    const h = makeHarness();
    h.native({ verifyResult: 'reject' });
    await h.start();
    h.registerItem(7, ASSET_URL);
    await flush();
    // The native engine CONFIRMED the checksum (verified: true) - and the
    // signature still fails. The two guarantees must stay distinct.
    emit('download-complete', { id: 7, path: '/downloads/badsig.exe', bytes: 21_000_000, sha256: GOOD_SHA, verified: true });
    await flush();
    expect(getDeliveryState()).toMatchObject({ phase: 'failed', reason: 'signature', fallback: true });
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('a completion without a confirmed checksum fails closed (verifying-checksum gate)', async () => {
    const h = makeHarness();
    await h.start();
    h.registerItem(7, ASSET_URL);
    await flush();
    // No `verified` flag: the file was never checked against the published
    // digest. It must not even reach the signature verifier. Transfer-level
    // integrity failures stay retryable in the manager - no auto-redirect.
    emit('download-complete', { id: 7, path: '/downloads/unverified.exe', bytes: 21_000_000, sha256: GOOD_SHA });
    await flush();
    expect(getDeliveryState()).toMatchObject({ phase: 'failed', reason: 'checksum', fallback: false });
    expect(h.verifyCalls()).toHaveLength(0);
    expect(h.deps.openExternal).not.toHaveBeenCalled();
  });

  it('an engine-reported checksum mismatch stays a retryable manager failure (no redirect)', async () => {
    const h = makeHarness();
    await h.start();
    h.registerItem(7, ASSET_URL);
    await flush();
    // The engine compared the transferred bytes against the published digest
    // and refused. The corrupted TRANSFER is retryable: the failure stays in
    // the download manager (its row offers a fresh Retry) and the delivery
    // reports a non-fallback checksum failure - nothing is opened and no
    // completed row can exist.
    emit('download-error', { id: 7, message: 'SHA-256 mismatch', kind: 'checksum' });
    await flush();
    expect(getDeliveryState()).toMatchObject({ phase: 'failed', reason: 'checksum', fallback: false });
    expect(h.verifyCalls()).toHaveLength(0);
    expect(h.deps.openExternal).not.toHaveBeenCalled();
  });
});

describe('correlation and consistency (Task 6: pill/registry stay consistent)', () => {
  it('a catalog download completing at the same moment never triggers (or blocks) update verification', async () => {
    const h = makeHarness();
    await h.start();
    h.registerItem(7, ASSET_URL);
    h.registerItem(8, 'https://example.org/some-catalog-app.zip'); // unrelated transfer
    await flush();
    emit('download-complete', { id: 8, path: '/downloads/other.zip', bytes: 5, sha256: 'f'.repeat(64), verified: true });
    await flush();
    // The unrelated completion is ignored: the update is still downloading.
    expect(getDeliveryState().phase).toBe('downloading');
    expect(h.verifyCalls()).toHaveLength(0);

    // The REAL completion still verifies afterwards.
    emit('download-complete', { id: 7, path: '/downloads/real.exe', bytes: 21_000_000, sha256: GOOD_SHA, verified: true });
    await flush();
    expect(getDeliveryState().phase).toBe('verified');
  });

  it('a completion that raced ahead of the event listeners is reconciled from the manager item list', async () => {
    const h = makeHarness();
    await h.start();
    // The item list ALREADY shows the completed transfer (the manager
    // recorded it before this module's listeners were registered), with the
    // checksum confirmed - exactly what a checksum-verified completion row
    // carries.
    h.registerItem(7, ASSET_URL, 'completed', '/downloads/raced.exe', true);
    await flush();
    // Reconciliation ran the verifier with the manager's own path record.
    const calls = h.verifyCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].args.filePath).toBe('/downloads/raced.exe');
    await flush();
    expect(getDeliveryState()).toMatchObject({ phase: 'verified', path: '/downloads/raced.exe' });
  });

  it('a cancellation that raced ahead of the listeners reconciles to a quiet idle (no false failure)', async () => {
    const h = makeHarness();
    await h.start();
    // The manager's item list already shows the transfer as cancelled: the
    // user stopped it before the delivery's listeners were registered, so
    // the 'Cancelled' error event can never arrive. The item list is the
    // authoritative record, and a cancelled update is a QUIET return to
    // idle - never a failure state, never a fallback redirect.
    h.registerItem(7, ASSET_URL, 'cancelled');
    await flush();
    expect(getDeliveryState()).toMatchObject({ phase: 'idle' });
    expect(h.deps.openExternal).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    // The plan is gone: a late completion for the cancelled transfer can
    // never reach the verifier or resurrect the delivery.
    emit('download-complete', { id: 7, path: '/downloads/late.exe', bytes: 21_000_000, sha256: GOOD_SHA, verified: true });
    await flush();
    expect(getDeliveryState().phase).toBe('idle');
    expect(h.verifyCalls()).toHaveLength(0);
  });

  it('state transitions are observable by subscribers (the pill) in order', async () => {
    const h = makeHarness();
    const phases: string[] = [];
    const unsubscribe = subscribeDelivery((s) => phases.push(s.phase));
    await h.start();
    h.registerItem(7, ASSET_URL);
    await flush();
    emit('download-complete', { id: 7, path: '/downloads/ordered.exe', bytes: 21_000_000, sha256: GOOD_SHA, verified: true });
    await flush();
    unsubscribe();
    // fetching-signature -> downloading -> verifying-checksum -> verifying-signature -> verified
    expect(phases).toEqual([
      'fetching-signature',
      'downloading',
      'verifying-checksum',
      'verifying-signature',
      'verified',
    ]);
  });

  it('a second click while delivering is ignored with an explanation (no double delivery)', async () => {
    const h = makeHarness();
    await h.start();
    expect(isDelivering()).toBe(true);
    await h.start(); // second attempt while downloading
    expect(h.deps.startDownload).toHaveBeenCalledTimes(1);
    expect(toastInfo).toHaveBeenCalled();
  });

  it('the delivery gate requires asset + checksum + signature TOGETHER (no-asset release)', async () => {
    const h = makeHarness();
    const release = makeRelease({ withSidecar: false });
    await startOwnUpdateDelivery(
      {
        release,
        asset: null, // nothing on this release can run on this machine
        expectedSha256: GOOD_SHA,
      },
      h.deps
    );
    expect(getDeliveryState()).toMatchObject({ phase: 'fallback', reason: 'no-asset' });
    expect(h.deps.startDownload).not.toHaveBeenCalled();
  });
});
