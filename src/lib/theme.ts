// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
// Theme handling with a single source of truth.
//
// The startup bug report was: app opens showing the wrong mode icon, pressing
// the button only flips the icon, and only the second press changes the page.
// Root cause in the old build: the button kept its own boolean that was
// initialized independently from the class actually applied to <html>, so the
// icon and the page could disagree, and the first click only resynced them.
//
// Fix: the theme state is ALWAYS read from the class on <html> (set before
// first paint by the inline script in index.html), and every change goes
// through applyTheme() which updates the DOM, localStorage and the icon state
// in one place.

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'fress.theme';

function readStoredTheme(): Theme | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

export function getInitialTheme(): Theme {
  // Ask the DOM first: the inline script in index.html already decided and
  // applied the theme before React mounted, so this can never disagree.
  if (typeof document !== 'undefined' && document.documentElement.classList.contains('dark')) {
    return 'dark';
  }
  if (typeof document !== 'undefined') {
    return 'light';
  }
  return 'dark';
}

const THEME_COLORS: Record<Theme, string> = {
  light: '#f6f4ef',
  dark: '#090d16',
};

export function applyTheme(theme: Theme, opts: { persist?: boolean } = {}): Theme {
  if (typeof document === 'undefined') return theme;
  document.documentElement.classList.toggle('dark', theme === 'dark');
  document.documentElement.style.colorScheme = theme;
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    document.head.appendChild(meta);
  }
  meta.setAttribute('content', THEME_COLORS[theme]);
  if (opts.persist !== false) {
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Storage can be unavailable (private mode); the page theme still works.
    }
  }
  return theme;
}

export function toggleTheme(current: Theme): Theme {
  return applyTheme(current === 'dark' ? 'light' : 'dark');
}

/**
 * Live system-theme sync for users who never picked a theme manually.
 *
 * The old `systemTheme()` read the media query once and was never imported:
 * an OS switch while the app was open was silently ignored until the user
 * toggled manually. This wiring applies OS switches ONLY while no explicit
 * choice is stored - the moment a user picks light/dark in the menu, their
 * choice wins forever (until they clear it).
 */
export function enableSystemThemeSync(onChange: (theme: Theme) => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => undefined;
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = (e: MediaQueryListEvent) => {
    // A stored choice is an explicit user decision: never override it.
    if (readStoredTheme()) return;
    // Persist=false: an OS switch is NOT a user choice - it must stay
    // ephemeral so a later manual pick (or its absence) keeps controlling
    // the default.
    onChange(e.matches ? 'dark' : 'light');
  };
  mq.addEventListener('change', handler);
  return () => mq.removeEventListener('change', handler);
}

export { readStoredTheme };
