// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { Download, Terminal, Columns, X } from 'lucide-react';
import { useI18n } from '../../lib/i18n';

/**
 * Floating bottom bar for the current batch selection. Presentation only:
 * the state and the actions live in useBatchSelection / useCompareSelection.
 */
export function BatchActionBar(props: {
  selectedCount: number;
  resolving: boolean;
  onDownload: () => void;
  onOpenScriptModal: () => void;
  onCompareSelected: () => void;
  onClear: () => void;
}) {
  const { t } = useI18n();
  const { selectedCount, resolving, onDownload, onOpenScriptModal, onCompareSelected, onClear } = props;

  return (
    <aside
      id="floating-batch-action-bar"
      aria-label={t('batch.barAria')}
      className="fixed bottom-5 left-1/2 -translate-x-1/2 z-40 bg-slate-900/95 border border-slate-950/[0.14] dark:border-white/[0.14] rounded-xl shadow-2xl px-4 py-2.5 flex items-center gap-3 backdrop-blur-md max-w-xl w-[92%]"
    >
      <div className="flex items-center gap-2 mr-auto">
        <span className="w-2 h-2 rounded-full bg-sky-400 animate-pulse" />
        <span className="text-xs font-semibold text-slate-100">
          {t('bar.selected').replace('{n}', String(selectedCount))}
        </span>
      </div>

      <div className="flex items-center gap-2">
        {/* Primary action: real downloads for the whole selection. */}
        <button
          type="button"
          id="batch-download-btn"
          onClick={onDownload}
          disabled={resolving}
          className="inline-flex items-center gap-1.5 text-xs font-semibold bg-fr-success-strong hover:bg-fr-success-strong-hover disabled:opacity-60 text-white px-3 py-1.5 rounded-md transition-colors shadow-xs"
          title={t('bar.downloadHint')}
        >
          <Download className={`w-3.5 h-3.5 ${resolving ? 'animate-pulse' : ''}`} />
          <span>{resolving ? t('bar.downloading') : t('bar.download')}</span>
        </button>

        {/* Script generator stays available one click away. */}
        <button
          type="button"
          id="batch-script-btn"
          onClick={onOpenScriptModal}
          className="inline-flex items-center gap-1.5 text-xs font-medium bg-sky-600 hover:bg-sky-500 text-white px-2.5 py-1.5 rounded-md transition-colors shadow-xs"
          title={t('bar.scriptHint')}
        >
          <Terminal className="w-3.5 h-3.5" />
          <span>{t('bar.script')}</span>
        </button>

        <button
          type="button"
          onClick={onCompareSelected}
          className="inline-flex items-center gap-1.5 text-xs font-medium bg-slate-950/[0.06] dark:bg-white/[0.08] hover:bg-slate-950/[0.1] dark:hover:bg-white/[0.14] text-slate-200 px-2.5 py-1.5 rounded-md transition-colors"
          title={t('batch.compareHint')}
        >
          <Columns className="w-3.5 h-3.5 text-indigo-400" />
          <span>{t('bar.compare')}</span>
        </button>

        <button
          type="button"
          onClick={onClear}
          className="p-1.5 text-slate-400 hover:text-slate-100 rounded hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.08] transition-colors"
          title={t('batch.clearSelection')}
          aria-label={t('batch.clearSelectionAria')}
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </aside>
  );
}
