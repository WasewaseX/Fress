import React, { useState, useEffect, useRef } from 'react';
import { useModalA11y } from '../lib/modalA11y';
import { AppItem, Category } from '../types';
import { Search, Terminal, Check, Copy, Code2 } from 'lucide-react';

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
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useModalA11y<HTMLDivElement>(isOpen, onClose);

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

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

    // Check system actions
    if ('batch install script'.includes(q) || 'script'.includes(q) || 'install'.includes(q)) {
      matches.push({
        type: 'action',
        id: 'act-batch',
        title: 'Generate Batch Install Script',
        subtitle: 'Create combined PowerShell, Bash, or Brewfile scripts for multiple apps',
        action: () => {
          onClose();
          onOpenBatchInstall();
        }
      });
    }

    if ('compare side by side'.includes(q) || 'matrix'.includes(q)) {
      matches.push({
        type: 'action',
        id: 'act-compare',
        title: 'Open Side-by-Side Comparison Matrix',
        subtitle: 'Compare licenses, architectures, and capabilities of selected software',
        action: () => {
          onClose();
          onOpenCompare();
        }
      });
    }

    if ('export markdown readme csv json'.includes(q) || 'readme'.includes(q) || 'export'.includes(q)) {
      matches.push({
        type: 'action',
        id: 'act-export',
        title: 'Export Catalog (Markdown README / CSV / JSON)',
        subtitle: 'Download the full catalog as formatted markdown or spreadsheet data',
        action: () => {
          onClose();
          onOpenExport();
        }
      });
    }

    if ('switch toggle view table grid'.includes(q)) {
      matches.push({
        type: 'action',
        id: 'act-view',
        title: `Switch View Mode (Currently: ${viewMode === 'grid' ? 'Grid' : 'Table'})`,
        subtitle: 'Toggle between visual card grid and compact data table',
        action: () => {
          onToggleViewMode();
          onClose();
        }
      });
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
          subtitle: matchAlt ? `Alternative to ${app.proprietaryAlternative} · ${app.tagline}` : app.tagline,
          alt: app.proprietaryAlternative
        });
      }
    }

    return matches.slice(0, 12);
  }, [query, apps, viewMode]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % Math.max(1, filteredItems.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + filteredItems.length) % Math.max(1, filteredItems.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const current = filteredItems[selectedIndex];
      if (current) {
        if (current.type === 'action' && current.action) {
          current.action();
        } else if (current.type === 'app' && current.app) {
          onOpenAppDetail(current.app);
          onClose();
        }
      }
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  const handleCopyCommand = async (e: React.MouseEvent, cmd: string, id: string) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(cmd);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      // ignore
    }
  };

  if (!isOpen) return null;

  return (
    <div 
      id="command-palette-backdrop"
      className="fixed inset-0 z-[60] fr-backdrop backdrop-blur-xs flex items-start justify-center pt-16 sm:pt-24 px-4 animate-in fade-in duration-100"
      onClick={onClose}
    >
      <div 
        id="command-palette-modal"
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="w-full max-w-2xl bg-slate-900 border border-slate-950/[0.14] dark:border-white/[0.14] rounded-xl shadow-2xl overflow-hidden flex flex-col focus:outline-none"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Search Header */}
        <div className="flex items-center px-4 py-3.5 border-b border-slate-950/10 dark:border-white/[0.08] bg-slate-950/80">
          <Search className="w-5 h-5 text-slate-400 mr-3 shrink-0" aria-hidden="true" />
          <input
            ref={inputRef}
            id="command-palette-input"
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            placeholder="Type a tool name, category, or alternative (e.g., 'Photoshop', 'AirDrop', 'brew')..."
            className="w-full bg-transparent text-sm text-slate-100 placeholder-slate-500 focus:outline-none"
            aria-label="Command palette input"
          />
          <kbd className="hidden sm:inline-block font-mono text-[11px] text-slate-400 bg-slate-950/[0.05] dark:bg-white/[0.06] border border-slate-950/10 dark:border-white/[0.1] px-1.5 py-0.5 rounded ml-2">
            ESC
          </kbd>
        </div>

        {/* Results List */}
        <div id="command-palette-list" className="max-h-96 overflow-y-auto p-2 divide-y divide-slate-950/10 dark:divide-white/[0.03]">
          {filteredItems.length > 0 ? (
            filteredItems.map((item, idx) => {
              const isSelected = idx === selectedIndex;
              if (item.type === 'action') {
                return (
                  <div
                    key={item.id}
                    id={`palette-item-${item.id}`}
                    onClick={() => item.action?.()}
                    onMouseEnter={() => setSelectedIndex(idx)}
                    className={`flex items-center justify-between px-3 py-2.5 rounded-lg cursor-pointer transition-colors ${
                      isSelected ? 'bg-sky-500/15 text-white border border-sky-500/30' : 'text-slate-300 hover:bg-slate-950/[0.05] dark:hover:bg-white/[0.04]'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <div className="p-2 rounded-md bg-sky-500/10 text-sky-400">
                        <Terminal className="w-4 h-4" aria-hidden="true" />
                      </div>
                      <div>
                        <div className="text-xs font-semibold text-slate-100">{item.title}</div>
                        <div className="text-[11px] text-slate-400">{item.subtitle}</div>
                      </div>
                    </div>
                    <span className="text-[11px] font-mono text-slate-500 uppercase tracking-wider">
                      Action
                    </span>
                  </div>
                );
              }

              const app = item.app!;

              const installCmd = app.wingetCommand || app.brewCommand || app.flatpakCommand;

              return (
                <div
                  key={app.id}
                  id={`palette-item-${app.id}`}
                  onClick={() => {
                    onOpenAppDetail(app);
                    onClose();
                  }}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  className={`flex items-center justify-between px-3 py-2.5 rounded-lg cursor-pointer transition-colors ${
                    isSelected ? 'bg-sky-500/15 text-white border border-sky-500/30' : 'text-slate-300 hover:bg-slate-950/[0.05] dark:hover:bg-white/[0.04]'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="p-2 rounded-md bg-slate-950/[0.05] dark:bg-white/[0.05] text-slate-300 shrink-0">
                      <Code2 className="w-4 h-4 text-sky-400" aria-hidden="true" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-slate-100 truncate">{app.name}</span>
                        {app.proprietaryAlternative && (
                          <span className="text-[11px] text-amber-300/90 font-mono bg-amber-400/10 border border-amber-400/20 px-1.5 py-0.5 rounded shrink-0">
                            vs {app.proprietaryAlternative}
                          </span>
                        )}
                        {app.stars > 0 && (
                          <span className="text-[11px] text-slate-400 font-mono" title={`${app.stars.toLocaleString()} stars`}>
                            ★ {app.stars >= 1000 ? `${(app.stars / 1000).toFixed(app.stars < 10000 ? 1 : 0).replace(/\.0$/, '')}k` : app.stars}
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-slate-400 truncate">{item.subtitle}</p>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0 ml-3">
                    {installCmd && (
                      <button
                        type="button"
                        onClick={(e) => handleCopyCommand(e, installCmd, app.id)}
                        className="inline-flex items-center gap-1 text-[11px] font-mono bg-slate-950/[0.05] dark:bg-white/[0.05] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.1] border border-slate-950/10 dark:border-white/[0.1] text-slate-200 px-2 py-1 rounded transition-colors"
                        title={installCmd}
                      >
                        {copiedId === app.id ? (
                          <>
                            <Check className="w-3 h-3 text-emerald-400" aria-hidden="true" />
                            <span className="text-emerald-400">Copied!</span>
                          </>
                        ) : (
                          <>
                            <Copy className="w-3 h-3 text-slate-400" aria-hidden="true" />
                            <span>Copy Cmd</span>
                          </>
                        )}
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          ) : (
            <div className="p-8 text-center text-xs text-slate-400">
              No matching software or command found for &quot;{query}&quot;.
            </div>
          )}
        </div>

        {/* Footer Navigation Hints */}
        <div className="px-4 py-2.5 bg-slate-950/90 border-t border-slate-950/10 dark:border-white/[0.08] flex items-center justify-between text-[11px] text-slate-400">
          <div className="flex items-center gap-3">
            <span><kbd className="font-mono bg-slate-950/[0.05] dark:bg-white/[0.06] border border-slate-950/10 dark:border-white/[0.1] px-1 py-0.5 rounded text-[11px]">↑↓</kbd> Navigate</span>
            <span><kbd className="font-mono bg-slate-950/[0.05] dark:bg-white/[0.06] border border-slate-950/10 dark:border-white/[0.1] px-1 py-0.5 rounded text-[11px]">↵</kbd> Select</span>
            <span><kbd className="font-mono bg-slate-950/[0.05] dark:bg-white/[0.06] border border-slate-950/10 dark:border-white/[0.1] px-1 py-0.5 rounded text-[11px]">ESC</kbd> Dismiss</span>
          </div>
          <span className="font-mono text-[11px] text-slate-500">{apps.length} tools indexed</span>
        </div>
      </div>
    </div>
  );
};
