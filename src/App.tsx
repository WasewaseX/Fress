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
import { useMemo } from 'react';
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
import { I18nProvider, useI18n } from './lib/i18n';
import { DownloadsProvider, useDownloadState, useDownloadActions } from './lib/downloads';
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
  const { t } = useI18n();
  const { activeCount: activeDownloadCount } = useDownloadState();
  const { startDownload } = useDownloadActions();

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
  const handleSaveApp = (appToSave: Parameters<typeof catalog.saveApp>[0]) => {
    catalog.saveApp(appToSave);
    dialogs.setEditingApp(null);
  };

  // Deleting cleans up every other surface that may hold the app.
  const handleDeleteApp = (appId: string) => {
    catalog.deleteApp(appId);
    batch.removeIds([appId]);
    compare.removeApp(appId);
    dialogs.closeDetailIfApp(appId);
  };

  const handleEditApp = (app: Parameters<typeof dialogs.setEditingApp>[0]) => {
    dialogs.setEditingApp(app);
    dialogs.setIsAddModalOpen(true);
  };

  const openAddFlowSearch = () => {
    dialogs.setEditingApp(null);
    dialogs.setAddFlow('search');
  };

  // Keyboard map: same keys and guards as before, actions pulled from the
  // feature hooks on each render.
  useGlobalShortcuts({
    toggleCommandPalette: () => dialogs.setIsCommandPaletteOpen((prev) => !prev),
    closeAllDialogs: dialogs.closeAllDialogs,
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

  return (
    <div id="awesome-apps-root" className="min-h-screen bg-slate-950 text-slate-100 flex flex-col selection:bg-sky-600 selection:text-white">
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
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6 pb-24" id="main-content" tabIndex={-1}>
        {page === 'replace' ? (
          <ReplaceTab
            apps={catalog.apps}
            onOpenDetail={(item) => dialogs.openDetail(item)}
            onAddToBatch={batch.addIds}
            onRemoveFromBatch={batch.removeIds}
          />
        ) : filteredApps.length > 0 ? (
          viewMode === 'grid' ? (
            <div id="apps-catalog-grid" className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
              {filteredApps.map((app) => (
                <AppCard
                  key={app.id}
                  app={app}
                  isFavorite={catalog.favorites.includes(app.id)}
                  onToggleFavorite={catalog.toggleFavorite}
                  onOpenDetail={(item) => dialogs.openDetail(item)}
                  onEditApp={handleEditApp}
                  onDeleteApp={handleDeleteApp}
                  isBatchSelected={batch.selectedIds.includes(app.id)}
                  onToggleBatchSelect={batch.toggleSelect}
                  isCompared={compare.comparedIds.includes(app.id)}
                  onToggleCompare={compare.toggleCompare}
                />
              ))}
            </div>
          ) : (
            <TableView
              apps={filteredApps}
              favorites={catalog.favorites}
              onToggleFavorite={catalog.toggleFavorite}
              onOpenDetail={(item) => dialogs.openDetail(item)}
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
        favorites={catalog.favorites}
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
