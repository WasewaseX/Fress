import React, { useState } from 'react';
import { AppItem, Platform } from '../types';
import {
  Star,
  ExternalLink,
  Github,
  Bookmark,
  Info,
  Edit2,
  Trash2,
  Check,
  Award,
  Flame,
  Terminal,
  Columns,
  HardDrive,
  Copy,
  ChevronDown,
  Download
} from 'lucide-react';

import { useDownloadActions, useAppDownloadActive } from '../lib/downloads';
import { openExternal } from '../lib/external';
import { startDownloadSmart } from '../lib/smartDownload';
import { toast } from 'sonner';
import { useI18n, categoryKey } from '../lib/i18n';


interface AppCardProps {
  app: AppItem;
  isFavorite: boolean;
  onToggleFavorite: (id: string) => void;
  onOpenDetail: (app: AppItem) => void;
  onEditApp?: (app: AppItem) => void;
  onDeleteApp?: (id: string) => void;
  isBatchSelected?: boolean;
  onToggleBatchSelect?: (id: string) => void;
  isCompared?: boolean;
  onToggleCompare?: (id: string) => void;
}

const AppCardBase: React.FC<AppCardProps> = ({
  app,
  isFavorite,
  onToggleFavorite,
  onOpenDetail,
  onEditApp,
  onDeleteApp,
  isBatchSelected = false,
  onToggleBatchSelect,
  isCompared = false,
  onToggleCompare
}) => {
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [copiedType, setCopiedType] = useState<string | null>(null);
  const [showInstallMenu, setShowInstallMenu] = useState(false);
  const { startDownload, recordExternalOpen } = useDownloadActions();
  const { t } = useI18n();
  const isDownloading = useAppDownloadActive(app.id);
  const [resolving, setResolving] = useState(false);

  const formatStars = (stars: number) => {
    if (stars >= 1000) {
      const k = stars / 1000;
      const label = k >= 10 ? k.toFixed(0) : k.toFixed(1);
      return `${label.replace(/\.0$/, '')}k`;
    }
    return stars.toString();
  };

  const renderPlatformBadge = (platform: Platform) => {
    const label =
      platform === 'windows' ? 'Windows' :
      platform === 'mac' ? 'macOS' :
      platform === 'linux' ? 'Linux' :
      platform === 'android' ? 'Android' :
      platform === 'web' ? 'Web' : 'iOS';

    return (
      <span
        key={platform}
        id={`platform-${platform}-${app.id}`}
        className="text-[11px] text-slate-400"
        title={`${label} supported`}
      >
        {label}
      </span>
    );
  };

  const handleCopyCmd = async (e: React.MouseEvent, cmd: string, type: string) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(cmd);
      setCopiedType(type);
      setShowInstallMenu(false);
      setTimeout(() => setCopiedType(null), 2000);
    } catch {
      // ignore
    }
  };

  const primaryCmd = app.wingetCommand || app.brewCommand || app.flatpakCommand;
  const userOs: Platform = (() => {
    if (typeof navigator === 'undefined') return 'windows';
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes('android')) return 'android';
    if (ua.includes('mac os')) return 'mac';
    if (ua.includes('linux')) return 'linux';
    return 'windows';
  })();
  const osCommand = userOs === 'mac' ? app.brewCommand : userOs === 'linux' ? app.flatpakCommand || app.brewCommand : app.wingetCommand;
  const shownCommand = osCommand || primaryCmd;


  return (
    <article 
      id={`app-card-${app.id}`}
      className={`group relative bg-slate-900 dark:bg-slate-800 border rounded-lg p-4 flex flex-col justify-between transition-all duration-150 shadow-sm hover:shadow-md dark:shadow-lg dark:shadow-black/40 ${
        isBatchSelected 
          ? 'border-sky-500/60 bg-sky-950/15 ring-1 ring-sky-500/40' 
          : 'border-slate-950/10 dark:border-white/[0.08] hover:border-slate-950/30 dark:hover:border-white/[0.2]'
      }`}
      aria-label={`Tool entry for ${app.name}`}
    >
      <div>
        {/* Top bar: Checkbox + Category + Status Badges + Action Buttons */}
        <div id={`app-header-bar-${app.id}`} className="flex items-center justify-between gap-2 mb-3">
          <div className="flex items-center gap-2 flex-wrap">
            {onToggleBatchSelect && (
              <input
                type="checkbox"
                id={`batch-check-${app.id}`}
                checked={isBatchSelected}
                onChange={() => onToggleBatchSelect(app.id)}
                className="w-3.5 h-3.5 rounded border-slate-950/20 dark:border-white/20 bg-slate-950/5 dark:bg-white/5 text-sky-500 focus:ring-sky-500 focus:ring-offset-0 cursor-pointer accent-sky-500"
                title="Select for batch install or export"
                aria-label={`Select ${app.name} for batch actions`}
              />
            )}

            <span id={`app-cat-badge-${app.id}`} className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              {t(categoryKey(app.category))}
            </span>

            {app.isOwnerPick && (
              <span 
                id={`app-owner-badge-${app.id}`}
                className="text-[11px] font-bold bg-amber-400/15 text-amber-300 border border-amber-400/50 px-2 py-0.5 rounded flex items-center gap-1 whitespace-nowrap shadow-xs"
                title="Our single recommendation in the whole catalog"
              >
                <Award className="w-3 h-3" aria-hidden="true" />
                <span>{t('card.badge.pick')}</span>
              </span>
            )}

            {app.isTrendingToday && (
              <span 
                id={`app-trending-badge-${app.id}`}
                className="text-[11px] font-medium text-emerald-300 flex items-center gap-1 whitespace-nowrap"
                title="Popular in open-source right now"
              >
                <Flame className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
                <span>{t('card.badge.trending')}</span>
              </span>
            )}

            {app.isCustom && (
              <span 
                id={`app-custom-badge-${app.id}`}
                className="text-[11px] font-medium bg-sky-400/10 text-sky-300 border border-sky-400/20 px-1.5 py-0.5 rounded"
                title="Locally added custom software"
              >
                {t('card.badge.custom')}
              </span>
            )}
          </div>

          <div className="flex items-center gap-1">
            {onToggleCompare && (
              <button
                type="button"
                id={`compare-toggle-btn-${app.id}`}
                onClick={() => onToggleCompare(app.id)}
                className={`p-1.5 rounded text-xs transition-colors ${
                  isCompared 
                    ? 'text-sky-400 bg-sky-400/15 border border-sky-400/30' 
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06]'
                }`}
                title={isCompared ? 'In compare matrix' : 'Add to compare matrix'}
                aria-label={`Compare ${app.name}`}
              >
                <Columns className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            )}

            {app.isCustom && onEditApp && (
              <button
                id={`edit-app-btn-${app.id}`}
                type="button"
                onClick={() => onEditApp(app)}
                className="p-1.5 rounded text-xs text-slate-400 hover:text-slate-100 hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06] transition-colors"
                title={t('card.edit')}
                aria-label={`Edit ${app.name}`}
              >
                <Edit2 className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            )}

            {app.isCustom && onDeleteApp && (
              <button
                id={`delete-app-btn-${app.id}`}
                type="button"
                onClick={() => setShowDeleteConfirm(true)}
                className="p-1.5 rounded text-xs text-slate-400 hover:text-rose-400 hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06] transition-colors"
                title={t('card.deleteTitle')}
                aria-label={`${t('card.delete')} ${app.name}`}
              >
                <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            )}

            <button
              id={`fav-toggle-btn-${app.id}`}
              type="button"
              onClick={() => onToggleFavorite(app.id)}
              className={`p-1.5 rounded text-xs transition-colors ${
                isFavorite 
                  ? 'text-rose-400 bg-rose-400/10' 
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06]'
              }`}
              aria-label={isFavorite ? `Remove ${app.name} from favorites` : `Add ${app.name} to favorites`}
              aria-pressed={isFavorite}
              title={isFavorite ? "Bookmarked" : "Add to bookmarks"}
            >
              <Bookmark className={`w-3.5 h-3.5 ${isFavorite ? 'fill-rose-400' : ''}`} aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Delete confirmation inline banner */}
        {showDeleteConfirm && (
          <div id={`delete-confirm-box-${app.id}`} className="mb-3 p-2.5 bg-rose-950/80 border border-rose-800/80 rounded-md text-xs text-rose-200 flex items-center justify-between">
            <span>{t('card.deleteConfirm')}</span>
            <div className="flex items-center gap-1.5">
              <button
                id={`confirm-delete-btn-${app.id}`}
                type="button"
                onClick={() => {
                  onDeleteApp?.(app.id);
                  setShowDeleteConfirm(false);
                }}
                className="bg-rose-600 hover:bg-rose-500 text-white px-2 py-0.5 rounded text-[11px] font-semibold"
              >
                {t('card.confirm')}
              </button>
              <button
                id={`cancel-delete-btn-${app.id}`}
                type="button"
                onClick={() => setShowDeleteConfirm(false)}
                className="bg-slate-950/[0.06] dark:bg-white/[0.08] hover:bg-slate-950/[0.1] dark:hover:bg-white/[0.12] text-slate-300 px-2 py-0.5 rounded text-[11px]"
              >
                {t('card.cancel')}
              </button>
            </div>
          </div>
        )}

        {/* App Title & Proprietary Alternative */}
        <div className="mb-2">
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              id={`app-title-${app.id}`}
              onClick={() => onOpenDetail(app)}
              className="font-bold text-left text-slate-100 text-base leading-snug tracking-tight group-hover:text-sky-400 transition-colors cursor-pointer"
              aria-label={`View details for ${app.name}`}
            >
              {app.name}
            </button>
            {app.proprietaryAlternative && (
              <span className="text-[11px] font-medium text-slate-400 bg-slate-950/[0.04] dark:bg-white/[0.04] border border-slate-950/10 dark:border-white/[0.08] px-1.5 py-0.5 rounded">
                {app.proprietaryAlternative}
              </span>
            )}
          </div>
          <p id={`app-tagline-${app.id}`} className="text-xs text-slate-400 line-clamp-1 mt-0.5">
            {app.tagline}
          </p>
        </div>

        {/* Description */}
        <p id={`app-desc-${app.id}`} className="text-[13px] text-slate-300 leading-relaxed line-clamp-2 mb-3">
          {app.description}
        </p>

        {/* Curated Highlight */}
        <div id={`app-highlight-row-${app.id}`} className="mb-3.5 ps-2.5 border-s-2 border-slate-950/[0.12] dark:border-white/[0.12]">
          <p className="text-slate-400 text-[12px] leading-relaxed line-clamp-2">
            {app.whyItsAwesome}
          </p>
        </div>

        {/* Metadata Row: Stars, License, Platforms as quiet text (badges are rationed) */}
        <div id={`app-meta-row-${app.id}`} className="flex items-center flex-wrap gap-x-3 gap-y-1 mb-4">
          <span 
            id={`app-stars-count-${app.id}`}
            className={`inline-flex items-center gap-1 font-mono text-xs text-slate-400 ${app.stars === 0 ? 'hidden' : ''}`}
            title={app.githubUrl.includes('github.com') ? `${app.stars.toLocaleString()} stars on GitHub` : `${app.stars.toLocaleString()} community stars (approximate)`}
          >
            <Star className="w-3 h-3 fill-slate-400 text-slate-400" aria-hidden="true" />
            <span>{formatStars(app.stars)}</span>
          </span>

          <span 
            id={`app-license-badge-${app.id}`}
            className="font-mono text-xs text-slate-400"
            title={`License: ${app.license}`}
          >
            {app.license}
          </span>

          {app.offlineReady && (
            <span 
              className="text-[11px] text-slate-400 inline-flex items-center gap-1"
              title="Runs 100% offline with zero cloud dependency"
            >
              <HardDrive className="w-3 h-3 text-emerald-400" aria-hidden="true" />
              <span>{t('card.offlineReady')}</span>
            </span>
          )}

          <div id={`app-platforms-list-${app.id}`} className="flex items-center gap-1.5 ms-auto flex-wrap" title="Available platforms">
            {app.platforms.map((p, i) => (
              <React.Fragment key={p}>
                {i > 0 && <span className="text-slate-500 text-[11px]" aria-hidden="true">·</span>}
                {renderPlatformBadge(p)}
              </React.Fragment>
            ))}
          </div>
        </div>
      </div>

      {/* Action Footer */}
      <div id={`app-card-footer-${app.id}`} className="pt-3 border-t border-slate-950/10 dark:border-white/[0.06] flex items-center justify-between gap-2 relative">
        <button
          id={`view-guide-btn-${app.id}`}
          type="button"
          onClick={() => onOpenDetail(app)}
          className="inline-flex items-center gap-1 text-xs font-medium text-slate-300 hover:text-slate-100 bg-slate-950/[0.04] dark:bg-white/[0.04] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.08] border border-slate-950/10 dark:border-white/[0.08] px-2.5 py-1.5 rounded-md transition-colors"
          aria-label={`View install instructions and details for ${app.name}`}
        >
          <Info className="w-3.5 h-3.5 text-sky-400" aria-hidden="true" />
          <span>{t('card.guide')}</span>
        </button>

        {/* Download button: direct targets start the in-app download manager,
            everything else opens the detail modal with the device picker. */}
        <button
          id={`download-btn-${app.id}`}
          type="button"
          disabled={resolving || isDownloading}
          onClick={() => {
            void startDownloadSmart(app, {
              startDownload,
              recordExternalOpen,
              onOpenDetail,
              onResolving: (id) => setResolving(id === app.id),
            });
          }}
          className="inline-flex items-center gap-1 text-xs font-semibold bg-emerald-500/10 hover:bg-emerald-500/20 disabled:opacity-60 disabled:cursor-wait border border-emerald-500/30 text-emerald-300 px-2.5 py-1.5 rounded-md transition-colors"
          title={isDownloading ? 'Downloading...' : resolving ? 'Finding the latest stable download...' : 'Download this app'}
          aria-label={`Download ${app.name}`}
        >
          <Download className={`w-3.5 h-3.5 ${isDownloading || resolving ? 'animate-pulse' : ''}`} aria-hidden="true" />
          <span>{isDownloading || resolving ? t('card.download') + '...' : t('card.download')}</span>
        </button>

        {/* Quick Install Command Dropdown */}
        <div className="flex items-center gap-1.5">
          {primaryCmd && (
            <div className="relative">
              <button
                type="button"
                id={`quick-install-btn-${app.id}`}
                onClick={(e) => {
                  const cmd = shownCommand;
                  if (cmd) {
                    handleCopyCmd(e, cmd, 'cmd');
                    toast.success(t('card.cmdCopied'), { description: t('card.cmdCopiedBody') });
                  }
                }}
                className="inline-flex items-center gap-1 text-xs font-mono bg-sky-500/10 hover:bg-sky-500/20 border border-sky-500/30 text-sky-300 px-2.5 py-1.5 rounded-md transition-colors"
                title="Copy the package-manager install command (for terminals; beginners can use the Download button instead)"
              >
                {copiedType === 'cmd' ? (
                  <>
                    <Check className="w-3 h-3 text-emerald-400" />
                    <span className="text-emerald-400">{t('card.copied')}</span>
                  </>
                ) : (
                  <>
                    <Terminal className="w-3 h-3 text-sky-400" />
                    <span>{(() => { const cmd = shownCommand || ''; return cmd.startsWith('winget') ? 'winget' : cmd.startsWith('brew') ? 'brew' : cmd.startsWith('flatpak') ? 'flatpak' : cmd.startsWith('scoop') ? 'scoop' : 'install'; })()}</span>
                  </>
                )}
              </button>

              {/* OS-choice dropdown trigger (only when alternatives exist) */}
              {(app.brewCommand || app.flatpakCommand || app.scoopCommand) && (
                <button
                  type="button"
                  id={`install-menu-btn-${app.id}`}
                  onClick={() => setShowInstallMenu(!showInstallMenu)}
                  className="p-1.5 text-sky-300 hover:bg-sky-500/20 border border-sky-500/30 rounded-md transition-colors"
                  title={t("card.otherManagers")}
                  aria-label={t("card.otherManagers")}
                  aria-expanded={showInstallMenu}
                >
                  <ChevronDown className="w-3 h-3" />
                </button>
              )}

              {/* Dropdown Options */}
              {showInstallMenu && (
                <div 
                  className="absolute end-0 bottom-full mb-1 w-48 bg-slate-950 border border-slate-950/[0.14] dark:border-white/[0.14] rounded-lg shadow-xl p-1 z-30 text-xs"
                  onClick={(e) => e.stopPropagation()}
                >
                  {app.wingetCommand && (
                    <button
                      type="button"
                      onClick={(e) => handleCopyCmd(e, app.wingetCommand!, 'winget')}
                      className="w-full text-left px-2.5 py-1.5 rounded hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.08] text-slate-200 flex items-center justify-between"
                    >
                      <span className="font-mono text-[11px]">winget (Win)</span>
                      <Copy className="w-3 h-3 text-slate-400" />
                    </button>
                  )}
                  {app.brewCommand && (
                    <button
                      type="button"
                      onClick={(e) => handleCopyCmd(e, app.brewCommand!, 'brew')}
                      className="w-full text-left px-2.5 py-1.5 rounded hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.08] text-slate-200 flex items-center justify-between"
                    >
                      <span className="font-mono text-[11px]">brew (Mac/Lin)</span>
                      <Copy className="w-3 h-3 text-slate-400" />
                    </button>
                  )}
                  {app.flatpakCommand && (
                    <button
                      type="button"
                      onClick={(e) => handleCopyCmd(e, app.flatpakCommand!, 'flatpak')}
                      className="w-full text-left px-2.5 py-1.5 rounded hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.08] text-slate-200 flex items-center justify-between"
                    >
                      <span className="font-mono text-[11px]">flatpak (Linux)</span>
                      <Copy className="w-3 h-3 text-slate-400" />
                    </button>
                  )}
                  {app.scoopCommand && (
                    <button
                      type="button"
                      onClick={(e) => handleCopyCmd(e, app.scoopCommand!, 'scoop')}
                      className="w-full text-left px-2.5 py-1.5 rounded hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.08] text-slate-200 flex items-center justify-between"
                    >
                      <span className="font-mono text-[11px]">scoop (Win)</span>
                      <Copy className="w-3 h-3 text-slate-400" />
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {app.githubUrl && (
            <a
              id={`github-link-${app.id}`}
              href={app.githubUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => { e.preventDefault(); void openExternal(app.githubUrl); }}
              className="p-1.5 text-slate-400 hover:text-slate-100 hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06] border border-transparent hover:border-slate-950/20 dark:hover:border-white/[0.08] rounded-md transition-colors"
              aria-label={`View ${app.name} source code (opens in new window)`}
              title="Source code"
            >
              <Github className="w-3.5 h-3.5" aria-hidden="true" />
            </a>
          )}

          {app.websiteUrl && (
            <a
              id={`website-link-${app.id}`}
              href={app.websiteUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => { e.preventDefault(); void openExternal(app.websiteUrl); }}
              className="inline-flex items-center gap-1 text-xs text-slate-300 hover:text-slate-100 bg-slate-950/[0.04] dark:bg-white/[0.04] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.08] border border-slate-950/10 dark:border-white/[0.08] px-2 py-1 rounded-md transition-colors"
              aria-label={`Visit official website for ${app.name} (opens in new window)`}
            >
              <span>{t('table.site')}</span>
              <ExternalLink className="w-3 h-3" aria-hidden="true" />
            </a>
          )}
        </div>
      </div>
    </article>
  );
};

// Memoized: with the selector-based download hooks above, a progress tick
// re-renders only the card whose app is actually downloading.
export const AppCard = React.memo(AppCardBase);
