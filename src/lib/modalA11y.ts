import { useEffect, useRef } from 'react';

/**
 * Minimal modal accessibility helper:
 * - locks body scroll while open (and restores it only when the LAST open
 *   modal closes — stacked modals must not unlock the page for each other)
 * - moves focus into the dialog on open and restores it on close
 * - traps Tab (and Shift+Tab) inside the dialog, including when focus starts
 *   on the body/backdrop
 * - Escape closes only the TOPMOST modal: the capture listener is registered
 *   on `document` by every open modal, but only the one mounted LAST (the
 *   top of the stack) handles the key; the others never see it.
 *
 * Attach the returned ref to the dialog container element.
 */

/** Open-modal stack, most recently opened last. */
const openStack: symbol[] = [];

export function useModalA11y<T extends HTMLElement>(isOpen: boolean, onClose?: () => void) {
  const containerRef = useRef<T | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  // Keep the latest callback without re-running the effect on every render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen) return;
    const token = Symbol('modal');
    openStack.push(token);
    const previouslyFocused = document.activeElement as HTMLElement | null;
    restoreFocusRef.current = previouslyFocused;

    const container = containerRef.current;
    if (container) {
      if (!container.hasAttribute('tabindex')) container.setAttribute('tabindex', '-1');
      container.focus({ preventScroll: true });
    }
    // Only the FIRST modal to open over a scrollable page hides the body;
    // every stacked modal remembers the same restored value.
    const prevOverflow = document.body.style.overflow;
    if (openStack.length === 1) {
      document.body.style.overflow = 'hidden';
    }

    const onKeyDown = (e: KeyboardEvent) => {
      // Stacked modals: only the topmost open modal consumes Escape.
      if (openStack[openStack.length - 1] !== token) return;
      if (e.key === 'Escape' && onCloseRef.current) {
        e.stopImmediatePropagation();
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || !container) return;
      const focusables = Array.from(
        container.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (focusables.length === 0) {
        // Empty dialog: keep focus pinned to the container instead of
        // letting Tab escape to the page behind the modal.
        e.preventDefault();
        container.focus({ preventScroll: true });
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      const inside = active instanceof Node && container.contains(active);
      if (!inside) {
        // Focus on body/backdrop: pull it into the dialog instead of
        // letting the first Tab jump to the header behind the modal.
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      const idx = openStack.indexOf(token);
      if (idx >= 0) openStack.splice(idx, 1);
      // Restore page scrolling only when no modal is stacked above anymore.
      if (openStack.length === 0) {
        document.body.style.overflow = prevOverflow;
      }
      restoreFocusRef.current?.focus?.({ preventScroll: true });
    };
  }, [isOpen]);

  return containerRef;
}
