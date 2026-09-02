/**
 * SubscriptionPage — choose a plan, choose how to pay, pay. Or type in a key
 * you already have.
 *
 * The order of the page is the order of the decisions: the plans, the payment
 * method, the one button that spends money, and only then the side door for a
 * licence somebody already owns. What a subscription unlocks is no longer a
 * list sitting in the middle of all that — it is shown once, in a dialog,
 * when a key has actually unlocked it.
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
import FAQ from '../components/FAQ';
import LicenseInput from '../components/LicenseInput';
import PaymentMethods from '../components/PaymentMethods';
import SubscriptionCard from '../components/SubscriptionCard';
import { useTranslation } from '../hooks/useTranslation';
import type { OrderError } from '../types';
import {
  APP_MISMATCH,
  formatRemaining,
  isDemoLicense,
  isLicensed,
  licenseErrorKey,
  planNameKey,
  statusNameKey,
  type LicenseState,
  type Order,
  type OrderOutcome,
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
  /** Milliseconds left on the licence in force, ticking in the renderer.
   *  Only a demo licence shows it — a subscription is shown as a date. */
  licenseMsRemaining?: number;
  createOrder: (planId: PlanId, method: PaymentMethodId) => Promise<Order | OrderError>;
  watchOrder: (orderId: string, signal: { cancelled: boolean }) => Promise<OrderOutcome>;
  refresh: () => Promise<void>;
  activate?: (code: string) => Promise<{ success: boolean; error?: string; code?: string }>;
}

/** What a licence turns on, shown in the dialog once one is in force. */
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
  // `code` is set for the failures with their own wording — an order or a
  // license belonging to another app, which no amount of retrying fixes.
  | { kind: 'error'; message: string; code?: string };

export default function SubscriptionPage({
  state, plans, plansAreFallback, methods, trialMsRemaining, licenseMsRemaining = 0,
  createOrder, watchOrder, refresh, activate,
}: SubscriptionPageProps) {
  const { t, locale } = useTranslation();
  // The plan the pay button would buy. Nothing is chosen for the user: a
  // preselected plan is one somebody pays for without ever choosing it.
  const [planId, setPlanId] = useState<PlanId | null>(null);
  // The chosen method, or none chosen yet.
  const [picked, setPicked] = useState<PaymentMethodId | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  // Shown after a licence key is accepted: the one place the feature list
  // still appears, at the moment it has stopped being a sales pitch.
  const [showUnlocked, setShowUnlocked] = useState(false);
  // Shared with the in-flight poll so cancelling actually stops it, rather
  // than leaving it to finish and overwrite whatever the user did next.
  const watching = useRef<{ cancelled: boolean }>({ cancelled: false });

  // The service decides which methods exist, so the default is whichever it
  // listed first rather than a hardcoded favourite that may not be enabled.
  // Derived rather than written into state on arrival: nothing to keep in
  // sync when the list changes under it.
  const method: PaymentMethodId | null = picked ?? methods[0]?.id ?? null;
  const plan = plans.find((p) => p.id === planId) ?? null;

  // A closed checkout window is not a failed payment — the order may already
  // be paid — so this only takes down the dialog, and the poll continues.
  useEffect(() => {
    window.electronAPI.onPaymentWindowClosed?.(() => {
      setPhase((current) => (current.kind === 'waiting' ? { kind: 'idle' } : current));
    });
  }, []);

  useEffect(() => () => { watching.current.cancelled = true; }, []);

  const pay = useCallback(async () => {
    if (!plan || !method) return;
    setPhase({ kind: 'creating', planId: plan.id });

    const created = await createOrder(plan.id, method);
    if ('error' in created) {
      setPhase({ kind: 'error', message: created.error, code: created.code });
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
    else if (outcome === 'mismatch') setPhase({ kind: 'error', message: '', code: APP_MISMATCH });
    else setPhase({ kind: 'idle' });
  }, [createOrder, method, plan, watchOrder]);

  const stopWaiting = useCallback(() => {
    watching.current.cancelled = true;
    void window.electronAPI.paymentCloseEmbedded?.();
    setPhase({ kind: 'idle' });
  }, []);

  // A failure with wording of its own — a licence belonging to another app —
  // or null, in which case the reason the service gave is what to show.
  const errorKey = phase.kind === 'error' ? licenseErrorKey(phase.code) : null;

  const licensed = isLicensed(state.status);
  // A demo in force. Its countdown comes in on the same ticking clock as the
  // trial's rather than being read off the wall clock here.
  const demoLicensed = licensed && isDemoLicense(state);
  const busy = phase.kind === 'creating' || phase.kind === 'waiting';
  const canPay = !!plan && !!method && !busy;
  const expiry = state.expiresAt
    ? new Date(state.expiresAt).toLocaleDateString(locale === 'zh' ? 'zh-CN' : 'en-GB')
    : '';

  return (
    <div
      data-testid="subscription-page"
      style={{ flex: 1, overflowY: 'auto', background: 'var(--bg)', padding: '28px 32px 40px' }}
    >
      <div style={{ maxWidth: 900, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 22 }}>
        {/* What is in force. The top bar carries the short version on every
            screen; this is the same answer with its dates attached. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <h1 style={{ color: 'var(--text)', fontSize: 20, fontWeight: 600 }}>💎 {t('subscription.heading')}</h1>
          <p data-testid="subscription-status" style={{ color: 'var(--text-muted)', fontSize: 12 }}>
            {t('subscription.statusLabel')}: {t(statusNameKey(state))}
            {state.status === 'active' && expiry && ` (${t('subscription.expiresOn', { date: expiry })})`}
            {state.status === 'grace_period' && ` (${t('subscription.graceLeft', { days: state.graceDaysLeft })})`}
            {!licensed && state.trial.active && ` (${formatRemaining(trialMsRemaining, t)})`}
            {demoLicensed && ` (${formatRemaining(licenseMsRemaining, t)})`}
          </p>
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
            {errorKey ? t(errorKey) : t('subscription.payFailed', { reason: phase.message })}
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

        {/* Choose a plan */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ color: 'var(--text)', fontSize: 14, fontWeight: 600 }}>{t('subscription.planHeading')}</p>
          {plans.length === 0 ? (
            <p data-testid="plans-loading" style={{ color: 'var(--text-faint)', fontSize: 12 }}>
              {t('subscription.plansLoading')}
            </p>
          ) : (
            <div className="plan-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 14 }}>
              {plans.map((option) => (
                <SubscriptionCard
                  key={option.id}
                  plan={option}
                  selected={planId === option.id}
                  licensed={licensed}
                  onSelect={(chosen) => setPlanId(chosen.id)}
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
        </div>

        <PaymentMethods methods={methods} selected={method} onSelect={setPicked} />

        {/* The one button that spends money. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button
            data-testid="pay-now"
            onClick={() => { void pay(); }}
            disabled={!canPay}
            style={{
              alignSelf: 'flex-start', minWidth: 180,
              background: canPay ? 'var(--accent)' : 'var(--accent-soft)',
              border: 'none', borderRadius: 8, padding: '10px 26px',
              color: canPay ? 'var(--accent-contrast)' : 'var(--accent-disabled-text)',
              fontSize: 13, fontWeight: 500,
              cursor: busy ? 'wait' : canPay ? 'pointer' : 'not-allowed',
            }}
          >
            {busy ? t('subscription.payWorking') : t('subscription.payNow')}
          </button>

          {/* Why the button is not doing anything, where the button is. */}
          <p data-testid="pay-hint" style={{ color: 'var(--text-faint)', fontSize: 11 }}>
            {!plan
              ? t('subscription.payChoosePlan')
              : !method
                ? t('subscription.payChooseMethod')
                : `${t('subscription.planSelected')}: ${t(planNameKey(plan.id))}`}
          </p>
          <p style={{ color: 'var(--text-faint)', fontSize: 11 }}>⚠ {t('subscription.paymentHint')}</p>
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
                expiry rather than restarting the clock. A demo is the one
                case where that is not true — the service never issued it and
                has nothing to extend — so it says something else. */}
            <p style={{ color: 'var(--text-faint)', fontSize: 11 }}>
              {t(demoLicensed ? 'subscription.demoNoExtend' : 'subscription.noAutoRenew')}
            </p>
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

        <hr style={{ border: 'none', borderTop: '1px solid var(--border)' }} />

        <LicenseInput activate={activate} onActivated={() => setShowUnlocked(true)} />

        <hr style={{ border: 'none', borderTop: '1px solid var(--border)' }} />

        <FAQ />
      </div>

      {/* What the licence just unlocked. It only appears once something has
          been unlocked, which is why it is a dialog and not a list of
          promises halfway up the page. */}
      {showUnlocked && (
        <div
          data-testid="unlocked-dialog"
          role="dialog"
          aria-modal="true"
          aria-label={t('subscription.unlockedHeading')}
          style={{
            position: 'fixed', inset: 0, background: 'var(--overlay)', display: 'flex',
            alignItems: 'center', justifyContent: 'center', zIndex: 50,
          }}
        >
          <div
            style={{
              background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10,
              padding: 24, display: 'flex', flexDirection: 'column', gap: 10,
              minWidth: 300, maxWidth: 380,
            }}
          >
            <p style={{ color: 'var(--text)', fontSize: 14, fontWeight: 500 }}>✅ {t('subscription.unlockedHeading')}</p>
            {BENEFITS.map((key) => (
              <p key={key} style={{ color: 'var(--text-secondary)', fontSize: 12 }}>· {t(key)}</p>
            ))}
            <button
              data-testid="unlocked-close"
              onClick={() => setShowUnlocked(false)}
              style={{
                alignSelf: 'flex-end', marginTop: 4, background: 'var(--accent)', border: 'none',
                borderRadius: 6, padding: '6px 18px', color: 'var(--accent-contrast)',
                fontSize: 12, cursor: 'pointer',
              }}
            >
              {t('subscription.unlockedClose')}
            </button>
          </div>
        </div>
      )}

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
