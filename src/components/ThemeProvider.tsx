// Fress - a catalog of free and open-source software.
// Copyright (c) 2026 WasewaseX and Fress contributors
// SPDX-License-Identifier: MIT
//
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { applyTheme, enableSystemThemeSync, getInitialTheme, Theme } from '../lib/theme';

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Single source of truth for the UI theme.
 * The initial value is read from the class already applied to <html> by the
 * inline script in index.html, so the toggle icon can never start out of sync
 * with the page (the bug reported in the previous build).
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => getInitialTheme());

  const setTheme = useCallback((next: Theme) => {
    applyTheme(next);
    setThemeState(next);
  }, []);

  // Follow live OS theme switches while the user has never picked a theme
  // manually (the pre-paint bootstrap already honored the initial value).
  // persist=false keeps the OS switch ephemeral - only an explicit menu
  // choice is written to storage.
  useEffect(() => enableSystemThemeSync((next) => {
    applyTheme(next, { persist: false });
    setThemeState(next);
  }), []);

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside ThemeProvider');
  return ctx;
}
