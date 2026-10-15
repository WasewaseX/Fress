// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { I18nProvider } from '../i18n';
import { DownloadsProvider, useDownloadActions, useDownloadSummary } from '../downloads';

/**
 * The open/reveal wiring contract: the download panel's "Open file" /
 * "Show in folder" / "Open folder" actions go through the NATIVE validated
 * boundary (open_download_file / reveal_download_file / record_download_directory),
 * never through the opener plugin's unrestricted openPath / revealItemInDir
 * bindings (those capability grants were removed - see
 * docs/security/tauri-security.md and the Rust download_open module).
 */

const h = vi.hoisted(() => ({
  calls: [] as Array<{ cmd: string; args: Record<string, unknown> }>,
  fail: new Set<string>(),
  listeners: new Map<string, (e: { payload: unknown }) => void>(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    h.calls.push({ cmd, args: args ?? {} });
    if (h.fail.has(cmd)) throw new Error('boundary refused');
    if (cmd === 'default_download_dir') return '/downloads';
    return null;
  }),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, handler: (e: { payload: unknown }) => void) => {
    h.listeners.set(name, handler);
    return () => undefined;
  }),
}));

vi.mock('@tauri-apps/api/path', () => ({
  dirname: vi.fn(async (p: string) => p.split('/').slice(0, -1).join('/')),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => '/picked/dir'),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), info: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

function setTauriMode(on: boolean): void {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

const callsFor = (cmd: string) => h.calls.filter((c) => c.cmd === cmd);

function Probe() {
  const { openFile, openFolder, chooseFolder } = useDownloadActions();
  const { downloadDir } = useDownloadSummary();
  return (
    <div>
      <button type="button" onClick={() => openFile('/downloads/app.apk')}>
        open-file
      </button>
      <button type="button" onClick={() => openFolder('/downloads/app.apk')}>
        show-in-folder
      </button>
      <button type="button" onClick={() => openFolder()}>
        open-folder
      </button>
      <button type="button" onClick={() => void chooseFolder()}>
        choose-folder
      </button>
      <span data-testid="dir">{downloadDir ?? 'none'}</span>
    </div>
  );
}

describe('the native open/reveal boundary wiring', () => {
  beforeEach(() => {
    h.calls.length = 0;
    h.fail.clear();
    h.listeners.clear();
    setTauriMode(true);
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    setTauriMode(false);
  });

  it('openFile goes through the validated native command, never the opener plugin', async () => {
    render(
      <I18nProvider>
        <DownloadsProvider>
          <Probe />
        </DownloadsProvider>
      </I18nProvider>
    );
    await act(async () => undefined);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'open-file' }));
    });
    const opens = callsFor('open_download_file');
    expect(opens).toHaveLength(1);
    expect(opens[0].args).toEqual({ path: '/downloads/app.apk' });
  });

  it('show-in-folder reveals natively and falls back to opening the parent on refusal', async () => {
    render(
      <I18nProvider>
        <DownloadsProvider>
          <Probe />
        </DownloadsProvider>
      </I18nProvider>
    );
    await act(async () => undefined);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'show-in-folder' }));
    });
    await act(async () => undefined);
    expect(callsFor('reveal_download_file')).toHaveLength(1);
    // Admitted: no fallback ran.
    expect(callsFor('open_download_file')).toHaveLength(0);

    // The boundary refuses (path outside download folders): the fallback
    // opens the file's CONTAINING folder through the same boundary.
    h.fail.add('reveal_download_file');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'show-in-folder' }));
    });
    await act(async () => undefined);
    const fallbacks = callsFor('open_download_file');
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0].args).toEqual({ path: '/downloads' });
  });

  it('open-folder without a path opens the current download dir through the boundary', async () => {
    render(
      <I18nProvider>
        <DownloadsProvider>
          <Probe />
        </DownloadsProvider>
      </I18nProvider>
    );
    await act(async () => undefined);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'open-folder' }));
    });
    const opens = callsFor('open_download_file');
    expect(opens).toHaveLength(1);
    expect(typeof opens[0].args.path).toBe('string');
    expect(opens[0].args.path).not.toBe('');
  });

  it('choosing a folder records it for admission before the first download lands', async () => {
    render(
      <I18nProvider>
        <DownloadsProvider>
          <Probe />
        </DownloadsProvider>
      </I18nProvider>
    );
    await act(async () => undefined);
    h.calls.length = 0;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'choose-folder' }));
    });
    await act(async () => undefined);
    const records = callsFor('record_download_directory');
    expect(records).toHaveLength(1);
    expect(records[0].args).toEqual({ dir: '/picked/dir' });
  });

  it('in a plain browser tab nothing is invoked (no Tauri bridge)', async () => {
    setTauriMode(false);
    render(
      <I18nProvider>
        <DownloadsProvider>
          <Probe />
        </DownloadsProvider>
      </I18nProvider>
    );
    await act(async () => undefined);
    h.calls.length = 0;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'open-file' }));
      fireEvent.click(screen.getByRole('button', { name: 'show-in-folder' }));
      fireEvent.click(screen.getByRole('button', { name: 'open-folder' }));
    });
    await act(async () => undefined);
    expect(callsFor('open_download_file')).toHaveLength(0);
    expect(callsFor('reveal_download_file')).toHaveLength(0);
  });
});
