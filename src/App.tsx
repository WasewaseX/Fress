// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
/**
 * App shell - the composition layer.
 *
 * This file wires feature modules together; it deliberately holds almost
 * no logic of its own. Each responsibility lives in src/features/:
 *
 *   catalog/     app list + favorites state, filters, view preferences
 *   batch/       batch selection + batch download orchestration + bar UI
 *   compare/     compare selection + dock UI
 *   dialogs/     which modal is open (state only, no domain data)
 *   shortcuts/   the global keyboard map
 *   selfUpdate/  the in-app updater flow
 *   whatsNew/    the once-per-version release summary
 *
 * Cross-feature coordination (delete cleans up batch/compare/detail, save
 * closes the editor, ...) happens here so every feature stays independently
 * readable and testable. See docs/ARCHITECTURE-frontend.md.
 */
import { useCallback, useMemo } from 'react';
import { Toaster } from 'sonner';

import { Header } from './components/Header';
import { FilterBar } from './components/FilterBar';
import { SpotlightSection } from './components/SpotlightSection';
import { AppCard } from './components/AppCard';
import { TableView } from './components/TableView';
import { AppDetailModal } from './components/AppDetailModal';
import { AddAppModal } from './components/AddAppModal';
import { TauriModal } from './components/TauriModal';
import { LegalModals } from './components/LegalModals';
import { KeyboardShortcutsModal } from './components/KeyboardShortcutsModal';
import { OfflineIndicator } from './components/OfflineIndicator';
import { Footer } from './components/Footer';
import { CommandPalette } from './components/CommandPalette';
import { BatchInstallModal } from './components/BatchInstallModal';
import { CompareModal } from './components/CompareModal';
import { ExportModal } from './components/ExportModal';
import { LiveSearchModal } from './components/LiveSearchModal';
import { DownloadManager } from './components/DownloadManager';
import { WhatsNewModal } from './components/WhatsNewModal';
import { ReplaceTab } from './components/ReplaceTab';
import { ThemeProvider, useTheme } from './components/ThemeProvider';
import { I18nProvider } from './lib/i18n';
import { DownloadsProvider, useDownloadActions, useDownloadSummary } from './lib/downloads';
import { Category } from './types';

import { useAppCatalog, filterAndSortApps } from './features/catalog/useAppCatalog';
import { useCatalogFilters } from './features/catalog/useCatalogFilters';
import { useViewPreferences } from './features/catalog/useViewPreferences';
import { EmptyCatalogState } from './features/catalog/EmptyCatalogState';
import { useBatchSelection } from './features/batch/useBatchSelection';
import { BatchActionBar } from './features/batch/BatchActionBar';
import { useCompareSelection } from './features/compare/useCompareSelection';
import { CompareDock } from './features/compare/CompareDock';
import { useAppDialogs } from './features/dialogs/useAppDialogs';
import { useGlobalShortcuts } from './features/shortcuts/useGlobalShortcuts';
import { useSelfUpdate } from './features/selfUpdate/useSelfUpdate';
import { useWhatsNew } from './features/whatsNew/useWhatsNew';

function AppShell() {
  const { theme: uiTheme } = useTheme();
  // Focused subscriptions: the shell needs the actions and the active
  // count, NOT the live item list. Byte-count/ETA updates therefore do not
  // rerender the shell - and with memoized cards, not the grid either.
  const { startDownload } = useDownloadActions();
  const { activeCount: activeDownloadCount } = useDownloadSummary();

  // Feature state
  const catalog = useAppCatalog();
  const { filters, handleFilterChange, resetFilters } = useCatalogFilters();
  const { viewMode, page, toggleViewMode, changePage } = useViewPreferences();
  const dialogs = useAppDialogs();
  const batch = useBatchSelection(catalog.apps, () => dialogs.setIsDownloadsOpen(true));
  const compare = useCompareSelection(catalog.apps);
  const selfUpdate = useSelfUpdate(startDownload);
  const { showWhatsNew, setShowWhatsNew } = useWhatsNew();

  // Filtered and sorted applications
  const filteredApps = useMemo(
    () => filterAndSortApps(catalog.apps, filters, catalog.favorites),
    [catalog.apps, filters, catalog.favorites]
  );

  // Cross-feature coordination ------------------------------------------

  // Saving closes the editor (the modal itself owns its other close paths).
  // Stabilized so memoized cards do not see a new identity per render.
  const handleSaveApp = useCallback(
    (appToSave: Parameters<typeof catalog.saveApp>[0]) => {
      catalog.saveApp(appToSave);
      dialogs.setEditingApp(null);
    },
    [catalog.saveApp, dialogs.setEditingApp]
  );

  // Deleting cleans up every other surface that may hold the app.
  const handleDeleteApp = useCallback(
    (appId: string) => {
      catalog.deleteApp(appId);
      batch.removeIds([appId]);
      compare.removeApp(appId);
      dialogs.closeDetailIfApp(appId);
    },
    [catalog.deleteApp, batch.removeIds, compare.removeApp, dialogs.closeDetailIfApp]
  );

  const handleEditApp = useCallback(
    (app: Parameters<typeof dialogs.setEditingApp>[0]) => {
      dialogs.setEditingApp(app);
      dialogs.setIsAddModalOpen(true);
    },
    [dialogs.setEditingApp, dialogs.setIsAddModalOpen]
  );

  const openAddFlowSearch = useCallback(() => {
    dialogs.setEditingApp(null);
    dialogs.setAddFlow('search');
  }, [dialogs.setEditingApp, dialogs.setAddFlow]);

  // Keyboard map: same keys and guards as before, actions pulled from the
  // feature hooks on each render.
  useGlobalShortcuts({
    toggleCommandPalette: () => dialogs.setIsCommandPaletteOpen((prev) => !prev),
    closeAllDialogs: dialogs.closeAllDialogs,
    // '/' must not yank focus out of an open dialog to the search field.
    hasOpenOverlay: () => dialogs.anyOverlayOpen || showWhatsNew,
    openAddFlowSearch,
    toggleBatchInstallModal: () => dialogs.setIsBatchInstallModalOpen((prev) => !prev),
    toggleCompareModal: () => dialogs.setIsCompareModalOpen((prev) => !prev),
    toggleExportModal: () => dialogs.setIsExportModalOpen((prev) => !prev),
    openTauriModal: () => dialogs.setIsTauriModalOpen(true),
    toggleFavoritesOnly: () => handleFilterChange({ favoritesOnly: !filters.favoritesOnly }),
    toggleTrendingOnly: () => handleFilterChange({ trendingOnly: !filters.trendingOnly }),
    toggleOwnerPickOnly: () => handleFilterChange({ ownerPickOnly: !filters.ownerPickOnly }),
    toggleViewMode: () => toggleViewMode(viewMode === 'grid' ? 'table' : 'grid'),
  });

  // Membership as memoized Sets: O(1) lookups in the mapped list instead
  // of a fresh Array.includes per card and per render. Cheap by itself;
  // it matters once catalogs grow into the hundreds with large batch or
  // compare selections.
  const favoriteSet = useMemo(() => new Set(catalog.favorites), [catalog.favorites]);
  const selectedSet = useMemo(() => new Set(batch.selectedIds), [batch.selectedIds]);
  const comparedSet = useMemo(() => new Set(compare.comparedIds), [compare.comparedIds]);

  return (
    <div id="awesome-apps-root" className="min-h-screen bg-fr-bg text-fr-text flex flex-col selection:bg-fr-focus selection:text-white">
      {/* Sonner Toast Notifications Container */}
      <Toaster
        theme={uiTheme}
        position="top-right"
        richColors
        closeButton
      />

      {/* Offline Status Connectivity Banner */}
      <OfflineIndicator />

      {/* Top Navigation Bar with View Mode Toggle, Batch & Export */}
      <Header
        searchQuery={filters.search}
        onSearchChange={(search) => handleFilterChange({ search })}
        onOpenAddApps={openAddFlowSearch}
        onOpenTauriModal={() => dialogs.setIsTauriModalOpen(true)}
        onOpenShortcutsModal={() => dialogs.setIsShortcutsModalOpen(true)}
        onExportCatalog={catalog.exportCatalog}
        onImportCatalog={catalog.importCatalog}
        viewMode={viewMode}
        onToggleViewMode={toggleViewMode}
        page={page}
        onPageChange={changePage}
        onOpenCommandPalette={() => dialogs.setIsCommandPaletteOpen(true)}
        onOpenBatchInstall={() => dialogs.setIsBatchInstallModalOpen(true)}
        onOpenCompare={() => dialogs.setIsCompareModalOpen(true)}
        onOpenExportModal={() => dialogs.setIsExportModalOpen(true)}
        batchCount={batch.selectedIds.length}
        compareCount={compare.comparedIds.length}
        onOpenDownloads={() => dialogs.setIsDownloadsOpen(true)}
        activeDownloadCount={activeDownloadCount}
        updateVersion={selfUpdate.ownUpdate ? selfUpdate.ownUpdate.release.version : null}
        updatePillStatus={selfUpdate.updatePillStatus}
        updateChannel={selfUpdate.updateChannel}
        onUpdateChannelChange={selfUpdate.handleUpdateChannelChange}
        onUpdateClick={selfUpdate.handleHeaderUpdateClick}
        onCheckForUpdates={() => void selfUpdate.runUpdateCheck(true)}
        onOpenWhatsNew={() => setShowWhatsNew(true)}
      />

      {/* On phones the header is position:fixed (Android webviews do not keep
          sticky headers pinned), so this spacer reserves its height. The
          height variable is measured live by the Header's ResizeObserver. */}
      <div className="md:hidden" style={{ height: 'var(--fress-header-h, 0px)' }} aria-hidden="true" />

      {/* Spotlight Section */}
      {page === 'catalog' && (
        <SpotlightSection
          totalApps={catalog.apps.length}
          androidCount={catalog.androidCount}
        />
      )}

      {/* Filter and Category Bar */}
      {page === 'catalog' && (
        <FilterBar
          filters={filters}
          onFilterChange={handleFilterChange}
          onResetFilters={resetFilters}
          favoritesCount={catalog.favorites.length}
          customCount={catalog.customCount}
          totalVisible={filteredApps.length}
          totalAll={catalog.apps.length}
        />
      )}

      {/* Main Content Area: Grid or Table View */}
      {/* fr-shell: the same content boundary as the header, hero and filter
          bar. Wide enough for a four-column catalog on large desktops,
          never stretched edge-to-edge on ultrawides. */}
      <main className="flex-1 fr-shell w-full py-6 pb-24" id="main-content" tabIndex={-1}>
        {page === 'replace' ? (
          <ReplaceTab
            apps={catalog.apps}
            onOpenDetail={dialogs.openDetail}
            onAddToBatch={batch.addIds}
            onRemoveFromBatch={batch.removeIds}
          />
        ) : filteredApps.length > 0 ? (
          viewMode === 'grid' ? (
            /* Responsive ladder: 1 phone / 2 tablet / 3 desktop / 4 at 2xl
                (1536px+ viewports), where a ~365px card stays comfortably
                readable inside the fr-shell boundary. */
            <div id="apps-catalog-grid" className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-3.5">
              {filteredApps.map((app) => (
                <AppCard
                  key={app.id}
                  app={app}
                  isFavorite={favoriteSet.has(app.id)}
                  onToggleFavorite={catalog.toggleFavorite}
                  onOpenDetail={dialogs.openDetail}
                  onEditApp={handleEditApp}
                  onDeleteApp={handleDeleteApp}
                  isBatchSelected={selectedSet.has(app.id)}
                  onToggleBatchSelect={batch.toggleSelect}
                  isCompared={comparedSet.has(app.id)}
                  onToggleCompare={compare.toggleCompare}
                />
              ))}
            </div>
          ) : (
            <TableView
              apps={filteredApps}
              favorites={catalog.favorites}
              onToggleFavorite={catalog.toggleFavorite}
              // dialogs.openDetail is identity-stable (ref pattern in
              // useAppDialogs); a fresh inline arrow here would defeat the
              // table's memo on every shell render.
              onOpenDetail={dialogs.openDetail}
              onEditApp={handleEditApp}
              onDeleteApp={handleDeleteApp}
              selectedAppIds={batch.selectedIds}
              onToggleBatchSelect={batch.toggleSelect}
              comparedAppIds={compare.comparedIds}
              onToggleCompare={compare.toggleCompare}
            />
          )
        ) : (
          <EmptyCatalogState
            onResetFilters={resetFilters}
            onAddApp={openAddFlowSearch}
            totalCount={catalog.apps.length}
          />
        )}
      </main>

      {/* Floating Bottom Selection Bar for Batch Actions */}
      {batch.selectedIds.length > 0 && (
        <BatchActionBar
          selectedCount={batch.selectedIds.length}
          resolving={batch.resolving}
          onDownload={() => void batch.downloadSelected()}
          onOpenScriptModal={() => dialogs.setIsBatchInstallModalOpen(true)}
          onCompareSelected={() => {
            compare.setIds(batch.selectedIds);
            dialogs.setIsCompareModalOpen(true);
          }}
          onClear={batch.clear}
        />
      )}

      {/* Floating Bottom Indicator for Compared Apps if matrix isn't open and selection bar isn't occupying */}
      {compare.comparedIds.length > 0 && batch.selectedIds.length === 0 && (
        <CompareDock
          count={compare.comparedIds.length}
          onOpenMatrix={() => dialogs.setIsCompareModalOpen(true)}
          onClear={compare.clear}
        />
      )}

      {/* Footer */}
      <Footer
        onOpenLegal={dialogs.openLegal}
        onOpenTauriModal={() => dialogs.setIsTauriModalOpen(true)}
      />

      {/* Modals & Dialogs */}
      <CommandPalette
        isOpen={dialogs.isCommandPaletteOpen}
        onClose={() => dialogs.setIsCommandPaletteOpen(false)}
        apps={catalog.apps}
        onToggleFavorite={catalog.toggleFavorite}
        onOpenAppDetail={(app) => dialogs.openDetail(app)}
        onSelectCategory={(cat: Category) => handleFilterChange({ category: cat })}
        onToggleViewMode={() => toggleViewMode(viewMode === 'grid' ? 'table' : 'grid')}
        viewMode={viewMode}
        onOpenBatchInstall={() => dialogs.setIsBatchInstallModalOpen(true)}
        onOpenCompare={() => dialogs.setIsCompareModalOpen(true)}
        onOpenExport={() => dialogs.setIsExportModalOpen(true)}
      />

      <BatchInstallModal
        isOpen={dialogs.isBatchInstallModalOpen}
        onClose={() => dialogs.setIsBatchInstallModalOpen(false)}
        // No fallback list: a cleared selection must show an empty batch,
        // never five random apps whose remove buttons do nothing.
        selectedApps={batch.selectedApps}
        allApps={catalog.apps}
        onToggleAppSelection={batch.toggleSelect}
        onSelectAll={batch.selectAll}
        onClearSelection={batch.clear}
      />

      <CompareModal
        isOpen={dialogs.isCompareModalOpen}
        onClose={() => dialogs.setIsCompareModalOpen(false)}
        // Same rule as the batch modal: empty means empty.
        appsToCompare={compare.comparedApps}
        allApps={catalog.apps}
        onAddAppToCompare={compare.toggleCompare}
        onRemoveAppFromCompare={compare.removeApp}
        onClearCompare={compare.clear}
      />

      <ExportModal
        isOpen={dialogs.isExportModalOpen}
        onClose={() => dialogs.setIsExportModalOpen(false)}
        apps={catalog.apps}
      />

      <AppDetailModal
        app={dialogs.selectedApp}
        onClose={dialogs.closeDetail}
        onEditApp={handleEditApp}
      />

      <LiveSearchModal
        isOpen={dialogs.addFlow === 'search'}
        onClose={() => dialogs.setAddFlow(null)}
        onAddApp={handleSaveApp}
        existingApps={catalog.apps}
        showTabs
        onSwitchTab={(tab) => dialogs.setAddFlow(tab)}
      />

      <AddAppModal
        isOpen={dialogs.addFlow === 'manual' || dialogs.isAddModalOpen}
        onClose={() => {
          dialogs.setIsAddModalOpen(false);
          dialogs.setEditingApp(null);
          if (dialogs.addFlow === 'manual') dialogs.setAddFlow(null);
        }}
        onSaveApp={handleSaveApp}
        initialApp={dialogs.editingApp}
        // Catalog snapshot for the manual-add duplicate guard.
        existingApps={catalog.apps}
        showTabs={!dialogs.isAddModalOpen}
        onSwitchTab={(tab) => dialogs.setAddFlow(tab)}
      />

      <TauriModal
        isOpen={dialogs.isTauriModalOpen}
        onClose={() => dialogs.setIsTauriModalOpen(false)}
      />

      <WhatsNewModal
        isOpen={showWhatsNew}
        onClose={() => setShowWhatsNew(false)}
      />

      <KeyboardShortcutsModal
        isOpen={dialogs.isShortcutsModalOpen}
        onClose={() => dialogs.setIsShortcutsModalOpen(false)}
      />

      {/* Download manager panel */}
      <DownloadManager
        isOpen={dialogs.isDownloadsOpen}
        onClose={() => dialogs.setIsDownloadsOpen(false)}
      />

      <LegalModals
        isOpen={dialogs.legalModal.isOpen}
        initialTab={dialogs.legalModal.tab}
        onClose={dialogs.closeLegal}
      />
    </div>
  );
}

export default function App() {
  return (
    <I18nProvider>
      <ThemeProvider>
        <DownloadsProvider>
          <AppShell />
        </DownloadsProvider>
      </ThemeProvider>
    </I18nProvider>
  );
}
