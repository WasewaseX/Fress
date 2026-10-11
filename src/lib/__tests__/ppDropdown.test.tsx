// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
// @vitest-environment jsdom
//
// Keyboard contract of the Privacy Pack dropdown: open focuses the selected
// option, arrows/Home/End move through options, Enter activates, Escape and
// outside click close and hand focus back to the trigger, and the selected
// option is exposed with aria-selected.

import React, { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { PpDropdown, PpListboxOption } from '../../components/ReplaceTab';

afterEach(cleanup);

const OPTIONS: PpListboxOption[] = [
  { id: 'a', selected: false, content: <span>Alpha</span> },
  { id: 'b', selected: true, content: <span>Beta</span> },
  { id: 'c', selected: false, content: <span>Gamma</span> },
];

const Harness: React.FC<{ onPick?: (id: string) => void }> = ({ onPick }) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <PpDropdown
        open={open}
        onOpenChange={setOpen}
        triggerId="pp-trigger"
        triggerAriaLabel="Replace with: Mail"
        triggerContent="Choose a replacement"
        listboxId="pp-listbox"
        listboxLabel="Replace with: Mail"
        options={OPTIONS}
        onPick={onPick ?? (() => {})}
      />
    </div>
  );
};

const optId = (id: string) => `pp-listbox-opt-${id}`;

describe('PpDropdown', () => {
  it('exposes trigger semantics and opens with focus on the selected option', () => {
    const { getByRole } = render(<Harness />);
    const trigger = getByRole('button', { name: 'Replace with: Mail' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const listbox = getByRole('listbox', { name: 'Replace with: Mail' });
    expect(listbox).toBeDefined();
    // Focus lands on the currently-selected option (Beta), not the first.
    expect(document.activeElement).toBe(screen.getByText('Beta').closest('button'));
  });

  it('marks the selected option with aria-selected', () => {
    const { getByRole } = render(<Harness />);
    fireEvent.click(getByRole('button', { name: 'Replace with: Mail' }));
    expect(document.getElementById(optId('b'))?.getAttribute('aria-selected')).toBe('true');
    expect(document.getElementById(optId('a'))?.getAttribute('aria-selected')).toBe('false');
  });

  it('moves focus with ArrowDown/ArrowUp and activates with Enter', () => {
    const picked: string[] = [];
    const { getByRole } = render(<Harness onPick={(id) => picked.push(id)} />);
    fireEvent.click(getByRole('button', { name: 'Replace with: Mail' }));

    expect(document.activeElement).toBe(document.getElementById(optId('b')));
    fireEvent.keyDown(getByRole('listbox'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(document.getElementById(optId('c')));
    fireEvent.keyDown(getByRole('listbox'), { key: 'ArrowUp' });
    fireEvent.keyDown(getByRole('listbox'), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(document.getElementById(optId('a')));
    fireEvent.keyDown(getByRole('listbox'), { key: 'ArrowUp' });
    // Clamped at the first option, no wrap-around surprise.
    expect(document.activeElement).toBe(document.getElementById(optId('a')));
    fireEvent.keyDown(getByRole('listbox'), { key: 'End' });
    expect(document.activeElement).toBe(document.getElementById(optId('c')));
    fireEvent.keyDown(getByRole('listbox'), { key: 'Home' });
    expect(document.activeElement).toBe(document.getElementById(optId('a')));

    fireEvent.click(document.activeElement as Element);
    expect(picked).toEqual(['a']);
  });

  it('closes on Escape and restores focus to the trigger', () => {
    const { getByRole } = render(<Harness />);
    const trigger = getByRole('button', { name: 'Replace with: Mail' });
    fireEvent.click(trigger);
    expect(document.getElementById('pp-listbox')).not.toBeNull();
    fireEvent.keyDown(getByRole('listbox'), { key: 'Escape' });
    expect(document.getElementById('pp-listbox')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on outside click and restores focus to the trigger', () => {
    const { getByRole } = render(<Harness />);
    const trigger = getByRole('button', { name: 'Replace with: Mail' });
    fireEvent.click(trigger);
    // The fixed overlay under the listbox is the outside-click surface.
    const overlay = document.querySelector('.fixed.inset-0') as HTMLElement;
    expect(overlay).not.toBeNull();
    fireEvent.click(overlay);
    expect(document.getElementById('pp-listbox')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on Tab while letting focus move on (no focus trap)', () => {
    const { getByRole } = render(<Harness />);
    const trigger = getByRole('button', { name: 'Replace with: Mail' });
    fireEvent.click(trigger);
    fireEvent.keyDown(getByRole('listbox'), { key: 'Tab' });
    expect(document.getElementById('pp-listbox')).toBeNull();
  });
});
