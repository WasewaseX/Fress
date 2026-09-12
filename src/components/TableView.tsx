import React, { useState } from 'react';
import { AppItem } from '../types';
import { openExternal } from '../lib/external';
import { startDownloadSmart } from '../lib/smartDownload';
import { useDownloadActions } from '../lib/downloads';
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
  Download,
  Loader2
} from 'lucide-react';
import { useI18n, categoryKey } from '../lib/i18n';

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
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const { t } = useI18n();
  const { startDownload, recordExternalOpen } = useDownloadActions();

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
    <div id="apps-table-container" className="overflow-x-auto rounded-lg border border-slate-950/10 dark:border-white/[0.08] bg-slate-900">
      <table id="apps-data-table" className="w-full text-start border-collapse text-xs">
        <thead>
          <tr className="border-b border-slate-950/10 dark:border-white/[0.08] bg-slate-950/[0.03] dark:bg-white/[0.02] text-slate-400 font-mono text-[11px]">
            <th className="py-2.5 px-3 font-medium w-8"></th>
            {onToggleBatchSelect && (
              <th className="py-2.5 px-2 font-medium w-8 text-center">
                <span className="sr-only">Batch Select</span>
              </th>
            )}
            <th className="py-2.5 px-3 font-medium">{t('table.tool')}</th>
            <th className="py-2.5 px-3 font-medium">{t('table.category')}</th>
            <th className="py-2.5 px-3 font-medium">{t('table.platforms')}</th>
            <th className="py-2.5 px-3 font-medium text-end">{t('table.stars')}</th>
            <th className="py-2.5 px-3 font-medium">{t('table.license')}</th>
            <th className="py-2.5 px-3 font-medium text-end">{t('table.installCmd')}</th>
            <th className="py-2.5 px-3 font-medium text-end">{t('table.actions')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-950/10 dark:divide-white/[0.04]">
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
                    className={`p-1 rounded hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06] transition-colors ${
                      isFav ? 'text-rose-400' : 'text-slate-500 hover:text-slate-300'
                    }`}
                    title={isFav ? 'Remove bookmark' : 'Add bookmark'}
                    aria-label={`Bookmark ${app.name}`}
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
                      className="w-3.5 h-3.5 rounded border-slate-950/20 dark:border-white/20 bg-slate-950/5 dark:bg-white/5 text-sky-500 focus:ring-sky-500 cursor-pointer accent-sky-500"
                      aria-label={`Select ${app.name} for batch install`}
                    />
                  </td>
                )}

                {/* Name & Alternative */}
                <td className="py-2.5 px-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-slate-100 group-hover:text-sky-400 transition-colors">
                      {app.name}
                    </span>
                    {app.proprietaryAlternative && (
                      <span className="text-[11px] font-mono text-amber-300/90 bg-amber-400/10 border border-amber-400/20 px-1.5 py-0.5 rounded">
                        vs {app.proprietaryAlternative}
                      </span>
                    )}
                    {app.isOwnerPick && (
                      <span className="inline-flex items-center gap-0.5 text-[11px] font-medium bg-amber-500/10 text-amber-300 px-1.5 py-0.5 rounded border border-amber-500/20">
                        <Award className="w-2.5 h-2.5" /> {t('card.pick')}
                      </span>
                    )}
                    {app.isTrendingToday && (
                      <span className="inline-flex items-center gap-0.5 text-[11px] font-medium bg-emerald-500/10 text-emerald-300 px-1.5 py-0.5 rounded border border-emerald-500/20">
                        <Flame className="w-2.5 h-2.5" /> {t('card.trend')}
                      </span>
                    )}
                  </div>
                  <p className="text-slate-400 text-[11px] line-clamp-1 max-w-md mt-0.5">
                    {app.tagline}
                  </p>
                </td>

                {/* Category */}
                <td className="py-2.5 px-3 text-slate-300">
                  <span className="bg-slate-950/[0.04] dark:bg-white/[0.04] text-slate-300 px-2 py-0.5 rounded border border-slate-950/10 dark:border-white/[0.06] text-[11px]">
                    {t(categoryKey(app.category))}
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
                          className={`text-[11px] uppercase font-mono px-1 py-0.5 rounded border ${
                            isAnd 
                              ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30 font-semibold' 
                              : 'text-slate-400 bg-slate-950/[0.04] dark:bg-white/[0.04] border-slate-950/10 dark:border-white/[0.06]'
                          }`}
                        >
                          {p === 'windows' ? 'Win' : p === 'mac' ? 'Mac' : p === 'linux' ? 'Lin' : p === 'android' ? 'And' : p === 'ios' ? 'iOS' : 'Web'}
                        </span>
                      );
                    })}
                  </div>
                </td>

                {/* GitHub Stars */}
                <td className="py-2.5 px-3 text-end font-mono text-amber-300">
                  {app.stars > 0 && (
                    <div className="inline-flex items-center gap-1" title={`${app.stars.toLocaleString()} stars`}>
                      <Star className="w-3 h-3 fill-amber-400 text-amber-400" aria-hidden="true" />
                      <span>{app.stars.toLocaleString()}</span>
                    </div>
                  )}
                </td>

                {/* License */}
                <td className="py-2.5 px-3 text-slate-400 font-mono text-[11px]">
                  {app.license}
                </td>

                {/* Install command or direct-download marker */}
                <td className="py-2.5 px-3 text-end" onClick={(e) => e.stopPropagation()}>
                  {primaryCmd ? (
                    <button
                      type="button"
                      onClick={(e) => handleCopyCmd(e, primaryCmd, app.id)}
                      className="inline-flex items-center gap-1 text-[11px] font-mono bg-slate-950/[0.04] dark:bg-white/[0.04] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.08] text-slate-300 hover:text-slate-100 px-2 py-1 rounded border border-slate-950/10 dark:border-white/[0.08] transition-colors"
                      title={primaryCmd}
                      aria-label={`Copy install command for ${app.name}`}
                    >
                      {copiedId === app.id ? (
                        <>
                          <Check className="w-3 h-3 text-emerald-400" />
                          <span className="text-emerald-400">{t('common.copied')}</span>
                        </>
                      ) : (
                        <>
                          <Terminal className="w-3 h-3 text-sky-400" />
                          <span>{t('table.copyCmd')}</span>
                        </>
                      )}
                    </button>
                  ) : (
                    <span className="text-slate-400 font-mono text-[11px]">—</span>
                  )}
                </td>

                {/* Download + Actions */}
                <td className="py-2.5 px-3 text-end" onClick={(e) => e.stopPropagation()}>
                  <div className="flex items-center justify-end gap-1.5">
                    <button
                      type="button"
                      disabled={resolvingId === app.id}
                      onClick={() =>
                        void startDownloadSmart(app, {
                          startDownload,
                          recordExternalOpen,
                          onOpenDetail,
                          onResolving: (id) => setResolvingId(id),
                        })
                      }
                      className="inline-flex items-center gap-1 text-[11px] font-semibold bg-emerald-500/10 hover:bg-emerald-500/20 disabled:opacity-60 border border-emerald-500/30 text-emerald-300 px-2 py-1 rounded transition-colors"
                      title="Download for your device"
                      aria-label={`Download ${app.name}`}
                    >
                      {resolvingId === app.id ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <Download className="w-3 h-3" />
                      )}
                      <span>{t('table.download')}</span>
                    </button>

                    {onToggleCompare && (
                      <button
                        type="button"
                        onClick={() => onToggleCompare(app.id)}
                        className={`p-1 rounded transition-colors ${
                          isComp ? 'text-sky-400 bg-sky-400/20' : 'text-slate-400 hover:text-slate-100 hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06]'
                        }`}
                        title="Compare side by side"
                        aria-label={`Compare ${app.name}`}
                      >
                        <Columns className="w-3.5 h-3.5" aria-hidden="true" />
                      </button>
                    )}

                    {app.githubUrl && (
                      <a
                        href={app.githubUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => { e.preventDefault(); void openExternal(app.githubUrl); }}
                        className="p-1 text-slate-400 hover:text-slate-100 hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06] rounded transition-colors"
                        title={t('card.openSource')}
                        aria-label={`Open source code for ${app.name}`}
                      >
                        <Github className="w-3.5 h-3.5" aria-hidden="true" />
                      </a>
                    )}

                    {app.websiteUrl && (
                      <a
                        href={app.websiteUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => { e.preventDefault(); void openExternal(app.websiteUrl); }}
                        className="p-1 text-slate-400 hover:text-slate-100 hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06] rounded transition-colors"
                        title={t('card.openSite')}
                        aria-label={`Open official website for ${app.name}`}
                      >
                        <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                      </a>
                    )}

                    {app.isCustom && onEditApp && (
                      <button
                        type="button"
                        onClick={() => onEditApp(app)}
                        className="p-1 text-slate-400 hover:text-sky-300 hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06] rounded transition-colors"
                        title="Edit custom app"
                        aria-label={`Edit ${app.name}`}
                      >
                        <Edit3 className="w-3.5 h-3.5" aria-hidden="true" />
                      </button>
                    )}

                    {app.isCustom && onDeleteApp && (
                      <button
                        type="button"
                        onClick={() => onDeleteApp(app.id)}
                        className="p-1 text-slate-400 hover:text-rose-400 hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06] rounded transition-colors"
                        title="Delete custom app"
                        aria-label={`Delete ${app.name}`}
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
