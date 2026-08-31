/**
 * SettingsPage — the preferences that are not part of a job.
 *
 * Appearance today; the language picker stays in the top bar, where it is one
 * click away from any screen, rather than being duplicated here.
 */
import ThemePicker from '../components/ThemePicker';
import { useTranslation } from '../hooks/useTranslation';
import type { SystemInfo } from '../types';

interface SettingsPageProps {
  /** For the About section. Null until the main process has answered. */
  systemInfo: SystemInfo | null;
}

export default function SettingsPage({ systemInfo }: SettingsPageProps) {
  const { t } = useTranslation();

  return (
    <div
      data-testid="settings-page"
      style={{ flex: 1, overflowY: 'auto', background: 'var(--bg)', padding: '28px 32px 40px' }}
    >
      <div style={{ maxWidth: 720, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 28 }}>
        <h1 style={{ color: 'var(--text)', fontSize: 20, fontWeight: 600 }}>{t('settings.heading')}</h1>

        <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <h2 style={{ color: 'var(--text-muted)', fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            {t('settings.appearance')}
          </h2>
          <p style={{ color: 'var(--text-faint)', fontSize: 12 }}>{t('settings.appearanceHint')}</p>
          <ThemePicker />
        </section>

        <section
          style={{
            display: 'flex', flexDirection: 'column', gap: 6,
            borderTop: '1px solid var(--border)', paddingTop: 20,
          }}
        >
          <h2 style={{ color: 'var(--text-muted)', fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            {t('settings.about')}
          </h2>
          {/* The name follows the language, the way the window title does. */}
          <p data-testid="about-name" style={{ color: 'var(--text)', fontSize: 13 }}>{t('app.name')}</p>
          {systemInfo && (
            <p style={{ color: 'var(--text-faint)', fontSize: 11 }}>
              {t('settings.version', { version: systemInfo.appVersion })}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
