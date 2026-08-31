/**
 * The appearance theme: what it starts as, what it writes down, and what it
 * does when the system changes underneath it.
 *
 * jsdom has no matchMedia, so these install one. That is not just plumbing —
 * the fake is what makes "follow the system" testable at all, and one test
 * deliberately removes it to check the app still starts somewhere sensible.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { ThemeProvider } from './ThemeProvider';
import { resolveTheme, storedTheme, THEME_STORAGE_KEY } from './theme';
import ThemePicker from '../components/ThemePicker';
import { useTheme } from '../hooks/useTheme';
import { setLocale } from '../i18n';

/** A matchMedia whose answer can be changed, and which notifies listeners. */
function installMatchMedia(prefersDark: boolean) {
  const listeners = new Set<() => void>();
  let matches = prefersDark;
  const media = {
    get matches() { return matches; },
    addEventListener: (_: string, fn: () => void) => { listeners.add(fn); },
    removeEventListener: (_: string, fn: () => void) => { listeners.delete(fn); },
  };
  window.matchMedia = vi.fn().mockReturnValue(media) as unknown as typeof window.matchMedia;
  return {
    /** Flip the system setting, as an OS switching at sunset would. */
    set(next: boolean) {
      matches = next;
      act(() => { listeners.forEach((fn) => fn()); });
    },
    get listenerCount() { return listeners.size; },
  };
}

/** Reads the value out of the context, so the hook itself is covered. */
function ThemeReadout() {
  const { theme, resolvedTheme } = useTheme();
  return <span data-testid="readout">{`${theme}/${resolvedTheme}`}</span>;
}

function renderPicker() {
  return render(
    <ThemeProvider>
      <ThemePicker />
      <ThemeReadout />
    </ThemeProvider>,
  );
}

const rootClasses = () => Array.from(document.documentElement.classList);

beforeEach(() => {
  window.localStorage.removeItem(THEME_STORAGE_KEY);
  document.documentElement.classList.remove('light', 'dark');
  document.documentElement.style.colorScheme = '';
  installMatchMedia(false);
  setLocale('en');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the stored preference', () => {
  it('starts on "system" when nothing has been chosen', () => {
    expect(storedTheme()).toBe('system');
    renderPicker();
    expect(screen.getByTestId('readout')).toHaveTextContent('system/light');
    expect(screen.getByTestId('theme-system')).toHaveAttribute('aria-checked', 'true');
  });

  it('starts on what was chosen last time', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    renderPicker();
    expect(screen.getByTestId('readout')).toHaveTextContent('dark/dark');
    expect(rootClasses()).toContain('dark');
  });

  it('ignores a stored value that is not a theme', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'chartreuse');
    expect(storedTheme()).toBe('system');
  });

  it('writes the choice down, so it survives a restart', () => {
    renderPicker();
    fireEvent.click(screen.getByTestId('theme-dark'));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });
});

describe('applying it', () => {
  it('puts the resolved theme on <html>, and only one of them', () => {
    renderPicker();
    expect(rootClasses()).toContain('light');
    expect(rootClasses()).not.toContain('dark');

    fireEvent.click(screen.getByTestId('theme-dark'));
    expect(rootClasses()).toContain('dark');
    expect(rootClasses()).not.toContain('light');
  });

  it('tells the browser which way to paint its own furniture', () => {
    renderPicker();
    fireEvent.click(screen.getByTestId('theme-dark'));
    expect(document.documentElement.style.colorScheme).toBe('dark');
  });

  it('takes effect immediately, with no reload', () => {
    renderPicker();
    fireEvent.click(screen.getByTestId('theme-dark'));
    expect(screen.getByTestId('readout')).toHaveTextContent('dark/dark');
    fireEvent.click(screen.getByTestId('theme-light'));
    expect(screen.getByTestId('readout')).toHaveTextContent('light/light');
  });
});

describe('following the system', () => {
  it('resolves to whatever the system is asking for', () => {
    installMatchMedia(true);
    expect(resolveTheme('system')).toBe('dark');
    renderPicker();
    expect(screen.getByTestId('readout')).toHaveTextContent('system/dark');
    expect(screen.getByTestId('theme-resolved')).toHaveTextContent('Dark');
  });

  it('follows it when it changes, without being asked again', () => {
    const media = installMatchMedia(false);
    renderPicker();
    expect(rootClasses()).toContain('light');

    media.set(true);
    expect(rootClasses()).toContain('dark');
    expect(screen.getByTestId('readout')).toHaveTextContent('system/dark');
  });

  it('ignores it once the user has picked a side', () => {
    const media = installMatchMedia(false);
    renderPicker();
    fireEvent.click(screen.getByTestId('theme-light'));

    media.set(true);
    expect(rootClasses()).toContain('light');
    expect(screen.getByTestId('readout')).toHaveTextContent('light/light');
  });

  it('goes back to following it when the user picks "system" again', () => {
    const media = installMatchMedia(true);
    renderPicker();
    fireEvent.click(screen.getByTestId('theme-light'));
    expect(rootClasses()).toContain('light');

    fireEvent.click(screen.getByTestId('theme-system'));
    expect(rootClasses()).toContain('dark');
    media.set(false);
    expect(rootClasses()).toContain('light');
  });

  it('drops its listener when it unmounts', () => {
    const media = installMatchMedia(false);
    const { unmount } = renderPicker();
    expect(media.listenerCount).toBe(1);
    unmount();
    expect(media.listenerCount).toBe(0);
  });

  it('starts in light where nothing can say what the system prefers', () => {
    // Some environments have no matchMedia at all; that must not throw.
    (window as unknown as { matchMedia?: unknown }).matchMedia = undefined;
    expect(resolveTheme('system')).toBe('light');
    renderPicker();
    expect(rootClasses()).toContain('light');
  });
});

describe('the picker', () => {
  it('says which theme "system" is currently giving, and only then', () => {
    renderPicker();
    expect(screen.getByTestId('theme-resolved')).toHaveTextContent('Light');
    fireEvent.click(screen.getByTestId('theme-dark'));
    expect(screen.queryByTestId('theme-resolved')).toBeNull();
  });

  it('is translated', () => {
    setLocale('zh');
    renderPicker();
    expect(screen.getByTestId('theme-light')).toHaveTextContent('亮色');
    expect(screen.getByTestId('theme-dark')).toHaveTextContent('暗色');
    expect(screen.getByTestId('theme-system')).toHaveTextContent('跟随系统');
  });
});

describe('useTheme outside a provider', () => {
  it('fails loudly rather than silently doing nothing', () => {
    // React logs the error boundary-less throw; the assertion is the throw.
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<ThemeReadout />)).toThrow(/ThemeProvider/);
    quiet.mockRestore();
  });
});
