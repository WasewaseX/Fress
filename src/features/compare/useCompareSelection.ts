// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { useCallback, useMemo, useState } from 'react';
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
        toast.info(t('compare.maxReached'));
        return prev;
      }
      const app = apps.find((a) => a.id === appId);
      // Unreachable fallback: toggles always come from rendered cards, so
      // the app exists; the id is language-neutral data if it ever fires.
      toast.success(t('compare.addedToMatrix').replace('{name}', app?.name || appId));
      return [...prev, appId];
    });
  }, [apps, t]);

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
