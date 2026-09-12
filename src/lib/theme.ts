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
  light: '#f3f0e8',
  dark: '#090d16',
};

export function applyTheme(theme: Theme): Theme {
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
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Storage can be unavailable (private mode); the page theme still works.
  }
  return theme;
}

export function toggleTheme(current: Theme): Theme {
  return applyTheme(current === 'dark' ? 'light' : 'dark');
}

/** Follow the OS setting if the user never chose one manually. */
export function systemTheme(): Theme {
  if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
    return 'light';
  }
  return 'dark';
}

export { readStoredTheme };
