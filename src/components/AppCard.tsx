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
import { bestDownloadFor, PLATFORM_LABELS } from '../lib/appDownloads';
import { useDownloads } from '../lib/downloads';
import { toast } from 'sonner';


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
  const [copiedType, setCopiedType] = useState<string | null>(null);
  const [showInstallMenu, setShowInstallMenu] = useState(false);
  const { startDownload, items: downloadItems } = useDownloads();
  const isDownloading = downloadItems.some((d) => d.name.startsWith(app.name) && d.status === 'active');

  const formatStars = (stars: number) => {
    if (stars >= 1000) {
      return `${(stars / 1000).toFixed(stars >= 10000 ? 0 : 1)}k`;
    }
    return stars.toString();
  };

  const renderPlatformBadge = (platform: Platform) => {
    const isAndroid = platform === 'android';
    const label = 
      platform === 'windows' ? 'Win' : 
      platform === 'mac' ? 'Mac' : 
      platform === 'linux' ? 'Lin' : 
      platform === 'android' ? 'And' :
      platform === 'web' ? 'Web' : 'iOS';

    return (
      <span 
        key={platform} 
        id={`platform-${platform}-${app.id}`}
        className={`text-[10px] font-mono px-1.5 py-0.2 rounded border ${
          isAndroid
            ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300 font-semibold'
            : 'bg-slate-950/[0.04] dark:bg-white/[0.04] border-slate-950/10 dark:border-white/[0.08] text-slate-300'
        }`}
        title={`${platform} supported`}
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

  return (
    <article 
      id={`app-card-${app.id}`}
      className={`group relative bg-slate-900 border rounded-lg p-4 flex flex-col justify-between transition-all duration-150 shadow-xs hover:shadow-md ${
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

            <span id={`app-cat-badge-${app.id}`} className="text-[11px] font-medium text-slate-300 bg-slate-950/[0.05] dark:bg-white/[0.05] border border-slate-950/10 dark:border-white/[0.08] px-2 py-0.5 rounded">
              {app.category}
            </span>

            {app.isOwnerPick && (
              <span 
                id={`app-owner-badge-${app.id}`}
                className="text-[10px] font-medium bg-amber-400/10 text-amber-300 border border-amber-400/20 px-1.5 py-0.5 rounded flex items-center gap-1 whitespace-nowrap"
                title="Recommended tool"
              >
                <Award className="w-3 h-3 text-amber-400" aria-hidden="true" />
                <span>Pick</span>
              </span>
            )}

            {app.isTrendingToday && (
              <span 
                id={`app-trending-badge-${app.id}`}
                className="text-[10px] font-medium bg-emerald-400/10 text-emerald-300 border border-emerald-400/20 px-1.5 py-0.5 rounded flex items-center gap-1 whitespace-nowrap"
                title="Popular in open-source"
              >
                <Flame className="w-3 h-3 text-emerald-400" aria-hidden="true" />
                <span>Trending</span>
              </span>
            )}

            {app.isCustom && (
              <span 
                id={`app-custom-badge-${app.id}`}
                className="text-[10px] font-medium bg-sky-400/10 text-sky-300 border border-sky-400/20 px-1.5 py-0.5 rounded"
                title="Locally added custom software"
              >
                Custom
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
                  ? 'text-rose-400 bg-rose-400/10' 
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06]'
              }`}
              aria-label={isFavorite ? `Remove ${app.name} from favorites` : `Add ${app.name} to favorites`}
              title={isFavorite ? "Bookmarked" : "Add to bookmarks"}
            >
              <Bookmark className={`w-3.5 h-3.5 ${isFavorite ? 'fill-rose-400' : ''}`} aria-hidden="true" />
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

        {/* App Title & Proprietary Alternative */}
        <div className="mb-2">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 
              id={`app-title-${app.id}`} 
              onClick={() => onOpenDetail(app)}
              className="font-semibold text-slate-100 text-[15px] leading-snug tracking-tight group-hover:text-sky-400 transition-colors cursor-pointer"
            >
              {app.name}
            </h3>
            {app.proprietaryAlternative && (
              <span className="text-[10px] font-mono text-amber-300/90 bg-amber-400/10 border border-amber-400/20 px-1.5 py-0.2 rounded">
                vs {app.proprietaryAlternative}
              </span>
            )}
          </div>
          <p id={`app-tagline-${app.id}`} className="text-xs text-slate-400 line-clamp-1 mt-0.5">
            {app.tagline}
          </p>
        </div>

        {/* Description */}
        <p id={`app-desc-${app.id}`} className="text-xs text-slate-300 leading-relaxed line-clamp-2 mb-3">
          {app.description}
        </p>

        {/* Curated Highlight */}
        <div id={`app-highlight-row-${app.id}`} className="mb-3.5 pl-2.5 border-l-2 border-slate-950/[0.12] dark:border-white/[0.12] text-xs">
          <p className="text-slate-400 text-[11px] leading-relaxed line-clamp-2">
            {app.whyItsAwesome}
          </p>
        </div>

        {/* Metadata Row: Stars, License, Offline, Platforms */}
        <div id={`app-meta-row-${app.id}`} className="flex items-center flex-wrap gap-2 text-xs mb-4">
          <span 
            id={`app-stars-count-${app.id}`}
            className="inline-flex items-center gap-1 font-mono text-[11px] bg-slate-950/[0.04] dark:bg-white/[0.03] border border-slate-950/10 dark:border-white/[0.08] px-2 py-0.5 rounded text-amber-300"
            title={`${app.stars.toLocaleString()} GitHub stars`}
          >
            <Star className="w-3 h-3 fill-amber-400 text-amber-400" aria-hidden="true" />
            <span>{formatStars(app.stars)}</span>
          </span>

          <span 
            id={`app-license-badge-${app.id}`}
            className="font-mono text-[11px] bg-slate-950/[0.04] dark:bg-white/[0.03] border border-slate-950/10 dark:border-white/[0.08] px-2 py-0.5 rounded text-slate-400"
            title={`License: ${app.license}`}
          >
            {app.license}
          </span>

          {app.offlineReady && (
            <span 
              className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-400/10 text-emerald-300 border border-emerald-400/20"
              title="Runs 100% offline with zero cloud dependency"
            >
              Offline Ready
            </span>
          )}

          <div id={`app-platforms-list-${app.id}`} className="flex items-center gap-1 ml-auto">
            {app.platforms.map((p) => renderPlatformBadge(p))}
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
          <span>Guide</span>
        </button>

        {/* Download button: direct targets start the in-app download manager,
            everything else opens the detail modal with the device picker. */}
        <button
          id={`download-btn-${app.id}`}
          type="button"
          onClick={() => {
            const target = bestDownloadFor(app, (navigator.platform || '').toLowerCase().includes('win') ? 'windows' : app.platforms[0]);
            if (!target) {
              onOpenDetail(app);
              return;
            }
            if (target.kind === 'direct') {
              void startDownload(target.url, `${app.name} ${target.label}`.trim());
            } else if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
              // In the desktop app, page links open the system browser
              import('@tauri-apps/plugin-opener').then(({ openUrl }) => openUrl(target.url)).catch(() => window.open(target.url, '_blank'));
            } else {
              window.open(target.url, '_blank', 'noopener,noreferrer');
              toast.info(`Opening the official download page for ${app.name}`, {
                description: target.label,
              });
            }
          }}
          className="inline-flex items-center gap-1 text-[11px] font-semibold bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-emerald-300 px-2 py-1 rounded transition-colors"
          title={isDownloading ? 'Downloading...' : 'Download this app'}
          aria-label={`Download ${app.name}`}
        >
          <Download className={`w-3 h-3 ${isDownloading ? 'animate-pulse' : ''}`} aria-hidden="true" />
          <span>{isDownloading ? 'Downloading' : 'Download'}</span>
        </button>

        {/* Quick Install Command Dropdown */}
        <div className="flex items-center gap-1.5">
          {primaryCmd && (
            <div className="relative">
              <button
                type="button"
                id={`quick-install-btn-${app.id}`}
                onClick={(e) => {
                  if (app.wingetCommand && !app.brewCommand && !app.flatpakCommand) {
                    handleCopyCmd(e, app.wingetCommand, 'winget');
                  } else {
                    setShowInstallMenu(!showInstallMenu);
                  }
                }}
                className="inline-flex items-center gap-1 text-[11px] font-mono bg-sky-500/10 hover:bg-sky-500/20 border border-sky-500/30 text-sky-300 px-2 py-1 rounded transition-colors"
                title="Quick install command"
              >
                {copiedType ? (
                  <>
                    <Check className="w-3 h-3 text-emerald-400" />
                    <span className="text-emerald-400">Copied!</span>
                  </>
                ) : (
                  <>
                    <Terminal className="w-3 h-3 text-sky-400" />
                    <span>Install</span>
                    {(app.brewCommand || app.flatpakCommand) && (
                      <ChevronDown className="w-2.5 h-2.5 ml-0.5" />
                    )}
                  </>
                )}
              </button>

              {/* Dropdown Options */}
              {showInstallMenu && (
                <div 
                  className="absolute right-0 bottom-full mb-1 w-48 bg-slate-950 border border-slate-950/[0.14] dark:border-white/[0.14] rounded-lg shadow-xl p-1 z-30 text-xs"
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
              className="p-1.5 text-slate-400 hover:text-slate-100 hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06] border border-transparent hover:border-slate-950/20 dark:hover:border-white/[0.08] rounded-md transition-colors"
              aria-label={`View ${app.name} GitHub repository (opens in new window)`}
              title="GitHub repository"
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
              className="inline-flex items-center gap-1 text-xs text-slate-300 hover:text-slate-100 bg-slate-950/[0.04] dark:bg-white/[0.04] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.08] border border-slate-950/10 dark:border-white/[0.08] px-2 py-1 rounded-md transition-colors"
              aria-label={`Visit official website for ${app.name} (opens in new window)`}
            >
              <span>Site</span>
              <ExternalLink className="w-3 h-3" aria-hidden="true" />
            </a>
          )}
        </div>
      </div>
    </article>
  );
};
