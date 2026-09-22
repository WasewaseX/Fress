// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import React from 'react';
import { useI18n } from '../lib/i18n';

interface SpotlightSectionProps {
  onSelectTrending: () => void;
  onSelectOwnerPicks: () => void;
  totalApps: number;
  androidCount: number;
}

export const SpotlightSection: React.FC<SpotlightSectionProps> = () => {
  const { t } = useI18n();

  return (
    <section id="spotlight-section" className="bg-slate-950 border-b border-slate-950/10 dark:border-white/[0.08] py-6 px-4 sm:px-6">
      <div className="max-w-7xl mx-auto">
        {/* Hero: title and one honest sentence. Actions live in the header and filter bar. */}
        <div className="min-w-0">
          <h1 id="spotlight-main-heading" className="text-[30px] sm:text-[38px] font-extrabold text-slate-100 tracking-tight leading-[1.1]">
            {t('hero.title')}
          </h1>
          <p id="spotlight-main-desc" className="text-[15px] text-slate-400 mt-2.5 leading-relaxed max-w-2xl">
            {t('hero.subtitle')}
          </p>
        </div>
      </div>
    </section>
  );
};
