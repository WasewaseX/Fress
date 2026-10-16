// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
// @vitest-environment jsdom
/**
 * Interpolation safety for the UI strings the reader actually sees.
 *
 * JavaScript's String.prototype.replace interprets $-patterns inside the
 * REPLACEMENT value: replace('{name}', 'a$&b') renders "a{name}b" because
 * $& means "the matched token". App names, repository names and vendor
 * names are data (user-added apps type them freely), so every owned call
 * site was moved to the shared formatter formatMessage - the value is
 * inserted literally, every occurrence replaced.
 *
 * The formatter itself was hardened twice: the first version (split/join
 * per token) dodged the $-patterns but re-scanned text inserted by an
 * earlier pass with the later tokens' patterns - a custom app named
 * "X {host} Y" rendered through a {name}/{host} template had its literal
 * "{host}" swapped for the real host. The current implementation scans the
 * template once and inserts every value through a function replacer (a
 * literal insertion by specification), so NO inserted text is ever
 * re-scanned.
 *
 * Two layers are pinned:
 *   1. the primitive itself, against every hostile value class the spec
 *      names ($&, $$, $', $`, braces, percent signs, paths, apostrophes,
 *      RTL/Unicode names);
 *   2. a REAL owned component (TableView renders 10 of the former replace
 *      call sites) fed an app whose name carries the worst of them.
 *
 * KILL-TEST REVIEW: reverting any owned call site back to
 * t(key).replace('{token}', value) makes the component assertions below
 * fail immediately - the label renders "a{name}b" (the matched token
 * substituted for $&) instead of the literal app name. The primitive
 * assertions fail against a naive replace-based reimplementation too, and
 * the no-re-scan block below fails against the old per-token split/join
 * implementation (its later passes substitute tokens inside earlier
 * values).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

import { formatMessage, DICTS } from '../i18n';
import { ThemeProvider } from '../../components/ThemeProvider';
import { DownloadsProvider } from '../downloads';
import { I18nProvider } from '../i18n';
import type { AppItem } from '../../types';
import { TableView } from '../../components/TableView';

/* ------------------------------------------------------------------ */
/* Layer 1: the shared primitive                                       */
/* ------------------------------------------------------------------ */

describe('formatMessage inserts every value literally (single-pass semantics)', () => {
  const template = 'Do {name} now ({name})';

  it.each([
    ['replacement-pattern dollars', 'a$&b'],
    ['escaped dollar', 'costs 5$$ total'],
    ["$' (tail of template)", "x$'y"],
    ['$` (head of template)', 'x$`y'],
    ['braces', '{name} {v} {}'],
    ['percent signs', '100% done %s %d'],
    ['windows path', 'C:\\Users\\Ada\\AppData\\Local'],
    ['apostrophes', "Ada's app $& it's"],
    ['rtl name', 'سلام $& نام'],
    ['newline and tab', 'line1\nline2\ttab'],
  ])('survives %s', (_label, value) => {
    expect(formatMessage(template, { name: value })).toBe(`Do ${value} now (${value})`);
  });

  it('replaces EVERY occurrence of a token (the old single-replace defect)', () => {
    expect(formatMessage('{x} and {x} and {x}', { x: 'v' })).toBe('v and v and v');
  });

  it('an empty value still replaces the token', () => {
    expect(formatMessage('a{name}b', { name: '' })).toBe('ab');
  });

  it('the en dictionary placeholders themselves are never $-corrupted', () => {
    // Guards the templates, not the values: an en string containing "$&"
    // next to a placeholder must keep both intact after a plain value pass.
    const out = formatMessage('Use {v} ($& means matched text) {v}', { v: '1.0' });
    expect(out).toBe('Use 1.0 ($& means matched text) 1.0');
  });

  it('no values means the template passes through untouched', () => {
    expect(formatMessage('plain {name} template', {})).toBe('plain {name} template');
  });
});

describe('formatMessage never re-scans inserted values (single pass over all tokens)', () => {
  it('a value containing a LATER token of the same call stays literal', () => {
    // The split/join implementation ran one pass per token: the {name}
    // pass inserted "X {host} Y", then the {host} pass substituted the
    // text the NAME contributed. A custom app name is user data - the
    // rendered label must carry it verbatim.
    const out = formatMessage('A {name} B {host}', { name: 'X {host} Y', host: 'example.com' });
    expect(out).toBe('A X {host} Y B example.com');
  });

  it('a value containing its OWN token stays literal (no self-substitution)', () => {
    expect(formatMessage('Remove {name}?', { name: '{name}' })).toBe('Remove {name}?');
  });

  it('a value carrying several tokens of the template stays verbatim', () => {
    const out = formatMessage('{name} vs {host}', {
      name: 'app {host} and {name}',
      host: 'gitlab.com',
    });
    expect(out).toBe('app {host} and {name} vs gitlab.com');
  });

  it('prefix-overlapping token names substitute exactly themselves', () => {
    // {v} is a prefix of {version}: the combined single scan must not let
    // {v} consume the opening of {version} (both are brace-anchored).
    const out = formatMessage('{v} then {version}', { v: '1.0', version: '2.0' });
    expect(out).toBe('1.0 then 2.0');
  });

  it('the real TableView multi-token site renders a token-shaped app name verbatim', () => {
    // End-to-end shape of the defect: card.source.aria carries {name} AND
    // {host}; a user app literally named "{host}" must reach the aria-label
    // as the name, not be replaced by the host label. The oracle builds the
    // expectation with a sentinel so the NAME contribution is never
    // re-scanned (a naive split/join oracle would itself corrupt it).
    const appName = '{host}';
    const sentinel = '@@APPNAME@@';
    const en = DICTS.en;
    const expected = en['card.source.aria']
      .split('{name}')
      .join(sentinel)
      .split('{host}')
      .join('GitHub')
      .split(sentinel)
      .join(appName);
    expect(expected).toContain('GitHub');
    expect(expected).toContain('{host}');
    expect(
      formatMessage(en['card.source.aria'], { name: appName, host: 'GitHub' })
    ).toBe(expected);
  });
});

/* ------------------------------------------------------------------ */
/* Layer 2: a real owned component with a hostile app name             */
/* ------------------------------------------------------------------ */

const HOSTILE = 'a$&b$\'c$`d%e{f}g';

function makeApp(overrides: Partial<AppItem> = {}): AppItem {
  return {
    id: 'app-hostile',
    name: HOSTILE,
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
    proprietaryAlternative: 'ClosedApp $& Pro',
    ...overrides,
  };
}

function withProviders(ui: React.ReactElement): React.ReactElement {
  return (
    <I18nProvider>
      <ThemeProvider>
        <DownloadsProvider>{ui}</DownloadsProvider>
      </ThemeProvider>
    </I18nProvider>
  );
}

describe('TableView renders hostile app names literally in every exposed label', () => {
  afterEach(cleanup);

  it('aria-labels and the sr-only confirm text carry the raw name', () => {
    render(
      withProviders(
        <TableView
          apps={[makeApp()]}
          favorites={[]}
          onToggleFavorite={() => undefined}
          onOpenDetail={() => undefined}
          onDeleteApp={() => undefined}
          onToggleBatchSelect={() => undefined}
        />
      )
    );
    const en = DICTS.en;
    /** The full expected accessible name, built with literal split/join
     * semantics (the same contract the component must honor). */
    const label = (key: string) => en[key].split('{name}').join(HOSTILE);

    // Favorite toggle (ariaOff carries {name}); exact accessible name, so a
    // corrupted value (the name replaced by the matched-token expansion)
    // fails the query itself.
    const fav = screen.getByRole('button', { name: label('card.fav.ariaOff') });
    expect(fav.getAttribute('aria-label')).toContain(HOSTILE);
    expect(fav.getAttribute('aria-label')).not.toContain('{name}');

    // Batch-select checkbox (a real input, hence the checkbox role).
    const batch = screen.getByRole('checkbox', { name: label('card.batch.aria') });
    expect(batch.getAttribute('aria-label')).toContain(HOSTILE);

    // Website link title/aria (an <a>, hence the link role).
    const site = screen.getByRole('link', { name: label('table.website.aria') });
    expect(site.getAttribute('aria-label')).toContain(HOSTILE);

    // Source-code link label carries BOTH tokens ({name} and {host}); the
    // host slot is filled by the link's own host label (GitHub here), an
    // <a>, hence the link role.
    const source = screen.getByRole('link', { name: label('card.source.aria').split('{host}').join('GitHub') });
    expect(source.getAttribute('aria-label')).toContain(HOSTILE);
    expect(source.getAttribute('aria-label')).not.toContain('{host}');

    // The delete button and the sr-only delete confirmation sentence.
    const del = screen.getByRole('button', { name: label('card.delete.aria') });
    expect(del.getAttribute('aria-label')).toContain(HOSTILE);

    // The proprietary-alternative cell is data too.
    expect(document.body.textContent).toContain('ClosedApp $& Pro');
  });

  it('the inline delete confirm names the app exactly once the flow opens', () => {
    render(
      withProviders(
        <TableView
          apps={[makeApp()]}
          favorites={[]}
          onToggleFavorite={() => undefined}
          onOpenDetail={() => undefined}
          onDeleteApp={() => undefined}
          onToggleBatchSelect={() => undefined}
        />
      )
    );
    const en = DICTS.en;
    const del = screen.getByRole('button', { name: en['card.delete.aria'].split('{name}').join(HOSTILE) });
    fireEvent.click(del);
    // "Remove {name} from your library? ..." with the literal hostile name.
    expect(screen.getByText(new RegExp(en['card.deleteConfirm'].split('{name}')[0]))).toBeTruthy();
    expect(document.body.textContent).toContain(HOSTILE);
    expect(document.body.textContent).not.toContain('a{name}b');
  });
});
