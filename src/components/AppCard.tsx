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
import { useI18n, CATEGORY_I18N_KEYS, translateLicenseDisplay } from '../lib/i18n';
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
    // The shared localized platform label (same mapping the table, detail
    // modal and filters use): the card used to be the one surface showing
    // raw English literals in every locale.
    const label = t(`common.platform.${platform}`);

    return (
      <span
        key={platform}
        id={`platform-${platform}-${app.id}`}
        className="text-[11px] text-slate-400"
        title={t('card.platform.supported').replace('{platform}', label)}
      >
        {label}
      </span>
    );
  };

  const handleDownload = () => {
    // Re-entry guard: every click while a resolve/download is already in
    // flight used to start ANOTHER resolver run (and could enqueue a second
    // transfer of the same file). The pending state already communicates
    // itself - the button text and icon pulse - so repeat clicks are
    // silently ignored, exactly like the provider-level guards.
    if (resolving || isDownloading) return;
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
          toast.info(t('card.toast.options').replace('{name}', app.name));
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
          toast.info(t('card.toast.officialPage').replace('{name}', app.name), {
            description: t('card.toast.inBrowser').replace('{label}', target.label),
          });
          void openExternal(target.url);
        }
      } catch {
        // No click may end in silence: worst case, show the in-app guide.
        toast.info(t('card.toast.options').replace('{name}', app.name));
        onOpenDetail(app);
      } finally {
        setResolving(false);
      }
    })();
  };

  return (
    <article
      id={`app-card-${app.id}`}
      className={`group relative bg-fr-surface-elevated border rounded-lg p-4 flex flex-col justify-between transition-all duration-150 shadow-sm hover:shadow-md dark:shadow-lg dark:shadow-black/40 ${
        isBatchSelected
          ? 'border-sky-500/60 bg-sky-950/15 ring-1 ring-sky-500/40'
          : 'border-fr-border hover:border-fr-border-strong'
      }`}
    >
      <div>
        {/* ---- Top: icon, name, and at most the two curation badges ----
            flex-wrap lets the quiet action cluster drop to a second row at
            the 320px floor on coarse pointers: four 44px touch targets plus
            the checkbox, icon and name cannot fit 256px of content width,
            and the shrink-0 cluster used to overhang the card border while
            the name collapsed toward zero width. */}
        <div id={`app-header-bar-${app.id}`} className="flex flex-wrap items-start justify-between gap-2 mb-1">
          <div className="flex items-start gap-2.5 min-w-0">
            {onToggleBatchSelect && (
              <input
                type="checkbox"
                id={`batch-check-${app.id}`}
                checked={isBatchSelected}
                onChange={() => onToggleBatchSelect(app.id)}
                className="mt-3 w-3.5 h-3.5 fr-touch-target rounded border-slate-950/20 dark:border-white/20 bg-slate-950/5 dark:bg-white/5 text-sky-500 focus:ring-sky-500 focus:ring-offset-0 cursor-pointer accent-sky-500"
                title={t('card.batch.aria').replace('{name}', app.name)}
                aria-label={t('card.batch.aria').replace('{name}', app.name)}
              />
            )}

            <AppIcon appId={app.id} name={app.name} size={38} />

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 flex-wrap">
                {/* Native button inside the heading: identical look, but
                    keyboard-focusable and announced as an action (a plain
                    clickable heading is invisible to keyboards and AT).
                    The two-line clamp lives ON the button: the button is
                    the text's box, and a clamp on the h2 is defeated by
                    the inline-block child (pathological names grew the
                    card to four+ lines in the stress fixture).
                    Level: h2 - the page has exactly one h1 (the hero) and
                    no intermediate section headings, so h3 skipped a level
                    (axe: heading-order). */}
                <h2
                  id={`app-title-${app.id}`}
                  className="font-bold text-slate-100 text-base leading-snug tracking-tight group-hover:text-sky-400 transition-colors break-words"
                >
                  <button
                    type="button"
                    onClick={() => onOpenDetail(app)}
                    title={app.name}
                    className="text-start text-inherit [font:inherit] bg-transparent border-0 p-0 m-0 cursor-pointer line-clamp-2 break-words"
                  >
                    {app.name}
                  </button>
                </h2>
                {app.isOwnerPick && (
                  <span
                    id={`app-owner-badge-${app.id}`}
                    className="text-[11px] font-bold bg-amber-400 text-amber-950 border border-amber-400 px-2 py-0.5 rounded flex items-center gap-1 whitespace-nowrap shadow-xs"
                    title={t('card.badge.pick.tip')}
                  >
                    <Award className="w-3 h-3" aria-hidden="true" />
                    <span>{t('card.badge.pick')}</span>
                  </span>
                )}

                {app.isTrendingToday && (
                  <span
                    id={`app-trending-badge-${app.id}`}
                    className="text-[11px] font-medium text-emerald-800 dark:text-emerald-300 flex items-center gap-1 whitespace-nowrap"
                    title={t('card.badge.trending.tip')}
                  >
                    <Flame className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
                    <span>{t('card.badge.trending')}</span>
                  </span>
                )}
              </div>

              {/* Quiet category label: metadata, not a badge. The stored
                  domain value is translated through the shared mapping -
                  the same label the filters, table and detail modal use. */}
              <span
                id={`app-cat-badge-${app.id}`}
                className="block text-[11px] font-semibold uppercase tracking-wide text-slate-400 truncate mt-0.5"
              >
                {t(CATEGORY_I18N_KEYS[app.category])}
              </span>
            </div>
          </div>

          {/* Secondary operations: visually quiet icon buttons, always
              reachable (keyboard focusable, labeled). ms-auto keeps the
              cluster on the inline end of its line when it wraps. */}
          <div className="flex items-center gap-0.5 shrink-0 ms-auto">
            {onToggleCompare && (
              <button
                type="button"
                id={`compare-toggle-btn-${app.id}`}
                onClick={() => onToggleCompare(app.id)}
                className={`p-1.5 fr-touch-target rounded text-xs transition-colors ${
                  isCompared
                    ? 'text-sky-800 bg-sky-800/[0.08] border border-sky-800/25 dark:text-sky-400 dark:bg-sky-400/15 dark:border-sky-400/30'
                    : 'text-slate-500 hover:text-slate-200 hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06]'
                }`}
                title={isCompared ? t('card.compare.on') : t('card.compare.off')}
                aria-label={isCompared ? t('card.compare.ariaRemove').replace('{name}', app.name) : t('card.compare.ariaAdd').replace('{name}', app.name)}
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
                className="p-1.5 fr-touch-target rounded text-xs text-slate-500 hover:text-slate-100 hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06] transition-colors"
                title={t('card.edit.tip')}
                aria-label={t('card.edit.aria').replace('{name}', app.name)}
              >
                <Edit2 className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            )}

            {app.isCustom && onDeleteApp && (
              <button
                id={`delete-app-btn-${app.id}`}
                type="button"
                onClick={() => setShowDeleteConfirm(true)}
                className="p-1.5 fr-touch-target rounded text-xs text-slate-500 hover:text-rose-400 hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06] transition-colors"
                title={t('card.delete.tip')}
                aria-label={t('card.delete.aria').replace('{name}', app.name)}
              >
                <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            )}

            <button
              id={`fav-toggle-btn-${app.id}`}
              type="button"
              onClick={() => onToggleFavorite(app.id)}
              className={`p-1.5 fr-touch-target rounded text-xs transition-colors ${
                isFavorite
                  ? 'text-rose-700 bg-rose-800/[0.08] dark:text-rose-400 dark:bg-rose-400/10'
                  : 'text-slate-500 hover:text-slate-200 hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06]'
              }`}
              aria-label={isFavorite ? t('card.fav.ariaOn').replace('{name}', app.name) : t('card.fav.ariaOff').replace('{name}', app.name)}
              aria-pressed={isFavorite}
              title={isFavorite ? t('card.fav.on') : t('card.fav.off')}
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
                  // The removal unmounts this card and dropped keyboard
                  // focus onto <body>. Park it on the next focusable title
                  // in the grid (or the main landmark when the catalog is
                  // now empty) so keyboard users keep their place.
                  requestAnimationFrame(() => {
                    const next = document.querySelector<HTMLElement>('#apps-catalog-grid h2 button');
                    (next ?? document.getElementById('main-content'))?.focus();
                  });
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
            title={app.githubUrl.includes('github.com') ? t('card.stars.tipGithub').replace('{count}', formatStarCount(shownStars)) : t('card.stars.tipForge').replace('{count}', formatStarCount(shownStars))}
          >
            <Star className="w-3 h-3 fill-slate-400 text-slate-400" aria-hidden="true" />
            <span>{formatStarCount(shownStars)}</span>
          </span>

          <span
            id={`app-license-badge-${app.id}`}
            className="font-mono text-xs text-slate-400 max-w-[14ch] truncate"
            title={t('card.license.tip').replace('{license}', translateLicenseDisplay(t, app.license))}
          >
            {translateLicenseDisplay(t, app.license)}
          </span>

          {app.proprietaryAlternative && (
            <span
              className="text-[11px] font-medium text-slate-400 bg-slate-950/[0.04] dark:bg-white/[0.04] border border-slate-950/10 dark:border-white/[0.08] px-1.5 py-0.5 rounded max-w-[20ch] truncate"
              title={t('card.replaces.tip').replace('{name}', app.proprietaryAlternative)}
            >
              {app.proprietaryAlternative}
            </span>
          )}

          {app.offlineReady && (
            <span
              className="text-[11px] text-slate-400 inline-flex items-center gap-1"
              title={t('card.offline.tip')}
            >
              <HardDrive className="w-3 h-3 text-emerald-400" aria-hidden="true" />
              <span>{t('card.offlineReady')}</span>
            </span>
          )}

          {app.isCustom && (
            <span
              id={`app-custom-badge-${app.id}`}
              className="text-[11px] font-medium bg-sky-400/10 text-sky-300 border border-sky-400/20 px-1.5 py-0.5 rounded"
              title={t('card.custom.tip')}
            >
              {t('card.badge.custom')}
            </span>
          )}

          <div id={`app-platforms-list-${app.id}`} className="flex items-center gap-1.5 ms-auto flex-wrap" title={t('card.platforms.tip')}>
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
          className="flex-1 min-w-0 inline-flex items-center justify-center gap-1.5 text-xs font-semibold bg-fr-success-strong hover:bg-fr-success-strong-hover text-white px-3 py-2 rounded-md transition-colors shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300"
          title={isDownloading ? t('card.download.busy') : resolving ? t('card.download.resolving') : t('card.download.tip')}
          aria-label={t('card.download.aria').replace('{name}', app.name)}
          aria-live="polite"
        >
          <Download className={`w-3.5 h-3.5 shrink-0 ${isDownloading || resolving ? 'animate-pulse' : ''}`} aria-hidden="true" />
          <span className="truncate">{isDownloading || resolving ? t('card.download') + '…' : t('card.download')}</span>
        </button>

        <button
          id={`view-guide-btn-${app.id}`}
          type="button"
          onClick={() => onOpenDetail(app)}
          className="inline-flex items-center gap-1 shrink-0 text-xs font-medium text-slate-300 hover:text-slate-100 bg-slate-950/[0.04] dark:bg-white/[0.04] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.08] border border-slate-950/10 dark:border-white/[0.08] px-2.5 py-2 rounded-md transition-colors"
          aria-label={t('card.details.aria').replace('{name}', app.name)}
        >
          <Info className="w-3.5 h-3.5 text-sky-400" aria-hidden="true" />
          <span>{t('card.details')}</span>
        </button>

        {sourceLinksFor(app).map((link, i) => {
          const Icon = link.kind === 'github' ? Github : link.kind === 'gitlab' ? Gitlab : Code2;
          // The forge fallback label ('Source') is a real English word -
          // translate it; the forge proper nouns pass through.
          const hostLabel = link.kind === 'forge' ? t('card.source.forge') : link.label;
          return (
            <a
              key={link.url}
              id={link.kind === 'gitlab' ? `gitlab-link-${app.id}` : i === 0 ? `github-link-${app.id}` : `source-link-${app.id}-${i}`}
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => { e.preventDefault(); void openExternal(link.url); }}
              className="p-1.5 fr-touch-target shrink-0 text-slate-500 hover:text-slate-100 hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06] border border-transparent hover:border-slate-950/20 dark:hover:border-white/[0.08] rounded-md transition-colors"
              aria-label={t('card.source.aria').replace('{name}', app.name).replace('{host}', hostLabel)}
              title={t('card.source.tip').replace('{host}', hostLabel)}
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
