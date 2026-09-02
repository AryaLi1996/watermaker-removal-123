/**
 * PaymentMethods — which channel the money goes through.
 *
 * The list is the service's, already localised there, and only ever contains
 * methods it can actually take money with. Nothing here is hardcoded: a
 * method this app drew itself would be one the checkout then refuses.
 */
import { useTranslation } from '../hooks/useTranslation';
import type { PaymentMethod, PaymentMethodId } from '../subscription';

interface PaymentMethodsProps {
  methods: PaymentMethod[];
  /** The chosen method, or null before the list has arrived. */
  selected: PaymentMethodId | null;
  onSelect: (id: PaymentMethodId) => void;
}

export default function PaymentMethods({ methods, selected, onSelect }: PaymentMethodsProps) {
  const { t } = useTranslation();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <p style={{ color: 'var(--text-muted)', fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
        {t('subscription.paymentHeading')}
      </p>

      {methods.length === 0 ? (
        <p data-testid="methods-unavailable" style={{ color: 'var(--text-faint)', fontSize: 11 }}>
          {t('subscription.methodsUnavailable')}
        </p>
      ) : (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {methods.map((option) => {
            const active = selected === option.id;
            // The service sends a colour for the branded methods and omits it
            // for the card, which takes the app's accent.
            const brand = option.color || 'var(--accent)';
            return (
              <button
                key={option.id}
                className="pay-method"
                data-testid={`pay-${option.id}`}
                aria-pressed={active}
                onClick={() => onSelect(option.id)}
                style={{
                  background: active ? brand : 'transparent',
                  border: `1px solid ${active ? brand : 'var(--border)'}`,
                  borderRadius: 8, padding: '8px 18px',
                  color: active ? '#ffffff' : 'var(--text-secondary)',
                  fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
                }}
              >
                {option.icon && <span aria-hidden="true">{option.icon}</span>}
                {option.name}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
