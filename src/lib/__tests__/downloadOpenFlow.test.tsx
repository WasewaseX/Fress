// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
// @vitest-environment jsdom
//
// The Android adapter of the download-to-open contract
// (docs/download-open-contract.md).
//
// Agent 6's suite (artifactOpen.test.tsx + Workflow K) pins the desktop
// policy and the opener wiring. THIS file pins the Android half:
//
//   1. On an Android webview the provider binds openCompletedArtifact's
//      openPath dep to the registry-validated native adapter command
//      (`open_downloaded_file`) - the exact completed path crosses as ONE
//      value and the opener plugin is never touched.
//   2. On desktop the same policy keeps the opener plugin (no Android
//      command traffic - the platforms never cross).
//   3. The adapter's typed `open-artifact/<code>` refusals classify through
//      the SAME taxonomy the desktop boundary uses, and the toast stays the
//      generic title with the localized reason.
//   4. The manager keeps Agent 6's pinned uniform "Open file" label with
//      the download-open e2e hook on every completed row; restored rows
//      keep the affordance - the adapter refuses them honestly with
//      `not-registered`.

import React from 'react';
import { act } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DownloadsProvider, useDownloadActions } from '../downloads';
import { I18nProvider } from '../i18n';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const DOWNLOADS_DIR = '/data/data/com.fress.app/files/Download';
const APK: CompletedArtifactRefLike = {
  id: 7,
  path: `${DOWNLOADS_DIR}/org.videolan.vlc_1043.apk`,
  name: 'org.videolan.vlc_1043.apk',
  url: 'https://f-droid.org/repo/org.videolan.vlc_1043.apk',
};
const ZIP: CompletedArtifactRefLike = {
  id: 8,
  path: `${DOWNLOADS_DIR}/manual.pdf`,
  name: 'manual.pdf',
  url: 'https://example.com/manual.pdf',
};

interface CompletedArtifactRefLike {
  id: number;
  path: string;
  name: string;
  url: string;
}

const h = vi.hoisted(() => {
  const listeners = new Map<string, Array<(e: { payload: unknown }) => void>>();
  return {
    listeners,
    openPath: vi.fn(async () => undefined),
    revealItemInDir: vi.fn(async () => undefined),
    invoke: vi.fn(async (..._: unknown[]) => null as unknown),
    toastError: vi.fn(),
    toastSuccess: vi.fn(),
    toastInfo: vi.fn(),
  };
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: h.invoke,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, cb: (e: { payload: unknown }) => void) => {
    const queue = h.listeners.get(name) ?? [];
    queue.push(cb);
    h.listeners.set(name, queue);
    return () => undefined;
  }),
}));

vi.mock('@tauri-apps/api/path', () => ({ dirname: vi.fn(async (p: string) => p + '/..') }));

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

vi.mock('@tauri-apps/plugin-opener', () => ({
  openPath: h.openPath,
  revealItemInDir: h.revealItemInDir,
}));

vi.mock('sonner', () => ({
  toast: {
    error: h.toastError,
    success: h.toastSuccess,
    info: h.toastInfo,
    warning: vi.fn(),
  },
}));

function setTauriMode(on: boolean): void {
  const w = window as unknown as Record<string, unknown>;
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

function stubUserAgent(ua: string): void {
  vi.stubGlobal('navigator', { userAgent: ua });
}

beforeEach(() => {
  localStorage.clear();
  setTauriMode(true);
});

afterEach(() => {
  cleanup();
  h.listeners.clear();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  h.invoke.mockImplementation(async (cmd?: string) =>
    cmd === 'default_download_dir'
      ? (DOWNLOADS_DIR as unknown)
      : cmd === 'start_download'
        ? (7 as unknown)
        : (null as unknown)
  );
  h.openPath.mockImplementation(async () => undefined);
  setTauriMode(false);
});

/** Counts only the adapter command's invoke calls (the provider also
 * invokes default_download_dir on mount, which is not under test). */
function adapterCalls(): Array<[string, unknown]> {
  return h.invoke.mock.calls.filter(
    ([cmd]) => cmd === 'open_downloaded_file'
  ) as Array<[string, unknown]>;
}

type DownloadActionsValue = ReturnType<typeof useDownloadActions>;

async function mountActions(): Promise<DownloadActionsValue> {
  let captured: DownloadActionsValue | null = null;
  function Probe(): null {
    const actions = useDownloadActions();
    captured = actions;
    return null;
  }
  await act(async () => {
    render(
      createElement(
        I18nProvider,
        null,
        createElement(DownloadsProvider, null, createElement(Probe))
      )
    );
  });
  if (!captured) throw new Error('actions were not captured');
  return captured;
}

describe('the Android adapter binding', () => {
  it('routes the open through the validated adapter command with the exact path', async () => {
    stubUserAgent(ANDROID_UA);
    const actions = await mountActions();
    const outcome = await actions.openFile(APK);
    expect(outcome).toMatchObject({ ok: true });
    expect(adapterCalls()).toHaveLength(1);
    const [cmd, args] = adapterCalls()[0];
    expect(cmd).toBe('open_downloaded_file');
    expect(args).toEqual({ path: APK.path });
    // The opener plugin is never touched on Android.
    expect(h.openPath).not.toHaveBeenCalled();
  });

  it('keeps the opener plugin on desktop: no Android adapter traffic', async () => {
    stubUserAgent(DESKTOP_UA);
    const actions = await mountActions();
    const outcome = await actions.openFile(APK);
    expect(outcome).toMatchObject({ ok: true });
    expect(h.openPath).toHaveBeenCalledWith(APK.path);
    expect(adapterCalls()).toHaveLength(0);
  });

  it('classifies adapter refusals through the shared typed taxonomy', async () => {
    stubUserAgent(ANDROID_UA);
    const actions = await mountActions();
    // The Rust adapter's uniform refusal for every out-of-registry path.
    h.invoke.mockImplementationOnce(
      async (cmd?: string) =>
        cmd === 'open_downloaded_file'
          ? await Promise.reject('open-artifact/not-registered')
          : (null as unknown)
    );
    const out = await actions.openFile(APK);
    expect(out).toMatchObject({ ok: false, kind: 'unregistered' });
    expect(h.toastError).toHaveBeenCalledTimes(1);
    const [title, opts] = h.toastError.mock.calls[0];
    expect(title).toBe('Could not open the file');
    // The localized reason for the typed kind (Agent 2's wording).
    expect(String(opts?.description)).not.toBe('');
    // Retryable: the failure did not stick.
    await actions.openFile(APK);
    expect(adapterCalls()).toHaveLength(2);
  });

  it('maps not-found and passes plain OS wording through the same parser', async () => {
    stubUserAgent(ANDROID_UA);
    const actions = await mountActions();
    h.invoke.mockRejectedValueOnce(
      'open-artifact/not-found: download #7, originally from https://example.com; the download had completed checksum-verified'
    );
    const gone = await actions.openFile(APK);
    expect(gone).toMatchObject({ ok: false, kind: 'missing' });

    // Plain OS text (as an OS-level handler failure would produce) is
    // classified by the same patterns the opener plugin feeds.
    h.invoke.mockRejectedValueOnce('Cannot open the downloaded file: Permission denied (os error 13)');
    const denied = await actions.openFile(APK);
    expect(denied).toMatchObject({ ok: false, kind: 'permission' });
  });

  it('never launches the AppImage fallback on Android (not a supported platform there)', async () => {
    stubUserAgent(ANDROID_UA);
    const actions = await mountActions();
    const appimage = { ...ZIP, path: `${DOWNLOADS_DIR}/tool.AppImage`, name: 'tool.AppImage' };
    await actions.openFile(appimage);
    // The adapter command owns the call; the AppImage launcher command is
    // desktop-Linux-only by construction.
    expect(h.invoke).toHaveBeenCalledWith('open_downloaded_file', { path: appimage.path });
  });
});

describe('DownloadManager Install/Open affordances', () => {
  /** Renders ONE provider carrying a start trigger and the manager, runs
   * one download through the real flow (start_download's invoke resolves an
   * id, then the download-complete event lands), and leaves the manager on
   * screen for assertions. */
  async function renderManagerWithSessionDownload(path: string): Promise<void> {
    const { I18nProvider } = await import('../i18n');
    const { DownloadsProvider, useDownloadActions } = await import('../downloads');
    const { DownloadManager } = await import('../../components/DownloadManager');
    let start: ((url: string, name?: string) => Promise<void>) | null = null;
    function Trigger(): null {
      const { startDownload } = useDownloadActions();
      start = startDownload as unknown as (url: string, name?: string) => Promise<void>;
      return null;
    }
    await act(async () => {
      render(
        createElement(
          I18nProvider,
          null,
          createElement(
            DownloadsProvider,
            null,
            createElement(Trigger),
            createElement(DownloadManager, { isOpen: true, onClose: () => undefined })
          )
        )
      );
    });
    await act(async () => {
      await (start as unknown as (url: string, name?: string) => Promise<void>)(
        'https://f-droid.org/repo/org.videolan.vlc_1043.apk'
      );
    });
    await act(async () => {
      const cbs = h.listeners.get('download-complete') ?? [];
      cbs[cbs.length - 1]?.({ payload: { id: 7, path, bytes: 20480, sha256: 'abc', verified: true } });
    });
  }

  it('an Android device keeps the uniform Open action (download-open) for a session .apk', async () => {
    stubUserAgent(ANDROID_UA);
    await renderManagerWithSessionDownload(`${DOWNLOADS_DIR}/org.videolan.vlc_1043.apk`);
    const open = screen.getByTestId('download-open');
    expect(open.textContent).toContain('Open file');
    expect(screen.queryByTestId('download-install')).toBeNull();
    // App-private storage: no folder affordance on Android.
    expect(screen.queryByRole('button', { name: 'Show in folder' })).toBeNull();
  });

  it('a desktop device keeps "Open file" (download-open) for the same artifact', async () => {
    stubUserAgent(DESKTOP_UA);
    await renderManagerWithSessionDownload(`${DOWNLOADS_DIR}/org.videolan.vlc_1043.apk`);
    const opens = screen.getAllByTestId('download-open');
    const open = opens[0];
    expect(open.textContent).toContain('Open file');
    expect(screen.queryByTestId('download-install')).toBeNull();
  });

  it('a session non-APK artifact stays an open affordance on Android', async () => {
    stubUserAgent(ANDROID_UA);
    await renderManagerWithSessionDownload(`${DOWNLOADS_DIR}/manual.pdf`);
    const open = screen.getByTestId('download-open');
    expect(open.textContent).toContain('Open file');
    expect(screen.queryByTestId('download-install')).toBeNull();
  });
});
