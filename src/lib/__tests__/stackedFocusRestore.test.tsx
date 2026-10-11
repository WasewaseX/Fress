// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
// @vitest-environment jsdom
//
// Reproduction for the stacked-dialog focus restore observed in Chromium:
// opener button -> inner dialog -> palette on top; Escape closes the palette
// and focus must return to the control inside the inner dialog.

import React, { useState } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { keepFocusInside } from '../../lib/modalFocus';

afterEach(() => {
  cleanup();
  document.body.style.overflow = '';
});

const Panel: React.FC<{
  open: boolean;
  onClose?: () => void;
  testId: string;
  children?: React.ReactNode;
}> = ({ open, onClose, testId, children }) => {
  const ref = React.useRef<HTMLDivElement>(null);
  keepFocusInside(ref, open, { onEscape: onClose });
  if (!open) return null;
  return (
    <div ref={ref} data-testid={testId}>
      <button type="button" data-testid={`${testId}-ctrl`}>
        {testId} control
      </button>
      {children}
    </div>
  );
};

const Shell: React.FC = () => {
  const [detail, setDetail] = useState(false);
  const [palette, setPalette] = useState(false);
  return (
    <>
      <button type="button" data-testid="opener" onClick={() => setDetail(true)}>
        Open detail
      </button>
      <Panel open={detail} onClose={() => setDetail(false)} testId="detail">
        <button type="button" data-testid="open-palette" onClick={() => setPalette(true)}>
          Palette
        </button>
        <Panel open={palette} onClose={() => setPalette(false)} testId="palette" />
      </Panel>
    </>
  );
};

describe('stacked dialog focus restore', () => {
  it('Escape on the topmost dialog returns focus to the dialog beneath it', () => {
    const { getByTestId } = render(<Shell />);
    fireEvent.click(getByTestId('opener'));
    expect(document.activeElement).toBe(getByTestId('detail-ctrl'));
    fireEvent.click(getByTestId('open-palette'));
    expect(document.activeElement).toBe(getByTestId('palette-ctrl'));
    fireEvent.keyDown(getByTestId('palette'), { key: 'Escape' });
    expect(getByTestId('detail')).toBeTruthy();
    expect(document.activeElement).toBe(getByTestId('detail-ctrl'));
  });
});

/**
 * Destroyed-opener restore: a child dialog whose opener was REMOVED while
 * it stood open (a palette row consumed by Enter, a list entry unmounted
 * mid-flow) must still park focus inside the parent dialog on close -
 * never drop the keyboard user onto the page behind the parent.
 */
const VanishingOpenerShell: React.FC = () => {
  const [detail, setDetail] = useState(false);
  const [child, setChild] = useState(false);
  return (
    <>
      <button type="button" data-testid="outer-opener" onClick={() => setDetail(true)}>
        Open detail
      </button>
      <Panel open={detail} onClose={() => setDetail(false)} testId="detail2">
        {/*
          The child's opener only exists while the child is closed, exactly
          like a palette row that the activation itself removes.
        */}
        {!child && (
          <button type="button" data-testid="child-opener" onClick={() => setChild(true)}>
            Open child
          </button>
        )}
        <Panel open={child} onClose={() => setChild(false)} testId="child" />
      </Panel>
    </>
  );
};

describe('destroyed opener while stacked', () => {
  it('parks focus inside the parent dialog when the opener was removed', () => {
    const { getByTestId } = render(<VanishingOpenerShell />);
    fireEvent.click(getByTestId('outer-opener'));
    expect(document.activeElement).toBe(getByTestId('detail2-ctrl'));
    const childOpener = getByTestId('child-opener');
    fireEvent.click(childOpener);
    expect(document.activeElement).toBe(getByTestId('child-ctrl'));
    expect(childOpener.isConnected).toBe(false);
    // Escape closes the child; its opener is gone, so focus must land back
    // INSIDE the parent dialog, not on the page behind it.
    fireEvent.keyDown(document, { key: 'Escape' });
    const parent = getByTestId('detail2');
    const focusInsideParent = parent.contains(document.activeElement);
    expect(focusInsideParent).toBe(true);
    expect(document.activeElement).not.toBe(document.body);
  });
});
