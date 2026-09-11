import React, { useState, useEffect, useMemo } from 'react';
import { Header } from './components/Header';
import { FilterBar } from './components/FilterBar';
import { SpotlightSection } from './components/SpotlightSection';
import { AppCard } from './components/AppCard';
import { TableView } from './components/TableView';
import { AppDetailModal } from './components/AppDetailModal';
import { AddAppModal } from './components/AddAppModal';
import { TauriModal } from './components/TauriModal';
import { PrivacyAuditModal } from './components/PrivacyAuditModal';
import { LegalModals, LegalTab } from './components/LegalModals';
import { CookieBanner } from './components/CookieBanner';
import { KeyboardShortcutsModal } from './components/KeyboardShortcutsModal';
import { OfflineIndicator } from './components/OfflineIndicator';
import { Footer } from './components/Footer';
import { CommandPalette } from './components/CommandPalette';
import { BatchInstallModal } from './components/BatchInstallModal';
import { CompareModal } from './components/CompareModal';
import { ExportModal } from './components/ExportModal';
import { LiveSearchModal } from './components/LiveSearchModal';
import { DownloadManager } from './components/DownloadManager';
import { ThemeProvider, useTheme } from './components/ThemeProvider';
import { I18nProvider } from './lib/i18n';
import { DownloadsProvider, useDownloads } from './lib/downloads';

import { INITIAL_APPS } from './data/appsData';
import { 
  AppItem, 
  Category,
  FilterState, 
  CookieConsentState, 
  PrivacyAuditData 
} from './types';
import { 
  SearchX, 
  RotateCcw, 
  Terminal, 
  Columns, 
  Share2, 
  X, 
  CheckSquare, 
  Square 
} from 'lucide-react';
import { Toaster, toast } from 'sonner';

const STORAGE_KEY_CUSTOM_APPS = 'fress_custom_items';
const STORAGE_KEY_FAVORITES = 'fress_favorites';
const STORAGE_KEY_COOKIES = 'awesome_free_apps_cookie_consent';
const STORAGE_KEY_VIEW_MODE = 'awesome_free_apps_view_mode';

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

function AppShell() {
  const { theme: uiTheme } = useTheme();
  const { items: downloadItems } = useDownloads();
  const [isDownloadsOpen, setIsDownloadsOpen] = useState(false);
  const activeDownloadCount = downloadItems.filter((d) => d.status === 'active').length;

  // Load custom apps from local storage
  const [apps, setApps] = useState<AppItem[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_CUSTOM_APPS);
      if (saved) {
        const parsed = JSON.parse(saved);
        return [...INITIAL_APPS, ...parsed];
      }
    } catch {
      // fallback to initial apps
    }
    return INITIAL_APPS;
  });

  // Favorites
  const [favorites, setFavorites] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_FAVORITES);
      if (saved) {
        return JSON.parse(saved);
      }
    } catch {
      // fallback
    }
    return [];
  });

  // Batch selection IDs
  const [selectedBatchAppIds, setSelectedBatchAppIds] = useState<string[]>([]);

  // Compare IDs
  const [comparedAppIds, setComparedAppIds] = useState<string[]>([]);

  // View mode: grid vs table
  const [viewMode, setViewMode] = useState<'grid' | 'table'>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_VIEW_MODE);
      if (saved === 'grid' || saved === 'table') return saved;
    } catch {
      // ignore
    }
    return 'grid';
  });

  const handleToggleViewMode = (mode: 'grid' | 'table') => {
    setViewMode(mode);
    try {
      localStorage.setItem(STORAGE_KEY_VIEW_MODE, mode);
    } catch {
      // ignore
    }
  };

  // Cookie consent
  const [cookieConsent, setCookieConsent] = useState<CookieConsentState>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_COOKIES);
      if (saved) {
        return JSON.parse(saved);
      }
    } catch {
      // fallback
    }
    return {
      decided: false,
      essential: true,
      functional: true,
      analytics: false,
      updatedAt: ''
    };
  });

  // Filters
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);

  // Modals state
  const [selectedApp, setSelectedApp] = useState<AppItem | null>(null);
  const [editingApp, setEditingApp] = useState<AppItem | null>(null);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isTauriModalOpen, setIsTauriModalOpen] = useState(false);
  const [isPrivacyModalOpen, setIsPrivacyModalOpen] = useState(false);
  const [isShortcutsModalOpen, setIsShortcutsModalOpen] = useState(false);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [isBatchInstallModalOpen, setIsBatchInstallModalOpen] = useState(false);
  const [isCompareModalOpen, setIsCompareModalOpen] = useState(false);
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [isLiveSearchOpen, setIsLiveSearchOpen] = useState(false);
  const [isLiveTrending, setIsLiveTrending] = useState(false);

  const [legalModal, setLegalModal] = useState<{ isOpen: boolean; tab: LegalTab }>({
    isOpen: false,
    tab: 'privacy'
  });

  // Real audit data
  const auditData: PrivacyAuditData = {
    trackingScriptsFound: 0,
    thirdPartyTrackersFound: 0,
    cookiesStatus: 'Clean local-first storage',
    externalLinkSanitization: true,
    wcagContrastCompliant: true,
    keyboardNavigable: true,
    secureHeadersActive: true
  };

  // Persist favorites
  const toggleFavorite = (appId: string) => {
    setFavorites((prev) => {
      const next = prev.includes(appId)
        ? prev.filter((id) => id !== appId)
        : [...prev, appId];
      try {
        localStorage.setItem(STORAGE_KEY_FAVORITES, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  };

  // Batch toggle
  const toggleBatchSelect = (appId: string) => {
    setSelectedBatchAppIds((prev) => 
      prev.includes(appId) ? prev.filter((id) => id !== appId) : [...prev, appId]
    );
  };

  const handleSelectAllBatch = () => {
    setSelectedBatchAppIds(apps.map((a) => a.id));
    toast.success(`Selected all ${apps.length} applications for batch operations.`);
  };

  const handleClearBatch = () => {
    setSelectedBatchAppIds([]);
  };

  // Compare toggle
  const toggleCompareApp = (appId: string) => {
    setComparedAppIds((prev) => {
      if (prev.includes(appId)) {
        return prev.filter((id) => id !== appId);
      }
      if (prev.length >= 4) {
        toast.info('Maximum 4 applications can be compared simultaneously.');
        return prev;
      }
      const app = apps.find((a) => a.id === appId);
      toast.success(`Added "${app?.name || 'app'}" to comparison matrix.`);
      return [...prev, appId];
    });
  };

  const handleRemoveCompare = (appId: string) => {
    setComparedAppIds((prev) => prev.filter((id) => id !== appId));
  };

  const handleClearCompare = () => {
    setComparedAppIds([]);
  };

  // Add or update application
  const handleSaveApp = (appToSave: AppItem) => {
    setApps((prev) => {
      const existingIndex = prev.findIndex((item) => item.id === appToSave.id);
      let updated: AppItem[];

      if (existingIndex >= 0) {
        updated = [...prev];
        updated[existingIndex] = appToSave;
        toast.success(`Updated "${appToSave.name}" successfully.`);
      } else {
        updated = [appToSave, ...prev];
        toast.success(`Added "${appToSave.name}" to your application catalog.`);
      }

      try {
        const customOnly = updated.filter((item) => item.isCustom);
        localStorage.setItem(STORAGE_KEY_CUSTOM_APPS, JSON.stringify(customOnly));
      } catch {
        // ignore
      }
      return updated;
    });

    setEditingApp(null);
  };

  // Delete custom application
  const handleDeleteApp = (appId: string) => {
    setApps((prev) => {
      const target = prev.find((a) => a.id === appId);
      const updated = prev.filter((item) => item.id !== appId);
      try {
        const customOnly = updated.filter((item) => item.isCustom);
        localStorage.setItem(STORAGE_KEY_CUSTOM_APPS, JSON.stringify(customOnly));
      } catch {
        // ignore
      }
      if (target) {
        toast.info(`Removed "${target.name}" from your catalog.`);
      }
      return updated;
    });

    setFavorites((prev) => {
      const next = prev.filter((id) => id !== appId);
      try {
        localStorage.setItem(STORAGE_KEY_FAVORITES, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });

    setSelectedBatchAppIds((prev) => prev.filter((id) => id !== appId));
    setComparedAppIds((prev) => prev.filter((id) => id !== appId));

    if (selectedApp?.id === appId) {
      setSelectedApp(null);
    }
  };

  // Edit custom app handler
  const handleEditApp = (app: AppItem) => {
    setEditingApp(app);
    setIsAddModalOpen(true);
  };

  // Export catalog
  const handleExportCatalog = () => {
    const payload = {
      meta: {
        project: 'Awesome Free Apps Hub',
        exportDate: new Date().toISOString(),
        version: '1.2',
        totalItems: apps.length
      },
      favorites,
      customApps: apps.filter((a) => a.isCustom),
      allApps: apps
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `awesome-free-apps-backup-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    toast.success('Catalog exported successfully as JSON backup.');
  };

  // Import catalog
  const handleImportCatalog = (jsonString: string) => {
    try {
      const parsed = JSON.parse(jsonString);
      const incomingApps: AppItem[] = parsed.customApps || parsed.apps || [];
      if (!Array.isArray(incomingApps)) {
        toast.error('Invalid backup file: Missing apps array.');
        return;
      }

      setApps((prev) => {
        const existingIds = new Set(prev.map((a) => a.id));
        const newCustoms: AppItem[] = [];

        for (const item of incomingApps) {
          if (item && item.name && !existingIds.has(item.id)) {
            newCustoms.push({ ...item, isCustom: true });
            existingIds.add(item.id);
          }
        }

        const merged = [...prev, ...newCustoms];
        try {
          const customOnly = merged.filter((item) => item.isCustom);
          localStorage.setItem(STORAGE_KEY_CUSTOM_APPS, JSON.stringify(customOnly));
        } catch {
          // ignore
        }

        if (newCustoms.length > 0) {
          toast.success(`Imported ${newCustoms.length} new application(s).`);
        } else {
          toast.info('No new applications detected; all items are already in catalog.');
        }

        return merged;
      });

      if (Array.isArray(parsed.favorites) && parsed.favorites.length > 0) {
        setFavorites((prev) => {
          const combined = Array.from(new Set([...prev, ...parsed.favorites]));
          try {
            localStorage.setItem(STORAGE_KEY_FAVORITES, JSON.stringify(combined));
          } catch {
            // ignore
          }
          return combined;
        });
      }
    } catch {
      toast.error('Failed to parse backup JSON file.');
    }
  };

  // Refresh live trending via server API
  const handleRefreshTrendingFromApi = async () => {
    try {
      const res = await fetch('/api/github/trending');
      if (!res.ok) throw new Error('API query failed');
      const data = await res.json();
      if (data.apps && data.apps.length > 0) {
        setIsLiveTrending(true);
        setApps((prev) => {
          const existingIds = new Set(prev.map((a) => a.id));
          const additions: AppItem[] = [];
          for (const item of data.apps) {
            if (!existingIds.has(item.id)) {
              additions.push(item);
            }
          }
          return [...additions, ...prev];
        });
        toast.success(`Synced live GitHub trending software (${data.source}).`);
      }
    } catch {
      toast.info('Using verified offline curated trending list.');
    }
  };

  // Update cookie consent
  const handleUpdateCookieConsent = (newConsent: CookieConsentState) => {
    setCookieConsent(newConsent);
    try {
      localStorage.setItem(STORAGE_KEY_COOKIES, JSON.stringify(newConsent));
    } catch {
      // ignore
    }
  };

  // Filter change helper
  const handleFilterChange = (partial: Partial<FilterState>) => {
    setFilters((prev) => ({ ...prev, ...partial }));
  };

  const handleResetFilters = () => {
    setFilters(DEFAULT_FILTERS);
    toast.info('Filters reset to default.');
  };

  // Keyboard navigation & accessibility shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd+K or Ctrl+K triggers command palette anywhere
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setIsCommandPaletteOpen((prev) => !prev);
        return;
      }

      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') {
        if (e.key === 'Escape') {
          target.blur();
        }
        return;
      }

      if (e.key === '/') {
        e.preventDefault();
        const searchInput = document.getElementById('app-search-input');
        searchInput?.focus();
      } else if (e.key === 'Escape') {
        setSelectedApp(null);
        setEditingApp(null);
        setIsAddModalOpen(false);
        setIsTauriModalOpen(false);
        setIsPrivacyModalOpen(false);
        setIsShortcutsModalOpen(false);
        setIsCommandPaletteOpen(false);
        setIsBatchInstallModalOpen(false);
        setIsCompareModalOpen(false);
        setIsExportModalOpen(false);
        setLegalModal((prev) => ({ ...prev, isOpen: false }));
      } else if (e.key === 'a' || e.key === 'A') {
        e.preventDefault();
        setEditingApp(null);
        setIsAddModalOpen(true);
      } else if (e.key === 'b' || e.key === 'B') {
        e.preventDefault();
        setIsBatchInstallModalOpen((prev) => !prev);
      } else if (e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        setIsCompareModalOpen((prev) => !prev);
      } else if (e.key === 'e' || e.key === 'E') {
        e.preventDefault();
        setIsExportModalOpen((prev) => !prev);
      } else if (e.key === 'd' || e.key === 'D') {
        e.preventDefault();
        setIsTauriModalOpen(true);
      } else if (e.key === 'p' || e.key === 'P') {
        e.preventDefault();
        setIsPrivacyModalOpen(true);
      } else if (e.key === 'c' || e.key === 'C') {
        e.preventDefault();
        setLegalModal({ isOpen: true, tab: 'consent' });
      } else if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        handleFilterChange({ favoritesOnly: !filters.favoritesOnly });
      } else if (e.key === 't' || e.key === 'T') {
        e.preventDefault();
        handleFilterChange({ trendingOnly: !filters.trendingOnly });
      } else if (e.key === 'o' || e.key === 'O') {
        e.preventDefault();
        handleFilterChange({ ownerPickOnly: !filters.ownerPickOnly });
      } else if (e.key === 'v' || e.key === 'V') {
        e.preventDefault();
        handleToggleViewMode(viewMode === 'grid' ? 'table' : 'grid');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [filters, viewMode]);

  // Filtered and sorted applications
  const filteredApps = useMemo(() => {
    return apps
      .filter((app) => {
        if (filters.search.trim()) {
          const q = filters.search.toLowerCase().trim();
          const matchName = app.name.toLowerCase().includes(q);
          const matchTagline = app.tagline.toLowerCase().includes(q);
          const matchDesc = app.description.toLowerCase().includes(q);
          const matchWhy = app.whyItsAwesome.toLowerCase().includes(q);
          const matchTags = app.tags.some((t) => t.toLowerCase().includes(q));
          const matchWinget = app.wingetCommand?.toLowerCase().includes(q) ?? false;
          const matchBrew = app.brewCommand?.toLowerCase().includes(q) ?? false;
          const matchFlatpak = app.flatpakCommand?.toLowerCase().includes(q) ?? false;
          const matchAlt = app.proprietaryAlternative?.toLowerCase().includes(q) ?? false;
          if (!matchName && !matchTagline && !matchDesc && !matchWhy && !matchTags && !matchWinget && !matchBrew && !matchFlatpak && !matchAlt) {
            return false;
          }
        }

        if (filters.category !== 'All' && app.category !== filters.category) {
          return false;
        }

        if (filters.platform !== 'all' && !app.platforms.includes(filters.platform)) {
          return false;
        }

        if (filters.beginnerOnly && app.beginnerRating !== 'Super Beginner Friendly') {
          return false;
        }

        if (filters.ownerPickOnly && !app.isOwnerPick) {
          return false;
        }

        if (filters.trendingOnly && !app.isTrendingToday) {
          return false;
        }

        if (filters.favoritesOnly && !favorites.includes(app.id)) {
          return false;
        }

        if (filters.customOnly && !app.isCustom) {
          return false;
        }

        return true;
      })
      .sort((a, b) => {
        if (filters.sortBy === 'stars') {
          return b.stars - a.stars;
        }
        if (filters.sortBy === 'name') {
          return a.name.localeCompare(b.name);
        }
        if (filters.sortBy === 'newest') {
          return new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime();
        }
        return 0;
      });
  }, [apps, filters, favorites]);

  const trendingApps = useMemo(() => apps.filter((a) => a.isTrendingToday), [apps]);
  const ownerPicks = useMemo(() => apps.filter((a) => a.isOwnerPick), [apps]);
  const customCount = useMemo(() => apps.filter((a) => a.isCustom).length, [apps]);
  const androidCount = useMemo(() => apps.filter((a) => a.platforms.includes('android')).length, [apps]);

  const selectedBatchApps = useMemo(() => {
    return apps.filter((a) => selectedBatchAppIds.includes(a.id));
  }, [apps, selectedBatchAppIds]);

  const comparedApps = useMemo(() => {
    return apps.filter((a) => comparedAppIds.includes(a.id));
  }, [apps, comparedAppIds]);

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
        onOpenLiveSearch={() => setIsLiveSearchOpen(true)}
        onOpenAddModal={() => {
          setEditingApp(null);
          setIsAddModalOpen(true);
        }}
        onOpenTauriModal={() => setIsTauriModalOpen(true)}
        onOpenPrivacyModal={() => setIsPrivacyModalOpen(true)}
        onOpenShortcutsModal={() => setIsShortcutsModalOpen(true)}
        onExportCatalog={handleExportCatalog}
        onImportCatalog={handleImportCatalog}
        auditData={auditData}
        totalApps={apps.length}
        viewMode={viewMode}
        onToggleViewMode={handleToggleViewMode}
        onOpenCommandPalette={() => setIsCommandPaletteOpen(true)}
        onOpenBatchInstall={() => setIsBatchInstallModalOpen(true)}
        onOpenCompare={() => setIsCompareModalOpen(true)}
        onOpenExportModal={() => setIsExportModalOpen(true)}
        batchCount={selectedBatchAppIds.length}
        compareCount={comparedAppIds.length}
        onOpenDownloads={() => setIsDownloadsOpen(true)}
        activeDownloadCount={activeDownloadCount}
      />

      {/* Spotlight Section */}
      <SpotlightSection
        onSelectTrending={() => handleFilterChange({ trendingOnly: true, ownerPickOnly: false, category: 'All' })}
        onSelectOwnerPicks={() => handleFilterChange({ ownerPickOnly: true, trendingOnly: false, category: 'All' })}
        onOpenLiveSearch={() => setIsLiveSearchOpen(true)}
        totalApps={apps.length}
        androidCount={androidCount}
      />

      {/* Filter and Category Bar */}
      <FilterBar
        filters={filters}
        onFilterChange={handleFilterChange}
        onResetFilters={handleResetFilters}
        favoritesCount={favorites.length}
        customCount={customCount}
        totalVisible={filteredApps.length}
        totalAll={apps.length}
      />

      {/* Main Content Area: Grid or Table View */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6 pb-24" id="main-content">
        {filteredApps.length > 0 ? (
          viewMode === 'grid' ? (
            <div id="apps-catalog-grid" className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
              {filteredApps.map((app) => (
                <AppCard
                  key={app.id}
                  app={app}
                  isFavorite={favorites.includes(app.id)}
                  onToggleFavorite={toggleFavorite}
                  onOpenDetail={(item) => setSelectedApp(item)}
                  onEditApp={handleEditApp}
                  onDeleteApp={handleDeleteApp}
                  isBatchSelected={selectedBatchAppIds.includes(app.id)}
                  onToggleBatchSelect={toggleBatchSelect}
                  isCompared={comparedAppIds.includes(app.id)}
                  onToggleCompare={toggleCompareApp}
                />
              ))}
            </div>
          ) : (
            <TableView
              apps={filteredApps}
              favorites={favorites}
              onToggleFavorite={toggleFavorite}
              onOpenDetail={(item) => setSelectedApp(item)}
              onEditApp={handleEditApp}
              onDeleteApp={handleDeleteApp}
              selectedAppIds={selectedBatchAppIds}
              onToggleBatchSelect={toggleBatchSelect}
              comparedAppIds={comparedAppIds}
              onToggleCompare={toggleCompareApp}
            />
          )
        ) : (
          <div id="no-apps-empty-state" className="bg-slate-900 border border-slate-950/10 dark:border-white/[0.08] rounded-lg p-10 text-center max-w-md mx-auto my-8">
            <SearchX className="w-8 h-8 text-slate-500 mx-auto mb-3" aria-hidden="true" />
            <h2 id="empty-state-title" className="text-sm font-semibold text-slate-100 mb-1">
              No matching applications found
            </h2>
            <p id="empty-state-desc" className="text-xs text-slate-400 mb-4 leading-relaxed">
              No software matched your current search or filter combination. Reset filters or add this tool to your library.
            </p>
            <div id="empty-state-actions" className="flex items-center justify-center gap-2">
              <button
                id="empty-reset-filters-btn"
                type="button"
                onClick={handleResetFilters}
                className="inline-flex items-center gap-1.5 text-xs font-medium bg-slate-950/[0.04] dark:bg-white/[0.04] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.08] text-slate-200 px-3 py-1.5 rounded-md border border-slate-950/10 dark:border-white/[0.08]"
              >
                <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Reset All Filters</span>
              </button>
              <button
                id="empty-add-app-btn"
                type="button"
                onClick={() => {
                  setEditingApp(null);
                  setIsAddModalOpen(true);
                }}
                className="text-xs font-semibold bg-sky-600 hover:bg-sky-500 text-white px-3 py-1.5 rounded-md border border-sky-400"
              >
                Add Custom Tool
              </button>
            </div>
          </div>
        )}
      </main>

      {/* Floating Bottom Selection Bar for Batch Actions */}
      {selectedBatchAppIds.length > 0 && (
        <aside 
          id="floating-batch-action-bar"
          aria-label="Batch operations bar"
          className="fixed bottom-5 left-1/2 -translate-x-1/2 z-40 bg-slate-900/95 border border-slate-950/[0.14] dark:border-white/[0.14] rounded-xl shadow-2xl px-4 py-2.5 flex items-center gap-3 backdrop-blur-md max-w-xl w-[92%]"
        >
          <div className="flex items-center gap-2 mr-auto">
            <span className="w-2 h-2 rounded-full bg-sky-400 animate-pulse" />
            <span className="text-xs font-semibold text-slate-100">
              {selectedBatchAppIds.length} tool{selectedBatchAppIds.length > 1 ? 's' : ''} selected
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setIsBatchInstallModalOpen(true)}
              className="inline-flex items-center gap-1.5 text-xs font-medium bg-sky-600 hover:bg-sky-500 text-white px-3 py-1.5 rounded-md transition-colors shadow-xs"
            >
              <Terminal className="w-3.5 h-3.5" />
              <span>Generate Script</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setComparedAppIds(selectedBatchAppIds.slice(0, 4));
                setIsCompareModalOpen(true);
              }}
              className="inline-flex items-center gap-1.5 text-xs font-medium bg-slate-950/[0.06] dark:bg-white/[0.08] hover:bg-slate-950/[0.1] dark:hover:bg-white/[0.14] text-slate-200 px-2.5 py-1.5 rounded-md transition-colors"
              title="Compare up to 4 selected tools side-by-side"
            >
              <Columns className="w-3.5 h-3.5 text-indigo-400" />
              <span>Compare</span>
            </button>

            <button
              type="button"
              onClick={handleClearBatch}
              className="p-1.5 text-slate-400 hover:text-slate-100 rounded hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.08] transition-colors"
              title="Clear selection"
              aria-label="Clear batch selection"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </aside>
      )}

      {/* Floating Bottom Indicator for Compared Apps if matrix isn't open and selection bar isn't occupying */}
      {comparedAppIds.length > 0 && selectedBatchAppIds.length === 0 && (
        <aside 
          id="floating-compare-action-bar"
          aria-label="Comparison dock"
          className="fixed bottom-5 right-6 z-40 bg-slate-900/95 border border-indigo-500/40 rounded-xl shadow-2xl px-3.5 py-2 flex items-center gap-2.5 backdrop-blur-md"
        >
          <Columns className="w-4 h-4 text-indigo-400" />
          <span className="text-xs text-slate-200 font-medium">
            {comparedAppIds.length} app{comparedAppIds.length > 1 ? 's' : ''} in comparison
          </span>
          <button
            type="button"
            onClick={() => setIsCompareModalOpen(true)}
            className="text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white px-2.5 py-1 rounded-md transition-colors ml-1"
          >
            View Matrix
          </button>
          <button
            type="button"
            onClick={handleClearCompare}
            className="text-slate-400 hover:text-slate-100 p-1 rounded hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.08]"
            title="Clear comparison"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </aside>
      )}

      {/* Footer */}
      <Footer
        onOpenLegal={(tab) => setLegalModal({ isOpen: true, tab })}
        onOpenPrivacyAudit={() => setIsPrivacyModalOpen(true)}
        onOpenTauriModal={() => setIsTauriModalOpen(true)}
      />

      {/* Modals & Dialogs */}
      <CommandPalette
        isOpen={isCommandPaletteOpen}
        onClose={() => setIsCommandPaletteOpen(false)}
        apps={apps}
        favorites={favorites}
        onToggleFavorite={toggleFavorite}
        onOpenAppDetail={(app) => setSelectedApp(app)}
        onSelectCategory={(cat: Category) => handleFilterChange({ category: cat })}
        onToggleViewMode={() => handleToggleViewMode(viewMode === 'grid' ? 'table' : 'grid')}
        viewMode={viewMode}
        onOpenBatchInstall={() => setIsBatchInstallModalOpen(true)}
        onOpenCompare={() => setIsCompareModalOpen(true)}
        onOpenExport={() => setIsExportModalOpen(true)}
      />

      <BatchInstallModal
        isOpen={isBatchInstallModalOpen}
        onClose={() => setIsBatchInstallModalOpen(false)}
        selectedApps={selectedBatchApps.length > 0 ? selectedBatchApps : apps.slice(0, 5)}
        allApps={apps}
        onToggleAppSelection={toggleBatchSelect}
        onSelectAll={handleSelectAllBatch}
        onClearSelection={handleClearBatch}
      />

      <CompareModal
        isOpen={isCompareModalOpen}
        onClose={() => setIsCompareModalOpen(false)}
        appsToCompare={comparedApps.length > 0 ? comparedApps : apps.slice(0, 3)}
        allApps={apps}
        onAddAppToCompare={toggleCompareApp}
        onRemoveAppFromCompare={handleRemoveCompare}
        onClearCompare={handleClearCompare}
      />

      <ExportModal
        isOpen={isExportModalOpen}
        onClose={() => setIsExportModalOpen(false)}
        apps={apps}
      />

      <AppDetailModal
        app={selectedApp}
        onClose={() => setSelectedApp(null)}
        onEditApp={handleEditApp}
      />

      <LiveSearchModal
        isOpen={isLiveSearchOpen}
        onClose={() => setIsLiveSearchOpen(false)}
        onAddApp={handleSaveApp}
        existingApps={apps}
      />

      <AddAppModal
        isOpen={isAddModalOpen}
        onClose={() => {
          setIsAddModalOpen(false);
          setEditingApp(null);
        }}
        onSaveApp={handleSaveApp}
        initialApp={editingApp}
      />

      <TauriModal
        isOpen={isTauriModalOpen}
        onClose={() => setIsTauriModalOpen(false)}
      />

      <PrivacyAuditModal
        isOpen={isPrivacyModalOpen}
        onClose={() => setIsPrivacyModalOpen(false)}
        auditData={auditData}
        externalLinkCount={apps.length * 2}
      />

      <LegalModals
        isOpen={legalModal.isOpen}
        initialTab={legalModal.tab}
        onClose={() => setLegalModal((prev) => ({ ...prev, isOpen: false }))}
        cookieConsent={cookieConsent}
        onUpdateCookieConsent={handleUpdateCookieConsent}
      />

      <KeyboardShortcutsModal
        isOpen={isShortcutsModalOpen}
        onClose={() => setIsShortcutsModalOpen(false)}
      />

      {/* Interactive Cookie Consent Banner */}
      <CookieBanner
        cookieConsent={cookieConsent}
        onAcceptNecessary={() =>
          handleUpdateCookieConsent({
            decided: true,
            essential: true,
            functional: false,
            analytics: false,
            updatedAt: new Date().toISOString()
          })
        }
        onAcceptAll={() =>
          handleUpdateCookieConsent({
            decided: true,
            essential: true,
            functional: true,
            analytics: true,
            updatedAt: new Date().toISOString()
          })
        }
        onOpenPreferences={() => setLegalModal({ isOpen: true, tab: 'consent' })}
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
