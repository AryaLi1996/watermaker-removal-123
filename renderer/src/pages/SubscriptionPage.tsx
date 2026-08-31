/**
 * SubscriptionPage — the plans, what is running now, and the way to pay.
 *
 * The payment step is a simulation: it draws a QR code, waits for the user to
 * say they paid, and writes the plan. A real integration replaces the dialog's
 * confirm handler with the provider's callback; everything else — the plans,
 * the persistence, what a plan unlocks — stays as it is.
 */
import { useState } from 'react';
import SubscriptionCard from '../components/SubscriptionCard';
import PaymentQr from '../components/PaymentQr';
import { useTranslation } from '../hooks/useTranslation';
import {
  formatRemaining,
  isPaidPlan,
  planNameKey,
  PLANS,
  statusNameKey,
  type PaidPlanId,
  type PaymentMethod,
  type Plan,
  type SubscriptionStatus,
} from '../subscription';

interface SubscriptionPageProps {
  status: SubscriptionStatus;
  onSubscribe: (plan: PaidPlanId, method: PaymentMethod) => Promise<void>;
  onCancelAutoRenew: () => Promise<void>;
}

/** Brand colours, for the QR and the selected payment button. */
const METHOD_COLOR: Record<PaymentMethod, string> = {
  wechat: '#07c160',
  alipay: '#1677ff',
};

const METHODS: PaymentMethod[] = ['wechat', 'alipay'];

const FAQ = [
  { q: 'subscription.faqTrial', a: 'subscription.faqTrialBody' },
  { q: 'subscription.faqRefund', a: 'subscription.faqRefundBody' },
  { q: 'subscription.faqDevices', a: 'subscription.faqDevicesBody' },
];

const BENEFITS = [
  'subscription.benefitTemporal',
  'subscription.benefitPreview',
  'subscription.benefitBatch',
  'subscription.benefitPresets',
];

export default function SubscriptionPage({ status, onSubscribe, onCancelAutoRenew }: SubscriptionPageProps) {
  const { t, locale } = useTranslation();
  const [method, setMethod] = useState<PaymentMethod>('wechat');
  const [paying, setPaying] = useState<Plan | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [cancelled, setCancelled] = useState(false);

  const confirmPayment = async () => {
    if (!paying) return;
    await onSubscribe(paying.id, method);
    setPaying(null);
    setConfirmed(true);
    setCancelled(false);
  };

  const cancelRenewal = async () => {
    await onCancelAutoRenew();
    setCancelled(true);
  };

  const endDate = status.endDate
    ? new Date(status.endDate).toLocaleDateString(locale === 'zh' ? 'zh-CN' : 'en-GB')
    : '';

  return (
    <div
      data-testid="subscription-page"
      style={{ flex: 1, overflowY: 'auto', background: '#18181b', padding: '28px 32px 40px' }}
    >
      <div style={{ maxWidth: 900, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 24 }}>
        {/* Header: what is running right now */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <h1 style={{ color: '#f4f4f5', fontSize: 20, fontWeight: 600 }}>💎 {t('subscription.heading')}</h1>
          <p data-testid="subscription-status" style={{ color: '#a1a1aa', fontSize: 12 }}>
            {t('subscription.statusLabel')}: {t(statusNameKey(status))}
            {status.msRemaining > 0 && ` (${formatRemaining(status.msRemaining, t)})`}
          </p>
          <p style={{ color: '#71717a', fontSize: 12 }}>{t('subscription.subheading')}</p>
        </div>

        {/* A trial that has run out is the one moment this page has to explain itself. */}
        {status.expired && !status.subscribed && (
          <div
            data-testid="trial-ended"
            style={{ background: '#27272a', border: '1px solid #3f3f46', borderRadius: 8, padding: '12px 14px' }}
          >
            <p style={{ color: '#f4f4f5', fontSize: 12, fontWeight: 500 }}>{t('subscription.trialEndedTitle')}</p>
            <p style={{ color: '#a1a1aa', fontSize: 11, marginTop: 4 }}>{t('subscription.trialEndedBody')}</p>
          </div>
        )}

        {confirmed && (
          <div
            data-testid="subscribe-success"
            style={{ background: '#052e16', border: '1px solid #15803d', borderRadius: 8, padding: '10px 14px', color: '#86efac', fontSize: 12 }}
          >
            {t('subscription.paySuccess')}
          </div>
        )}

        {/* Plans */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: 14,
          }}
        >
          {PLANS.map((plan) => (
            <SubscriptionCard
              key={plan.id}
              plan={plan}
              subscribed={status.subscribed}
              current={status.plan === plan.id}
              onSubscribe={(chosen) => { setConfirmed(false); setPaying(chosen); }}
            />
          ))}
        </div>

        {/* Payment method */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <p style={{ color: '#a1a1aa', fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            {t('subscription.paymentHeading')}
          </p>
          <div style={{ display: 'flex', gap: 10 }}>
            {METHODS.map((id) => {
              const active = method === id;
              return (
                <button
                  key={id}
                  data-testid={`pay-${id}`}
                  aria-pressed={active}
                  onClick={() => setMethod(id)}
                  style={{
                    background: active ? METHOD_COLOR[id] : 'transparent',
                    border: `1px solid ${active ? METHOD_COLOR[id] : '#3f3f46'}`,
                    borderRadius: 6, padding: '6px 16px', color: active ? '#fff' : '#d4d4d8',
                    fontSize: 12, cursor: 'pointer',
                  }}
                >
                  {t(`subscription.${id}`)}
                </button>
              );
            })}
          </div>
          <p style={{ color: '#71717a', fontSize: 11 }}>{t('subscription.paymentHint')}</p>
        </div>

        {/* What the money buys */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <p style={{ color: '#a1a1aa', fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            {t('subscription.benefitsHeading')}
          </p>
          {BENEFITS.map((key) => (
            <p key={key} style={{ color: '#d4d4d8', fontSize: 12 }}>· {t(key)}</p>
          ))}
        </div>

        {/* Managing a plan that exists */}
        {isPaidPlan(status.plan) && (
          <div
            data-testid="manage-subscription"
            style={{ background: '#27272a', border: '1px solid #3f3f46', borderRadius: 8, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 6 }}
          >
            <p style={{ color: '#a1a1aa', fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              {t('subscription.manageHeading')}
            </p>
            <p style={{ color: '#f4f4f5', fontSize: 13 }}>{t(planNameKey(status.plan))}</p>
            <p style={{ color: '#a1a1aa', fontSize: 11 }}>{t('subscription.expiresOn', { date: endDate })}</p>
            <p style={{ color: status.autoRenew ? '#a5b4fc' : '#71717a', fontSize: 11 }}>
              {t(status.autoRenew ? 'subscription.autoRenewOn' : 'subscription.autoRenewOff')}
            </p>
            {status.autoRenew ? (
              <button
                data-testid="cancel-auto-renew"
                onClick={() => { void cancelRenewal(); }}
                style={{
                  alignSelf: 'flex-start', marginTop: 4, background: 'transparent',
                  border: '1px solid #3f3f46', borderRadius: 6, padding: '5px 14px',
                  color: '#d4d4d8', fontSize: 11, cursor: 'pointer',
                }}
              >
                {t('subscription.cancelAutoRenew')}
              </button>
            ) : cancelled && (
              <p data-testid="auto-renew-cancelled" style={{ color: '#71717a', fontSize: 11 }}>
                {t('subscription.autoRenewCancelled')}
              </p>
            )}
          </div>
        )}

        {/* FAQ and the refund policy */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, borderTop: '1px solid #27272a', paddingTop: 16 }}>
          <p style={{ color: '#a1a1aa', fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            ❓ {t('subscription.faqHeading')}
          </p>
          {FAQ.map(({ q, a }) => (
            <details key={q}>
              <summary style={{ color: '#d4d4d8', fontSize: 12, cursor: 'pointer', padding: '4px 0' }}>{t(q)}</summary>
              <p style={{ color: '#71717a', fontSize: 11, paddingBottom: 6 }}>{t(a)}</p>
            </details>
          ))}
        </div>
      </div>

      {/* Payment dialog */}
      {paying && (
        <div
          data-testid="payment-dialog"
          role="dialog"
          aria-modal="true"
          aria-label={t('subscription.payTitle')}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(9,9,11,0.8)', display: 'flex',
            alignItems: 'center', justifyContent: 'center', zIndex: 50,
          }}
        >
          <div
            style={{
              background: '#27272a', border: '1px solid #3f3f46', borderRadius: 10,
              padding: 24, display: 'flex', flexDirection: 'column', alignItems: 'center',
              gap: 12, minWidth: 280,
            }}
          >
            <p style={{ color: '#f4f4f5', fontSize: 14, fontWeight: 500 }}>{t('subscription.payTitle')}</p>
            <p data-testid="payment-summary" style={{ color: '#a1a1aa', fontSize: 12 }}>
              {t('subscription.paySummary', {
                plan: t(planNameKey(paying.id)),
                price: paying.price,
                method: t(`subscription.${method}`),
              })}
            </p>
            <PaymentQr seed={`${paying.id}:${method}`} color={METHOD_COLOR[method]} />
            <p style={{ color: '#71717a', fontSize: 10, maxWidth: 240, textAlign: 'center' }}>
              {t('subscription.paySimulated')}
            </p>
            <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
              <button
                data-testid="payment-cancel"
                onClick={() => setPaying(null)}
                style={{
                  background: 'transparent', border: '1px solid #3f3f46', borderRadius: 6,
                  padding: '6px 16px', color: '#a1a1aa', fontSize: 12, cursor: 'pointer',
                }}
              >
                {t('subscription.payCancel')}
              </button>
              <button
                data-testid="payment-confirm"
                onClick={() => { void confirmPayment(); }}
                style={{
                  background: '#6366f1', border: 'none', borderRadius: 6, padding: '6px 16px',
                  color: '#fff', fontSize: 12, fontWeight: 500, cursor: 'pointer',
                }}
              >
                {t('subscription.payConfirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
