/**
 * The strip along the bottom of the window: what the license is, and how long
 * it has left.
 *
 * It is the only place the trial countdown is visible while the user is
 * working, so it stays put on every screen rather than only on the
 * subscription page.
 */
import { formatRemaining, statusNameKey, type LicenseState } from '../subscription';
import { useTranslation } from '../hooks/useTranslation';

interface SubscriptionStatusBarProps {
  state: LicenseState;
  /** Milliseconds left on the trial, ticking in the renderer. */
  trialMsRemaining: number;
  /** True before the main process has answered, so the bar says nothing
   *  rather than briefly claiming the user has no license. */
  loading: boolean;
  /** Opens the subscription page. Hidden only while a plan is running
   *  normally — the grace period keeps prompting. */
  onOpen: () => void;
}

export default function SubscriptionStatusBar({ state, trialMsRemaining, loading, onOpen }: SubscriptionStatusBarProps) {
  const { t } = useTranslation();
  // Not `isLicensed`: the grace period still unlocks the features, but it is
  // precisely when a renewal prompt is worth showing — hiding it there would
  // let someone run out the grace period without ever being told.
  const settled = state.status === 'active';

  const label = () => {
    if (state.status === 'active') return t('subscription.barSubscribed', { plan: t(statusNameKey(state)) });
    if (state.status === 'grace_period') return t('subscription.barGrace', { days: state.graceDaysLeft });
    if (state.trial.active) return t('subscription.barTrial', { remaining: formatRemaining(trialMsRemaining, t) });
    if (state.trial.used || state.status === 'expired') return t('subscription.barExpired');
    return t('subscription.barNone');
  };

  return (
    <div
      data-testid="status-bar"
      style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '5px 14px',
        background: 'var(--surface)', borderTop: '1px solid var(--border)', minHeight: 26,
      }}
    >
      <span
        data-testid="subscription-bar-label"
        style={{
          color: settled ? 'var(--accent-emphasis)'
            : state.status === 'grace_period' ? 'var(--warn-text)'
            : 'var(--text-muted)',
          fontSize: 11,
        }}
      >
        {loading ? '' : label()}
      </span>
      {!loading && !settled && (
        <button
          data-testid="status-bar-subscribe"
          onClick={onOpen}
          style={{
            background: 'none', border: 'none', color: 'var(--accent-link)', fontSize: 11,
            textDecoration: 'underline', cursor: 'pointer', padding: 0,
          }}
        >
          {t('subscription.barAction')}
        </button>
      )}
    </div>
  );
}
