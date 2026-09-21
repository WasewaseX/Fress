import React, { useEffect, useRef, useState } from 'react';
import {
  Search,
  Plus,
  Download,
  RefreshCw,
  Keyboard,
  X,
  Upload,
  FileDown,
  LayoutGrid,
  List,
  Layers,
  Terminal,
  Columns,
  Share2,
  Sparkles,
  MoreHorizontal,
  Sun,
  Moon,
  DownloadCloud,
  Globe,
  Check,
  Folder,
  FolderOpen,
  RotateCcw,
} from 'lucide-react';
import { useTheme } from './ThemeProvider';
import { useDownloads, isAndroidWebview } from '../lib/downloads';
import { LANGUAGES, useI18n } from '../lib/i18n';
import pkg from '../../package.json';

interface HeaderProps {
  searchQuery: string;
  onSearchChange: (value: string) => void;
  onOpenAddApps: () => void;
  onOpenTauriModal: () => void;
  onOpenShortcutsModal: () => void;
  onExportCatalog: () => void;
  onImportCatalog: (importedJson: string) => void;
  viewMode: 'grid' | 'table';
  onToggleViewMode: (mode: 'grid' | 'table') => void;
  /** Which top-level tab is open. */
  page?: 'catalog' | 'combos';
  onPageChange?: (page: 'catalog' | 'combos') => void;
  onOpenCommandPalette?: () => void;
  onOpenBatchInstall?: () => void;
  onOpenCompare?: () => void;
  onOpenExportModal?: () => void;
  onOpenDownloads?: () => void;
  batchCount?: number;
  compareCount?: number;
  activeDownloadCount?: number;
  /** Set when a newer Fress release exists on GitHub. */
  updateVersion?: string | null;
  onUpdateClick?: () => void;
  onCheckForUpdates?: () => void;
  onOpenWhatsNew?: () => void;
}

/** Brand mark: a blue leaf on a transparent background, used everywhere. */
export const BrandMark: React.FC<{ size?: number }> = ({ size = 32 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 64 64"
    role="img"
    aria-label="Fress"
    className="shrink-0"
  >
    <defs>
      <linearGradient id="fressLeafFill" x1="0" y1="0" x2="0.35" y2="1">
        <stop offset="0" stopColor="#41b6f2" />
        <stop offset="1" stopColor="#0d84c9" />
      </linearGradient>
    </defs>
    <path
      d="M46.5 15.5c-13.2 0-22.6 4.6-27.4 12.9-3.4 5.9-3.6 12.9-1 20.6l3.4-1.2c-2.2-6.6-2.1-12.5.7-17.4 2.5-4.4 7.2-7.8 13.7-9.7-4.3 2.8-7.4 6.4-9.1 10.6-2.4 5.9-1.7 12.4 1.9 17.7 5.9-1 10.9-3.3 14.7-6.8 5.3-4.9 8-12 8.1-21.5 0-2.9-.4-5.2-1.5-5.2z"
      fill="url(#fressLeafFill)"
    />
    <path d="M19 50.5c1.5-4.5 4-8.5 7.5-11.5" stroke="#0b6ea8" strokeWidth="2.4" strokeLinecap="round" fill="none" />
  </svg>
);

export const Header: React.FC<HeaderProps> = ({
  searchQuery,
  onSearchChange,
  onOpenAddApps,
  onOpenTauriModal,
  onOpenShortcutsModal,
  onExportCatalog,
  onImportCatalog,
  viewMode,
  onToggleViewMode,
  page = 'catalog',
  onPageChange,
  onOpenCommandPalette,
  onOpenBatchInstall,
  onOpenCompare,
  onOpenExportModal,
  onOpenDownloads,
  batchCount = 0,
  compareCount = 0,
  activeDownloadCount = 0,
  updateVersion = null,
  onUpdateClick,
  onCheckForUpdates,
  onOpenWhatsNew,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const { theme, setTheme } = useTheme();
  const { activeCount, downloadDir, chooseFolder, resetFolder } = useDownloads();
  const { t, lang, setLang } = useI18n();

  const downloadBadge = activeDownloadCount ?? activeCount;
  // Android's scoped storage has no arbitrary folder picker (that's a desktop
  // capability), so the change/reset controls only exist on desktop.
  const canPickFolder = !isAndroidWebview();

  // Publish the header's rendered height as a CSS variable so the filter bar
  // can stick directly beneath it on every screen size without guessing.
  useEffect(() => {
    const headerEl = document.getElementById('main-app-header');
    if (!headerEl) return;
    const update = () =>
      document.documentElement.style.setProperty('--fress-header-h', `${headerEl.offsetHeight}px`);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(headerEl);
    window.addEventListener('resize', update);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
    };
  }, []);

  const handleFileSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      const text = evt.target?.result as string;
      if (text) {
        onImportCatalog(text);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
    setShowMoreMenu(false);
  };

  // Close menus on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowMoreMenu(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <header
      id="main-app-header"
      className="fixed inset-x-0 top-0 z-30 md:sticky border-b border-slate-950/10 dark:border-white/[0.08] bg-slate-900/95 backdrop-blur-md"
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-2.5">
        <div id="header-content-row" className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 flex-wrap">

          {/* Brand: app icon + name, nothing else */}
          <div id="header-brand-group" className="flex items-center gap-2.5 shrink-0">
            <BrandMark size={32} />
            <span id="header-brand-title" className="font-extrabold text-base text-slate-100 tracking-tight">
              Fress
            </span>
            <span
              id="header-version-chip"
              className="text-[11px] font-mono font-semibold tracking-wide text-slate-400 bg-slate-950/[0.05] dark:bg-white/[0.05] border border-slate-950/10 dark:border-white/[0.08] px-1.5 py-0.5 rounded"
              title="The exact version of this Fress install"
            >
              v{pkg.version}
            </span>
            {updateVersion && (
              <button
                id="header-update-pill"
                type="button"
                onClick={onUpdateClick}
                className="inline-flex items-center gap-1 text-[11px] font-bold text-amber-900 bg-amber-300 hover:bg-amber-200 border border-amber-400 px-2 py-0.5 rounded transition-colors"
                title={`Fress v${updateVersion} is available. Tap to download the update. Your apps and data are kept.`}
              >
                <Download className="w-3 h-3" aria-hidden="true" />
                <span>Update v{updateVersion}</span>
              </button>
            )}
          </div>

          {/* Search bar & Cmd+K quick launcher */}
          <div id="header-search-wrapper" className="flex-1 max-w-lg relative min-w-[200px]">
            <label htmlFor="app-search-input" className="sr-only">
              {t('header.search')} Ctrl+K
            </label>
            <div className="relative">
              <Search
                id="search-icon-indicator"
                className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                aria-hidden="true"
              />
              <input
                id="app-search-input"
                type="text"
                value={searchQuery}
                onChange={(e) => onSearchChange(e.target.value)}
                placeholder={t('header.searchPlaceholder')}
                className="w-full bg-slate-950/[0.04] dark:bg-white/[0.04] border border-slate-950/10 dark:border-white/[0.1] hover:border-slate-950/20 dark:hover:border-white/[0.2] text-slate-100 placeholder-slate-400 text-xs rounded-lg pl-9 pr-20 py-2 transition-colors focus:outline-none focus:ring-1 focus:ring-sky-500 focus:border-sky-500"
              />
              <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                {searchQuery && (
                  <button
                    id="clear-search-btn"
                    type="button"
                    onClick={() => onSearchChange('')}
                    aria-label="Clear search input"
                    className="text-slate-400 hover:text-slate-100 p-0.5"
                  >
                    <X className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                )}
                {onOpenCommandPalette && (
                  <button
                    type="button"
                    onClick={onOpenCommandPalette}
                    className="text-[11px] font-mono bg-slate-950/[0.06] dark:bg-white/[0.08] hover:bg-slate-950/[0.1] dark:hover:bg-white/[0.14] border border-slate-950/10 dark:border-white/[0.12] text-slate-300 px-1.5 py-0.5 rounded transition-colors"
                    title="Open Command Palette (Ctrl+K)"
                  >
                    Ctrl+K
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Action group */}
          <div id="header-actions-group" className="flex items-center gap-2 shrink-0 flex-wrap">
            <button
              id="header-add-app-btn"
              type="button"
              onClick={onOpenAddApps}
              className="inline-flex items-center gap-1.5 bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold px-3 py-1.5 rounded-lg border border-sky-500 transition-colors shadow-xs"
              title="Add software to your catalog: search GitHub or enter it yourself"
            >
              <Plus className="w-3.5 h-3.5 text-sky-100" aria-hidden="true" />
              <span>{t('header.addApp')}</span>
            </button>

            {/* Downloads */}
            <button
              id="header-downloads-btn"
              type="button"
              onClick={onOpenDownloads}
              className="relative inline-flex items-center gap-1.5 text-xs font-medium text-slate-200 hover:text-slate-100 bg-slate-950/[0.04] dark:bg-white/[0.04] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.08] border border-slate-950/10 dark:border-white/[0.08] px-2.5 py-1.5 rounded-lg transition-colors"
              title={t('header.downloads')}
              aria-label={`${t('header.downloads')}${downloadBadge > 0 ? ` (${downloadBadge})` : ''}`}
            >
              <DownloadCloud className="w-3.5 h-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">{t('header.downloads')}</span>
              {downloadBadge > 0 && (
                <span
                  id="downloads-active-badge"
                  className="absolute -top-1.5 -right-1.5 min-w-[16px] h-4 px-1 rounded-full bg-sky-500 text-white text-[11px] font-bold flex items-center justify-center"
                >
                  {downloadBadge}
                </span>
              )}
            </button>

            {/* Batch pill */}
            {onOpenBatchInstall && batchCount > 0 && (
              <button
                type="button"
                id="header-batch-btn"
                onClick={onOpenBatchInstall}
                className="inline-flex items-center gap-1 bg-sky-800/[0.08] text-sky-900 border border-sky-800/25 dark:bg-sky-500/20 dark:text-sky-300 dark:border-sky-500/40 hover:bg-sky-800/[0.14] dark:hover:bg-sky-500/30 text-xs font-medium px-2.5 py-1.5 rounded-lg transition-colors"
                title="Generate batch installer script"
              >
                <Terminal className="w-3.5 h-3.5" />
                <span>Batch ({batchCount})</span>
              </button>
            )}

            {/* Compare pill */}
            {onOpenCompare && compareCount > 0 && (
              <button
                type="button"
                id="header-compare-btn"
                onClick={onOpenCompare}
                className="inline-flex items-center gap-1 bg-indigo-500/20 text-indigo-300 border border-indigo-500/40 hover:bg-indigo-500/30 text-xs font-medium px-2.5 py-1.5 rounded-lg transition-colors"
                title="Side-by-side feature comparison"
              >
                <Columns className="w-3.5 h-3.5" />
                <span>Compare ({compareCount})</span>
              </button>
            )}

            {/* Tabs: catalog vs combos (desktop; phones find them in the More menu) */}
            {onPageChange && (
              <div id="page-tabs" role="tablist" aria-label="Catalog sections" className="hidden md:flex items-center bg-slate-950/[0.04] dark:bg-white/[0.04] border border-slate-950/10 dark:border-white/[0.08] p-0.5 rounded-lg">
                <button
                  id="page-catalog-btn"
                  type="button"
                  role="tab"
                  aria-selected={page === 'catalog'}
                  onClick={() => onPageChange('catalog')}
                  className={`px-2 py-1 rounded-md text-xs font-medium transition-colors ${
                    page === 'catalog'
                      ? 'fr-chip-active shadow-xs'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                  title="Browse the app catalog"
                >
                  Apps
                </button>
                <button
                  id="page-combos-btn"
                  type="button"
                  role="tab"
                  aria-selected={page === 'combos'}
                  onClick={() => onPageChange('combos')}
                  className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium transition-colors ${
                    page === 'combos'
                      ? 'fr-chip-active shadow-xs'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                  title="Kits of apps that work well together"
                >
                  <Layers className="w-3.5 h-3.5" aria-hidden="true" />
                  Combos
                </button>
              </div>
            )}

            {/* View mode (desktop; phones find it in the More menu) */}
            <div id="view-mode-toggle" className={`hidden md:flex items-center bg-slate-950/[0.04] dark:bg-white/[0.04] border border-slate-950/10 dark:border-white/[0.08] p-0.5 rounded-lg ${page === 'combos' ? 'md:hidden' : ''}`}>
              <button
                id="view-mode-grid-btn"
                type="button"
                onClick={() => onToggleViewMode('grid')}
                className={`p-1.5 rounded-md text-xs transition-colors ${
                  viewMode === 'grid'
                    ? 'fr-chip-active shadow-xs'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
                title="Grid Card View"
                aria-label="Switch to Grid View"
              >
                <LayoutGrid className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
              <button
                id="view-mode-table-btn"
                type="button"
                onClick={() => onToggleViewMode('table')}
                className={`p-1.5 rounded-md text-xs transition-colors ${
                  viewMode === 'table'
                    ? 'fr-chip-active shadow-xs'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
                title="Compact Table View"
                aria-label="Switch to Table View"
              >
                <List className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </div>

            {/* Theme toggle (desktop; phones find it in the More menu) */}
            <button
              id="theme-toggle-btn"
              type="button"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              className="hidden md:inline-flex p-1.5 text-slate-300 hover:text-slate-100 bg-slate-950/[0.04] dark:bg-white/[0.04] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.08] border border-slate-950/10 dark:border-white/[0.08] rounded-lg transition-colors"
              title={theme === 'dark' ? t('theme.toLight') : t('theme.toDark')}
              aria-label={theme === 'dark' ? t('theme.toLight') : t('theme.toDark')}
              data-theme={theme}
            >
              {theme === 'dark' ? <Sun className="w-4 h-4" aria-hidden="true" /> : <Moon className="w-4 h-4" aria-hidden="true" />}
            </button>

            {/* More menu */}
            <div className="relative">
              <button
                id="header-more-menu-btn"
                type="button"
                onClick={() => setShowMoreMenu(!showMoreMenu)}
                className="p-1.5 text-slate-300 hover:text-slate-100 bg-slate-950/[0.04] dark:bg-white/[0.04] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.08] border border-slate-950/10 dark:border-white/[0.08] rounded-lg transition-colors"
                title={t('header.moreMenu')}
                aria-label={t('header.moreMenu')}
                aria-expanded={showMoreMenu}
                aria-haspopup="true"
              >
                <MoreHorizontal className="w-4 h-4" />
              </button>

              {showMoreMenu && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowMoreMenu(false)} aria-hidden="true" />
                  <div
                    id="header-more-dropdown"
                    className="absolute right-0 mt-1.5 w-60 bg-slate-800 border border-slate-950/10 dark:border-white/[0.12] rounded-xl shadow-2xl z-50 py-1 text-xs divide-y divide-slate-950/10 dark:divide-white/[0.06]"
                  >
                    {/* Phones: tabs, view mode + theme live here instead of the bar */}
                    <div className="py-1 md:hidden">
                      {onPageChange && (
                        <>
                          <p className="px-3 pt-1.5 pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400 flex items-center gap-1.5">
                            <Layers className="w-3 h-3" />
                            Section
                          </p>
                          <div className="px-3 pb-1 flex items-center gap-1.5">
                            <button
                              type="button"
                              aria-pressed={page === 'catalog'}
                              onClick={() => {
                                onPageChange('catalog');
                                setShowMoreMenu(false);
                              }}
                              className={`flex-1 inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-md border transition-colors ${
                                page === 'catalog'
                                  ? 'fr-chip-active font-semibold'
                                  : 'text-slate-200 bg-slate-950/[0.06] dark:bg-white/[0.06] border-slate-950/10 dark:border-white/[0.08]'
                              }`}
                            >
                              <span>Apps</span>
                            </button>
                            <button
                              type="button"
                              aria-pressed={page === 'combos'}
                              onClick={() => {
                                onPageChange('combos');
                                setShowMoreMenu(false);
                              }}
                              className={`flex-1 inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-md border transition-colors ${
                                page === 'combos'
                                  ? 'fr-chip-active font-semibold'
                                  : 'text-slate-200 bg-slate-950/[0.06] dark:bg-white/[0.06] border-slate-950/10 dark:border-white/[0.08]'
                              }`}
                            >
                              <Layers className="w-3.5 h-3.5" aria-hidden="true" />
                              <span>Combos</span>
                            </button>
                          </div>
                        </>
                      )}

                      <p className="px-3 pt-1.5 pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400 flex items-center gap-1.5">
                        <LayoutGrid className="w-3 h-3" />
                        View
                      </p>
                      <div className="px-3 pb-1 flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            onToggleViewMode('grid');
                            setShowMoreMenu(false);
                          }}
                          className={`flex-1 inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-md border transition-colors ${
                            viewMode === 'grid'
                              ? 'fr-chip-active font-semibold'
                              : 'text-slate-200 bg-slate-950/[0.06] dark:bg-white/[0.06] border-slate-950/10 dark:border-white/[0.08]'
                          }`}
                        >
                          <LayoutGrid className="w-3.5 h-3.5" />
                          <span>Grid</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            onToggleViewMode('table');
                            setShowMoreMenu(false);
                          }}
                          className={`flex-1 inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-md border transition-colors ${
                            viewMode === 'table'
                              ? 'fr-chip-active font-semibold'
                              : 'text-slate-200 bg-slate-950/[0.06] dark:bg-white/[0.06] border-slate-950/10 dark:border-white/[0.08]'
                          }`}
                        >
                          <List className="w-3.5 h-3.5" />
                          <span>Table</span>
                        </button>
                      </div>

                      <p className="px-3 pt-1.5 pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400 flex items-center gap-1.5">
                        {theme === 'dark' ? <Sun className="w-3 h-3" /> : <Moon className="w-3 h-3" />}
                        Theme
                      </p>
                      <div className="px-3 pb-1.5 flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => setTheme('light')}
                          className={`flex-1 inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-md border transition-colors ${
                            theme === 'light'
                              ? 'fr-chip-active font-semibold'
                              : 'text-slate-200 bg-slate-950/[0.06] dark:bg-white/[0.06] border-slate-950/10 dark:border-white/[0.08]'
                          }`}
                        >
                          <Sun className="w-3.5 h-3.5" />
                          <span>Light</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setTheme('dark')}
                          className={`flex-1 inline-flex items-center justify-center gap-1 px-2 py-1.5 rounded-md border transition-colors ${
                            theme === 'dark'
                              ? 'fr-chip-active font-semibold'
                              : 'text-slate-200 bg-slate-950/[0.06] dark:bg-white/[0.06] border-slate-950/10 dark:border-white/[0.08]'
                          }`}
                        >
                          <Moon className="w-3.5 h-3.5" />
                          <span>Dark</span>
                        </button>
                      </div>
                    </div>

                    <div className="py-1">
                      {onOpenWhatsNew && (
                        <button
                          type="button"
                          onClick={() => {
                            setShowMoreMenu(false);
                            onOpenWhatsNew();
                          }}
                          className="w-full text-left px-3 py-1.5 text-slate-200 hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.08] flex items-center gap-2"
                        >
                          <Sparkles className="w-3.5 h-3.5 text-sky-400" />
                          <span>What's new</span>
                        </button>
                      )}

                      {onCheckForUpdates && (
                        <button
                          type="button"
                          onClick={() => {
                            setShowMoreMenu(false);
                            onCheckForUpdates();
                          }}
                          className="w-full text-left px-3 py-1.5 text-slate-200 hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.08] flex items-center gap-2"
                        >
                          <RefreshCw className="w-3.5 h-3.5 text-sky-400" />
                          <span>Check for updates</span>
                        </button>
                      )}

                      {onOpenBatchInstall && batchCount === 0 && (
                        <button
                          type="button"
                          onClick={() => {
                            setShowMoreMenu(false);
                            onOpenBatchInstall();
                          }}
                          className="w-full text-left px-3 py-1.5 text-slate-200 hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.08] flex items-center gap-2"
                        >
                          <Terminal className="w-3.5 h-3.5 text-sky-400" />
                          <span>{t('header.batchGenerator')}</span>
                        </button>
                      )}

                      {onOpenExportModal && (
                        <button
                          type="button"
                          onClick={() => {
                            setShowMoreMenu(false);
                            onOpenExportModal();
                          }}
                          className="w-full text-left px-3 py-1.5 text-slate-200 hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.08] flex items-center gap-2"
                        >
                          <Share2 className="w-3.5 h-3.5 text-emerald-400" />
                          <span>{t('header.exportReadme')}</span>
                        </button>
                      )}
                    </div>

                    <div className="py-1">
                      <button
                        type="button"
                        onClick={() => {
                          setShowMoreMenu(false);
                          onExportCatalog();
                        }}
                        className="w-full text-left px-3 py-1.5 text-slate-200 hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.08] flex items-center gap-2"
                      >
                        <FileDown className="w-3.5 h-3.5 text-sky-400" />
                        <span>{t('header.backup')}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          fileInputRef.current?.click();
                        }}
                        className="w-full text-left px-3 py-1.5 text-slate-200 hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.08] flex items-center gap-2"
                      >
                        <Upload className="w-3.5 h-3.5 text-emerald-400" />
                        <span>{t('header.restore')}</span>
                      </button>
                    </div>

                    {/* Download location (moved here from the old settings gear) */}
                    <div className="px-3 pt-2.5 pb-2.5 border-b border-slate-950/10 dark:border-white/[0.06]">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 flex items-center gap-1.5 mb-1.5">
                        <Folder className="w-3 h-3" />
                        {t('settings.downloadFolder')}
                      </p>
                      <code
                        className="block w-full truncate text-[10px] font-mono text-slate-300 bg-slate-950/[0.06] dark:bg-white/[0.06] border border-slate-950/10 dark:border-white/[0.08] rounded px-1.5 py-1 mb-1.5"
                        dir="ltr"
                        title={downloadDir || ''}
                      >
                        {downloadDir || '…'}
                      </code>
                      {canPickFolder ? (
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => void chooseFolder()}
                            className="flex-1 inline-flex items-center justify-center gap-1 bg-sky-600 hover:bg-sky-500 text-white px-2 py-1 rounded-md font-semibold border border-sky-500 transition-colors"
                          >
                            <FolderOpen className="w-3 h-3" />
                            <span>{t('settings.changeFolder')}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => void resetFolder()}
                            className="inline-flex items-center justify-center gap-1 text-slate-300 hover:text-slate-100 bg-slate-950/[0.06] dark:bg-white/[0.06] hover:bg-slate-950/[0.1] dark:hover:bg-white/[0.1] border border-slate-950/10 dark:border-white/[0.08] px-2 py-1 rounded-md transition-colors"
                            title="Use the system Downloads folder"
                          >
                            <RotateCcw className="w-3 h-3" />
                            <span>{t('settings.resetFolder')}</span>
                          </button>
                        </div>
                      ) : (
                        <p className="text-[10px] text-slate-400 leading-snug">
                          {t('settings.androidFolderNote')}
                        </p>
                      )}
                    </div>

                    <div className="py-1">
                      <p className="px-3 pt-1.5 pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400 flex items-center gap-1.5">
                        <Globe className="w-3 h-3" />
                        {t('header.language')}
                      </p>
                      {LANGUAGES.map((l) => (
                        <button
                          key={l.code}
                          type="button"
                          onClick={() => setLang(l.code)}
                          className={`w-full text-left px-3 py-1.5 flex items-center justify-between hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.08] ${
                            lang === l.code ? 'text-sky-400 font-semibold' : 'text-slate-200'
                          }`}
                        >
                          <span>{l.native}</span>
                          {lang === l.code && <Check className="w-3.5 h-3.5" />}
                        </button>
                      ))}
                    </div>

                    <div className="py-1">
                      <button
                        type="button"
                        onClick={() => {
                          setShowMoreMenu(false);
                          onOpenTauriModal();
                        }}
                        className="w-full text-left px-3 py-1.5 text-slate-200 hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.08] flex items-center gap-2"
                      >
                        <Download className="w-3.5 h-3.5 text-amber-400" />
                        <span>{t('header.packageGuide')}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setShowMoreMenu(false);
                          onOpenShortcutsModal();
                        }}
                        className="w-full text-left px-3 py-1.5 text-slate-200 hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.08] flex items-center gap-2"
                      >
                        <Keyboard className="w-3.5 h-3.5 text-slate-400" />
                        <span>{t('header.shortcuts')}</span>
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>

            <input
              id="hidden-catalog-file-input"
              ref={fileInputRef}
              type="file"
              accept=".json"
              onChange={handleFileSelected}
              className="hidden"
              aria-hidden="true"
            />
          </div>
        </div>
      </div>
    </header>
  );
};
