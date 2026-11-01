// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
// @vitest-environment jsdom
//
// Issue #128: the header update pill must never be a DEAD control. A
// delivery can outlive its detection - a channel switch clears ownUpdate
// mid-transfer (deliberately), and any check landing non-`available` keeps
// it cleared - so the hook's click handler must answer honestly even with
// ownUpdate null, doing what the pill's delivered label promises:
//   - "Ready" (verified)          -> reveal the verified artifact;
//   - "Retry" (failed, no fallback) -> a fresh quiet check re-arms the pill
//     under the CURRENT channel (a blind retry would bypass the three-gate
//     plan, so the check IS the honest retry here);
//   - "See releases" (fallback / failed-with-fallback) -> the project's
//     Releases page, the same destination the failure toasts offer;
//   - mid-transfer                -> the same "already in progress" toast
//     the detected path shows.
//
// (With the current App wiring the pill is not even RENDERED without a
// detection - updateVersion gates the button - so these cases are
// defense-in-depth for the render contract; the hook-level pill-status
// contract that renders labels without a detection is pinned in
// stableChannelPolicy.test.tsx.)

import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';

const externalOpen = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/external', () => ({
  openExternal: (...args: unknown[]) => externalOpen(...args),
}));

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => undefined),
}));

import { DownloadsProvider } from '../../../lib/downloads';
import { I18nProvider } from '../../../lib/i18n';
import {
  OWN_RELEASES_PAGE_URL,
  getDeliveryState,
  resetDeliveryForTest,
  startOwnUpdateDelivery,
} from '../updateDelivery';
import { useSelfUpdate } from '../useSelfUpdate';

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(I18nProvider, null, createElement(DownloadsProvider, null, children));

/** Update-check stub: every check errors out (ownUpdate stays null) while
 * the sidecar fetch (a github.com download URL) succeeds. */
/** A well-shaped sidecar: ONE outer-base64 line that decodes to the
 * four-line minisign document (untrusted comment / signature box / trusted
 * comment / global signature) - exactly what the shape gate admits. The
 * bytes are never cryptographically verified here: post-download
 * verification is a separate gate this suite does not reach. */
// Sig cryptobuf: "ED" (prehashed algo) + 8-byte key id + 64 bytes = 74.
const SIG_BOX = btoa(
  'ED' + String.fromCharCode(...new Uint8Array(8).fill(0x01), ...new Uint8Array(64).fill(0x11))
);
const SIG_INNER = [
  'untrusted comment: signature',
  SIG_BOX,
  'trusted comment: timestamp:0000000000\tfile:x',
  btoa(String.fromCharCode(...new Uint8Array(64).fill(0x22))),
].join('\n');
const SIG_DOC = btoa(SIG_INNER);

function stubFetch(opts: { sidecarBody?: string } = {}): ReturnType<typeof vi.fn> {
  const f = vi.fn(async (input: string | URL | Request) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (u.includes('releases/download/')) {
      return new Response(opts.sidecarBody ?? SIG_DOC, { status: 200 });
    }
    return new Response('rate limited', { status: 403 });
  });
  vi.stubGlobal('fetch', f as unknown as typeof fetch);
  return f;
}

const RELEASE = {
  tag: 'v1.0.13',
  version: '1.0.13',
  publishedAt: '2026-10-30T00:00:00Z',
  htmlUrl: 'https://github.com/WasewaseX/Fress/releases/tag/v1.0.13',
  assets: [
    {
      name: 'Fress_1.0.13_x64-setup.exe',
      size: 10_000_000,
      url: 'https://github.com/WasewaseX/Fress/releases/download/v1.0.13/Fress_1.0.13_x64-setup.exe',
    },
    {
      name: 'Fress_1.0.13_x64-setup.exe.sig',
      size: 320,
      url: 'https://github.com/WasewaseX/Fress/releases/download/v1.0.13/Fress_1.0.13_x64-setup.exe.sig',
    },
  ],
};
const GOOD_SHA = 'a'.repeat(64);

async function mountHook(): Promise<{ result: { current: ReturnType<typeof useSelfUpdate> } }> {
  const fh = renderHook(() => useSelfUpdate(vi.fn()), { wrapper });
  // Let the mount-time quiet check land (errors out): ownUpdate stays null
  // and the in-flight guard is released, so a click's own check can run.
  await waitFor(() => expect(fh.result.current.updateChecking).toBe(false));
  expect(fh.result.current.ownUpdate).toBeNull();
  return { result: fh.result };
}

describe('issue #128: the pill click never dead-ends without a detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    resetDeliveryForTest();
  });
  afterEach(() => {
    resetDeliveryForTest();
    vi.unstubAllGlobals();
  });

  it('a plan-level refusal ("See releases") opens the project Releases page', async () => {
    const { result } = await mountHook();
    // Plan the refusal directly through the shared entry point: a release
    // with no runnable asset routes to the planner's releases-page answer.
    await act(async () => {
      await startOwnUpdateDelivery(
        { release: { ...RELEASE, assets: [] }, asset: null, expectedSha256: null },
        { startDownload: vi.fn(), openExternal: externalOpen, revealItemInDir: vi.fn() }
      );
    });
    expect(getDeliveryState().phase).toBe('fallback');
    externalOpen.mockClear();
    act(() => {
      result.current.handleHeaderUpdateClick();
    });
    expect(externalOpen).toHaveBeenCalledWith(OWN_RELEASES_PAGE_URL);
  });

  it('a retryable failure ("Retry") re-runs the update check instead of doing nothing', async () => {
    const fetchStub = stubFetch();
    const { result } = await mountHook();
    const checksBefore = fetchStub.mock.calls.filter((c) =>
      String(c[0]).includes('api.github.com')
    ).length;
    // Drive the delivery into a retryable failure: the planner passes
    // (asset + digest + sidecar), then the startDownload dep refuses.
    await act(async () => {
      await startOwnUpdateDelivery(
        { release: RELEASE, asset: RELEASE.assets[0], expectedSha256: GOOD_SHA },
        {
          startDownload: vi.fn(async () => {
            throw new Error('start refused');
          }),
          openExternal: externalOpen,
          revealItemInDir: vi.fn(),
        }
      );
    });
    expect(getDeliveryState()).toMatchObject({ phase: 'failed', fallback: false });
    await act(async () => {
      result.current.handleHeaderUpdateClick();
    });
    await waitFor(() => expect(result.current.updateChecking).toBe(false));
    const checksAfter = fetchStub.mock.calls.filter((c) =>
      String(c[0]).includes('api.github.com')
    ).length;
    expect(checksAfter).toBeGreaterThan(checksBefore);
  });

  it('a mid-transfer click with a cleared detection shows the in-progress toast', async () => {
    stubFetch();
    const { result } = await mountHook();
    // A never-resolving start keeps the delivery in its downloading phase
    // (the channel-switch-mid-transfer shape from the issue).
    await act(async () => {
      void startOwnUpdateDelivery(
        { release: RELEASE, asset: RELEASE.assets[0], expectedSha256: GOOD_SHA },
        { startDownload: () => new Promise<void>(() => undefined), openExternal: externalOpen, revealItemInDir: vi.fn() }
      );
    });
    expect(getDeliveryState().phase).toBe('downloading');
    act(() => {
      result.current.handleHeaderUpdateClick();
    });
    expect(toast.info).toHaveBeenCalled();
    expect(externalOpen).not.toHaveBeenCalled();
  });

  it('an idle delivery with no detection stays inert (no browser, no check)', async () => {
    const fetchStub = stubFetch();
    const { result } = await mountHook();
    const checksBefore = fetchStub.mock.calls.length;
    act(() => {
      result.current.handleHeaderUpdateClick();
    });
    expect(externalOpen).not.toHaveBeenCalled();
    expect(fetchStub.mock.calls.length).toBe(checksBefore);
    expect(toast.info).not.toHaveBeenCalled();
  });
});
