import React, { useState } from 'react';
import { AppItem, Platform } from '../types';
import {
  Star,
  Github,
  Gitlab,
  Code2,
  Bookmark,
  Info,
  Edit2,
  Trash2,
  Award,
  Flame,
  Columns,
  HardDrive,
  Download
} from 'lucide-react';
import { bestDownloadFor } from '../lib/appDownloads';
import { useDownloads } from '../lib/downloads';
import { openExternal } from '../lib/external';
import { resolveGitHubDownload, resolveFdroidDownload, guessUserPlatform } from '../lib/releaseFetch';
import { sourceLinksFor } from '../lib/sourceLinks';
import { toast } from 'sonner';
import { useI18n } from '../lib/i18n';
import { useAppText } from '../lib/appText';
import { useLiveStars, formatStarCount } from '../lib/starFetch';


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

export const AppCard: React.FC<AppCardProps> = ({
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
  const { startDownload, recordExternalOpen, items: downloadItems } = useDownloads();
  const { t } = useI18n();
  const tx = useAppText(app);
  const isDownloading = downloadItems.some((d) => d.name.startsWith(app.name) && d.status === 'active');
  const [resolving, setResolving] = useState(false);
  // Live value from GitHub/GitLab when reachable; falls back to the stored number.
  const liveStars = useLiveStars(app.githubUrl);
  const shownStars = liveStars ?? app.stars;

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
              {app.category}
            </span>

            {app.isOwnerPick && (
              <span 
                id={`app-owner-badge-${app.id}`}
                className="text-[11px] font-bold bg-amber-400 text-slate-950 border border-amber-400 px-2 py-0.5 rounded flex items-center gap-1 whitespace-nowrap shadow-xs"
                title="Our single recommendation in the whole catalog"
              >
                <Award className="w-3 h-3" aria-hidden="true" />
                <span>{t('card.badge.pick')}</span>
              </span>
            )}

            {app.isTrendingToday && (
              <span 
                id={`app-trending-badge-${app.id}`}
                className="text-[11px] font-medium text-emerald-800 dark:text-emerald-300 flex items-center gap-1 whitespace-nowrap"
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
                    ? 'text-sky-800 bg-sky-800/[0.08] border border-sky-800/25 dark:text-sky-400 dark:bg-sky-400/15 dark:border-sky-400/30' 
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
                title="Edit this application details"
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
                title="Delete this custom tool"
                aria-label={`Delete ${app.name}`}
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
                  ? 'text-rose-700 bg-rose-800/[0.08] dark:text-rose-400 dark:bg-rose-400/10' 
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06]'
              }`}
              aria-label={isFavorite ? `Remove ${app.name} from favorites` : `Add ${app.name} to favorites`}
              aria-pressed={isFavorite}
              title={isFavorite ? "Bookmarked" : "Add to bookmarks"}
            >
              <Bookmark className={`w-3.5 h-3.5 ${isFavorite ? 'fill-rose-700 dark:fill-rose-400' : ''}`} aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Delete confirmation inline banner */}
        {showDeleteConfirm && (
          <div id={`delete-confirm-box-${app.id}`} className="mb-3 p-2.5 bg-rose-950/80 border border-rose-800/80 rounded-md text-xs text-rose-200 flex items-center justify-between">
            <span>Remove tool from library?</span>
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
                Confirm
              </button>
              <button
                id={`cancel-delete-btn-${app.id}`}
                type="button"
                onClick={() => setShowDeleteConfirm(false)}
                className="bg-slate-950/[0.06] dark:bg-white/[0.08] hover:bg-slate-950/[0.1] dark:hover:bg-white/[0.12] text-slate-300 px-2 py-0.5 rounded text-[11px]"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* App title + one-line tagline. The full story, install commands
            and links live in the guide popup so cards stay calm. */}
        <div className="mb-3">
          <h3 
            id={`app-title-${app.id}`} 
            onClick={() => onOpenDetail(app)}
            className="font-bold text-slate-100 text-base leading-snug tracking-tight group-hover:text-sky-400 transition-colors cursor-pointer"
          >
            {app.name}
          </h3>
          <p id={`app-tagline-${app.id}`} className="text-xs text-slate-400 line-clamp-1 mt-0.5">
            {tx.tagline}
          </p>
        </div>

        {/* Metadata Row: Stars, License, Platforms as quiet text (badges are rationed) */}
        <div id={`app-meta-row-${app.id}`} className="flex items-center flex-wrap gap-x-3 gap-y-1 mb-4">
          <span 
            id={`app-stars-count-${app.id}`}
            className={`inline-flex items-center gap-1 font-mono text-xs text-slate-400 ${shownStars === 0 ? 'hidden' : ''}`}
            title={app.githubUrl.includes('github.com') ? `${shownStars.toLocaleString()} stars on GitHub, fetched live` : `${shownStars.toLocaleString()} stars on the project's own code forge`}
          >
            <Star className="w-3 h-3 fill-slate-400 text-slate-400" aria-hidden="true" />
            <span>{formatStarCount(shownStars)}</span>
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

          <div id={`app-platforms-list-${app.id}`} className="flex items-center gap-1.5 ml-auto flex-wrap" title="Available platforms">
            {app.platforms.map((p, i) => (
              <React.Fragment key={p}>
                {i > 0 && <span className="text-slate-500 text-[11px]" aria-hidden="true">·</span>}
                {renderPlatformBadge(p)}
              </React.Fragment>
            ))}
          </div>
        </div>
      </div>

      {/* Action Footer: Guide left; Download + GitHub right. One row, no clutter —
          install commands and the official site live in the detail modal. */}
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

        {/* Quick Install Command Dropdown */}
        <div className="flex items-center gap-1.5">
          {/* Download button: direct targets start the in-app download manager,
              everything else opens the detail modal with the device picker. */}
          <button
            id={`download-btn-${app.id}`}
            type="button"
            onClick={() => {
              const platform = guessUserPlatform(app);
              void (async () => {
                setResolving(true);
                try {
                  // 1) Live-resolve the latest STABLE file for this platform from GitHub Releases
                  const resolved = await resolveGitHubDownload(app, platform);
                  if (resolved) {
                    void startDownload(resolved.url, resolved.filename);
                    return;
                  }
                  // 2) Android: try the app's F-Droid package next
                  if (platform === 'android' && app.fdroidId) {
                    const fd = await resolveFdroidDownload(app.fdroidId);
                    if (fd) {
                      void startDownload(fd.url, fd.filename);
                      return;
                    }
                  }
                  // 3) Curated targets: direct links stream in the app
                  const target = bestDownloadFor(app, platform);
                  if (!target) {
                    onOpenDetail(app);
                    return;
                  }
                  if (target.kind === 'direct') {
                    void startDownload(target.url, `${app.name} ${target.label}`.trim());
                  } else if (target.kind === 'store' || !/github\.com\/[^/]+\/[^/]+\/releases/i.test(target.url)) {
                    // Official vendor download pages are beginner-friendly; open them
                    recordExternalOpen(`${app.name}: ${target.label}`, target.url);
                    toast.info(`Opening the official download page for ${app.name}`, {
                      description: target.label,
                    });
                    void openExternal(target.url);
                  } else {
                    // A raw GitHub releases page is not beginner-friendly: open the in-app guide
                    onOpenDetail(app);
                  }
                } finally {
                  setResolving(false);
                }
              })();
            }}
            className="inline-flex items-center gap-1 text-xs font-semibold bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-emerald-300 px-2.5 py-1.5 rounded-md transition-colors"
            title={isDownloading ? 'Downloading...' : resolving ? 'Finding the latest stable download...' : 'Download this app'}
            aria-label={`Download ${app.name}`}
          >
            <Download className={`w-3.5 h-3.5 ${isDownloading || resolving ? 'animate-pulse' : ''}`} aria-hidden="true" />
            <span>{isDownloading || resolving ? t('card.download') + '...' : t('card.download')}</span>
          </button>

          {sourceLinksFor(app).map((link, i) => {
            const Icon = link.kind === 'github' ? Github : link.kind === 'gitlab' ? Gitlab : Code2;
            return (
              <a
                key={link.url}
                id={link.kind === 'gitlab' ? `gitlab-link-${app.id}` : i === 0 ? `github-link-${app.id}` : `source-link-${app.id}-${i}`}
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => { e.preventDefault(); void openExternal(link.url); }}
                className="p-1.5 text-slate-400 hover:text-slate-100 hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06] border border-transparent hover:border-slate-950/20 dark:hover:border-white/[0.08] rounded-md transition-colors"
                aria-label={`View ${app.name} source code on ${link.label} (opens in new window)`}
                title={`${link.label} source code`}
              >
                <Icon className="w-3.5 h-3.5" aria-hidden="true" />
              </a>
            );
          })}

        </div>
      </div>
    </article>
  );
};
