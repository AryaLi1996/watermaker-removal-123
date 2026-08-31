/**
 * SubscriptionCard — one plan: what it costs, what it saves, and the button
 * that starts paying for it.
 *
 * Every number on the card comes from the service. The card computes nothing:
 * a client that works out its own price is a client that can show one figure
 * and charge another.
 */
import { formatPrice, planBadgeKey, planNameKey, planTaglineKey, type Plan, type PlanId } from '../subscription';
import { useTranslation } from '../hooks/useTranslation';

interface SubscriptionCardProps {
  plan: Plan;
  /** True once a license is in force, so the button reads "Renew". */
  licensed: boolean;
  /** The plan currently in force, if it is this one. */
  current: boolean;
  /** True while an order is being created, so a second click cannot start a
   *  second order for the same thing. */
  busy: boolean;
  onSubscribe: (plan: Plan) => void;
}

/** The unit the price is quoted in — the service's `period`, not a guess. */
const PERIOD_KEY: Record<Plan['period'], string> = {
  month: 'subscription.perMonth',
  quarter: 'subscription.perQuarter',
  half_year: 'subscription.perHalfYear',
  year: 'subscription.perYear',
};

export default function SubscriptionCard({ plan, licensed, current, busy, onSubscribe }: SubscriptionCardProps) {
  const { t, locale } = useTranslation();
  const badgeKey = planBadgeKey(plan.id as PlanId);
  const featured = plan.id === 'quarterly';

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
      {badgeKey && (
        <span
          style={{
            position: 'absolute', top: -9, left: 16,
            background: featured ? 'var(--accent)' : 'var(--accent-soft)',
            color: featured ? 'var(--accent-contrast)' : 'var(--accent-soft-text)',
            fontSize: 10, borderRadius: 999, padding: '2px 8px', whiteSpace: 'nowrap',
          }}
        >
          {t(badgeKey)}
        </span>
      )}

      <p style={{ color: 'var(--text)', fontSize: 13, fontWeight: 500 }}>{t(planNameKey(plan.id as PlanId))}</p>
      <p style={{ color: 'var(--text)', fontSize: 20, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
        {t(PERIOD_KEY[plan.period], { price: formatPrice(plan, locale) })}
      </p>

      {plan.discountPercent > 0 ? (
        <p style={{ color: 'var(--accent-emphasis)', fontSize: 11 }}>
          {t('subscription.discount', { percent: plan.discountPercent })}
          {' · '}
          {/* The pre-discount total, struck through, as the service computed
              it — not this card multiplying a monthly price back up. */}
          <span style={{ textDecoration: 'line-through', color: 'var(--text-faint)' }}>
            {formatPrice({ price: plan.originalPrice, currency: plan.currency }, locale)}
          </span>
        </p>
      ) : (
        <p style={{ color: 'var(--text-faint)', fontSize: 11 }}>{t('subscription.noDiscount')}</p>
      )}

      <p style={{ color: 'var(--text-muted)', fontSize: 11 }}>{t(planTaglineKey(plan.id as PlanId))}</p>

      <button
        data-testid={`subscribe-${plan.id}`}
        onClick={() => onSubscribe(plan)}
        disabled={busy}
        style={{
          marginTop: 'auto',
          background: featured || current ? 'var(--accent)' : 'transparent',
          border: `1px solid ${featured || current ? 'var(--accent)' : 'var(--border)'}`,
          borderRadius: 6, padding: '7px 0',
          color: featured || current ? 'var(--accent-contrast)' : 'var(--text-secondary)',
          fontSize: 12, fontWeight: 500, cursor: busy ? 'wait' : 'pointer',
          opacity: busy ? 0.6 : 1,
        }}
      >
        {t(licensed ? 'subscription.renew' : 'subscription.subscribe')}
      </button>
    </div>
  );
}
