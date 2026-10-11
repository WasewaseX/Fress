// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { RefObject, useEffect, useRef } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * Options for keepFocusInside. Everything is optional: the two-argument
 * call shape every existing dialog uses keeps working unchanged.
 */
export interface KeepFocusOptions {
  /**
   * Called when Escape is pressed while this panel is the topmost open
   * modal. Panels that opt in get one consistent Escape path: the innermost
   * open surface closes first, never two layers at once.
   */
  onEscape?: () => void;
  /**
   * A meaningful control to focus when the modal opens (the search input of
   * the palette, the primary action of a wizard). When it cannot be focused
   * the first tabbable control inside the panel is used, then the panel.
   */
  initialFocus?: RefObject<HTMLElement | null> | null;
}

/**
 * Stack of currently open modal panels. Only the TOPMOST panel may trap Tab
 * or answer Escape. Without this, two open surfaces (a palette launched
 * over a dialog, a popover rendered inside a modal) would run competing
 * focus traps against the same keystrokes and fight each other.
 */
const openPanels: HTMLElement[] = [];

/**
 * Refcounted background-scroll lock. Several modals can be open at once and
 * each calls keepFocusInside; the lock must only lift when the LAST one
 * closes. The body's previous overflow value is restored, never assumed.
 */
let scrollLockCount = 0;
let savedBodyOverflow: string | null = null;

function lockBackgroundScroll(): void {
  if (typeof document === 'undefined') return;
  scrollLockCount += 1;
  if (scrollLockCount > 1) return;
  savedBodyOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
}

function restoreBackgroundScroll(): void {
  if (typeof document === 'undefined' || scrollLockCount === 0) return;
  scrollLockCount -= 1;
  if (scrollLockCount > 0) return;
  document.body.style.overflow = savedBodyOverflow ?? '';
  savedBodyOverflow = null;
}

/**
 * Whether this environment actually lays elements out. jsdom (tests) never
 * produces client rects, so "zero rects" must not be read as "hidden"
 * there — probed once, lazily, with a known-visible element.
 */
let layoutProbe: boolean | null = null;
function layoutAvailable(): boolean {
  if (layoutProbe !== null) return layoutProbe;
  if (typeof document === 'undefined' || !document.body) {
    layoutProbe = false;
    return layoutProbe;
  }
  const probe = document.createElement('div');
  document.body.appendChild(probe);
  layoutProbe = probe.getClientRects().length > 0;
  probe.remove();
  return layoutProbe;
}

/**
 * A node counts as rendered, and therefore tabbable, when it is not
 * explicitly hidden: no [hidden] or aria-hidden ancestor, a computed
 * display that is not none, a visibility that is not hidden, and — in an
 * environment that lays out — at least one client rect (the reliable
 * real-browser signal for display:none subtrees, whose children still
 * report display:block from their own rules).
 */
function isRendered(el: HTMLElement): boolean {
  if (el.closest('[hidden]')) return false;
  if (el.closest('[aria-hidden="true"]')) return false;
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  if (layoutAvailable() && el.getClientRects().length === 0) return false;
  return true;
}

function visibleFocusable(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(isRendered);
}

/**
 * Keep keyboard focus inside an open modal.
 *
 * Remembers where the user was, moves focus into the panel when the modal
 * opens (preferring `options.initialFocus`), cycles Tab (and Shift+Tab)
 * within the panel while it stays open, answers Escape for panels that opt
 * in, locks background scrolling for as long as any modal is open, and
 * hands focus back to the original element on close when it still exists.
 * Without this, a keyboard or screen reader user who closes a modal lands
 * at the top of the page with no idea where they are.
 *
 * Panels that autofocus their own input (command palette, live search) keep
 * working: if focus already sits inside the panel when it opens, we leave
 * it alone. Nested surfaces do not compete: the topmost open panel owns Tab
 * and Escape until it closes.
 */
export function keepFocusInside(
  panelRef: RefObject<HTMLElement | null>,
  open: boolean,
  options: KeepFocusOptions = {}
): void {
  const { initialFocus } = options;
  // Latest-ref for onEscape: callers pass fresh closures every render, and
  // re-running the whole setup per render would re-capture focus state and
  // churn the open-panel stack for nothing.
  const escapeRef = useRef<(() => void) | undefined>(undefined);
  escapeRef.current = options.onEscape;
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
      const wanted = initialFocus?.current;
      const first =
        wanted && panel.contains(wanted) && isRendered(wanted)
          ? wanted
          : (visibleFocusable(panel)[0] ?? null);
      (first ?? panel).focus();
    }

    openPanels.push(panel);
    lockBackgroundScroll();

    const onKeyDown = (e: KeyboardEvent) => {
      // Only the innermost open modal answers: an outer dialog's trap must
      // never steal Tab or Escape while a surface above it is open.
      if (openPanels[openPanels.length - 1] !== panel) return;

      if (e.key === 'Escape') {
        if (escapeRef.current) {
          e.preventDefault();
          escapeRef.current();
        }
        return;
      }
      if (e.key !== 'Tab') return;

      const items = visibleFocusable(panel);
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

    // Document-level: also catches Tab/Escape when focus has slipped out of
    // the panel (a click on the backdrop leaves focus on body), so a lost
    // keyboard user can always Tab back in and Escape always reaches the
    // topmost dialog.
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const stackIndex = openPanels.lastIndexOf(panel);
      if (stackIndex !== -1) openPanels.splice(stackIndex, 1);
      restoreBackgroundScroll();
      // Two valid cases for pulling focus back: it still sits inside the
      // (by now removed) panel, or the panel's removal dropped it onto the
      // body, which is where focus lands when the element holding it leaves
      // the document. If the user already clicked somewhere else, leave them
      // where they are. A disconnected opener (its row was filtered away
      // while the dialog stood open) is skipped: focusing it would no-op.
      const active = document.activeElement;
      const stillInside = active instanceof Node && panel.contains(active);
      const fellBackToBody = active === document.body;
      const openerAlive =
        previouslyFocused !== null &&
        previouslyFocused instanceof HTMLElement &&
        previouslyFocused.isConnected;
      if ((stillInside || fellBackToBody) && openerAlive) {
        previouslyFocused.focus();
      }
    };
  }, [open, panelRef, initialFocus]);
}
