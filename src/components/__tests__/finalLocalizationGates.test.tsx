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

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider, DICTS, PP_CATEGORY_I18N_KEYS } from '../../lib/i18n';
import { PRIVACY_PACK } from '../../data/privacyPack';
import { COMBOS } from '../../data/combos';
import { ReplaceTab } from '../ReplaceTab';
import { AppDetailModal } from '../AppDetailModal';
import { AddAppModal } from '../AddAppModal';
import { BatchActionBar } from '../../features/batch/BatchActionBar';
import { CompareDock } from '../../features/compare/CompareDock';
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

describe('floating docks and bars expose localized accessible names', () => {
  it('the batch bar names itself, its compare hint and its clear action in German', () => {
    setLang('de');
    render(
      <I18nProvider>
        <BatchActionBar
          selectedCount={2}
          resolving={false}
          onDownload={() => {}}
          onOpenScriptModal={() => {}}
          onCompareSelected={() => {}}
          onClear={() => {}}
        />
      </I18nProvider>
    );
    expect(screen.getByLabelText('Leiste für Sammelaktionen')).toBeTruthy();
    expect(screen.getByTitle('Bis zu 4 ausgewählte Werkzeuge nebeneinander vergleichen')).toBeTruthy();
    expect(screen.getByLabelText('Sammelauswahl aufheben')).toBeTruthy();
  });

  it('the compare dock names itself and its count in Persian, RTL-safe copy', () => {
    setLang('fa');
    render(
      <I18nProvider>
        <CompareDock count={2} onOpenMatrix={() => {}} onClear={() => {}} />
      </I18nProvider>
    );
    expect(screen.getByLabelText('داک مقایسه')).toBeTruthy();
    expect(screen.getByText('2 در مقایسه')).toBeTruthy();
    expect(screen.getByText('نمایش ماتریس')).toBeTruthy();
  });
});

describe('privacy page label-in-name and heading contract', () => {
  it('the "you use now" trigger is named by the CURRENT app, not the category', () => {
    // The trigger's visible text is the app name (Gmail); a name that omits
    // it fails WCAG 2.5.3 Label in Name (axe: label-content-name-mismatch).
    setLang('en');
    render(
      <I18nProvider>
        <ReplaceTab apps={[]} onOpenDetail={() => {}} onAddToBatch={() => {}} onRemoveFromBatch={() => {}} />
      </I18nProvider>
    );
    const mailCat = PRIVACY_PACK.find((c) => c.id === 'mail') ?? PRIVACY_PACK[0];
    const current = mailCat.mainstream[0].name;
    const trigger = document.getElementById(`pp-main-${mailCat.id}`) as HTMLButtonElement;
    expect(trigger).toBeTruthy();
    expect(trigger.textContent).toContain(current);
    expect(trigger.getAttribute('aria-label')).toBe(`You use now: ${current}`);
  });

  it('the replacement picker name contains its visible placeholder and counter', () => {
    setLang('en');
    render(
      <I18nProvider>
        <ReplaceTab apps={[]} onOpenDetail={() => {}} onAddToBatch={() => {}} onRemoveFromBatch={() => {}} />
      </I18nProvider>
    );
    const placeholder = DICTS.en['pp.pick'];
    const trigger = document.getElementById('pp-picker-mail') as HTMLButtonElement;
    expect(trigger).toBeTruthy();
    // Visible text: placeholder + n/max counter.
    expect(trigger.textContent).toContain(placeholder);
    expect(trigger.textContent).toContain('0/3');
    // The accessible name embeds the SAME strings, so it always contains the
    // visible text in every trigger state.
    const label = trigger.getAttribute('aria-label') ?? '';
    expect(label.startsWith('Replace with: ')).toBe(true);
    expect(label).toContain(placeholder);
    expect(label).toContain('0/3');
    // The label is built from the same source string as the content.
    expect(label).toBe(`Replace with: ${placeholder} 0/3`);
  });

  it('the privacy page carries exactly one level-one heading', () => {
    // When this page replaces the catalog its h1 goes with it; the page
    // must own its own (axe: page-has-heading-one).
    setLang('en');
    render(
      <I18nProvider>
        <ReplaceTab apps={[]} onOpenDetail={() => {}} onAddToBatch={() => {}} onRemoveFromBatch={() => {}} />
      </I18nProvider>
    );
    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s.length).toBe(1);
    expect(h1s[0].textContent).toBe(DICTS.en['pp.title']);
    // Card headings sit one level below the page heading - no skips.
    const h2s = screen.getAllByRole('heading', { level: 2 });
    expect(h2s.length).toBeGreaterThanOrEqual(PRIVACY_PACK.length);
  });

  it('no emerald-500 text ink remains in ReplaceTab (light-theme AA)', () => {
    // Light remaps emerald-500 to #257c4b, which fails 4.5:1 on the tinted
    // chips. Text uses emerald-800 in light (emerald-400 in dark): emerald-700 still sat at about 4.3:1 on the tinted chip.
    const source = readFileSync(resolve(process.cwd(), 'src/components/ReplaceTab.tsx'), 'utf8');
    expect(source.includes('text-emerald-500')).toBe(false);
    expect(source.includes('text-emerald-800 dark:text-emerald-400')).toBe(true);
  });
});
