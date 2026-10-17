// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
// @vitest-environment jsdom
//
// Download lifecycle contracts (Agent 1): slot accounting, queue promotion,
// and start/cancel/retry state handling, driven through the REAL provider
// with a mocked Tauri bridge (the harness discipline of
// downloadPanelFormatting.test.tsx).
//
// The defect class this suite pins: the frontend learns about a transfer's
// start (the start_download invoke resolving) and its end (a terminal event
// on the event channel) through two independent channels, and Rust emits
// from a spawned task - so a fast-completing transfer can deliver its
// terminal event BEFORE the invoke resolves. The old slot COUNTER decremented
// on the event and incremented after the invoke, so that ordering leaked a
// slot permanently; once three slots had leaked the concurrency gate read
// full with nothing running and the queue stalled forever. The fixes:
//
//   - slot ownership is PER RUST ID (order-proof, idempotent under
//     duplicate terminal events) - tests 1-3;
//   - cancelling a queued row whose entry is mid-promotion marks the row so
//     the pump cancels the transfer the moment its real id is known -
//     test 4;
//   - retry re-sends the WIRE filename hint, never the localized display
//     fallback word (Rust lets a requested name outrank Content-
//     Disposition, so the placeholder word would become the file name) -
//     test 5;
//   - retry refuses live transfers (active rows would be orphaned, queued
//     rows would race the pump) - test 6.

import { act, cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DownloadsProvider, DownloadItem, useDownloadActions, useDownloadItems } from '../downloads';
import { I18nProvider } from '../i18n';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  /** Event name -> registered provider listeners (last one wins). */
  listeners: new Map<string, Array<(e: { payload: unknown }) => void>>(),
  invoke: vi.fn(),
  /** URLs whose start_download stays pending until the test resolves it. */
  deferUrls: new Set<string>(),
  /** Resolvers for the pending starts, keyed by the handed-out id. */
  pending: new Map<number, (v: number) => void>(),
  nextId: 1,
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), info: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

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

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  h.listeners.clear();
  h.deferUrls.clear();
  h.pending.clear();
  h.nextId = 1;
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  h.invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'default_download_dir') return '/downloads';
    if (cmd === 'start_download') {
      const id = h.nextId++;
      const url = args?.url as string | undefined;
      if (url && h.deferUrls.has(url)) {
        return new Promise<number>((resolve) => h.pending.set(id, resolve));
      }
      return id;
    }
    return null;
  });
});

afterEach(() => {
  cleanup();
  h.listeners.clear();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

const tick = (): Promise<void> => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

/** Fires one native event payload at the provider's listener, WITHOUT an
 * act scope - for the tests that must observe state BETWEEN two
 * synchronously-scheduled updates (see test 4). */
function rawEmit(name: string, payload: unknown): void {
  const cbs = h.listeners.get(name);
  if (!cbs || cbs.length === 0) throw new Error(`no listener registered for ${name}`);
  cbs[cbs.length - 1]({ payload });
}

/** Fires one native event payload inside an act scope. */
function emit(name: string, payload: unknown): void {
  act(() => {
    rawEmit(name, payload);
  });
}

function startCalls(): Array<Record<string, unknown>> {
  return h.invoke.mock.calls
    .filter(([cmd]) => cmd === 'start_download')
    .map((call) => call[1] as Record<string, unknown>);
}

function cancelInvokes(): Array<Record<string, unknown>> {
  return h.invoke.mock.calls
    .filter(([cmd]) => cmd === 'cancel_download')
    .map((call) => call[1] as Record<string, unknown>);
}

type Actions = ReturnType<typeof useDownloadActions>;

/** Mounts I18nProvider + DownloadsProvider; captures the actions and the
 * live item list. Returns getters so reads always see the latest commit. */
async function mountProvider(): Promise<{ actions: Actions; items: DownloadItem[] }> {
  let captured: { actions: Actions; items: DownloadItem[] } | null = null;
  function Harness(): null {
    captured = {
      actions: useDownloadActions(),
      items: useDownloadItems().items,
    };
    return null;
  }
  render(
    createElement(I18nProvider, null, createElement(DownloadsProvider, null, createElement(Harness)))
  );
  // The event listeners register asynchronously on mount.
  await act(async () => {
    await tick();
  });
  if (!captured) throw new Error('provider harness was not captured');
  return {
    get actions() {
      return captured!.actions;
    },
    get items() {
      return captured!.items;
    },
  };
}

describe('download slot accounting (per-id, order-proof)', () => {
  it('a completion event that beats the start resolution cannot leak a slot', async () => {
    const p = await mountProvider();
    // A tiny transfer whose completion event lands before the invoke
    // resolves: exactly the timing the pendingEvents buffer exists for.
    h.deferUrls.add('https://example.com/tiny.exe');
    await act(async () => {
      void p.actions.startDownload('https://example.com/tiny.exe', 'tiny.exe');
      await tick();
    });
    emit('download-complete', { id: 1, path: '/downloads/tiny.exe', bytes: 3, sha256: 'aa' });
    await act(async () => {
      h.pending.get(1)?.(1);
      await tick();
    });
    expect(p.items.find((it) => it.id === 1)?.status).toBe('completed');

    // With the leaked counter the gate read one higher than reality and
    // the FOURTH start below would have been queued instead of dispatched.
    for (const n of ['b.exe', 'c.exe', 'd.exe']) {
      await act(async () => {
        await p.actions.startDownload(`https://example.com/${n}`, n);
      });
    }
    expect(startCalls()).toHaveLength(4);
    expect(p.items.some((it) => it.status === 'queued')).toBe(false);
    expect(p.items.find((it) => it.name === 'd.exe')?.status).toBe('active');
  });

  it('three real transfers fill the gate; the queued fourth promotes with its original payload', async () => {
    const p = await mountProvider();
    for (const n of ['a.exe', 'b.exe', 'c.exe']) {
      await act(async () => {
        await p.actions.startDownload(`https://example.com/${n}`, n);
      });
    }
    expect(startCalls()).toHaveLength(3);

    await act(async () => {
      await p.actions.startDownload('https://example.com/d.exe', 'd.exe', {
        resume: true,
        dir: '/somewhere',
        expectedSha256: 'cafe12',
      });
    });
    expect(startCalls()).toHaveLength(3); // gated, waiting in line
    expect(p.items.find((it) => it.status === 'queued')).toBeTruthy();

    emit('download-complete', { id: 1, path: '/downloads/a.exe', bytes: 10, sha256: 'bb' });
    await act(async () => {
      await tick();
    });
    const starts = startCalls();
    expect(starts).toHaveLength(4);
    expect(starts[3]).toEqual({
      url: 'https://example.com/d.exe',
      filename: 'd.exe',
      directory: '/somewhere',
      expectedSha256: 'cafe12',
      expectedSha512: null,
      resume: true,
    });
    expect(p.items.some((it) => it.status === 'queued')).toBe(false);
    expect(p.items.find((it) => it.name === 'd.exe')?.status).toBe('active');
  });

  it('a repeated terminal event cannot free a second slot', async () => {
    const p = await mountProvider();
    await act(async () => {
      await p.actions.startDownload('https://example.com/a.exe', 'a.exe');
    });
    emit('download-complete', { id: 1, path: '/downloads/a.exe', bytes: 10, sha256: 'bb' });
    // Defensive duplicate: the engine emits one terminal per id, but the
    // gate must not depend on that courtesy.
    emit('download-complete', { id: 1, path: '/downloads/a.exe', bytes: 10, sha256: 'bb' });
    await act(async () => {
      await tick();
    });
    for (const n of ['b.exe', 'c.exe', 'd.exe']) {
      await act(async () => {
        await p.actions.startDownload(`https://example.com/${n}`, n);
      });
    }
    expect(startCalls()).toHaveLength(4);
    expect(p.items.some((it) => it.status === 'queued')).toBe(false);
  });
});

describe('cancel during promotion', () => {
  it('cancelling a queued row mid-promotion cancels the transfer it was becoming', async () => {
    const p = await mountProvider();
    for (const n of ['a.exe', 'b.exe', 'c.exe']) {
      await act(async () => {
        await p.actions.startDownload(`https://example.com/${n}`, n);
      });
    }
    h.deferUrls.add('https://example.com/d.exe');
    await act(async () => {
      void p.actions.startDownload('https://example.com/d.exe', 'd.exe');
      await tick();
    });
    const queuedRow = p.items.find((it) => it.status === 'queued');
    expect(queuedRow).toBeTruthy();
    const localId = queuedRow!.id;

    // One synchronous window: the completion frees a slot, the pump shifts
    // the queued entry and suspends inside the deferred start - and the
    // user's cancel lands while the row still reads 'queued'. The commit
    // has not happened yet, so the cancel must find the row exactly here.
    act(() => {
      rawEmit('download-complete', { id: 1, path: '/downloads/a.exe', bytes: 10, sha256: 'bb' });
      p.actions.cancel(localId);
    });

    // The start resolves; the pump must cancel the transfer it just
    // started instead of letting a "cancelled" download run on. The first
    // tick lets the suspended pump reach the deferred start invoke - only
    // then does the pending resolver exist.
    await act(async () => {
      await tick();
      h.pending.get(4)?.(4);
      await tick();
    });
    const cancels = cancelInvokes();
    expect(cancels).toHaveLength(1);
    expect(cancels[0]).toEqual({ id: 4 });

    // The engine's terminal event moves the row into the cancelled state
    // the user asked for.
    emit('download-error', { id: 4, message: 'Cancelled' });
    await act(async () => {
      await tick();
    });
    expect(p.items.find((it) => it.url === 'https://example.com/d.exe')?.status).toBe('cancelled');
  });
});

describe('retry state handling', () => {
  it('retry re-sends the wire filename hint, never the localized display fallback', async () => {
    const p = await mountProvider();
    // No name guessable from this URL: Rust derived the real name itself,
    // the panel displays the localized fallback word for it.
    await act(async () => {
      await p.actions.startDownload('https://example.com/get/', undefined);
    });
    emit('download-error', { id: 1, message: 'connection reset' });
    await act(async () => {
      await tick();
    });
    expect(p.items.find((it) => it.id === 1)?.status).toBe('error');

    await act(async () => {
      p.actions.retry(1);
      await tick();
    });
    const starts = startCalls();
    expect(starts).toHaveLength(2);
    // The retried start carries NO filename: Rust re-derives the name from
    // the response. The old code passed the display fallback word here,
    // which ( outranking Content-Disposition on the Rust side ) saved the
    // file under a literal "Download".
    expect(starts[1].filename).toBeNull();

    // A real hint survives verbatim.
    await act(async () => {
      await p.actions.startDownload('https://example.com/x/Setup.exe', 'Setup.exe');
    });
    emit('download-error', { id: 3, message: 'connection reset' });
    await act(async () => {
      await tick();
    });
    await act(async () => {
      p.actions.retry(3);
      await tick();
    });
    const after = startCalls();
    expect(after).toHaveLength(4);
    expect(after[3].filename).toBe('Setup.exe');
  });

  it('retry refuses live transfers: active and queued rows stay exactly where they are', async () => {
    const p = await mountProvider();
    for (const n of ['one.exe', 'two.exe', 'three.exe']) {
      h.deferUrls.add(`https://example.com/${n}`);
      await act(async () => {
        void p.actions.startDownload(`https://example.com/${n}`, n);
        await tick();
      });
    }
    // The panel rows appear when the starts resolve; the transfers stay
    // live (no terminal event), holding all three slots.
    await act(async () => {
      h.pending.get(1)?.(1);
      h.pending.get(2)?.(2);
      h.pending.get(3)?.(3);
      await tick();
    });
    await act(async () => {
      await p.actions.startDownload('https://example.com/next.exe', 'next.exe');
    });
    const activeRow = p.items.find((it) => it.name === 'one.exe');
    const queuedRow = p.items.find((it) => it.status === 'queued');
    expect(activeRow?.status).toBe('active');
    expect(queuedRow).toBeTruthy();

    await act(async () => {
      p.actions.retry(activeRow!.id);
      p.actions.retry(queuedRow!.id);
      await tick();
    });
    expect(startCalls()).toHaveLength(3); // no extra starts
    expect(p.items.find((it) => it.id === activeRow!.id)?.status).toBe('active');
    expect(p.items.find((it) => it.id === queuedRow!.id)?.status).toBe('queued');
  });
});
