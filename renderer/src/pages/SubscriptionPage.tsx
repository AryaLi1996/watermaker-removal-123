/**
 * SubscriptionPage — what is in force, the plans, and paying for one.
 *
 * The payment is real: creating an order returns a checkout URL from the
 * service's provider, which opens in the system browser or in a child window
 * for the methods that show a QR code. Nothing here decides whether a payment
 * succeeded — the provider's webhook tells the service, the service issues
 * the license, and this page finds out by polling the order.
 *
 * That is why there is no "I have paid" button: the only thing that could
 * make one work is trusting the client's word for it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import SubscriptionCard from '../components/SubscriptionCard';
import { useTranslation } from '../hooks/useTranslation';
import {
  formatRemaining,
  isLicensed,
  planNameKey,
  statusNameKey,
  type LicenseState,
  type Order,
  type PaymentMethod,
  type PaymentMethodId,
  type Plan,
  type PlanId,
} from '../subscription';

interface SubscriptionPageProps {
  state: LicenseState;
  plans: Plan[];
  plansAreFallback: boolean;
  methods: PaymentMethod[];
  trialMsRemaining: number;
  createOrder: (planId: PlanId, method: PaymentMethodId) => Promise<Order | { error: string }>;
  watchOrder: (orderId: string, signal: { cancelled: boolean }) => Promise<'paid' | 'timeout' | 'cancelled'>;
  refresh: () => Promise<void>;
}

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

/** What the page is doing, so it can only be doing one thing at a time. */
type Phase =
  | { kind: 'idle' }
  | { kind: 'creating'; planId: PlanId }
  | { kind: 'waiting'; order: Order }
  | { kind: 'paid' }
  | { kind: 'timeout' }
  | { kind: 'error'; message: string };

export default function SubscriptionPage({
  state, plans, plansAreFallback, methods, trialMsRemaining, createOrder, watchOrder, refresh,
}: SubscriptionPageProps) {
  const { t, locale } = useTranslation();
  // The chosen method, or none chosen yet.
  const [picked, setPicked] = useState<PaymentMethodId | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  // Shared with the in-flight poll so cancelling actually stops it, rather
  // than leaving it to finish and overwrite whatever the user did next.
  const watching = useRef<{ cancelled: boolean }>({ cancelled: false });

  // The service decides which methods exist, so the default is whichever it
  // listed first rather than a hardcoded favourite that may not be enabled.
  // Derived rather than written into state on arrival: nothing to keep in
  // sync when the list changes under it.
  const method: PaymentMethodId | null = picked ?? methods[0]?.id ?? null;

  // A closed checkout window is not a failed payment — the order may already
  // be paid — so this only takes down the dialog, and the poll continues.
  useEffect(() => {
    window.electronAPI.onPaymentWindowClosed?.(() => {
      setPhase((current) => (current.kind === 'waiting' ? { kind: 'idle' } : current));
    });
  }, []);

  useEffect(() => () => { watching.current.cancelled = true; }, []);

  const startOrder = useCallback(async (plan: Plan) => {
    if (!method) return;
    setPhase({ kind: 'creating', planId: plan.id });

    const created = await createOrder(plan.id, method);
    if ('error' in created) {
      setPhase({ kind: 'error', message: created.error });
      return;
    }

    // The checkout page is the provider's. `embedded` is the QR-code case,
    // which needs a window of its own; `external` goes to the real browser,
    // where a password manager and a saved card actually work.
    if (created.presentAs === 'embedded') {
      await window.electronAPI.paymentOpenEmbedded?.(created.redirectUrl);
    } else {
      await window.electronAPI.paymentOpenExternal?.(created.redirectUrl);
    }

    setPhase({ kind: 'waiting', order: created });
    watching.current = { cancelled: false };
    const outcome = await watchOrder(created.orderId, watching.current);
    await window.electronAPI.paymentCloseEmbedded?.();
    if (outcome === 'paid') setPhase({ kind: 'paid' });
    else if (outcome === 'timeout') setPhase({ kind: 'timeout' });
    else setPhase({ kind: 'idle' });
  }, [createOrder, method, watchOrder]);

  const stopWaiting = useCallback(() => {
    watching.current.cancelled = true;
    void window.electronAPI.paymentCloseEmbedded?.();
    setPhase({ kind: 'idle' });
  }, []);

  const licensed = isLicensed(state.status);
  const expiry = state.expiresAt
    ? new Date(state.expiresAt).toLocaleDateString(locale === 'zh' ? 'zh-CN' : 'en-GB')
    : '';

  return (
    <div
      data-testid="subscription-page"
      style={{ flex: 1, overflowY: 'auto', background: 'var(--bg)', padding: '28px 32px 40px' }}
    >
      <div style={{ maxWidth: 900, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 24 }}>
        {/* What is in force */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <h1 style={{ color: 'var(--text)', fontSize: 20, fontWeight: 600 }}>💎 {t('subscription.heading')}</h1>
          <p data-testid="subscription-status" style={{ color: 'var(--text-muted)', fontSize: 12 }}>
            {t('subscription.statusLabel')}: {t(statusNameKey(state))}
            {state.status === 'active' && expiry && ` (${t('subscription.expiresOn', { date: expiry })})`}
            {state.status === 'grace_period' && ` (${t('subscription.graceLeft', { days: state.graceDaysLeft })})`}
            {!licensed && state.trial.active && ` (${formatRemaining(trialMsRemaining, t)})`}
          </p>
          <p style={{ color: 'var(--text-faint)', fontSize: 12 }}>{t('subscription.subheading')}</p>
        </div>

        {/* A trial that has run out is the one moment this page must explain
            itself; the grace period is the other. */}
        {!licensed && state.trial.used && !state.trial.active && (
          <div
            data-testid="trial-ended"
            style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px' }}
          >
            <p style={{ color: 'var(--text)', fontSize: 12, fontWeight: 500 }}>{t('subscription.trialEndedTitle')}</p>
            <p style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 4 }}>{t('subscription.trialEndedBody')}</p>
          </div>
        )}

        {state.status === 'grace_period' && (
          <div
            data-testid="grace-notice"
            style={{ background: 'var(--warn-bg)', border: '1px solid var(--warn-border)', borderRadius: 8, padding: '12px 14px' }}
          >
            <p style={{ color: 'var(--warn-text)', fontSize: 12 }}>
              {t('subscription.graceBody', { days: state.graceDaysLeft })}
            </p>
          </div>
        )}

        {phase.kind === 'paid' && (
          <div
            data-testid="subscribe-success"
            style={{ background: 'var(--success-bg)', border: '1px solid var(--success-border)', borderRadius: 8, padding: '10px 14px', color: 'var(--success-text)', fontSize: 12 }}
          >
            {t('subscription.paySuccess')}
          </div>
        )}

        {phase.kind === 'error' && (
          <div
            data-testid="subscribe-error"
            style={{ background: 'var(--danger-bg)', border: '1px solid var(--danger-border)', borderRadius: 8, padding: '10px 14px', color: 'var(--danger-text)', fontSize: 12 }}
          >
            {t('subscription.payFailed', { reason: phase.message })}
          </div>
        )}

        {phase.kind === 'timeout' && (
          <div
            data-testid="subscribe-timeout"
            style={{ background: 'var(--info-bg)', border: '1px solid var(--info-border)', borderRadius: 8, padding: '10px 14px', color: 'var(--info-text)', fontSize: 12 }}
          >
            {t('subscription.payTimeout')}
          </div>
        )}

        {/* Plans */}
        {plans.length === 0 ? (
          <p data-testid="plans-loading" style={{ color: 'var(--text-faint)', fontSize: 12 }}>
            {t('subscription.plansLoading')}
          </p>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14 }}>
            {plans.map((plan) => (
              <SubscriptionCard
                key={plan.id}
                plan={plan}
                licensed={licensed}
                current={state.payload?.planId === plan.id && licensed}
                busy={phase.kind === 'creating' || phase.kind === 'waiting'}
                onSubscribe={(chosen) => { void startOrder(chosen); }}
              />
            ))}
          </div>
        )}

        {/* Said plainly rather than hidden: these are last known prices, and
            the checkout will quote the real ones. */}
        {plansAreFallback && (
          <p data-testid="plans-offline" style={{ color: 'var(--text-faint)', fontSize: 11 }}>
            {t('subscription.plansOffline')}
          </p>
        )}

        {/* Payment method */}
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
                const active = method === option.id;
                // The service sends a colour for the branded methods and
                // omits it for the card, which takes the app's accent.
                const brand = option.color || 'var(--accent)';
                return (
                  <button
                    key={option.id}
                    data-testid={`pay-${option.id}`}
                    aria-pressed={active}
                    onClick={() => setPicked(option.id)}
                    style={{
                      background: active ? brand : 'transparent',
                      border: `1px solid ${active ? brand : 'var(--border)'}`,
                      borderRadius: 6, padding: '6px 16px',
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
          <p style={{ color: 'var(--text-faint)', fontSize: 11 }}>{t('subscription.paymentHint')}</p>
        </div>

        {/* What the money buys */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <p style={{ color: 'var(--text-muted)', fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            {t('subscription.benefitsHeading')}
          </p>
          {BENEFITS.map((key) => (
            <p key={key} style={{ color: 'var(--text-secondary)', fontSize: 12 }}>· {t(key)}</p>
          ))}
        </div>

        {/* Managing a license that exists */}
        {licensed && state.payload && (
          <div
            data-testid="manage-subscription"
            style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 6 }}
          >
            <p style={{ color: 'var(--text-muted)', fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              {t('subscription.manageHeading')}
            </p>
            <p style={{ color: 'var(--text)', fontSize: 13 }}>{t(planNameKey(state.payload.planId))}</p>
            <p style={{ color: 'var(--text-muted)', fontSize: 11 }}>{t('subscription.expiresOn', { date: expiry })}</p>
            {/* One-off periods, not an auto-renewing subscription: there is
                nothing to cancel, and buying again extends from the current
                expiry rather than restarting the clock. */}
            <p style={{ color: 'var(--text-faint)', fontSize: 11 }}>{t('subscription.noAutoRenew')}</p>
            <button
              data-testid="refresh-license"
              onClick={() => { void refresh(); }}
              style={{
                alignSelf: 'flex-start', marginTop: 4, background: 'transparent',
                border: '1px solid var(--border)', borderRadius: 6, padding: '5px 14px',
                color: 'var(--text-secondary)', fontSize: 11, cursor: 'pointer',
              }}
            >
              {t('subscription.refresh')}
            </button>
          </div>
        )}

        {/* FAQ and the refund policy */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, borderTop: '1px solid var(--surface)', paddingTop: 16 }}>
          <p style={{ color: 'var(--text-muted)', fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            ❓ {t('subscription.faqHeading')}
          </p>
          {FAQ.map(({ q, a }) => (
            <details key={q}>
              <summary style={{ color: 'var(--text-secondary)', fontSize: 12, cursor: 'pointer', padding: '4px 0' }}>{t(q)}</summary>
              <p style={{ color: 'var(--text-faint)', fontSize: 11, paddingBottom: 6 }}>{t(a)}</p>
            </details>
          ))}
        </div>
      </div>

      {/* Waiting for the provider */}
      {phase.kind === 'waiting' && (
        <div
          data-testid="payment-dialog"
          role="dialog"
          aria-modal="true"
          aria-label={t('subscription.payWaitingTitle')}
          style={{
            position: 'fixed', inset: 0, background: 'var(--overlay)', display: 'flex',
            alignItems: 'center', justifyContent: 'center', zIndex: 50,
          }}
        >
          <div
            style={{
              background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10,
              padding: 24, display: 'flex', flexDirection: 'column', alignItems: 'center',
              gap: 12, minWidth: 300, maxWidth: 360, textAlign: 'center',
            }}
          >
            <p style={{ color: 'var(--text)', fontSize: 14, fontWeight: 500 }}>{t('subscription.payWaitingTitle')}</p>
            <p data-testid="payment-summary" style={{ color: 'var(--text-muted)', fontSize: 12 }}>
              {t(planNameKey(phase.order.planId))}
            </p>
            <div
              aria-hidden="true"
              style={{
                width: 22, height: 22, border: '2px solid var(--border)', borderTopColor: 'var(--accent)',
                borderRadius: '50%', animation: 'spin 0.8s linear infinite',
              }}
            />
            <p style={{ color: 'var(--text-faint)', fontSize: 11 }}>{t('subscription.payWaitingBody')}</p>
            <button
              data-testid="payment-cancel"
              onClick={stopWaiting}
              style={{
                background: 'transparent', border: '1px solid var(--border)', borderRadius: 6,
                padding: '6px 16px', color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer',
              }}
            >
              {t('subscription.payStopWaiting')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
