// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
// @vitest-environment jsdom
//
// The data-DEFAULT fallbacks that AddAppModal and LiveSearchModal write
// into AppItem entries ("Open Source", the placeholder sentences) are
// English display copy stored as data. They must translate at READ time
// (appText.ts / LICENSE_DISPLAY_KEYS) without touching the stored data,
// while real user-typed copy and SPDX license ids pass through untouched.

import React from 'react';
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { AppItem } from '../../types';
import { DICTS, I18nProvider, Language, translateLicenseDisplay } from '../i18n';
import { translateAppTextDefault, useAppText } from '../appText';

afterEach(() => {
  window.localStorage.clear();
});

function makeApp(fields: Partial<AppItem> = {}): AppItem {
  return {
    id: 'custom-test-app',
    name: 'Test App',
    tagline: 'A real tagline the user typed',
    description: 'A real description',
    whyItsAwesome: 'A real highlight',
    beginnerGuide: 'A real guide',
    githubUrl: 'https://github.com/example/test-app',
    websiteUrl: 'https://example.com',
    category: 'Utilities & System',
    platforms: ['windows'],
    license: 'MIT',
    stars: 0,
    isOwnerPick: false,
    isTrendingToday: false,
    tags: [],
    addedAt: '2026-01-01',
    ...fields,
  };
}

/** Wrapper that pins the provider's language through its storage key. */
function withLang(lang: Language): React.FC<{ children?: React.ReactNode }> {
  return ({ children }) => {
    window.localStorage.setItem('fress.lang', lang);
    return <I18nProvider>{children}</I18nProvider>;
  };
}

describe('useAppText translates known data defaults', () => {
  it('keeps real user copy unchanged under en', () => {
    const app = makeApp();
    const { result } = renderHook(() => useAppText(app), { wrapper: withLang('en') });
    expect(result.current.whyItsAwesome).toBe('A real highlight');
  });

  it('translates the AddAppModal defaults under fa', () => {
    const app = makeApp({
      tagline: '',
      description: '',
      whyItsAwesome: 'Curated community open-source application.',
      beginnerGuide: 'Download and install from the official release page.',
    });
    const { result } = renderHook(() => useAppText(app), { wrapper: withLang('fa') });
    expect(result.current.whyItsAwesome).toBe('برنامه متن‌باز جامعه‌محور برگزیده.');
    expect(result.current.beginnerGuide).toBe('دریافت و نصب از صفحه انتشار رسمی.');
  });

  it('translates the LiveSearchModal defaults under de, stars number included', () => {
    const app = makeApp({
      tagline: 'Open-source application',
      description: 'Community open-source repository.',
      whyItsAwesome: 'Community-backed open-source project with 1,234 stars on GitHub.',
      beginnerGuide: 'Visit the GitHub project page for release downloads and setup instructions.',
    });
    const { result } = renderHook(() => useAppText(app), { wrapper: withLang('de') });
    expect(result.current.tagline).toBe('Open-Source-Anwendung');
    expect(result.current.description).toBe('Community-Open-Source-Repository.');
    // The star count itself is data and survives into the German sentence.
    expect(result.current.whyItsAwesome).toContain('1,234');
    expect(result.current.whyItsAwesome).toContain('Sternen auf GitHub');
    expect(result.current.whyItsAwesome.startsWith('Von der Community getragenes')).toBe(true);
    expect(result.current.beginnerGuide).toBe('Besuchen Sie die Projektseite auf GitHub für Release-Downloads und Installationsanleitungen.');
  });

  it('never translates copy the user actually typed', () => {
    const app = makeApp();
    const { result } = renderHook(() => useAppText(app), { wrapper: withLang('es') });
    expect(result.current.whyItsAwesome).toBe('A real highlight');
    expect(result.current.tagline).toBe('A real tagline the user typed');
    expect(result.current.description).toBe('A real description');
  });
});

describe('translateAppTextDefault (standalone, for map-rendered rows)', () => {
  const t = (key: string) => `T:${key}`;

  it('translates defaults and passes everything else through', () => {
    expect(translateAppTextDefault(t, 'Open-source application')).toBe('T:search.defaultTagline');
    expect(translateAppTextDefault(t, 'Community open-source repository.')).toBe('T:search.defaultDescription');
    expect(translateAppTextDefault(t, 'A real user sentence.')).toBe('A real user sentence.');
  });

  it('moves the captured star count into the translated template', () => {
    // Real dictionary value: the German template carries {stars}.
    const t = (key: string) => DICTS.de[key] ?? key;
    const expected = DICTS.de['search.defaultWhy'].replace('{stars}', '42');
    const out = translateAppTextDefault(t, 'Community-backed open-source project with 42 stars on GitHub.');
    expect(out).toBe(expected);
    expect(out).toContain('42');
  });
});

describe('translateLicenseDisplay', () => {
  const t = (key: string) => `T:${key}`;

  it('translates the English-phrase license values, not SPDX ids', () => {
    expect(translateLicenseDisplay(t, 'Open Source')).toBe('T:license.openSource');
    expect(translateLicenseDisplay(t, 'Free for Personal Use')).toBe('T:license.freePersonal');
    expect(translateLicenseDisplay(t, 'Source-available')).toBe('T:license.sourceAvailable');
    // SPDX proper nouns pass through untouched.
    expect(translateLicenseDisplay(t, 'MIT')).toBe('MIT');
    expect(translateLicenseDisplay(t, 'GPL-3.0')).toBe('GPL-3.0');
    expect(translateLicenseDisplay(t, 'Apache-2.0')).toBe('Apache-2.0');
    expect(translateLicenseDisplay(t, 'GNU LGPL')).toBe('GNU LGPL');
  });
});
