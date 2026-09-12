import React from 'react';
import { Award, Flame, Search } from 'lucide-react';
import { useI18n } from '../lib/i18n';

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
  totalApps,
  androidCount,
}) => {
  const { t } = useI18n();

  return (
    <section id="spotlight-section" className="bg-slate-950 border-b border-slate-950/10 dark:border-white/[0.08] py-6 px-4 sm:px-6">
      <div className="max-w-7xl mx-auto flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 sm:gap-6">

        {/* Hero: the one place we raise our voice */}
        <div className="min-w-0">
          <h1 id="spotlight-main-heading" className="text-[32px] sm:text-[40px] font-extrabold text-slate-100 tracking-tight leading-[1.1]">
            {t('hero.title')}
          </h1>
          <p id="spotlight-main-desc" className="text-[15px] text-slate-400 mt-2.5 leading-relaxed max-w-2xl">
            {t('hero.subtitle')}
          </p>
          <p id="spotlight-stat-line" className="text-xs text-slate-500 dark:text-slate-400 mt-2">
            {t('hero.statLine')
              .replace('{total}', String(totalApps))
              .replace('{android}', String(androidCount))}
          </p>
        </div>

        {/* Curated browsing is the product; raw GitHub search is the fallback */}
        <div id="spotlight-quick-actions" className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={onSelectOwnerPicks}
            className="inline-flex items-center gap-1.5 bg-sky-600 hover:bg-sky-500 text-white text-sm font-semibold px-4 py-2.5 rounded-lg border border-sky-500 transition-colors shadow-xs"
          >
            <Award className="w-4 h-4 text-sky-100" aria-hidden="true" />
            <span>{t('hero.browsePicks')}</span>
          </button>
          <button
            type="button"
            onClick={onSelectTrending}
            className="inline-flex items-center gap-1.5 bg-slate-950/[0.05] dark:bg-white/[0.06] hover:bg-slate-950/[0.08] dark:hover:bg-white/[0.1] text-slate-200 text-sm font-semibold px-4 py-2.5 rounded-lg border border-slate-950/10 dark:border-white/[0.1] transition-colors"
          >
            <Flame className="w-4 h-4 text-amber-400" aria-hidden="true" />
            <span>{t('hero.trending')}</span>
          </button>
          <button
            type="button"
            onClick={onOpenLiveSearch}
            className="inline-flex items-center gap-1.5 text-slate-400 hover:text-slate-200 text-xs font-medium px-3 py-2 rounded-lg hover:bg-slate-950/[0.05] dark:hover:bg-white/[0.05] transition-colors"
            title={t('header.liveSearch')}
          >
            <Search className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{t('hero.searchGithub')}</span>
          </button>
        </div>

      </div>
    </section>
  );
};
