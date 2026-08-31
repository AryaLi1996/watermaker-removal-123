/**
 * The license, as the interface uses it.
 *
 * The state machine is in the main process; this hook reads it, listens for
 * the pushes it sends when the trial runs out or a payment settles, and wraps
 * the payment calls. Nothing about expiry is computed here — one place
 * deciding that is what keeps the answer consistent.
 *
 * The countdown is the exception: it re-renders on a timer so the trial's
 * remaining time visibly moves, while the state behind it is unchanged.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { OrderError, TemporalUsage } from '../types';
import {
  APP_MISMATCH,
  entitlementsFor,
  LOADING_STATE,
  type OrderOutcome,
  type Entitlements,
  type LicenseState,
  type Order,
  type PaymentMethod,
  type PaymentMethodId,
  type Plan,
  type PlanId,
} from '../subscription';

/** How often the trial countdown is redrawn. */
export const TICK_MS = 60_000;

export interface UseSubscription {
  state: LicenseState;
  entitlements: Entitlements;
  /** True until the main process has answered for the first time. */
  loading: boolean;
  /** The plans, from the service — or the offline fallback, which says so. */
  plans: Plan[];
  plansAreFallback: boolean;
  methods: PaymentMethod[];
  /** Milliseconds left on the trial, recomputed as the clock moves. */
  trialMsRemaining: number;
  createOrder: (planId: PlanId, method: PaymentMethodId) => Promise<Order | OrderError>;
  /** The trial's remaining temporal-fill exports. Null until the main
   *  process answers, or where it does not meter them at all. */
  temporalUsage: TemporalUsage | null;
  /** Whether this build offers the box for typing a licence in by hand. */
  manualActivation: boolean;
  /** Activate from a licence key or a pasted token. */
  activate: (code: string) => Promise<{ success: boolean; error?: string; code?: string }>;
  /** Poll one order until it is paid, the user gives up, or time runs out. */
  watchOrder: (orderId: string, signal: { cancelled: boolean }) => Promise<OrderOutcome>;
  refresh: () => Promise<void>;
}

export function useSubscription(locale: string): UseSubscription {
  // The state and when it was read, together: the countdown is derived from
  // both, so keeping them in one value is what stops them disagreeing.
  const [reading, setReading] = useState<{ state: LicenseState; readAt: number }>(
    { state: LOADING_STATE, readAt: 0 },
  );
  const [loading, setLoading] = useState(true);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [plansAreFallback, setPlansAreFallback] = useState(false);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [manualActivation, setManualActivation] = useState(false);
  const [temporalUsage, setTemporalUsage] = useState<TemporalUsage | null>(null);

  const applyState = useCallback((next: LicenseState) => {
    const at = Date.now();
    setReading({ state: next, readAt: at });
    setNow(at);
  }, []);

  useEffect(() => {
    const api = window.electronAPI;
    let cancelled = false;

    void api.licenseState?.()
      .then((s) => { if (!cancelled && s) applyState(s); })
      .catch(() => {
        // Leave the loading state showing rather than claiming "not
        // subscribed" on one failed call.
      })
      .finally(() => { if (!cancelled) setLoading(false); });

    api.onLicenseState?.((s) => { if (!cancelled) applyState(s); });
    return () => {
      cancelled = true;
      api.removeLicenseListeners?.();
    };
  }, [applyState]);

  // The allowance is read once and then pushed: it changes when an export
  // starts, and when a licence arrives and clears it.
  useEffect(() => {
    const api = window.electronAPI;
    let cancelled = false;
    void api.temporalUsage?.()
      .then((usage) => { if (!cancelled && usage) setTemporalUsage(usage); })
      .catch(() => {});
    api.onTemporalUsage?.((usage) => { if (!cancelled && usage) setTemporalUsage(usage); });
    return () => {
      cancelled = true;
      api.removeTemporalUsageListeners?.();
    };
  }, []);

  // Whether to offer manual activation is the main process's to decide: the
  // environment variable behind it is not visible from here.
  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.licenseConfig?.()
      .then((config) => { if (!cancelled && config) setManualActivation(!!config.manualActivationEnabled); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Plans and methods come from the service, and the method list is
  // localised there, so it is re-fetched when the language changes.
  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.paymentPlans?.()
      .then((res) => {
        if (cancelled || !res) return;
        setPlans(res.plans);
        setPlansAreFallback(res.source === 'fallback');
      })
      .catch(() => {});
    void window.electronAPI.paymentMethods?.(locale === 'zh' ? 'zh-CN' : 'en-US')
      .then((res) => { if (!cancelled && res) setMethods(res.methods); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [locale]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const createOrder = useCallback(async (planId: PlanId, method: PaymentMethodId) => {
    const api = window.electronAPI;
    if (!api.paymentCreateOrder) return { error: 'payment is not available in this build' };
    return api.paymentCreateOrder(planId, method);
  }, []);

  const watchOrder = useCallback(async (
    orderId: string, signal: { cancelled: boolean },
  ): Promise<OrderOutcome> => {
    const api = window.electronAPI;
    const config = (await api.licenseConfig?.()) ?? { orderPollIntervalMs: 3000, orderPollTimeoutMs: 600_000 };
    const deadline = Date.now() + config.orderPollTimeoutMs;

    while (Date.now() < deadline) {
      if (signal.cancelled) return 'cancelled';
      const result = await api.paymentOrderStatus?.(orderId);
      // Paid, but the token the service issued is another app's. The money
      // is not lost — it bought a license the service scoped elsewhere — so
      // this stops the wait with a distinct outcome rather than claiming the
      // features are unlocked when they are not.
      if (result && result.status === 'paid' && result.code === APP_MISMATCH) return 'mismatch';
      if (result && result.status === 'paid') {
        // The main process adopts the token and pushes the new state; this
        // only has to report that the wait is over.
        if (result.state) applyState(result.state);
        return 'paid';
      }
      await new Promise((resolve) => setTimeout(resolve, config.orderPollIntervalMs));
    }
    return 'timeout';
  }, [applyState]);

  const activate = useCallback(async (code: string) => {
    const api = window.electronAPI;
    if (!api.licenseActivate) return { success: false, error: 'activation is not available in this build' };
    const result = await api.licenseActivate(code);
    // The main process pushes the new state on success, but reading it back
    // here is what makes the page update on the same tick as the message.
    if (result?.success) {
      const next = await api.licenseState?.().catch(() => null);
      if (next) applyState(next);
    }
    return result;
  }, [applyState]);

  const refresh = useCallback(async () => {
    await window.electronAPI.licenseRefresh?.().catch(() => {});
    const next = await window.electronAPI.licenseState?.().catch(() => null);
    if (next) applyState(next);
  }, [applyState]);

  const { state } = reading;
  const entitlements = useMemo(
    () => entitlementsFor(state, temporalUsage),
    [state, temporalUsage],
  );

  // What the main process reported, less however long ago it reported it —
  // so the countdown moves every minute without it having to push a state.
  const elapsed = reading.readAt === 0 ? 0 : now - reading.readAt;
  const trialMsRemaining = Math.max(0, state.trial.msRemaining - elapsed);

  return {
    state,
    entitlements,
    loading,
    plans,
    plansAreFallback,
    methods,
    trialMsRemaining,
    createOrder,
    watchOrder,
    refresh,
    temporalUsage,
    manualActivation,
    activate,
  };
}
