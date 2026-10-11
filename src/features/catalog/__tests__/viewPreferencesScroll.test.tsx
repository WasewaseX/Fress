// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
// @vitest-environment jsdom
//
/**
 * Regression test for the page-switch scroll bug.
 *
 * Reported: after scrolling deep into the catalog, switching to the Privacy
 * Pack left the page heading partly obscured (the previous scroll offset
 * leaked into the new page, and the fixed header covered the heading).
 *
 * Contract under test (src/features/catalog/useViewPreferences.ts):
 *   1. changing page (catalog <-> replace) resets window scroll to the top,
 *      instantly, so the new page's heading is fully in view;
 *   2. the initial mount does NOT scroll (a restored position is kept);
 *   3. toggling view mode (grid <-> table) does NOT scroll the page;
 *   4. the page choice is still persisted to localStorage.
 *
 * Rendered through react-dom/client + act (React 19) because the behavior
 * lives in an effect; SSR would never run it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useViewPreferences } from '../useViewPreferences';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

type ViewPrefs = ReturnType<typeof useViewPreferences>;

// Mutable box so the test can reach the hook's API after render without
// forcing a parent-child state dance.
const box: { current: ViewPrefs | null } = { current: null };

function Harness(): null {
  const api = useViewPreferences();
  box.current = api;
  return null;
}

describe('useViewPreferences page-switch scroll reset', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  const scrollToMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.stubGlobal('scrollTo', scrollToMock);
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    vi.unstubAllGlobals();
  });

  function mount(): void {
    act(() => {
      root = createRoot(container);
      root.render(<Harness />);
    });
  }

  it('does not scroll on the initial mount', () => {
    mount();
    expect(scrollToMock).not.toHaveBeenCalled();
  });

  it('resets scroll to the top, instantly, when the page changes', () => {
    mount();
    expect(box.current).not.toBeNull();

    act(() => {
      box.current!.changePage('replace');
    });
    expect(scrollToMock).toHaveBeenCalledTimes(1);
    expect(scrollToMock).toHaveBeenCalledWith({ top: 0, behavior: 'instant' });

    act(() => {
      box.current!.changePage('catalog');
    });
    expect(scrollToMock).toHaveBeenCalledTimes(2);
    expect(box.current!.page).toBe('catalog');
  });

  it('resets scroll after a DEEP scroll (the reported bug: deep catalog scroll, then Privacy Pack)', () => {
    mount();
    // jsdom has no layout, so "scrolled deeply" is simulated by planting the
    // offset the real browser would report; the hook contract under test is
    // that a page CHANGE answers it with an instant scrollTo(top: 0) no
    // matter how far the page was scrolled. The full-browser reproduction
    // lives in the E2E navigation coverage.
    vi.spyOn(window, 'scrollY', 'get').mockReturnValue(4233);

    act(() => {
      box.current!.changePage('replace');
    });
    expect(scrollToMock).toHaveBeenCalledTimes(1);
    expect(scrollToMock).toHaveBeenCalledWith({ top: 0, behavior: 'instant' });
  });

  it('does not scroll when only the view mode toggles', () => {
    mount();

    act(() => {
      box.current!.toggleViewMode('table');
    });
    act(() => {
      box.current!.toggleViewMode('grid');
    });

    expect(scrollToMock).not.toHaveBeenCalled();
    expect(box.current!.viewMode).toBe('grid');
  });

  it('still persists the page choice to localStorage', () => {
    mount();

    act(() => {
      box.current!.changePage('replace');
    });

    expect(localStorage.getItem('fress.page')).toBe('replace');
  });
});
