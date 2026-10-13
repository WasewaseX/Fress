// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import React, { useEffect, useRef } from 'react';
import {
  Category,
  Platform,
  FilterState
} from '../types';
import { useI18n } from '../lib/i18n';
import {
  Bookmark,
  FolderPlus,
  RotateCcw,
  Award,
  Flame,
  Smartphone,
  SlidersHorizontal
} from 'lucide-react';

interface FilterBarProps {
  filters: FilterState;
  onFilterChange: (newFilters: Partial<FilterState>) => void;
  onResetFilters: () => void;
  favoritesCount: number;
  customCount: number;
  totalVisible: number;
  totalAll: number;
}

// The bar renders its controls twice (mobile bar + desktop row); every id
// carries a layout suffix so no id is ever duplicated in the DOM.
type FilterLayout = 'mobile' | 'desktop';

// Internal values stay the exact domain strings App.tsx and
// useCatalogFilters depend on; only the visible label is translated.
const CATEGORY_OPTIONS: Array<{ value: Category; labelKey: string }> = [
  { value: 'All', labelKey: 'filter.categories.all' },
  { value: 'Productivity & Office', labelKey: 'filter.categories.productivity' },
  { value: 'Developer & Code', labelKey: 'filter.categories.developer' },
  { value: 'Design & Creative', labelKey: 'filter.categories.design' },
  { value: 'Utilities & System', labelKey: 'filter.categories.utilities' },
  { value: 'Privacy & Security', labelKey: 'filter.categories.privacy' },
  { value: 'Media, Audio & Video', labelKey: 'filter.categories.media' }
];

const PLATFORM_OPTIONS: Array<{ id: Platform | 'all'; labelKey: string }> = [
  { id: 'all', labelKey: 'common.platform.all' },
  { id: 'windows', labelKey: 'common.platform.windows' },
  { id: 'mac', labelKey: 'common.platform.mac' },
  { id: 'linux', labelKey: 'common.platform.linux' },
  { id: 'android', labelKey: 'common.platform.android' },
  { id: 'web', labelKey: 'common.platform.web' }
];

// Focus treatment: deliberately EMPTY. The global `:focus-visible` rule in
// index.css (2px --fr-focus outline, 2px offset) is the one keyboard-focus
// look for the whole app; the bar's chips previously overrode it with a
// thinner ring, which made focus inconsistent between the filter row and
// every other control. Keeping the interpolation points so the class list
// stays byte-stable for the id-scoped tests.
const FOCUS_RING = '';

export const FilterBar: React.FC<FilterBarProps> = ({
  filters,
  onFilterChange,
  onResetFilters,
  favoritesCount,
  customCount,
  totalVisible,
  totalAll
}) => {
  const { t, rtl } = useI18n();
  const mobileScrollRef = useRef<HTMLDivElement | null>(null);

  // Debounced mirror of totalVisible for the live region: the count changes
  // on EVERY search keystroke, and an aria-live polite region announcing
  // each interim number drowned the one count that mattered. The announcement
  // follows 600ms after the value last changed (typing pauses, filters
  // apply instantly).
  const [announcedVisible, setAnnouncedVisible] = React.useState(totalVisible);
  useEffect(() => {
    const timer = setTimeout(() => setAnnouncedVisible(totalVisible), 600);
    return () => clearTimeout(timer);
  }, [totalVisible]);

  const isFiltered =
    filters.search !== '' ||
    filters.category !== 'All' ||
    filters.platform !== 'all' ||
    filters.ownerPickOnly ||
    filters.trendingOnly ||
    filters.favoritesOnly ||
    filters.customOnly ||
    filters.sortBy !== 'stars';

  // Keep the active platform chip visible inside the scrollable mobile bar
  // (the selected platform should never sit half-cut off the screen edge).
  // Scoped to the mobile container via a ref: the chips render twice
  // (mobile + desktop) with layout-suffixed ids, so a global getElementById
  // on a shared id would be ambiguous.
  useEffect(() => {
    const sc = mobileScrollRef.current;
    const chip = sc?.querySelector<HTMLElement>(`[id="filter-platform-mobile-${filters.platform}"]`);
    if (!sc || !chip) return;
    // Measured in visible coordinates: how far the chip center sits from the
    // container's inline start edge (left in LTR, right in RTL), then scroll
    // until that distance is half the viewport.
    const scRect = sc.getBoundingClientRect();
    const chipRect = chip.getBoundingClientRect();
    const start = rtl
      ? scRect.right - (chipRect.left + chipRect.width / 2)
      : chipRect.left + chipRect.width / 2 - scRect.left;
    const delta = start - sc.clientWidth / 2;
    if (Math.abs(delta) < 1 || sc.clientWidth === 0) return;
    // RTL scrollLeft runs 0 -> negative away from the start (right) edge, so
    // the same signed delta applies but clamps at 0 from below, not above.
    const next = sc.scrollLeft + delta;
    // Honor prefers-reduced-motion: the codebase's own policy (see
    // useViewPreferences' scroll reset) - programmatic scrolls jump
    // instantly instead of animating for users who asked for less motion.
    const reduceMotion = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    sc.scrollTo({ left: rtl ? Math.min(0, next) : Math.max(0, next), behavior: reduceMotion ? 'auto' : 'smooth' });
  }, [filters.platform, rtl]);

  // Phones get a ~40px minimum touch target; desktop keeps its compact density.
  const touchCls = (layout: FilterLayout) => (layout === 'mobile' ? ' min-h-[40px]' : '');

  // Platform chips are rendered twice (mobile bar + desktop row), so the
  // markup lives in one place.
  const platformChips = (layout: FilterLayout) => (
    <>
      <span className="text-slate-400 font-semibold text-[11px] uppercase tracking-wider me-1 shrink-0">
        {t('filter.platforms')}
      </span>
      {PLATFORM_OPTIONS.map((p) => {
        const isActive = filters.platform === p.id;
        const isAndroid = p.id === 'android';
        return (
          <button
            key={p.id}
            id={`filter-platform-${layout}-${p.id}`}
            type="button"
            onClick={() => onFilterChange({ platform: p.id })}
            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs border transition-colors shrink-0${touchCls(layout)} ${FOCUS_RING} ${
              isActive
                ? isAndroid
                  ? 'bg-emerald-500 text-white dark:text-slate-950 font-bold border-emerald-400'
                  : 'fr-chip-active font-semibold'
                : isAndroid
                  ? 'bg-emerald-800/[0.07] text-emerald-900 border-emerald-800/25 hover:bg-emerald-800/[0.12] dark:bg-emerald-400/10 dark:text-emerald-300 dark:border-emerald-400/30 dark:hover:bg-emerald-400/20'
                  : 'bg-slate-950/[0.04] dark:bg-white/[0.03] text-slate-400 border-slate-950/10 dark:border-white/[0.06] hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06] hover:text-slate-200'
            }`}
            aria-pressed={isActive}
          >
            {isAndroid && <Smartphone className="w-3 h-3" />}
            <span className="whitespace-nowrap">{t(p.labelKey)}</span>
          </button>
        );
      })}
    </>
  );

  const toggleButtons = (layout: FilterLayout) => (
    <>
      <button
        id={`filter-owner-picks-btn-${layout}`}
        type="button"
        onClick={() => onFilterChange({ ownerPickOnly: !filters.ownerPickOnly })}
        className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md border text-xs font-medium transition-colors whitespace-nowrap shrink-0${touchCls(layout)} ${FOCUS_RING} ${
          filters.ownerPickOnly
            ? 'fr-chip-active shadow-xs'
            : 'bg-slate-950/[0.04] dark:bg-white/[0.03] text-slate-400 border-slate-950/10 dark:border-white/[0.06] hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06] hover:text-slate-200'
        }`}
        aria-pressed={filters.ownerPickOnly}
      >
        <Award className="w-3 h-3 text-amber-400" aria-hidden="true" />
        <span>{t('filter.pickOnly')}</span>
      </button>

      <button
        id={`filter-trending-btn-${layout}`}
        type="button"
        onClick={() => onFilterChange({ trendingOnly: !filters.trendingOnly })}
        className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md border text-xs font-medium transition-colors whitespace-nowrap shrink-0${touchCls(layout)} ${FOCUS_RING} ${
          filters.trendingOnly
            ? 'bg-emerald-800/[0.07] text-emerald-900 border-emerald-800/25 dark:bg-emerald-400/10 dark:text-emerald-300 dark:border-emerald-400/30'
            : 'bg-slate-950/[0.04] dark:bg-white/[0.03] text-slate-400 border-slate-950/10 dark:border-white/[0.06] hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06] hover:text-slate-200'
        }`}
        aria-pressed={filters.trendingOnly}
      >
        <Flame className="w-3 h-3 text-emerald-400" aria-hidden="true" />
        <span>{t('filter.trendingOnly')}</span>
      </button>

      <button
        id={`filter-favorites-btn-${layout}`}
        type="button"
        onClick={() => onFilterChange({ favoritesOnly: !filters.favoritesOnly })}
        className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md border text-xs font-medium transition-colors whitespace-nowrap shrink-0${touchCls(layout)} ${FOCUS_RING} ${
          filters.favoritesOnly
            ? 'bg-rose-800/[0.07] text-rose-900 border-rose-800/25 dark:bg-rose-400/10 dark:text-rose-300 dark:border-rose-400/30'
            : 'bg-slate-950/[0.04] dark:bg-white/[0.03] text-slate-400 border-slate-950/10 dark:border-white/[0.06] hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06] hover:text-slate-200'
        }`}
        aria-pressed={filters.favoritesOnly}
      >
        <Bookmark className="w-3 h-3 text-rose-400" aria-hidden="true" />
        <span>{t('filter.favorites')} ({favoritesCount})</span>
      </button>

      {customCount > 0 && (
        <button
          id={`filter-custom-apps-btn-${layout}`}
          type="button"
          onClick={() => onFilterChange({ customOnly: !filters.customOnly })}
          className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md border text-xs font-medium transition-colors whitespace-nowrap shrink-0${touchCls(layout)} ${FOCUS_RING} ${
            filters.customOnly
              ? 'bg-indigo-400/10 text-indigo-300 border-indigo-400/30'
              : 'bg-slate-950/[0.04] dark:bg-white/[0.03] text-slate-400 border-slate-950/10 dark:border-white/[0.06] hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06] hover:text-slate-200'
          }`}
          aria-pressed={filters.customOnly}
        >
          <FolderPlus className="w-3 h-3 text-indigo-400" aria-hidden="true" />
          <span>{t('filter.custom')} ({customCount})</span>
        </button>
      )}
    </>
  );

  const sortControls = (layout: FilterLayout) => (
    <div id={`filter-sort-controls-${layout}`} className="flex items-center gap-2">
      <select
        id={`sort-selector-${layout}`}
        value={filters.sortBy}
        onChange={(e) => onFilterChange({ sortBy: e.target.value as FilterState['sortBy'] })}
        // The sort selector has no visible label; give assistive tech a name.
        aria-label={t('filter.sort')}
        className={`bg-slate-950/[0.04] dark:bg-white/[0.04] border border-slate-950/10 dark:border-white/[0.1] text-slate-200 text-xs rounded-md px-2 py-1${touchCls(layout)} ${FOCUS_RING} cursor-pointer`}
      >
        <option value="stars" className="bg-fr-bg text-fr-text">{t('filter.sortStars')}</option>
        <option value="name" className="bg-fr-bg text-fr-text">{t('filter.sortName')}</option>
        <option value="newest" className="bg-fr-bg text-fr-text">{t('filter.sortNewest')}</option>
      </select>

      {isFiltered && (
        <button
          id={`filter-reset-btn-${layout}`}
          type="button"
          onClick={onResetFilters}
          className={`inline-flex items-center gap-1 text-slate-400 hover:text-slate-100 bg-slate-950/[0.04] dark:bg-white/[0.04] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.08] border border-slate-950/10 dark:border-white/[0.08] px-2 py-1 rounded-md text-xs transition-colors whitespace-nowrap${touchCls(layout)} ${FOCUS_RING}`}
          title={t('filter.resetTitle')}
        >
          <RotateCcw className="w-3 h-3" aria-hidden="true" />
          <span>{t('filter.reset')}</span>
        </button>
      )}

      <span id={`filter-count-indicator-${layout}`} className="text-[11px] text-slate-400 font-mono ps-1">
        {totalVisible} / {totalAll}
      </span>
    </div>
  );

  return (
    <div
      id="filter-bar-container"
      /* The bar sits outside <main> (sticky full-bleed band), so it must be
         its own landmark to not float outside the page outline for screen
         readers (axe: region). A named region needs the explicit role on a
         generic div; the label names the whole control cluster. */
      role="region"
      aria-label={t('filter.region')}
      className="md:sticky md:z-20 bg-fr-bg border-b border-fr-border py-2.5"
      style={{ top: 'var(--fress-header-h, 0px)' }}
    >
      <div className="fr-shell space-y-2">
        {/* Categories Bar. The row is a keyboard-scrollable region (WCAG
            2.1.1): the chip row overflows horizontally at narrow widths and
            keyboard users must be able to scroll it intentionally. */}
        <div
          id="categories-scroll-row"
          className="flex items-center gap-1.5 overflow-x-auto pb-0.5 text-xs scrollbar-none"
          tabIndex={0}
          role="group"
          aria-label={t('filter.categories')}
        >
          <span className="text-slate-400 font-semibold text-[11px] uppercase tracking-wider me-1 shrink-0">
            {t('filter.categories')}
          </span>
          {CATEGORY_OPTIONS.map((cat) => {
            const isActive = filters.category === cat.value;
            const slug = cat.value.toLowerCase().replace(/[^a-z0-9]/g, '-');
            return (
              <button
                key={cat.value}
                id={`cat-filter-btn-${slug}`}
                type="button"
                onClick={() => onFilterChange({ category: cat.value })}
                className={`whitespace-nowrap px-2.5 py-1 rounded-md text-xs font-medium border transition-colors shrink-0 ${FOCUS_RING} ${
                  isActive
                    ? 'fr-chip-active shadow-xs'
                    : 'bg-slate-950/[0.04] dark:bg-white/[0.03] text-slate-400 border-slate-950/10 dark:border-white/[0.06] hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06] hover:text-slate-200'
                }`}
                aria-pressed={isActive}
              >
                {t(cat.labelKey)}
              </button>
            );
          })}
        </div>

        {/* Phones: the platform chips live in their own bar fixed directly
            under the header (sticky cannot outlive its scrolling parent, and
            pinning the whole stack would eat half of a phone screen). The
            spacer keeps the layout identical while the bar is in its natural
            position. */}
        <div
          id="platform-bar-mobile"
          className="md:hidden fixed left-0 right-0 z-20 bg-fr-bg border-b border-fr-border px-4 py-1.5"
          style={{ top: 'var(--fress-header-h, 0px)' }}
        >
          <div
            ref={mobileScrollRef}
            id="platform-bar-mobile-scroll"
            role="group"
            aria-label={t('filter.platforms')}
            tabIndex={0}
            className="flex items-center gap-1.5 overflow-x-auto scrollbar-none text-xs"
          >
            {platformChips('mobile')}
          </div>
        </div>
        <div className="h-11 md:hidden" aria-hidden="true" />

        {/* Desktop/tablet: one combined row (platform + toggles + sort), the
            whole bar pins under the header. */}
        <div
          id="secondary-filter-row"
          className="hidden md:flex flex-wrap items-center justify-between gap-2.5 pt-1.5 border-t border-slate-950/10 dark:border-white/[0.04] text-xs"
        >
          <div id="platform-chips-group" role="group" aria-label={t('filter.platforms')} className="flex items-center gap-1 flex-wrap">
            {platformChips('desktop')}
          </div>
          <div id="filter-toggles-group" role="group" aria-label={t('filter.quickFilters')} className="flex items-center flex-wrap gap-1.5">
            {toggleButtons('desktop')}
          </div>
          {sortControls('desktop')}
        </div>

        {/* Phones: toggles + sort row (platform chips are in the fixed bar) */}
        <div
          id="mobile-toggles-row"
          className="md:hidden flex flex-wrap items-center justify-between gap-2.5 pt-1 text-xs"
        >
          <div id="filter-toggles-group-mobile" className="flex items-center flex-wrap gap-1.5">
            {toggleButtons('mobile')}
          </div>
          {sortControls('mobile')}
        </div>
      </div>

      {/* Screen-reader mirror of the language-neutral visible counter. */}
      <div className="sr-only" role="status" aria-live="polite">
        {t('filter.resultsAnnounce').replace('{visible}', String(announcedVisible)).replace('{total}', String(totalAll))}
      </div>
    </div>
  );
};
