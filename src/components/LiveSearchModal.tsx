// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import React, { useState, useEffect, useRef } from 'react';
import { keepFocusInside } from '../lib/modalFocus';
import { useI18n, CATEGORY_I18N_KEYS } from '../lib/i18n';
import { openExternal } from '../lib/external';
import { 
  Search, 
  X, 
  Loader2, 
  Plus, 
  Check, 
  ExternalLink, 
  Star, 
  FolderGit2, 
  Sparkles,
  Smartphone,
  Terminal,
  Layers
} from 'lucide-react';
import { AppItem, Platform, Category } from '../types';
import { formatStarCount } from '../lib/starFetch';

interface LiveSearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAddApp: (app: AppItem) => void;
  existingApps: AppItem[];
  /** When true, shows the Search/Manual tabs so both add-flows share one entry point. */
  showTabs?: boolean;
  onSwitchTab?: (tab: 'search' | 'manual') => void;
}

export const LiveSearchModal: React.FC<LiveSearchModalProps> = ({
  isOpen,
  onClose,
  onAddApp,
  existingApps,
  showTabs = false,
  onSwitchTab
}) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<AppItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set());
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Monotonic id: only the newest search may touch state (stale responses
  // used to overwrite fresh results and kill the spinner early).
  const searchReqId = useRef(0);
  const { t } = useI18n();

  // Pre-populate with a starting search once per open, so the dialog is
  // never an empty wall. The query reset keeps repeated opens consistent.
  useEffect(() => {
    if (isOpen && !query) {
      handleSearch('awesome open-source');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Focus, Escape and the shared stack: keepFocusInside moves focus to the
  // search input synchronously on open (no setTimeout that could leak past
  // close), restores focus to the opener on close, and answers Escape only
  // while this dialog is the topmost open surface.
  const panelRef = useRef<HTMLDivElement>(null);
  keepFocusInside(panelRef, isOpen, { onEscape: onClose, initialFocus: inputRef });

  // A keystroke schedules a search 350ms out; that pending timer must not
  // fire into an unmounted dialog.
  useEffect(() => {
    return () => {
      if (debounceTimer.current !== null) clearTimeout(debounceTimer.current);
    };
  }, []);

  const existingGithubUrls = new Set(
    existingApps.map((a) => a.githubUrl?.toLowerCase().replace(/\/$/, '')).filter(Boolean)
  );
  const existingNames = new Set(existingApps.map((a) => a.name.toLowerCase()));

  const handleSearch = async (searchTerm: string) => {
    const myId = ++searchReqId.current;
    const q = searchTerm.trim();
    if (!q) {
      setResults([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setErrorMsg(null);

    try {
      // 1. Try server-side live search proxy
      const res = await fetch(`/api/github/search?q=${encodeURIComponent(q)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.items && data.items.length > 0) {
          if (myId === searchReqId.current) {
            setResults(data.items);
            setLoading(false);
          }
          return;
        }
      }

      // 2. Client-side fallback to GitHub Search API
      const ghRes = await fetch(
        `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}+is:public&sort=stars&order=desc&per_page=12`
      );
      if (ghRes.ok) {
        const ghData = await ghRes.json();
        const mappedItems: AppItem[] = (ghData.items || []).map((repo: any) => {
          const text = `${repo.name} ${repo.description || ''} ${(repo.topics || []).join(' ')}`.toLowerCase();
          let category: Category = 'Utilities & System';
          if (text.includes('code') || text.includes('editor') || text.includes('terminal') || text.includes('compiler') || text.includes('git')) {
            category = 'Developer & Code';
          } else if (text.includes('note') || text.includes('markdown') || text.includes('office') || text.includes('todo')) {
            category = 'Productivity & Office';
          } else if (text.includes('password') || text.includes('security') || text.includes('privacy') || text.includes('vault')) {
            category = 'Privacy & Security';
          } else if (text.includes('video') || text.includes('audio') || text.includes('player') || text.includes('media')) {
            category = 'Media, Audio & Video';
          } else if (text.includes('paint') || text.includes('draw') || text.includes('3d') || text.includes('design')) {
            category = 'Design & Creative';
          }
          if (text.includes('llm') || text.includes('ai') || text.includes('gpt')) {
            category = 'Productivity & Office';
          }

          const hasAndroid = text.includes('android') || (repo.topics || []).includes('android');
          const platforms: Platform[] = ['windows', 'mac', 'linux'];
          if (hasAndroid) platforms.push('android');

          return {
            id: `custom-gh-${repo.id}`,
            name: repo.name,
            tagline: repo.description ? repo.description.slice(0, 110) : 'Open-source application',
            description: repo.description || 'Community open-source repository.',
            whyItsAwesome: `Community-backed open-source project with ${repo.stargazers_count.toLocaleString()} stars on GitHub.`,
            beginnerGuide: 'Visit the GitHub project page for release downloads and setup instructions.',
            githubUrl: repo.html_url,
            websiteUrl: repo.homepage || repo.html_url,
            category,
            platforms,
            license: repo.license?.spdx_id || repo.license?.name || 'Open Source',
            stars: repo.stargazers_count,
            beginnerRating: 'Quick Learning Curve',
            isOwnerPick: false,
            isTrendingToday: false,
            tags: repo.topics && repo.topics.length > 0 ? repo.topics.slice(0, 4) : ['open-source', 'github'],
            wingetCommand: `winget install ${repo.name}`,
            brewCommand: `brew install --cask ${repo.name.toLowerCase()}`,
            flatpakCommand: `flatpak install flathub ${repo.name.toLowerCase()}`,
            isPortable: true,
            offlineReady: true,
            isCustom: true,
            addedAt: new Date().toISOString().split('T')[0]
          };
        });
        if (myId === searchReqId.current) setResults(mappedItems);
      } else {
        if (myId === searchReqId.current) setErrorMsg(t('ls.rateLimited'));
      }
    } catch (err: any) {
      if (myId === searchReqId.current) setErrorMsg(t('ls.networkFailed'));
    } finally {
      if (myId === searchReqId.current) setLoading(false);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setQuery(val);

    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }

    debounceTimer.current = setTimeout(() => {
      handleSearch(val);
    }, 350);
  };

  const handleAddTool = (app: AppItem) => {
    const cleanApp: AppItem = {
      ...app,
      id: app.id || `custom-${Date.now()}`,
      isCustom: true,
      addedAt: new Date().toISOString().split('T')[0]
    };

    onAddApp(cleanApp);
    setAddedIds((prev) => new Set([...prev, app.id]));
  };

  if (!isOpen) return null;

  return (
    <div 
      ref={panelRef}
      id="live-search-modal-backdrop" 
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5 bg-black/80 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="live-search-title"
    >
      <div 
        id="live-search-card"
        className="bg-slate-900 border border-slate-950/[0.14] dark:border-white/[0.14] rounded-xl w-full max-w-3xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="p-4 border-b border-slate-950/10 dark:border-white/[0.08] flex items-center justify-between gap-3 bg-slate-900">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-sky-500/10 border border-sky-500/20 flex items-center justify-center text-sky-400">
              <Sparkles className="w-4 h-4" aria-hidden="true" />
            </div>
            <div>
              <h2 id="live-search-title" className="text-sm font-bold text-slate-100 tracking-tight">
                {t('ls.title')}
              </h2>
              <p className="text-[11px] text-slate-400">
                {t('ls.disclaimer')}
              </p>
            </div>
          </div>
          <button
            id="close-live-search-btn"
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-100 p-1 rounded-md hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06] transition-colors"
            aria-label={t('ls.closeAria')}
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        {/* Shared tabs: one entry point for both ways of adding an app */}
        {showTabs && onSwitchTab && (
          <div className="flex items-center gap-1 px-4 py-2 border-b border-slate-950/10 dark:border-white/[0.06] bg-slate-900" role="tablist" aria-label={t('ls.tabsAria')}>
            {([['search', t('ls.title')], ['manual', t('ls.tabManual')]] as const).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={id === 'search'}
                onClick={() => onSwitchTab(id)}
                className={`text-xs font-semibold px-3 py-1.5 rounded-md transition-colors ${
                  id === 'search'
                    ? 'bg-sky-600 text-white border border-sky-500'
                    : 'text-slate-300 hover:text-slate-100 bg-slate-950/[0.04] dark:bg-white/[0.04] border border-slate-950/10 dark:border-white/[0.08]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {/* Search Input Bar */}
        <div className="p-4 border-b border-slate-950/10 dark:border-white/[0.06] bg-slate-950">
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden="true" />
            <input
              ref={inputRef}
              id="live-search-query-input"
              type="text"
              value={query}
              onChange={handleInputChange}
              placeholder={t('ls.placeholder')}
              className="w-full bg-slate-950/[0.04] dark:bg-white/[0.04] border border-slate-950/[0.12] dark:border-white/[0.12] text-slate-100 placeholder-slate-400 text-sm rounded-lg pl-9 pr-10 py-2.5 focus:outline-none focus:ring-1 focus:ring-sky-500 focus:border-sky-500 transition-colors"
            />
            {loading && (
              <Loader2 className="w-4 h-4 text-sky-400 absolute right-3 top-1/2 -translate-y-1/2 animate-spin" aria-hidden="true" />
            )}
          </div>

          {/* Quick Search Badges */}
          <div className="flex items-center gap-1.5 flex-wrap mt-2.5 text-xs">
            <span className="text-slate-400 text-[11px]">{t('ls.tryLabel')}</span>
            {['syncthing', 'neovim', 'tailscale', 'alacritty', 'obsidian', 'termux', 'ollama'].map((term) => (
              <button
                key={term}
                type="button"
                onClick={() => {
                  setQuery(term);
                  handleSearch(term);
                }}
                className="px-2 py-0.5 rounded text-[11px] bg-slate-950/[0.04] dark:bg-white/[0.04] text-slate-300 hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.08] hover:text-slate-100 border border-slate-950/10 dark:border-white/[0.06] transition-colors"
              >
                {term}
              </button>
            ))}
          </div>
        </div>

        {/* Results List */}
        <div id="live-search-results-list" className="flex-1 overflow-y-auto p-4 space-y-2.5">
          {errorMsg && (
            <div role="alert" className="p-3 bg-amber-500/10 border border-amber-500/20 text-amber-300 text-xs rounded-lg">
              {errorMsg}
            </div>
          )}

          {results.length === 0 && !loading && (
            <div role="status" className="text-center py-12 text-slate-400 text-xs">
              <FolderGit2 className="w-8 h-8 mx-auto mb-2 text-slate-400" aria-hidden="true" />
              <p>{t('ls.emptyTitle')}</p>
              <p className="text-[11px] text-slate-400 mt-1">
                {t('ls.emptyHint')}
              </p>
            </div>
          )}

          {results.map((item) => {
            const isAlreadyAdded = 
              addedIds.has(item.id) ||
              existingGithubUrls.has(item.githubUrl?.toLowerCase().replace(/\/$/, '')) ||
              existingNames.has(item.name.toLowerCase());

            const hasAndroid = item.platforms.includes('android');

            return (
              <div
                key={item.id}
                id={`live-result-item-${item.id}`}
                className="bg-slate-950/[0.03] dark:bg-white/[0.02] hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.05] border border-slate-950/10 dark:border-white/[0.06] hover:border-slate-950/25 dark:hover:border-white/[0.14] rounded-lg p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <h3 className="font-bold text-sm text-slate-100 truncate">
                      {item.name}
                    </h3>
                    <span className="text-[11px] text-amber-300 font-mono inline-flex items-center gap-0.5 bg-amber-400/10 px-1.5 py-0.5 rounded border border-amber-400/20">
                      <Star className="w-2.5 h-2.5" aria-hidden="true" />
                      {typeof item.stars === 'number' && item.stars > 0 ? formatStarCount(item.stars) : t('common.fossBadge')}
                    </span>
                    <span className="text-[11px] text-sky-300 bg-sky-400/10 px-1.5 py-0.5 rounded border border-sky-400/20">
                      {t(CATEGORY_I18N_KEYS[item.category])}
                    </span>
                    {hasAndroid && (
                      <span className="text-[11px] text-emerald-300 bg-emerald-400/10 px-1.5 py-0.5 rounded border border-emerald-400/20 inline-flex items-center gap-0.5">
                        <Smartphone className="w-2.5 h-2.5" aria-hidden="true" />
                        {t('common.platform.android')}
                      </span>
                    )}
                    {item.license && (
                      <span className="text-[11px] text-slate-400 font-mono">
                        {item.license}
                      </span>
                    )}
                  </div>

                  <p className="text-xs text-slate-300 line-clamp-2 leading-relaxed">
                    {item.tagline || item.description}
                  </p>

                  <div className="flex items-center gap-3 mt-2 text-[11px] text-slate-400">
                    <a
                      href={item.githubUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 hover:text-sky-300 transition-colors"
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); void openExternal(item.githubUrl); }}
                    >
                      <span>{t('ls.viewGitHub')}</span>
                      <ExternalLink className="w-3 h-3" aria-hidden="true" />
                    </a>
                    {item.wingetCommand && (
                      <span className="font-mono text-[11px] text-slate-400 truncate max-w-xs">
                        {item.wingetCommand}
                      </span>
                    )}
                  </div>
                </div>

                {/* Add to catalog button */}
                <div className="shrink-0">
                  {isAlreadyAdded ? (
                    <button
                      type="button"
                      disabled
                      aria-disabled="true"
                      className="inline-flex items-center gap-1.5 bg-emerald-500/10 text-emerald-300 border border-emerald-500/30 text-xs font-medium px-3 py-1.5 rounded-md cursor-default"
                    >
                      <Check className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>{t('ls.inCatalog')}</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      id={`btn-add-live-app-${item.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}`}
                      onClick={() => handleAddTool(item)}
                      className="inline-flex items-center gap-1.5 bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold px-3 py-1.5 rounded-md border border-sky-400 transition-colors shadow-xs"
                    >
                      <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>{t('common.add')}</span>
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer info */}
        <div className="p-3 border-t border-slate-950/10 dark:border-white/[0.08] bg-slate-950 flex items-center justify-between text-xs text-slate-400">
          <span>{t('common.savedLocal')}</span>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-300 hover:text-slate-100 px-2 py-1 text-xs"
          >
            {t('common.done')}
          </button>
        </div>
      </div>
    </div>
  );
};
