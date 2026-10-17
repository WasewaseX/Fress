// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
// @vitest-environment jsdom
//
// Command-palette keyboard & feedback contract, at the component level:
//  - clipboard rejection shows a real localized error state, never a stale
//    "Copied";
//  - dismissing the palette kills the pending feedback timer, so reopening
//    inside the 2s window cannot resurrect the previous session's
//    "Copied" flash;
//  - the combobox's aria-activedescendant follows the highlighted row and
//    exactly one option carries aria-selected="true" (the SR announcement
//    contract for keyboard-driven active-option changes).

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../lib/i18n';
import { CommandPalette } from '../../components/CommandPalette';
import { AppItem } from '../../types';

function app(id: string, name: string, cmd: string, proprietaryAlternative?: string): AppItem {
  return {
    proprietaryAlternative,
    id,
    name,
    tagline: `${name} tagline`,
    description: `${name} description`,
    whyItsAwesome: 'why',
    beginnerGuide: 'guide',
    githubUrl: `https://github.com/example/${id}`,
    websiteUrl: `https://${id}.example.com`,
    category: 'Utilities & System',
    platforms: ['windows'],
    license: 'MIT',
    stars: 10,
    tags: [],
    beginnerRating: 'Quick Learning Curve',
    wingetCommand: cmd,
  } as unknown as AppItem;
}

const APPS = [
  app('alpha', 'Alpha Tool', 'winget install alpha', 'Alpha Proprietary Suite'),
  app('beta', 'Beta Tool', 'brew install beta'),
];

function renderPalette(isOpen: boolean, onClose = vi.fn()) {
  return render(
    <I18nProvider>
      <CommandPalette
        isOpen={isOpen}
        onClose={onClose}
        apps={APPS}
        onToggleFavorite={() => {}}
        onOpenAppDetail={() => {}}
        onSelectCategory={() => {}}
        onToggleViewMode={() => {}}
        viewMode="grid"
        onOpenBatchInstall={() => {}}
        onOpenCompare={() => {}}
        onOpenExport={() => {}}
      />
    </I18nProvider>
  );
}

const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('palette clipboard feedback', () => {
  it('shows a real error state when the clipboard rejects the write', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'));
    renderPalette(true);
    const copyButtons = screen.getAllByRole('button', { name: /copy/i });
    fireEvent.click(copyButtons[0]);
    await vi.waitFor(() => expect(screen.getAllByText('Copy failed').length).toBeGreaterThan(0));
    expect(screen.queryByText('Copied')).toBeNull();
  });

  it('Enter on the focused copy button COPIES instead of navigating (Enter-hijack regression)', async () => {
    writeText.mockResolvedValueOnce(undefined);
    const onClose = vi.fn();
    const onOpenAppDetail = vi.fn();
    render(
      <I18nProvider>
        <CommandPalette
          isOpen
          onClose={onClose}
          apps={APPS}
          onToggleFavorite={() => {}}
          onOpenAppDetail={onOpenAppDetail}
          onSelectCategory={() => {}}
          onToggleViewMode={() => {}}
          viewMode="grid"
          onOpenBatchInstall={() => {}}
          onOpenCompare={() => {}}
          onOpenExport={() => {}}
        />
      </I18nProvider>
    );
    const copyBtn = screen.getByRole('button', { name: 'Copy install command for Alpha Tool' });
    copyBtn.focus();
    // The container-level keydown used to preventDefault() this Enter and
    // open the highlighted app's detail instead - keyboard users could
    // never copy. The hijack symptom is the navigation: with focus on the
    // button, Enter must NOT navigate (jsdom does not synthesize the
    // button's native click from keydown, so the copy itself is asserted
    // by the click path below).
    fireEvent.keyDown(copyBtn, { key: 'Enter' });
    expect(onClose).not.toHaveBeenCalled();
    expect(onOpenAppDetail).not.toHaveBeenCalled();
    // The copy path itself (native activation / mouse) still works.
    fireEvent.click(copyBtn);
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('winget install alpha'));
  });

  it('Enter in the query input still activates the highlighted row', () => {
    const onClose = vi.fn();
    const onOpenAppDetail = vi.fn();
    render(
      <I18nProvider>
        <CommandPalette
          isOpen
          onClose={onClose}
          apps={APPS}
            onToggleFavorite={() => {}}
          onOpenAppDetail={onOpenAppDetail}
          onSelectCategory={() => {}}
          onToggleViewMode={() => {}}
          viewMode="grid"
          onOpenBatchInstall={() => {}}
          onOpenCompare={() => {}}
          onOpenExport={() => {}}
        />
      </I18nProvider>
    );
    const input = screen.getByRole('combobox');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onOpenAppDetail).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('the contextual copy control sits outside the listbox and names the highlighted app', () => {
    renderPalette(true);
    const copyBtn = screen.getByRole('button', { name: 'Copy install command for Alpha Tool' });
    const list = screen.getByRole('listbox');
    expect(list.contains(copyBtn)).toBe(false);
    // No copy affordance lives inside any option anymore.
    list.querySelectorAll('[role="option"]').forEach((opt) => {
      expect(opt.querySelector('button')).toBeNull();
    });
  });

  it('dismissing the palette clears pending feedback; reopening shows none', async () => {
    writeText.mockResolvedValueOnce(undefined);
    const onClose = vi.fn();
    const { rerender } = renderPalette(true, onClose);
    const copyButtons = screen.getAllByRole('button', { name: /copy/i });
    fireEvent.click(copyButtons[0]);
    await vi.waitFor(() => expect(screen.getAllByText('Copied').length).toBeGreaterThan(0));

    // Close while the 2s flash timer is still pending...
    rerender(
      <I18nProvider>
        <CommandPalette
          isOpen={false}
          onClose={onClose}
          apps={APPS}
          onToggleFavorite={() => {}}
          onOpenAppDetail={() => {}}
          onSelectCategory={() => {}}
          onToggleViewMode={() => {}}
          viewMode="grid"
          onOpenBatchInstall={() => {}}
          onOpenCompare={() => {}}
          onOpenExport={() => {}}
        />
      </I18nProvider>
    );
    // ...and reopen BEFORE the timer would have fired.
    vi.advanceTimersByTime(500);
    rerender(
      <I18nProvider>
        <CommandPalette
          isOpen
          onClose={onClose}
          apps={APPS}
          onToggleFavorite={() => {}}
          onOpenAppDetail={() => {}}
          onSelectCategory={() => {}}
          onToggleViewMode={() => {}}
          viewMode="grid"
          onOpenBatchInstall={() => {}}
          onOpenCompare={() => {}}
          onOpenExport={() => {}}
        />
      </I18nProvider>
    );
    expect(screen.queryByText('Copied')).toBeNull();
    // The live region is silent too - no stale announcement on reopen.
    const live = document.querySelector('span.sr-only[role="status"]');
    expect(live?.textContent).toBe('');
  });
});

describe('active option follows the keyboard selection', () => {
  it('ArrowDown moves aria-activedescendant and exactly one option is selected', () => {
    renderPalette(true);
    const input = screen.getByRole('combobox');
    expect(input.getAttribute('aria-activedescendant')).toBe('palette-item-alpha');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe('palette-item-beta');
    expect(document.getElementById('palette-item-beta')!.getAttribute('aria-selected')).toBe('true');
    expect(document.getElementById('palette-item-alpha')!.getAttribute('aria-selected')).toBe('false');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    // Wraparound back to the first row.
    expect(input.getAttribute('aria-activedescendant')).toBe('palette-item-alpha');
  });

  it('the listbox is named, the dialog is named by its heading, rows stay option-only', () => {
    renderPalette(true);
    const input = screen.getByRole('combobox');
    expect(input.getAttribute('aria-controls')).toBe('command-palette-list');
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(input.getAttribute('aria-autocomplete')).toBe('list');

    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-labelledby')).toBe('command-palette-title');
    expect(document.getElementById('command-palette-title')?.textContent?.length ?? 0).toBeGreaterThan(0);

    // A listbox may own ONLY option/group elements: no interactive control
    // may live inside an option button (or as any other listbox child).
    const list = screen.getByRole('listbox');
    list.querySelectorAll('[role="option"]').forEach((opt) => {
      expect(opt.querySelector('button')).toBeNull();
    });
  });

  it('an empty result list is a status OUTSIDE any listbox (no non-option children)', () => {
    render(
      <I18nProvider>
        <CommandPalette
          isOpen
          onClose={() => {}}
          apps={[]}
          onToggleFavorite={() => {}}
          onOpenAppDetail={() => {}}
          onSelectCategory={() => {}}
          onToggleViewMode={() => {}}
          viewMode="grid"
          onOpenBatchInstall={() => {}}
          onOpenCompare={() => {}}
          onOpenExport={() => {}}
        />
      </I18nProvider>
    );
    // A listbox must own only option/group children - the empty state is a
    // role=status element that CARRIES the list id instead (axe:
    // aria-required-children).
    expect(screen.queryByRole('listbox')).toBeNull();
    const status = document.getElementById('command-palette-list')!;
    expect(status.getAttribute('role')).toBe('status');
    expect(status.textContent!.length).toBeGreaterThan(0);
    // aria-controls still resolves to a live element.
    const input = screen.getByRole('combobox');
    expect(document.getElementById(input.getAttribute('aria-controls')!)).toBe(status);
  });
});

describe('selected row follows the chip text contract', () => {
  it('the highlighted row paints its text with the selection-surface ink family (light-theme AA)', () => {
    // The active chip background is a SOLID cocoa in light theme; the row's
    // paper-calibrated slate inks would sit dark-on-brown far below AA
    // (subtitle measured 1.06:1, the "vs" chip 1.12:1, the name 2.53:1 in
    // the round-27 captures). The selected row must switch to the
    // selection-surface ink family: primary text, soft secondary text and
    // the amber accent for the proprietary chip - all via the semantic
    // tokens, in BOTH themes.
    renderPalette(true);
    const selected = document.getElementById('palette-item-alpha')!;
    expect(selected.getAttribute('aria-selected')).toBe('true');

    // Primary ink: the app name.
    const title = selected.querySelector('span[class*="fr-chip-active-text"]') as HTMLElement;
    expect(title, 'the selected name must carry the chip-active text token').toBeTruthy();
    expect(title.className).toContain('text-[color:var(--fr-chip-active-text)]');
    expect(title.className).not.toContain('-soft');

    // Secondary inks: subtitle and stars carry the soft token.
    const soft = selected.querySelectorAll('span[class*="fr-chip-active-text-soft"]');
    expect(soft.length, 'subtitle + stars must use the soft ink').toBeGreaterThanOrEqual(2);

    // Accent ink: the "vs proprietary" badge.
    const badge = selected.querySelector('span[class*="fr-chip-active-accent"]') as HTMLElement;
    expect(badge, 'the vs badge must carry the accent token').toBeTruthy();
    expect(badge.textContent).toContain('vs');

    // No paper-calibrated slate text ink survives on the selected row.
    expect(selected.querySelectorAll('.text-slate-100, .text-slate-400').length).toBe(0);
  });

  it('unselected rows keep their slate inks (no needless override)', () => {
    renderPalette(true);
    const unselected = document.getElementById('palette-item-beta')!;
    expect(unselected.getAttribute('aria-selected')).toBe('false');
    expect(unselected.querySelector('.text-slate-100')).toBeTruthy();
    expect(unselected.querySelectorAll('span[class*="fr-chip-active"]').length).toBe(0);
  });

  it('the ink family follows the keyboard selection as it moves', () => {
    renderPalette(true);
    const input = screen.getByRole('combobox');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const nowSelected = document.getElementById('palette-item-beta')!;
    expect(nowSelected.getAttribute('aria-selected')).toBe('true');
    expect(
      nowSelected.querySelector('span[class*="fr-chip-active-text"]'),
      'the newly selected row must carry the ink family'
    ).toBeTruthy();
    const before = document.getElementById('palette-item-alpha')!;
    expect(before.querySelectorAll('span[class*="fr-chip-active"]').length).toBe(0);
    expect(before.querySelector('.text-slate-100')).toBeTruthy();
  });
});
