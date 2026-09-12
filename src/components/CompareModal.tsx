import React from 'react';
import { useModalA11y } from '../lib/modalA11y';
import { AppItem } from '../types';
import { openExternal } from '../lib/external';
import { Columns, X, Check, Minus, ExternalLink, Star } from 'lucide-react';

interface CompareModalProps {
  isOpen: boolean;
  onClose: () => void;
  appsToCompare: AppItem[];
  allApps: AppItem[];
  onAddAppToCompare: (appId: string) => void;
  onRemoveAppFromCompare: (appId: string) => void;
  onClearCompare: () => void;
}

export const CompareModal: React.FC<CompareModalProps> = ({
  isOpen,
  onClose,
  appsToCompare,
  allApps,
  onAddAppToCompare,
  onRemoveAppFromCompare,
  onClearCompare
}) => {
  const containerRef = useModalA11y<HTMLDivElement>(isOpen, onClose);
  if (!isOpen) return null;

  return (
    <div 
      id="compare-modal-backdrop"
      role="dialog" aria-modal="true" className="fixed inset-0 z-50 fr-backdrop backdrop-blur-xs flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div 
        id="compare-modal"
        ref={containerRef}
        className="w-full max-w-5xl bg-slate-900 border border-slate-950/[0.14] dark:border-white/[0.14] rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-950/10 dark:border-white/[0.08] bg-slate-950">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-sky-500/10 text-sky-400">
              <Columns className="w-5 h-5" aria-hidden="true" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-100 tracking-tight">
                Software Comparison Matrix
              </h2>
              <p className="text-xs text-slate-400">
                Direct head-to-head comparison of architectures, offline capabilities, and licensing.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {appsToCompare.length > 0 && (
              <button
                type="button"
                onClick={onClearCompare}
                className="text-xs text-slate-400 hover:text-slate-100 transition-colors"
              >
                Clear Matrix
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 text-slate-400 hover:text-slate-100 rounded-md hover:bg-slate-950/[0.06] dark:hover:bg-white/[0.06]"
              aria-label="Close dialog"
            >
              <X className="w-5 h-5" aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Matrix Content */}
        <div className="flex-1 overflow-auto p-5">
          {appsToCompare.length === 0 ? (
            <div className="py-16 text-center">
              <p className="text-slate-400 text-sm mb-4">
                No software currently selected for comparison.
              </p>
              <p className="text-slate-500 text-xs max-w-md mx-auto">
                Click &quot;Compare&quot; on any tool card or pick from the list below to compare features side-by-side.
              </p>
              <div className="mt-6 flex flex-wrap justify-center gap-2 max-w-2xl mx-auto">
                {allApps.slice(0, 6).map((app) => (
                  <button
                    key={app.id}
                    type="button"
                    onClick={() => onAddAppToCompare(app.id)}
                    className="text-xs px-2.5 py-1 rounded bg-slate-950/[0.05] dark:bg-white/[0.05] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.1] text-sky-300 border border-slate-950/10 dark:border-white/[0.08]"
                  >
                    + Add {app.name}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="min-w-[650px]">
              {/* Table header with software names */}
              <div className="grid grid-cols-[160px_repeat(auto-fit,minmax(200px,1fr))] border-b border-slate-950/10 dark:border-white/[0.08] pb-4">
                <div className="text-xs font-mono uppercase tracking-wider text-slate-400 pt-2">
                  Application
                </div>
                {appsToCompare.map((app) => (
                  <div key={app.id} className="px-3">
                    <div className="flex items-center justify-between">
                      <h3 className="font-bold text-slate-100 text-base truncate">{app.name}</h3>
                      <button
                        type="button"
                        onClick={() => onRemoveAppFromCompare(app.id)}
                        className="text-slate-500 hover:text-rose-400 p-1"
                        title="Remove from comparison"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                    <p className="text-xs text-slate-400 line-clamp-1 mt-0.5">{app.tagline}</p>
                    <div className="flex items-center gap-1.5 mt-2">
                      <a
                        href={app.websiteUrl}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => { e.preventDefault(); void openExternal(app.websiteUrl); }}
                        className="text-[11px] text-sky-400 hover:underline inline-flex items-center gap-1"
                      >
                        <span>Website</span>
                        <ExternalLink className="w-3 h-3" />
                      </a>
                      <span className="text-slate-400">·</span>
                      <a
                        href={app.githubUrl}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => { e.preventDefault(); void openExternal(app.githubUrl); }}
                        className="text-[11px] text-slate-400 hover:text-slate-100 inline-flex items-center gap-1"
                      >
                        <span>GitHub</span>
                      </a>
                    </div>
                  </div>
                ))}
              </div>

              {/* Rows */}
              <div className="divide-y divide-slate-950/10 dark:divide-white/[0.06] text-xs">
                {/* Replaces proprietary */}
                <div className="grid grid-cols-[160px_repeat(auto-fit,minmax(200px,1fr))] py-3 items-center">
                  <div className="font-semibold text-slate-400">Replaces Proprietary</div>
                  {appsToCompare.map((app) => (
                    <div key={app.id} className="px-3">
                      {app.proprietaryAlternative ? (
                        <span className="inline-block px-2 py-0.5 rounded text-[11px] font-mono bg-amber-400/10 border border-amber-400/20 text-amber-300">
                          {app.proprietaryAlternative}
                        </span>
                      ) : (
                        <span className="text-slate-500">Universal Utility</span>
                      )}
                    </div>
                  ))}
                </div>

                {/* Category */}
                <div className="grid grid-cols-[160px_repeat(auto-fit,minmax(200px,1fr))] py-3 items-center">
                  <div className="font-semibold text-slate-400">Category</div>
                  {appsToCompare.map((app) => (
                    <div key={app.id} className="px-3 text-slate-200">
                      {app.category}
                    </div>
                  ))}
                </div>

                {/* License */}
                <div className="grid grid-cols-[160px_repeat(auto-fit,minmax(200px,1fr))] py-3 items-center">
                  <div className="font-semibold text-slate-400">License</div>
                  {appsToCompare.map((app) => (
                    <div key={app.id} className="px-3">
                      <span className="font-mono text-emerald-400">{app.license}</span>
                    </div>
                  ))}
                </div>

                {/* GitHub Stars */}
                <div className="grid grid-cols-[160px_repeat(auto-fit,minmax(200px,1fr))] py-3 items-center">
                  <div className="font-semibold text-slate-400">Community Stars</div>
                  {appsToCompare.map((app) => (
                    <div key={app.id} className="px-3 flex items-center gap-1.5 text-amber-300 font-mono">
                      {app.stars > 0 ? (
                        <>
                          <Star className="w-3.5 h-3.5 fill-current" />
                          <span>{app.stars.toLocaleString()}</span>
                        </>
                      ) : (
                        <span className="text-slate-500">—</span>
                      )}
                    </div>
                  ))}
                </div>

                {/* Platforms */}
                <div className="grid grid-cols-[160px_repeat(auto-fit,minmax(200px,1fr))] py-3 items-center">
                  <div className="font-semibold text-slate-400">Supported Platforms</div>
                  {appsToCompare.map((app) => (
                    <div key={app.id} className="px-3 flex flex-wrap gap-1">
                      {app.platforms.map((p) => (
                        <span key={p} className="px-1.5 py-0.5 rounded text-[11px] uppercase font-mono bg-slate-950/[0.05] dark:bg-white/[0.06] text-slate-300">
                          {p}
                        </span>
                      ))}
                    </div>
                  ))}
                </div>

                {/* Offline Ready */}
                <div className="grid grid-cols-[160px_repeat(auto-fit,minmax(200px,1fr))] py-3 items-center">
                  <div className="font-semibold text-slate-400">100% Offline Capable</div>
                  {appsToCompare.map((app) => (
                    <div key={app.id} className="px-3">
                      {app.offlineReady ? (
                        <span className="inline-flex items-center gap-1 text-emerald-400">
                          <Check className="w-4 h-4" />
                          <span>Local-First (No Cloud Lock-in)</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-slate-400">
                          <Minus className="w-4 h-4" />
                          <span>Network Dependant</span>
                        </span>
                      )}
                    </div>
                  ))}
                </div>

                {/* Portable Mode */}
                <div className="grid grid-cols-[160px_repeat(auto-fit,minmax(200px,1fr))] py-3 items-center">
                  <div className="font-semibold text-slate-400">Portable (Zero-Install)</div>
                  {appsToCompare.map((app) => (
                    <div key={app.id} className="px-3">
                      {app.isPortable ? (
                        <span className="text-emerald-400 font-mono text-[11px]">Yes (Standalone .zip/exe)</span>
                      ) : (
                        <span className="text-slate-500 font-mono text-[11px]">System Install Required</span>
                      )}
                    </div>
                  ))}
                </div>

                {/* Architectures */}
                <div className="grid grid-cols-[160px_repeat(auto-fit,minmax(200px,1fr))] py-3 items-center">
                  <div className="font-semibold text-slate-400">CPU Architectures</div>
                  {appsToCompare.map((app) => (
                    <div key={app.id} className="px-3 font-mono text-[11px] text-slate-300">
                      {app.architectures ? app.architectures.join(', ') : 'x86_64, arm64'}
                    </div>
                  ))}
                </div>

                {/* Beginner Curve */}
                <div className="grid grid-cols-[160px_repeat(auto-fit,minmax(200px,1fr))] py-3 items-center">
                  <div className="font-semibold text-slate-400">Learning Curve</div>
                  {appsToCompare.map((app) => (
                    <div key={app.id} className="px-3 text-slate-300">
                      {app.beginnerRating}
                    </div>
                  ))}
                </div>

                {/* Package Manager Command */}
                <div className="grid grid-cols-[160px_repeat(auto-fit,minmax(200px,1fr))] py-3 items-center">
                  <div className="font-semibold text-slate-400">Install Command</div>
                  {appsToCompare.map((app) => (
                    <div key={app.id} className="px-3">
                      <code className="text-[11px] font-mono text-sky-300 bg-black/40 px-2 py-1 rounded block truncate select-all">
                        {app.wingetCommand || app.brewCommand || 'Direct installer'}
                      </code>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer with add extra tool dropdown */}
        <div className="px-5 py-3 bg-slate-950 border-t border-slate-950/10 dark:border-white/[0.08] flex items-center justify-between">
          <div className="text-xs text-slate-400">
            Comparing {appsToCompare.length} application{appsToCompare.length !== 1 ? 's' : ''}.
          </div>
          {appsToCompare.length < 4 && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-400">Add to compare:</span>
              <select
                onChange={(e) => {
                  if (e.target.value) {
                    onAddAppToCompare(e.target.value);
                    e.target.value = '';
                  }
                }}
                className="bg-slate-950/[0.05] dark:bg-white/[0.06] border border-slate-950/10 dark:border-white/[0.1] text-xs text-slate-100 px-2 py-1 rounded focus:outline-none"
                defaultValue=""
              >
                <option value="" disabled>Select software...</option>
                {allApps
                  .filter((a) => !appsToCompare.some((c) => c.id === a.id))
                  .map((app) => (
                    <option key={app.id} value={app.id} className="bg-slate-900 text-slate-100">
                      {app.name} ({app.category})
                    </option>
                  ))}
              </select>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
