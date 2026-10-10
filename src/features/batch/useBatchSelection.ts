// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { AppItem } from '../../types';
import { useI18n } from '../../lib/i18n';
import { useDownloadActions } from '../../lib/downloads';
import { openExternal } from '../../lib/external';
import { bestDownloadFor } from '../../lib/appDownloads';
import { guessUserPlatform, resolveDownloadFor } from '../../lib/releaseFetch';

/**
 * Batch selection state and the real batch download orchestration.
 *
 * The hook needs the current catalog (to translate ids into apps) and a
 * callback that opens the download manager panel; both are passed in so
 * the hook owns selection semantics only.
 */

export interface BatchSelection {
  selectedIds: string[];
  selectedApps: AppItem[];
  resolving: boolean;
  toggleSelect: (appId: string) => void;
  selectAll: () => void;
  clear: () => void;
  addIds: (ids: string[]) => void;
  removeIds: (ids: string[]) => void;
  downloadSelected: () => Promise<void>;
}

export function useBatchSelection(apps: AppItem[], openDownloads: () => void): BatchSelection {
  const { t } = useI18n();
  const { startDownload } = useDownloadActions();

  // Batch selection IDs
  const [selectedBatchAppIds, setSelectedBatchAppIds] = useState<string[]>([]);

  const [batchResolving, setBatchResolving] = useState(false);

  const selectedBatchApps = useMemo(() => {
    return apps.filter((a) => selectedBatchAppIds.includes(a.id));
  }, [apps, selectedBatchAppIds]);

  // Selection helper shared by the Privacy Pack tab and the batch checkboxes.
  const addIds = (ids: string[]) => {
    setSelectedBatchAppIds((prev) => Array.from(new Set([...prev, ...ids])));
  };

  // Privacy tab picks stay in sync with the batch selection both ways:
  // picking a replacement adds it, unpicking (or clearing a category) removes it.
  const removeIds = (ids: string[]) => {
    setSelectedBatchAppIds((prev) => prev.filter((id) => !ids.includes(id)));
  };

  // Batch toggle
  const toggleSelect = (appId: string) => {
    setSelectedBatchAppIds((prev) =>
      prev.includes(appId) ? prev.filter((id) => id !== appId) : [...prev, appId]
    );
  };

  const selectAll = () => {
    setSelectedBatchAppIds(apps.map((a) => a.id));
    toast.success(`Selected all ${apps.length} applications for batch operations.`);
  };

  const clear = () => {
    setSelectedBatchAppIds([]);
  };

  // Real downloads for the whole batch selection: resolve the latest stable
  // file for this device for every selected app and hand each one to the
  // download manager. Sequential resolve keeps the GitHub API calm; the
  // results are cached per repo anyway.
  const downloadSelected = async () => {
    if (selectedBatchApps.length === 0 || batchResolving) return;
    setBatchResolving(true);
    openDownloads();
    try {
      let started = 0;
      let weakPicks = 0;
      const skipped: string[] = [];
      const skippedApps: typeof selectedBatchApps = [];
      for (const app of selectedBatchApps) {
        const platform = guessUserPlatform(app);
        let url: string | null = null;
        let name = app.name;
        let hash: { expectedSha256?: string; expectedSha512?: string } | undefined;
        try {
          // Confidence order lives in resolveDownloadFor: confident GitHub
          // pick, then the F-Droid package, then a flagged weak pick.
          const resolved = await resolveDownloadFor(app, platform);
          if (resolved) {
            url = resolved.url;
            name = resolved.filename;
            // Vendor-manifest checksums (GIMP/Signal/Proton) verify the
            // finished file exactly like a single download does.
            hash = {
              expectedSha256: resolved.expectedSha256,
              expectedSha512: resolved.expectedSha512,
            };
            if (resolved.weak) weakPicks += 1;
          }
        } catch {
          url = null;
        }
        if (!url) {
          const target = bestDownloadFor(app, platform);
          if (target?.kind === 'direct') {
            url = target.url;
            name = `${app.name} ${target.label}`.trim();
            hash = undefined;
          }
        }
        if (url) {
          void startDownload(url, name, hash);
          started += 1;
        } else {
          skipped.push(app.name);
          skippedApps.push(app);
        }
      }
      if (started > 0) {
        toast.success(t('batchDL.started').replace('{n}', String(started)), {
          description:
            weakPicks > 0
              ? t('batchDL.weakNote').replace('{n}', String(weakPicks))
              : undefined,
        });
      }
      if (skipped.length > 0) {
        // The old hint just said "open their Guide" - a dead end that read as
        // a joke when the skipped apps were famous ones (LocalSend, AppFlowy).
        // Now the toast carries an action that opens each skipped app's
        // official download target (curated page, downloadUrl or releases
        // page) directly in the browser, staggered so popup blockers keep up.
        toast.info(t('batchDL.skipped').replace('{n}', String(skipped.length)), {
          description: `${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? '…' : ''}: ${t('batchDL.skippedHint')}`,
          action: {
            label: t('batchDL.openPages'),
            onClick: () => {
              skippedApps.slice(0, 5).forEach((app, i) => {
                const url =
                  bestDownloadFor(app, guessUserPlatform(app))?.url ||
                  app.websiteUrl ||
                  app.downloadUrl;
                if (url) setTimeout(() => void openExternal(url), i * 600);
              });
            },
          },
        });
      }
      if (started === 0 && skipped.length === 0) {
        toast.info(t('batchDL.nothing'));
      }
    } finally {
      setBatchResolving(false);
    }
  };

  return {
    selectedIds: selectedBatchAppIds,
    selectedApps: selectedBatchApps,
    resolving: batchResolving,
    toggleSelect,
    selectAll,
    clear,
    addIds,
    removeIds,
    downloadSelected,
  };
}
