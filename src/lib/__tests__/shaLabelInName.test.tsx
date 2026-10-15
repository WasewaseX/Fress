// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
// @vitest-environment jsdom
//
// The download panel's SHA-256 row must satisfy WCAG 2.5.3 Label in Name:
// the visible text IS the hash, so the accessible name has to CONTAIN that
// visible text. The old aria-label ("Copy SHA-256 hash: {name}") omitted the
// hash entirely - axe: label-content-name-mismatch. The name now comes from
// content: an sr-only intent prefix followed by the visible hash.

import { cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

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

const SEED = [
  {
    url: 'https://example.com/fress/Fress_setup.exe',
    name: 'Fress_setup.exe',
    dir: '/downloads',
    bytes: 100,
    total: 100,
    status: 'completed',
    path: '/downloads/Fress_setup.exe',
    sha256: 'a'.repeat(64),
    verified: true,
    startedAt: 1,
  },
];

describe('download SHA row label-in-name', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    localStorage.setItem('fress.downloadItems.v1', JSON.stringify(SEED));
  });

  afterEach(() => {
    cleanup();
    vi.resetModules();
  });

  it('the SHA button names itself by content: intent prefix + the visible hash', async () => {
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
    });
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

    const hash = 'a'.repeat(64);
    // The accessible name (from content) starts with the intent and file
    // name, then contains the full visible hash text.
    const btn = screen.getByRole('button', {
      name: new RegExp(`^Copy SHA-256 hash: Fress_setup\\.exe\\. SHA-256: ${hash}`),
    }) as HTMLButtonElement;
    // No aria-label fighting the content: the name IS the content.
    expect(btn.getAttribute('aria-label')).toBeNull();
    // The sr-only prefix carries intent + file name ahead of the hash.
    const prefix = btn.querySelector('.sr-only') as HTMLSpanElement;
    expect(prefix.textContent).toBe('Copy SHA-256 hash: Fress_setup.exe. ');
    // The visible hash text is part of the name (Label in Name holds).
    expect(btn.textContent).toContain(`SHA-256: ${hash}`);
  });

  it('copying still shows honest localized feedback inside the same button', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
      clipboard: { writeText },
    });
    const { I18nProvider } = await import('../../lib/i18n');
    const { DownloadsProvider } = await import('../../lib/downloads');
    const { DownloadManager } = await import('../../components/DownloadManager');
    const { fireEvent } = await import('@testing-library/react');
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
    const btn = screen.getByRole('button', { name: /Copy SHA-256 hash: Fress_setup\.exe/ });
    writeText.mockResolvedValueOnce(undefined);
    fireEvent.click(btn);
    // The flash appears twice (button feedback + polite live region).
    const flashes = await screen.findAllByText('Copied');
    expect(flashes.length).toBeGreaterThanOrEqual(2);
    // The visible hash remains inside the name with the feedback appended.
    expect(btn.textContent).toContain(`SHA-256: ${'a'.repeat(64)}`);
    expect(btn.textContent).toContain('Copied');
  });
});
