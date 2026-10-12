// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import React, { useState } from 'react';
import { AppItem } from '../types';
import { openExternal } from '../lib/external';
import { useLiveStars } from '../lib/starFetch';
import { sourceLinksFor } from '../lib/sourceLinks';
import { AppIcon } from './AppCard';
import { useI18n, CATEGORY_I18N_KEYS, translateLicenseDisplay } from '../lib/i18n';
import { useAppText } from '../lib/appText';
import {
  Star,
  ExternalLink,
  Bookmark,
  Terminal,
  Edit3,
  Trash2,
  Flame,
  Award,
  Columns,
  Check,
  Github,
  Gitlab,
  Code2
} from 'lucide-react';

interface TableViewProps {
  apps: AppItem[];
  favorites: string[];
  onToggleFavorite: (id: string) => void;
  onOpenDetail: (app: AppItem) => void;
  onEditApp?: (app: AppItem) => void;
  onDeleteApp?: (appId: string) => void;
  selectedAppIds?: string[];
  onToggleBatchSelect?: (id: string) => void;
  comparedAppIds?: string[];
  onToggleCompare?: (id: string) => void;
}

/** One table cell: live star count with the stored number as fallback. */
const StarCell: React.FC<{ app: AppItem }> = ({ app }) => {
  const live = useLiveStars(app.githubUrl);
  const shown = live ?? app.stars;
  if (shown === 0) {
    // slate-400, not slate-600: slate-600 is a decorative/border step whose
    // light value (#d8d1c1) sits at ~1.2:1 on the paper card - as TEXT that
    // is an invisible placeholder in light mode (and ~1.6:1 in dark).
    return <span className="text-slate-400">-</span>;
  }
  return (
    <div className="inline-flex items-center gap-1">
      <Star className="w-3 h-3 fill-amber-400 text-amber-400" aria-hidden="true" />
      <span>{shown.toLocaleString()}</span>
    </div>
  );
};

/** One table cell: the localized tagline. Isolated as a component so the
 * hook stays out of the row map (Rules of Hooks), like StarCell above. */
const TaglineCell: React.FC<{ app: AppItem }> = ({ app }) => {
  const tagline = useAppText(app).tagline;
  return (
    <p className="text-fr-text-muted text-[11px] line-clamp-1 max-w-md mt-0.5">
      {tagline}
    </p>
  );
};

export const TableView: React.FC<TableViewProps> = ({
  apps,
  favorites,
  onToggleFavorite,
  onOpenDetail,
  onEditApp,
  onDeleteApp,
  selectedAppIds = [],
  onToggleBatchSelect,
  comparedAppIds = [],
  onToggleCompare
}) => {
  const { t } = useI18n();
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleCopyCmd = async (e: React.MouseEvent, cmd: string, id: string) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(cmd);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      // ignore
    }
  };

  return (
    <div id="apps-table-container" className="overflow-x-auto rounded-lg border border-fr-border bg-fr-surface">
      <table id="apps-data-table" className="w-full text-left border-collapse text-xs">
        <thead>
          <tr className="border-b border-fr-border bg-fr-bg/[0.03] dark:bg-white/[0.02] text-fr-text-muted font-mono text-[11px]">
            <th className="py-2.5 px-3 font-medium w-8"></th>
            {onToggleBatchSelect && (
              <th className="py-2.5 px-2 font-medium w-8 text-center">
                <span className="sr-only">{t('table.batchSelect')}</span>
              </th>
            )}
            <th className="py-2.5 px-3 font-medium">{t('table.head.app')}</th>
            <th className="py-2.5 px-3 font-medium">{t('table.head.category')}</th>
            <th className="py-2.5 px-3 font-medium">{t('table.head.platforms')}</th>
            <th className="py-2.5 px-3 font-medium text-right">{t('table.head.stars')}</th>
            <th className="py-2.5 px-3 font-medium">{t('table.head.license')}</th>
            <th className="py-2.5 px-3 font-medium text-right">{t('table.head.install')}</th>
            <th className="py-2.5 px-3 font-medium text-right">{t('table.head.actions')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-fr-border">
          {apps.map((app) => {
            const isFav = favorites.includes(app.id);
            const isBatch = selectedAppIds.includes(app.id);
            const isComp = comparedAppIds.includes(app.id);
            const primaryCmd = app.wingetCommand || app.brewCommand || app.flatpakCommand;

            return (
              <tr
                key={app.id}
                id={`table-row-${app.id}`}
                className={`transition-colors group cursor-pointer ${
                  isBatch ? 'bg-sky-950/20' : 'hover:bg-slate-950/[0.04] dark:hover:bg-white/[0.02]'
                }`}
                onClick={() => onOpenDetail(app)}
              >
                {/* Favorite Toggle */}
                <td className="py-2.5 px-3" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    onClick={() => onToggleFavorite(app.id)}
                    className={`p-1 fr-touch-target rounded hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06] transition-colors ${
                      isFav ? 'text-rose-400' : 'text-slate-500 hover:text-slate-300'
                    }`}
                    title={isFav ? t('card.fav.on') : t('card.fav.off')}
                    aria-label={isFav ? t('card.fav.ariaOn').replace('{name}', app.name) : t('card.fav.ariaOff').replace('{name}', app.name)}
                    aria-pressed={isFav}
                  >
                    <Bookmark className={`w-3.5 h-3.5 ${isFav ? 'fill-rose-400' : ''}`} aria-hidden="true" />
                  </button>
                </td>

                {/* Batch Checkbox */}
                {onToggleBatchSelect && (
                  <td className="py-2.5 px-2 text-center" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={isBatch}
                      onChange={() => onToggleBatchSelect(app.id)}
                      className="w-3.5 h-3.5 fr-touch-target rounded border-slate-950/20 dark:border-white/20 bg-slate-950/5 dark:bg-white/5 text-sky-500 focus:ring-sky-500 cursor-pointer accent-sky-500"
                      aria-label={t('card.batch.aria').replace('{name}', app.name)}
                    />
                  </td>
                )}

                {/* Name & Alternative */}
                <td className="py-2.5 px-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <AppIcon appId={app.id} name={app.name} size={22} />
                    {/* Keyboard path into the row: the row's mouse click is
                        not focusable, so the name itself is a real button. */}
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onOpenDetail(app); }}
                      className="text-left font-semibold text-slate-100 group-hover:text-sky-400 hover:text-sky-400 transition-colors text-inherit [font:inherit] bg-transparent border-0 p-0 m-0 cursor-pointer"
                    >
                      {app.name}
                    </button>
                    {app.proprietaryAlternative && (
                      <span className="text-[11px] font-mono text-amber-900 bg-amber-400/15 dark:text-amber-300/90 dark:bg-amber-400/10 border border-amber-400/20 px-1.5 py-0.2 rounded max-w-[24ch] truncate">
                        {t('table.vs').replace('{app}', app.proprietaryAlternative)}
                      </span>
                    )}
                    {app.isOwnerPick && (
                      <span className="inline-flex items-center gap-0.5 text-[11px] font-medium bg-amber-400/15 text-amber-900 dark:bg-amber-500/10 dark:text-amber-300 px-1.5 py-0.2 rounded border border-amber-500/20">
                        <Award className="w-2.5 h-2.5" aria-hidden="true" /> {t('table.pick')}
                      </span>
                    )}
                    {app.isTrendingToday && (
                      <span className="inline-flex items-center gap-0.5 text-[11px] font-medium bg-emerald-400/15 text-emerald-900 dark:bg-emerald-500/10 dark:text-emerald-300 px-1.5 py-0.2 rounded border border-emerald-500/20">
                        <Flame className="w-2.5 h-2.5" aria-hidden="true" /> {t('table.trend')}
                      </span>
                    )}
                  </div>
                  <TaglineCell app={app} />
                </td>

                {/* Category: translated through the shared mapping - the
                    same label the card, filters and detail modal use. */}
                <td className="py-2.5 px-3 text-slate-300">
                  <span className="bg-slate-950/[0.04] dark:bg-white/[0.04] text-slate-300 px-2 py-0.5 rounded border border-slate-950/10 dark:border-white/[0.06] text-[11px]">
                    {t(CATEGORY_I18N_KEYS[app.category])}
                  </span>
                </td>

                {/* Platforms */}
                <td className="py-2.5 px-3">
                  <div className="flex items-center gap-1 flex-wrap">
                    {app.platforms.map((p) => {
                      const isAnd = p === 'android';
                      return (
                        <span
                          key={p}
                          className={`text-[11px] uppercase font-mono px-1 py-0.2 rounded border ${
                            isAnd
                              ? 'bg-emerald-500/15 text-emerald-900 border-emerald-500/30 dark:text-emerald-300 font-semibold'
                              : 'text-slate-400 bg-slate-950/[0.04] dark:bg-white/[0.04] border-slate-950/10 dark:border-white/[0.06]'
                          }`}
                        >
                          {t(`common.platform.${p}`)}
                        </span>
                      );
                    })}
                  </div>
                </td>

                {/* GitHub Stars */}
                <td className="py-2.5 px-3 text-right font-mono text-amber-900 dark:text-amber-300">
                  <StarCell app={app} />
                </td>

                {/* License */}
                <td className="py-2.5 px-3 text-slate-400 font-mono text-[11px]">
                  {translateLicenseDisplay(t, app.license)}
                </td>

                {/* Quick Install Command */}
                <td className="py-2.5 px-3 text-right" onClick={(e) => e.stopPropagation()}>
                  {primaryCmd ? (
                    <button
                      type="button"
                      onClick={(e) => void handleCopyCmd(e, primaryCmd, app.id)}
                      className="inline-flex items-center gap-1 text-[11px] font-mono bg-slate-950/[0.04] dark:bg-white/[0.04] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.08] text-slate-300 hover:text-slate-100 px-2 py-1 rounded border border-slate-950/10 dark:border-white/[0.08] transition-colors"
                      title={primaryCmd}
                      aria-label={`${t('table.copyCmd')} (${app.name})`}
                    >
                      {copiedId === app.id ? (
                        <>
                          <Check className="w-3 h-3 text-emerald-400" aria-hidden="true" />
                          <span className="text-emerald-400">{t('card.copied')}</span>
                        </>
                      ) : (
                        <>
                          <Terminal className="w-3 h-3 text-sky-400" aria-hidden="true" />
                          <span>{t('table.copyCmd')}</span>
                        </>
                      )}
                    </button>
                  ) : (
                    <span className="text-slate-400 font-mono text-[11px]">{t('table.directDl')}</span>
                  )}
                </td>

                {/* Actions */}
                <td className="py-2.5 px-3 text-right" onClick={(e) => e.stopPropagation()}>
                  <div className="flex items-center justify-end gap-1.5">
                    {onToggleCompare && (
                      <button
                        type="button"
                        onClick={() => onToggleCompare(app.id)}
                        aria-label={isComp ? t('card.compare.ariaRemove').replace('{name}', app.name) : t('card.compare.ariaAdd').replace('{name}', app.name)}
                        aria-pressed={isComp}
                        className={`p-1 fr-touch-target rounded transition-colors ${
                          isComp ? 'text-sky-400 bg-sky-400/20' : 'text-slate-400 hover:text-slate-100 hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06]'
                        }`}
                        title={isComp ? t('card.compare.on') : t('card.compare.off')}
                      >
                        <Columns className="w-3.5 h-3.5" aria-hidden="true" />
                      </button>
                    )}

                    {sourceLinksFor(app).map((link, i) => {
                      const Icon = link.kind === 'github' ? Github : link.kind === 'gitlab' ? Gitlab : Code2;
                      return (
                        <a
                          key={link.url}
                          href={link.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => { e.preventDefault(); void openExternal(link.url); }}
                          className="p-1 fr-touch-target text-slate-400 hover:text-slate-100 hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06] rounded transition-colors"
                          title={t('card.source.tip').replace('{host}', link.label)}
                          aria-label={t('card.source.aria').replace('{name}', app.name).replace('{host}', link.label)}
                        >
                          <Icon className="w-3.5 h-3.5" aria-hidden="true" />
                        </a>
                      );
                    })}

                    {app.websiteUrl && (
                      <a
                        href={app.websiteUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => { e.preventDefault(); void openExternal(app.websiteUrl); }}
                        className="p-1 fr-touch-target text-slate-400 hover:text-slate-100 hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06] rounded transition-colors"
                        title={t('table.website.tip')}
                        aria-label={t('table.website.aria').replace('{name}', app.name)}
                      >
                        <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                      </a>
                    )}

                    {app.isCustom && onEditApp && (
                      <button
                        type="button"
                        onClick={() => onEditApp(app)}
                        aria-label={t('card.edit.aria').replace('{name}', app.name)}
                        className="p-1 fr-touch-target text-slate-400 hover:text-sky-300 hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06] rounded transition-colors"
                        title={t('card.edit.tip')}
                      >
                        <Edit3 className="w-3.5 h-3.5" aria-hidden="true" />
                      </button>
                    )}

                    {app.isCustom && onDeleteApp && (
                      <button
                        type="button"
                        onClick={() => onDeleteApp(app.id)}
                        aria-label={t('card.delete.aria').replace('{name}', app.name)}
                        className="p-1 fr-touch-target text-slate-400 hover:text-rose-400 hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06] rounded transition-colors"
                        title={t('card.delete.tip')}
                      >
                        <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};
