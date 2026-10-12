// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
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
  Replace,
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
import { useDownloadState, useDownloadActions, isAndroidWebview } from '../lib/downloads';
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
  page?: 'catalog' | 'replace';
  onPageChange?: (page: 'catalog' | 'replace') => void;
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
  /** Live delivery status for the pill: label override + busy flag.
   * Null = show the default "Update {v}" text. */
  updatePillStatus?: { label: string; busy: boolean } | null;
  onUpdateClick?: () => void;
  onCheckForUpdates?: () => void;
  onOpenWhatsNew?: () => void;
  /** Which prerelease roughness the in-app updater reports. */
  updateChannel?: 'stable' | 'beta' | 'alpha';
  onUpdateChannelChange?: (channel: 'stable' | 'beta' | 'alpha') => void;
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

/* Shared More-menu styling: one look for every row, label and chip. */
const MORE_ITEM =
  'w-full text-start px-3 py-2 flex items-center gap-2 text-xs text-fr-text hover:bg-fr-bg transition-colors';
const MORE_LABEL =
  'px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-fr-text-muted flex items-center gap-1.5';
const MORE_CHIP_ON =
  'flex-1 inline-flex items-center justify-center gap-1 px-2 py-2 rounded-md border text-xs fr-chip-active font-semibold transition-colors';
const MORE_CHIP_OFF =
  'flex-1 inline-flex items-center justify-center gap-1 px-2 py-2 rounded-md border text-xs text-fr-text bg-fr-bg border-fr-border transition-colors';

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
  updatePillStatus = null,
  onUpdateClick,
  onCheckForUpdates,
  onOpenWhatsNew,
  updateChannel = 'alpha',
  onUpdateChannelChange,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const { theme, setTheme } = useTheme();
  // Split contexts: state re-renders on every progress tick, actions never change.
  const { activeCount, downloadDir } = useDownloadState();
  const { chooseFolder, resetFolder } = useDownloadActions();
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

  // Close the More menu on Escape and hand focus back to its button, so
  // keyboard users do not fall back to the top of the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && showMoreMenu) {
        setShowMoreMenu(false);
        moreBtnRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showMoreMenu]);

  return (
    <>
      {/* Skip link: first focusable element on the page, lands on #main-content */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:start-2 focus:z-[70] focus:inline-flex focus:items-center focus:h-[var(--fr-h-primary)] focus:px-3 focus:rounded-lg focus:bg-fr-primary focus:text-white focus:text-xs focus:font-semibold focus:shadow-lg"
      >
        {t('a11y.skipToContent')}
      </a>

      <header
        id="main-app-header"
        className="fixed inset-x-0 top-0 z-30 md:sticky border-b border-fr-border bg-fr-surface"
      >
        <div className="fr-shell py-2">
          {/*
            Two-tier action hierarchy.
            Mobile (<md):   row 1 = brand · Add App · Downloads · More
                            row 2 = search (and the update pill, when one exists)
            Desktop (>=md): brand · update pill · search · Add App · Downloads
                            · [secondary: tabs · view toggle · More]
            Search always gets an equivalent route to every control: the More
            menu exists on every screen size.
          */}
          <div
            id="header-content-row"
            className="flex flex-wrap items-center gap-x-1.5 gap-y-2 md:flex-nowrap md:gap-x-3"
          >
            {/* ---- Primary group: brand ---- */}
            <div id="header-brand-group" className="order-1 flex items-center gap-2 shrink-0 min-w-0">
              <BrandMark size={32} />
              <span id="header-brand-title" className="font-extrabold text-base text-fr-text tracking-tight">
                Fress
              </span>
              <span
                id="header-version-chip"
                className="hidden min-[420px]:inline-block text-[11px] font-mono font-semibold tracking-wide text-fr-text-muted bg-fr-bg border border-fr-border px-1.5 py-0.5 rounded"
                title={t('header.versionTitle')}
              >
                v{pkg.version}
              </span>
            </div>

            {/* ---- Primary group: Add App (dominant) + Downloads ---- */}
            <div id="header-actions-group" className="order-2 md:order-4 flex items-center gap-1.5 md:gap-2 shrink-0 ml-auto md:ml-0">
              <button
                id="header-add-app-btn"
                type="button"
                onClick={onOpenAddApps}
                className="inline-flex items-center justify-center gap-1.5 h-[var(--fr-h-primary)] max-md:h-[var(--fr-touch-target)] bg-fr-primary hover:bg-fr-primary-hover text-white text-xs font-semibold px-3 max-md:px-2.5 rounded-lg border border-fr-primary-hover transition-colors shadow-xs"
                title={t('header.addAppTitle')}
              >
                <Plus className="w-4 h-4" aria-hidden="true" />
                <span>{t('header.addApp')}</span>
              </button>

              <button
                id="header-downloads-btn"
                type="button"
                onClick={onOpenDownloads}
                className="relative inline-flex items-center justify-center gap-1.5 h-[var(--fr-h-primary)] max-md:h-[var(--fr-touch-target)] max-md:w-[var(--fr-touch-target)] max-md:px-0 text-xs font-medium text-fr-text bg-fr-bg hover:bg-fr-bg border border-fr-border hover:border-fr-border-strong px-2.5 rounded-lg transition-colors"
                title={t('header.downloads')}
                aria-label={`${t('header.downloads')}${downloadBadge > 0 ? ` (${downloadBadge})` : ''}`}
              >
                <DownloadCloud className="w-4 h-4" aria-hidden="true" />
                {/* Label from md up only: at sm-md widths (e.g. 1366px at
                    200% browser zoom = 683 CSS px) the brand, search, Add
                    app, Downloads and More cannot share one row - the label
                    clipped mid-word against the More button. The icon-only
                    button (title + aria-label carry the name) matches the
                    phone treatment. */}
                <span className="hidden md:inline">{t('header.downloads')}</span>
                {downloadBadge > 0 && (
                  <span
                    id="downloads-active-badge"
                    className="absolute -top-1.5 -end-1.5 min-w-[16px] h-4 px-1 rounded-full bg-fr-primary-hover text-white text-[11px] font-bold flex items-center justify-center"
                  >
                    {downloadBadge}
                  </span>
                )}
              </button>

              {onOpenBatchInstall && batchCount > 0 && (
                <button
                  type="button"
                  id="header-batch-btn"
                  onClick={onOpenBatchInstall}
                  className="inline-flex items-center gap-1 h-[var(--fr-h-primary)] max-md:h-[var(--fr-touch-target)] bg-sky-800/[0.08] text-sky-900 border border-sky-800/25 dark:bg-sky-500/20 dark:text-sky-300 dark:border-sky-500/40 hover:bg-sky-800/[0.14] dark:hover:bg-sky-500/30 text-xs font-medium px-2.5 rounded-lg transition-colors"
                  title={t('header.batchTitle')}
                >
                  <Terminal className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>{t('header.batchPill').replace('{n}', String(batchCount))}</span>
                </button>
              )}

              {onOpenCompare && compareCount > 0 && (
                <button
                  type="button"
                  id="header-compare-btn"
                  onClick={onOpenCompare}
                  className="inline-flex items-center gap-1 h-[var(--fr-h-primary)] max-md:h-[var(--fr-touch-target)] bg-indigo-500/20 text-indigo-300 border border-indigo-500/40 hover:bg-indigo-500/30 text-xs font-medium px-2.5 rounded-lg transition-colors"
                  title={t('header.compareTitle')}
                >
                  <Columns className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>{t('header.comparePill').replace('{n}', String(compareCount))}</span>
                </button>
              )}
            </div>

            {/* ---- Secondary group: tabs + view toggle (desktop) and the More menu (every size) ---- */}
            <div id="header-secondary-group" className="order-3 md:order-5 flex items-center gap-2 shrink-0">
              {onPageChange && (
                <div
                  id="page-tabs"
                  role="tablist"
                  aria-label={t('header.sectionsAria')}
                  className="hidden lg:flex items-center bg-fr-bg border border-fr-border p-0.5 rounded-lg"
                >
                  <button
                    id="page-catalog-btn"
                    type="button"
                    role="tab"
                    aria-selected={page === 'catalog'}
                    onClick={() => onPageChange('catalog')}
                    className={`h-[var(--fr-h-secondary)] px-2.5 rounded-md text-xs font-medium transition-colors ${
                      page === 'catalog' ? 'fr-chip-active shadow-xs' : 'text-fr-text-muted hover:text-fr-text'
                    }`}
                    title={t('header.browseCatalog')}
                  >
                    {t('header.tabApps')}
                  </button>
                  <button
                    id="page-replace-btn"
                    type="button"
                    role="tab"
                    aria-selected={page === 'replace'}
                    onClick={() => onPageChange('replace')}
                    className={`inline-flex items-center gap-1 h-[var(--fr-h-secondary)] px-2.5 rounded-md text-xs font-medium transition-colors ${
                      page === 'replace' ? 'fr-chip-active shadow-xs' : 'text-fr-text-muted hover:text-fr-text'
                    }`}
                    title={t('header.privacyPackTitle')}
                  >
                    <Replace className="w-3.5 h-3.5" aria-hidden="true" />
                    {t('header.tabPrivacy')}
                  </button>
                </div>
              )}

              <div
                id="view-mode-toggle"
                className={`hidden md:flex items-center bg-fr-bg border border-fr-border p-0.5 rounded-lg ${
                  page !== 'catalog' ? 'md:hidden' : ''
                }`}
              >
                <button
                  id="view-mode-grid-btn"
                  type="button"
                  onClick={() => onToggleViewMode('grid')}
                  aria-pressed={viewMode === 'grid'}
                  className={`inline-flex items-center justify-center h-[var(--fr-h-secondary)] w-[var(--fr-h-secondary)] rounded-md transition-colors ${
                    viewMode === 'grid' ? 'fr-chip-active shadow-xs' : 'text-fr-text-muted hover:text-fr-text'
                  }`}
                  title={t('header.gridView')}
                  aria-label={t('header.gridViewAria')}
                >
                  <LayoutGrid className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
                <button
                  id="view-mode-table-btn"
                  type="button"
                  onClick={() => onToggleViewMode('table')}
                  aria-pressed={viewMode === 'table'}
                  className={`inline-flex items-center justify-center h-[var(--fr-h-secondary)] w-[var(--fr-h-secondary)] rounded-md transition-colors ${
                    viewMode === 'table' ? 'fr-chip-active shadow-xs' : 'text-fr-text-muted hover:text-fr-text'
                  }`}
                  title={t('header.tableView')}
                  aria-label={t('header.tableViewAria')}
                >
                  <List className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </div>

              {/* More menu: the single route to every secondary action */}
              <div className="relative">
                <button
                  id="header-more-menu-btn"
                  ref={moreBtnRef}
                  type="button"
                  onClick={() => setShowMoreMenu(!showMoreMenu)}
                  className="inline-flex items-center justify-center h-[var(--fr-h-secondary)] w-[var(--fr-h-secondary)] max-md:h-[var(--fr-touch-target)] max-md:w-[var(--fr-touch-target)] text-fr-text bg-fr-bg hover:bg-fr-bg border border-fr-border hover:border-fr-border-strong rounded-lg transition-colors"
                  title={t('header.moreMenu')}
                  aria-label={t('header.moreMenu')}
                  aria-expanded={showMoreMenu}
                  aria-controls="header-more-dropdown"
                  aria-haspopup="true"
                >
                  <MoreHorizontal className="w-4 h-4" aria-hidden="true" />
                </button>

                {showMoreMenu && (
                  <>
                    {/* Outside click closes the menu */}
                    <div className="fixed inset-0 z-40" onClick={() => setShowMoreMenu(false)} aria-hidden="true" />
                    <div
                      id="header-more-dropdown"
                      aria-label={t('header.moreMenu')}
                      className="absolute end-0 mt-1.5 w-60 max-w-[calc(100vw-2rem)] max-h-[min(75vh,640px)] overflow-y-auto overscroll-contain bg-fr-surface-elevated border border-fr-border-strong rounded-xl shadow-2xl z-50 py-1 text-xs divide-y divide-fr-border"
                    >
                      {/* Phones and tablets: section tabs + view mode live here */}
                      <div className="py-1 lg:hidden">
                        {onPageChange && (
                          <>
                            <p id="more-menu-section-label" className={MORE_LABEL}>
                              <LayoutGrid className="w-3 h-3" aria-hidden="true" />
                              {t('header.section')}
                            </p>
                            <div className="px-3 pb-1 grid grid-cols-2 items-center gap-1.5" role="group" aria-labelledby="more-menu-section-label">
                              <button
                                type="button"
                                aria-pressed={page === 'catalog'}
                                onClick={() => {
                                  onPageChange('catalog');
                                  setShowMoreMenu(false);
                                }}
                                className={page === 'catalog' ? MORE_CHIP_ON : MORE_CHIP_OFF}
                                title={t('header.browseCatalog')}
                              >
                                <span>{t('header.tabApps')}</span>
                              </button>
                              <button
                                type="button"
                                aria-pressed={page === 'replace'}
                                onClick={() => {
                                  onPageChange('replace');
                                  setShowMoreMenu(false);
                                }}
                                className={page === 'replace' ? MORE_CHIP_ON : MORE_CHIP_OFF}
                                title={t('header.privacyPackTitle')}
                              >
                                <Replace className="w-3.5 h-3.5" aria-hidden="true" />
                                <span>{t('header.tabPrivacy')}</span>
                              </button>
                            </div>
                          </>
                        )}

                        <p id="more-menu-view-label" className={MORE_LABEL}>
                          <LayoutGrid className="w-3 h-3" aria-hidden="true" />
                          {t('header.view')}
                        </p>
                        <div className="px-3 pb-1 flex items-center gap-1.5" role="group" aria-labelledby="more-menu-view-label">
                          <button
                            type="button"
                            aria-pressed={viewMode === 'grid'}
                            onClick={() => {
                              onToggleViewMode('grid');
                              setShowMoreMenu(false);
                            }}
                            className={viewMode === 'grid' ? MORE_CHIP_ON : MORE_CHIP_OFF}
                          >
                            <LayoutGrid className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>{t('header.grid')}</span>
                          </button>
                          <button
                            type="button"
                            aria-pressed={viewMode === 'table'}
                            onClick={() => {
                              onToggleViewMode('table');
                              setShowMoreMenu(false);
                            }}
                            className={viewMode === 'table' ? MORE_CHIP_ON : MORE_CHIP_OFF}
                          >
                            <List className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>{t('header.table')}</span>
                          </button>
                        </div>
                      </div>

                      <div className="py-1">
                        <p className={MORE_LABEL}>
                          <Folder className="w-3 h-3" aria-hidden="true" />
                          {t('menu.catalog')}
                        </p>

                        <button
                          type="button"
                          onClick={() => {
                            setShowMoreMenu(false);
                            onExportCatalog();
                          }}
                          className={MORE_ITEM}
                        >
                          <FileDown className="w-3.5 h-3.5 text-fr-primary shrink-0" aria-hidden="true" />
                          <span>{t('header.backup')}</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            setShowMoreMenu(false);
                            fileInputRef.current?.click();
                          }}
                          className={MORE_ITEM}
                        >
                          <Upload className="w-3.5 h-3.5 text-fr-success shrink-0" aria-hidden="true" />
                          <span>{t('header.restore')}</span>
                        </button>

                        {onOpenExportModal && (
                          <button
                            type="button"
                            onClick={() => {
                              setShowMoreMenu(false);
                              onOpenExportModal();
                            }}
                            className={MORE_ITEM}
                          >
                            <Share2 className="w-3.5 h-3.5 text-fr-success shrink-0" aria-hidden="true" />
                            <span>{t('header.exportReadme')}</span>
                          </button>
                        )}

                        {onOpenBatchInstall && batchCount === 0 && (
                          <button
                            type="button"
                            onClick={() => {
                              setShowMoreMenu(false);
                              onOpenBatchInstall();
                            }}
                            className={MORE_ITEM}
                          >
                            <Terminal className="w-3.5 h-3.5 text-fr-primary shrink-0" aria-hidden="true" />
                            <span>{t('header.batchGenerator')}</span>
                          </button>
                        )}
                      </div>

                      <div className="py-1">
                        <p className={MORE_LABEL}>
                          <RefreshCw className="w-3 h-3" aria-hidden="true" />
                          {t('menu.updates')}
                        </p>

                        {onOpenWhatsNew && (
                          <button
                            type="button"
                            onClick={() => {
                              setShowMoreMenu(false);
                              onOpenWhatsNew();
                            }}
                            className={MORE_ITEM}
                          >
                            <Sparkles className="w-3.5 h-3.5 text-fr-primary shrink-0" aria-hidden="true" />
                            <span>{t('header.whatsNew')}</span>
                          </button>
                        )}

                        {onCheckForUpdates && (
                          <button
                            type="button"
                            onClick={() => {
                              setShowMoreMenu(false);
                              onCheckForUpdates();
                            }}
                            className={MORE_ITEM}
                          >
                            <RefreshCw className="w-3.5 h-3.5 text-fr-primary shrink-0" aria-hidden="true" />
                            <span>{t('header.checkUpdates')}</span>
                          </button>
                        )}

                        {onUpdateChannelChange && (
                          // Update channel: which roughness of build the
                          // updater reports. Stable hides prereleases once a
                          // stable 1.0 exists; Alpha sees everything.
                          <div className="px-3 py-2 mt-1">
                            <p className="text-[11px] text-fr-text-muted mb-1.5">{t('header.updateChannel')}</p>
                            <div className="flex gap-1">
                              {(['stable', 'beta', 'alpha'] as const).map((ch) => (
                                <button
                                  key={ch}
                                  type="button"
                                  onClick={() => onUpdateChannelChange(ch)}
                                  aria-pressed={updateChannel === ch}
                                  className={`flex-1 px-2 py-1.5 rounded-md border text-[11px] capitalize transition-colors ${
                                    updateChannel === ch
                                      ? 'fr-chip-active font-semibold'
                                      : 'text-fr-text bg-fr-bg border-fr-border'
                                  }`}
                                >
                                  {ch}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Download location (moved here from the old settings gear) */}
                      <div className="px-3 pt-2.5 pb-2.5">
                        <p className={MORE_LABEL}>
                          <Folder className="w-3 h-3" aria-hidden="true" />
                          {t('settings.downloadFolder')}
                        </p>
                        <code
                          className="block w-full truncate text-[10px] font-mono text-fr-text-muted bg-fr-bg border border-fr-border rounded px-1.5 py-1 mb-1.5"
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
                              className="flex-1 inline-flex items-center justify-center gap-1 h-[var(--fr-h-secondary)] bg-fr-primary hover:bg-fr-primary-hover text-white px-2 rounded-md font-semibold border border-fr-primary-hover transition-colors text-[11px] whitespace-nowrap"
                            >
                              <FolderOpen className="w-3 h-3" aria-hidden="true" />
                              <span>{t('settings.changeFolder')}</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => void resetFolder()}
                              className="inline-flex items-center justify-center gap-1 h-[var(--fr-h-secondary)] text-fr-text bg-fr-bg hover:bg-fr-bg border border-fr-border hover:border-fr-border-strong px-2 rounded-md transition-colors text-[11px] whitespace-nowrap"
                              title={t('header.systemDownloads')}
                            >
                              <RotateCcw className="w-3 h-3" aria-hidden="true" />
                              <span>{t('settings.resetFolder')}</span>
                            </button>
                          </div>
                        ) : (
                          <p className="text-[10px] text-fr-text-muted leading-snug">
                            {t('settings.androidFolderNote')}
                          </p>
                        )}
                      </div>

                      <div className="py-1">
                        <p className={MORE_LABEL}>
                          <Globe className="w-3 h-3" aria-hidden="true" />
                          {t('header.language')}
                        </p>
                        {LANGUAGES.map((l) => (
                          <button
                            key={l.code}
                            type="button"
                            onClick={() => setLang(l.code)}
                            aria-pressed={lang === l.code}
                            className={`w-full text-start px-3 py-2 flex items-center justify-between hover:bg-fr-bg transition-colors ${
                              lang === l.code ? 'text-fr-primary font-semibold' : 'text-fr-text'
                            }`}
                          >
                            <span>{l.native}</span>
                            {lang === l.code && <Check className="w-3.5 h-3.5" aria-hidden="true" />}
                          </button>
                        ))}
                      </div>

                      <div className="py-1">
                        <p className={MORE_LABEL}>
                          {theme === 'dark' ? (
                            <Sun className="w-3 h-3" aria-hidden="true" />
                          ) : (
                            <Moon className="w-3 h-3" aria-hidden="true" />
                          )}
                          {t('header.theme')}
                        </p>
                        <div className="px-3 pb-1.5 flex items-center gap-1.5" role="group" aria-label={t('header.theme')}>
                          <button
                            type="button"
                            onClick={() => { setTheme('light'); setShowMoreMenu(false); }}
                            aria-pressed={theme === 'light'}
                            className={theme === 'light' ? MORE_CHIP_ON : MORE_CHIP_OFF}
                          >
                            <Sun className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>{t('header.light')}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => { setTheme('dark'); setShowMoreMenu(false); }}
                            aria-pressed={theme === 'dark'}
                            className={theme === 'dark' ? MORE_CHIP_ON : MORE_CHIP_OFF}
                          >
                            <Moon className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>{t('header.dark')}</span>
                          </button>
                        </div>
                      </div>

                      <div className="py-1">
                        <p className={MORE_LABEL}>
                          <Keyboard className="w-3 h-3" aria-hidden="true" />
                          {t('menu.help')}
                        </p>
                        <button
                          type="button"
                          onClick={() => {
                            setShowMoreMenu(false);
                            onOpenTauriModal();
                          }}
                          className={MORE_ITEM}
                        >
                          <Download className="w-3.5 h-3.5 text-fr-warning shrink-0" aria-hidden="true" />
                          <span>{t('header.packageGuide')}</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            setShowMoreMenu(false);
                            onOpenShortcutsModal();
                          }}
                          className={MORE_ITEM}
                        >
                          <Keyboard className="w-3.5 h-3.5 text-fr-text-muted shrink-0" aria-hidden="true" />
                          <span>{t('header.shortcuts')}</span>
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* ---- Update pill: own line on phones, inline after the brand on desktop ---- */}
            {updateVersion && (
              <button
                id="header-update-pill"
                type="button"
                onClick={onUpdateClick}
                className="order-4 md:order-2 max-md:basis-full max-md:justify-center inline-flex items-center gap-1 self-center text-[11px] font-bold text-amber-950 bg-amber-400 hover:brightness-105 border border-amber-400 dark:text-amber-900 dark:bg-amber-300 dark:hover:bg-amber-200 px-2 py-1 rounded-lg transition-colors"
                title={
                  /* The tooltip must tell the same truth as the visible
                   * label: while a delivery state override is active
                   * (busy / verified / retry / see-releases after a
                   * plan-level refusal), the override label IS the
                   * honest description of what the pill does - the static
                   * "tap to download" hint would contradict the
                   * see-releases label on a refused update. */
                  updatePillStatus
                    ? updatePillStatus.label
                    : t('header.updatePillTitle').replace('{v}', updateVersion)
                }
              >
                <Download className="w-3 h-3" aria-hidden="true" />
                <span>
                  {updatePillStatus
                    ? updatePillStatus.label
                    : t('header.updatePill').replace('{v}', updateVersion)}
                </span>
              </button>
            )}

            {/* ---- Primary group: search ---- */}
            <div
              id="header-search-wrapper"
              className="order-5 md:order-3 max-md:basis-full min-w-0 md:flex-1 md:max-w-lg relative"
            >
              <label htmlFor="app-search-input" className="sr-only">
                {t('header.search')} Ctrl+K
              </label>
              <div className="relative">
                <Search
                  id="search-icon-indicator"
                  className="w-4 h-4 text-fr-text-muted absolute start-3 top-1/2 -translate-y-1/2 pointer-events-none"
                  aria-hidden="true"
                />
                <input
                  id="app-search-input"
                  type="text"
                  value={searchQuery}
                  onChange={(e) => onSearchChange(e.target.value)}
                  placeholder={t('header.searchPlaceholder')}
                  className="w-full h-[var(--fr-h-input)] bg-fr-surface-elevated border border-fr-border hover:border-fr-border-strong text-fr-text placeholder:text-fr-text-muted text-xs rounded-lg ps-9 pe-20 transition-colors focus:outline-none focus:ring-2 focus:ring-fr-focus focus:border-fr-focus"
                />
                <div className="absolute end-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                  {searchQuery && (
                    <button
                      id="clear-search-btn"
                      type="button"
                      onClick={() => onSearchChange('')}
                      aria-label={t('header.clearSearch')}
                      className="text-fr-text-muted hover:text-fr-text p-0.5"
                    >
                      <X className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                  )}
                  {onOpenCommandPalette && (
                    <button
                      type="button"
                      onClick={onOpenCommandPalette}
                      className="text-[11px] font-mono bg-fr-bg hover:bg-fr-bg border border-fr-border hover:border-fr-border-strong text-fr-text px-1.5 py-0.5 rounded transition-colors"
                      title={t('header.openPalette')}
                    >
                      Ctrl+K
                    </button>
                  )}
                </div>
              </div>
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
      </header>
    </>
  );
};
