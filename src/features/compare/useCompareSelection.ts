// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { AppItem } from '../../types';

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
  // Compare IDs
  const [comparedAppIds, setComparedAppIds] = useState<string[]>([]);

  const comparedApps = useMemo(() => {
    return apps.filter((a) => comparedAppIds.includes(a.id));
  }, [apps, comparedAppIds]);

  // Compare toggle. Card-facing: stable identity via useCallback (memoized
  // cards rely on it). `apps` only feeds the confirmation toast's name.
  const toggleCompare = useCallback((appId: string) => {
    setComparedAppIds((prev) => {
      if (prev.includes(appId)) {
        return prev.filter((id) => id !== appId);
      }
      if (prev.length >= MAX_COMPARE) {
        toast.info('Maximum 4 applications can be compared simultaneously.');
        return prev;
      }
      const app = apps.find((a) => a.id === appId);
      toast.success(`Added "${app?.name || 'app'}" to comparison matrix.`);
      return [...prev, appId];
    });
  }, [apps]);

  const removeApp = useCallback((appId: string) => {
    setComparedAppIds((prev) => prev.filter((id) => id !== appId));
  }, []);

  const clear = useCallback(() => {
    setComparedAppIds([]);
  }, []);

  const setIds = useCallback((ids: string[]) => {
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
