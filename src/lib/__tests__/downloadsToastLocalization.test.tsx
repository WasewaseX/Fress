// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
// @vitest-environment jsdom
//
// The downloads context fires toasts for every meaningful transfer-state
// change (verified/unverified completion, checksum failure, reconnect,
// cancelled, resume-invalid, failure, folder operations). Those toasts are
// the audible surface of the download UX, so they must follow the active
// language - this pins the German wording through the real event pipeline
// (mocked Rust events -> provider listeners -> sonner).

import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../i18n';
import { DownloadsProvider } from '../downloads';

const h = vi.hoisted(() => {
  const listeners = new Map<string, Array<(e: { payload: unknown }) => void>>();
  const state = { nextId: 0, dir: '/downloads' };
  return { listeners, state };
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === 'default_download_dir') return h.state.dir;
    if (cmd === 'start_download') {
      h.state.nextId += 1;
      return h.state.nextId;
    }
    return null;
  }),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, cb: (e: { payload: unknown }) => void) => {
    const queue = h.listeners.get(name) ?? [];
    queue.push(cb);
    h.listeners.set(name, queue);
    return () => undefined;
  }),
}));

vi.mock('@tauri-apps/api/path', () => ({ dirname: vi.fn(async (p: string) => p) }));

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: toastMock }));

function emit(name: string, payload: unknown): void {
  const handlers = h.listeners.get(name) ?? [];
  expect(handlers.length, `no listener captured for ${name}`).toBeGreaterThan(0);
  for (const handler of handlers) handler({ payload });
}

function setTauriMode(on: boolean): void {
  const w = window as unknown as Record<string, unknown>;
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

/** Renders the provider under the German locale. */
function mountGerman(): void {
  window.localStorage.setItem('fress.lang', 'de');
  render(
    <I18nProvider>
      <DownloadsProvider>
        <div data-testid="child" />
      </DownloadsProvider>
    </I18nProvider>
  );
}

beforeEach(() => {
  h.listeners.clear();
  h.state.nextId = 0;
  toastMock.success.mockClear();
  toastMock.info.mockClear();
  toastMock.error.mockClear();
  toastMock.warning.mockClear();
  window.localStorage.clear();
  setTauriMode(true);
});

afterEach(() => {
  cleanup();
  setTauriMode(false);
  window.localStorage.clear();
});

describe('downloads context toasts follow the active language (de)', () => {
  it('announces a verified completion with the checksum sentence', () => {
    mountGerman();
    emit('download-complete', { id: 1, path: '/downloads/app.exe', bytes: 10, sha256: 'abc', verified: true });
    expect(toastMock.success).toHaveBeenCalledTimes(1);
    const [title, opts] = toastMock.success.mock.calls[0];
    expect(title).toBe('Download abgeschlossen: Datei');
    expect(opts.description).toBe('SHA-256 gegen die veröffentlichte Prüfsumme verifiziert. /downloads/app.exe');
  });

  it('announces an unverified completion without the checksum claim', () => {
    mountGerman();
    emit('download-complete', { id: 1, path: '/downloads/app.exe', bytes: 10, sha256: 'abc' });
    const [title, opts] = toastMock.success.mock.calls[0];
    expect(title).toBe('Download abgeschlossen: Datei');
    // No verification claim when no trusted hash matched.
    expect(String(opts.description)).not.toContain('SHA-256');
    expect(opts.description).toBe('/downloads/app.exe');
  });

  it('keeps the reconnect note quiet and translated', () => {
    mountGerman();
    emit('download-retrying', { id: 1, attempt: 2, message: 'connection dropped' });
    expect(toastMock.info).toHaveBeenCalledTimes(1);
    const [title, opts] = toastMock.info.mock.calls[0];
    expect(title).toBe('Neuverbindung von Download (Versuch 2)');
    expect(opts.description).toBe('Die Verbindung wurde unterbrochen. Es geht dort weiter, wo sie abriss.');
  });

  it('maps the checksum failure to the integrity toast', () => {
    mountGerman();
    emit('download-error', { id: 1, message: 'digest mismatch', kind: 'checksum' });
    expect(toastMock.error).toHaveBeenCalledTimes(1);
    const [title] = toastMock.error.mock.calls[0];
    expect(title).toBe('Integritätsprüfung fehlgeschlagen');
  });

  it('maps resume-invalid to its own honest toast (not generic failure)', () => {
    mountGerman();
    emit('download-error', { id: 1, message: 'invalid range', kind: 'resume-invalid' });
    const [title] = toastMock.error.mock.calls[0];
    expect(title).toBe('Fortsetzen nicht möglich');
  });

  it('uses the Resume pointer for a cancelled transfer', () => {
    mountGerman();
    emit('download-error', { id: 1, message: 'Cancelled' });
    expect(toastMock.info).toHaveBeenCalledTimes(1);
    expect(toastMock.info.mock.calls[0][0]).toBe('Download pausiert. Verwenden Sie „Fortsetzen“, um weiterzumachen.');
  });

  it('announces a plain failure through the generic error toast', () => {
    mountGerman();
    emit('download-error', { id: 1, message: 'HTTP 500' });
    const [title, opts] = toastMock.error.mock.calls[0];
    expect(title).toBe('Download fehlgeschlagen');
    expect(opts.description).toBe('HTTP 500');
  });
});

describe('downloads start-path toasts follow the active language (de)', () => {
  it('rejects a non-direct link in German', async () => {
    mountGerman();
    const { useDownloadActions } = await import('../downloads');
    let actions: ReturnType<typeof useDownloadActions> | null = null;
    const Probe: React.FC = () => {
      actions = useDownloadActions();
      return null;
    };
    cleanup();
    render(
      <I18nProvider>
        <DownloadsProvider>
          <Probe />
        </DownloadsProvider>
      </I18nProvider>
    );
    await actions!.startDownload('ftp://example.com/app.exe');
    expect(toastMock.error).toHaveBeenCalledTimes(1);
    expect(toastMock.error.mock.calls[0][0]).toBe('Dieser Link ist kein direkter Download');
  });
});
