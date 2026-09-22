import React, { useState, useEffect, useMemo } from 'react';
import { Header } from './components/Header';
import { FilterBar } from './components/FilterBar';
import { SpotlightSection } from './components/SpotlightSection';
import { AppCard } from './components/AppCard';
import { TableView } from './components/TableView';
import { AppDetailModal } from './components/AppDetailModal';
import { AddAppModal } from './components/AddAppModal';
import { TauriModal } from './components/TauriModal';
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
import { WhatsNewModal } from './components/WhatsNewModal';
import { ReplaceTab } from './components/ReplaceTab';
import { ThemeProvider, useTheme } from './components/ThemeProvider';
import { I18nProvider } from './lib/i18n';
import { DownloadsProvider, useDownloads } from './lib/downloads';
import { openExternal } from './lib/external';
import { checkForUpdate, OwnRelease, getUpdateChannel, setUpdateChannel, UpdateChannel } from './lib/selfUpdate';
import pkg from '../package.json';

import { INITIAL_APPS } from './data/appsData';
import { 
  AppItem, 
  Category,
  FilterState
} from './types';
import { 
  SearchX, 
  RotateCcw, 
  Terminal, 
  Columns, 
  Share2, 
  X, 
  Download,
  CheckSquare, 
  Square 
} from 'lucide-react';
import { Toaster, toast } from 'sonner';
import { sanitizeInstallCommand } from './lib/installCommands';
import { bestDownloadFor } from './lib/appDownloads';
import { guessUserPlatform, resolveGitHubDownload, resolveFdroidDownload } from './lib/releaseFetch';
import { useI18n } from './lib/i18n';

const STORAGE_KEY_CUSTOM_APPS = 'fress_custom_items';
const STORAGE_KEY_FAVORITES = 'fress_favorites';
const STORAGE_KEY_VIEW_MODE = 'awesome_free_apps_view_mode';
const STORAGE_KEY_PAGE = 'fress.page';
const STORAGE_KEY_PLATFORM = 'fress_platform_filter';

// Each device starts with its own platform preselected: Android opens on the
// Android catalog, everything else opens on the full list. The user's last
// choice is remembered and always wins over the device default.
const isAndroidDevice = typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent);
const deviceDefaultPlatform: FilterState['platform'] = isAndroidDevice ? 'android' : 'all';

function initialPlatform(): FilterState['platform'] {
  try {
    const saved = localStorage.getItem(STORAGE_KEY_PLATFORM);
    if (saved) return saved as FilterState['platform'];
  } catch {
    // ignore
  }
  return deviceDefaultPlatform;
}

const DEFAULT_FILTERS: FilterState = {
  search: '',
  category: 'All',
  platform: deviceDefaultPlatform,
  beginnerOnly: false,
  ownerPickOnly: false,
  trendingOnly: false,
  favoritesOnly: false,
  customOnly: false,
  sortBy: 'stars'
};

function AppShell() {
  const { theme: uiTheme } = useTheme();
  const { t } = useI18n();
  const { items: downloadItems, startDownload } = useDownloads();
  const [isDownloadsOpen, setIsDownloadsOpen] = useState(false);
  const activeDownloadCount = downloadItems.filter((d) => d.status === 'active').length;

  // In-app self-update: compares this install against the newest GitHub
  // release. Checked automatically at most once every 24 hours, plus on
  // demand from the menu. When an update exists, the header shows a pill;
  // tapping it downloads the platform file (an APK update on Android keeps
  // all apps and data, no reinstall needed).
  const [ownUpdate, setOwnUpdate] = useState<{ release: OwnRelease; asset: { name: string; size: number; url: string } | null; expectedSha256: string | null } | null>(null);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateChannel, setUpdateChannelState] = useState<UpdateChannel>(() => getUpdateChannel());

  const handleUpdateChannelChange = (channel: UpdateChannel) => {
    setUpdateChannelState(channel);
    setUpdateChannel(channel);
    toast.info(`Update channel: ${channel}`, {
      description: 'Re-check for updates to apply the new channel.',
    });
  };

  const runUpdateCheck = async (announce: boolean) => {
    if (updateChecking) return;
    setUpdateChecking(true);
    const res = await checkForUpdate(pkg.version);
    setOwnUpdate(res.kind === 'available' ? { release: res.release, asset: res.asset, expectedSha256: res.expectedSha256 } : null);
    if (announce) {
      if (res.kind === 'available') {
        toast.info(`Fress v${res.release.version} is available.`, {
          description: 'Use the Update button in the header. Your apps and data are kept.',
        });
      } else if (res.kind === 'latest') {
        toast.success(`You are on the latest version (v${pkg.version}).`);
      } else {
        // Both the API and the atom fallback failed (offline, firewall). This
        // is normal and must not look like the app is broken: quiet note, no
        // red error.
        toast.info(t('update.unavailable'), {
          description: t('update.unavailableHint'),
        });
      }
    }
    setUpdateChecking(false);
  };

  // Startup check, throttled to once a day so the GitHub API is not hammered.
  // The throttle stamp is only saved AFTER the check finishes: a failed check
  // (rate limit, offline) must not block every launch for the next 24 hours.
  useEffect(() => {
    try {
      const last = Number(localStorage.getItem('fress.last_update_check') || '0');
      if (Date.now() - last < 24 * 60 * 60 * 1000) return;
    } catch {
      return;
    }
    void runUpdateCheck(false).then(() => {
      try {
        localStorage.setItem('fress.last_update_check', String(Date.now()));
      } catch {
        // ignore
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleHeaderUpdateClick = () => {
    if (!ownUpdate) return;
    if (ownUpdate.asset) {
      // The download is verified against the release's published
      // SHA256SUMS.txt entry before it counts as finished.
      void startDownload(ownUpdate.asset.url, ownUpdate.asset.name, { expectedSha256: ownUpdate.expectedSha256 || undefined });
      toast.success('Update downloading…', {
        description: 'When it finishes, open the file to update Fress. Your apps and data stay.',
      });
    } else {
      void openExternal(ownUpdate.release.htmlUrl);
    }
  };

  // "What's new": opens once per version, and only for returning users.
  // A fresh install stays silent. Returning users upgrading from versions
  // that never recorded a seen-version still get the release summary once.
  const [showWhatsNew, setShowWhatsNew] = useState(false);
  useEffect(() => {
    try {
      const returning = !!(
        localStorage.getItem(STORAGE_KEY_FAVORITES) ||
        localStorage.getItem(STORAGE_KEY_CUSTOM_APPS) ||
        localStorage.getItem('fress.seen_version')
      );
      const seen = localStorage.getItem('fress.seen_version');
      if (returning && seen !== pkg.version) setShowWhatsNew(true);
      localStorage.setItem('fress.seen_version', pkg.version);
    } catch {
      // ignore
    }
  }, []);

  // Load custom apps from local storage. Saved commands pass through the
  // same check as imports: an older version or tampered storage must not be
  // able to put a script payload back into circulation.
  const [apps, setApps] = useState<AppItem[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_CUSTOM_APPS);
      if (saved) {
        const parsed = JSON.parse(saved) as AppItem[];
        const cleaned = (Array.isArray(parsed) ? parsed : []).map((item) => ({
          ...item,
          wingetCommand: sanitizeInstallCommand('winget', item.wingetCommand) || undefined,
          brewCommand: sanitizeInstallCommand('brew', item.brewCommand) || undefined,
          flatpakCommand: sanitizeInstallCommand('flatpak', item.flatpakCommand) || undefined,
          scoopCommand: sanitizeInstallCommand('scoop', item.scoopCommand) || undefined
        }));
        return [...INITIAL_APPS, ...cleaned];
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

  // Top-level tab: the app catalog or the privacy pack. Remembered per device.
  const [page, setPage] = useState<'catalog' | 'replace'>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_PAGE);
      if (saved === 'catalog' || saved === 'replace') return saved;
      // 'combos' was removed; returning users land on the catalog instead.
      if (saved === 'combos') {
        localStorage.setItem(STORAGE_KEY_PAGE, 'catalog');
      }
    } catch {
      // ignore
    }
    return 'catalog';
  });

  const handlePageChange = (next: 'catalog' | 'replace') => {
    setPage(next);
    try {
      localStorage.setItem(STORAGE_KEY_PAGE, next);
    } catch {
      // ignore
    }
  };

  // Selection helper shared by the Privacy Pack tab and the batch checkboxes.
  const handleAddIdsToBatch = (ids: string[]) => {
    setSelectedBatchAppIds((prev) => Array.from(new Set([...prev, ...ids])));
  };

  // Real downloads for the whole batch selection: resolve the latest stable
  // file for this device for every selected app and hand each one to the
  // download manager. Sequential resolve keeps the GitHub API calm; the
  // results are cached per repo anyway.
  const [batchResolving, setBatchResolving] = useState(false);
  const handleBatchDownload = async () => {
    if (selectedBatchApps.length === 0 || batchResolving) return;
    setBatchResolving(true);
    setIsDownloadsOpen(true);
    try {
      let started = 0;
      const skipped: string[] = [];
      for (const app of selectedBatchApps) {
        const platform = guessUserPlatform(app);
        let url: string | null = null;
        let name = app.name;
        try {
          const resolved = await resolveGitHubDownload(app, platform);
          if (resolved) {
            url = resolved.url;
            name = resolved.filename;
          }
        } catch {
          url = null;
        }
        if (!url && platform === 'android' && app.fdroidId) {
          try {
            const fd = await resolveFdroidDownload(app.fdroidId);
            if (fd) {
              url = fd.url;
              name = fd.filename;
            }
          } catch {
            url = null;
          }
        }
        if (!url) {
          const target = bestDownloadFor(app, platform);
          if (target?.kind === 'direct') {
            url = target.url;
            name = `${app.name} ${target.label}`.trim();
          }
        }
        if (url) {
          void startDownload(url, name);
          started += 1;
        } else {
          skipped.push(app.name);
        }
      }
      if (started > 0) {
        toast.success(t('batchDL.started').replace('{n}', String(started)));
      }
      if (skipped.length > 0) {
        toast.info(t('batchDL.skipped').replace('{n}', String(skipped.length)), {
          description: `${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? '…' : ''} — ${t('batchDL.skippedHint')}`,
        });
      }
      if (started === 0 && skipped.length === 0) {
        toast.info(t('batchDL.nothing'));
      }
    } finally {
      setBatchResolving(false);
    }
  };

  // Filters
  const [filters, setFilters] = useState<FilterState>(() => ({
    ...DEFAULT_FILTERS,
    platform: initialPlatform(),
  }));

  // Modals state
  const [selectedApp, setSelectedApp] = useState<AppItem | null>(null);
  const [editingApp, setEditingApp] = useState<AppItem | null>(null);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isTauriModalOpen, setIsTauriModalOpen] = useState(false);
  const [isShortcutsModalOpen, setIsShortcutsModalOpen] = useState(false);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [isBatchInstallModalOpen, setIsBatchInstallModalOpen] = useState(false);
  const [isCompareModalOpen, setIsCompareModalOpen] = useState(false);
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  // One shared add-flow: 'search' (GitHub) or 'manual' (form). A single header
  // button opens it; the tabs inside switch between the two methods.
  const [addFlow, setAddFlow] = useState<null | 'search' | 'manual'>(null);
  const [isLiveTrending, setIsLiveTrending] = useState(false);

  const [legalModal, setLegalModal] = useState<{ isOpen: boolean; tab: LegalTab }>({
    isOpen: false,
    tab: 'privacy'
  });

  // Real audit data

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
    // Schema 1.3 renames the project metadata to Fress (older backups said
    // "Awesome Free Apps Hub"); imports still accept every older schema.
    const payload = {
      meta: {
        project: 'Fress',
        exportDate: new Date().toISOString(),
        version: '1.3',
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
    toast.success('Catalog exported successfully as JSON backup.');
  };

  // Import catalog
  const handleImportCatalog = (jsonString: string) => {
    let parsed: any;
    try {
      parsed = JSON.parse(jsonString);
    } catch {
      toast.error('Failed to parse backup JSON file.');
      return;
    }

    // Shape validation before anything is touched: a corrupted or foreign
    // file must be rejected with a reason, not half-applied.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      toast.error('Invalid backup file: expected a JSON object.');
      return;
    }
    const incomingApps: AppItem[] = parsed.customApps || parsed.apps || [];
    if (!Array.isArray(incomingApps)) {
      toast.error('Invalid backup file: the apps list is not an array.');
      return;
    }
    if (parsed.favorites !== undefined && !Array.isArray(parsed.favorites)) {
      toast.error('Invalid backup file: the favorites list is corrupted (not an array).');
      return;
    }
    if (parsed.meta && typeof parsed.meta === 'object' && typeof parsed.meta.version === 'string') {
      const major = parseInt(parsed.meta.version.split('.')[0] || '0', 10);
      if (major > 1) {
        toast.error(`This backup was written by a newer Fress (schema ${parsed.meta.version}) and cannot be read safely.`);
        return;
      }
    }

    let strippedCommands = 0;

    // Counts are computed outside the state setters: React may defer updater
    // functions, so reading counters mutated inside them can toast stale
    // numbers. The closure apps/favorites are fresh in this event handler.
    const existingIds = new Set(apps.map((a) => a.id));
    const existingNames = new Set(apps.map((a) => a.name.trim().toLowerCase()));
    const newCustoms: AppItem[] = [];
    let invalidCount = 0;
    let skippedCount = 0;

    for (const item of incomingApps) {
      if (!item || typeof item !== 'object' || !item.name || typeof item.name !== 'string') {
        invalidCount++;
        continue;
      }
      if (existingIds.has(item.id)) {
        skippedCount++;
        continue;
      }
      // A catalog backup can come from anyone. Install commands end up
      // in generated batch scripts, so every command field is checked
      // and anything that is not a plain install invocation is dropped
      // instead of being stored.
      const winget = sanitizeInstallCommand('winget', item.wingetCommand);
      const brew = sanitizeInstallCommand('brew', item.brewCommand);
      const flatpak = sanitizeInstallCommand('flatpak', item.flatpakCommand);
      const scoop = sanitizeInstallCommand('scoop', item.scoopCommand);
      const apt = sanitizeInstallCommand('apt', item.aptCommand);
      strippedCommands += [
        item.wingetCommand, item.brewCommand, item.flatpakCommand, item.scoopCommand, item.aptCommand
      ].filter((raw, i) => raw && [winget, brew, flatpak, scoop, apt][i] === null).length;

      // Guard against the same application arriving twice under different
      // ids (renamed export, merged backups).
      if (existingNames.has(item.name.trim().toLowerCase())) {
        skippedCount++;
        continue;
      }

      newCustoms.push({
        ...item,
        wingetCommand: winget || undefined,
        brewCommand: brew || undefined,
        flatpakCommand: flatpak || undefined,
        scoopCommand: scoop || undefined,
        aptCommand: apt || undefined,
        isCustom: true
      });
      existingIds.add(item.id);
      existingNames.add(item.name.trim().toLowerCase());
    }

    const merged = [...apps, ...newCustoms];
    try {
      localStorage.setItem(STORAGE_KEY_CUSTOM_APPS, JSON.stringify(merged.filter((item) => item.isCustom)));
    } catch {
      // ignore
    }
    setApps(merged);

    let mergedFavorites = 0;
    if (Array.isArray(parsed.favorites) && parsed.favorites.length > 0) {
      const fresh = parsed.favorites.filter((f: unknown) => typeof f === 'string' && !favorites.includes(f as string));
      mergedFavorites = fresh.length;
      if (mergedFavorites > 0) {
        const combined = [...favorites, ...fresh];
        try {
          localStorage.setItem(STORAGE_KEY_FAVORITES, JSON.stringify(combined));
        } catch {
          // ignore
        }
        setFavorites(combined);
      }
    }

    // One summary instead of a toast barrage: what was added, what was
    // skipped, what was unusable, what happened to bookmarks.
    const bits: string[] = [`${newCustoms.length} app${newCustoms.length === 1 ? '' : 's'} imported`];
    if (skippedCount > 0) bits.push(`${skippedCount} already present`);
    if (invalidCount > 0) bits.push(`${invalidCount} invalid entr${invalidCount === 1 ? 'y' : 'ies'} skipped`);
    if (mergedFavorites > 0) bits.push(`${mergedFavorites} bookmark${mergedFavorites === 1 ? '' : 's'} restored`);
    if (newCustoms.length > 0 || mergedFavorites > 0) {
      toast.success(`Backup imported: ${bits.join(', ')}.`);
    } else {
      toast.info(`Nothing new to import (${bits.join(', ')}).`);
    }
    if (strippedCommands > 0) {
      toast.warning(
        `${strippedCommands} package command(s) in the backup were removed as unsafe. Only plain "<manager> install <package>" commands are accepted.`
      );
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

  // Filter change helper
  const handleFilterChange = (partial: Partial<FilterState>) => {
    if (partial.platform !== undefined) {
      try {
        localStorage.setItem(STORAGE_KEY_PLATFORM, partial.platform);
      } catch {
        // ignore
      }
    }
    setFilters((prev) => ({ ...prev, ...partial }));
  };

  const handleResetFilters = () => {
    try {
      localStorage.removeItem(STORAGE_KEY_PLATFORM);
    } catch {
      // ignore
    }
    setFilters({ ...DEFAULT_FILTERS, platform: deviceDefaultPlatform });
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
        setIsShortcutsModalOpen(false);
        setIsCommandPaletteOpen(false);
        setIsBatchInstallModalOpen(false);
        setIsCompareModalOpen(false);
        setIsExportModalOpen(false);
        setAddFlow(null);
        setIsDownloadsOpen(false);
        setLegalModal((prev) => ({ ...prev, isOpen: false }));
      } else if (e.key === 'a' || e.key === 'A') {
        e.preventDefault();
        setEditingApp(null);
        setAddFlow('search');
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
        onOpenAddApps={() => {
          setEditingApp(null);
          setAddFlow('search');
        }}
        onOpenTauriModal={() => setIsTauriModalOpen(true)}
        onOpenShortcutsModal={() => setIsShortcutsModalOpen(true)}
        onExportCatalog={handleExportCatalog}
        onImportCatalog={handleImportCatalog}
        viewMode={viewMode}
        onToggleViewMode={handleToggleViewMode}
        page={page}
        onPageChange={handlePageChange}
        onOpenCommandPalette={() => setIsCommandPaletteOpen(true)}
        onOpenBatchInstall={() => setIsBatchInstallModalOpen(true)}
        onOpenCompare={() => setIsCompareModalOpen(true)}
        onOpenExportModal={() => setIsExportModalOpen(true)}
        batchCount={selectedBatchAppIds.length}
        compareCount={comparedAppIds.length}
        onOpenDownloads={() => setIsDownloadsOpen(true)}
        activeDownloadCount={activeDownloadCount}
        updateVersion={ownUpdate ? ownUpdate.release.version : null}
        updateChannel={updateChannel}
        onUpdateChannelChange={handleUpdateChannelChange}
        onUpdateClick={handleHeaderUpdateClick}
        onCheckForUpdates={() => void runUpdateCheck(true)}
        onOpenWhatsNew={() => setShowWhatsNew(true)}
      />

      {/* On phones the header is position:fixed (Android webviews do not keep
          sticky headers pinned), so this spacer reserves its height. The
          height variable is measured live by the Header's ResizeObserver. */}
      <div className="md:hidden" style={{ height: 'var(--fress-header-h, 0px)' }} aria-hidden="true" />

      {/* Spotlight Section */}
      {page === 'catalog' && (
        <SpotlightSection
          onSelectTrending={() => handleFilterChange({ trendingOnly: true, ownerPickOnly: false, category: 'All' })}
          onSelectOwnerPicks={() => handleFilterChange({ ownerPickOnly: true, trendingOnly: false, category: 'All' })}
          totalApps={apps.length}
          androidCount={androidCount}
        />
      )}

      {/* Filter and Category Bar */}
      {page === 'catalog' && (
        <FilterBar
          filters={filters}
          onFilterChange={handleFilterChange}
          onResetFilters={handleResetFilters}
          favoritesCount={favorites.length}
          customCount={customCount}
          totalVisible={filteredApps.length}
          totalAll={apps.length}
        />
      )}

      {/* Main Content Area: Grid or Table View */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6 pb-24" id="main-content">
        {page === 'replace' ? (
          <ReplaceTab
            apps={apps}
            onOpenDetail={(item) => setSelectedApp(item)}
            onAddToBatch={handleAddIdsToBatch}
          />
        ) : filteredApps.length > 0 ? (
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
                  setAddFlow('search');
                }}
                className="text-xs font-semibold bg-sky-600 hover:bg-sky-500 text-white px-3 py-1.5 rounded-md border border-sky-400"
              >
                Add it yourself
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
              {t('bar.selected').replace('{n}', String(selectedBatchAppIds.length))}
            </span>
          </div>

          <div className="flex items-center gap-2">
            {/* Primary action: real downloads for the whole selection. */}
            <button
              type="button"
              id="batch-download-btn"
              onClick={() => void handleBatchDownload()}
              disabled={batchResolving}
              className="inline-flex items-center gap-1.5 text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white px-3 py-1.5 rounded-md transition-colors shadow-xs"
              title={t('bar.downloadHint')}
            >
              <Download className={`w-3.5 h-3.5 ${batchResolving ? 'animate-pulse' : ''}`} />
              <span>{batchResolving ? t('bar.downloading') : t('bar.download')}</span>
            </button>

            {/* Script generator stays available one click away. */}
            <button
              type="button"
              id="batch-script-btn"
              onClick={() => setIsBatchInstallModalOpen(true)}
              className="inline-flex items-center gap-1.5 text-xs font-medium bg-sky-600 hover:bg-sky-500 text-white px-2.5 py-1.5 rounded-md transition-colors shadow-xs"
              title={t('bar.scriptHint')}
            >
              <Terminal className="w-3.5 h-3.5" />
              <span>{t('bar.script')}</span>
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
              <span>{t('bar.compare')}</span>
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
        // No fallback list: a cleared selection must show an empty batch,
        // never five random apps whose remove buttons do nothing.
        selectedApps={selectedBatchApps}
        allApps={apps}
        onToggleAppSelection={toggleBatchSelect}
        onSelectAll={handleSelectAllBatch}
        onClearSelection={handleClearBatch}
      />

      <CompareModal
        isOpen={isCompareModalOpen}
        onClose={() => setIsCompareModalOpen(false)}
        // Same rule as the batch modal: empty means empty.
        appsToCompare={comparedApps}
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
        isOpen={addFlow === 'search'}
        onClose={() => setAddFlow(null)}
        onAddApp={handleSaveApp}
        existingApps={apps}
        showTabs
        onSwitchTab={(tab) => setAddFlow(tab)}
      />

      <AddAppModal
        isOpen={addFlow === 'manual' || isAddModalOpen}
        onClose={() => {
          setIsAddModalOpen(false);
          setEditingApp(null);
          if (addFlow === 'manual') setAddFlow(null);
        }}
        onSaveApp={handleSaveApp}
        initialApp={editingApp}
        showTabs={!isAddModalOpen}
        onSwitchTab={(tab) => setAddFlow(tab)}
      />

      <TauriModal
        isOpen={isTauriModalOpen}
        onClose={() => setIsTauriModalOpen(false)}
      />

      <WhatsNewModal
        isOpen={showWhatsNew}
        onClose={() => setShowWhatsNew(false)}
      />

      <KeyboardShortcutsModal
        isOpen={isShortcutsModalOpen}
        onClose={() => setIsShortcutsModalOpen(false)}
      />

      {/* Download manager panel */}
      <DownloadManager
        isOpen={isDownloadsOpen}
        onClose={() => setIsDownloadsOpen(false)}
      />

      <LegalModals
        isOpen={legalModal.isOpen}
        initialTab={legalModal.tab}
        onClose={() => setLegalModal((prev) => ({ ...prev, isOpen: false }))}
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
