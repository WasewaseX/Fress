// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
// @vitest-environment jsdom
//
// The app download flow contract (Agent 1, v1.0.12-beta regression).
//
// The reported defect: in the INSTALLED v1.0.12-beta app, clicking a
// supported app's Download opened the system browser on a releases page
// instead of starting the in-app transfer. Inside the packaged webview
// window.open is swallowed, so the visible browser could only have been
// launched by the opener plugin - i.e. the card's curated PAGE fallback
// ran. It ran because resolveDownloadFor returns null both for an honest
// "no installer exists" and for a FAILED lookup (GitHub's unauthenticated
// quota makes failures routine), and the old card could not tell the two
// apart.
//
// This suite pins the corrected contract at every seam:
//   - card: resolved direct -> startDownload (never an external open);
//   - card: FAILED lookup   -> retryable error toast, NEVER a page open
//     (mutation detector: removing the failure branch fails this test);
//   - card: honest none     -> curated fallback, honestly labeled;
//   - card: weak pick       -> visible caution, never silent;
//   - card: double click / rapid re-click -> one transfer;
//   - provider (real downloads.tsx): browser preview -> window.open +
//     a 'browser' panel entry (no fabricated native transfer); Tauri ->
//     exactly one start_download invoke carrying the trusted digest;
//     native rejection -> visible error, NO hidden browser fallback
//     (mutation detector for the native path);
//   - modal: a DIRECT option routes to the in-app transfer even when it
//     appears among the fallback rows (kind-distinction mutation check).
//
// Module boundaries are mocked per test with vi.doMock + vi.resetModules
// (the repo's established pattern for mixed mock regimes in one file);
// the POLICY under test - card routing, provider start contract, curated
// table - is never mocked.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  // download actions (card/modal seam)
  startDownload: vi.fn(),
  recordExternalOpen: vi.fn(),
  isAppDownloading: vi.fn(() => false),
  // resolver seam
  resolveDownloadFor: vi.fn(),
  guessUserPlatform: vi.fn(),
  peekResolveFailure: vi.fn(),
  retryResolveDownloadFor: vi.fn(),
  // external open seam
  openExternal: vi.fn(),
  // toasts
  toast: { success: vi.fn(), info: vi.fn(), error: vi.fn(), warning: vi.fn() },
  // native command surface (provider tests)
  invoke: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: h.toast }));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  h.isAppDownloading.mockReturnValue(false);
  h.invoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'default_download_dir') return '/downloads';
    if (cmd === 'start_download') return 42;
    return null;
  });
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

afterEach(() => {
  cleanup();
  vi.resetModules();
  // Every vi.doMock registration in this file is per-test: drop them all so
  // the next test's dynamic imports see a clean module graph.
  for (const m of [
    '../../lib/downloads',
    '../../lib/external',
    '../../lib/resolveRetry',
    '../../lib/releaseFetch',
    '../../lib/starFetch',
    '../../lib/officialResolvers',
    '@tauri-apps/api/core',
    '@tauri-apps/api/event',
    '@tauri-apps/plugin-dialog',
    '@tauri-apps/plugin-opener',
    '../AppCard',
  ]) {
    vi.doUnmock(m);
  }
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

function baseApp(over: Record<string, unknown> = {}) {
  return {
    id: 'localsend',
    name: 'LocalSend',
    tagline: 'Local network file sharing utility',
    description: 'An open source cross-platform alternative to AirDrop.',
    whyItsAwesome: 'No cloud upload.',
    beginnerGuide: 'Install it on both devices.',
    githubUrl: 'https://github.com/localsend/localsend',
    websiteUrl: 'https://localsend.org',
    downloadUrl: 'https://localsend.org/download',
    category: 'Utilities & System',
    platforms: ['windows', 'mac', 'linux', 'android', 'ios'],
    license: 'Apache-2.0',
    stars: 90853,
    isOwnerPick: false,
    isTrendingToday: false,
    tags: [],
    ...over,
  } as never;
}

const CONFIDENT_HIT = {
  source: 'github' as const,
  url: 'https://github.com/localsend/localsend/releases/download/v2/LocalSend-2.0.0.exe',
  filename: 'LocalSend-2.0.0.exe',
  size: 20_000_000,
  version: '2.0.0',
  publishedAt: '2026-01-01T00:00:00Z',
  releasePageUrl: 'https://github.com/localsend/localsend/releases/tag/v2.0.0',
  matchedBy: 'windows-installer',
};

function configureCardMocks(): void {
  vi.doMock('../../lib/downloads', () => ({
    useDownloadActions: () => ({ startDownload: h.startDownload, recordExternalOpen: h.recordExternalOpen }),
    useAppDownloadStatus: () => h.isAppDownloading(),
  }));
  vi.doMock('../../lib/external', () => ({ openExternal: h.openExternal }));
  vi.doMock('../../lib/resolveRetry', () => ({
    resolverRetry: {
      retryGitHubResolve: vi.fn(async () => null),
      retryFdroidResolve: vi.fn(async () => null),
      retryOfficialResolve: vi.fn(async () => null),
      retryResolveDownloadFor: h.retryResolveDownloadFor,
    },
  }));
  vi.doMock('../../lib/releaseFetch', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    resolveDownloadFor: h.resolveDownloadFor,
    guessUserPlatform: h.guessUserPlatform,
    peekResolveFailure: h.peekResolveFailure,
  }));
  vi.doMock('../../lib/starFetch', () => ({
    useLiveStars: () => null,
    formatStarCount: (n: number) => String(n),
  }));
}

async function renderCard(app: ReturnType<typeof baseApp>, props: Record<string, unknown> = {}) {
  configureCardMocks();
  const { AppCard } = await import('../AppCard');
  const { I18nProvider } = await import('../../lib/i18n');
  const onOpenDetail = vi.fn();
  const utils = render(
    createElement(
      I18nProvider,
      null,
      createElement(AppCard, {
        app,
        isFavorite: false,
        onToggleFavorite: () => undefined,
        onOpenDetail,
        ...props,
      })
    )
  );
  return { ...utils, onOpenDetail };
}

async function clickCardDownload(name = 'LocalSend'): Promise<void> {
  const btn = await screen.findByRole('button', { name: `Download ${name}` });
  fireEvent.click(btn);
  // Let the async resolve microtask settle inside act.
  await act(async () => undefined);
}

describe('AppCard download flow (Agent 1 regression)', () => {
  it('Tauri runtime + resolved direct artifact: exactly one in-app start, never an external open', async () => {
    h.guessUserPlatform.mockReturnValue('windows');
    h.resolveDownloadFor.mockResolvedValue(CONFIDENT_HIT);
    await renderCard(baseApp());
    await clickCardDownload();
    expect(h.startDownload).toHaveBeenCalledTimes(1);
    expect(h.startDownload).toHaveBeenCalledWith(
      CONFIDENT_HIT.url,
      CONFIDENT_HIT.filename,
      { expectedSha256: undefined, expectedSha512: undefined }
    );
    expect(h.openExternal).not.toHaveBeenCalled();
    expect(h.recordExternalOpen).not.toHaveBeenCalled();
  });

  it('a weak resolver pick starts in-app but is never silent: the caution toast names it as a best guess', async () => {
    h.guessUserPlatform.mockReturnValue('windows');
    h.resolveDownloadFor.mockResolvedValue({ ...CONFIDENT_HIT, weak: true });
    await renderCard(baseApp());
    await clickCardDownload();
    expect(h.startDownload).toHaveBeenCalledTimes(1);
    expect(h.toast.info).toHaveBeenCalledWith(
      'Best-guess file: matched by name only. Verify the publisher before running it.'
    );
  });

  it('honest no-match on a page-only target: the IN-APP options open, never a browser (no-auto-browser contract)', async () => {
    h.guessUserPlatform.mockReturnValue('windows');
    h.resolveDownloadFor.mockResolvedValue(null);
    h.peekResolveFailure.mockReturnValue(null);
    // id 'vlc' hits the REAL curated table: a 'page' target for windows.
    const { onOpenDetail } = await renderCard(
      baseApp({ id: 'vlc', name: 'VLC', githubUrl: 'https://github.com/videolan/vlc' })
    );
    await clickCardDownload('VLC');
    // The Download button NEVER launches the system browser by itself: a
    // page target lands in the in-app detail dialog where every official
    // option is a labeled link the user opens by choice.
    expect(h.openExternal).not.toHaveBeenCalled();
    expect(h.recordExternalOpen).not.toHaveBeenCalled();
    expect(h.startDownload).not.toHaveBeenCalled();
    expect(onOpenDetail).toHaveBeenCalledTimes(1);
    expect(h.toast.info).toHaveBeenCalledWith('Showing the download options for VLC');
  });

  it('FAILED lookup: a retryable error replaces the page open (mutation detector for the failure branch)', async () => {
    h.guessUserPlatform.mockReturnValue('windows');
    h.resolveDownloadFor.mockResolvedValue(null);
    h.peekResolveFailure.mockReturnValue({
      kind: 'rate-limit',
      message: 'GitHub rate limit reached; try again in a few minutes',
    });
    await renderCard(baseApp());
    await clickCardDownload();
    // The defect this fixes: the old card opened the releases page here.
    expect(h.openExternal).not.toHaveBeenCalled();
    expect(h.recordExternalOpen).not.toHaveBeenCalled();
    expect(h.startDownload).not.toHaveBeenCalled();
    expect(h.toast.error).toHaveBeenCalledTimes(1);
    const [title, opts] = h.toast.error.mock.calls[0];
    expect(title).toBe('Could not check LocalSend right now');
    const action = (opts as { action: { label: string; onClick: () => void } }).action;
    expect(action.label).toBe('Retry');
  });

  it('Retry on the failed-lookup toast runs the agreed composite seam and starts the found artifact', async () => {
    h.guessUserPlatform.mockReturnValue('windows');
    h.resolveDownloadFor.mockResolvedValue(null);
    h.peekResolveFailure.mockReturnValue({ kind: 'network', message: 'fetch failed' });
    await renderCard(baseApp());
    await clickCardDownload();
    const action = (h.toast.error.mock.calls[0][1] as { action: { onClick: () => Promise<void> | void } }).action;
    h.retryResolveDownloadFor.mockResolvedValue(CONFIDENT_HIT);
    await act(async () => {
      action.onClick();
    });
    expect(h.retryResolveDownloadFor).toHaveBeenCalledTimes(1);
    expect(h.startDownload).toHaveBeenCalledTimes(1);
    expect(h.startDownload).toHaveBeenCalledWith(CONFIDENT_HIT.url, CONFIDENT_HIT.filename, {
      expectedSha256: undefined,
      expectedSha512: undefined,
    });
    expect(h.openExternal).not.toHaveBeenCalled();
  });

  it('Retry that honestly answers none lands in the in-app options - only then, never a browser', async () => {
    h.guessUserPlatform.mockReturnValue('windows');
    h.resolveDownloadFor.mockResolvedValue(null);
    h.peekResolveFailure.mockReturnValue({ kind: 'api', message: 'GitHub HTTP 500' });
    const { onOpenDetail } = await renderCard(
      baseApp({ id: 'vlc', name: 'VLC', githubUrl: 'https://github.com/videolan/vlc' })
    );
    await clickCardDownload('VLC');
    expect(h.openExternal).not.toHaveBeenCalled();
    const action = (h.toast.error.mock.calls[0][1] as { action: { onClick: () => Promise<void> | void } }).action;
    h.retryResolveDownloadFor.mockResolvedValue(null);
    await act(async () => {
      action.onClick();
    });
    // The retry ANSWERED (no failure recorded): the in-app options dialog is
    // the intended fallback. The browser still never opens by itself.
    expect(h.openExternal).not.toHaveBeenCalled();
    expect(onOpenDetail).toHaveBeenCalledTimes(1);
    expect(h.toast.info).toHaveBeenCalledWith('Showing the download options for VLC');
  });

  it('an app with no curated target and no resolved artifact opens the in-app guide, not a browser', async () => {
    h.guessUserPlatform.mockReturnValue('windows');
    h.resolveDownloadFor.mockResolvedValue(null);
    h.peekResolveFailure.mockReturnValue(null);
    const { onOpenDetail } = await renderCard(
      baseApp({ id: 'mystery-app', githubUrl: '', downloadUrl: undefined, websiteUrl: '' })
    );
    await clickCardDownload();
    expect(h.openExternal).not.toHaveBeenCalled();
    expect(h.startDownload).not.toHaveBeenCalled();
    expect(onOpenDetail).toHaveBeenCalledTimes(1);
  });

  it('double-click protection: a repeat click during the resolve never re-runs the lookup', async () => {
    h.guessUserPlatform.mockReturnValue('windows');
    let release!: (v: typeof CONFIDENT_HIT) => void;
    h.resolveDownloadFor.mockReturnValue(
      new Promise<typeof CONFIDENT_HIT>((res) => {
        release = res;
      })
    );
    await renderCard(baseApp());
    const btn = await screen.findByRole('button', { name: 'Download LocalSend' });
    fireEvent.click(btn);
    await act(async () => undefined);
    fireEvent.click(btn);
    await act(async () => undefined);
    expect(h.resolveDownloadFor).toHaveBeenCalledTimes(1);
    release(CONFIDENT_HIT);
    await act(async () => undefined);
    expect(h.startDownload).toHaveBeenCalledTimes(1);
  });

  it('rapid re-click after the resolve lands is deduped by URL so one file cannot enqueue twice', async () => {
    h.guessUserPlatform.mockReturnValue('windows');
    h.resolveDownloadFor.mockResolvedValue(CONFIDENT_HIT);
    h.isAppDownloading.mockReturnValue(false);
    await renderCard(baseApp());
    await clickCardDownload();
    expect(h.startDownload).toHaveBeenCalledTimes(1);
    // The transfer has neither surfaced as active (mocked false) nor is the
    // card resolving; only the same-URL time-window dedupe stands between
    // this click and a second transfer of the same file.
    await clickCardDownload();
    expect(h.resolveDownloadFor).toHaveBeenCalledTimes(2);
    expect(h.startDownload).toHaveBeenCalledTimes(1);
  });

  it('an architecture-incompatible asset can never be picked for the device (hard refusal is resolver contract)', async () => {
    const { assetCompatibleWithDevice } = await import('../../lib/release/assetMatching');
    // Windows arch gate: an x86_64 host cannot run arm64 binaries, a 32-bit
    // host runs neither arm64 nor x64, and an ARM64 Windows host runs x64
    // through emulation. These refusals are what keep an incompatible
    // direct download from ever being initiated.
    expect(assetCompatibleWithDevice('App-1.0-arm64.exe', 'windows', 'x86_64')).toBe(false);
    expect(assetCompatibleWithDevice('App-1.0-x64.exe', 'windows', 'x86')).toBe(false);
    expect(assetCompatibleWithDevice('App-1.0-arm64.exe', 'windows', 'arm64')).toBe(true);
    expect(assetCompatibleWithDevice('App-1.0-x64.exe', 'windows', 'x86_64')).toBe(true);
  });
});

describe('startDownload provider contract (real downloads.tsx)', () => {
  function configureProviderMocks(): void {
    vi.doMock('@tauri-apps/api/core', () => ({ invoke: h.invoke }));
    vi.doMock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => undefined) }));
    vi.doMock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
    vi.doMock('@tauri-apps/plugin-opener', () => ({
      openPath: vi.fn(async () => undefined),
      revealItemInDir: vi.fn(async () => undefined),
    }));
  }

  async function mountProvider() {
    configureProviderMocks();
    const downloads = await import('../../lib/downloads');
    const { I18nProvider } = await import('../../lib/i18n');
    let captured: { actions: (typeof downloads)['useDownloadActions'] extends () => infer R ? R : never; items: { id: number; status: string; expectedSha256?: string; name: string; url: string; dir: string }[] } | null = null;
    function Harness(): null {
      const actions = downloads.useDownloadActions();
      const { items } = downloads.useDownloadItems();
      captured = { actions, items } as typeof captured;
      return null;
    }
    render(
      createElement(I18nProvider, null, createElement(downloads.DownloadsProvider, null, createElement(Harness)))
    );
    return {
      get actions() {
        return captured!.actions;
      },
      get items() {
        return captured!.items;
      },
    };
  }

  it('browser preview + direct option: window.open is the transfer, recorded as a browser handoff (no fabricated native item)', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const p = await mountProvider();
    await act(async () => {
      await p.actions.startDownload('https://example.com/Installer.exe', 'Installer.exe');
    });
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith('https://example.com/Installer.exe', '_blank', 'noopener,noreferrer');
    expect(h.invoke).not.toHaveBeenCalledWith('start_download', expect.anything());
    expect(p.items).toHaveLength(1);
    expect(p.items[0].status).toBe('browser');
    expect(p.items[0].name).toBe('Installer.exe');
    openSpy.mockRestore();
  });

  it('Tauri runtime + direct option: exactly one native start carrying the trusted digest, no window.open', async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const p = await mountProvider();
    await act(async () => {
      await p.actions.startDownload('https://example.com/Installer.exe', 'Installer.exe', {
        expectedSha256: 'deadbeef',
      });
    });
    const startCalls = h.invoke.mock.calls.filter((c) => c[0] === 'start_download');
    expect(startCalls).toHaveLength(1);
    expect(startCalls[0][1]).toEqual({
      url: 'https://example.com/Installer.exe',
      filename: 'Installer.exe',
      directory: '/downloads',
      expectedSha256: 'deadbeef',
      expectedSha512: null,
      resume: false,
    });
    expect(openSpy).not.toHaveBeenCalled();
    expect(p.items).toHaveLength(1);
    expect(p.items[0].status).toBe('active');
    expect(p.items[0].expectedSha256).toBe('deadbeef');
    openSpy.mockRestore();
  });

  it('native start rejection: a visible retryable failure - the error is never laundered into a browser open', async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    h.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'default_download_dir') return '/downloads';
      if (cmd === 'start_download') throw new Error('disk full');
      return null;
    });
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const p = await mountProvider();
    await act(async () => {
      await p.actions.startDownload('https://example.com/Installer.exe', 'Installer.exe');
    });
    expect(h.toast.error).toHaveBeenCalledTimes(1);
    // Mutation detector: making the native failure silently open a page
    // would fail here.
    expect(openSpy).not.toHaveBeenCalled();
    expect(p.items).toHaveLength(0);
    openSpy.mockRestore();
  });

  it('Tauri runtime + page action: the panel records an honest page entry, never an active native transfer', async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const p = await mountProvider();
    await act(async () => {
      p.actions.recordExternalOpen('VLC: Official download page', 'https://www.videolan.org/vlc/download-windows.html');
    });
    expect(p.items).toHaveLength(1);
    expect(p.items[0].status).toBe('page');
    expect(h.invoke).not.toHaveBeenCalledWith('start_download', expect.anything());
  });
});

describe('AppDetailModal fallback routing (kind-distinction mutation check)', () => {
  async function renderModalDirectFallback() {
    vi.doMock('../../lib/releaseFetch', () => ({
      resolveGitHubDownload: vi.fn(async () => null),
      resolveFdroidDownload: vi.fn(async () => null),
      retryGitHubResolve: vi.fn(async () => null),
      retryFdroidResolve: vi.fn(async () => null),
      parseGithubRepo: () => null,
      fdroidPageUrl: (id: string) => `https://f-droid.org/packages/${id}/`,
      playStoreUrl: (id: string) => `https://play.google.com/store/apps/details?id=${id}`,
      githubFetchSupported: (p: string) => p !== 'web' && p !== 'ios',
      peekResolveError: () => null,
      peekResolveFailure: () => null,
    }));
    vi.doMock('../../lib/officialResolvers', () => ({
      officialSupported: () => false,
      resolveOfficialDownload: vi.fn(async () => null),
    }));
    vi.doMock('../../lib/resolveRetry', () => ({
      resolverRetry: {
        retryGitHubResolve: vi.fn(async () => null),
        retryFdroidResolve: vi.fn(async () => null),
        retryOfficialResolve: vi.fn(async () => null),
        retryResolveDownloadFor: vi.fn(async () => null),
      },
    }));
    vi.doMock('../../lib/downloads', () => ({
      useDownloadActions: () => ({ startDownload: h.startDownload, recordExternalOpen: h.recordExternalOpen }),
      useAppDownloadStatus: () => false,
      formatBytes: (n: number) => `${n} B`,
    }));
    vi.doMock('../../lib/external', () => ({ openExternal: h.openExternal }));
    vi.doMock('../../lib/starFetch', () => ({ useLiveStars: () => null }));
    vi.doMock('../AppCard', () => ({ AppIcon: () => createElement('span', { 'data-testid': 'app-icon' }) }));
    const { AppDetailModal } = await import('../AppDetailModal');
    const { I18nProvider } = await import('../../lib/i18n');
    const app = baseApp({
      id: 'f-droid',
      name: 'F-Droid',
      githubUrl: 'https://github.com/f-droid/fdroidclient',
      platforms: ['android'],
      fdroidId: 'org.fdroid.fdroid',
      downloadUrl: undefined,
    });
    render(createElement(I18nProvider, null, createElement(AppDetailModal, { app, onClose: () => {} })));
  }

  it('a DIRECT curated option among the fallbacks starts the in-app transfer; the F-Droid page fallback opens externally', async () => {
    await renderModalDirectFallback();
    // The curated 'direct' row (F-Droid .apk) sits under "Other ways".
    const directRow = await screen.findByRole('button', { name: /F-Droid \.apk \(direct\)/ });
    fireEvent.click(directRow);
    await act(async () => undefined);
    expect(h.startDownload).toHaveBeenCalledTimes(1);
    expect(h.startDownload).toHaveBeenCalledWith('https://f-droid.org/F-Droid.apk', 'F-Droid .apk (direct)', undefined);
    // Mutation detector: deleting the `option.kind === 'direct'` branch in
    // handleOption routes this row to openExternal and fails this assert.
    expect(h.openExternal).not.toHaveBeenCalled();

    // The honest-none F-Droid page fallback IS an external action.
    const fdPageRow = await screen.findByRole('button', { name: /^F-Droid$/ });
    fireEvent.click(fdPageRow);
    await act(async () => undefined);
    expect(h.openExternal).toHaveBeenCalledTimes(1);
    expect(h.openExternal).toHaveBeenCalledWith('https://f-droid.org/packages/org.fdroid.fdroid/');
    expect(h.startDownload).toHaveBeenCalledTimes(1);
  }, 15000);
});
