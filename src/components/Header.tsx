import React, { useEffect, useRef, useState } from 'react';
import {
  Search,
  Plus,
  Download,
  ShieldCheck,
  Keyboard,
  X,
  Upload,
  FileDown,
  LayoutGrid,
  List,
  Terminal,
  Columns,
  Share2,
  Sparkles,
  MoreHorizontal,
  Sun,
  Moon,
  Settings,
  DownloadCloud,
  Globe,
  Check,
  Folder,
  FolderOpen,
  RotateCcw,
} from 'lucide-react';
import { useTheme } from './ThemeProvider';
import { useDownloadActions, useActiveDownloadCount, useDownloadDir, isTauri } from '../lib/downloads';
import { LANGUAGES, useI18n } from '../lib/i18n';
import { invoke } from '@tauri-apps/api/core';

interface HeaderProps {
  searchQuery: string;
  onSearchChange: (value: string) => void;
  onOpenLiveSearch: () => void;
  onOpenAddModal: () => void;
  onOpenTauriModal: (tab?: 'install' | 'why' | 'build') => void;
  onOpenPrivacyModal: () => void;
  onOpenShortcutsModal: () => void;
  onExportCatalog: () => void;
  onImportCatalog: (importedJson: string) => void;
  viewMode: 'grid' | 'table';
  onToggleViewMode: (mode: 'grid' | 'table') => void;
  onOpenCommandPalette?: () => void;
  onOpenBatchInstall?: () => void;
  onOpenCompare?: () => void;
  onOpenExportModal?: () => void;
  onOpenDownloads?: () => void;
  batchCount?: number;
  compareCount?: number;
  activeDownloadCount?: number;
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
  onOpenLiveSearch,
  onOpenAddModal,
  onOpenTauriModal,
  onOpenPrivacyModal,
  onOpenShortcutsModal,
  onExportCatalog,
  onImportCatalog,
  viewMode,
  onToggleViewMode,
  onOpenCommandPalette,
  onOpenBatchInstall,
  onOpenCompare,
  onOpenExportModal,
  onOpenDownloads,
  batchCount = 0,
  compareCount = 0,
  activeDownloadCount = 0,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [appVersion, setAppVersion] = useState<string>('');
  const { theme, setTheme } = useTheme();
  const { chooseFolder, resetFolder } = useDownloadActions();
  const activeCount = useActiveDownloadCount();
  const downloadDir = useDownloadDir();
  const { t, lang, setLang } = useI18n();

  // The Rust command exists since the first download engine; now it is
  // actually visible so users can tell which build they are running.
  useEffect(() => {
    if (!isTauri()) return;
    invoke<string>('app_version')
      .then((v) => setAppVersion(v))
      .catch(() => undefined);
  }, []);

  const downloadBadge = activeDownloadCount ?? activeCount;

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
        setShowSettings(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <header id="main-app-header" className="border-b border-slate-950/10 dark:border-white/[0.08] bg-slate-900/95 backdrop-blur-md sticky top-0 z-30">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-2.5">
        <div id="header-content-row" className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 flex-wrap">

          {/* Brand: app icon + name, nothing else */}
          <div id="header-brand-group" className="flex items-center gap-2.5 shrink-0">
            <BrandMark size={32} />
            <span id="header-brand-title" className="font-extrabold text-base text-slate-100 tracking-tight">
              Fress
            </span>
            <span className="text-[11px] font-mono font-semibold uppercase tracking-wide text-slate-400 bg-slate-950/[0.05] dark:bg-white/[0.05] border border-slate-950/10 dark:border-white/[0.08] px-1.5 py-0.5 rounded">
              {t('common.beta')}
            </span>
          </div>

          {/* Search bar & Cmd+K quick launcher */}
          <div id="header-search-wrapper" className="flex-1 max-w-lg relative min-w-[200px]">
            <label htmlFor="app-search-input" className="sr-only">
              {t('header.search')} Ctrl+K
            </label>
            <div className="relative">
              <Search
                id="search-icon-indicator"
                className="w-4 h-4 text-slate-400 absolute start-3 top-1/2 -translate-y-1/2 pointer-events-none"
                aria-hidden="true"
              />
              <input
                id="app-search-input"
                type="text"
                value={searchQuery}
                onChange={(e) => onSearchChange(e.target.value)}
                placeholder={t('header.searchPlaceholder')}
                className="w-full bg-slate-950/[0.04] dark:bg-white/[0.04] border border-slate-950/10 dark:border-white/[0.1] hover:border-slate-950/20 dark:hover:border-white/[0.2] text-slate-100 placeholder-slate-400 text-xs rounded-lg ps-9 pe-20 py-2 transition-colors focus:outline-none focus:ring-1 focus:ring-sky-500 focus:border-sky-500"
              />
              <div className="absolute end-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
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
                    aria-label="Open command palette (Ctrl+K)"
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
              id="header-live-search-btn"
              type="button"
              onClick={onOpenLiveSearch}
              className="inline-flex items-center gap-1.5 text-slate-400 hover:text-slate-200 text-xs font-medium px-3 py-1.5 rounded-lg hover:bg-slate-950/[0.05] dark:hover:bg-white/[0.05] transition-colors"
              title="Search any open-source tool live on GitHub and add it to your catalog"
            >
              <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{t('header.liveSearch')}</span>
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
                className="inline-flex items-center gap-1 bg-sky-500/20 text-sky-300 border border-sky-500/40 hover:bg-sky-500/30 text-xs font-medium px-2.5 py-1.5 rounded-lg transition-colors"
                title={t('header.batchGenerator')}
              >
                <Terminal className="w-3.5 h-3.5" />
                <span>{t('header.batch')} ({batchCount})</span>
              </button>
            )}

            {/* Compare pill */}
            {onOpenCompare && compareCount > 0 && (
              <button
                type="button"
                id="header-compare-btn"
                onClick={onOpenCompare}
                className="inline-flex items-center gap-1 bg-indigo-500/20 text-indigo-300 border border-indigo-500/40 hover:bg-indigo-500/30 text-xs font-medium px-2.5 py-1.5 rounded-lg transition-colors"
                title={t('shortcuts.compare')}
              >
                <Columns className="w-3.5 h-3.5" />
                <span>{t('shortcuts.compare')} ({compareCount})</span>
              </button>
            )}

            {/* View mode */}
            <div id="view-mode-toggle" className="flex items-center bg-slate-950/[0.04] dark:bg-white/[0.04] border border-slate-950/10 dark:border-white/[0.08] p-0.5 rounded-lg">
              <button
                id="view-mode-grid-btn"
                type="button"
                onClick={() => onToggleViewMode('grid')}
                className={`p-1.5 rounded-md text-xs transition-colors ${
                  viewMode === 'grid'
                    ? 'bg-sky-600 text-white shadow-xs'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
                title={t("header.gridView")}
                aria-label={t("header.gridView")}
                aria-pressed={viewMode === 'grid'}
              >
                <LayoutGrid className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
              <button
                id="view-mode-table-btn"
                type="button"
                onClick={() => onToggleViewMode('table')}
                className={`p-1.5 rounded-md text-xs transition-colors ${
                  viewMode === 'table'
                    ? 'bg-sky-600 text-white shadow-xs'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
                title={t("header.tableView")}
                aria-label={t("header.tableView")}
                aria-pressed={viewMode === 'table'}
              >
                <List className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </div>

            {/* Theme toggle: one button, icon always mirrors the real theme */}
            <button
              id="theme-toggle-btn"
              type="button"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              className="p-1.5 text-slate-300 hover:text-slate-100 bg-slate-950/[0.04] dark:bg-white/[0.04] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.08] border border-slate-950/10 dark:border-white/[0.08] rounded-lg transition-colors"
              title={theme === 'dark' ? t('theme.toLight') : t('theme.toDark')}
              aria-label={theme === 'dark' ? t('theme.toLight') : t('theme.toDark')}
              data-theme={theme}
            >
              {theme === 'dark' ? <Sun className="w-4 h-4" aria-hidden="true" /> : <Moon className="w-4 h-4" aria-hidden="true" />}
            </button>

            {/* Settings: language */}
            <div className="relative">
              <button
                id="header-settings-btn"
                type="button"
                onClick={() => setShowSettings(!showSettings)}
                className="p-1.5 text-slate-300 hover:text-slate-100 bg-slate-950/[0.04] dark:bg-white/[0.04] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.08] border border-slate-950/10 dark:border-white/[0.08] rounded-lg transition-colors"
                title={t('header.settings')}
                aria-label={t('header.settings')}
                aria-expanded={showSettings}
                aria-haspopup="true"
              >
                <Settings className="w-4 h-4" />
              </button>

              {showSettings && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowSettings(false)} aria-hidden="true" />
                  <div
                    id="header-settings-dropdown"
                    className="absolute end-0 mt-1.5 w-64 bg-slate-800 border border-slate-950/10 dark:border-white/[0.12] rounded-xl shadow-2xl z-50 py-1 text-xs"
                  >
                    {/* Download location */}
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
                    </div>

                    <p className="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400 flex items-center gap-1.5">
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
                    <p className="px-3 pt-2 pb-1.5 text-[10px] font-mono text-slate-500 border-t border-slate-950/10 dark:border-white/[0.06] mt-1">
                      Fress {appVersion || t('common.beta')}
                    </p>
                  </div>
                </>
              )}
            </div>

            {/* More menu */}
            <div className="relative">
              <button
                id="header-more-menu-btn"
                type="button"
                onClick={() => setShowMoreMenu(!showMoreMenu)}
                className="p-1.5 text-slate-300 hover:text-slate-100 bg-slate-950/[0.04] dark:bg-white/[0.04] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.08] border border-slate-950/10 dark:border-white/[0.08] rounded-lg transition-colors"
                title={t('header.moreMenu')}
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
                    className="absolute end-0 mt-1.5 w-52 bg-slate-800 border border-slate-950/10 dark:border-white/[0.12] rounded-xl shadow-2xl z-50 py-1 text-xs divide-y divide-slate-950/10 dark:divide-white/[0.06]"
                  >
                    <div className="py-1">
                      <button
                        type="button"
                        onClick={() => {
                          setShowMoreMenu(false);
                          onOpenAddModal();
                        }}
                        className="w-full text-left px-3 py-1.5 text-slate-200 hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.08] flex items-center gap-2"
                      >
                        <Plus className="w-3.5 h-3.5 text-sky-400" />
                        <span>{t('header.addManually')}</span>
                      </button>

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

                    <div className="py-1">
                      <button
                        type="button"
                        onClick={() => {
                          setShowMoreMenu(false);
                          onOpenTauriModal('install');
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
                          onOpenPrivacyModal();
                        }}
                        className="w-full text-left px-3 py-1.5 text-slate-200 hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.08] flex items-center gap-2"
                      >
                        <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                        <span>{t('header.privacyAudit')}</span>
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
