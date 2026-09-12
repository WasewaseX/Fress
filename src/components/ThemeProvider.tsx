import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { applyTheme, getInitialTheme, Theme } from '../lib/theme';

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

  // Sync the browser chrome (meta theme-color) with the real theme on mount:
  // the inline script applied the class pre-paint, but applyTheme() only ran
  // on user toggles, so the meta stayed on its static HTML default.
  useEffect(() => {
    applyTheme(theme);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setTheme = useCallback((next: Theme) => {
    applyTheme(next);
    setThemeState(next);
  }, []);

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside ThemeProvider');
  return ctx;
}
