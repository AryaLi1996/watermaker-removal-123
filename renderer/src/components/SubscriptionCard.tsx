/**
 * SubscriptionCard — one plan: what it costs, what it saves, and whether it
 * is the one about to be paid for.
 *
 * The card chooses; it does not buy. Payment is a separate button below the
 * methods, so the plan and the method are both settled before an order is
 * created — which is also the only order the service will accept, since it
 * takes the two together.
 *
 * Every number on the card comes from the service. The card computes nothing:
 * a client that works out its own price is a client that can show one figure
 * and charge another.
 */
import { formatPrice, planNameKey, planTaglineKey, type Plan, type PlanId } from '../subscription';
import { useTranslation } from '../hooks/useTranslation';

interface SubscriptionCardProps {
  plan: Plan;
  /** The plan the pay button would buy. */
  selected: boolean;
  /** True once a license is in force, so the button reads "Renew". */
  licensed: boolean;
  onSelect: (plan: Plan) => void;
}

/** The unit the price is quoted in — the service's `period`, not a guess. */
const PERIOD_KEY: Record<Plan['period'], string> = {
  month: 'subscription.perMonth',
  quarter: 'subscription.perQuarter',
  half_year: 'subscription.perHalfYear',
  year: 'subscription.perYear',
};

export default function SubscriptionCard({ plan, selected, licensed, onSelect }: SubscriptionCardProps) {
  const { t, locale } = useTranslation();

  return (
    <div
      className="plan-card"
      data-testid={`plan-${plan.id}`}
      data-selected={selected ? 'true' : undefined}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={() => onSelect(plan)}
      onKeyDown={(e) => {
        // A card that only answers the mouse is a control half the keyboard
        // users cannot reach.
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(plan);
        }
      }}
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        background: selected ? 'var(--accent-soft)' : 'var(--surface)',
        // Two pixels in both states: a border that grows on selection shifts
        // every other card by a pixel as the choice moves along the row.
        border: `2px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
        borderRadius: 10,
        padding: '16px 16px 14px',
        cursor: 'pointer',
      }}
    >
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

      {/* The popularity chip. Every plan has one, so the row reads as four
          choices rather than three also-rans beside a recommendation. */}
      <span
        style={{
          alignSelf: 'flex-start',
          background: selected ? 'var(--accent)' : 'var(--accent-soft)',
          color: selected ? 'var(--accent-contrast)' : 'var(--accent-soft-text)',
          fontSize: 10, borderRadius: 999, padding: '2px 8px', whiteSpace: 'nowrap',
        }}
      >
        {t(planTaglineKey(plan.id as PlanId))}
      </span>

      <button
        data-testid={`subscribe-${plan.id}`}
        aria-pressed={selected}
        // The card handles the click; this is the affordance that says so.
        tabIndex={-1}
        onClick={(e) => { e.stopPropagation(); onSelect(plan); }}
        style={{
          marginTop: 'auto',
          background: selected ? 'var(--accent)' : 'transparent',
          border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
          borderRadius: 6, padding: '7px 0',
          color: selected ? 'var(--accent-contrast)' : 'var(--text-secondary)',
          fontSize: 12, fontWeight: 500, cursor: 'pointer',
        }}
      >
        {t(licensed ? 'subscription.renew' : 'subscription.subscribe')}
      </button>
    </div>
  );
}
