/**
 * Read and change the appearance theme.
 *
 * Throws outside a ThemeProvider rather than falling back to a default: a
 * component whose theme control silently does nothing is worse to debug than
 * one that fails on the first render.
 */
import { useContext } from 'react';
import { ThemeContext, type ThemeContextValue } from '../theme/theme';

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used within a ThemeProvider');
  return context;
}
