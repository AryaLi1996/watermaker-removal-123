/**
 * Applies the appearance theme, and keeps it applied.
 *
 * "System" is a live setting, not a reading taken once: the media query stays
 * subscribed, so a machine that switches at sunset switches the app with it.
 * An explicit light or dark ignores it.
 *
 * The choice itself, and everything that does not need React, is in theme.ts.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  applyTheme,
  DARK_QUERY,
  resolveTheme,
  storedTheme,
  storeTheme,
  ThemeContext,
  type ResolvedTheme,
  type Theme,
} from './theme';

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(storedTheme);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => resolveTheme(storedTheme()));

  const setTheme = useCallback((next: Theme) => {
    storeTheme(next);
    setThemeState(next);
  }, []);

  useEffect(() => {
    const update = () => {
      const resolved = resolveTheme(theme);
      setResolvedTheme(resolved);
      applyTheme(resolved);
    };
    update();

    // Attached whatever the preference is, and filtered inside: switching
    // back to "system" then needs no re-subscription.
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(DARK_QUERY);
    const onChange = () => { if (theme === 'system') update(); };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [theme]);

  const value = useMemo(
    () => ({ theme, setTheme, resolvedTheme }),
    [theme, setTheme, resolvedTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
