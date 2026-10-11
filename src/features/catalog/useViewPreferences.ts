// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { useEffect, useRef, useState } from 'react';

/**
 * Device-level view preferences: grid vs table, and which top-level tab
 * (catalog or privacy pack) is open. Both are remembered per device.
 */

const STORAGE_KEY_VIEW_MODE = 'awesome_free_apps_view_mode';
const STORAGE_KEY_PAGE = 'fress.page';

export type ViewMode = 'grid' | 'table';
export type Page = 'catalog' | 'replace';

export interface ViewPreferences {
  viewMode: ViewMode;
  page: Page;
  toggleViewMode: (mode: ViewMode) => void;
  changePage: (next: Page) => void;
}

export function useViewPreferences(): ViewPreferences {
  // View mode: grid vs table
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_VIEW_MODE);
      if (saved === 'grid' || saved === 'table') return saved;
    } catch {
      // ignore
    }
    return 'grid';
  });

  const toggleViewMode = (mode: ViewMode) => {
    setViewMode(mode);
    try {
      localStorage.setItem(STORAGE_KEY_VIEW_MODE, mode);
    } catch {
      // ignore
    }
  };

  // Top-level tab: the app catalog or the privacy pack. Remembered per device.
  const [page, setPage] = useState<Page>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_PAGE);
      if (saved === 'catalog' || saved === 'replace') return saved;
      // 'combos' was removed; returning users land on the catalog instead.
      if (saved === 'combos') {
        localStorage.setItem(STORAGE_KEY_PAGE, 'catalog');
      }
    } catch {
      // ignore
    }
    return 'catalog';
  });

  const changePage = (next: Page) => {
    setPage(next);
    try {
      localStorage.setItem(STORAGE_KEY_PAGE, next);
    } catch {
      // ignore
    }
  };

  // Regression guard for the page-switch scroll bug: switching Apps <->
  // Privacy Pack used to keep the previous page's scroll offset, so a deep
  // scroll left the new page's heading half-hidden under the fixed header.
  // Every page CHANGE now resets the window to the top, where the in-flow
  // spacer already clears the fixed header; the very first effect run is
  // the initial mount and must not yank a restored position. View-mode
  // toggles (grid <-> table) are deliberately NOT wired to this effect, so
  // switching layout never scrolls the page.
  const isFirstPageEffect = useRef(true);
  useEffect(() => {
    if (isFirstPageEffect.current) {
      isFirstPageEffect.current = false;
      return;
    }
    // 'instant' on purpose: a page swap must land immediately, and it is
    // also the correct treatment for prefers-reduced-motion users.
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, [page]);

  return { viewMode, page, toggleViewMode, changePage };
}
