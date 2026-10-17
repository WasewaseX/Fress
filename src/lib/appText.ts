// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { useMemo } from 'react';
import { AppItem } from '../types';
import { APP_DESCRIPTIONS, LocalizedAppText } from '../data/appDescriptions';
import { formatMessage, useI18n } from './i18n';

export interface AppText {
  tagline: string;
  description: string;
  whyItsAwesome: string;
  beginnerGuide: string;
}

const EN_FALLBACK = (app: AppItem): AppText => ({
  tagline: app.tagline,
  description: app.description,
  whyItsAwesome: app.whyItsAwesome,
  beginnerGuide: app.beginnerGuide || '',
});

/**
 * Known data-DEFAULT strings that AddAppModal and LiveSearchModal write
 * into AppItem entries when the user left a field blank. They are English
 * display copy stored as data (the stored string is the identifier of
 * "nothing was entered"), so they translate at READ time here - one place,
 * covering every consumer (detail modal, cards, table, live search).
 * A real description the user typed is never in this table and passes
 * through untouched, as does any translated copy from APP_DESCRIPTIONS
 * that happens to differ from the defaults.
 */
const DEFAULT_TEXT_KEYS: Array<{ match: RegExp; key: string }> = [
  { match: /^Curated community open-source application\.$/, key: 'app.defaultWhy' },
  { match: /^Download and install from the official release page\.$/, key: 'app.defaultGuide' },
  { match: /^Open-source application$/, key: 'search.defaultTagline' },
  { match: /^Community open-source repository\.$/, key: 'search.defaultDescription' },
  // The live-search highlight is generated with the star count embedded;
  // the number itself is data and moves into the translated sentence.
  { match: /^Community-backed open-source project with ([\d.,]+) stars on GitHub\.$/, key: 'search.defaultWhy' },
  { match: /^Visit the GitHub project page for release downloads and setup instructions\.$/, key: 'search.defaultGuide' },
];

/** Translate one known default string; anything else passes through. */
function translateDefault(t: (key: string) => string, text: string): string {
  for (const { match, key } of DEFAULT_TEXT_KEYS) {
    const m = match.exec(text);
    if (m) {
      const translated = t(key);
      // Only the stars template carries a capture group; the shared
      // split/join formatter inserts it literally (the captured value is
      // digits/punctuation today, and the primitive keeps it that way by
      // construction even if the pattern ever widens).
      return m[1] !== undefined ? formatMessage(translated, { stars: m[1] }) : translated;
    }
  }
  return text;
}

/**
 * Standalone form of the default-translation for callers that translate
 * INSIDE a .map() (the live-search result rows) and therefore cannot call
 * the useAppText hook per item. Same table, same behaviour.
 */
export function translateAppTextDefault(t: (key: string) => string, text: string): string {
  return translateDefault(t, text);
}

/**
 * Catalog copy in the reader's language. Falls back to the English source
 * for anything not translated yet (custom apps, missing fields) - except
 * for the known generated defaults, which translate so a Farsi reader's
 * self-added app never shows an English placeholder sentence.
 */
export function useAppText(app: AppItem | null): AppText {
  const { lang, t } = useI18n();
  return useMemo(() => {
    if (!app) return { tagline: '', description: '', whyItsAwesome: '', beginnerGuide: '' };
    if (lang === 'en') return EN_FALLBACK(app);
    const loc: LocalizedAppText | undefined = APP_DESCRIPTIONS[app.id]?.[lang];
    if (!loc) {
      // No curated translation: real user copy stays as written, known
      // generated defaults translate.
      return {
        tagline: translateDefault(t, app.tagline),
        description: translateDefault(t, app.description),
        whyItsAwesome: translateDefault(t, app.whyItsAwesome),
        beginnerGuide: translateDefault(t, app.beginnerGuide || ''),
      };
    }
    return {
      tagline: loc.tagline || translateDefault(t, app.tagline),
      description: loc.description || translateDefault(t, app.description),
      whyItsAwesome: loc.whyItsAwesome || translateDefault(t, app.whyItsAwesome),
      beginnerGuide: loc.beginnerGuide || translateDefault(t, app.beginnerGuide || ''),
    };
  }, [app, lang, t]);
}
