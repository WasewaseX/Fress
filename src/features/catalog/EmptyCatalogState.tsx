// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { SearchX, RotateCcw, PackagePlus } from 'lucide-react';
import { useI18n } from '../../lib/i18n';

/**
 * Zero-result screen. It is a product moment, not an error: it answers
 * three questions in order - why is this empty, how do I get my apps back,
 * how do I add what is missing. Reset Filters is the recovery action;
 * Add App is secondary. When the catalog itself is truly empty (totalCount
 * is 0), the filters story is dropped because resetting cannot help.
 * Presentation only.
 */
export function EmptyCatalogState(props: {
  onResetFilters: () => void;
  onAddApp: () => void;
  /** Total apps in the catalog before filters; 0 means the catalog itself is empty. */
  totalCount?: number;
}) {
  const { t } = useI18n();
  const { onResetFilters, onAddApp, totalCount = 0 } = props;
  const catalogItselfEmpty = totalCount === 0;
  const title = catalogItselfEmpty ? t('empty.catalogTitle') : t('empty.title');
  const description = catalogItselfEmpty ? t('empty.catalogDesc') : t('empty.desc');

  return (
    <div
      id="no-apps-empty-state"
      className="bg-fr-surface border border-fr-border rounded-xl p-8 sm:p-10 text-center max-w-md mx-auto my-8"
    >
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-fr-bg border border-fr-border">
        <SearchX className="h-6 w-6 text-fr-text-muted" aria-hidden="true" />
      </div>
      <h2 id="empty-state-title" className="text-base font-semibold text-fr-text mb-1.5">
        {title}
      </h2>
      <p id="empty-state-desc" className="text-sm text-fr-text-muted mb-5 leading-relaxed">
        {description}
      </p>
      <div
        id="empty-state-actions"
        className="flex flex-col sm:flex-row items-stretch sm:items-center justify-center gap-2"
      >
        {!catalogItselfEmpty && (
          <button
            id="empty-reset-filters-btn"
            type="button"
            onClick={onResetFilters}
            className="inline-flex items-center justify-center gap-1.5 h-[var(--fr-h-primary)] px-4 text-xs font-semibold bg-fr-primary hover:bg-fr-primary-hover text-white rounded-lg border border-fr-primary-hover transition-colors shadow-xs"
          >
            <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{t('empty.reset')}</span>
          </button>
        )}
        <button
          id="empty-add-app-btn"
          type="button"
          onClick={onAddApp}
          className={
            catalogItselfEmpty
              ? 'inline-flex items-center justify-center gap-1.5 h-[var(--fr-h-primary)] px-4 text-xs font-semibold bg-fr-primary hover:bg-fr-primary-hover text-white rounded-lg border border-fr-primary-hover transition-colors shadow-xs'
              : 'inline-flex items-center justify-center gap-1.5 h-[var(--fr-h-primary)] px-4 text-xs font-medium text-fr-text bg-fr-bg hover:bg-fr-bg border border-fr-border hover:border-fr-border-strong rounded-lg transition-colors'
          }
        >
          <PackagePlus className="w-3.5 h-3.5" aria-hidden="true" />
          <span>{t('empty.add')}</span>
        </button>
      </div>
    </div>
  );
}
