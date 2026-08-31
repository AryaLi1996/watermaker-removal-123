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
        background: current ? '#312e81' : '#27272a',
        border: `1px solid ${current || featured ? '#6366f1' : '#3f3f46'}`,
        borderRadius: 10,
        padding: '18px 16px 16px',
      }}
    >
      {plan.badgeKey && (
        <span
          style={{
            position: 'absolute', top: -9, left: 16, background: featured ? '#6366f1' : '#3f3f46',
            color: '#fff', fontSize: 10, borderRadius: 999, padding: '2px 8px', whiteSpace: 'nowrap',
          }}
        >
          {t(plan.badgeKey)}
        </span>
      )}

      <p style={{ color: '#f4f4f5', fontSize: 13, fontWeight: 500 }}>{t(planNameKey(plan.id))}</p>
      <p style={{ color: '#f4f4f5', fontSize: 20, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
        {t(planPriceKey(plan.id), { price: plan.price })}
      </p>
      <p style={{ color: plan.multiplier < 1 ? '#a5b4fc' : '#71717a', fontSize: 11 }}>
        {t(planDiscountKey(plan.id))}
      </p>
      {plan.multiplier < 1 && (
        <p style={{ color: '#71717a', fontSize: 10, fontVariantNumeric: 'tabular-nums' }}>
          {t('subscription.equivalent', { price: plan.monthlyEquivalent })}
        </p>
      )}
      <p style={{ color: '#a1a1aa', fontSize: 11 }}>{t(planTaglineKey(plan.id))}</p>

      <button
        data-testid={`subscribe-${plan.id}`}
        onClick={() => onSubscribe(plan)}
        style={{
          marginTop: 'auto', background: featured || current ? '#6366f1' : 'transparent',
          border: `1px solid ${featured || current ? '#6366f1' : '#3f3f46'}`, borderRadius: 6,
          padding: '7px 0', color: featured || current ? '#fff' : '#d4d4d8', fontSize: 12,
          fontWeight: 500, cursor: 'pointer',
        }}
      >
        {t(subscribed ? 'subscription.renew' : 'subscription.subscribe')}
      </button>
    </div>
  );
}
