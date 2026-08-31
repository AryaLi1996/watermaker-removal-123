/**
 * The appearance theme: what the choices are, where the choice is kept, and
 * what it works out to right now.
 *
 * Separate from ThemeProvider.tsx so that file exports nothing but the
 * component — the fast-refresh rule this project lints for, and a reasonable
 * split anyway: none of this needs React to be true.
 */
import { createContext } from 'react';

/** What the user picked. */
export type Theme = 'light' | 'dark' | 'system';
/** What that works out to right now. Never 'system'. */
export type ResolvedTheme = 'light' | 'dark';

/** The order the picker shows them in. */
export const THEMES: Theme[] = ['light', 'dark', 'system'];

export const THEME_STORAGE_KEY = 'theme-preference';

export const DARK_QUERY = '(prefers-color-scheme: dark)';

export interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  resolvedTheme: ResolvedTheme;
}

export const ThemeContext = createContext<ThemeContextValue | null>(null);

export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as string[]).includes(value);
}

/**
 * The stored choice, or "system" when there is none.
 *
 * Storage can be unavailable — a hardened browser, a test environment — and a
 * theme preference is not worth failing to start over.
 */
export function storedTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

/** Remember the choice. A storage that refuses still leaves it applied. */
export function storeTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // The choice still applies for this session.
  }
}

/** Whether the system is asking for dark. False where nothing can say. */
export function systemPrefersDark(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches;
}

/** What a preference works out to, against the system setting. */
export function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return theme;
}

/**
 * Put the resolved theme on <html>, where the CSS variables are looked up.
 *
 * On the document rather than a wrapper element, so the page background —
 * painted by <body>, outside React's tree — changes with everything else.
 */
export function applyTheme(resolved: ResolvedTheme): void {
  const root = document.documentElement;
  root.classList.remove('light', 'dark');
  root.classList.add(resolved);
  // Tells the browser which way to paint its own furniture: form controls,
  // and the background behind the page before the first paint.
  root.style.colorScheme = resolved;
}
