// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
// @vitest-environment jsdom
//
// Behavior contract of src/lib/modalFocus.ts: initial focus (skipping
// hidden controls, honoring initialFocus), the Tab cycle, Escape via the
// topmost-open-modal rule, the refcounted body scroll lock, and focus
// restoration to a still-connected opener (never to a removed one).

import React, { useRef } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { keepFocusInside, KeepFocusOptions } from '../modalFocus';

afterEach(() => {
  cleanup();
  document.body.style.overflow = '';
  document.body.innerHTML = '';
});

/** Minimal dialog shell wired to keepFocusInside. */
const Probe: React.FC<{ open: boolean; opts?: KeepFocusOptions; testId?: string }> = ({
  open,
  opts,
  testId = 'panel',
}) => {
  const ref = useRef<HTMLDivElement>(null);
  keepFocusInside(ref, open, opts);
  if (!open) return null;
  return (
    <div ref={ref} data-testid={testId}>
      <button type="button" data-testid={`${testId}-first`}>
        First
      </button>
      <button type="button" data-testid={`${testId}-hidden`} style={{ display: 'none' }}>
        Hidden
      </button>
      <button type="button" data-testid={`${testId}-last`}>
        Last
      </button>
    </div>
  );
};

describe('keepFocusInside', () => {
  it('focuses the first rendered focusable control on open and skips hidden ones', () => {
    const { getByTestId } = render(<Probe open />);
    expect(document.activeElement).toBe(getByTestId('panel-first'));
  });

  it('focuses options.initialFocus when provided and rendered inside the panel', () => {
    const target = React.createRef<HTMLButtonElement>() as React.RefObject<HTMLButtonElement | null>;
    const WithTarget: React.FC = () => {
      const ref = useRef<HTMLDivElement>(null);
      keepFocusInside(ref, true, { initialFocus: target });
      return (
        <div ref={ref}>
          <button type="button" data-testid="a">
            A
          </button>
          <button type="button" ref={target} data-testid="b">
            B
          </button>
        </div>
      );
    };
    const { getByTestId } = render(<WithTarget />);
    expect(document.activeElement).toBe(getByTestId('b'));
  });

  it('cycles Tab forward and backward within the panel', () => {
    const { getByTestId } = render(<Probe open />);
    const first = getByTestId('panel-first');
    const last = getByTestId('panel-last');
    last.focus();
    fireEvent.keyDown(getByTestId('panel'), { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(getByTestId('panel'), { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('calls onEscape when Escape is pressed while the panel is topmost', () => {
    const onEscape = vi.fn();
    const { getByTestId } = render(<Probe open opts={{ onEscape }} />);
    fireEvent.keyDown(getByTestId('panel'), { key: 'Escape' });
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('only the topmost open modal answers Escape (no competing traps)', () => {
    const escapeA = vi.fn();
    const escapeB = vi.fn();
    const { getByTestId } = render(
      <>
        <Probe open opts={{ onEscape: escapeA }} testId="a" />
        <Probe open opts={{ onEscape: escapeB }} testId="b" />
      </>
    );
    fireEvent.keyDown(getByTestId('b'), { key: 'Escape' });
    expect(escapeB).toHaveBeenCalledTimes(1);
    expect(escapeA).not.toHaveBeenCalled();
  });

  it('a dialog that ANSWERS Escape stops it from reaching the shell-wide close-all handler', () => {
    // The app registers a global window Escape handler (close every dialog).
    // One press must close ONE layer: the topmost dialog answers and stops
    // the event, so the shell handler never sees it.
    const windowEscape = vi.fn();
    window.addEventListener('keydown', windowEscape);
    try {
      const onEscape = vi.fn();
      const { getByTestId } = render(<Probe open opts={{ onEscape }} />);
      fireEvent.keyDown(getByTestId('panel'), { key: 'Escape' });
      expect(onEscape).toHaveBeenCalledTimes(1);
      expect(windowEscape).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', windowEscape);
    }
  });

  it('a dialog WITHOUT onEscape leaves Escape to the shell-wide handler', () => {
    const windowEscape = vi.fn();
    window.addEventListener('keydown', windowEscape);
    try {
      const { getByTestId } = render(<Probe open />);
      fireEvent.keyDown(getByTestId('panel'), { key: 'Escape' });
      expect(windowEscape).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('keydown', windowEscape);
    }
  });

  it('locks body scroll while open and restores the previous value on close', () => {
    document.body.style.overflow = 'scroll';
    const { rerender } = render(<Probe open />);
    expect(document.body.style.overflow).toBe('hidden');
    rerender(<Probe open={false} />);
    expect(document.body.style.overflow).toBe('scroll');
  });

  it('keeps the lock while any modal is open (refcounted)', () => {
    const { rerender } = render(
      <>
        <Probe open testId="a" />
        <Probe open testId="b" />
      </>
    );
    rerender(
      <>
        <Probe open={false} testId="a" />
        <Probe open testId="b" />
      </>
    );
    expect(document.body.style.overflow).toBe('hidden');
    rerender(<Probe open={false} testId="b" />);
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  it('restores focus to the opener on close when it is still connected', () => {
    const Harness: React.FC<{ open: boolean }> = ({ open }) => (
      <>
        <button type="button" data-testid="opener">
          Opener
        </button>
        <Probe open={open} />
      </>
    );
    const { getByTestId, rerender } = render(<Harness open={false} />);
    const opener = getByTestId('opener');
    opener.focus();
    rerender(<Harness open />);
    expect(document.activeElement).toBe(getByTestId('panel-first'));
    rerender(<Harness open={false} />);
    expect(document.activeElement).toBe(opener);
  });

  it('does not restore focus to an opener that left the document while open', () => {
    // The opener only exists while the dialog is closed - like a catalog
    // card that gets filtered away while its detail dialog stands open.
    const Harness: React.FC<{ open: boolean }> = ({ open }) => (
      <>
        {!open && (
          <button type="button" data-testid="opener">
            Opener
          </button>
        )}
        <Probe open={open} />
      </>
    );
    const { getByTestId, rerender } = render(<Harness open={false} />);
    const opener = getByTestId('opener');
    opener.focus();
    rerender(<Harness open />);
    expect(opener.isConnected).toBe(false);
    expect(document.activeElement).toBe(getByTestId('panel-first'));
    rerender(<Harness open={false} />);
    expect(document.activeElement).not.toBe(opener);
  });
});
