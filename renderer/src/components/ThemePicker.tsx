/**
 * ThemePicker — light, dark, or whatever the system is doing.
 *
 * Three buttons rather than a dropdown: there are only three options, and the
 * one in force should be visible without opening anything.
 */
import { useTheme } from '../hooks/useTheme';
import { useTranslation } from '../hooks/useTranslation';
import { THEMES } from '../theme/theme';

export default function ThemePicker() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const { t } = useTranslation();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 8 }} role="radiogroup" aria-label={t('settings.theme')}>
        {THEMES.map((mode) => {
          const active = theme === mode;
          return (
            <button
              key={mode}
              data-testid={`theme-${mode}`}
              role="radio"
              aria-checked={active}
              onClick={() => setTheme(mode)}
              style={{
                background: active ? 'var(--accent-soft)' : 'transparent',
                border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                borderRadius: 6,
                padding: '6px 16px',
                color: active ? 'var(--accent-soft-text)' : 'var(--text-secondary)',
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              {t(`settings.theme_${mode}`)}
            </button>
          );
        })}
      </div>
      {/* "System" is the only choice whose result is not written on the
          button, so it is the only one that says what it currently means. */}
      {theme === 'system' && (
        <p data-testid="theme-resolved" style={{ color: 'var(--text-faint)', fontSize: 11 }}>
          {t('settings.themeFollowing', { resolved: t(`settings.theme_${resolvedTheme}`) })}
        </p>
      )}
    </div>
  );
}
