// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
// @vitest-environment jsdom
//
// Localization gate for the dialog system this PR owns: every modal renders
// fully translated in a non-English locale (German - a language with real
// grammar distance from English), every dialog has an accessible name
// derived from a visible element, no old hardcoded English sentinel survives,
// and the RTL locale flips the document direction. Plus: the English
// fallback for an unexpected runtime key emits a development warning instead
// of silently hiding translation debt.

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider, DICTS } from '../../lib/i18n';
import { KeyboardShortcutsModal } from '../KeyboardShortcutsModal';
import { LegalModals } from '../LegalModals';
import { TauriModal } from '../TauriModal';
import { WhatsNewModal } from '../WhatsNewModal';
import { LiveSearchModal } from '../LiveSearchModal';
import { AddAppModal } from '../AddAppModal';
import { CompareModal } from '../CompareModal';
import { AppItem } from '../../types';

vi.mock('../Header', () => ({
  BrandMark: () => <span data-testid="brand" />,
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
  license: 'MIT',
  stars: 0,
  tags: [],
  beginnerRating: 'Quick Learning Curve',
} as unknown as AppItem;

function setLang(lang: string) {
  localStorage.setItem('fress.lang', lang);
}

/** The accessible name of a dialog must come from an existing, non-empty element. */
function expectDialogNamed() {
  const dialog = screen.getByRole('dialog');
  const labelledBy = dialog.getAttribute('aria-labelledby');
  expect(labelledBy, 'dialog must name itself via aria-labelledby').toBeTruthy();
  const nameEl = document.getElementById(labelledBy!);
  expect(nameEl, `aria-labelledby target #${labelledBy} must exist`).toBeTruthy();
  expect((nameEl!.textContent ?? '').trim().length).toBeGreaterThan(0);
  expect(nameEl!.textContent).not.toMatch(/^[a-z]+\.[a-zA-Z.]+$/); // no raw keys
}

beforeEach(() => {
  // Hermetic: no network in any of these renders.
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline (test)'))));
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.lang = '';
  document.documentElement.dir = '';
  vi.unstubAllGlobals();
});

describe('owned dialogs render fully translated (German)', () => {
  it('keyboard shortcuts modal', () => {
    setLang('de');
    render(
      <I18nProvider>
        <KeyboardShortcutsModal isOpen onClose={() => {}} />
      </I18nProvider>
    );
    expectDialogNamed();
    expect(screen.getByText('Tastaturkürzel für die Navigation')).toBeTruthy();
    expect(document.body.textContent).not.toContain('Keyboard Navigation Shortcuts');
    expect(document.body.textContent).not.toContain('Toggle between Card Grid and Table View');
  });

  it('legal modals', () => {
    setLang('de');
    render(
      <I18nProvider>
        <LegalModals isOpen onClose={() => {}} />
      </I18nProvider>
    );
    expectDialogNamed();
    expect(screen.getByText('Datenschutz & Bedingungen')).toBeTruthy();
    expect(screen.getByText('Was Fress sammelt')).toBeTruthy();
    expect(document.body.textContent).not.toContain('Privacy & terms');
    expect(document.body.textContent).not.toContain('What Fress collects');
  });

  it('tauri packaging modal', () => {
    setLang('de');
    render(
      <I18nProvider>
        <TauriModal isOpen onClose={() => {}} />
      </I18nProvider>
    );
    expectDialogNamed();
    expect(screen.getByText('Desktop-Installer paketieren')).toBeTruthy();
    expect(screen.getByText('Terminal-Befehl')).toBeTruthy();
    expect(document.body.textContent).not.toContain('Desktop Installer Packaging');
  });

  it('whats new modal', () => {
    setLang('de');
    render(
      <I18nProvider>
        <WhatsNewModal isOpen onClose={() => {}} />
      </I18nProvider>
    );
    expectDialogNamed();
    expect(screen.getByText('Neu in Fress')).toBeTruthy();
    expect(screen.getByText('Verstanden')).toBeTruthy();
    expect(document.body.textContent).not.toContain('Got it');
    expect(document.body.textContent).not.toContain('Full changelog on GitHub');
  });

  it('live search modal', () => {
    setLang('de');
    render(
      <I18nProvider>
        <LiveSearchModal isOpen onClose={() => {}} onAddApp={() => {}} existingApps={[]} />
      </I18nProvider>
    );
    expectDialogNamed();
    expect(screen.getByText('GitHub durchsuchen')).toBeTruthy();
    expect(screen.getByText('Nur auf diesem Gerät gespeichert.')).toBeTruthy();
    expect(document.body.textContent).not.toContain('Type a name above to search GitHub.');
    expect(document.body.textContent).not.toContain('Saved on this device only.');
  });

  it('add/edit app modal', () => {
    setLang('de');
    render(
      <I18nProvider>
        <AddAppModal isOpen onClose={() => {}} onSaveApp={() => {}} />
      </I18nProvider>
    );
    expectDialogNamed();
    expect(screen.getByText('Name der Anwendung *')).toBeTruthy();
    expect(screen.getByText('GitHub-Repository-URL')).toBeTruthy();
    expect(screen.getByText('Unterstützte Plattformen')).toBeTruthy();
    // Categories come through the shared category keys, not the raw id.
    expect(screen.getByText('Dienstprogramme & System')).toBeTruthy();
    expect(document.body.textContent).not.toContain('Application Name *');
    expect(document.body.textContent).not.toContain('Utilities & System');
  });

  it('compare modal', () => {
    setLang('de');
    render(
      <I18nProvider>
        <CompareModal
          isOpen
          onClose={() => {}}
          appsToCompare={[APP]}
          allApps={[APP]}
          onAddAppToCompare={() => {}}
          onRemoveAppFromCompare={() => {}}
          onClearCompare={() => {}}
        />
      </I18nProvider>
    );
    expectDialogNamed();
    expect(screen.getByText('Software-Vergleichsmatrix')).toBeTruthy();
    // The category row shows the translated category, never the raw id.
    expect(screen.getByText('Dienstprogramme & System')).toBeTruthy();
    expect(screen.getByText('Community-Sterne')).toBeTruthy();
    expect(document.body.textContent).not.toContain('Software Comparison Matrix');
    expect(document.body.textContent).not.toContain('Community Stars');
  });
});

describe('dialog locale mechanics', () => {
  it('the Persian locale flips the document to RTL', () => {
    setLang('fa');
    render(
      <I18nProvider>
        <KeyboardShortcutsModal isOpen onClose={() => {}} />
      </I18nProvider>
    );
    expect(document.documentElement.dir).toBe('rtl');
    expect(document.documentElement.lang).toBe('fa');
    expect(screen.getByText('میان‌برهای ناوبری با صفحه‌کلید')).toBeTruthy();
  });

  it('an unexpected runtime key falls back to English WITH a development warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setLang('es');
    // Simulate translation debt: the key exists in en but drifted out of es.
    const saved = DICTS.es['ks.title'];
    delete (DICTS.es as Record<string, string>)['ks.title'];
    try {
      render(
        <I18nProvider>
          <KeyboardShortcutsModal isOpen onClose={() => {}} />
        </I18nProvider>
      );
      // The UI still shows English (never a raw key), but loudly.
      expect(screen.getByText('Keyboard Navigation Shortcuts')).toBeTruthy();
      expect(
        warnSpy.mock.calls.some((c) => String(c[0]).includes('ks.title')),
        'the fallback must warn about the missing es translation'
      ).toBe(true);
    } finally {
      (DICTS.es as Record<string, string>)['ks.title'] = saved;
      warnSpy.mockRestore();
    }
  });
});
