/**
 * The strip along the bottom of the window: what the subscription is, and how
 * long it has left.
 *
 * It is the only place the trial countdown is visible while the user is
 * working, so it stays put on every screen rather than only on the
 * subscription page.
 */
import { formatRemaining, statusNameKey, type SubscriptionStatus } from '../subscription';
import { useTranslation } from '../hooks/useTranslation';

interface SubscriptionStatusBarProps {
  status: SubscriptionStatus;
  /** True before the record has been read, so the bar shows nothing rather
   *  than briefly claiming the user has not subscribed. */
  loading: boolean;
  /** Opens the subscription page. Hidden while a plan is running. */
  onOpen: () => void;
}

export default function SubscriptionStatusBar({ status, loading, onOpen }: SubscriptionStatusBarProps) {
  const { t } = useTranslation();

  const label = () => {
    if (status.subscribed) return t('subscription.barSubscribed', { plan: t(statusNameKey(status)) });
    if (status.trialing) return t('subscription.barTrial', { remaining: formatRemaining(status.msRemaining, t) });
    return t(status.expired ? 'subscription.barExpired' : 'subscription.barNone');
  };

  return (
    <div
      data-testid="status-bar"
      style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '5px 14px',
        background: '#27272a', borderTop: '1px solid #3f3f46', minHeight: 26,
      }}
    >
      <span
        data-testid="subscription-bar-label"
        style={{ color: status.subscribed ? '#a5b4fc' : '#a1a1aa', fontSize: 11 }}
      >
        {loading ? '' : label()}
      </span>
      {!loading && !status.subscribed && (
        <button
          data-testid="status-bar-subscribe"
          onClick={onOpen}
          style={{
            background: 'none', border: 'none', color: '#818cf8', fontSize: 11,
            textDecoration: 'underline', cursor: 'pointer', padding: 0,
          }}
        >
          {t('subscription.barAction')}
        </button>
      )}
    </div>
  );
}
