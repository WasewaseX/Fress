// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { describe, expect, it } from 'vitest';

import { DICTS } from '../i18n';

const LANGS = ['en', 'fa', 'es', 'fr', 'de'] as const;
const enKeys = Object.keys(DICTS.en).sort();

/**
 * Keys whose translation is ALLOWED to be byte-identical to the English
 * source. Every entry here is either a proper noun, a product name, a
 * package-manager label, or a word that genuinely is the same word in that
 * language. Anything NOT in this list that a future change copies straight
 * from English fails CI - the whole point of the coverage gate is that
 * "paste the en string into the other dict" is a conscious, reviewed
 * decision, never a shortcut.
 */
const IDENTICAL_TO_EN_ALLOWLIST: Record<(typeof LANGS)[number], ReadonlySet<string>> = {
  en: new Set<string>(),
  fa: new Set([
    'downloads.hash',
    'detail.googlePlay',
    'detail.fdroid',
    'bs.tab.brewfile',
    'common.platform.windows',
    'common.platform.mac',
    'common.platform.linux',
    'common.platform.android',
    'common.platform.ios',
    // Product/technology badge: Tauri, Rust and the version are proper names.
    'tauri.badgeStack',
    // International technical abbreviations: used as-is in Persian tech text.
    'pp.cat.vpn',
    'pp.cat.dns',
  ]),
  es: new Set([
    'card.portable',
    'downloads.hash',
    'common.beta',
    'detail.googlePlay',
    'detail.fdroid',
    'bar.script',
    'bs.tab.wingetPs',
    'bs.tab.brew',
    'bs.tab.brewfile',
    'bs.tab.flatpak',
    'bs.tab.scoop',
    'bs.tab.apt',
    'header.tabApps',
    'palette.vs',
    'detail.resolver.wingetLabel',
    'detail.resolver.brewLabel',
    'detail.resolver.flatpakLabel',
    'common.platform.windows',
    'common.platform.mac',
    'common.platform.linux',
    'common.platform.android',
    'common.platform.web',
    'common.platform.ios',
    // "vs" is the standard comparison marker in Spanish tables and headings.
    'table.vs',
    // Product/technology badge: Tauri, Rust and the version are proper names.
    'tauri.badgeStack',
    // International technical abbreviations: used as-is in Spanish tech text.
    'pp.cat.twofa',
    'pp.cat.vpn',
    'pp.cat.dns',
  ]),
  fr: new Set([
    'card.guide',
    'card.portable',
    'downloads.hash',
    'detail.googlePlay',
    'detail.fdroid',
    'bar.script',
    'bs.tab.wingetPs',
    'bs.tab.brew',
    'bs.tab.brewfile',
    'bs.tab.flatpak',
    'bs.tab.scoop',
    'bs.tab.apt',
    'palette.actionBadge',
    'palette.vs',
    'detail.resolver.wingetLabel',
    'detail.resolver.brewLabel',
    'detail.resolver.flatpakLabel',
    'common.platform.windows',
    'common.platform.mac',
    'common.platform.linux',
    'common.platform.android',
    'common.platform.web',
    'common.platform.ios',
    'header.section',
    // "Actions" is the standard French noun for a column of action buttons.
    'table.head.actions',
    // "vs" is the standard comparison marker in French tables and headings.
    'table.vs',
    // Product/technology badge: Tauri, Rust and the version are proper names.
    'tauri.badgeStack',
    // "Description" is the same word in French.
    'add.descriptionLabel',
    // "Photos", "Notes", "Contacts" are genuine French cognates (same
    // spelling, same meaning) for the Privacy-Pack category names.
    'pp.cat.photos',
    'pp.cat.notes',
    'pp.cat.contacts',
    // International technical abbreviations: used as-is in French tech text.
    'pp.cat.twofa',
    'pp.cat.vpn',
    'pp.cat.dns',
    // "Open Source" is the standard French term for the license class
    // (used as-is in French software writing, e.g. Wikipedia FR).
    'license.openSource',
  ]),
  de: new Set([
    'header.downloads',
    'filter.sortName',
    'card.details',
    'downloads.title',
    'downloads.hash',
    'detail.googlePlay',
    'detail.fdroid',
    'bs.tab.wingetPs',
    'bs.tab.brew',
    'bs.tab.brewfile',
    'bs.tab.flatpak',
    'bs.tab.scoop',
    'bs.tab.apt',
    'header.tabApps',
    'detail.resolver.wingetLabel',
    'detail.resolver.brewLabel',
    'detail.resolver.flatpakLabel',
    'downloads.a11y.summary',
    'downloads.a11y.summaryEmpty',
    'common.platform.windows',
    'common.platform.mac',
    'common.platform.linux',
    'common.platform.android',
    'common.platform.web',
    'common.platform.ios',
    'menu.updates',
    // "App" is the standard German word for a software application (Duden).
    'table.head.app',
    // "Trend" is the standard German word for a popularity ranking (Duden).
    'table.trend',
    // "Website" is the standard German word for a site (Duden loanword).
    'common.websiteShort',
    // Product/technology badge: Tauri, Rust and the version are proper names.
    'tauri.badgeStack',
    // "Highlight" is the standard German loanword for a feature highlight (Duden).
    'add.highlightLabel',
    // "Browser", "Smart Home" and "Community" are standard German loanwords
    // for these Privacy-Pack categories (Duden); "2FA", "VPN", "DNS" are
    // international technical abbreviations used as-is in German tech text.
    'pp.cat.browser',
    'pp.cat.smarthome',
    'pp.cat.community',
    'pp.cat.twofa',
    'pp.cat.vpn',
    'pp.cat.dns',
    // "Open Source" is the standard German loanword for the license class
    // (Duden lists it; used as-is in German software writing).
    'license.openSource',
  ]),
};

describe('i18n dictionary parity', () => {
  it('exposes DICTS with exactly the five supported languages', () => {
    expect(Object.keys(DICTS).sort()).toEqual([...LANGS].sort());
  });

  for (const lang of LANGS.filter((l) => l !== 'en')) {
    it(`${lang} has exactly the same key set as en (no missing, no extra)`, () => {
      const keys = Object.keys(DICTS[lang]).sort();
      const missing = enKeys.filter((k) => !keys.includes(k));
      const extra = keys.filter((k) => !enKeys.includes(k));
      expect(missing, `${lang} is missing keys`).toEqual([]);
      expect(extra, `${lang} has extra keys`).toEqual([]);
    });
  }

  it('every entry in every dict is a string', () => {
    for (const lang of LANGS) {
      for (const [key, value] of Object.entries(DICTS[lang])) {
        expect(typeof value, `${lang}.${key}`).toBe('string');
      }
    }
  });

  // Replacement contract: whatever {placeholder} the English source carries
  // must survive in every translation, or .replace('{x}', v) silently no-ops.
  const tokenRe = /\{[a-z]+\}/g;
  for (const lang of LANGS.filter((l) => l !== 'en')) {
    it(`${lang} keeps every {placeholder} token from the en source`, () => {
      for (const [key, enValue] of Object.entries(DICTS.en)) {
        for (const token of enValue.match(tokenRe) ?? []) {
          expect(DICTS[lang][key], `${lang}.${key} dropped ${token}`).toContain(token);
        }
      }
    });
  }

  // Translation coverage: a non-empty English source string must not be
  // copied verbatim into another dictionary unless the pair is explicitly
  // allowlisted above. New verbatim copies fail CI and must either be
  // translated or consciously added to the allowlist with a reason.
  describe('translation coverage (no English passthrough)', () => {
    for (const lang of LANGS.filter((l) => l !== 'en')) {
      it(`${lang} translates every non-allowlisted key`, () => {
        const copied: string[] = [];
        for (const [key, enValue] of Object.entries(DICTS.en)) {
          if (enValue.trim() === '') continue; // empty source: nothing to say
          if (DICTS[lang][key] === enValue && !IDENTICAL_TO_EN_ALLOWLIST[lang].has(key)) {
            copied.push(key);
          }
        }
        expect(
          copied,
          `${lang} copies these keys verbatim from en - translate them or allowlist them with a reason`
        ).toEqual([]);
      });

      it(`${lang} never leaves a translation empty when en has content`, () => {
        for (const [key, enValue] of Object.entries(DICTS.en)) {
          if (enValue.trim() === '') continue;
          expect(DICTS[lang][key].trim().length, `${lang}.${key} is empty`).toBeGreaterThan(0);
        }
      });
    }
  });

  // The command palette's localized search aliases must stay usable: each
  // action needs several alias phrases, and none may carry placeholders
  // (alias matching is plain substring work, not interpolation).
  describe('palette search aliases', () => {
    const ALIAS_KEYS = [
      'palette.aliasBatch',
      'palette.aliasCompare',
      'palette.aliasExport',
      'palette.aliasView',
    ];
    for (const lang of LANGS) {
      it(`${lang} provides multi-phrase, placeholder-free aliases`, () => {
        for (const key of ALIAS_KEYS) {
          const value = DICTS[lang][key];
          expect(value.trim().length, `${lang}.${key} is empty`).toBeGreaterThan(0);
          expect(value.split(/\s+/).length, `${lang}.${key} needs several alias words`).toBeGreaterThanOrEqual(3);
          expect(value, `${lang}.${key} must not contain {placeholders}`).not.toMatch(/\{[a-z]+\}/);
        }
      });
    }
  });
});
