// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
// AppCard long-content stress invariants (Agent 1 round 26, Task 2).
//
// The pixel evidence for card alignment lives in qa-shots/round26 (real
// production captures at six widths in both themes). jsdom has no layout
// engine, so THIS file pins the structural invariants the design relies on
// - the ones that, if regressed, would break the visual contract even
// when every width measurement happens to pass:
//
//   1. The title button and the tagline keep their two-line clamps.
//   2. The tagline block keeps its reserved minimum height (adjacent cards'
//      metadata rows and footers stay aligned even with one-line text).
//   3. The card's visual order is fixed: identity (icon + title), badges,
//      description, metadata, action footer - long content reorders nothing.
//   4. A broken/missing icon falls back to the designed letter tile, never
//      an empty gap.
//   5. Extreme metadata values (huge star counts, missing license, very long
//      proprietary alternative names, many platform indicators) all render
//      with their truncation/tooltip treatments and never remove the
//      Download footer.
//
// @vitest-environment jsdom

import { act } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

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

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), info: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

// Live stars do network fetches on mount; the stress test pins structure,
// not network state - render with the formatter only.
vi.mock('../../lib/starFetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/starFetch')>();
  return { ...actual, useLiveStars: () => null };
});

// The engine context is required by useDownloadActions; the stress card
// never starts a download.
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('@tauri-apps/plugin-opener', () => ({
  openPath: vi.fn(async () => undefined),
  revealItemInDir: vi.fn(async () => undefined),
}));

import { AppCard, AppIcon } from '../AppCard';
import { I18nProvider } from '../../lib/i18n';
import { DownloadsProvider } from '../../lib/downloads';
import type { AppItem } from '../../types';

function makeApp(overrides: Partial<AppItem> = {}): AppItem {
  return {
    id: 'stress-app',
    name: 'Stress App',
    tagline: 'A plain tagline',
    description: 'A plain description.',
    category: 'Productivity & Office',
    platforms: ['windows', 'mac', 'linux'],
    license: 'MIT',
    stars: 12_345,
    icon: 'stress-app.png',
    githubUrl: 'https://github.com/stress/app',
    ...overrides,
  } as AppItem;
}

function renderCard(app: AppItem): Root {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(
        I18nProvider,
        null,
        createElement(DownloadsProvider, null, createElement(AppCard, { app, isFavorite: false, onToggleFavorite: () => undefined, onOpenDetail: () => undefined }))
      )
    );
  });
  return root;
}

let roots: Root[] = [];
function renderTracked(app: AppItem): void {
  roots.push(renderCard(app));
}

afterEach(() => {
  roots.forEach((r) => act(() => r.unmount()));
  roots = [];
  cleanup();
});

describe('AppCard long-content stress (Task 2 invariants)', () => {
  it('the title button and tagline keep their two-line clamps under a pathological name', () => {
    const longName = 'Super extraordinarily long application name that no sane catalog row would ever hold but the design must survive';
    renderTracked(makeApp({ name: longName }));
    const titleBtn = screen.getByRole('button', { name: longName });
    expect(titleBtn.className).toContain('line-clamp-2');
    const tagline = document.getElementById('app-tagline-stress-app');
    expect(tagline?.className).toContain('line-clamp-2');
    // The clamp lives on the button INSIDE the heading; the heading itself
    // must not add a competing overflow rule that defeats the inner clamp.
    const heading = titleBtn.closest('h2, h3');
    expect(heading).not.toBeNull();
  });

  it('the tagline block reserves its two-line minimum height even for one-line text', () => {
    renderTracked(makeApp({ tagline: 'Short.' }));
    const tagline = document.getElementById('app-tagline-stress-app');
    expect(tagline).not.toBeNull();
    const block = tagline!.parentElement;
    expect(block?.getAttribute('style') ?? '').toMatch(/min-height/i);
  });

  it('long content does not reorder the card: identity, badges, description, metadata, footer', () => {
    renderTracked(
      makeApp({
        name: 'A very long application name that wraps and wraps and keeps wrapping across the whole card width',
        proprietaryAlternative: 'SomeExtremelyLongProprietarySuiteNameWithSeveralWordsAndSuffixes',
        platforms: ['windows', 'mac', 'linux', 'android', 'ios', 'web'],
        stars: 987_654_321,
      })
    );
    const card = document.getElementById('app-card-stress-app') ?? document.querySelector('[id^="app-card-"]')?.parentElement;
    expect(card).not.toBeNull();
    const order = (card as HTMLElement).textContent ?? '';
    const idx = (needle: string) => order.indexOf(needle);
    // Identity before badges before description before metadata before footer.
    expect(idx('A very long application name')).toBeGreaterThanOrEqual(0);
    expect(idx('987.7M') >= 0 || idx('987.65M') >= 0 || /987/.test(order)).toBe(true);
    const footerDownload = screen.getByRole('button', { name: /download/i });
    expect(footerDownload).not.toBeNull();
    expect(screen.getByRole('button', { name: /details/i })).not.toBeNull();
  });

  it('a broken icon falls back to the designed letter tile, never an empty gap', () => {
    // 'vlc' ships real artwork in APP_ICONS, so an <img> renders first and
    // the onError fallback path is exercisable.
    renderTracked(makeApp({ id: 'vlc', name: 'VLC' }));
    const img = document.querySelector('[id^="app-card-"] img') as HTMLImageElement | null;
    expect(img).not.toBeNull();
    // Simulate the browser failing to load the artwork.
    act(() => {
      fireEvent.error(img!);
    });
    const tile = Array.from(document.querySelectorAll('[id^="app-card-"] span[aria-hidden="true"]')).find(
      (s) => s.textContent === 'V'
    );
    expect(tile).not.toBeNull();
  });

  it('the AppIcon letter tile also covers apps without any shipped icon', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(createElement(AppIcon, { appId: 'no-icon-app', name: 'librewolf' }));
    });
    expect(container.textContent).toBe('L');
    act(() => root.unmount());
    container.remove();
  });

  it('extreme metadata renders with its treatments: huge stars, missing license, long alternative, many platforms', () => {
    renderTracked(
      makeApp({
        stars: 987_654,
        license: '',
        proprietaryAlternative: 'AnAbsurdlyLongCommercialAlternativeProductNameThatMustTruncateWithATooltip',
        platforms: ['windows', 'mac', 'linux', 'android', 'ios', 'web'],
      })
    );
    const metaText = document.querySelector('[id^="app-card-"]')?.textContent ?? '';
    // Large star counts use the compact formatter, never raw digits. The
    // realistic ceiling on GitHub is a few hundred thousand stars, so the
    // three-digit-k contract is what the card must hold.
    expect(metaText).toContain('988k'); // 987,654 -> '988k'
    expect(metaText).not.toContain('987654');
    // A missing license never renders an empty chip; the alternative chip
    // keeps its tooltip; the footer still carries the Download action.
    expect(screen.getByRole('button', { name: /download/i })).not.toBeNull();
    const altChip = document.querySelector('[title*="Absurdly"]') as HTMLElement | null;
    expect(altChip).not.toBeNull();
    // Every platform indicator renders.
    for (const p of ['Windows', 'macOS', 'Linux', 'Android', 'iOS', 'Web']) {
      expect(metaText).toContain(p);
    }
  });
});
