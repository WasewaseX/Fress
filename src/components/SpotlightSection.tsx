import React from 'react';
import { Sparkles, Flame, Award } from 'lucide-react';

interface SpotlightSectionProps {
  onSelectTrending: () => void;
  onSelectOwnerPicks: () => void;
  onOpenLiveSearch: () => void;
  totalApps: number;
  androidCount: number;
}

export const SpotlightSection: React.FC<SpotlightSectionProps> = ({
  onSelectTrending,
  onSelectOwnerPicks,
  onOpenLiveSearch,
  totalApps
}) => {
  return (
    <section id="spotlight-section" className="bg-slate-950 border-b border-slate-950/10 dark:border-white/[0.08] py-4 px-4 sm:px-6">
      <div className="max-w-7xl mx-auto flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-6">
        
        {/* Clean, authentic title and description without AI buzzwords */}
        <div className="min-w-0">
          <h1 id="spotlight-main-heading" className="text-sm sm:text-base font-semibold text-slate-100 tracking-tight">
            Free & Open-Source Software Directory
          </h1>
          <p id="spotlight-main-desc" className="text-xs text-slate-400 mt-0.5 leading-relaxed">
            Curated desktop and mobile alternatives with copyable install commands for Winget, Homebrew, Flatpak, and F-Droid.
          </p>
        </div>

        {/* Action buttons with consistent 2:1 padding and clear layout */}
        <div id="spotlight-quick-actions" className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={onOpenLiveSearch}
            className="inline-flex items-center gap-1.5 bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold px-3 py-1.5 rounded-lg border border-sky-400 transition-colors shadow-xs"
          >
            <Sparkles className="w-3.5 h-3.5 text-sky-200" aria-hidden="true" />
            <span>Search GitHub Live</span>
          </button>

          <button
            type="button"
            onClick={onSelectTrending}
            className="inline-flex items-center gap-1.5 bg-slate-950/[0.04] dark:bg-white/[0.04] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.08] text-slate-300 hover:text-slate-100 text-xs font-medium px-3 py-1.5 rounded-lg border border-slate-950/10 dark:border-white/[0.08] transition-colors"
          >
            <Flame className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
            <span>Trending</span>
          </button>

          <button
            type="button"
            onClick={onSelectOwnerPicks}
            className="inline-flex items-center gap-1.5 bg-slate-950/[0.04] dark:bg-white/[0.04] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.08] text-slate-300 hover:text-slate-100 text-xs font-medium px-3 py-1.5 rounded-lg border border-slate-950/10 dark:border-white/[0.08] transition-colors"
          >
            <Award className="w-3.5 h-3.5 text-amber-400" aria-hidden="true" />
            <span>Curated Picks</span>
          </button>
        </div>

      </div>
    </section>
  );
};
