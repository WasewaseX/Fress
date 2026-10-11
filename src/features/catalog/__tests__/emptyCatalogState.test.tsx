// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
// @vitest-environment jsdom
//
/**
 * EmptyCatalogState contract (Task 7):
 *   1. FILTERED-EMPTY (totalCount > 0, filters hide everything): the copy
 *      says the catalog HAS apps and the filters hide them; Reset Filters
 *      is the primary recovery action and Add App is secondary.
 *   2. GENUINELY EMPTY (totalCount === 0): the filters story is dropped
 *      (resetting cannot help), the copy explains the catalog itself is
 *      empty, and Add App becomes the primary action. No Reset button.
 *
 * A loading/ERROR state is deliberately NOT added: useAppCatalog degrades
 * (bundled catalog + localStorage fallbacks) and never surfaces a resolver
 * error into the catalog body, so an error-shaped empty state would be a
 * fiction. If a real error state is ever introduced, this test file is
 * where its contract belongs.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup, render, fireEvent } from '@testing-library/react';
import { EmptyCatalogState } from '../EmptyCatalogState';
import { I18nProvider } from '../../../lib/i18n';

afterEach(cleanup);

function renderEmpty(props: Parameters<typeof EmptyCatalogState>[0]) {
  return render(
    <I18nProvider>
      <EmptyCatalogState {...props} />
    </I18nProvider>
  );
}

describe('EmptyCatalogState', () => {
  it('filtered-empty: explains the filter story and ranks Reset first', () => {
    const onReset = vi.fn();
    const onAdd = vi.fn();
    renderEmpty({ onResetFilters: onReset, onAddApp: onAdd, totalCount: 75 });

    const title = document.getElementById('empty-state-title')!;
    expect(title.textContent).toMatch(/filter/i);
    expect(document.getElementById('empty-state-desc')!.textContent).toMatch(/catalog has apps/i);
    // Both recovery actions exist, Reset rendered BEFORE Add (primary first).
    const actions = document.getElementById('empty-state-actions')!;
    const buttons = Array.from(actions.querySelectorAll('button'));
    expect(buttons[0]?.id).toBe('empty-reset-filters-btn');
    expect(document.getElementById('empty-add-app-btn')).not.toBeNull();

    fireEvent.click(document.getElementById('empty-reset-filters-btn')!);
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(onAdd).not.toHaveBeenCalled();
    cleanup();
  });

  it('genuinely empty: no Reset (it cannot help), Add App is the primary action', () => {
    const onReset = vi.fn();
    const onAdd = vi.fn();
    renderEmpty({ onResetFilters: onReset, onAddApp: onAdd, totalCount: 0 });

    const title = document.getElementById('empty-state-title')!;
    expect(title.textContent).not.toMatch(/filter/i);
    expect(document.getElementById('empty-state-desc')!.textContent).toMatch(/catalog/i);
    expect(document.getElementById('empty-reset-filters-btn')).toBeNull();
    expect(document.getElementById('empty-add-app-btn')).not.toBeNull();

    fireEvent.click(document.getElementById('empty-add-app-btn')!);
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onReset).not.toHaveBeenCalled();
  });
});
