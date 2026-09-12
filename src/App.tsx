import { useState, useEffect, useMemo } from 'react';
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
import { I18nProvider, useI18n } from './lib/i18n';
import { DownloadsProvider, useActiveDownloadCount } from './lib/downloads';

import { INITIAL_APPS } from './data/appsData';
import { 
  AppItem, 
  Category,
  FilterState, 
  CookieConsentState, 
} from './types';
import { SearchX, RotateCcw, Terminal, Columns, X } from 'lucide-react';
import { Toaster, toast } from 'sonner';

const STORAGE_KEYS = {
  customApps: {
    current: 'fress.customItems',
    legacy: 'fress_custom_items',
  },
  favorites: {
    current: 'fress.favorites',
    legacy: 'fress_favorites',
  },
  cookies: {
    current: 'fress.cookieConsent',
    legacy: 'awesome_free_apps_cookie_consent',
  },
  viewMode: {
    current: 'fress.viewMode',
    legacy: 'awesome_free_apps_view_mode',
  },
} as const;

/** Reads a preference that used to live under a template-era key. */
function loadWithMigration<T>(key: { current: string; legacy: string }): T | null {
  try {
    const current = localStorage.getItem(key.current);
    if (current !== null) return JSON.parse(current) as T;
    const legacy = localStorage.getItem(key.legacy);
    if (legacy !== null) {
      localStorage.setItem(key.current, legacy); // one-time migration
      localStorage.removeItem(key.legacy);
      return JSON.parse(legacy) as T;
    }
  } catch {
    // ignore
  }
  return null;
}

const VALID_PLATFORMS = ['windows', 'mac', 'linux', 'web', 'android', 'ios'] as const;
const VALID_CATEGORIES = [
  'All',
  'Productivity & Office',
  'Developer & Code',
  'Design & Creative',
  'Utilities & System',
  'Privacy & Security',
  'Media, Audio & Video',
  'AI & Knowledge',
];

/**
 * Imported JSON is untrusted: coerce every field to a safe shape so a crafted
 * backup file can neither crash the grid nor smuggle in broken entries.
 */
function normalizeImportedApp(raw: unknown): AppItem | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === 'string' ? r.name.trim() : '';
  if (!name) return null;
  const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
  const platforms = Array.isArray(r.platforms)
    ? (r.platforms.filter((p): p is (typeof VALID_PLATFORMS)[number] =>
        typeof p === 'string' && (VALID_PLATFORMS as readonly string[]).includes(p)))
    : [];
  return {
    id: typeof r.id === 'string' && r.id.trim() ? r.id.trim().slice(0, 80) : `custom-${Date.now()}`,
    name,
    tagline: str(r.tagline, name).slice(0, 160),
    description: str(r.description).slice(0, 4000),
    whyItsAwesome: str(r.whyItsAwesome).slice(0, 2000),
    beginnerGuide: str(r.beginnerGuide).slice(0, 2000),
    githubUrl: /^https?:\/\//.test(str(r.githubUrl)) ? str(r.githubUrl) : '',
    websiteUrl: /^https?:\/\//.test(str(r.websiteUrl)) ? str(r.websiteUrl) : '',
    downloadUrl: /^https:\/\//.test(str(r.downloadUrl)) ? str(r.downloadUrl) : undefined,
    category: (VALID_CATEGORIES.includes(str(r.category)) ? str(r.category) : 'Utilities & System') as AppItem['category'],
    platforms: platforms.length > 0 ? platforms : ['windows'],
    license: str(r.license, 'Open Source').slice(0, 40),
    stars: typeof r.stars === 'number' && Number.isFinite(r.stars) ? Math.max(0, Math.min(r.stars, 1_000_000)) | 0 : 0,
    beginnerRating: typeof r.beginnerRating === 'string' ? (r.beginnerRating as AppItem['beginnerRating']) : undefined,
    isOwnerPick: false,
    isTrendingToday: false,
    tags: Array.isArray(r.tags)
      ? r.tags.filter((tg): tg is string => typeof tg === 'string').slice(0, 10).map((tg) => tg.slice(0, 30))
      : ['open-source'],
    wingetCommand: /^[-A-Za-z0-9._ ]+$/.test(str(r.wingetCommand)) ? str(r.wingetCommand) : undefined,
    brewCommand: /^[-A-Za-z0-9._ /]+$/.test(str(r.brewCommand)) ? str(r.brewCommand) : undefined,
    flatpakCommand: /^[-A-Za-z0-9._ /]+$/.test(str(r.flatpakCommand)) ? str(r.flatpakCommand) : undefined,
    scoopCommand: /^[-A-Za-z0-9._ ]+$/.test(str(r.scoopCommand)) ? str(r.scoopCommand) : undefined,
    aptCommand: /^[-A-Za-z0-9._ ]+$/.test(str(r.aptCommand)) ? str(r.aptCommand) : undefined,
    fdroidId: /^[A-Za-z][A-Za-z0-9_.]+$/.test(str(r.fdroidId)) ? str(r.fdroidId) : undefined,
    playStoreId: /^[A-Za-z][A-Za-z0-9_.]+$/.test(str(r.playStoreId)) ? str(r.playStoreId) : undefined,
    proprietaryAlternative: str(r.proprietaryAlternative).slice(0, 80) || undefined,
    isPortable: undefined,
    offlineReady: undefined,
    addedAt: /^\d{4}-\d{2}-\d{2}$/.test(str(r.addedAt)) ? str(r.addedAt) : new Date().toISOString().split('T')[0],
    isCustom: true,
  };
}

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
  const activeDownloadCount = useActiveDownloadCount();
  const { t: tI18n } = useI18n();
  const [isDownloadsOpen, setIsDownloadsOpen] = useState(false);

  // First launch: one quiet moment that answers "why care?" — the guide's
  // Why-open-source tab. Never shown again after the first run.
  const [onboarded, setOnboarded] = useState(() => {
    try { return localStorage.getItem('fress.onboarded') === '1'; } catch { return true; }
  });
  useEffect(() => {
    if (onboarded) return;
    const timer = setTimeout(() => {
      setTauriModalTab('why');
      setIsTauriModalOpen(true);
      setOnboarded(true);
      try { localStorage.setItem('fress.onboarded', '1'); } catch { /* ignore */ }
    }, 900);
    return () => clearTimeout(timer);
  }, [onboarded]);

  // Load custom apps from local storage (with legacy-key migration)
  const [apps, setApps] = useState<AppItem[]>(() => {
    const saved = loadWithMigration<AppItem[]>(STORAGE_KEYS.customApps);
    if (saved && Array.isArray(saved)) {
      // Re-normalize on load too: older local data predates validation.
      // Dedupe against the shipped catalog so a hand-edited backup cannot
      // produce duplicate React keys for built-in ids.
      const existingIds = new Set(INITIAL_APPS.map((a) => a.id));
      const normalized: AppItem[] = [];
      for (const raw of saved) {
        const app = normalizeImportedApp(raw);
        if (app && !existingIds.has(app.id)) {
          normalized.push(app);
          existingIds.add(app.id);
        }
      }
      return [...INITIAL_APPS, ...normalized];
    }
    return INITIAL_APPS;
  });

  // Favorites
  const [favorites, setFavorites] = useState<string[]>(() => {
    const saved = loadWithMigration<string[]>(STORAGE_KEYS.favorites);
    if (saved && Array.isArray(saved)) {
      return saved.filter((id) => typeof id === 'string');
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
      const current = localStorage.getItem(STORAGE_KEYS.viewMode.current);
      if (current === 'grid' || current === 'table') return current;
      const legacy = localStorage.getItem(STORAGE_KEYS.viewMode.legacy);
      if (legacy === 'grid' || legacy === 'table') {
        localStorage.setItem(STORAGE_KEYS.viewMode.current, legacy);
        localStorage.removeItem(STORAGE_KEYS.viewMode.legacy);
        return legacy;
      }
    } catch {
      // ignore
    }
    return 'grid';
  });

  const handleToggleViewMode = (mode: 'grid' | 'table') => {
    setViewMode(mode);
    try {
      localStorage.setItem(STORAGE_KEYS.viewMode.current, mode);
    } catch {
      // ignore
    }
  };

  // Cookie consent
  const [cookieConsent, setCookieConsent] = useState<CookieConsentState>(() => {
    const saved = loadWithMigration<CookieConsentState>(STORAGE_KEYS.cookies);
    if (saved && typeof saved === 'object' && 'decided' in saved) {
      return saved;
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
  const [tauriModalTab, setTauriModalTab] = useState<'install' | 'why' | 'build'>('install');
  const [isPrivacyModalOpen, setIsPrivacyModalOpen] = useState(false);
  const [isShortcutsModalOpen, setIsShortcutsModalOpen] = useState(false);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [isBatchInstallModalOpen, setIsBatchInstallModalOpen] = useState(false);
  const [isCompareModalOpen, setIsCompareModalOpen] = useState(false);
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [isLiveSearchOpen, setIsLiveSearchOpen] = useState(false);

  const [legalModal, setLegalModal] = useState<{ isOpen: boolean; tab: LegalTab }>({
    isOpen: false,
    tab: 'privacy'
  });

  // Persist favorites
  const toggleFavorite = (appId: string) => {
    setFavorites((prev) => {
      const next = prev.includes(appId)
        ? prev.filter((id) => id !== appId)
        : [...prev, appId];
      try {
        localStorage.setItem(STORAGE_KEYS.favorites.current, JSON.stringify(next));
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
    toast.success(tI18n('app.selectAllBatch').replace('{n}', String(apps.length)));
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
        toast.info(tI18n('app.compareMax'));
        return prev;
      }
      const app = apps.find((a) => a.id === appId);
      toast.success(tI18n('app.compareAdded').replace('{name}', app?.name || 'app'));
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
        toast.success(tI18n('app.saved').replace('{name}', appToSave.name));
      } else {
        updated = [appToSave, ...prev];
        toast.success(tI18n('app.added').replace('{name}', appToSave.name));
      }

      try {
        const customOnly = updated.filter((item) => item.isCustom);
        localStorage.setItem(STORAGE_KEYS.customApps.current, JSON.stringify(customOnly));
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
        localStorage.setItem(STORAGE_KEYS.customApps.current, JSON.stringify(customOnly));
      } catch {
        // ignore
      }
      if (target) {
        toast.info(tI18n('app.removed').replace('{name}', target.name));
      }
      return updated;
    });

    setFavorites((prev) => {
      const next = prev.filter((id) => id !== appId);
      try {
        localStorage.setItem(STORAGE_KEYS.favorites.current, JSON.stringify(next));
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
        project: 'Fress catalog backup',
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
    link.download = `fress-backup-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    toast.success(tI18n('app.exported'));
  };

  // Import catalog
  const handleImportCatalog = (jsonString: string) => {
    try {
      const parsed = JSON.parse(jsonString);
      const incomingApps: unknown[] = Array.isArray(parsed.customApps)
        ? parsed.customApps
        : Array.isArray(parsed.apps)
          ? parsed.apps
          : [];

      setApps((prev) => {
        const existingIds = new Set(prev.map((a) => a.id));
        const newCustoms: AppItem[] = [];

        for (const raw of incomingApps) {
          const item = normalizeImportedApp(raw);
          if (item && !existingIds.has(item.id)) {
            newCustoms.push(item);
            existingIds.add(item.id);
          }
        }

        const merged = [...prev, ...newCustoms];
        try {
          const customOnly = merged.filter((item) => item.isCustom);
          localStorage.setItem(STORAGE_KEYS.customApps.current, JSON.stringify(customOnly));
        } catch {
          // ignore
        }

        if (newCustoms.length > 0) {
          toast.success(tI18n('app.imported').replace('{n}', String(newCustoms.length)));
        } else {
          toast.info(tI18n('app.importedNone'));
        }

        return merged;
      });

      if (Array.isArray(parsed.favorites) && parsed.favorites.length > 0) {
        setFavorites((prev) => {
          const incoming = parsed.favorites.filter((id: unknown): id is string => typeof id === 'string');
          const combined = Array.from(new Set([...prev, ...incoming]));
          try {
            localStorage.setItem(STORAGE_KEYS.favorites.current, JSON.stringify(combined));
          } catch {
            // ignore
          }
          return combined;
        });
      }
    } catch {
      toast.error(tI18n('app.importFail'));
    }
  };

  // Update cookie consent
  const handleUpdateCookieConsent = (newConsent: CookieConsentState) => {
    setCookieConsent(newConsent);
    try {
      localStorage.setItem(STORAGE_KEYS.cookies.current, JSON.stringify(newConsent));
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
    toast.info(tI18n('app.filtersReset'));
  };

  // Keyboard navigation & accessibility shortcuts.
  // Guard rails: never hijack Ctrl/Cmd/Alt combos (copy, paste, find, ...),
  // never fire while a modal is open, never repeat while a key is held, and
  // never trigger while typing in a form field.
  useEffect(() => {
    const anyModalOpen = () =>
      !!selectedApp ||
      !!editingApp ||
      isAddModalOpen ||
      isTauriModalOpen ||
      isPrivacyModalOpen ||
      isShortcutsModalOpen ||
      isCommandPaletteOpen ||
      isBatchInstallModalOpen ||
      isCompareModalOpen ||
      isExportModalOpen ||
      isLiveSearchOpen ||
      isDownloadsOpen ||
      legalModal.isOpen;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd+K or Ctrl+K triggers command palette anywhere
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setIsCommandPaletteOpen((prev) => !prev);
        return;
      }

      const target = e.target as HTMLElement;
      const typing =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable;
      if (typing) {
        if (e.key === 'Escape') {
          target.blur();
        }
        return;
      }

      if (e.metaKey || e.ctrlKey || e.altKey) return; // system/browser combos stay intact
      if (e.repeat) return; // holding a key must not spam modals

      if (e.key === 'Escape') {
        // Escape is owned by the topmost open modal (useModalA11y capture
        // listeners); nothing to do here on the unobstructed catalog.
        return;
      } else if (anyModalOpen()) {
        return; // single-letter shortcuts are only safe on the unobstructed catalog
      } else if (e.key === '/') {
        e.preventDefault();
        const searchInput = document.getElementById('app-search-input');
        searchInput?.focus();
      } else if (e.key === 'a' || e.key === 'A') {
        setEditingApp(null);
        setIsAddModalOpen(true);
      } else if (e.key === 'b' || e.key === 'B') {
        setIsBatchInstallModalOpen((prev) => !prev);
      } else if (e.key === 'm' || e.key === 'M') {
        setIsCompareModalOpen((prev) => !prev);
      } else if (e.key === 'e' || e.key === 'E') {
        setIsExportModalOpen((prev) => !prev);
      } else if (e.key === 'd' || e.key === 'D') {
        setIsTauriModalOpen(true);
      } else if (e.key === 'p' || e.key === 'P') {
        setIsPrivacyModalOpen(true);
      } else if (e.key === 'c' || e.key === 'C') {
        setLegalModal({ isOpen: true, tab: 'consent' });
      } else if (e.key === 'f' || e.key === 'F') {
        handleFilterChange({ favoritesOnly: !filters.favoritesOnly });
      } else if (e.key === 't' || e.key === 'T') {
        handleFilterChange({ trendingOnly: !filters.trendingOnly });
      } else if (e.key === 'o' || e.key === 'O') {
        handleFilterChange({ ownerPickOnly: !filters.ownerPickOnly });
      } else if (e.key === 'v' || e.key === 'V') {
        handleToggleViewMode(viewMode === 'grid' ? 'table' : 'grid');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [filters, viewMode, selectedApp, editingApp, isAddModalOpen, isTauriModalOpen, isPrivacyModalOpen, isShortcutsModalOpen, isCommandPaletteOpen, isBatchInstallModalOpen, isCompareModalOpen, isExportModalOpen, isLiveSearchOpen, isDownloadsOpen, legalModal.isOpen]);

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
        onOpenTauriModal={(tab) => { setTauriModalTab(tab || 'install'); setIsTauriModalOpen(true); }}
        onOpenPrivacyModal={() => setIsPrivacyModalOpen(true)}
        onOpenShortcutsModal={() => setIsShortcutsModalOpen(true)}
        onExportCatalog={handleExportCatalog}
        onImportCatalog={handleImportCatalog}
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
              {tI18n('empty.title')}
            </h2>
            <p id="empty-state-desc" className="text-xs text-slate-400 mb-4 leading-relaxed">
              {tI18n('empty.desc')}
            </p>
            <div id="empty-state-actions" className="flex items-center justify-center gap-2">
              <button
                id="empty-reset-filters-btn"
                type="button"
                onClick={handleResetFilters}
                className="inline-flex items-center gap-1.5 text-xs font-medium bg-slate-950/[0.04] dark:bg-white/[0.04] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.08] text-slate-200 px-3 py-1.5 rounded-md border border-slate-950/10 dark:border-white/[0.08]"
              >
                <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{tI18n('empty.reset')}</span>
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
                {tI18n('empty.add')}
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
          <div className="flex items-center gap-2 me-auto">
            <span className="w-2 h-2 rounded-full bg-sky-400 animate-pulse" />
            <span className="text-xs font-semibold text-slate-100">
              {tI18n('app.selectedCount').replace('{n}', String(selectedBatchAppIds.length))}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setIsBatchInstallModalOpen(true)}
              className="inline-flex items-center gap-1.5 text-xs font-medium bg-sky-600 hover:bg-sky-500 text-white px-3 py-1.5 rounded-md transition-colors shadow-xs"
            >
              <Terminal className="w-3.5 h-3.5" />
              <span>{tI18n('app.generateScript')}</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setComparedAppIds(selectedBatchAppIds.slice(0, 4));
                setIsCompareModalOpen(true);
              }}
              className="inline-flex items-center gap-1.5 text-xs font-medium bg-slate-950/[0.06] dark:bg-white/[0.08] hover:bg-slate-950/[0.1] dark:hover:bg-white/[0.14] text-slate-200 px-2.5 py-1.5 rounded-md transition-colors"
              title={tI18n('app.batchTip')}
            >
              <Columns className="w-3.5 h-3.5 text-indigo-400" />
              <span>{tI18n('app.compareSel')}</span>
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
          className="fixed bottom-5 end-6 z-40 bg-slate-900/95 border border-indigo-500/40 rounded-xl shadow-2xl px-3.5 py-2 flex items-center gap-2.5 backdrop-blur-md"
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
        onOpenTauriModal={(tab) => { setTauriModalTab(tab || 'install'); setIsTauriModalOpen(true); }}
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
        initialTab={tauriModalTab}
        onOpenDownloads={() => setIsDownloadsOpen(true)}
        onClose={() => setIsTauriModalOpen(false)}
      />

      <PrivacyAuditModal
        isOpen={isPrivacyModalOpen}
        onClose={() => setIsPrivacyModalOpen(false)}
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

      {/* Download manager panel */}
      <DownloadManager
        isOpen={isDownloadsOpen}
        onClose={() => setIsDownloadsOpen(false)}
        onOpenGuide={() => { setTauriModalTab('install'); setIsTauriModalOpen(true); }}
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
