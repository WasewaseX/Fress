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

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../lib/i18n';
import { CommandPalette } from '../../components/CommandPalette';
import { AppItem } from '../../types';

function app(id: string, name: string, cmd: string): AppItem {
  return {
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

const APPS = [app('alpha', 'Alpha Tool', 'winget install alpha'), app('beta', 'Beta Tool', 'brew install beta')];

function renderPalette(isOpen: boolean, onClose = vi.fn()) {
  return render(
    <I18nProvider>
      <CommandPalette
        isOpen={isOpen}
        onClose={onClose}
        apps={APPS}
        favorites={[]}
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
          favorites={[]}
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
          favorites={[]}
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
          favorites={[]}
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
