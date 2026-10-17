// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
// React Profiler measurement for the download-state subscription split.
//
// Scenario (identical for the before/after numbers recorded in the PR):
//   500 catalog cards + one live download. The Profiler counts every commit
//   inside the grid subtree while download events fire.
//
// Before the split, every card consumed the aggregate downloads context and
// scanned the item list, so each progress event committed all 500 cards.
// After the split, cards subscribe through useSyncExternalStore with the
// per-app boolean as the snapshot, so ten progress events commit ZERO
// cards, a start/finish commits only the one matching card, and non-
// matching cards never rerender at all.

// @vitest-environment jsdom

import { Profiler, act } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppItem } from '../../types';
import { AppCard } from '../../components/AppCard';
import { I18nProvider } from '../i18n';
import {
  DownloadsProvider,
  useDownloadItems,
  useDownloads,
} from '../downloads';
import { DOWNLOAD_ITEMS_KEY } from '../downloadItemsStore';
import type { DownloadItem } from '../downloads';

const h = vi.hoisted(() => {
  const listeners = new Map<string, Array<(e: { payload: unknown }) => void>>();
  const state = { nextId: 0 };
  return { listeners, state };
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === 'default_download_dir') return '/downloads';
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

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), info: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

// Live stars do network fetches on mount; the render-isolation scenario
// must not depend on (or wait for) the network.
vi.mock('../starFetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../starFetch')>();
  return { ...actual, useLiveStars: () => null };
});

/** Pretend the app runs inside Tauri so the provider wires its listeners. */
function setTauriMode(on: boolean): void {
  const w = window as unknown as Record<string, unknown>;
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

/** Fire a captured Rust event at the provider's listeners. */
function emit(name: string, payload: unknown): void {
  const handlers = h.listeners.get(name) ?? [];
  expect(handlers.length, `no listener captured for ${name}`).toBeGreaterThan(0);
  for (const handler of handlers) handler({ payload });
}

function makeApps(n: number): AppItem[] {
  const template: AppItem = {
    id: 'template',
    name: 'Template App',
    tagline: 'A template app used by the render-isolation fixture',
    description: 'Long description',
    whyItsAwesome: 'Why',
    beginnerGuide: 'Guide',
    githubUrl: 'https://github.com/example/template',
    websiteUrl: 'https://example.com',
    category: 'Utilities & System',
    platforms: ['windows', 'linux'],
    license: 'MIT',
    stars: 100,
    isOwnerPick: false,
    isTrendingToday: false,
    tags: ['test'],
    addedAt: '2026-01-01',
  };
  return Array.from({ length: n }, (_, i) => ({
    ...template,
    id: `test-app-${i}`,
    name: `App ${i}`,
  }));
}

const stableProps = {
  isFavorite: false,
  onToggleFavorite: () => undefined,
  onOpenDetail: () => undefined,
};

/** Compat-layer probe: exposes a start button and reports the live items.
 * It deliberately uses useDownloads() - the pre-split aggregate API - to
 * prove the migration path still works. It sits OUTSIDE the Profiler. */
function Probe({ itemsRef }: { itemsRef: { current: DownloadItem[] } }) {
  const { startDownload } = useDownloads();
  const { items } = useDownloadItems();
  itemsRef.current = items;
  return (
    <button
      type="button"
      onClick={() => void startDownload('https://example.com/VLC-3.0.2-win64.exe', 'VLC-3.0.2-win64.exe')}
    >
      start-download
    </button>
  );
}

describe('download state subscriptions (React Profiler, 500-card catalog)', () => {
  let setItemSpy: ReturnType<typeof vi.spyOn>;

  const writesFor = (key: string): string[] =>
    setItemSpy.mock.calls.filter((call: string[]) => call[0] === key).map((call: string[]) => call[1] as string);

  beforeEach(() => {
    h.listeners.clear();
    h.state.nextId = 0;
    setTauriMode(true);
    localStorage.clear();
    // Seed the store so the mount restore dedupes its first flush.
    localStorage.setItem(DOWNLOAD_ITEMS_KEY, '[]');
    setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
  });

  afterEach(() => {
    cleanup(); // vitest has no globals configured: RTL cannot auto-cleanup
    vi.restoreAllMocks();
    setTauriMode(false);
  });

  it('ten progress events commit zero cards and attempt zero storage writes; completion persists promptly', async () => {
    const apps = makeApps(500);
    const onRender = vi.fn();
    const itemsRef: { current: DownloadItem[] } = { current: [] };

    render(
      <I18nProvider>
        <DownloadsProvider>
          <Profiler id="grid" onRender={onRender}>
            <div>
              {apps.map((app) => (
                <AppCard key={app.id} app={app} {...stableProps} />
              ))}
            </div>
          </Profiler>
          <Probe itemsRef={itemsRef} />
        </DownloadsProvider>
      </I18nProvider>
    );

    // Let mount-time work (default_download_dir) settle, then open the
    // measurement window.
    await act(async () => undefined);
    onRender.mockClear();
    setItemSpy.mockClear();

    // Start one transfer through the compat layer (useDownloads). No
    // fixture card matches "VLC", so not one card should flip status.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'start-download' }));
    });
    await act(async () => undefined);

    expect(itemsRef.current.some((it) => it.status === 'active')).toBe(true);
    expect(onRender).not.toHaveBeenCalled();

    // Ten rapid progress events.
    for (let i = 1; i <= 10; i++) {
      await act(async () => {
        emit('download-progress', {
          id: 1,
          downloaded: i * 100,
          total: 1000,
          speed_bps: 100_000,
          eta_secs: 9,
        });
      });
    }

    // The events really landed (the manager's data source saw them)...
    expect(itemsRef.current[0]?.bytes).toBe(1000);
    // ...yet not a single card inside the profiler committed, and...
    expect(onRender).not.toHaveBeenCalled();
    // ...not a single durable-state write was attempted: active items are
    // not persisted, so the payload did not change.
    expect(writesFor(DOWNLOAD_ITEMS_KEY)).toHaveLength(0);

    // Terminal transition: completion flushes promptly (no timers needed)
    // and remains recoverable for the next launch.
    onRender.mockClear();
    await act(async () => {
      emit('download-complete', {
        id: 1,
        path: '/downloads/VLC-3.0.2-win64.exe',
        bytes: 1000,
        sha256: 'abc123',
      });
    });
    await act(async () => undefined);

    expect(itemsRef.current[0]?.status).toBe('completed');
    const persisted = JSON.parse(writesFor(DOWNLOAD_ITEMS_KEY).at(-1) ?? '[]') as Array<{
      name: string;
      status: string;
    }>;
    expect(persisted[0]).toMatchObject({ name: 'VLC-3.0.2-win64.exe', status: 'completed' });
    const stored = JSON.parse(localStorage.getItem(DOWNLOAD_ITEMS_KEY) ?? '[]') as Array<{
      status: string;
    }>;
    expect(stored.some((it) => it.status === 'completed')).toBe(true);
  }, 90_000);

  it('a start/finish flips exactly the matching card and never the other 499', async () => {
    const apps: AppItem[] = [
      ...makeApps(499),
      { ...makeApps(1)[0], id: 'vlc', name: 'VLC' },
    ];
    const onRender = vi.fn();
    const itemsRef: { current: DownloadItem[] } = { current: [] };

    render(
      <I18nProvider>
        <DownloadsProvider>
          <Profiler id="grid" onRender={onRender}>
            <div>
              {apps.map((app) => (
                <AppCard key={app.id} app={app} {...stableProps} />
              ))}
            </div>
          </Profiler>
          <Probe itemsRef={itemsRef} />
        </DownloadsProvider>
      </I18nProvider>
    );

    await act(async () => undefined);
    onRender.mockClear();
    setItemSpy.mockClear();

    // Start: the active set changes; only the VLC card's status boolean
    // flips, so only it commits (useSyncExternalStore bails the rest out).
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'start-download' }));
    });
    await act(async () => undefined);

    expect(onRender).toHaveBeenCalledTimes(1);
    expect(onRender.mock.calls[0][2]).toBeGreaterThan(0); // actualDuration: a real render

    // Five progress events on that same transfer: zero further commits.
    onRender.mockClear();
    for (let i = 1; i <= 5; i++) {
      await act(async () => {
        emit('download-progress', { id: 1, downloaded: i * 10, total: 1000, speed_bps: 10, eta_secs: 5 });
      });
    }
    expect(onRender).not.toHaveBeenCalled();

    // Completion flips the card back: still exactly one commit.
    onRender.mockClear();
    await act(async () => {
      emit('download-complete', { id: 1, path: '/downloads/VLC-3.0.2-win64.exe', bytes: 50, sha256: 'x' });
    });
    await act(async () => undefined);
    expect(onRender).toHaveBeenCalledTimes(1);
  }, 90_000);
});
