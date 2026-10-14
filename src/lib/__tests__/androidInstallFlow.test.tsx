// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
// @vitest-environment jsdom
//
// The Android download-to-install seam, verified at the UI boundary.
//
// Contract under test (docs/android-open-path-interface.md):
//   1. The download panel's primary action on a completed row routes
//      through the app's OWN `open_path` command on EVERY platform - the
//      command that validates the path against the download engine's
//      completed-artifact registry. The plugin's raw openPath is no longer
//      reachable from the panel, so an unvalidated path can never be
//      opened.
//   2. On Android a completed .apk row says "Install", because that is
//      what the command does with it (FileProvider content:// URI ->
//      system package installer). Every other row keeps "Open file".
//   3. A completed .apk on the desktop still says "Open file" - the
//      installer route is Android's alone.
//
// The navigator UA is stubbed BEFORE the module graph is (re)imported with
// vi.resetModules(): isAndroidWebview() reads navigator.userAgent at call
// time, and the components capture it while rendering.

import { act } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const h = vi.hoisted(() => ({
  invoked: [] as Array<{ cmd: string; args: unknown }>,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args?: unknown) => {
    h.invoked.push({ cmd, args });
    if (cmd === 'default_download_dir') return '/downloads';
    if (cmd === 'start_download') return 1;
    return null;
  }),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => undefined),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('@tauri-apps/plugin-opener', () => ({
  openPath: vi.fn(async () => undefined),
  revealItemInDir: vi.fn(async () => undefined),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), info: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

function stubUserAgent(ua: string): void {
  vi.stubGlobal('navigator', { userAgent: ua });
}

/** Seeds the persisted panel with one completed download (the shape
 * serializeItems writes; the provider restores it on mount). */
function seedCompletedDownload(name: string, path: string): void {
  localStorage.setItem(
    'fress.downloadItems.v1',
    JSON.stringify([
      {
        url: `https://example.com/${name}`,
        name,
        dir: '/downloads',
        bytes: 128,
        total: 128,
        status: 'completed',
        path,
        startedAt: Date.now(),
      },
    ])
  );
}

async function renderManager(): Promise<void> {
  const { I18nProvider } = await import('../../lib/i18n');
  const { DownloadsProvider } = await import('../../lib/downloads');
  const { DownloadManager } = await import('../../components/DownloadManager');
  render(
    createElement(
      I18nProvider,
      null,
      createElement(
        DownloadsProvider,
        null,
        createElement(DownloadManager, { isOpen: true, onClose: () => undefined })
      )
    )
  );
}

describe('isAndroidApkArtifact, the install-label classifier', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.resetModules();
    h.invoked.length = 0;
  });

  it('is true for an .apk on Android, case-insensitive', async () => {
    stubUserAgent(ANDROID_UA);
    const { isAndroidApkArtifact } = await import('../../lib/downloads');
    expect(isAndroidApkArtifact('F-Droid_1021051.apk')).toBe(true);
    expect(isAndroidApkArtifact('Signal-7.11.3.APK')).toBe(true);
  });

  it('is false for non-apk names on Android', async () => {
    stubUserAgent(ANDROID_UA);
    const { isAndroidApkArtifact } = await import('../../lib/downloads');
    expect(isAndroidApkArtifact('report.pdf')).toBe(false);
    expect(isAndroidApkArtifact('installer.exe')).toBe(false);
    expect(isAndroidApkArtifact('app.apk.part')).toBe(false);
  });

  it('is false on desktop even for an .apk', async () => {
    stubUserAgent(DESKTOP_UA);
    const { isAndroidApkArtifact } = await import('../../lib/downloads');
    expect(isAndroidApkArtifact('F-Droid.apk')).toBe(false);
  });
});

describe('the completed row opens through the open_path boundary', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    h.invoked.length = 0;
    // openFile is gated on isTauri(): the panel never opens files outside
    // the app shell. Presence of the internals marker IS the gate.
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke: () => Promise.resolve(null),
    };
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.resetModules();
    h.invoked.length = 0;
  });

  it('an Android device labels a completed .apk "Install" and hands its path to open_path', async () => {
    stubUserAgent(ANDROID_UA);
    seedCompletedDownload('F-Droid_1021051.apk', '/data/app/com.fress.app/files/Download/F-Droid_1021051.apk');
    await renderManager();

    const install = screen.getByRole('button', { name: 'Install' });
    expect(screen.queryByRole('button', { name: 'Open file' })).toBeNull();
    await act(async () => {
      install.click();
    });

    const call = h.invoked.find((c) => c.cmd === 'open_path');
    expect(call).toBeTruthy();
    expect((call!.args as { path: string }).path).toBe(
      '/data/app/com.fress.app/files/Download/F-Droid_1021051.apk'
    );
    // The raw opener plugin must stay out of this path: the registry
    // validation lives in the app's own command.
    const openerCall = h.invoked.find((c) => c.cmd === 'plugin:opener|open_path');
    expect(openerCall).toBeUndefined();
  });

  it('a desktop device keeps "Open file" for an .apk and still goes through open_path', async () => {
    stubUserAgent(DESKTOP_UA);
    seedCompletedDownload('F-Droid.apk', '/home/test/Downloads/F-Droid.apk');
    await renderManager();

    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull();
    const open = screen.getByRole('button', { name: 'Open file' });
    await act(async () => {
      open.click();
    });

    const call = h.invoked.find((c) => c.cmd === 'open_path');
    expect(call).toBeTruthy();
    expect((call!.args as { path: string }).path).toBe('/home/test/Downloads/F-Droid.apk');
  });

  it('a completed non-apk on Android says "Open file" (view/share, never the installer)', async () => {
    stubUserAgent(ANDROID_UA);
    seedCompletedDownload('report.pdf', '/data/app/com.fress.app/files/Download/report.pdf');
    await renderManager();

    const open = screen.getByRole('button', { name: 'Open file' });
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull();
    await act(async () => {
      open.click();
    });

    const call = h.invoked.find((c) => c.cmd === 'open_path');
    expect(call).toBeTruthy();
    expect((call!.args as { path: string }).path).toContain('report.pdf');
  });
});
