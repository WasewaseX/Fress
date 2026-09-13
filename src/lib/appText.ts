import { useMemo } from 'react';
import { AppItem } from '../types';
import { APP_DESCRIPTIONS, LocalizedAppText } from '../data/appDescriptions';
import { useI18n } from './i18n';

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
 * Catalog copy in the reader's language. Falls back to the English source
 * for anything not translated yet (custom apps, missing fields).
 */
export function useAppText(app: AppItem | null): AppText {
  const { lang } = useI18n();
  return useMemo(() => {
    if (!app) return { tagline: '', description: '', whyItsAwesome: '', beginnerGuide: '' };
    if (lang === 'en') return EN_FALLBACK(app);
    const loc: LocalizedAppText | undefined = APP_DESCRIPTIONS[app.id]?.[lang];
    if (!loc) return EN_FALLBACK(app);
    return {
      tagline: loc.tagline || app.tagline,
      description: loc.description || app.description,
      whyItsAwesome: loc.whyItsAwesome || app.whyItsAwesome,
      beginnerGuide: loc.beginnerGuide || app.beginnerGuide || '',
    };
  }, [app, lang]);
}
