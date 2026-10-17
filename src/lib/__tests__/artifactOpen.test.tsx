// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
// @vitest-environment jsdom
//
// The download-to-open boundary, on both sides:
//
//  1. The pure operations (src/lib/artifactOpen.ts): the exact completed
//     path crosses the opener boundary as ONE value, the AppImage fallback
//     fires only where it is allowed and only after a rejection, and every
//     rejection is classified honestly.
//
//  2. The provider wiring (src/lib/downloads.tsx): repeat activation while
//     one launch is pending produces exactly ONE native call (the E2E-pinned
//     single-launch contract, K-G1), failures toast the generic title with a
//     classified description and stay retryable, and concurrent artifacts
//     never cross-wire their paths.

import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  openCompletedArtifact,
  revealCompletedArtifact,
  parseOpenError,
  type ArtifactOpenDeps,
  type ArtifactRevealDeps,
  type CompletedArtifactRef,
} from '../artifactOpen';
import { DownloadsProvider, useDownloadActions } from '../downloads';
import { I18nProvider } from '../i18n';

type DownloadActionsValue = ReturnType<typeof useDownloadActions>;

const h = vi.hoisted(() => {
  const listeners = new Map<string, Array<(e: { payload: unknown }) => void>>();
  return {
    listeners,
    openPath: vi.fn(async (_path?: string): Promise<void> => undefined),
    revealItemInDir: vi.fn(async (_path?: string): Promise<void> => undefined),
    invoke: vi.fn((cmd?: unknown, args?: unknown) => {
      const c = typeof cmd === 'string' ? cmd : '';
      const a = (args ?? {}) as Record<string, unknown>;
      if (c === 'open_downloaded_file') return h.openPath(String(a.path ?? ''));
      if (c === 'reveal_download_file') return h.revealItemInDir(String(a.path ?? ''));
      if (c === 'open_download_dir') return h.openPath(String(a.dir ?? ''));
      return Promise.resolve(null as unknown);
    }),
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

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  // Restore the default no-failure behavior after fault-injection tests.
  h.openPath.mockImplementation(async (_path?: string): Promise<void> => undefined);
  h.revealItemInDir.mockImplementation(async (_path?: string): Promise<void> => undefined);
  h.invoke.mockImplementation((cmd?: unknown, args?: unknown) => {
    const c = typeof cmd === 'string' ? cmd : '';
    const a = (args ?? {}) as Record<string, unknown>;
    if (c === 'open_downloaded_file') return h.openPath(String(a.path ?? ''));
    if (c === 'reveal_download_file') return h.revealItemInDir(String(a.path ?? ''));
    if (c === 'open_download_dir') return h.openPath(String(a.dir ?? ''));
    return Promise.resolve(null as unknown);
  });
  setTauriMode(false);
});

// ---------------------------------------------------------------------------
// 1. parseOpenError - the failure taxonomy
// ---------------------------------------------------------------------------

describe('parseOpenError', () => {
  it('maps the launcher command\'s typed codes', () => {
    expect(parseOpenError('open-artifact/not-found: the downloaded file is no longer on disk')).toEqual({
      kind: 'missing',
      detail: 'the downloaded file is no longer on disk',
    });
    expect(parseOpenError('open-artifact/id-mismatch').kind).toBe('cross-wired');
    expect(parseOpenError('open-artifact/not-registered').kind).toBe('unregistered');
    expect(parseOpenError('open-artifact/replaced').kind).toBe('replaced');
    expect(parseOpenError('open-artifact/symlink').kind).toBe('not-a-file');
    expect(parseOpenError('open-artifact/internal: spawn failed: boom')).toEqual({
      kind: 'unknown',
      detail: 'spawn failed: boom',
    });
    // An unrecognized typed code must not masquerade as a specific reason.
    expect(parseOpenError('open-artifact/something-new').kind).toBe('unknown');
  });

  it('classifies real plugin/OS error wordings per platform', () => {
    // Windows / Linux missing file
    expect(parseOpenError('No such file or directory').kind).toBe('missing');
    expect(parseOpenError('The system cannot find the file specified. (os error 2)').kind).toBe('missing');
    // Permission
    expect(parseOpenError('Permission denied').kind).toBe('permission');
    expect(parseOpenError('Access is denied. (os error 5)').kind).toBe('permission');
    // No handler (Windows SE_ERR_NOASSOC, Linux xdg-open/gio wordings)
    expect(parseOpenError('No application is registered as handling this file').kind).toBe('no-handler');
    expect(parseOpenError('os error 1155').kind).toBe('no-handler');
    expect(parseOpenError('xdg-open: no method available for ...').kind).toBe('no-handler');
    // Shape
    expect(parseOpenError('Path is a directory').kind).toBe('not-a-file');
    // Honest fallback
    expect(parseOpenError('something entirely unexpected').kind).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// 2. openCompletedArtifact - the opening operation
// ---------------------------------------------------------------------------

function makeDeps(over: Partial<ArtifactOpenDeps> = {}): ArtifactOpenDeps & {
  launch: ReturnType<typeof vi.fn>;
  warns: string[];
} {
  const warns: string[] = [];
  const launch = vi.fn(async () => undefined);
  return {
    openPath: h.openPath,
    launchAppImage: launch,
    appImageLaunchSupported: false,
    warn: (m) => warns.push(m),
    launch,
    warns,
    ...over,
  };
}

const EXE: CompletedArtifactRef = {
  id: 1,
  path: '/home/test/Downloads/LocalSend-1.17.0-windows-x64.exe',
  name: 'LocalSend-1.17.0-windows-x64.exe',
  url: 'https://example.com/localsend.exe',
};

const APPIMAGE: CompletedArtifactRef = {
  id: 2,
  path: '/home/test/Downloads/Bitwarden-2025.1.0-x86_64.AppImage',
  name: 'Bitwarden-2025.1.0-x86_64.AppImage',
  url: 'https://example.com/bitwarden',
};

describe('openCompletedArtifact', () => {
  it('hands the EXACT completed path to the opener and does not pre-empt the OS', async () => {
    const deps = makeDeps();
    const out = await openCompletedArtifact(EXE, deps);
    expect(out.ok).toBe(true);
    expect(h.openPath).toHaveBeenCalledTimes(1);
    expect(h.openPath).toHaveBeenCalledWith(EXE.path);
    expect(deps.launch).not.toHaveBeenCalled();
  });

  it('passes spaces, Unicode, parentheses and shell-like names through as ONE value', async () => {
    const deps = makeDeps();
    const spaced: CompletedArtifactRef = {
      ...EXE,
      path: '/home/test/Downloads/Lokaler Versand 1.17 (offiziell) — Änderungen [x64] & final.exe',
    };
    await openCompletedArtifact(spaced, deps);
    expect(h.openPath).toHaveBeenCalledWith(spaced.path);
  });

  it('classifies an opener rejection without trying to launch a non-AppImage', async () => {
    h.openPath.mockRejectedValueOnce('Permission denied');
    const deps = makeDeps();
    const out = await openCompletedArtifact(EXE, deps);
    expect(out).toEqual({ ok: false, kind: 'permission', detail: 'Permission denied' });
    expect(deps.launch).not.toHaveBeenCalled();
  });

  it('retries a rejected AppImage through the validated launcher when supported', async () => {
    h.openPath.mockRejectedValueOnce('No application is registered as handling this file');
    const deps = makeDeps({ appImageLaunchSupported: true });
    const out = await openCompletedArtifact(APPIMAGE, deps);
    expect(out.ok).toBe(true);
    expect(deps.launch).toHaveBeenCalledTimes(1);
    expect(deps.launch).toHaveBeenCalledWith({ id: APPIMAGE.id, path: APPIMAGE.path });
  });

  it('keeps the launcher\'s typed rejection when the fallback also fails', async () => {
    h.openPath.mockRejectedValueOnce('no method available');
    h.invoke.mockRejectedValueOnce('open-artifact/id-mismatch');
    const deps = makeDeps({ appImageLaunchSupported: true, launchAppImage: (req) => h.invoke(req) as Promise<void> });
    const out = await openCompletedArtifact(APPIMAGE, deps);
    expect(out).toEqual({ ok: false, kind: 'cross-wired', detail: '' });
  });

  it('never calls the launcher where the platform does not ship it', async () => {
    h.openPath.mockRejectedValueOnce('no handler');
    const deps = makeDeps({ appImageLaunchSupported: false });
    const out = await openCompletedArtifact(APPIMAGE, deps);
    expect(out.ok).toBe(false);
    expect(out.kind).toBe('no-handler');
    expect(deps.launch).not.toHaveBeenCalled();
  });

  it('does not fire the fallback when the OS accepted the AppImage after all', async () => {
    // A desktop WITH an AppImage handler: the OS association wins.
    const deps = makeDeps({ appImageLaunchSupported: true });
    const out = await openCompletedArtifact(APPIMAGE, deps);
    expect(out.ok).toBe(true);
    expect(deps.launch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. revealCompletedArtifact - the reveal chain
// ---------------------------------------------------------------------------

describe('revealCompletedArtifact', () => {
  function makeRevealDeps(over: Partial<ArtifactRevealDeps> = {}): ArtifactRevealDeps {
    return {
      revealItemInDir: h.revealItemInDir,
      openPath: h.openPath,
      dirname: async (p) => p + '/..',
      warn: () => undefined,
      ...over,
    };
  }

  it('reveals the exact file, not its folder', async () => {
    const deps = makeRevealDeps();
    const out = await revealCompletedArtifact(EXE, deps);
    expect(out.ok).toBe(true);
    expect(h.revealItemInDir).toHaveBeenCalledWith(EXE.path);
    expect(h.openPath).not.toHaveBeenCalled();
  });

  it('falls back to the CONTAINING folder when the reveal is refused', async () => {
    h.revealItemInDir.mockRejectedValueOnce('no explorer integration');
    const deps = makeRevealDeps();
    const out = await revealCompletedArtifact(EXE, deps);
    expect(out.ok).toBe(true);
    expect(h.openPath).toHaveBeenCalledWith(EXE.path + '/..');
  });

  it('reports a typed failure when even the folder cannot be opened', async () => {
    h.revealItemInDir.mockRejectedValueOnce('no explorer integration');
    h.openPath.mockRejectedValueOnce('Access is denied');
    const deps = makeRevealDeps();
    const out = await revealCompletedArtifact(EXE, deps);
    expect(out).toEqual({ ok: false, kind: 'permission', detail: 'Access is denied' });
  });
});

// ---------------------------------------------------------------------------
// 4. The provider wiring: single launch, honest toasts, retry, isolation
// ---------------------------------------------------------------------------

async function mountActions(): Promise<DownloadActionsValue> {
  let captured: DownloadActionsValue | null = null;
  function Probe(): null {
    const actions = useDownloadActions();
    captured = actions;
    return null;
  }
  render(
    <I18nProvider>
      <DownloadsProvider>
        <Probe />
      </DownloadsProvider>
    </I18nProvider>
  );
  // The provider resolves its default directory on mount.
  await Promise.resolve();
  if (!captured) throw new Error('actions were not captured');
  return captured;
}

describe('provider openFile/openFolder wiring', () => {
  beforeEach(() => {
    setTauriMode(true);
  });

  it('swallows repeat activation while one launch is pending: exactly ONE native call', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.openPath.mockImplementationOnce(() => gate);

    const actions = await mountActions();
    const first = actions.openFile(EXE);
    // Two more activations while the first native call is in flight.
    const second = await actions.openFile(EXE);
    const third = await actions.openFile(EXE);

    expect(h.openPath).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ ok: false, kind: 'busy' });
    expect(third).toMatchObject({ ok: false, kind: 'busy' });

    release();
    await expect(first).resolves.toMatchObject({ ok: true });

    // The busy state cleared: a later activation reaches the boundary again.
    await actions.openFile(EXE);
    expect(h.openPath).toHaveBeenCalledTimes(2);
  });

  it('never toasts on the busy path and never on success', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.openPath.mockImplementationOnce(() => gate);

    const actions = await mountActions();
    const first = actions.openFile(EXE);
    await actions.openFile(EXE); // ignored: busy
    release();
    await first;

    expect(h.toastError).not.toHaveBeenCalled();
  });

  it('surfaces a rejection honestly: generic title, classified description, retryable', async () => {
    h.openPath.mockRejectedValueOnce('Permission denied');

    const actions = await mountActions();
    const out = await actions.openFile(EXE);

    expect(out.ok).toBe(false);
    expect(h.toastError).toHaveBeenCalledTimes(1);
    const [title, opts] = h.toastError.mock.calls[0];
    expect(title).toBe('Could not open the file');
    expect(opts).toMatchObject({ description: 'The system refused access to the file.' });

    // The failure did NOT stick: an immediate retry reaches the boundary.
    await actions.openFile(EXE);
    expect(h.openPath).toHaveBeenCalledTimes(2);
  });

  it('refuses an empty completion path without touching the boundary', async () => {
    const actions = await mountActions();
    const out = await actions.openFile({ ...EXE, path: '' });
    expect(out).toMatchObject({ ok: false, kind: 'missing' });
    expect(h.openPath).not.toHaveBeenCalled();
  });

  it('keeps concurrent downloads isolated: each activation carries its own path', async () => {
    const actions = await mountActions();
    const a: CompletedArtifactRef = { ...EXE, id: 1, path: '/dl/first (1).exe', name: 'same name.exe' };
    const b: CompletedArtifactRef = { ...EXE, id: 2, path: '/dl/second (1).exe', name: 'same name.exe' };

    // Same display name, different files, activated while both are pending.
    await Promise.all([actions.openFile(a), actions.openFile(b)]);

    expect(h.openPath).toHaveBeenCalledTimes(2);
    expect(h.openPath).toHaveBeenNthCalledWith(1, a.path);
    expect(h.openPath).toHaveBeenNthCalledWith(2, b.path);
  });

  it('routes a rejected desktop-Linux AppImage through the launch command and stays honest on failure', async () => {
    // The provider computes the platform at render: pretend desktop Linux.
    const original = navigator.userAgent;
    Object.defineProperty(window.navigator, 'userAgent', {
      value: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 jsdom',
      configurable: true,
    });
    try {
      h.openPath.mockRejectedValueOnce('no method available');
      // Dispatch by command: the provider's mount-time directory lookup
      // must not consume the launcher's rejection, and the open itself
      // flows through the validated open command before the fallback.
      h.invoke.mockImplementation(async (cmd?: unknown, args?: unknown) => {
        const c = typeof cmd === 'string' ? cmd : '';
        const a = (args ?? {}) as Record<string, unknown>;
        if (c === 'open_downloaded_file') return h.openPath(String(a.path ?? ''));
        if (c === 'reveal_download_file') return h.revealItemInDir(String(a.path ?? ''));
        if (c === 'open_download_dir') return h.openPath(String(a.dir ?? ''));
        if (c === 'launch_app_image_artifact') throw 'open-artifact/not-registered';
        if (c === 'default_download_dir') return '/home/test/Downloads';
        return null;
      });

      const actions = await mountActions();
      const out = await actions.openFile(APPIMAGE);

      expect(h.invoke).toHaveBeenCalledWith('launch_app_image_artifact', {
        id: APPIMAGE.id,
        path: APPIMAGE.path,
      });
      expect(out).toMatchObject({ ok: false, kind: 'unregistered' });
      expect(h.toastError).toHaveBeenCalledWith('Could not open the file', {
        description: 'Only a download completed in this session can be launched directly. Use Show in folder and start it from there.',
      });
    } finally {
      Object.defineProperty(window.navigator, 'userAgent', {
        value: original,
        configurable: true,
      });
    }
  });

  it('does not offer the launch fallback on Android; the adapter serves the open, the reveal chain stays', async () => {
    const original = navigator.userAgent;
    Object.defineProperty(window.navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile Safari/537.36',
      configurable: true,
    });
    try {
      // Since the Android adapter landed (open_downloaded_file below the
      // same boundary), an Android openPath dep call does NOT reach the
      // opener plugin at all: the adapter command resolves the path
      // against the session registry and serves the open (APK -> system
      // installer, everything else -> viewer/share). The opener plugin's
      // rejection therefore never happens on the happy path.
      const actions = await mountActions();
      const out = await actions.openFile(APPIMAGE);
      expect(out).toMatchObject({ ok: true });
      expect(h.invoke).toHaveBeenCalledWith('open_downloaded_file', { path: APPIMAGE.path });
      // The webview's only open identity is the validated command; the
      // opener-plugin binding no longer exists on any platform.
      expect(h.invoke.mock.calls.every(([c]) => c !== 'plugin:opener|open_path')).toBe(true);

      // No launch command on Android, ever: the AppImage launcher stays a
      // desktop-Linux capability even when the open fails there.
      h.invoke.mockRejectedValueOnce('open-artifact/not-registered');
      const refused = await actions.openFile(APPIMAGE);
      expect(refused).toMatchObject({ ok: false, kind: 'unregistered' });
      expect(h.invoke).not.toHaveBeenCalledWith('launch_app_image_artifact', expect.anything());

      // The reveal chain stays intact for non-APK artifacts where a
      // viewer exists (the row itself hides Show in folder on Android).
      const revealOut = await actions.openFolder({ ...EXE, id: 3 });
      expect(revealOut.ok).toBe(true);
      expect(h.revealItemInDir).toHaveBeenCalledWith(EXE.path);
    } finally {
      Object.defineProperty(window.navigator, 'userAgent', {
        value: original,
        configurable: true,
      });
    }
  });
});
