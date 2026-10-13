// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import { useEffect, useRef } from 'react';

/**
 * Global keyboard navigation & accessibility shortcuts.
 *
 * Exact behavior carried over from the monolithic App:
 * - Cmd/Ctrl+K toggles the command palette anywhere (browser combos win
 *   while a text field is focused only via the INPUT guard below);
 * - inside INPUT/TEXTAREA/SELECT, only Escape blurs - no shortcut swallows
 *   typing;
 * - single-letter shortcuts never run with Ctrl/Cmd/Alt held (Ctrl+A,
 *   Ctrl+F, Ctrl/D belong to the browser);
 * - '/' focuses the catalog search, Escape closes every transient surface,
 *   a/b/m/e/d toggle the add/batch/compare/export/tauri dialogs, f/t/o flip
 *   the favorites/trending/owner-pick filters, v flips grid/table.
 *
 * The actions are read through a ref, so the listener is registered once
 * while always acting on the current render's state (the old effect
 * re-registered on every filters/viewMode change to the same effect).
 */

export interface GlobalShortcutsActions {
  toggleCommandPalette: () => void;
  closeAllDialogs: () => void;
  /** True while any modal/panel is open (see useAppDialogs.anyOverlayOpen). */
  hasOpenOverlay: () => boolean;
  openAddFlowSearch: () => void;
  toggleBatchInstallModal: () => void;
  toggleCompareModal: () => void;
  toggleExportModal: () => void;
  openTauriModal: () => void;
  toggleFavoritesOnly: () => void;
  toggleTrendingOnly: () => void;
  toggleOwnerPickOnly: () => void;
  toggleViewMode: () => void;
}

export function useGlobalShortcuts(actions: GlobalShortcutsActions): void {
  // Latest actions without re-registering the listener: the shortcuts stay
  // responsive to the current filters/viewMode exactly like before.
  const ref = useRef(actions);
  ref.current = actions;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd+K or Ctrl+K triggers command palette anywhere
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        ref.current.toggleCommandPalette();
        return;
      }

      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') {
        if (e.key === 'Escape') {
          target.blur();
        }
        return;
      }

      // Single-letter shortcuts below must never swallow the browser's own
      // Ctrl/Cmd combos: Ctrl+A (select all), Ctrl+F (find in page), Ctrl+D
      // (bookmark) used to open modals instead, on any focused element.
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (e.key === '/') {
        // Focus-moving shortcut: while any dialog is open it would yank
        // focus out of the trapped surface to the search input hidden
        // behind the backdrop, stranding keyboard users inside the modal
        // stack. No-op while an overlay is up.
        if (ref.current.hasOpenOverlay()) return;
        e.preventDefault();
        const searchInput = document.getElementById('app-search-input');
        searchInput?.focus();
      } else if (e.key === 'Escape') {
        ref.current.closeAllDialogs();
      } else if (e.key === 'a' || e.key === 'A') {
        e.preventDefault();
        ref.current.openAddFlowSearch();
      } else if (e.key === 'b' || e.key === 'B') {
        e.preventDefault();
        ref.current.toggleBatchInstallModal();
      } else if (e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        ref.current.toggleCompareModal();
      } else if (e.key === 'e' || e.key === 'E') {
        e.preventDefault();
        ref.current.toggleExportModal();
      } else if (e.key === 'd' || e.key === 'D') {
        e.preventDefault();
        ref.current.openTauriModal();
      } else if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        ref.current.toggleFavoritesOnly();
      } else if (e.key === 't' || e.key === 'T') {
        e.preventDefault();
        ref.current.toggleTrendingOnly();
      } else if (e.key === 'o' || e.key === 'O') {
        e.preventDefault();
        ref.current.toggleOwnerPickOnly();
      } else if (e.key === 'v' || e.key === 'V') {
        e.preventDefault();
        ref.current.toggleViewMode();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);
}
