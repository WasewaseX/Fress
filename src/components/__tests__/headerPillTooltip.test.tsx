// @vitest-environment jsdom
// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
/**
 * The header update pill's TOOLTIP truthfulness contract.
 *
 * The visible label and the native tooltip describe the SAME control, so
 * they must never contradict each other: while a delivery-state override
 * is active (busy, verified, retry, or see-releases after a plan-level
 * refusal), the tooltip is the override label itself - the static
 * "tap to download" hint would tell the user to expect an in-app
 * download that the planner just refused. Pinned here so the fallback
 * truthfulness fix (quality-gates finding 1 follow-up) cannot regress.
 */
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../ThemeProvider', () => ({
  useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }),
}));

// jsdom has no ResizeObserver; the Header observes its own width for the
// responsive collapse. A inert stub is enough - no resize can fire here.
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

vi.mock('../../lib/downloads', () => ({
  useDownloadState: () => ({ activeCount: 0, downloadDir: '' }),
  useDownloadActions: () => ({ chooseFolder: vi.fn(), resetFolder: vi.fn() }),
  isAndroidWebview: () => false,
}));

import { Header } from '../Header';
import { I18nProvider, DICTS } from '../../lib/i18n';

const VERSION = '1.0.10-beta';
const t = (key: string) => DICTS.en[key] ?? key;

function renderHeader(updatePillStatus: { label: string; busy: boolean } | null) {
  return render(
    <I18nProvider>
      <Header
        searchQuery=""
        onSearchChange={() => {}}
        onOpenAddApps={() => {}}
        onOpenTauriModal={() => {}}
        onOpenShortcutsModal={() => {}}
        onExportCatalog={() => {}}
        onImportCatalog={() => {}}
        viewMode="grid"
        onToggleViewMode={() => {}}
        updateVersion={VERSION}
        updatePillStatus={updatePillStatus}
        onUpdateClick={() => {}}
      />
    </I18nProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('update pill tooltip truth', () => {
  it('idle pill keeps the static tap-to-download hint naming the version', () => {
    renderHeader(null);
    const pill = document.getElementById('header-update-pill')!;
    expect(pill.getAttribute('title')).toBe(
      t('header.updatePillTitle').replace('{v}', VERSION)
    );
  });

  it('a plan-level refusal tooltips the same see-releases truth the label shows', () => {
    const label = t('header.updatePillSeeReleases');
    renderHeader({ label, busy: false });
    const pill = document.getElementById('header-update-pill')!;
    expect(pill.textContent).toContain(label);
    expect(pill.getAttribute('title')).toBe(label);
    expect(pill.getAttribute('title')).not.toBe(
      t('header.updatePillTitle').replace('{v}', VERSION)
    );
  });

  it('busy and verified overrides tooltip their own label (one truth per state)', () => {
    for (const label of [
      t('header.updatePillDownloading').replace('{v}', VERSION),
      t('header.updatePillVerifyingSignature').replace('{v}', VERSION),
      t('header.updatePillReady').replace('{v}', VERSION),
      t('header.updatePillRetry'),
    ]) {
      cleanup();
      renderHeader({ label, busy: true });
      const pill = document.getElementById('header-update-pill')!;
      expect(pill.getAttribute('title')).toBe(label);
    }
  });
});
