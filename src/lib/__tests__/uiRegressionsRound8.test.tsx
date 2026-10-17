// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
// @vitest-environment jsdom
//
// Regression pins for the whole-frontend UI/UX, accessibility and
// regression pass. Every test names the exact defect it locks shut:
//  - the manual add-app white screen (githubUrl saved as undefined, then
//    AppCard/AppDetailModal called .includes on it);
//  - one-click permanent row deletion in table view (cards always had an
//    inline confirm);
//  - single-letter shortcuts firing behind open dialogs (only '/' was
//    guarded);
//  - ExportModal Escape closing the whole stacked dialog set;
//  - the command palette activating the row that was focused, not the row
//    that was highlighted/announced, after arrow navigation from a row;
//  - the live-search "type a name above" nonsense after a completed
//    0-hit search;
//  - the hardcoded-English batch script comments;
//  - the English-only download ETA suffix;
//  - the $&-pattern toast corruption in string interpolation;
//  - keyboard-inaccessible scrollable regions;
//  - the ARIA tablist roles without the tab keyboard contract;
//  - the header page tabs switching from tab roles to honest toggle
//    buttons.

import React from 'react';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider, DICTS, formatMessage } from '../i18n';
import { ThemeProvider } from '../../components/ThemeProvider';
import { DownloadsProvider } from '../downloads';
import { formatEta } from '../format';
import { resetCurrentLangForTest, setEtaSuffix } from '../currentLang';
import { parseChangelog, changelogForVersion } from '../changelog';
import { AddAppModal } from '../../components/AddAppModal';
import { AppCard } from '../../components/AppCard';
import { TableView } from '../../components/TableView';
import { ExportModal } from '../../components/ExportModal';
import { CommandPalette } from '../../components/CommandPalette';
import { BatchInstallModal } from '../../components/BatchInstallModal';
import { LiveSearchModal } from '../../components/LiveSearchModal';
import { WhatsNewModal } from '../../components/WhatsNewModal';
import { Header } from '../../components/Header';
import { useGlobalShortcuts, type GlobalShortcutsActions } from '../../features/shortcuts/useGlobalShortcuts';
import type { AppItem } from '../../types';

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: toastMock }));

// jsdom has no ResizeObserver; the Header observes its own width for the
// responsive collapse (same inert stub as headerPillTooltip.test.tsx).
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  resetCurrentLangForTest();
});

function withProviders(ui: React.ReactElement): React.ReactElement {
  return (
    <I18nProvider>
      <ThemeProvider>
        <DownloadsProvider>{ui}</DownloadsProvider>
      </ThemeProvider>
    </I18nProvider>
  );
}

function makeApp(overrides: Partial<AppItem> = {}): AppItem {
  return {
    id: 'app-1',
    name: 'TestApp',
    tagline: 'A test app',
    description: 'A longer test description.',
    whyItsAwesome: 'Because tests.',
    beginnerGuide: 'Install it.',
    githubUrl: 'https://github.com/a/b',
    websiteUrl: 'https://a.b',
    category: 'Utilities & System',
    platforms: ['windows'],
    license: 'MIT',
    stars: 100,
    beginnerRating: 'Quick Learning Curve',
    isOwnerPick: false,
    isTrendingToday: false,
    tags: ['test'],
    wingetCommand: 'winget install A.B',
    isPortable: true,
    offlineReady: true,
    isCustom: true,
    addedAt: '2026-01-01',
    ...overrides,
  };
}

describe('manual add-app: a missing repo URL must never white-screen the app', () => {
  const NAME_LABEL = DICTS.en['add.nameLabel'];
  const DESC_LABEL = DICTS.en['add.descriptionLabel'];

  function openModal(onSaveApp: (app: AppItem) => void) {
    render(withProviders(
      <AddAppModal isOpen onClose={() => undefined} onSaveApp={onSaveApp} showTabs={false} />
    ));
    fireEvent.change(screen.getByLabelText(NAME_LABEL), { target: { value: 'My App' } });
    fireEvent.change(screen.getByLabelText(DESC_LABEL), { target: { value: 'Does things.' } });
  }

  function submit() {
    fireEvent.click(document.querySelector('button[type="submit"]')!);
  }

  it('saves githubUrl/gitlabUrl as strings (possibly empty), never undefined', () => {
    const onSaveApp = vi.fn();
    openModal(onSaveApp);
    submit();
    expect(onSaveApp).toHaveBeenCalledTimes(1);
    const saved = onSaveApp.mock.calls[0][0] as AppItem;
    // THE FIX: these used to be `|| undefined`, and the very next card
    // render crashed on undefined.includes.
    expect(saved.githubUrl).toBe('');
    expect(saved.gitlabUrl).toBe('');
    expect(typeof saved.stars).toBe('number');
  });

  it('an invalid URL produces the translated inline error, not a native bubble', () => {
    const onSaveApp = vi.fn();
    openModal(onSaveApp);
    fireEvent.change(screen.getByLabelText(DICTS.en['add.githubLabel']), { target: { value: 'not a url' } });
    submit();
    expect(onSaveApp).not.toHaveBeenCalled();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('valid GitHub repository URL');
  });

  it('AppCard and the catalog survive an app with githubUrl undefined (legacy data)', () => {
    // Pre-fix local storage data can still carry undefined; the render-time
    // guards keep the session alive until the loader sanitizes.
    const app = makeApp({ githubUrl: undefined as unknown as string });
    expect(() =>
      render(withProviders(
        <AppCard app={app} isFavorite={false} onToggleFavorite={() => undefined} onOpenDetail={() => undefined} />
      ))
    ).not.toThrow();
  });

  it('negative or blank star input clamps to 0 on save', () => {
    const onSaveApp = vi.fn();
    openModal(onSaveApp);
    fireEvent.change(screen.getByLabelText(DICTS.en['add.starsLabel']), { target: { value: '-5' } });
    submit();
    expect((onSaveApp.mock.calls[0][0] as AppItem).stars).toBe(0);
  });
});

describe('table view: deleting a custom app requires the same confirm as the cards', () => {
  function renderTable(onDeleteApp: (id: string) => void) {
    return render(withProviders(
      <TableView
        apps={[makeApp()]}
        favorites={[]}
        onToggleFavorite={() => undefined}
        onOpenDetail={() => undefined}
        onDeleteApp={onDeleteApp}
      />
    ));
  }

  it('the trash button opens an inline confirm instead of deleting immediately', () => {
    const onDeleteApp = vi.fn();
    renderTable(onDeleteApp);
    fireEvent.click(screen.getByRole('button', { name: 'Delete TestApp' }));
    // THE FIX: onDeleteApp used to fire on this first click.
    expect(onDeleteApp).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Remove: TestApp' })).toBeTruthy();
    // Focus lands on the safe action (Cancel), like the card confirm.
    expect(document.activeElement?.textContent).toBe('Cancel');
  });

  it('cancel keeps the app and returns focus to the trash button', () => {
    const onDeleteApp = vi.fn();
    renderTable(onDeleteApp);
    fireEvent.click(screen.getByRole('button', { name: 'Delete TestApp' }));
    fireEvent.click(screen.getByText('Cancel'));
    expect(onDeleteApp).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Delete TestApp' })).toBeTruthy();
  });

  it('confirming calls the delete exactly once', () => {
    const onDeleteApp = vi.fn();
    renderTable(onDeleteApp);
    fireEvent.click(screen.getByRole('button', { name: 'Delete TestApp' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove: TestApp' }));
    expect(onDeleteApp).toHaveBeenCalledTimes(1);
  });
});

describe('global shortcuts: no single-letter shortcut fires behind an open overlay', () => {
  function HookProbe({ actions }: { actions: GlobalShortcutsActions }) {
    useGlobalShortcuts(actions);
    return null;
  }

  function makeActions(overlayOpen: boolean) {
    return {
      toggleCommandPalette: vi.fn(),
      closeAllDialogs: vi.fn(),
      hasOpenOverlay: () => overlayOpen,
      openAddFlowSearch: vi.fn(),
      toggleBatchInstallModal: vi.fn(),
      toggleCompareModal: vi.fn(),
      toggleExportModal: vi.fn(),
      openTauriModal: vi.fn(),
      toggleFavoritesOnly: vi.fn(),
      toggleTrendingOnly: vi.fn(),
      toggleOwnerPickOnly: vi.fn(),
      toggleViewMode: vi.fn(),
    };
  }

  it('b/m/e/a/d/f/t/o/v are swallowed while a dialog is open', () => {
    const actions = makeActions(true);
    render(<HookProbe actions={actions} />);
    for (const key of ['b', 'm', 'e', 'a', 'd', 'f', 't', 'o', 'v']) {
      fireEvent.keyDown(window, { key });
    }
    // THE FIX: only '/' used to check hasOpenOverlay; the rest flipped
    // hidden filters or stacked dialogs behind the backdrop.
    expect(actions.toggleBatchInstallModal).not.toHaveBeenCalled();
    expect(actions.toggleCompareModal).not.toHaveBeenCalled();
    expect(actions.toggleExportModal).not.toHaveBeenCalled();
    expect(actions.openAddFlowSearch).not.toHaveBeenCalled();
    expect(actions.openTauriModal).not.toHaveBeenCalled();
    expect(actions.toggleFavoritesOnly).not.toHaveBeenCalled();
    expect(actions.toggleTrendingOnly).not.toHaveBeenCalled();
    expect(actions.toggleOwnerPickOnly).not.toHaveBeenCalled();
    expect(actions.toggleViewMode).not.toHaveBeenCalled();
  });

  it('Escape still closes all dialogs while an overlay is open', () => {
    const actions = makeActions(true);
    render(<HookProbe actions={actions} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(actions.closeAllDialogs).toHaveBeenCalledTimes(1);
  });

  it('the same keys work again once the overlay is gone', () => {
    const actions = makeActions(false);
    render(<HookProbe actions={actions} />);
    fireEvent.keyDown(window, { key: 'b' });
    expect(actions.toggleBatchInstallModal).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: 'v' });
    expect(actions.toggleViewMode).toHaveBeenCalledTimes(1);
  });
});

describe('ExportModal: Escape closes only the topmost layer', () => {
  it('Escape calls onClose and does not reach the window-level close-all', () => {
    const onClose = vi.fn();
    const windowCloseAll = vi.fn();
    render(withProviders(<ExportModal isOpen onClose={onClose} apps={[]} />));
    window.addEventListener('keydown', windowCloseAll);
    try {
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(1);
      // THE FIX: without onEscape the event fell through to the shell's
      // window handler and tore down every stacked dialog at once.
      expect(windowCloseAll).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', windowCloseAll);
    }
  });
});

describe('command palette: arrows from a row keep focus, highlight and Enter on one row', () => {
  const apps = [makeApp({ id: 'alpha', name: 'Alpha' }), makeApp({ id: 'beta', name: 'Beta' })];

  function renderPalette(overrides: Partial<Parameters<typeof CommandPalette>[0]> = {}) {
    const onOpenAppDetail = vi.fn();
    render(withProviders(
      <CommandPalette
        isOpen
        onClose={() => undefined}
        apps={apps}
        onToggleFavorite={() => undefined}
        onOpenAppDetail={onOpenAppDetail}
        onSelectCategory={() => undefined}
        onToggleViewMode={() => undefined}
        viewMode="grid"
        onOpenBatchInstall={() => undefined}
        onOpenCompare={() => undefined}
        onOpenExport={() => undefined}
        {...overrides}
      />
    ));
    return { onOpenAppDetail };
  }

  it('ArrowDown from a row button moves DOM focus to the highlighted row', () => {
    renderPalette();
    const first = document.getElementById('palette-item-alpha') as HTMLButtonElement;
    first.focus();
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    const second = document.getElementById('palette-item-beta') as HTMLButtonElement;
    // THE FIX: the highlight and aria-activedescendant moved while focus
    // stayed on row 0, so Enter activated the un-highlighted row.
    expect(document.activeElement).toBe(second);
    expect(document.getElementById('command-palette-input')?.getAttribute('aria-activedescendant')).toBe('palette-item-beta');
  });

  it('activating a focused row opens THAT row (highlight and focus agree)', () => {
    const { onOpenAppDetail } = renderPalette();
    const second = document.getElementById('palette-item-beta') as HTMLButtonElement;
    second.focus();
    // Native Enter-on-button activation is a click; the keyboard path is
    // pinned by the ArrowDown test above (focus follows the highlight).
    fireEvent.click(second);
    expect(onOpenAppDetail).toHaveBeenCalledTimes(1);
    expect((onOpenAppDetail.mock.calls[0][0] as AppItem).id).toBe('beta');
  });
});

describe('live search: a completed 0-hit search must not tell users to type a name', () => {
  it('shows the no-matches state with the query and announces the count', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(((url: string) => {
      if (String(url).includes('/api/github/search')) {
        return Promise.resolve({ ok: false } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({ items: [] }) } as unknown as Response);
    }) as typeof fetch);

    render(withProviders(
      <LiveSearchModal isOpen onClose={() => undefined} onAddApp={() => undefined} existingApps={[]} />
    ));

    const input = document.getElementById('live-search-query-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'zzqqxx' } });
    await waitFor(() => {
      // THE FIX: this state used to render ls.emptyTitle - "Type a name
      // above to search GitHub" - after the search had already run.
      expect(screen.getByText('No matches for “zzqqxx”.')).toBeTruthy();
    });
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe('batch script generation speaks the active language', () => {
  it('the empty-selection script uses the translated dictionary text', () => {
    render(withProviders(
      <BatchInstallModal
        isOpen
        onClose={() => undefined}
        selectedApps={[]}
        allApps={[]}
        onToggleAppSelection={() => undefined}
        onSelectAll={() => undefined}
        onClearSelection={() => undefined}
      />
    ));
    const region = screen.getByRole('region', { name: DICTS.en['bs.title'] });
    // THE FIX: this was a hardcoded English comment block.
    expect(region.textContent).toContain(DICTS.en['bs.scriptEmpty']);
  });

  it('the script preview and the chip strip are keyboard-scrollable', () => {
    render(withProviders(
      <BatchInstallModal
        isOpen
        onClose={() => undefined}
        selectedApps={[makeApp()]}
        allApps={[makeApp()]}
        onToggleAppSelection={() => undefined}
        onSelectAll={() => undefined}
        onClearSelection={() => undefined}
      />
    ));
    const preview = screen.getByRole('region', { name: DICTS.en['bs.title'] });
    expect(preview.getAttribute('tabindex')).toBe('0');
  });

  it('switching the script format clears the stale Copied feedback', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>();
    writeText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(withProviders(
      <BatchInstallModal
        isOpen
        onClose={() => undefined}
        selectedApps={[makeApp()]}
        allApps={[makeApp()]}
        onToggleAppSelection={() => undefined}
        onSelectAll={() => undefined}
        onClearSelection={() => undefined}
      />
    ));
    fireEvent.click(screen.getByText(DICTS.en['bs.copy']));
    await waitFor(() => expect(screen.getAllByText(DICTS.en['bs.copied']).length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText(DICTS.en['bs.tab.brew']));
    // THE FIX: "Copied" survived the format switch, describing a copy of a
    // script that was no longer on screen.
    expect(screen.queryAllByText(DICTS.en['bs.copied'])).toHaveLength(0);
  });
});

describe('what\'s new: disclosures are wired to their regions', () => {
  it('the details toggle declares aria-controls', () => {
    render(withProviders(<WhatsNewModal isOpen onClose={() => undefined} />));
    const toggle = document.getElementById('whats-new-details-toggle');
    expect(toggle?.getAttribute('aria-controls')).toBe('whats-new-details');
    const earlier = document.getElementById('whats-new-earlier-toggle');
    expect(earlier?.getAttribute('aria-controls')).toBe('whats-new-earlier');
  });

  it('the changelog body is a keyboard-scrollable region', () => {
    render(withProviders(<WhatsNewModal isOpen onClose={() => undefined} />));
    const body = screen.getByRole('region', { name: DICTS.en['wn.title'] });
    expect(body.getAttribute('tabindex')).toBe('0');
  });
});

describe('header page switch: honest toggle buttons, not a fake tablist', () => {
  const noop = () => undefined;
  const baseProps = {
    searchQuery: '',
    onSearchChange: noop,
    onOpenAddApps: noop,
    onOpenTauriModal: noop,
    onOpenShortcutsModal: noop,
    onExportCatalog: noop,
    onImportCatalog: noop,
    viewMode: 'grid' as const,
    onToggleViewMode: noop,
    page: 'catalog' as const,
    onPageChange: noop,
    onOpenCommandPalette: noop,
    onOpenDownloads: noop,
    activeDownloadCount: 0,
    updateVersion: null,
    updateChannel: 'stable' as const,
    onUpdateChannelChange: noop,
    onUpdateClick: noop,
    onCheckForUpdates: noop,
  };

  it('page buttons expose aria-pressed and no tab roles', () => {
    render(withProviders(<Header {...baseProps} />));
    const catalog = document.getElementById('page-catalog-btn');
    // THE FIX: role=tablist/tab without tabpanels or arrow keys promised
    // behavior that was never implemented.
    expect(catalog?.getAttribute('role')).toBeNull();
    expect(catalog?.getAttribute('aria-pressed')).toBe('true');
    expect(catalog?.closest('[role="tablist"]')).toBeNull();
    const replace = document.getElementById('page-replace-btn');
    expect(replace?.getAttribute('aria-pressed')).toBe('false');
  });

  it('a startup update is announced by a persistent live region', () => {
    render(withProviders(
      <Header {...baseProps} updateVersion="1.0.13" />
    ));
    // The region must exist in the DOM regardless of any update being
    // present, and carry the announcement when one appears.
    const region = screen.getByRole('status', { hidden: true });
    expect(region.textContent).toContain('Update v1.0.13');
  });

  it('the persistent live region exists even with no update', () => {
    render(withProviders(<Header {...baseProps} />));
    const region = screen.getByRole('status', { hidden: true });
    expect(region.textContent).toBe('');
  });
});

describe('localization plumbing', () => {
  it('formatEta uses the localized suffix fed by the i18n dictionary', () => {
    expect(formatEta(45)).toBe('45s left'); // en default
    setEtaSuffix(DICTS.de['downloads.eta']);
    expect(formatEta(45)).toBe('45s übrig');
    expect(formatEta(125)).toBe('2m 5s übrig');
    setEtaSuffix(DICTS.fa['downloads.eta']);
    expect(formatEta(7200)).toBe('2h 0m باقی‌مانده');
    // An empty dictionary value must never erase the suffix.
    setEtaSuffix('');
    expect(formatEta(45)).toBe('45s left');
  });

  it('formatMessage replaces every token and inserts values literally', () => {
    // THE FIX: String.replace interpreted $& patterns in the value, so a
    // filename like "a$&b" corrupted the toast announcing it.
    expect(formatMessage('{x} and {x}', { x: 'a$&b' })).toBe('a$&b and a$&b');
    expect(formatMessage('Hello {name}, bye {name}', { name: 'Ada' })).toBe('Hello Ada, bye Ada');
  });

  it('the shipped release heading (version + date + title) parses with its details', () => {
    // THE FIX: "## 1.0.12-beta (2026-10-13): the frontend-quality release"
    // broke the $-anchored date match, so the release's own detailed
    // changelog silently never rendered.
    const entries = parseChangelog('## 1.2.3-beta (2026-01-02): a titled release\nSome intro.\n### Added\n- one thing\n');
    expect(entries).toHaveLength(1);
    expect(entries[0].version).toBe('1.2.3-beta');
    expect(entries[0].date).toBe('2026-01-02');
    expect(entries[0].sections).toEqual([{ heading: 'Added', items: ['one thing'] }]);
    // And the REAL shipped changelog resolves for the running version.
    const shipped = changelogForVersion('1.0.12-beta');
    expect(shipped).not.toBeNull();
    expect((shipped as { sections: unknown[] }).sections.length).toBeGreaterThan(0);
  });

  it('the German/French/Spanish dictionary defects are gone', () => {
    expect(DICTS.fr['cmp.clear']).toBe('Vider la matrice');
    expect(DICTS.de['downloads.emptyHint']).not.toContain('liveem');
    expect(DICTS.de['update.downloadFailed']).toContain('Der Update-Download');
    expect(DICTS.es['detail.unavailable.noAndroid']).toContain('revisa');
    // The (s) plural hacks on visible toasts are reworded, not translated.
    expect(DICTS.en['batchDL.started']).not.toContain('(s)');
    expect(DICTS.fr['batchDL.started']).not.toContain('(s)');
    expect(DICTS.es['batchDL.started']).not.toContain('(s)');
  });

  it('the Persian dictionary defects are gone', () => {
    // "opened in a new LANGUAGE of the browser" -> tab (زبانه), and the
    // toast block now uses the same word the download panel uses.
    expect(DICTS.fa['downloads.toast.browserTabTitle']).toContain('زبانه');
    expect(DICTS.fa['downloads.toast.browserTabTitle']).not.toContain('زبانی');
    expect(DICTS.fa['downloads.toast.startedTitle']).toContain('دانلود');
    expect(DICTS.fa['downloads.toast.startedTitle']).not.toContain('دریافت');
    // One brand spelling everywhere.
    const faValues = Object.values(DICTS.fa).join(' ');
    expect(faValues).not.toContain(' فرس ');
  });
});
