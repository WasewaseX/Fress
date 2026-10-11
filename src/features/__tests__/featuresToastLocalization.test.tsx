// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
// @vitest-environment jsdom
//
// The unclaimed feature hooks (batch selection, compare selection, catalog
// management, filters) fire user-facing toasts. This pins their localized
// wording (German) through the real hooks, so a future refactor cannot
// quietly reintroduce hardcoded English.

import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppItem } from '../../types';
import { I18nProvider, Language } from '../../lib/i18n';
import { DownloadsProvider } from '../../lib/downloads';

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: toastMock }));

beforeEach(() => {
  toastMock.success.mockClear();
  toastMock.info.mockClear();
  toastMock.error.mockClear();
  toastMock.warning.mockClear();
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function makeApp(id: string, name: string): AppItem {
  return {
    id,
    name,
    tagline: '',
    description: '',
    whyItsAwesome: '',
    beginnerGuide: '',
    githubUrl: 'https://github.com/example/app',
    websiteUrl: 'https://example.com',
    category: 'Utilities & System',
    platforms: ['windows'],
    license: 'MIT',
    stars: 0,
    isOwnerPick: false,
    isTrendingToday: false,
    tags: [],
    addedAt: '2026-01-01',
  };
}

function makeAppArray(n: number): AppItem[] {
  return Array.from({ length: n }, (_, i) => makeApp(`app-${i}`, `App ${i}`));
}

/** Pins the locale through the provider's storage key before mount. */
function withGermanLocale(lang: Language = 'de'): void {
  window.localStorage.setItem('fress.lang', lang);
}

describe('useCompareSelection toasts (de)', () => {
  it('announces the add and the hard limit in German', async () => {
    withGermanLocale();
    const { useCompareSelection } = await import('../compare/useCompareSelection');
    let api: ReturnType<typeof useCompareSelection> | null = null;
    const apps = makeAppArray(5);
    const Probe: React.FC = () => {
      api = useCompareSelection(apps);
      return null;
    };
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>
    );
    act(() => api!.toggleCompare('app-0'));
    expect(toastMock.success).toHaveBeenCalledWith('„App 0“ zur Vergleichsmatrix hinzugefügt.');
    for (const id of ['app-1', 'app-2', 'app-3']) act(() => api!.toggleCompare(id));
    expect(toastMock.info).not.toHaveBeenCalled();
    act(() => api!.toggleCompare('app-4'));
    expect(toastMock.info).toHaveBeenCalledWith('Es können maximal 4 Anwendungen gleichzeitig verglichen werden.');
  });
});

describe('useBatchSelection selectAll toast (de)', () => {
  it('announces the full selection with the count', async () => {
    withGermanLocale();
    const { useBatchSelection } = await import('../batch/useBatchSelection');
    let api: ReturnType<typeof useBatchSelection> | null = null;
    const apps = makeAppArray(3);
    const Probe: React.FC = () => {
      api = useBatchSelection(apps, () => undefined);
      return null;
    };
    render(
      <I18nProvider>
        <DownloadsProvider>
          <Probe />
        </DownloadsProvider>
      </I18nProvider>
    );
    act(() => api!.selectAll());
    expect(toastMock.success).toHaveBeenCalledWith('Alle 3 Anwendungen für Sammelaktionen ausgewählt.');
  });
});

describe('useCatalogFilters resetFilters toast (de)', () => {
  it('announces the reset in German', async () => {
    withGermanLocale();
    const { useCatalogFilters } = await import('../catalog/useCatalogFilters');
    let api: ReturnType<typeof useCatalogFilters> | null = null;
    const Probe: React.FC = () => {
      api = useCatalogFilters();
      return null;
    };
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>
    );
    act(() => api!.resetFilters());
    expect(toastMock.info).toHaveBeenCalledWith('Filter auf Standard zurückgesetzt.');
  });
});

describe('useAppCatalog feedback toasts (de)', () => {
  it('announces add and remove in German', async () => {
    withGermanLocale();
    const { useAppCatalog } = await import('../catalog/useAppCatalog');
    let api: ReturnType<typeof useAppCatalog> | null = null;
    const Probe: React.FC = () => {
      api = useAppCatalog();
      return null;
    };
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>
    );
    const custom = { ...makeApp('custom-1', 'Mein Werkzeug'), isCustom: true };
    act(() => api!.saveApp(custom));
    expect(toastMock.success).toHaveBeenCalledWith('„Mein Werkzeug“ zu Ihrem Anwendungskatalog hinzugefügt.');
    act(() => api!.saveApp({ ...custom, name: 'Mein Werkzeug 2' }));
    expect(toastMock.success).toHaveBeenLastCalledWith('„Mein Werkzeug 2“ erfolgreich aktualisiert.');
    act(() => api!.deleteApp('custom-1'));
    // The toast names the app by its CURRENT title (it was renamed above).
    expect(toastMock.info).toHaveBeenCalledWith('„Mein Werkzeug 2“ aus Ihrem Katalog entfernt.');
  });

  it('rejects a broken backup with the German reason', async () => {
    withGermanLocale();
    const { useAppCatalog } = await import('../catalog/useAppCatalog');
    let api: ReturnType<typeof useAppCatalog> | null = null;
    const Probe: React.FC = () => {
      api = useAppCatalog();
      return null;
    };
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>
    );
    act(() => api!.importCatalog('not json at all'));
    expect(toastMock.error).toHaveBeenCalledWith('JSON-Backup-Datei konnte nicht gelesen werden.');
    act(() => api!.importCatalog('[]'));
    expect(toastMock.error).toHaveBeenLastCalledWith('Ungültige Backup-Datei: ein JSON-Objekt wurde erwartet.');
  });
});
