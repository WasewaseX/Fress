// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
// Localized command-palette search aliases: every supported language must
// be able to FIND each system action by a word in that language, and the
// matcher must stay plain-substring (no brittle stemming) and ignore
// single-character queries.

import { describe, expect, it } from 'vitest';

import { DICTS } from '../i18n';
import { aliasMatches } from '../../components/CommandPalette';

const LANGS = ['en', 'fa', 'es', 'fr', 'de'] as const;

/** One representative search word per action per language (keys = dict keys). */
const PROBES: Record<(typeof LANGS)[number], Record<string, string>> = {
  en: { 'palette.aliasBatch': 'batch', 'palette.aliasCompare': 'compare', 'palette.aliasExport': 'export', 'palette.aliasView': 'table' },
  fa: { 'palette.aliasBatch': 'اسکریپت', 'palette.aliasCompare': 'مقایسه', 'palette.aliasExport': 'خروجی', 'palette.aliasView': 'نمایش' },
  es: { 'palette.aliasBatch': 'lotes', 'palette.aliasCompare': 'comparar', 'palette.aliasExport': 'exportar', 'palette.aliasView': 'tabla' },
  fr: { 'palette.aliasBatch': 'lot', 'palette.aliasCompare': 'comparer', 'palette.aliasExport': 'exporter', 'palette.aliasView': 'tableau' },
  de: { 'palette.aliasBatch': 'stapel', 'palette.aliasCompare': 'vergleichen', 'palette.aliasExport': 'exportieren', 'palette.aliasView': 'raster' },
};

describe('aliasMatches', () => {
  it('matches case-insensitive substrings', () => {
    expect(aliasMatches('INST', 'batch install script generator')).toBe(true);
    expect(aliasMatches('  batch  ', 'batch install script generator')).toBe(true);
  });

  it('ignores single-character queries (they would flood the list)', () => {
    expect(aliasMatches('a', 'batch install script generator')).toBe(false);
    expect(aliasMatches('', 'batch install script generator')).toBe(false);
  });

  it('does not match unrelated words', () => {
    expect(aliasMatches('zzzz', 'compare side by side matrix')).toBe(false);
  });
});

describe('localized action discovery', () => {
  for (const lang of LANGS) {
    it(`${lang}: every action is findable by a ${lang} search word`, () => {
      for (const [aliasKey, probe] of Object.entries(PROBES[lang])) {
        const aliases = DICTS[lang][aliasKey];
        expect(aliases.trim().length, `${lang}.${aliasKey}`).toBeGreaterThan(0);
        expect(aliasMatches(probe, aliases), `${lang} "${probe}" should hit ${aliasKey}`).toBe(true);
      }
    });

    it(`${lang}: probes stay inside their own action`, () => {
      for (const [aliasKey, probe] of Object.entries(PROBES[lang])) {
        for (const otherKey of Object.keys(PROBES[lang])) {
          if (otherKey === aliasKey) continue;
          expect(aliasMatches(probe, DICTS[lang][otherKey]), `${lang} "${probe}" leaked into ${otherKey}`).toBe(
            false
          );
        }
      }
    });
  }

  it('the pre-localization English keywords still match through the en aliases', () => {
    // The original predicates matched: batch/install/script, compare/matrix,
    // export/readme, switch/toggle/view.
    expect(aliasMatches('install', DICTS.en['palette.aliasBatch'])).toBe(true);
    expect(aliasMatches('matrix', DICTS.en['palette.aliasCompare'])).toBe(true);
    expect(aliasMatches('readme', DICTS.en['palette.aliasExport'])).toBe(true);
    expect(aliasMatches('toggle', DICTS.en['palette.aliasView'])).toBe(true);
  });
});
