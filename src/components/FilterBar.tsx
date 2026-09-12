import React from 'react';
import {
  Category,
  Platform,
  FilterState
} from '../types';
import { Bookmark, FolderPlus, RotateCcw, Award, Flame, Smartphone, Apple } from 'lucide-react';
import { useI18n, categoryKey } from '../lib/i18n';

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
  { id: 'all', label: '' } as { id: Platform | 'all'; label: string; icon?: React.ReactNode },
  { id: 'windows', label: 'Windows' },
  { id: 'mac', label: 'macOS' },
  { id: 'linux', label: 'Linux' },
  { id: 'android', label: 'Android' },
  { id: 'ios', label: 'iOS' },
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
  const { t } = useI18n();
  const isFiltered = 
    filters.search !== '' ||
    filters.category !== 'All' ||
    filters.platform !== 'all' ||
    filters.ownerPickOnly ||
    filters.trendingOnly ||
    filters.favoritesOnly ||
    filters.customOnly ||
    filters.sortBy !== 'stars';

  return (
    <div id="filter-bar-container" className="bg-slate-950 border-b border-slate-950/10 dark:border-white/[0.08] py-2.5 px-4 sm:px-6">
      <div className="max-w-7xl mx-auto space-y-2">
        {/* Categories Bar */}
        <div id="categories-scroll-row" className="flex items-center gap-1.5 overflow-x-auto pb-0.5 text-xs scrollbar-none">
          <span className="text-slate-400 font-semibold text-[11px] uppercase tracking-wider mr-1 shrink-0">
            {t('filter.categoryLabel')}
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
                    ? 'bg-sky-600 text-white border-sky-500 shadow-xs'
                    : 'bg-slate-950/[0.04] dark:bg-white/[0.03] text-slate-400 border-slate-950/10 dark:border-white/[0.06] hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06] hover:text-slate-200'
                }`}
                aria-pressed={isActive}
              >
                {t(categoryKey(cat))}
              </button>
            );
          })}
        </div>

        {/* Secondary Clean Filter Row: OS Tabs, Toggles, Sort */}
        <div id="secondary-filter-row" className="flex flex-wrap items-center justify-between gap-2.5 pt-1.5 border-t border-slate-950/10 dark:border-white/[0.04] text-xs">
          {/* OS Platform Tabs including Android and iOS */}
          <div id="platform-chips-group" className="flex items-center gap-1 flex-wrap">
            <span className="text-slate-400 font-semibold text-[11px] uppercase tracking-wider mr-1">
              {t('filter.platformLabel')}
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
                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs border transition-colors ${
                    isActive
                      ? 'bg-sky-600 text-white font-semibold border-sky-500'
                      : isAndroid
                        ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/20'
                        : 'bg-slate-950/[0.04] dark:bg-white/[0.03] text-slate-400 border-slate-950/10 dark:border-white/[0.06] hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06] hover:text-slate-200'
                  }`}
                  aria-pressed={isActive}
                >
                  {isAndroid && <Smartphone className="w-3 h-3" />}
                  {p.id === 'ios' && <Apple className="w-3 h-3" />}
                  <span>{p.id === 'all' ? t('category.all') : p.label}</span>
                </button>
              );
            })}
          </div>

          {/* Quick toggle filters (No beginner friendly clutter) */}
          <div id="filter-toggles-group" className="flex items-center flex-wrap gap-1.5">
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
              <span>{t('filter.picks')}</span>
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
              <span>{t('filter.trendingLabel')}</span>
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
              <span>{t('filter.favorites')} ({favoritesCount})</span>
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
                <span>{t('filter.custom')} ({customCount})</span>
              </button>
            )}
          </div>

          {/* Right side: Sorting and Reset */}
          <div id="filter-sort-controls" className="flex items-center gap-2">
            <select
              id="sort-selector"
              aria-label="Sort apps by"
              value={filters.sortBy}
              onChange={(e) => onFilterChange({ sortBy: e.target.value as FilterState['sortBy'] })}
              className="bg-slate-950/[0.04] dark:bg-white/[0.04] border border-slate-950/10 dark:border-white/[0.1] text-slate-200 text-xs rounded-md px-2 py-1 focus:outline-none focus:ring-1 focus:ring-sky-500 cursor-pointer"
            >
              <option value="stars" className="bg-slate-950 text-slate-200">{t('filter.sortStars')}</option>
              <option value="name" className="bg-slate-950 text-slate-200">{t('filter.sortName')}</option>
              <option value="newest" className="bg-slate-950 text-slate-200">{t('filter.sortNewest')}</option>
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
                <span>{t('filter.reset')}</span>
              </button>
            )}

            <span id="filter-count-indicator" className="text-[11px] text-slate-400 font-mono pl-1">
              {totalVisible} / {totalAll}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
