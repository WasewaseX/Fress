// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
// @vitest-environment jsdom
//
// Regression pins for the frontend quality pass. Each test names the exact
// defect it locks shut:
//  - useLiveStars repo-switch reset (the detail modal kept showing app A's
//    star count for app B when B's own lookup never answered);
//  - the OfflineIndicator live region existing in the DOM BEFORE the
//    offline state it announces (a conditionally-mounted role=status is
//    unreliable for screen readers);
//  - useCompareSelection.setIds announcing the silent truncation instead
//    of dropping apps 5+ with no feedback (and its side effects living
//    OUTSIDE the state updaters, which StrictMode double-invokes).

import { cleanup, render, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../lib/i18n';
import { useLiveStars } from '../starFetch';
import { OfflineIndicator } from '../../components/OfflineIndicator';
import { useCompareSelection } from '../../features/compare/useCompareSelection';

// Same sonner mock pattern as featuresToastLocalization.test.tsx: ESM
// namespace objects cannot be spied on, so the module is replaced whole.
const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: toastMock }));

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('useLiveStars: a repo switch must never keep the previous repo count', () => {
  const CACHE = 'fress.stars.v1';

  function Probe({ url }: { url?: string }) {
    const stars = useLiveStars(url);
    return <span data-testid="stars">{stars === null ? 'null' : String(stars)}</span>;
  }

  beforeEach(() => {
    // Any live fetch fails fast; the hook must stay correct without network.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network down'));
  });

  it('switching to an uncached repo resets to null instead of showing the old count', () => {
    localStorage.setItem(CACHE, JSON.stringify({ 'gh:a/b': { n: 1234, t: Date.now() } }));
    const { rerender, getByTestId } = render(<Probe url="https://github.com/a/b" />);
    expect(getByTestId('stars').textContent).toBe('1234');

    rerender(<Probe url="https://github.com/c/d" />);
    // THE FIX: without the reset effect, app B rendered 1234 indefinitely.
    expect(getByTestId('stars').textContent).toBe('null');
  });

  it("switching to a repo WITH a fresh cache shows that repo's own value", () => {
    localStorage.setItem(CACHE, JSON.stringify({
      'gh:a/b': { n: 1234, t: Date.now() },
      'gh:c/d': { n: 42, t: Date.now() },
    }));
    const { rerender, getByTestId } = render(<Probe url="https://github.com/a/b" />);
    expect(getByTestId('stars').textContent).toBe('1234');
    rerender(<Probe url="https://github.com/c/d" />);
    expect(getByTestId('stars').textContent).toBe('42');
  });

  it('clearing the repo (dialog closed) resets to null', () => {
    localStorage.setItem(CACHE, JSON.stringify({ 'gh:a/b': { n: 7, t: Date.now() } }));
    const { rerender, getByTestId } = render(<Probe url="https://github.com/a/b" />);
    expect(getByTestId('stars').textContent).toBe('7');
    rerender(<Probe url={undefined} />);
    expect(getByTestId('stars').textContent).toBe('null');
  });
});

describe('OfflineIndicator: the live region exists before it has anything to announce', () => {
  function renderIndicator(initialOnline: boolean) {
    const listeners: Record<string, () => void> = {};
    vi.spyOn(window, 'addEventListener').mockImplementation(((type: string, fn: EventListenerOrEventListenerObject) => {
      listeners[type] = fn as () => void;
    }) as never);
    vi.spyOn(window, 'removeEventListener').mockImplementation(() => {});
    const onlineGetter = vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(initialOnline);

    const utils = render(
      <I18nProvider>
        <OfflineIndicator />
      </I18nProvider>
    );

    return {
      ...utils,
      goOffline() {
        onlineGetter.mockReturnValue(false);
        act(() => { listeners['offline']?.(); });
      },
    };
  }

  it('role=status is mounted while online (empty content, hidden styling)', () => {
    const { container } = renderIndicator(true);
    const region = container.querySelector('#offline-indicator-banner');
    expect(region).not.toBeNull();
    expect(region!.getAttribute('role')).toBe('status');
    expect(region!.textContent).toBe('');
    expect(region!.className).toContain('sr-only');
  });

  it('going offline announces through the SAME region (no remount)', () => {
    const { container, goOffline } = renderIndicator(true);
    const regionBefore = container.querySelector('#offline-indicator-banner');
    goOffline();
    const regionAfter = container.querySelector('#offline-indicator-banner');
    // Same DOM node: the announcement rides a region that already existed.
    expect(regionAfter).toBe(regionBefore);
    expect(regionAfter!.textContent!.length).toBeGreaterThan(0);
    expect(regionAfter!.className).not.toContain('sr-only');
  });
});

describe('useCompareSelection: the batch shortcut must announce truncation', () => {
  const sixApps = Array.from({ length: 6 }, (_, i) => ({
    id: `app-${i}`,
    name: `App ${i}`,
  })) as never[];

  function runHarness(batches: string[][]) {
    let captured: ReturnType<typeof useCompareSelection>;
    function Harness() {
      captured = useCompareSelection(sixApps);
      return null;
    }
    render(
      <I18nProvider>
        <Harness />
      </I18nProvider>
    );
    act(() => {
      batches.forEach((batch) => captured!.setIds(batch));
    });
    return captured!;
  }

  it('setIds with more than MAX_COMPARE apps toasts the limit and keeps 4', () => {
    const sixIds = Array.from({ length: 6 }, (_, i) => `app-${i}`);
    const compare = runHarness([sixIds]);
    expect(toastMock.info).toHaveBeenCalled();
    expect(compare.comparedIds).toHaveLength(4);
  });

  it('setIds within the limit stays silent', () => {
    const compare = runHarness([['app-0', 'app-1']]);
    expect(toastMock.info).not.toHaveBeenCalled();
    expect(compare.comparedIds).toEqual(['app-0', 'app-1']);
  });
});
