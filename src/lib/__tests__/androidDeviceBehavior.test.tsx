// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
// @vitest-environment jsdom
//
// Android device behavior contract, verified at the UI seam.
//
// These gates exist because a desktop developer never sees them break:
//   1. An Android device opens the catalog on the 'android' platform filter
//      (deviceDefaultPlatform), while a desktop device opens on 'all'.
//   2. The user's stored platform choice always wins over the device
//      default, on Android too.
//   3. isAndroidWebview() is the scoped-storage signal: true for an Android
//      WebView UA, false for desktop browsers and iOS Safari.
//   4. Android's scoped storage has no arbitrary folder picker, so the
//      DownloadManager must NOT offer "Change folder" on an Android device,
//      while the desktop surface keeps it.
//
// The navigator UA is stubbed BEFORE the module graph is (re)imported with
// vi.resetModules(): useCatalogFilters computes isAndroidDevice at module
// load, mirroring how the app bundle evaluates it once per session.

import { act } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const h = vi.hoisted(() => ({ nextId: 0 }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === 'default_download_dir') return '/downloads';
    if (cmd === 'start_download') return ++h.nextId;
    return null;
  }),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => undefined),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), info: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

function stubUserAgent(ua: string): void {
  vi.stubGlobal('navigator', { userAgent: ua });
}

describe('Android device platform default', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('an Android device opens the catalog on the android filter', async () => {
    stubUserAgent(ANDROID_UA);
    const { deviceDefaultPlatform } = await import('../../features/catalog/useCatalogFilters');
    expect(deviceDefaultPlatform).toBe('android');
  });

  it('a desktop device opens on the full list (all)', async () => {
    stubUserAgent(DESKTOP_UA);
    const { deviceDefaultPlatform } = await import('../../features/catalog/useCatalogFilters');
    expect(deviceDefaultPlatform).toBe('all');
  });

  it('a stored platform choice wins over the Android device default', async () => {
    stubUserAgent(ANDROID_UA);
    localStorage.setItem('fress_platform_filter', 'linux');
    const { useCatalogFilters } = await import('../../features/catalog/useCatalogFilters');
    const { I18nProvider } = await import('../../lib/i18n');

    let platform: string | null = null;
    function Harness(): null {
      const { filters } = useCatalogFilters();
      platform = filters.platform;
      return null;
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    let root: Root | null = null;
    await act(async () => {
      root = createRoot(container);
      root.render(createElement(I18nProvider, null, createElement(Harness)));
    });
    expect(platform).toBe('linux');
    await act(async () => {
      root?.unmount();
    });
    container.remove();
  });

  it('an Android device with empty storage starts on android through the hook', async () => {
    stubUserAgent(ANDROID_UA);
    const { useCatalogFilters } = await import('../../features/catalog/useCatalogFilters');
    const { I18nProvider } = await import('../../lib/i18n');

    let platform: string | null = null;
    function Harness(): null {
      const { filters } = useCatalogFilters();
      platform = filters.platform;
      return null;
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    let root: Root | null = null;
    await act(async () => {
      root = createRoot(container);
      root.render(createElement(I18nProvider, null, createElement(Harness)));
    });
    expect(platform).toBe('android');
    await act(async () => {
      root?.unmount();
    });
    container.remove();
  });
});

describe('isAndroidWebview, the scoped-storage signal', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is true for an Android WebView user agent', async () => {
    stubUserAgent(ANDROID_UA);
    const { isAndroidWebview } = await import('../../lib/downloads');
    expect(isAndroidWebview()).toBe(true);
  });

  it('is false for a desktop browser user agent', async () => {
    stubUserAgent(DESKTOP_UA);
    const { isAndroidWebview } = await import('../../lib/downloads');
    expect(isAndroidWebview()).toBe(false);
  });

  it('is false for iOS Safari (iOS has its own storage model, not Android scoped storage)', async () => {
    stubUserAgent(IOS_UA);
    const { isAndroidWebview } = await import('../../lib/downloads');
    expect(isAndroidWebview()).toBe(false);
  });
});

describe('DownloadManager scoped-storage gating on Android', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

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

  it('an Android device is never offered "Change folder" (scoped storage)', async () => {
    stubUserAgent(ANDROID_UA);
    await renderManager();
    expect(screen.queryByRole('button', { name: 'Change folder' })).toBeNull();
  });

  it('a desktop device keeps the "Change folder" control', async () => {
    stubUserAgent(DESKTOP_UA);
    await renderManager();
    expect(screen.getByRole('button', { name: 'Change folder' })).toBeTruthy();
  });
});
