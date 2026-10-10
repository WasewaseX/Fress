// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { FilterBar } from '../../components/FilterBar';
import { I18nProvider } from '../i18n';
import type { FilterState } from '../../types';

// Mirrors DEFAULT_FILTERS from src/features/catalog/useCatalogFilters.ts —
// nothing active, so isFiltered is false and the Reset button must not render.
const DEFAULT_FILTERS: FilterState = {
  search: '',
  category: 'All',
  platform: 'all',
  beginnerOnly: false,
  ownerPickOnly: false,
  trendingOnly: false,
  favoritesOnly: false,
  customOnly: false,
  sortBy: 'stars'
};

const renderBar = (filters: FilterState = DEFAULT_FILTERS) =>
  renderToStaticMarkup(
    <I18nProvider>
      <FilterBar
        filters={filters}
        onFilterChange={() => {}}
        onResetFilters={() => {}}
        favoritesCount={2}
        customCount={1}
        totalVisible={42}
        totalAll={100}
      />
    </I18nProvider>
  );

const extractIds = (markup: string): string[] =>
  Array.from(markup.matchAll(/id="([^"]+)"/g), (m) => m[1]);

describe('FilterBar unique ids', () => {
  it('renders no duplicate id anywhere in the markup', () => {
    const markup = renderBar();
    const ids = extractIds(markup);
    expect(ids.length).toBeGreaterThan(0);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(dupes, `duplicate ids: ${[...new Set(dupes)].join(', ')}`).toEqual([]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('renders platform chips for BOTH layouts (mobile + desktop)', () => {
    const markup = renderBar();
    for (const p of ['all', 'windows', 'mac', 'linux', 'android', 'web']) {
      expect(markup).toContain(`filter-platform-mobile-${p}`);
      expect(markup).toContain(`filter-platform-desktop-${p}`);
    }
  });

  it('suffixes toggles, sort and count ids per layout; no Reset when unfiltered', () => {
    const markup = renderBar();
    for (const base of [
      'filter-owner-picks-btn',
      'filter-trending-btn',
      'filter-favorites-btn',
      'filter-custom-apps-btn',
      'filter-sort-controls',
      'sort-selector',
      'filter-count-indicator'
    ]) {
      expect(markup).toContain(`${base}-mobile`);
      expect(markup).toContain(`${base}-desktop`);
    }
    // Nothing is filtered -> the Reset button is absent in both layouts.
    expect(markup).not.toContain('filter-reset-btn');
  });

  it('renders the Reset button in both layouts once something is filtered', () => {
    const markup = renderBar({ ...DEFAULT_FILTERS, platform: 'linux' });
    expect(markup).toContain('filter-reset-btn-mobile');
    expect(markup).toContain('filter-reset-btn-desktop');
  });

  it('renders localized labels and the polite live region (en)', () => {
    // React escapes "&" to "&amp;" in the HTML string; decode before matching.
    const markup = renderBar().replace(/&amp;/g, '&');
    expect(markup).toContain('>All<');
    expect(markup).toContain('Productivity & Office');
    expect(markup).toContain('Media, Audio & Video');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('Showing 42 of 100 apps');
  });
});
