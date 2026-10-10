// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { useState } from 'react';

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

  return { viewMode, page, toggleViewMode, changePage };
}
