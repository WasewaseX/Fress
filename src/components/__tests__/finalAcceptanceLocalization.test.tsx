// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
// @vitest-environment jsdom
//
// Final-acceptance localization regressions for the surfaces this round
// found still rendering untranslated English:
//  - the footer (license badge, description, build-guide button + tooltip,
//    legal links) now consumes the dictionary in every language;
//  - the batch modal's per-chip remove control exposes an accessible name
//    that identifies WHICH app it removes (dead bs.removeApp key wired);
//  - cards and the table route license defaults through the ONE shared
//    translateLicenseDisplay mapping instead of rendering the stored
//    English data value (same contract as the detail modal and matrix).

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../lib/i18n';
import { Footer } from '../Footer';
import { BatchInstallModal } from '../BatchInstallModal';
import { AppCard } from '../AppCard';
import { TableView } from '../TableView';
import { AppItem } from '../../types';

vi.mock('../../lib/downloads', () => ({
  useDownloadActions: () => ({
    startDownload: vi.fn(),
    recordExternalOpen: vi.fn(),
  }),
  useAppDownloadStatus: () => null,
  formatBytes: (n: number) => `${n} B`,
}));

vi.mock('../../lib/starFetch', () => ({
  useLiveStars: () => null,
  formatStarCount: (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)),
}));

vi.mock('../../lib/external', () => ({
  openExternal: vi.fn(),
}));

vi.mock('../../lib/selfUpdate', () => ({
  checkForUpdate: vi.fn(() => Promise.resolve({ kind: 'idle' } as never)),
  planUpdateDelivery: vi.fn(() => ({ kind: 'external' } as never)),
}));

vi.mock('../../lib/sourceLinks', () => ({
  sourceLinksFor: () => [],
}));

vi.mock('../../data/appIcons', () => ({
  iconFor: () => null,
}));

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
  license: 'Free for Personal Use',
  stars: 0,
  tags: [],
  beginnerRating: 'Quick Learning Curve',
} as unknown as AppItem;

function setLang(lang: string) {
  localStorage.setItem('fress.lang', lang);
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.lang = '';
  document.documentElement.dir = '';
});

describe('footer renders translated in every language', () => {
  it('German: license badge, description, build guide, tooltip and legal links', () => {
    setLang('de');
    render(
      <I18nProvider>
        <Footer onOpenLegal={() => {}} onOpenTauriModal={() => {}} />
      </I18nProvider>
    );
    expect(screen.getByText('MIT-lizenziert')).toBeTruthy();
    expect(
      screen.getByText(
        'Ein kurzes Verzeichnis freier Open-Source-Apps, basierend auf der Liste awesome-free-apps. Downloads stammen von den offiziellen Projekten.'
      )
    ).toBeTruthy();
    expect(screen.getByText('Build-Anleitung (für Entwickler)')).toBeTruthy();
    expect(
      screen.getByTitle('Für Entwickler: So bauen Sie das Desktop-Installationsprogramm aus dem Quellcode')
    ).toBeTruthy();
    expect(screen.getByText('Datenschutz')).toBeTruthy();
    expect(screen.getByText('Bedingungen')).toBeTruthy();
  });

  it('Persian (RTL): same surfaces resolved from the fa dictionary', () => {
    setLang('fa');
    render(
      <I18nProvider>
        <Footer onOpenLegal={() => {}} onOpenTauriModal={() => {}} />
      </I18nProvider>
    );
    expect(screen.getByText('دارای مجوز MIT')).toBeTruthy();
    expect(screen.getByText('راهنمای ساخت (برای توسعه‌دهندگان)')).toBeTruthy();
    expect(screen.getByText('حریم خصوصی')).toBeTruthy();
    expect(screen.getByText('شرایط')).toBeTruthy();
    expect(document.documentElement.dir).toBe('rtl');
  });

  it('German renders no English footer sentinels', () => {
    setLang('de');
    render(
      <I18nProvider>
        <Footer onOpenLegal={() => {}} onOpenTauriModal={() => {}} />
      </I18nProvider>
    );
    expect(screen.queryByText('MIT Licensed')).toBeNull();
    expect(screen.queryByText('Build guide (developers)')).toBeNull();
    expect(screen.queryByText('Privacy')).toBeNull();
    expect(screen.queryByText('Terms')).toBeNull();
    expect(
      screen.queryByText(/A short directory of free and open-source apps/)
    ).toBeNull();
  });
});

describe('batch modal remove control identifies the app', () => {
  it('German accessible name is "Aus dem Stapel entfernen: <app>"', () => {
    setLang('de');
    render(
      <I18nProvider>
        <BatchInstallModal
          isOpen
          onClose={() => {}}
          selectedApps={[APP]}
          allApps={[APP]}
          onToggleAppSelection={() => {}}
          onSelectAll={() => {}}
          onClearSelection={() => {}}
        />
      </I18nProvider>
    );
    const remove = screen.getByRole('button', { name: 'Aus dem Stapel entfernen: Ente Auth' });
    expect(remove).toBeTruthy();
    // The visible chip keeps the app name; the control itself no longer says
    // just "Remove from batch" for every row.
    expect(screen.queryByTitle('Remove from batch')).toBeNull();
  });
});

describe('license defaults resolve through the shared mapping on cards and table', () => {
  it('German card badge shows the translated license, not the stored English value', () => {
    setLang('de');
    render(
      <I18nProvider>
        <AppCard
          app={APP}
          isFavorite={false}
          onToggleFavorite={() => {}}
          onOpenDetail={() => {}}
        />
      </I18nProvider>
    );
    expect(screen.getByText('Kostenlos für persönliche Nutzung')).toBeTruthy();
    expect(screen.queryByText('Free for Personal Use')).toBeNull();
  });

  it('German table cell shows the translated license', () => {
    setLang('de');
    render(
      <I18nProvider>
        <TableView
          apps={[APP]}
          favorites={[]}
          onToggleFavorite={() => {}}
          onOpenDetail={() => {}}
        />
      </I18nProvider>
    );
    expect(screen.getByText('Kostenlos für persönliche Nutzung')).toBeTruthy();
    expect(screen.queryByText('Free for Personal Use')).toBeNull();
  });
});
