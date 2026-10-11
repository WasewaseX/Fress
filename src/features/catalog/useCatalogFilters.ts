// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { useState } from 'react';
import { toast } from 'sonner';

import { FilterState } from '../../types';
import { useI18n } from '../../lib/i18n';

/**
 * Catalog browsing/search/filter state.
 *
 * Persistence semantics (unchanged): only the platform filter is stored
 * (`fress_platform_filter`), validated against a whitelist so a hand-edited
 * value can never become filter state. Every device starts with its own
 * platform preselected - Android opens on the Android catalog, everything
 * else opens on the full list - and the user's last choice always wins
 * over the device default.
 */

const STORAGE_KEY_PLATFORM = 'fress_platform_filter';

// Each device starts with its own platform preselected: Android opens on the
// Android catalog, everything else opens on the full list. The user's last
// choice is remembered and always wins over the device default.
const isAndroidDevice = typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent);
export const deviceDefaultPlatform: FilterState['platform'] = isAndroidDevice ? 'android' : 'all';

/** Every value the platform filter is allowed to hold; anything else found
 * in localStorage is treated as absent. */
const VALID_PLATFORM_FILTERS = ['all', 'windows', 'mac', 'linux', 'web', 'android', 'ios'] as const;

function initialPlatform(): FilterState['platform'] {
  try {
    const saved = localStorage.getItem(STORAGE_KEY_PLATFORM);
    // Same localStorage-trust rule as everywhere else: a hand-edited or
    // stale value ("banana") must not become filter state. Fall back to
    // the device default instead.
    if (saved && (VALID_PLATFORM_FILTERS as readonly string[]).includes(saved)) {
      return saved as FilterState['platform'];
    }
  } catch {
    // ignore
  }
  return deviceDefaultPlatform;
}

export const DEFAULT_FILTERS: FilterState = {
  search: '',
  category: 'All',
  platform: deviceDefaultPlatform,
  beginnerOnly: false,
  ownerPickOnly: false,
  trendingOnly: false,
  favoritesOnly: false,
  customOnly: false,
  sortBy: 'stars'
};

export interface CatalogFilters {
  filters: FilterState;
  handleFilterChange: (partial: Partial<FilterState>) => void;
  resetFilters: () => void;
}

export function useCatalogFilters(): CatalogFilters {
  const { t } = useI18n();
  const [filters, setFilters] = useState<FilterState>(() => ({
    ...DEFAULT_FILTERS,
    platform: initialPlatform(),
  }));

  const handleFilterChange = (partial: Partial<FilterState>) => {
    if (partial.platform !== undefined) {
      try {
        localStorage.setItem(STORAGE_KEY_PLATFORM, partial.platform);
      } catch {
        // ignore
      }
    }
    setFilters((prev) => ({ ...prev, ...partial }));
  };

  const resetFilters = () => {
    try {
      localStorage.removeItem(STORAGE_KEY_PLATFORM);
    } catch {
      // ignore
    }
    setFilters({ ...DEFAULT_FILTERS, platform: deviceDefaultPlatform });
    toast.info(t('filters.resetDone'));
  };

  return { filters, handleFilterChange, resetFilters };
}
