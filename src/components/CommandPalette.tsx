// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import React, { useState, useEffect, useRef } from 'react';
import { keepFocusInside } from '../lib/modalFocus';
import { useI18n } from '../lib/i18n';
import { AppItem, Category, Platform } from '../types';
import { formatStarCount } from '../lib/starFetch';
import {
  Search,
  Terminal,
  Check,
  Copy,
  ExternalLink,
  Bookmark,
  Columns,
  Layers,
  Download,
  X,
  Code2,
  FileText
} from 'lucide-react';

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  apps: AppItem[];
  favorites: string[];
  onToggleFavorite: (id: string) => void;
  onOpenAppDetail: (app: AppItem) => void;
  onSelectCategory: (cat: Category) => void;
  onToggleViewMode: () => void;
  viewMode: 'grid' | 'table';
  onOpenBatchInstall: () => void;
  onOpenCompare: () => void;
  onOpenExport: () => void;
}

/**
 * Does the query hit this action's search aliases?
 *
 * Every system action carries a `palette.alias*` dictionary key: a flat,
 * lowercase, space-separated list of searchable words TRANSLATED FOR EACH
 * LANGUAGE (the old English-only keyword predicates locked Persian/Spanish/
 * French/German users out of the actions they could see rendered). Matching
 * is plain case-insensitive substring over the alias string, so "inst"
 * finds "install", "batch" finds "batch install", and a translated word
 * finds its action in that language - without any stemming or fuzzy logic
 * that could turn brittle. Queries shorter than two characters match
 * nothing: one letter would otherwise surface every action at once.
 *
 * Exported for tests: the localized-alias coverage is pinned per language.
 */
export function aliasMatches(query: string, aliasString: string): boolean {
  const q = query.toLowerCase().trim();
  if (q.length < 2) return false;
  return aliasString.toLowerCase().includes(q);
}

type PaletteAction = {
  id: string;
  aliasesKey: string;
  titleKey: string;
  subKey: string;
  /** Extra static words to match besides the alias key (localized too). */
  extraTextKeys?: string[];
};

const ACTIONS: PaletteAction[] = [
  { id: 'act-batch', aliasesKey: 'palette.aliasBatch', titleKey: 'palette.actionBatchTitle', subKey: 'palette.actionBatchSub' },
  { id: 'act-compare', aliasesKey: 'palette.aliasCompare', titleKey: 'palette.actionCompareTitle', subKey: 'palette.actionCompareSub' },
  { id: 'act-export', aliasesKey: 'palette.aliasExport', titleKey: 'palette.actionExportTitle', subKey: 'palette.actionExportSub' },
  { id: 'act-view', aliasesKey: 'palette.aliasView', titleKey: 'palette.actionViewTitle', subKey: 'palette.actionViewSub', extraTextKeys: ['common.viewGrid', 'common.viewTable'] },
];

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  isOpen,
  onClose,
  apps,
  favorites,
  onToggleFavorite,
  onOpenAppDetail,
  onSelectCategory,
  onToggleViewMode,
  viewMode,
  onOpenBatchInstall,
  onOpenCompare,
  onOpenExport
}) => {
  const [query, setQuery] = useState('');
  const [copyState, setCopyState] = useState<{ id: string; ok: boolean } | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const copyTimerRef = useRef<number | null>(null);
  const { t, lang } = useI18n();

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      // Focus is NOT set here. keepFocusInside (declared below, so its
      // effect runs after this one) captures the OPENER before moving focus
      // to options.initialFocus (this input). Focusing in this effect used
      // to run first and poison that capture: the palette remembered itself
      // as the opener, so closing restored focus to a node that was about
      // to be removed - keyboard users landed on <body>.
    } else {
      // Dismissal kills the pending "Copied"/"Copy failed" flash: reopening
      // inside the 2s timer window must not resurrect feedback from the
      // previous palette session (stale success is as false as stale failure).
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
        copyTimerRef.current = null;
      }
      setCopyState(null);
    }
  }, [isOpen]);

  // Stop the "Copied" flash timer when it has no row left to describe.
  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    };
  }, []);

  const filteredItems = React.useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) {
      // Return top recommended apps and top actions
      return apps.slice(0, 8).map((app) => ({
        type: 'app' as const,
        app,
        id: app.id,
        title: app.name,
        subtitle: app.tagline,
        alt: app.proprietaryAlternative
      }));
    }

    const matches: {
      type: 'app' | 'action';
      app?: AppItem;
      id: string;
      title: string;
      subtitle: string;
      alt?: string;
      action?: () => void;
    }[] = [];

    // System actions: matched through localized alias lists plus the
    // localized title/subtitle the user actually sees rendered.
    for (const action of ACTIONS) {
      const haystacks = [t(action.aliasesKey), t(action.titleKey), t(action.subKey)];
      for (const extra of action.extraTextKeys ?? []) haystacks.push(t(extra));
      const viewTitle = action.id === 'act-view'
        ? t(action.titleKey)
            .replace('{mode}', viewMode === 'grid' ? t('common.viewGrid') : t('common.viewTable'))
            .toLowerCase()
        : null;
      if (haystacks.some((h) => h.toLowerCase().includes(q)) || (viewTitle !== null && viewTitle.includes(q))) {
        matches.push({
          type: 'action',
          id: action.id,
          title: action.id === 'act-view'
            ? t(action.titleKey).replace('{mode}', viewMode === 'grid' ? t('common.viewGrid') : t('common.viewTable'))
            : t(action.titleKey),
          subtitle: t(action.subKey),
          action: () => {
            onClose();
            if (action.id === 'act-batch') onOpenBatchInstall();
            else if (action.id === 'act-compare') onOpenCompare();
            else if (action.id === 'act-export') onOpenExport();
            else if (action.id === 'act-view') onToggleViewMode();
          }
        });
      }
    }

    // Match apps by name, alternative (e.g. "photoshop"), tag, or category
    for (const app of apps) {
      const matchName = app.name.toLowerCase().includes(q);
      const matchAlt = app.proprietaryAlternative?.toLowerCase().includes(q);
      const matchTag = app.tags.some((t) => t.toLowerCase().includes(q));
      const matchDesc = app.description.toLowerCase().includes(q);
      const matchCategory = app.category.toLowerCase().includes(q);

      if (matchName || matchAlt || matchTag || matchDesc || matchCategory) {
        matches.push({
          type: 'app',
          app,
          id: app.id,
          title: app.name,
          subtitle: matchAlt
            ? t('palette.alternativeTo').replace('{alt}', app.proprietaryAlternative).replace('{tagline}', app.tagline)
            : app.tagline,
          alt: app.proprietaryAlternative
        });
      }
    }

    return matches.slice(0, 12);
    // t/lang re-translate the action titles and aliases when the language
    // switches, so search words follow the active language live.
  }, [query, apps, viewMode, t, lang, onClose, onOpenBatchInstall, onOpenCompare, onOpenExport, onToggleViewMode]);

  // The selection can go stale when the list shrinks under it (the apps
  // array updates while the palette is open: live stars, a fresh import).
  // Clamping keeps Enter and the highlight on a real row in every case;
  // typing already resets the index in the input's onChange.
  const activeIndex = Math.min(selectedIndex, Math.max(0, filteredItems.length - 1));
  const activeItem = filteredItems.length > 0 ? filteredItems[activeIndex] : undefined;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % Math.max(1, filteredItems.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + filteredItems.length) % Math.max(1, filteredItems.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const current = filteredItems[activeIndex];
      if (current) {
        if (current.type === 'action' && current.action) {
          current.action();
        } else if (current.type === 'app' && current.app) {
          onOpenAppDetail(current.app);
          onClose();
        }
      }
    }
    // Escape: owned by keepFocusInside's onEscape below, so the topmost
    // open surface answers it exactly once (the palette's own panel handler
    // used to race the global "close everything" shortcut).
    // Home/End: intentionally NOT intercepted. This is a combobox with a
    // text input, so per the ARIA Authoring Practices those keys move the
    // text caret inside the query, they do not jump across result rows.
  };

  const handleCopyCommand = async (cmd: string, id: string) => {
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    try {
      await navigator.clipboard.writeText(cmd);
      setCopyState({ id, ok: true });
    } catch {
      // Clipboard denial is user-visible feedback, not silence: without
      // this row the button lies about a copy that never happened.
      setCopyState({ id, ok: false });
    }
    copyTimerRef.current = window.setTimeout(() => {
      setCopyState(null);
      copyTimerRef.current = null;
    }, 2000);
  };

  const panelRef = useRef<HTMLDivElement>(null);
  keepFocusInside(panelRef, isOpen, { onEscape: onClose, initialFocus: inputRef });
  if (!isOpen) return null;

  return (
    <div
      ref={panelRef}
      id="command-palette-backdrop"
      className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-start justify-center pt-16 sm:pt-24 px-4 animate-in fade-in duration-100"
      onClick={onClose}
    >
      <div
        id="command-palette-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="command-palette-title"
        className="w-full max-w-2xl bg-slate-900 border border-slate-950/[0.14] dark:border-white/[0.14] rounded-xl shadow-2xl overflow-hidden flex flex-col focus:outline-none"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Visible dialog name: the accessible name comes from this heading
            via aria-labelledby, not from a competing aria-label. */}
        <h2 id="command-palette-title" className="sr-only">{t('palette.title')}</h2>

        {/* Search Header */}
        <div className="flex items-center px-4 py-3.5 border-b border-slate-950/10 dark:border-white/[0.08] bg-slate-950/80">
          <Search className="w-5 h-5 text-slate-400 mr-3 shrink-0" aria-hidden="true" />
          <input
            ref={inputRef}
            id="command-palette-input"
            type="text"
            role="combobox"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            placeholder={t('palette.placeholder')}
            className="w-full bg-transparent text-sm text-slate-100 placeholder-slate-500 focus:outline-none"
            aria-label={t('palette.inputAria')}
            aria-expanded="true"
            aria-controls="command-palette-list"
            aria-autocomplete="list"
            aria-activedescendant={activeItem ? `palette-item-${activeItem.id}` : undefined}
          />
          <kbd className="hidden sm:inline-block font-mono text-[11px] text-slate-400 bg-slate-950/[0.05] dark:bg-white/[0.06] border border-slate-950/10 dark:border-white/[0.1] px-1.5 py-0.5 rounded ml-2">
            ESC
          </kbd>
        </div>

        {/* Contextual install-command copy for the HIGHLIGHTED app row.
            It lives OUTSIDE the listbox on purpose: a listbox may own only
            option/group elements, and a focusable control among the rows
            (its li is role=presentation, and focusable descendants do NOT
            inherit that role) surfaces in the accessibility tree as a
            `button` child of the listbox - axe: aria-required-children.
            Applying it to the arrow-key selection also matches what the
            screen reader is already announcing, instead of forcing N extra
            Tab stops between the rows. */}
        {(() => {
          const activeApp = activeItem?.type === 'app' ? activeItem.app : null;
          const installCmd = activeApp ? activeApp.wingetCommand || activeApp.brewCommand || activeApp.flatpakCommand : undefined;
          if (!activeApp || !installCmd) return null;
          const feedback = copyState?.id === activeApp.id ? copyState : null;
          return (
            <div className="px-4 py-2 border-b border-slate-950/10 dark:border-white/[0.08] bg-slate-950/60">
              <button
                type="button"
                onClick={() => void handleCopyCommand(installCmd, activeApp.id)}
                className={`inline-flex items-center gap-1.5 text-[11px] font-mono border rounded px-2 py-1 transition-colors ${
                  feedback
                    ? feedback.ok
                      ? 'text-emerald-400 border-emerald-500/40 bg-emerald-500/10'
                      : 'text-rose-400 border-rose-500/40 bg-rose-500/10'
                    : 'text-slate-200 bg-slate-950/[0.05] dark:bg-white/[0.05] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.1] border-slate-950/10 dark:border-white/[0.1]'
                }`}
                title={installCmd}
              >
                {feedback ? (
                  feedback.ok ? (
                    <>
                      <Check className="w-3 h-3" aria-hidden="true" />
                      <span>{t('common.copied')}</span>
                    </>
                  ) : (
                    <>
                      <X className="w-3 h-3" aria-hidden="true" />
                      <span>{t('common.copyFailed')}</span>
                    </>
                  )
                ) : (
                  <>
                    <Copy className="w-3 h-3" aria-hidden="true" />
                    <span>{t('palette.copyCommandFor').replace('{name}', activeApp.name)}</span>
                  </>
                )}
              </button>
            </div>
          );
        })()}

        {/* Results List. The listbox/option pair (with aria-selected and the
            input's aria-activedescendant) is what makes the rows keyboard
            and screen-reader operable; the old click-only divs were silent
            to assistive tech. When NOTHING matches, the id moves to a
            role=status sibling instead: a listbox may only own option/group
            children, so the empty state must never live inside it (axe:
            aria-required-children). aria-controls keeps pointing at
            #command-palette-list either way. */}
        {filteredItems.length > 0 ? (
          <ul
            id="command-palette-list"
            role="listbox"
            aria-label={t('palette.resultsAria')}
            className="max-h-96 overflow-y-auto p-2 divide-y divide-slate-950/10 dark:divide-white/[0.03] list-none m-0"
          >
            {filteredItems.map((item, idx) => {
              const isSelected = idx === activeIndex;
              const rowCls = `w-full flex items-center justify-between px-3 py-2.5 rounded-lg cursor-pointer transition-colors text-left ${
                isSelected ? 'fr-chip-active border' : 'text-slate-300 hover:bg-slate-950/[0.05] dark:hover:bg-white/[0.04]'
              }`;
              if (item.type === 'action') {
                return (
                  <li key={item.id} role="presentation" className="list-none">
                    <button
                      type="button"
                      role="option"
                      id={`palette-item-${item.id}`}
                      aria-selected={isSelected}
                      onClick={() => item.action?.()}
                      onMouseEnter={() => setSelectedIndex(idx)}
                      onFocus={() => setSelectedIndex(idx)}
                      className={rowCls}
                    >
                      <span className="flex items-center gap-3">
                        <span className={
                          /* The selection surface (fr-chip-active) is cocoa
                           * in light / white-haze in dark: the paper-calibrated
                           * slate/sky inks collapse to ~1:1 on it, so a
                           * selected row switches to the selection-surface
                           * inks (measured, see lightThemeContrast.test). */
                          isSelected
                            ? 'p-2 rounded-md bg-white/10 text-white'
                            : 'p-2 rounded-md bg-sky-500/10 text-sky-400'
                        }>
                          <Terminal className="w-4 h-4" aria-hidden="true" />
                        </span>
                        <span>
                          <span className={`block text-xs font-semibold ${isSelected ? 'text-[color:var(--fr-chip-active-text)]' : 'text-slate-100'}`}>{item.title}</span>
                          <span className={`block text-[11px] ${isSelected ? 'text-[color:var(--fr-chip-active-text-soft)]' : 'text-slate-400'}`}>{item.subtitle}</span>
                        </span>
                      </span>
                      <span className={`text-[11px] font-mono uppercase tracking-wider ${isSelected ? 'text-[color:var(--fr-chip-active-text-soft)]' : 'text-slate-400'}`}>
                        {t('palette.actionBadge')}
                      </span>
                    </button>
                  </li>
                );
              }

              const app = item.app!;
              const isFav = favorites.includes(app.id);

              return (
                <li key={app.id} role="presentation" className="relative list-none">
                  <button
                    type="button"
                    role="option"
                    id={`palette-item-${app.id}`}
                    aria-selected={isSelected}
                    onClick={() => {
                      onOpenAppDetail(app);
                      onClose();
                    }}
                    onMouseEnter={() => setSelectedIndex(idx)}
                    onFocus={() => setSelectedIndex(idx)}
                    className={rowCls}
                  >
                    <span className="flex items-center gap-3 min-w-0">
                      <span className={`p-2 rounded-md shrink-0 ${isSelected ? 'bg-white/10 text-white' : 'bg-slate-950/[0.05] dark:bg-white/[0.05] text-slate-300'}`}>
                        <Code2 className={`w-4 h-4 ${isSelected ? 'text-white' : 'text-sky-400'}`} aria-hidden="true" />
                      </span>
                      <span className="min-w-0">
                        <span className="flex items-center gap-2">
                          <span className={`text-xs font-semibold truncate max-w-[45%] shrink-0 ${isSelected ? 'text-[color:var(--fr-chip-active-text)]' : 'text-slate-100'}`}>{app.name}</span>
                          {app.proprietaryAlternative && (
                            /* Truncates BEFORE the name (identity wins):
                             * the old shrink-0 chip could push the app
                             * name to zero width on narrow inputs. */
                            <span className={`text-[11px] font-mono px-1.5 py-0.2 rounded min-w-0 max-w-[55%] truncate ${
                              isSelected
                                ? 'text-[color:var(--fr-chip-active-accent)] bg-amber-200/10 border border-amber-200/25'
                                : 'text-amber-300/90 bg-amber-400/10 border border-amber-400/20'
                            }`}>
                              {t('palette.vs').replace('{alt}', app.proprietaryAlternative)}
                            </span>
                          )}
                          <span className={`text-[11px] font-mono shrink-0 ${isSelected ? 'text-[color:var(--fr-chip-active-text-soft)]' : 'text-slate-400'}`}>
                            ★ {formatStarCount(app.stars)}
                          </span>
                        </span>
                        <span className={`block text-[11px] truncate ${isSelected ? 'text-[color:var(--fr-chip-active-text-soft)]' : 'text-slate-400'}`}>{item.subtitle}</span>
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <div
            id="command-palette-list"
            role="status"
            className="p-8 text-center text-xs text-slate-400"
          >
            {t('palette.noMatch').replace('{query}', query)}
          </div>
        )}

        {/* Localized completion feedback for the clipboard operation: the
            visual swap on the button is not announced by screen readers on
            its own, this polite live region is. */}
        <span className="sr-only" role="status">
          {copyState
            ? copyState.ok
              ? t('common.copied')
              : t('common.copyFailed')
            : ''}
        </span>

        {/* Footer Navigation Hints */}
        <div className="px-4 py-2.5 bg-slate-950/90 border-t border-slate-950/10 dark:border-white/[0.08] flex items-center justify-between text-[11px] text-slate-400">
          <div className="flex items-center gap-3">
            <span><kbd className="font-mono bg-slate-950/[0.05] dark:bg-white/[0.06] border border-slate-950/10 dark:border-white/[0.1] px-1 py-0.5 rounded text-[11px]">↑↓</kbd> {t('palette.navigate')}</span>
            <span><kbd className="font-mono bg-slate-950/[0.05] dark:bg-white/[0.06] border border-slate-950/10 dark:border-white/[0.1] px-1 py-0.5 rounded text-[11px]">↵</kbd> {t('palette.select')}</span>
            <span><kbd className="font-mono bg-slate-950/[0.05] dark:bg-white/[0.06] border border-slate-950/10 dark:border-white/[0.1] px-1 py-0.5 rounded text-[11px]">ESC</kbd> {t('palette.dismiss')}</span>
          </div>
          <span className="font-mono text-[11px] text-slate-400">{t('palette.toolsIndexed').replace('{count}', String(apps.length))}</span>
        </div>
      </div>
    </div>
  );
};
