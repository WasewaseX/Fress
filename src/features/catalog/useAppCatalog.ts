// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { useCallback, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { INITIAL_APPS } from '../../data/appsData';
import { AppItem } from '../../types';
import { sanitizeAppItem } from '../../lib/appValidation';
import { useI18n, formatMessage } from '../../lib/i18n';

/**
 * Catalog state: the built-in entries plus the user's own, and the
 * favorites list. Owns every write to their localStorage stores.
 *
 * Persistence semantics (unchanged from the monolithic App):
 * - custom apps live under `fress_custom_items`, sanitized on the way in
 *   AND on the way out of storage;
 * - favorites live under `fress_favorites`, strings only;
 * - corrupted or hand-edited storage degrades to the defaults instead of
 *   poisoning the render;
 * - saving/deleting persists ONLY the custom entries.
 */

const STORAGE_KEY_CUSTOM_APPS = 'fress_custom_items';
const STORAGE_KEY_FAVORITES = 'fress_favorites';

export interface AppCatalog {
  apps: AppItem[];
  favorites: string[];
  customCount: number;
  androidCount: number;
  trendingApps: AppItem[];
  ownerPicks: AppItem[];
  toggleFavorite: (appId: string) => void;
  saveApp: (appToSave: AppItem) => void;
  deleteApp: (appId: string) => void;
  exportCatalog: () => void;
  importCatalog: (jsonString: string) => void;
  refreshTrendingFromApi: () => Promise<void>;
}

function loadInitialApps(): AppItem[] {
  try {
    const saved = localStorage.getItem(STORAGE_KEY_CUSTOM_APPS);
    if (saved) {
      const parsed: unknown = JSON.parse(saved);
      const cleaned = (Array.isArray(parsed) ? parsed : [])
        .map((item) => sanitizeAppItem(item).app)
        .filter((a): a is AppItem => a !== null)
        .map((a) => ({ ...a, isCustom: true }));
      return [...INITIAL_APPS, ...cleaned];
    }
  } catch {
    // fallback to initial apps
  }
  return INITIAL_APPS;
}

function loadInitialFavorites(): string[] {
  try {
    const saved = localStorage.getItem(STORAGE_KEY_FAVORITES);
    if (saved) {
      const parsed: unknown = JSON.parse(saved);
      if (Array.isArray(parsed)) {
        return parsed.filter((f): f is string => typeof f === 'string');
      }
    }
  } catch {
    // fallback
  }
  return [];
}

export function useAppCatalog(): AppCatalog {
  // Load custom apps from local storage. Every entry passes through the
  // runtime sanitizer (same one as imports): an older version, a corrupted
  // write or tampered storage must not be able to put a malformed app -
  // `platforms: null` crashed whole rendering paths - or a script payload
  // back into circulation.
  const [apps, setApps] = useState<AppItem[]>(loadInitialApps);

  // Favorites. Corrupted storage (an object or a string where the array
  // should be) used to flow straight into `favorites.includes(...)` calls
  // and break the whole render - parse defensively, keep strings only.
  const [favorites, setFavorites] = useState<string[]>(loadInitialFavorites);

  // Toast wording follows the active language. The translator lives in a
  // ref so the card-facing callbacks below keep their documented stable
  // identity (see toggleFavorite) even when the language switches.
  const { t } = useI18n();
  const tRef = useRef(t);
  tRef.current = t;

  // Latest-value mirrors for the catalog/favorites state. The card-facing
  // callbacks below stay identity-stable (memoized cards rely on it) while
  // computing against current data. Side effects (toasts, localStorage)
  // must live OUTSIDE state updater functions: updaters are re-run by
  // StrictMode and can re-run on discarded concurrent renders, which
  // duplicated toasts and executed the storage writes twice.
  const appsRef = useRef(apps);
  appsRef.current = apps;
  const favoritesRef = useRef(favorites);
  favoritesRef.current = favorites;

  const trendingApps = useMemo(() => apps.filter((a) => a.isTrendingToday), [apps]);
  const ownerPicks = useMemo(() => apps.filter((a) => a.isOwnerPick), [apps]);
  const customCount = useMemo(() => apps.filter((a) => a.isCustom).length, [apps]);
  const androidCount = useMemo(() => apps.filter((a) => a.platforms.includes('android')).length, [apps]);

  // Persist favorites. Wrapped in useCallback with empty deps: this is a
  // card-facing prop, and memoized cards rely on its identity never
  // changing.
  const toggleFavorite = useCallback((appId: string) => {
    const prev = favoritesRef.current;
    const next = prev.includes(appId)
      ? prev.filter((id) => id !== appId)
      : [...prev, appId];
    favoritesRef.current = next;
    setFavorites(next);
    try {
      localStorage.setItem(STORAGE_KEY_FAVORITES, JSON.stringify(next));
    } catch {
      // ignore
    }
  }, []);

  // Add or update application. Dialog state is deliberately NOT touched
  // here: the composition layer closes the editor when it calls this.
  // Stable identity - see toggleFavorite.
  const saveApp = useCallback((appToSave: AppItem) => {
    const prev = appsRef.current;
    const existingIndex = prev.findIndex((item) => item.id === appToSave.id);
    let updated: AppItem[];

    if (existingIndex >= 0) {
      updated = [...prev];
      updated[existingIndex] = appToSave;
      // formatMessage (split/join): a custom app name is user input, and
      // String.prototype.replace would treat "$&" in the name as the whole
      // match, corrupting the toast (same class as the round-8 palette fix).
      toast.success(formatMessage(tRef.current('catalog.updatedOk'), { name: appToSave.name }));
    } else {
      updated = [appToSave, ...prev];
      toast.success(formatMessage(tRef.current('catalog.addedOk'), { name: appToSave.name }));
    }

    appsRef.current = updated;
    setApps(updated);
    try {
      const customOnly = updated.filter((item) => item.isCustom);
      localStorage.setItem(STORAGE_KEY_CUSTOM_APPS, JSON.stringify(customOnly));
    } catch {
      // ignore
    }
  }, []);

  // Delete a custom application from the catalog and the favorites store.
  // Selection/compare/detail cleanup stays with the composition layer,
  // which owns those states. Stable identity - see toggleFavorite.
  const deleteApp = useCallback((appId: string) => {
    const prev = appsRef.current;
    const target = prev.find((a) => a.id === appId);
    const updated = prev.filter((item) => item.id !== appId);
    appsRef.current = updated;
    setApps(updated);
    try {
      const customOnly = updated.filter((item) => item.isCustom);
      localStorage.setItem(STORAGE_KEY_CUSTOM_APPS, JSON.stringify(customOnly));
    } catch {
      // ignore
    }
    if (target) {
      toast.info(formatMessage(tRef.current('catalog.removedOk'), { name: target.name }));
    }

    const favPrev = favoritesRef.current;
    const nextFavs = favPrev.filter((id) => id !== appId);
    favoritesRef.current = nextFavs;
    setFavorites(nextFavs);
    try {
      localStorage.setItem(STORAGE_KEY_FAVORITES, JSON.stringify(nextFavs));
    } catch {
      // ignore
    }
  }, []);

  // Export catalog
  const exportCatalog = () => {
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
    toast.success(tRef.current('catalog.exportOk'));
  };

  // Import catalog
  const importCatalog = (jsonString: string) => {
    let parsed: any;
    try {
      parsed = JSON.parse(jsonString);
    } catch {
      toast.error(tRef.current('catalog.importParseFailed'));
      return;
    }

    // Shape validation before anything is touched: a corrupted or foreign
    // file must be rejected with a reason, not half-applied.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      toast.error(tRef.current('catalog.importInvalidRoot'));
      return;
    }
    const incomingApps: AppItem[] = parsed.customApps || parsed.apps || [];
    if (!Array.isArray(incomingApps)) {
      toast.error(tRef.current('catalog.importAppsNotArray'));
      return;
    }
    if (parsed.favorites !== undefined && !Array.isArray(parsed.favorites)) {
      toast.error(tRef.current('catalog.importFavoritesCorrupt'));
      return;
    }
    if (parsed.meta && typeof parsed.meta === 'object' && typeof parsed.meta.version === 'string') {
      const major = parseInt(parsed.meta.version.split('.')[0] || '0', 10);
      if (major > 1) {
        toast.error(formatMessage(tRef.current('catalog.importNewerVersion'), { version: parsed.meta.version }));
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
      // Full runtime validation: a backup can come from anyone. Every field
      // is type-checked and whitelisted here - the old spread-anything path
      // let `platforms: null` or `tags: "oops"` through and crashed the
      // rendering/filtering code later. Install commands end up in
      // generated batch scripts, so they are checked and anything that is
      // not a plain install invocation is dropped instead of being stored.
      const { app: clean, strippedCommands: stripped } = sanitizeAppItem(item);
      if (!clean) {
        invalidCount++;
        continue;
      }
      strippedCommands += stripped;

      // Guard against the same application arriving twice under different
      // ids (renamed export, merged backups).
      if (existingIds.has(clean.id)) {
        skippedCount++;
        continue;
      }
      if (existingNames.has(clean.name.toLowerCase())) {
        skippedCount++;
        continue;
      }

      newCustoms.push({ ...clean, isCustom: true });
      existingIds.add(clean.id);
      existingNames.add(clean.name.toLowerCase());
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
    // skipped, what was unusable, what happened to bookmarks. Count-only
    // fragments ({count} imported) sidestep noun plurals that no single
    // form survives in all five languages.
    const tt = tRef.current;
    const bits: string[] = [formatMessage(tt('catalog.importImported'), { count: newCustoms.length })];
    if (skippedCount > 0) bits.push(formatMessage(tt('catalog.importPresent'), { count: skippedCount }));
    if (invalidCount > 0) bits.push(formatMessage(tt('catalog.importInvalid'), { count: invalidCount }));
    if (mergedFavorites > 0) bits.push(formatMessage(tt('catalog.importRestored'), { count: mergedFavorites }));
    const list = bits.join(', ');
    if (newCustoms.length > 0 || mergedFavorites > 0) {
      toast.success(formatMessage(tt('catalog.importDone'), { list }));
    } else {
      toast.info(formatMessage(tt('catalog.importNothingNew'), { list }));
    }
    if (strippedCommands > 0) {
      toast.warning(formatMessage(tt('catalog.importStripped'), { count: strippedCommands }));
    }
  };

  // Refresh live trending via server API
  const refreshTrendingFromApi = async () => {
    try {
      const res = await fetch('/api/github/trending');
      if (!res.ok) throw new Error('API query failed');
      const data = await res.json();
      if (data.apps && data.apps.length > 0) {
        // Same sanitizer as every other ingestion path (storage load,
        // import): server data is still untrusted input, and a malformed
        // entry used to be able to crash rendering/filtering downstream.
        const prev = appsRef.current;
        const existingIds = new Set(prev.map((a) => a.id));
        const additions: AppItem[] = [];
        for (const item of data.apps as unknown[]) {
          const { app: clean } = sanitizeAppItem(item);
          if (!clean || existingIds.has(clean.id)) continue;
          additions.push(clean);
          existingIds.add(clean.id);
        }
        if (additions.length > 0) {
          const merged = [...additions, ...prev];
          appsRef.current = merged;
          setApps(merged);
          toast.success(formatMessage(tRef.current('catalog.trendingSynced'), { source: data.source }));
          return;
        }
      }
    } catch {
      toast.info(tRef.current('catalog.trendingOffline'));
    }
  };

  return {
    apps,
    favorites,
    customCount,
    androidCount,
    trendingApps,
    ownerPicks,
    toggleFavorite,
    saveApp,
    deleteApp,
    exportCatalog,
    importCatalog,
    refreshTrendingFromApi,
  };
}

/** Pure filter/sort over the catalog; kept next to the catalog state so
 * the predicate chain has exactly one home. */
export function filterAndSortApps(
  apps: AppItem[],
  filters: {
    search: string;
    category: string;
    platform: string;
    beginnerOnly: boolean;
    ownerPickOnly: boolean;
    trendingOnly: boolean;
    favoritesOnly: boolean;
    customOnly: boolean;
    sortBy: 'stars' | 'name' | 'newest';
  },
  favorites: string[]
): AppItem[] {
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

      if (filters.platform !== 'all' && !app.platforms.includes(filters.platform as AppItem['platforms'][number])) {
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
}
