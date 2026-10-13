// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { useCallback, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { AppItem } from '../../types';
import { useI18n } from '../../lib/i18n';

/**
 * Comparison selection state: which apps sit in the compare matrix.
 * The hard limit of 4 and its toast live here so every caller shares it.
 */

export const MAX_COMPARE = 4;

export interface CompareSelection {
  comparedIds: string[];
  comparedApps: AppItem[];
  toggleCompare: (appId: string) => void;
  removeApp: (appId: string) => void;
  clear: () => void;
  /** Replace the whole selection with the given ids (batch-bar shortcut). */
  setIds: (ids: string[]) => void;
}

export function useCompareSelection(apps: AppItem[]): CompareSelection {
  const { t } = useI18n();
  // Compare IDs
  const [comparedAppIds, setComparedAppIds] = useState<string[]>([]);

  // Latest-value mirrors: the callbacks below stay identity-stable for the
  // memoized cards while still deciding against current data. State
  // updater functions must stay PURE - the toasts used to fire inside the
  // updaters, which StrictMode double-invokes (duplicate toasts in dev)
  // and which can re-run on discarded concurrent renders.
  const appsRef = useRef(apps);
  appsRef.current = apps;
  const idsRef = useRef(comparedAppIds);
  idsRef.current = comparedAppIds;
  const tRef = useRef(t);
  tRef.current = t;

  const comparedApps = useMemo(() => {
    return apps.filter((a) => comparedAppIds.includes(a.id));
  }, [apps, comparedAppIds]);

  // Compare toggle. Card-facing: stable identity via useCallback (memoized
  // cards rely on it); reads go through the refs above.
  const toggleCompare = useCallback((appId: string) => {
    const prev = idsRef.current;
    if (prev.includes(appId)) {
      setComparedAppIds(prev.filter((id) => id !== appId));
      return;
    }
    if (prev.length >= MAX_COMPARE) {
      toast.info(tRef.current('compare.maxReached'));
      return;
    }
    const app = appsRef.current.find((a) => a.id === appId);
    // Unreachable fallback: toggles always come from rendered cards, so
    // the app exists; the id is language-neutral data if it ever fires.
    toast.success(tRef.current('compare.addedToMatrix').replace('{name}', app?.name || appId));
    setComparedAppIds([...prev, appId]);
  }, []);

  const removeApp = useCallback((appId: string) => {
    setComparedAppIds((prev) => prev.filter((id) => id !== appId));
  }, []);

  const clear = useCallback(() => {
    setComparedAppIds([]);
  }, []);

  const setIds = useCallback((ids: string[]) => {
    if (ids.length > MAX_COMPARE) {
      // The batch-bar shortcut used to drop apps 5+ silently; the toggle
      // path toasts the same limit, so the shortcut must too.
      toast.info(tRef.current('compare.maxReached'));
    }
    setComparedAppIds(ids.slice(0, MAX_COMPARE));
  }, []);

  return {
    comparedIds: comparedAppIds,
    comparedApps,
    toggleCompare,
    removeApp,
    clear,
    setIds,
  };
}
