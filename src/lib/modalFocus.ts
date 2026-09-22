// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { RefObject, useEffect } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * Keep keyboard focus inside an open modal.
 *
 * Remembers where the user was, moves focus into the panel when the modal
 * opens, cycles Tab (and Shift+Tab) within the panel while it stays open,
 * and hands focus back to the original element on close. Without this, a
 * keyboard or screen reader user who closes a modal lands at the top of
 * the page with no idea where they are.
 *
 * Panels that autofocus their own input (command palette, live search) keep
 * working: if focus already sits inside the panel when it opens, we leave
 * it alone.
 */
export function keepFocusInside(panelRef: RefObject<HTMLElement | null>, open: boolean): void {
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // The panel itself becomes a valid focus target as a last resort.
    panel.tabIndex = -1;

    const focusAlreadyInside =
      previouslyFocused !== null && panel.contains(previouslyFocused);
    if (!focusAlreadyInside) {
      const first = panel.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? panel).focus();
    }

    const isRendered = (el: HTMLElement): boolean => el.getClientRects().length > 0;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(isRendered);
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const escaped = !(active instanceof Node) || !panel.contains(active);
      if (e.shiftKey) {
        if (active === first || escaped) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || escaped) {
        e.preventDefault();
        first.focus();
      }
    };

    panel.addEventListener('keydown', onKeyDown);

    return () => {
      panel.removeEventListener('keydown', onKeyDown);
      // Two valid cases for pulling focus back: it still sits inside the
      // (by now removed) panel, or the panel's removal dropped it onto the
      // body, which is where focus lands when the element holding it leaves
      // the document. If the user already clicked somewhere else, leave them
      // where they are.
      const active = document.activeElement;
      const stillInside = active instanceof Node && panel.contains(active);
      const fellBackToBody = active === document.body;
      if (stillInside || fellBackToBody) {
        previouslyFocused?.focus();
      }
    };
  }, [open, panelRef]);
}
