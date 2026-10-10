// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import React, { useCallback, useEffect, useRef, useState } from 'react';
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
import { useDownloadActions, useAppDownloadStatus } from '../lib/downloads';
import { openExternal } from '../lib/external';
import { resolveDownloadFor, guessUserPlatform } from '../lib/releaseFetch';
import { sourceLinksFor } from '../lib/sourceLinks';
import { toast } from 'sonner';
import { useI18n } from '../lib/i18n';
import { useAppText } from '../lib/appText';
import { useLiveStars, formatStarCount } from '../lib/starFetch';
import { iconFor } from '../data/appIcons';

/**
 * Official project icon next to the app name, with a designed letter tile
 * as the fallback for custom entries, broken artwork and anything without
 * shipped icons - never an empty gap where an icon should be.
 */
export const AppIcon: React.FC<{ appId: string; name: string; size?: number }> = ({ appId, name, size = 28 }) => {
  const [failed, setFailed] = useState(false);
  const src = failed ? null : iconFor({ id: appId });
  if (!src) {
    return (
      <span
        aria-hidden="true"
        className="inline-flex items-center justify-center rounded-md bg-gradient-to-br from-slate-700 to-slate-900 text-slate-100 font-bold select-none shrink-0 ring-1 ring-white/10"
        style={{ width: size, height: size, fontSize: size * 0.5 }}
      >
        {name.charAt(0).toUpperCase() || '?'}
      </span>
    );
  }
  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      loading="lazy"
      className="rounded-md shrink-0 object-contain"
      onError={() => setFailed(true)}
    />
  );
};

/** Reserved height of the description block (two clamped lines at 13px/1.5).
 * Cards with a one-line tagline reserve the same space, so metadata rows
 * and footer actions of adjacent cards stay aligned in the grid. */
const TAGLINE_BLOCK_MIN_H = 39;

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

const AppCardImpl: React.FC<AppCardProps> = ({
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
  const cancelDeleteRef = useRef<HTMLButtonElement>(null);
  // Focused actions only: the card must not subscribe to the live item
  // list. Its download state comes from the active-set subscription below,
  // which is blind to byte-count/ETA updates.
  const { startDownload, recordExternalOpen } = useDownloadActions();
  const isDownloading = useAppDownloadStatus(app.id, app.name);
  const { t } = useI18n();
  const tx = useAppText(app);
  const [resolving, setResolving] = useState(false);
  // Live value from GitHub/GitLab when reachable; falls back to the stored number.
  const liveStars = useLiveStars(app.githubUrl);
  const shownStars = liveStars ?? app.stars;

  // Safe-default focus for the removal confirmation: the focus lands on
  // Cancel, never on the destructive button, and Escape dismisses.
  useEffect(() => {
    if (showDeleteConfirm) cancelDeleteRef.current?.focus();
  }, [showDeleteConfirm]);
  const onDeleteConfirmKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      setShowDeleteConfirm(false);
    }
  }, []);

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

  const handleDownload = () => {
    const platform = guessUserPlatform(app);
    void (async () => {
      setResolving(true);
      try {
        // Confidence order lives in resolveDownloadFor: confident
        // GitHub pick, then the F-Droid package, then a weak pick.
        const resolved = await resolveDownloadFor(app, platform);
        if (resolved) {
          void startDownload(resolved.url, resolved.filename, {
            expectedSha256: resolved.expectedSha256,
            expectedSha512: resolved.expectedSha512,
          });
          return;
        }
        // 3) Curated targets: direct links stream in the app
        const target = bestDownloadFor(app, platform);
        if (!target) {
          toast.info(`Showing the download options for ${app.name}`);
          onOpenDetail(app);
          return;
        }
        if (target.kind === 'direct') {
          void startDownload(target.url, `${app.name} ${target.label}`.trim());
        } else {
          // Every other target IS the download page: open it in the
          // browser and say so. Popping the in-app guide here (the
          // old behavior) read as "the download button opens a help
          // window instead of downloading".
          recordExternalOpen(`${app.name}: ${target.label}`, target.url);
          toast.info(`Opening the official download page for ${app.name}`, {
            description: `${target.label} opens in your browser.`,
          });
          void openExternal(target.url);
        }
      } catch {
        // No click may end in silence: worst case, show the in-app guide.
        toast.info(`Showing the download options for ${app.name}`);
        onOpenDetail(app);
      } finally {
        setResolving(false);
      }
    })();
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
        {/* ---- Top: icon, name, and at most the two curation badges ---- */}
        <div id={`app-header-bar-${app.id}`} className="flex items-start justify-between gap-2 mb-1">
          <div className="flex items-start gap-2.5 min-w-0">
            {onToggleBatchSelect && (
              <input
                type="checkbox"
                id={`batch-check-${app.id}`}
                checked={isBatchSelected}
                onChange={() => onToggleBatchSelect(app.id)}
                className="mt-3 w-3.5 h-3.5 rounded border-slate-950/20 dark:border-white/20 bg-slate-950/5 dark:bg-white/5 text-sky-500 focus:ring-sky-500 focus:ring-offset-0 cursor-pointer accent-sky-500"
                title="Select for batch install or export"
                aria-label={`Select ${app.name} for batch actions`}
              />
            )}

            <AppIcon appId={app.id} name={app.name} size={38} />

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 flex-wrap">
                <h3
                  id={`app-title-${app.id}`}
                  onClick={() => onOpenDetail(app)}
                  className="font-bold text-slate-100 text-base leading-snug tracking-tight group-hover:text-sky-400 transition-colors cursor-pointer line-clamp-2 break-words"
                >
                  {app.name}
                </h3>
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
              </div>

              {/* Quiet category label: metadata, not a badge. */}
              <span
                id={`app-cat-badge-${app.id}`}
                className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500 truncate mt-0.5"
              >
                {app.category}
              </span>
            </div>
          </div>

          {/* Secondary operations: visually quiet icon buttons, always
              reachable (keyboard focusable, labeled). */}
          <div className="flex items-center gap-0.5 shrink-0">
            {onToggleCompare && (
              <button
                type="button"
                id={`compare-toggle-btn-${app.id}`}
                onClick={() => onToggleCompare(app.id)}
                className={`p-1.5 rounded text-xs transition-colors ${
                  isCompared
                    ? 'text-sky-800 bg-sky-800/[0.08] border border-sky-800/25 dark:text-sky-400 dark:bg-sky-400/15 dark:border-sky-400/30'
                    : 'text-slate-500 hover:text-slate-200 hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06]'
                }`}
                title={isCompared ? 'In compare matrix' : 'Add to compare matrix'}
                aria-label={isCompared ? `Remove ${app.name} from the comparison matrix` : `Add ${app.name} to the comparison matrix`}
                aria-pressed={isCompared}
              >
                <Columns className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            )}

            {app.isCustom && onEditApp && (
              <button
                id={`edit-app-btn-${app.id}`}
                type="button"
                onClick={() => onEditApp(app)}
                className="p-1.5 rounded text-xs text-slate-500 hover:text-slate-100 hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06] transition-colors"
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
                className="p-1.5 rounded text-xs text-slate-500 hover:text-rose-400 hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06] transition-colors"
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
                  : 'text-slate-500 hover:text-slate-200 hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06]'
              }`}
              aria-label={isFavorite ? `Remove ${app.name} from favorites` : `Add ${app.name} to favorites`}
              aria-pressed={isFavorite}
              title={isFavorite ? "Bookmarked" : "Add to bookmarks"}
            >
              <Bookmark className={`w-3.5 h-3.5 ${isFavorite ? 'fill-rose-700 dark:fill-rose-400' : ''}`} aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Removal confirmation: names the exact entry, translated, keyboard
            operable (focus starts on the safe Cancel, Escape dismisses). */}
        {showDeleteConfirm && (
          <div
            id={`delete-confirm-box-${app.id}`}
            role="alert"
            onKeyDown={onDeleteConfirmKeyDown}
            className="mb-3 p-3 bg-rose-950/80 border border-rose-700/70 rounded-md text-xs text-rose-100"
          >
            <p className="font-semibold leading-snug mb-2.5 break-words">
              {t('card.deleteConfirm').replace('{name}', app.name)}
            </p>
            <div className="flex items-center gap-2">
              <button
                id={`confirm-delete-btn-${app.id}`}
                type="button"
                onClick={() => {
                  onDeleteApp?.(app.id);
                  setShowDeleteConfirm(false);
                }}
                className="bg-rose-600 hover:bg-rose-500 text-white px-3 py-1.5 rounded text-xs font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-300"
              >
                {t('card.deleteConfirmAction')}
              </button>
              <button
                id={`cancel-delete-btn-${app.id}`}
                ref={cancelDeleteRef}
                type="button"
                onClick={() => setShowDeleteConfirm(false)}
                className="bg-slate-950/[0.06] dark:bg-white/[0.08] hover:bg-slate-950/[0.1] dark:hover:bg-white/[0.12] text-slate-200 px-3 py-1.5 rounded text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-300"
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        )}

        {/* ---- Middle: short description, then the metadata row ---- */}
        <div className="mb-2" style={{ minHeight: TAGLINE_BLOCK_MIN_H }}>
          <p id={`app-tagline-${app.id}`} className="text-[13px] text-slate-400 leading-normal line-clamp-2 break-words">
            {tx.tagline}
          </p>
        </div>

        {/* The long description and highlight text live in the Guide popup now,
            so the catalog stays scannable instead of wall-of-text. */}

        {/* Metadata Row: stars, license, proprietary alternative, offline -
            same order on every card; platforms right-aligned. Badges are
            rationed, so these stay quiet text. */}
        <div id={`app-meta-row-${app.id}`} className="flex items-center flex-wrap gap-x-3 gap-y-1 mb-2">
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
            className="font-mono text-xs text-slate-400 max-w-[14ch] truncate"
            title={`License: ${app.license}`}
          >
            {app.license}
          </span>

          {app.proprietaryAlternative && (
            <span
              className="text-[11px] font-medium text-slate-400 bg-slate-950/[0.04] dark:bg-white/[0.04] border border-slate-950/10 dark:border-white/[0.08] px-1.5 py-0.5 rounded max-w-[20ch] truncate"
              title={`Replaces: ${app.proprietaryAlternative}`}
            >
              {app.proprietaryAlternative}
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

      {/* ---- Bottom: one dominant action + one quiet action ----
          Download fills the row and is the only solid button on the card;
          Details, source links and the quiet top icons are tertiary.
          mt-auto pins the footer to the card bottom so grid rows keep
          their actions aligned. */}
      <div id={`app-card-footer-${app.id}`} className="mt-auto pt-3 border-t border-slate-950/10 dark:border-white/[0.06] flex items-center gap-1.5 relative">
        <button
          id={`download-btn-${app.id}`}
          type="button"
          onClick={handleDownload}
          className="flex-1 min-w-0 inline-flex items-center justify-center gap-1.5 text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-2 rounded-md transition-colors shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300"
          title={isDownloading ? 'Downloading...' : resolving ? 'Finding the latest stable download...' : 'Download this app'}
          aria-label={`Download ${app.name}`}
          aria-live="polite"
        >
          <Download className={`w-3.5 h-3.5 shrink-0 ${isDownloading || resolving ? 'animate-pulse' : ''}`} aria-hidden="true" />
          <span className="truncate">{isDownloading || resolving ? t('card.download') + '...' : t('card.download')}</span>
        </button>

        <button
          id={`view-guide-btn-${app.id}`}
          type="button"
          onClick={() => onOpenDetail(app)}
          className="inline-flex items-center gap-1 shrink-0 text-xs font-medium text-slate-300 hover:text-slate-100 bg-slate-950/[0.04] dark:bg-white/[0.04] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.08] border border-slate-950/10 dark:border-white/[0.08] px-2.5 py-2 rounded-md transition-colors"
          aria-label={`View install instructions and details for ${app.name}`}
        >
          <Info className="w-3.5 h-3.5 text-sky-400" aria-hidden="true" />
          <span>{t('card.details')}</span>
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
              className="p-1.5 shrink-0 text-slate-500 hover:text-slate-100 hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06] border border-transparent hover:border-slate-950/20 dark:hover:border-white/[0.08] rounded-md transition-colors"
              aria-label={`View ${app.name} source code on ${link.label} (opens in new window)`}
              title={`${link.label} source code`}
            >
              <Icon className="w-3.5 h-3.5" aria-hidden="true" />
            </a>
          );
        })}
      </div>
    </article>
  );
};

/**
 * Memoized: every card-facing prop from the composition layer is either a
 * primitive (booleans, stable app object references) or a stable callback,
 * so an AppShell rerender - including one triggered by a download starting
 * or finishing - skips cards whose inputs did not change.
 */
export const AppCard = React.memo(AppCardImpl);
