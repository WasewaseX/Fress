// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { Columns, X } from 'lucide-react';
import { useI18n } from '../../lib/i18n';

/**
 * Floating indicator for apps staged for comparison while the matrix is
 * closed and the batch bar is not occupying the corner. Presentation only.
 */
export function CompareDock(props: {
  count: number;
  onOpenMatrix: () => void;
  onClear: () => void;
}) {
  const { count, onOpenMatrix, onClear } = props;
  const { t } = useI18n();

  return (
    <aside
      id="floating-compare-action-bar"
      aria-label={t('compare.dockAria')}
      className="fixed bottom-5 end-6 z-40 bg-slate-900/95 border border-indigo-500/40 rounded-xl shadow-2xl px-3.5 py-2 flex items-center gap-2.5 backdrop-blur-md"
    >
      <Columns className="w-4 h-4 text-indigo-400" aria-hidden="true" />
      {/* Count only, no noun: app/app{s} has no plural form that works in
          all five languages, and the dock sits next to the matrix button. */}
      <span className="text-xs text-slate-200 font-medium">
        {t('compare.countInDock').replace('{count}', String(count))}
      </span>
      <button
        type="button"
        onClick={onOpenMatrix}
        className="text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white px-2.5 py-1 rounded-md transition-colors ms-1"
      >
        {t('compare.viewMatrix')}
      </button>
      <button
        type="button"
        onClick={onClear}
        className="text-slate-400 hover:text-slate-100 p-1 rounded hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.08]"
        title={t('compare.clearHint')}
        aria-label={t('compare.clearHint')}
      >
        <X className="w-3.5 h-3.5" aria-hidden="true" />
      </button>
    </aside>
  );
}
