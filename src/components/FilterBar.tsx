import React, { useEffect } from 'react';
import {
  Category,
  Platform,
  FilterState
} from '../types';
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

const CATEGORIES: Category[] = [
  'All',
  'Productivity & Office',
  'Developer & Code',
  'Design & Creative',
  'Utilities & System',
  'Privacy & Security',
  'Media, Audio & Video',
  'AI & Knowledge'
];

const PLATFORMS: { id: Platform | 'all'; label: string; icon?: React.ReactNode }[] = [
  { id: 'all', label: 'All' },
  { id: 'windows', label: 'Windows' },
  { id: 'mac', label: 'macOS' },
  { id: 'linux', label: 'Linux' },
  { id: 'android', label: 'Android' },
  { id: 'web', label: 'Web' }
];

export const FilterBar: React.FC<FilterBarProps> = ({
  filters,
  onFilterChange,
  onResetFilters,
  favoritesCount,
  customCount,
  totalVisible,
  totalAll
}) => {
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
  useEffect(() => {
    const sc = document.getElementById('platform-bar-mobile-scroll');
    const chip = document.getElementById(`filter-platform-${filters.platform}`);
    if (!sc || !chip) return;
    const target = chip.offsetLeft - sc.clientWidth / 2 + chip.clientWidth / 2;
    sc.scrollTo({ left: Math.max(0, target), behavior: 'smooth' });
  }, [filters.platform]);

  // Platform chips are rendered twice (mobile bar + desktop row), so the
  // markup lives in one place.
  const platformChips = (
    <>
      <span className="text-slate-400 font-semibold text-[11px] uppercase tracking-wider mr-1 shrink-0">
        Platform:
      </span>
      {PLATFORMS.map((p) => {
        const isActive = filters.platform === p.id;
        const isAndroid = p.id === 'android';
        return (
          <button
            key={p.id}
            id={`filter-platform-${p.id}`}
            type="button"
            onClick={() => onFilterChange({ platform: p.id })}
            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs border transition-colors shrink-0 ${
              isActive
                ? isAndroid
                  ? 'bg-emerald-500 text-slate-950 font-bold border-emerald-400'
                  : 'fr-chip-active font-semibold'
                : isAndroid
                  ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/20'
                  : 'bg-slate-950/[0.04] dark:bg-white/[0.03] text-slate-400 border-slate-950/10 dark:border-white/[0.06] hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06] hover:text-slate-200'
            }`}
            aria-pressed={isActive}
          >
            {isAndroid && <Smartphone className="w-3 h-3" />}
            <span>{p.label}</span>
          </button>
        );
      })}
    </>
  );

  const toggleButtons = (
    <>
      <button
        id="filter-owner-picks-btn"
        type="button"
        onClick={() => onFilterChange({ ownerPickOnly: !filters.ownerPickOnly })}
        className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md border text-xs font-medium transition-colors ${
          filters.ownerPickOnly
            ? 'bg-amber-400/10 text-amber-300 border-amber-400/30'
            : 'bg-slate-950/[0.04] dark:bg-white/[0.03] text-slate-400 border-slate-950/10 dark:border-white/[0.06] hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06] hover:text-slate-200'
        }`}
        aria-pressed={filters.ownerPickOnly}
      >
        <Award className="w-3 h-3 text-amber-400" aria-hidden="true" />
        <span>Picks</span>
      </button>

      <button
        id="filter-trending-btn"
        type="button"
        onClick={() => onFilterChange({ trendingOnly: !filters.trendingOnly })}
        className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md border text-xs font-medium transition-colors ${
          filters.trendingOnly
            ? 'bg-emerald-400/10 text-emerald-300 border-emerald-400/30'
            : 'bg-slate-950/[0.04] dark:bg-white/[0.03] text-slate-400 border-slate-950/10 dark:border-white/[0.06] hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06] hover:text-slate-200'
        }`}
        aria-pressed={filters.trendingOnly}
      >
        <Flame className="w-3 h-3 text-emerald-400" aria-hidden="true" />
        <span>Trending</span>
      </button>

      <button
        id="filter-favorites-btn"
        type="button"
        onClick={() => onFilterChange({ favoritesOnly: !filters.favoritesOnly })}
        className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md border text-xs font-medium transition-colors ${
          filters.favoritesOnly
            ? 'bg-rose-400/10 text-rose-300 border-rose-400/30'
            : 'bg-slate-950/[0.04] dark:bg-white/[0.03] text-slate-400 border-slate-950/10 dark:border-white/[0.06] hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06] hover:text-slate-200'
        }`}
        aria-pressed={filters.favoritesOnly}
      >
        <Bookmark className="w-3 h-3 text-rose-400" aria-hidden="true" />
        <span>Favorites ({favoritesCount})</span>
      </button>

      {customCount > 0 && (
        <button
          id="filter-custom-apps-btn"
          type="button"
          onClick={() => onFilterChange({ customOnly: !filters.customOnly })}
          className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md border text-xs font-medium transition-colors ${
            filters.customOnly
              ? 'bg-indigo-400/10 text-indigo-300 border-indigo-400/30'
              : 'bg-slate-950/[0.04] dark:bg-white/[0.03] text-slate-400 border-slate-950/10 dark:border-white/[0.06] hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06] hover:text-slate-200'
          }`}
          aria-pressed={filters.customOnly}
        >
          <FolderPlus className="w-3 h-3 text-indigo-400" aria-hidden="true" />
          <span>Custom ({customCount})</span>
        </button>
      )}
    </>
  );

  const sortControls = (
    <div id="filter-sort-controls" className="flex items-center gap-2">
      <select
        id="sort-selector"
        value={filters.sortBy}
        onChange={(e) => onFilterChange({ sortBy: e.target.value as FilterState['sortBy'] })}
        className="bg-slate-950/[0.04] dark:bg-white/[0.04] border border-slate-950/10 dark:border-white/[0.1] text-slate-200 text-xs rounded-md px-2 py-1 focus:outline-none focus:ring-1 focus:ring-sky-500 cursor-pointer"
      >
        <option value="stars" className="bg-slate-950 text-slate-200">Most Stars</option>
        <option value="name" className="bg-slate-950 text-slate-200">Name (A-Z)</option>
        <option value="newest" className="bg-slate-950 text-slate-200">Recently Added</option>
      </select>

      {isFiltered && (
        <button
          id="filter-reset-btn"
          type="button"
          onClick={onResetFilters}
          className="inline-flex items-center gap-1 text-slate-400 hover:text-slate-100 bg-slate-950/[0.04] dark:bg-white/[0.04] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.08] border border-slate-950/10 dark:border-white/[0.08] px-2 py-1 rounded-md text-xs transition-colors"
          title="Reset all active filters"
        >
          <RotateCcw className="w-3 h-3" aria-hidden="true" />
          <span>Reset</span>
        </button>
      )}

      <span id="filter-count-indicator" className="text-[11px] text-slate-400 font-mono pl-1">
        {totalVisible} / {totalAll}
      </span>
    </div>
  );

  return (
    <div
      id="filter-bar-container"
      className="md:sticky md:z-20 bg-slate-950 border-b border-slate-950/10 dark:border-white/[0.08] py-2.5 px-4 sm:px-6"
      style={{ top: 'var(--fress-header-h, 0px)' }}
    >
      <div className="max-w-7xl mx-auto space-y-2">
        {/* Categories Bar */}
        <div id="categories-scroll-row" className="flex items-center gap-1.5 overflow-x-auto pb-0.5 text-xs scrollbar-none">
          <span className="text-slate-400 font-semibold text-[11px] uppercase tracking-wider mr-1 shrink-0">
            Category:
          </span>
          {CATEGORIES.map((cat) => {
            const isActive = filters.category === cat;
            const slug = cat.toLowerCase().replace(/[^a-z0-9]/g, '-');
            return (
              <button
                key={cat}
                id={`cat-filter-btn-${slug}`}
                type="button"
                onClick={() => onFilterChange({ category: cat })}
                className={`whitespace-nowrap px-2.5 py-1 rounded-md text-xs font-medium border transition-colors shrink-0 ${
                  isActive
                    ? 'fr-chip-active shadow-xs'
                    : 'bg-slate-950/[0.04] dark:bg-white/[0.03] text-slate-400 border-slate-950/10 dark:border-white/[0.06] hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06] hover:text-slate-200'
                }`}
                aria-pressed={isActive}
              >
                {cat}
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
          className="md:hidden fixed left-0 right-0 z-20 bg-slate-950 border-b border-slate-950/10 dark:border-white/[0.08] px-4 py-1.5"
          style={{ top: 'var(--fress-header-h, 0px)' }}
        >
          <div id="platform-bar-mobile-scroll" className="flex items-center gap-1 overflow-x-auto scrollbar-none text-xs">
            {platformChips}
          </div>
        </div>
        <div className="h-11 md:hidden" aria-hidden="true" />

        {/* Desktop/tablet: one combined row (platform + toggles + sort), the
            whole bar pins under the header. */}
        <div
          id="secondary-filter-row"
          className="hidden md:flex flex-wrap items-center justify-between gap-2.5 pt-1.5 border-t border-slate-950/10 dark:border-white/[0.04] text-xs"
        >
          <div id="platform-chips-group" className="flex items-center gap-1 flex-wrap">
            {platformChips}
          </div>
          <div id="filter-toggles-group" className="flex items-center flex-wrap gap-1.5">
            {toggleButtons}
          </div>
          {sortControls}
        </div>

        {/* Phones: toggles + sort row (platform chips are in the fixed bar) */}
        <div
          id="mobile-toggles-row"
          className="md:hidden flex flex-wrap items-center justify-between gap-2.5 pt-1 text-xs"
        >
          <div id="filter-toggles-group-mobile" className="flex items-center flex-wrap gap-1.5">
            {toggleButtons}
          </div>
          {sortControls}
        </div>
      </div>
    </div>
  );
};
