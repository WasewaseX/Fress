// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
// @vitest-environment jsdom
//
// Download-panel formatting contracts (Agent 6 regression pins).
//
// Each test here pins a corrected UI-contract defect so it cannot quietly
// come back:
//
//   1. Toast/announcement interpolation is LITERAL. The old
//      `template.replace('{x}', value)` interpreted `$&`-style replacement
//      patterns inside the VALUE, so a name or Windows path like
//      "a$&b.exe" corrupted the very toast announcing it, and a token used
//      twice in a translation was only replaced once. formatMessage
//      (split/join) inserts the value literally and replaces every token.
//      The expectations below are built with an INLINE split/join - not
//      the production helper and not String.replace - so a regression of
//      either shape fails the comparison.
//
//   2. 'downloads.speed' is LIVE UI, not a dead key: the active row's
//      speed readout carries the localized label for assistive tech
//      (sr-only; the visible unit string is locale-neutral).
//
//   3. The error row's icon margin is the LOGICAL `me-1` token, so the
//      gutter flips correctly in RTL (Persian) instead of pinning the
//      icon to the physical right edge.
//
// The tests drive the REAL provider path (start_download invoke resolves
// an id, native events land through the mocked listen bridge) - the same
// harness discipline as artifactOpen.test.tsx.

import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DownloadsProvider, useDownloadActions } from '../downloads';
import { I18nProvider, DICTS } from '../i18n';
import { DownloadManager } from '../../components/DownloadManager';

const h = vi.hoisted(() => {
  const listeners = new Map<string, Array<(e: { payload: unknown }) => void>>();
  return {
    listeners,
    invoke: vi.fn(async (...args: unknown[]) => {
      const cmd = args[0] as string;
      if (cmd === 'start_download') return 11;
      return null;
    }),
    toastError: vi.fn(),
    toastSuccess: vi.fn(),
    toastInfo: vi.fn(),
  };
});

vi.mock('@tauri-apps/api/core', () => ({ invoke: h.invoke }));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, cb: (e: { payload: unknown }) => void) => {
    const queue = h.listeners.get(name) ?? [];
    queue.push(cb);
    h.listeners.set(name, queue);
    return () => undefined;
  }),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('@tauri-apps/plugin-opener', () => ({
  openPath: vi.fn(async () => undefined),
  revealItemInDir: vi.fn(async () => undefined),
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

/** Fires one native event payload at the provider's registered listener. */
function emit(name: string, payload: unknown): void {
  const cbs = h.listeners.get(name) ?? [];
  if (cbs.length === 0) throw new Error(`no listener registered for ${name}`);
  act(() => {
    cbs[cbs.length - 1]?.({ payload });
  });
}

/** Literal token interpolation for EXPECTATIONS only: the exact semantics
 * the production formatMessage must deliver - every value inserted
 * LITERALLY, every occurrence replaced, and NO pass ever re-scans text
 * inserted for another token (the reconnecting-toast case below pins that:
 * a file named "x{attempt}y$&.exe" must keep its literal "{attempt}").
 * The sentinel two-phase shape keeps the oracle independent of the
 * implementation while forbidding the sequential re-scan. */
function literal(template: string, values: Record<string, string | number>): string {
  let out = template;
  const stashed: Array<[string, string]> = [];
  for (const [token, value] of Object.entries(values)) {
    const sentinel = `\u0000${token}\u0000`;
    out = out.split(`{${token}}`).join(sentinel);
    stashed.push([sentinel, String(value)]);
  }
  for (const [sentinel, value] of stashed) {
    out = out.split(sentinel).join(value);
  }
  return out;
}

/** Mounts I18nProvider + DownloadsProvider (+ optional manager), captures
 * the start action, returns a render container. */
function mountTree(withManager: boolean): { container: HTMLElement; start: (url: string, name?: string) => Promise<void> } {
  let captured: ((url: string, name?: string) => Promise<void>) | null = null;
  function Trigger(): null {
    const { startDownload } = useDownloadActions();
    captured = startDownload as unknown as (url: string, name?: string) => Promise<void>;
    return null;
  }
  const { container } = render(
    <I18nProvider>
      <DownloadsProvider>
        <Trigger />
        {withManager ? <DownloadManager isOpen onClose={() => undefined} /> : null}
      </DownloadsProvider>
    </I18nProvider>
  );
  if (!captured) throw new Error('start action was not captured');
  return { container, start: captured };
}

async function startDownload(start: (url: string, name?: string) => Promise<void>, url: string, name: string): Promise<void> {
  await act(async () => {
    await start(url, name);
  });
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  h.invoke.mockImplementation(async (...args: unknown[]) => {
    const cmd = args[0] as string;
    if (cmd === 'start_download') return 11;
    return null;
  });
  setTauriMode(false);
  window.localStorage.clear();
});

// ---------------------------------------------------------------------------
// 1. Toast interpolation is literal (formatMessage, not .replace)
// ---------------------------------------------------------------------------

describe('completion/reconnect toast interpolation', () => {
  beforeEach(() => {
    setTauriMode(true);
  });

  it('inserts a hostile name and a Windows path LITERALLY into the verified completion toast', async () => {
    // `$&` expands to the matched token, `$$` to a literal `$` - all under
    // the old .replace path, none of it may survive into the render.
    const HOSTILE_NAME = 'a$&b$$c.exe';
    const HOSTILE_PATH = 'C:\\Users\\test\\Downloads\\$&dir (1)\\final.exe';
    const { start } = mountTree(false);
    await startDownload(start, 'https://example.com/hostile.exe', HOSTILE_NAME);

    emit('download-complete', {
      id: 11,
      path: HOSTILE_PATH,
      bytes: 2048,
      sha256: 'a'.repeat(64),
      verified: true,
    });

    expect(h.toastSuccess).toHaveBeenCalledTimes(1);
    const [title, opts] = h.toastSuccess.mock.calls[0];
    // The name landed byte-exact: every token gone, no $& expansion, no
    // re-inserted {name} (the exact corruption the old code produced).
    expect(title).toBe(literal(DICTS.en['downloads.toast.completedTitle'], { name: HOSTILE_NAME }));
    expect(String(title)).not.toContain('{name}');
    const description = (opts as { description?: string }).description ?? '';
    expect(description).toBe(literal(DICTS.en['downloads.toast.verifiedDesc'], { path: HOSTILE_PATH }));
    expect(description).toContain('$&dir (1)');
    expect(description).not.toContain('{path}');
  });

  it('interpolates the reconnecting toast without letting the name rewrite the attempt token', async () => {
    // Chained .replace would have rewritten the {attempt} INSIDE the
    // substituted name (it precedes the template's own token) and the
    // name's `$&` would have re-inserted {name}; neither may happen.
    const HOSTILE_NAME = 'x{attempt}y$&.exe';
    const { start } = mountTree(false);
    await startDownload(start, 'https://example.com/flaky.exe', HOSTILE_NAME);

    // The start itself emits a "Download started" info toast; isolate the
    // reconnecting toast under test.
    h.toastInfo.mockClear();
    emit('download-retrying', { id: 11, attempt: 3, message: 'connection reset' });

    expect(h.toastInfo).toHaveBeenCalledTimes(1);
    const [title] = h.toastInfo.mock.calls[0];
    // The name survives VERBATIM - its own "{attempt}" text is user data,
    // not a token of this call (the old sequential oracle asserted the
    // corrupted "x3y$&.exe", contradicting this test's stated intent).
    expect(String(title)).toContain('x{attempt}y$&.exe');
    expect(title).toBe(
      literal(DICTS.en['downloads.toast.reconnectingTitle'], { name: HOSTILE_NAME, attempt: 3 })
    );
  });
});

// ---------------------------------------------------------------------------
// 2/3. Panel rendering: live speed label, announcement, logical icon margin
// ---------------------------------------------------------------------------

describe('DownloadManager formatting contracts', () => {
  const PROGRESS = {
    id: 11,
    downloaded: 4_194_304,
    total: 25_165_824,
    speed_bps: 4_194_304,
    eta_secs: 3,
  };

  function speedReadout(container: HTMLElement): { wrapper: HTMLElement; label: string; value: string } | null {
    const wrapper = Array.from(container.querySelectorAll('span')).find(
      (el) => el.querySelector(':scope > .sr-only') !== null && /\d(\.\d)? [KMG]?B\/s/.test(el.textContent ?? '')
    );
    if (!wrapper) return null;
    const label = wrapper.querySelector(':scope > .sr-only')!.textContent ?? '';
    const value = (wrapper.textContent ?? '').slice(label.length);
    return { wrapper, label, value };
  }

  it("renders the active row's speed under the localized 'Speed' label (en), value unchanged", async () => {
    setTauriMode(true);
    const { container, start } = mountTree(true);
    await startDownload(start, 'https://example.com/tool.zip', 'tool-1.0.zip');
    emit('download-progress', PROGRESS);

    const readout = speedReadout(container);
    expect(readout).not.toBeNull();
    // The localized key is LIVE: it names the readout for assistive tech
    // (sr-only), and the visible value stays the locale-neutral unit string.
    expect(readout!.label).toBe('Speed: ');
    expect(readout!.value).toBe('4.0 MB/s');
  });

  it("renders the Persian 'Speed' label when fa is the active language", async () => {
    setTauriMode(true);
    window.localStorage.setItem('fress.lang', 'fa');
    const { container, start } = mountTree(true);
    await startDownload(start, 'https://example.com/tool.zip', 'tool-1.0.zip');
    emit('download-progress', PROGRESS);

    const readout = speedReadout(container);
    expect(readout).not.toBeNull();
    expect(readout!.label).toBe('سرعت: ');
    expect(readout!.value).toBe('4.0 MB/s');
  });

  it('keeps the aria-live announcement interpolating through formatMessage', async () => {
    setTauriMode(true);
    const { container, start } = mountTree(true);
    await startDownload(start, 'https://example.com/tool.zip', 'tool-1.0.zip');

    const region = container.querySelectorAll('[role="status"]')[0];
    expect(region.textContent).toBe('Downloads: 1 downloading');
  });

  it('uses the logical me-1 margin (never mr-1) on the error-row icon for RTL correctness', async () => {
    setTauriMode(true);
    const { container, start } = mountTree(true);
    await startDownload(start, 'https://example.com/tool.zip', 'tool-1.0.zip');
    emit('download-error', { id: 11, message: 'network dropped' });

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    const icon = alert!.querySelector('svg');
    expect(icon).not.toBeNull();
    expect(icon!.getAttribute('class')).toContain('me-1');
    expect(icon!.getAttribute('class')).not.toContain('mr-1');
  });
});
