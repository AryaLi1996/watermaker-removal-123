/**
 * The subscription, read against the clock and kept current.
 *
 * The record itself belongs to the main process, which persists it. This hook
 * asks for it once, re-reads it after every change, and re-derives the status
 * every minute so a trial that runs out while the app is open takes effect
 * without a restart.
 *
 * A main process that has no subscription handlers — an older build, or a
 * renderer running outside Electron in tests — falls back to localStorage, so
 * the UI is never left with nothing to show.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  applyPurchase,
  entitlementsFor,
  startTrial,
  statusOf,
  type Entitlements,
  type PaidPlanId,
  type PaymentMethod,
  type Subscription,
  type SubscriptionStatus,
} from '../subscription';

/** How often the countdown and the expiry check are re-derived. */
export const TICK_MS = 60_000;

const STORAGE_KEY = 'watermark-remover:subscription';

function readLocal(): Subscription | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Subscription) : null;
  } catch {
    return null;
  }
}

function writeLocal(record: Subscription): Subscription {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    // The change still applies for this session.
  }
  return record;
}

/** The main process where it has the handlers, localStorage where it does not. */
const backend = {
  status(): Promise<Subscription | null> {
    const api = window.electronAPI;
    if (api?.subscriptionStatus) return api.subscriptionStatus();
    return Promise.resolve(readLocal() ?? writeLocal(startTrial()));
  },
  subscribe(plan: PaidPlanId, method: PaymentMethod): Promise<Subscription | null> {
    const api = window.electronAPI;
    if (api?.subscribe) return api.subscribe(plan, method);
    return Promise.resolve(writeLocal(applyPurchase(readLocal(), plan)));
  },
  cancel(): Promise<Subscription | null> {
    const api = window.electronAPI;
    if (api?.cancelAutoRenew) return api.cancelAutoRenew();
    const current = readLocal();
    return Promise.resolve(current ? writeLocal({ ...current, autoRenew: false }) : null);
  },
};

export interface UseSubscription {
  /** The stored record, or null before the first read has come back. */
  record: Subscription | null;
  status: SubscriptionStatus;
  entitlements: Entitlements;
  /** True until the first read resolves, so the UI can hold off on "not subscribed". */
  loading: boolean;
  subscribe: (plan: PaidPlanId, method: PaymentMethod) => Promise<void>;
  cancelAutoRenew: () => Promise<void>;
  refresh: () => Promise<void>;
}

export function useSubscription(): UseSubscription {
  const [record, setRecord] = useState<Subscription | null>(null);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    try {
      setRecord(await backend.status());
    } catch {
      // A handler that threw leaves the previous answer in place rather than
      // downgrading a paying user to "not subscribed" on one bad call.
    } finally {
      setLoading(false);
      setNow(Date.now());
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The countdown moves and, at the end of it, the status changes. Both come
  // from re-reading the same stored dates against a newer clock.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const subscribe = useCallback(async (plan: PaidPlanId, method: PaymentMethod) => {
    const next = await backend.subscribe(plan, method);
    if (next) {
      setRecord(next);
      setNow(Date.now());
    }
  }, []);

  const cancelAutoRenew = useCallback(async () => {
    const next = await backend.cancel();
    if (next) setRecord(next);
  }, []);

  const status = useMemo(() => statusOf(record, now), [record, now]);
  const entitlements = useMemo(() => entitlementsFor(status), [status]);

  return { record, status, entitlements, loading, subscribe, cancelAutoRenew, refresh };
}
