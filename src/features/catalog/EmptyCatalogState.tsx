// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { SearchX, RotateCcw } from 'lucide-react';
import { useI18n } from '../../lib/i18n';

/**
 * Empty state for a catalog view that filtered everything out.
 * Presentation only.
 */
export function EmptyCatalogState(props: {
  onResetFilters: () => void;
  onAddApp: () => void;
}) {
  const { t } = useI18n();
  const { onResetFilters, onAddApp } = props;

  return (
    <div id="no-apps-empty-state" className="bg-slate-900 border border-slate-950/10 dark:border-white/[0.08] rounded-lg p-10 text-center max-w-md mx-auto my-8">
      <SearchX className="w-8 h-8 text-slate-500 mx-auto mb-3" aria-hidden="true" />
      <h2 id="empty-state-title" className="text-sm font-semibold text-slate-100 mb-1">
        {t('empty.title')}
      </h2>
      <p id="empty-state-desc" className="text-xs text-slate-400 mb-4 leading-relaxed">
        {t('empty.desc')}
      </p>
      <div id="empty-state-actions" className="flex items-center justify-center gap-2">
        <button
          id="empty-reset-filters-btn"
          type="button"
          onClick={onResetFilters}
          className="inline-flex items-center gap-1.5 text-xs font-medium bg-slate-950/[0.04] dark:bg-white/[0.04] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.08] text-slate-200 px-3 py-1.5 rounded-md border border-slate-950/10 dark:border-white/[0.08]"
        >
          <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
          <span>{t('empty.reset')}</span>
        </button>
        <button
          id="empty-add-app-btn"
          type="button"
          onClick={onAddApp}
          className="text-xs font-semibold bg-sky-600 hover:bg-sky-500 text-white px-3 py-1.5 rounded-md border border-sky-400"
        >
          {t('empty.add')}
        </button>
      </div>
    </div>
  );
}
