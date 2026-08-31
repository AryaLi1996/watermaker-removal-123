/**
 * SubscriptionCard — one plan: what it costs, what it saves, and the button
 * that starts paying for it.
 *
 * The recommended plan is marked rather than reordered; the cards stay in
 * commitment order so the comparison down the row is a like-for-like one.
 */
import { planDiscountKey, planNameKey, planPriceKey, planTaglineKey, type Plan } from '../subscription';
import { useTranslation } from '../hooks/useTranslation';

interface SubscriptionCardProps {
  plan: Plan;
  /** True once a plan is paid for, so the button reads "Renew". */
  subscribed: boolean;
  /** The plan currently in force, if it is this one. */
  current: boolean;
  onSubscribe: (plan: Plan) => void;
}

export default function SubscriptionCard({ plan, subscribed, current, onSubscribe }: SubscriptionCardProps) {
  const { t } = useTranslation();
  const featured = plan.badgeKey === 'subscription.badgePopular';

  return (
    <div
      data-testid={`plan-${plan.id}`}
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        background: current ? 'var(--accent-soft)' : 'var(--surface)',
        border: `1px solid ${current || featured ? 'var(--accent)' : 'var(--border)'}`,
        borderRadius: 10,
        padding: '18px 16px 16px',
      }}
    >
      {plan.badgeKey && (
        <span
          style={{
            position: 'absolute', top: -9, left: 16,
            // The recommended plan's badge is the accent itself; the others
            // are the quiet version of it, which stays readable in a light
            // theme where a plain border colour would not.
            background: featured ? 'var(--accent)' : 'var(--accent-soft)',
            color: featured ? 'var(--accent-contrast)' : 'var(--accent-soft-text)',
            fontSize: 10, borderRadius: 999, padding: '2px 8px', whiteSpace: 'nowrap',
          }}
        >
          {t(plan.badgeKey)}
        </span>
      )}

      <p style={{ color: 'var(--text)', fontSize: 13, fontWeight: 500 }}>{t(planNameKey(plan.id))}</p>
      <p style={{ color: 'var(--text)', fontSize: 20, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
        {t(planPriceKey(plan.id), { price: plan.price })}
      </p>
      <p style={{ color: plan.multiplier < 1 ? 'var(--accent-emphasis)' : 'var(--text-faint)', fontSize: 11 }}>
        {t(planDiscountKey(plan.id))}
      </p>
      {plan.multiplier < 1 && (
        <p style={{ color: 'var(--text-faint)', fontSize: 10, fontVariantNumeric: 'tabular-nums' }}>
          {t('subscription.equivalent', { price: plan.monthlyEquivalent })}
        </p>
      )}
      <p style={{ color: 'var(--text-muted)', fontSize: 11 }}>{t(planTaglineKey(plan.id))}</p>

      <button
        data-testid={`subscribe-${plan.id}`}
        onClick={() => onSubscribe(plan)}
        style={{
          marginTop: 'auto', background: featured || current ? 'var(--accent)' : 'transparent',
          border: `1px solid ${featured || current ? 'var(--accent)' : 'var(--border)'}`, borderRadius: 6,
          padding: '7px 0', color: featured || current ? 'var(--accent-contrast)' : 'var(--text-secondary)', fontSize: 12,
          fontWeight: 500, cursor: 'pointer',
        }}
      >
        {t(subscribed ? 'subscription.renew' : 'subscription.subscribe')}
      </button>
    </div>
  );
}
