/**
 * TopBar — who is using the app, what they are licensed for, and in which
 * language.
 *
 * The licence state used to live in a strip along the bottom of the window.
 * It is here now because this is the one line that is true of the whole app
 * rather than of the screen in front of you, and the bottom of a window is
 * where people stop looking.
 *
 * It doubles as the window's title bar on macOS — see index.css and
 * titlebar.ts — so every control in it has to be exempted from the drag
 * region. That is done by element type in the stylesheet rather than a class
 * each control has to remember to carry.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '../hooks/useTranslation';
import { LOCALES, LOCALE_NAMES, type Locale } from '../i18n';
import {
  formatRemaining,
  isDemoLicense,
  planNameKey,
  statusNameKey,
  type LicenseState,
} from '../subscription';

interface TopBarProps {
  state: LicenseState;
  /** Milliseconds left on the trial, ticking in the renderer. */
  trialMsRemaining: number;
  /** Milliseconds left on the licence in force. Only a demo licence shows
   *  it — a subscription is a date, not a countdown. */
  licenseMsRemaining: number;
  /** True before the main process has answered, so the bar says "checking"
   *  rather than briefly claiming the device has no licence. */
  loading: boolean;
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
  /** Opens the subscription screen, from the account panel. */
  onOpenSubscription: () => void;
  /** Left padding, so nothing is drawn under the macOS window controls. */
  inset: number;
}

/**
 * The one line about what is in force.
 *
 * Three shapes, as the ticket has them: not activated, something running with
 * time left on it, and a plan that was bought. The grace period is its own
 * wording again — it unlocks everything, but saying only "subscribed" there
 * would let someone run it out without ever being told.
 */
function statusText(
  state: LicenseState,
  trialMsRemaining: number,
  licenseMsRemaining: number,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  if (state.status === 'grace_period') return t('subscription.topGrace', { days: state.graceDaysLeft });
  if (state.status === 'active') {
    return isDemoLicense(state)
      ? t('subscription.topDemo', { remaining: formatRemaining(licenseMsRemaining, t) })
      : t('subscription.topSubscribed', { plan: t(planNameKey(state.payload?.planId ?? 'monthly')) });
  }
  if (state.trial.active) {
    return t('subscription.topTrial', { remaining: formatRemaining(trialMsRemaining, t) });
  }
  if (state.status === 'expired' || state.trial.used) return t('subscription.topExpired');
  return t('subscription.topNone');
}

export default function TopBar({
  state, trialMsRemaining, licenseMsRemaining, loading,
  locale, onLocaleChange, onOpenSubscription, inset,
}: TopBarProps) {
  const { t } = useTranslation();
  const [accountOpen, setAccountOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);

  // A panel that only closes by clicking the avatar again is a panel that
  // gets left open over whatever the user meant to look at next.
  useEffect(() => {
    if (!accountOpen) return;
    const onDown = (event: MouseEvent) => {
      if (!accountRef.current?.contains(event.target as Node)) setAccountOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAccountOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [accountOpen]);

  const licensed = state.status === 'active' || state.status === 'grace_period';

  return (
    <div
      className="app-topbar"
      style={{
        display: 'flex', alignItems: 'center', gap: 10, height: 44,
        // The right padding is the ordinary one; the left keeps clear of the
        // window controls macOS floats over this corner.
        paddingRight: 14, paddingLeft: inset,
        background: 'var(--surface)', borderBottom: '1px solid var(--border)',
      }}
    >
      <div ref={accountRef} style={{ position: 'relative', display: 'flex' }}>
        <button
          data-testid="user-avatar"
          aria-label={t('subscription.accountLabel')}
          aria-expanded={accountOpen}
          onClick={() => setAccountOpen((open) => !open)}
          style={{
            width: 26, height: 26, borderRadius: '50%', cursor: 'pointer',
            background: licensed ? 'var(--accent)' : 'var(--border)',
            border: `1px solid ${licensed ? 'var(--accent)' : 'var(--border-strong)'}`,
            color: licensed ? 'var(--accent-contrast)' : 'var(--text-muted)',
            fontSize: 13, lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <span aria-hidden="true">👤</span>
        </button>

        {accountOpen && (
          <div
            data-testid="account-panel"
            role="dialog"
            aria-label={t('subscription.accountHeading')}
            style={{
              position: 'absolute', top: 34, left: 0, zIndex: 40, minWidth: 220,
              background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8,
              padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 6,
              boxShadow: '0 8px 24px var(--overlay)',
            }}
          >
            <p style={{ color: 'var(--text-muted)', fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              {t('subscription.accountHeading')}
            </p>
            <p style={{ color: 'var(--text)', fontSize: 12 }}>
              {t('subscription.statusLabel')}: {t(statusNameKey(state))}
            </p>
            <p style={{ color: 'var(--text-faint)', fontSize: 11 }}>{t('subscription.accountHint')}</p>
            <button
              data-testid="account-subscribe"
              onClick={() => { setAccountOpen(false); onOpenSubscription(); }}
              style={{
                alignSelf: 'flex-start', marginTop: 2, background: 'transparent',
                border: '1px solid var(--border)', borderRadius: 6, padding: '4px 12px',
                color: 'var(--text-secondary)', fontSize: 11, cursor: 'pointer',
              }}
            >
              {t('subscription.accountAction')}
            </button>
          </div>
        )}
      </div>

      <span
        data-testid="subscription-status-top"
        style={{
          color: state.status === 'grace_period' ? 'var(--warn-text)'
            : licensed ? 'var(--accent-emphasis)'
            : 'var(--text-muted)',
          fontSize: 12,
        }}
      >
        {loading ? t('subscription.topChecking') : statusText(state, trialMsRemaining, licenseMsRemaining, t)}
      </span>

      <select
        data-testid="language-select"
        aria-label={t('app.language')}
        value={locale}
        onChange={(e) => onLocaleChange(e.target.value as Locale)}
        style={{
          marginLeft: 'auto', background: 'var(--bg)', color: 'var(--text-muted)',
          border: '1px solid var(--border)', borderRadius: 4, fontSize: 11,
          padding: '3px 6px', cursor: 'pointer',
        }}
      >
        {LOCALES.map((code) => (
          <option key={code} value={code}>{LOCALE_NAMES[code]}</option>
        ))}
      </select>
    </div>
  );
}
