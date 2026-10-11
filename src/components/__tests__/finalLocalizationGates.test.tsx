// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
// @vitest-environment jsdom
//
// Final localization gates for the strings this round found still rendering
// in English inside owned surfaces:
//  - Privacy-Pack category names (data strings) resolve through the ONE
//    shared PP_CATEGORY_I18N_KEYS mapping in every language;
//  - the rendered maximum-privacy combo's name/purpose come from the
//    dictionary, not the English data;
//  - the detail dialog translates its category badge, the generic
//    download-option labels, product-pattern labels and the
//    platform-unavailable note at render time (the data files stay
//    untouched - labels remain their identifiers);
//  - the add/edit form consumes the existing add.highlightLabel key instead
//    of a hardcoded label.

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider, DICTS, PP_CATEGORY_I18N_KEYS } from '../../lib/i18n';
import { PRIVACY_PACK } from '../../data/privacyPack';
import { COMBOS } from '../../data/combos';
import { ReplaceTab } from '../ReplaceTab';
import { AppDetailModal } from '../AppDetailModal';
import { AddAppModal } from '../AddAppModal';
import { AppItem } from '../../types';
import { DownloadOption } from '../../lib/appDownloads';

vi.mock('../AppCard', () => ({
  AppIcon: () => <span data-testid="app-icon" />,
}));

vi.mock('../Header', () => ({
  BrandMark: () => <span data-testid="brand" />,
}));

vi.mock('../../lib/releaseFetch', () => ({
  resolveGitHubDownload: vi.fn(() => Promise.resolve(null)),
  resolveFdroidDownload: vi.fn(() => Promise.resolve(null)),
  parseGithubRepo: vi.fn(() => null),
  fdroidPageUrl: vi.fn((id: string) => `https://f-droid.org/packages/${id}/`),
  playStoreUrl: vi.fn((id: string) => `https://play.google.com/store/apps/details?id=${id}`),
  githubFetchSupported: vi.fn(() => true),
  peekResolveError: vi.fn(() => null),
}));

vi.mock('../../lib/officialResolvers', () => ({
  officialSupported: vi.fn(() => false),
  resolveOfficialDownload: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('../../lib/resolveRetry', () => ({
  resolverRetry: {
    retryGitHubResolve: vi.fn(() => Promise.resolve(null)),
    retryFdroidResolve: vi.fn(() => Promise.resolve(null)),
    retryOfficialResolve: vi.fn(() => Promise.resolve(null)),
  },
}));

vi.mock('../../lib/downloads', () => ({
  useDownloadActions: () => ({
    startDownload: vi.fn(),
    recordExternalOpen: vi.fn(),
  }),
  formatBytes: (n: number) => `${n} B`,
}));

vi.mock('../../lib/starFetch', () => ({
  useLiveStars: () => null,
}));

vi.mock('../../lib/external', () => ({
  openExternal: vi.fn(),
}));

// getDownloadOptions stays callable as the real implementation by default,
// individual tests override it to inject data labels (product patterns).
vi.mock('../../lib/appDownloads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/appDownloads')>();
  return {
    ...actual,
    getDownloadOptions: vi.fn((...args: Parameters<typeof actual.getDownloadOptions>) =>
      actual.getDownloadOptions(...args)
    ),
  };
});

import { getDownloadOptions } from '../../lib/appDownloads';

const APP: AppItem = {
  id: 'ente-auth',
  name: 'Ente Auth',
  tagline: 'Authenticator',
  description: 'An authenticator app.',
  whyItsAwesome: 'Open source.',
  beginnerGuide: 'Download it.',
  githubUrl: 'https://github.com/ente-io/ente',
  websiteUrl: 'https://ente.io',
  category: 'Utilities & System',
  platforms: ['windows'],
  license: 'MIT',
  stars: 0,
  tags: [],
  beginnerRating: 'Quick Learning Curve',
} as unknown as AppItem;

function setLang(lang: string) {
  localStorage.setItem('fress.lang', lang);
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline (test)'))));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  vi.mocked(getDownloadOptions).mockReset();
  document.documentElement.lang = '';
  document.documentElement.dir = '';
});

describe('privacy pack category names share one mapping', () => {
  it('every PRIVACY_PACK category name has a mapping whose key exists in all five dictionaries', () => {
    const names = PRIVACY_PACK.map((c) => c.name);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const key = PP_CATEGORY_I18N_KEYS[name];
      expect(key, `PRIVACY_PACK name "${name}" has no PP_CATEGORY_I18N_KEYS entry`).toBeTruthy();
      for (const lang of ['en', 'fa', 'es', 'fr', 'de'] as const) {
        const value = DICTS[lang][key as string];
        expect(value, `${lang}.${key} (category "${name}") is missing`).toBeTruthy();
        expect(value.trim().length, `${lang}.${key} is empty`).toBeGreaterThan(0);
      }
    }
    // And the mapping does not drift: every entry points at a real pp.cat.* key.
    for (const key of Object.values(PP_CATEGORY_I18N_KEYS)) {
      expect(key.startsWith('pp.cat.'), `${key} is not a pp.cat.* key`).toBe(true);
    }
  });

  it('the rendered maximum-privacy combo still exists and its copy is dictionary-driven', () => {
    // The component looks this combo up by id; if the id drifts the card
    // silently disappears - pin it here.
    expect(COMBOS.some((c) => c.id === 'maximum-privacy')).toBe(true);
  });

  it('ReplaceTab renders translated category names, combo name and purpose in German', () => {
    setLang('de');
    render(
      <I18nProvider>
        <ReplaceTab apps={[]} onOpenDetail={() => {}} onAddToBatch={() => {}} onRemoveFromBatch={() => {}} />
      </I18nProvider>
    );
    // A spread of German category headings across the whole set.
    expect(screen.getByText('E-Mail')).toBeTruthy();
    expect(screen.getByText('Nachrichten')).toBeTruthy();
    expect(screen.getByText('Passwort-Manager')).toBeTruthy();
    expect(screen.getByText('Cloud-Speicher')).toBeTruthy();
    expect(screen.getByText('Videokonferenzen')).toBeTruthy();
    expect(screen.getByText('Domain-Hosting')).toBeTruthy();
    // Combo card copy comes from the dictionary.
    expect(screen.getByText('Maximale Privatsphäre')).toBeTruthy();
    expect(screen.getByText('Der kompromisslose Weg: die stärkste Wahl für jeden ersetzbaren Typ.')).toBeTruthy();
    // No English data passthrough on the rendered surfaces.
    expect(document.body.textContent).not.toContain('Password Managers');
    expect(document.body.textContent).not.toContain('Video Conferencing');
    expect(document.body.textContent).not.toContain('Domain Hosting');
    expect(document.body.textContent).not.toContain('Maximum privacy');
    // ARIA labels follow the same mapping (article + dropdown triggers).
    const card = document.getElementById('pp-card-messaging') as HTMLElement | null;
    expect(card?.getAttribute('aria-label')).toBe('Nachrichten');
  });

  it('ReplaceTab renders Persian category names (RTL spot check)', () => {
    setLang('fa');
    render(
      <I18nProvider>
        <ReplaceTab apps={[]} onOpenDetail={() => {}} onAddToBatch={() => {}} onRemoveFromBatch={() => {}} />
      </I18nProvider>
    );
    expect(document.documentElement.dir).toBe('rtl');
    expect(screen.getByText('پیام‌رسانی')).toBeTruthy();
    expect(screen.getByText('مدیریت‌کننده‌های گذرواژه')).toBeTruthy();
    expect(document.body.textContent).not.toContain('Messaging');
  });
});

describe('detail dialog translates its data-driven strings', () => {
  it('category badge and generic download labels render translated in German', async () => {
    setLang('de');
    const APP_WITH_DL = { ...APP, downloadUrl: 'https://ente.io/download' } as unknown as AppItem;
    render(
      <I18nProvider>
        <AppDetailModal app={APP_WITH_DL} onClose={() => {}} />
      </I18nProvider>
    );
    // Category badge through the shared CATEGORY_I18N_KEYS mapping.
    expect(screen.getByText('Dienstprogramme & System')).toBeTruthy();
    // Generic data labels translated at render time.
    await screen.findByText('Offizielle Download-Seite');
    expect(document.body.textContent).not.toContain('Official download page');
    expect(document.body.textContent).not.toContain('Utilities & System');
  });

  it('product-pattern labels go through the forPlatform/onStore templates in German', async () => {
    setLang('de');
    const injected: DownloadOption[] = [
      { kind: 'page', label: 'Thunderbird for Windows', url: 'https://www.thunderbird.net/' },
      { kind: 'store', label: 'Signal on Google Play', url: 'https://play.google.com/store/apps/details?id=org.thoughtcrime.securesms' },
    ];
    vi.mocked(getDownloadOptions).mockReturnValue(injected);
    render(
      <I18nProvider>
        <AppDetailModal app={APP} onClose={() => {}} />
      </I18nProvider>
    );
    // The product proper noun stays; only the glue word translates.
    await screen.findByText('Thunderbird für Windows');
    expect(screen.getByText('Signal im Google Play')).toBeTruthy();
    expect(document.body.textContent).not.toContain('Thunderbird for Windows');
    expect(document.body.textContent).not.toContain('Signal on Google Play');
  });

  it('the platform-unavailable note renders translated (German)', () => {
    setLang('de');
    const EMPTY: AppItem = { ...APP, platforms: [] } as unknown as AppItem;
    render(
      <I18nProvider>
        <AppDetailModal app={EMPTY} onClose={() => {}} />
      </I18nProvider>
    );
    // Malformed data (no platforms) still yields a German sentence naming the
    // requested platform, never the lib's English template.
    expect(screen.getByText(/Kein Windows-Build/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('No Windows build');
  });

  it('the Spanish locale translates the same surfaces', async () => {
    setLang('es');
    const APP_WITH_DL = { ...APP, downloadUrl: 'https://ente.io/download' } as unknown as AppItem;
    render(
      <I18nProvider>
        <AppDetailModal app={APP_WITH_DL} onClose={() => {}} />
      </I18nProvider>
    );
    expect(screen.getByText('Utilidades y sistema')).toBeTruthy();
    await screen.findByText('Página de descarga oficial');
    expect(document.body.textContent).not.toContain('Official download page');
  });
});

describe('add/edit form consumes the existing highlight key', () => {
  it('the Highlight label is the dictionary string, not hardcoded English (Spanish)', () => {
    setLang('es');
    render(
      <I18nProvider>
        <AddAppModal isOpen onClose={() => {}} onSaveApp={() => {}} />
      </I18nProvider>
    );
    expect(screen.getByText('Punto destacado')).toBeTruthy();
  });
});
