// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import React from 'react';
import { Smartphone } from 'lucide-react';
import { useI18n } from '../lib/i18n';

interface SpotlightSectionProps {
  /** Total apps in the catalog (unfiltered). */
  totalApps: number;
  /** How many of them ship Android builds. */
  androidCount: number;
}

/**
 * Hero. States what Fress is in one heading + one honest sentence, then a
 * compact, real catalog summary. It intentionally has no filter buttons:
 * Trending and Owner Picks stay shortcuts in the filter bar, so the hero
 * never pushes the first row of apps below the fold.
 */
export const SpotlightSection: React.FC<SpotlightSectionProps> = ({ totalApps, androidCount }) => {
  const { t } = useI18n();

  return (
    <section
      id="spotlight-section"
      /* Phones: the platform chip bar is fixed directly under the header and
         overlays the top of this section, so the hero clears it with its own
         top padding. Desktop has no fixed bar and keeps the compact rhythm. */
      className="bg-fr-bg border-b border-fr-border py-5 max-md:pt-12 px-4 sm:px-6"
    >
      <div className="max-w-7xl mx-auto">
        <div className="min-w-0">
          <h1
            id="spotlight-main-heading"
            className="text-[28px] sm:text-[36px] font-extrabold text-fr-text tracking-tight leading-[1.1]"
          >
            {t('hero.title')}
          </h1>
          <p
            id="spotlight-main-desc"
            className="text-[15px] text-fr-text-muted mt-2 leading-relaxed max-w-2xl"
          >
            {t('hero.subtitle')}
          </p>

          {/* Real, live catalog numbers - small, quiet, never a second nav */}
          <p id="spotlight-stats" className="mt-3 flex flex-wrap items-center gap-2 text-xs text-fr-text-muted">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-fr-border bg-fr-surface px-2.5 py-1">
              <span className="font-bold text-fr-text tabular-nums">{totalApps}</span>
              {t('hero.countApps')}
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-fr-border bg-fr-surface px-2.5 py-1">
              <Smartphone className="w-3.5 h-3.5" aria-hidden="true" />
              <span className="font-bold text-fr-text tabular-nums">{androidCount}</span>
              {t('hero.countAndroid')}
            </span>
          </p>
        </div>
      </div>
    </section>
  );
};
