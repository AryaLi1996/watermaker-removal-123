/**
 * The subscription page against the payment flow it actually drives.
 *
 * The flow is the thing worth covering here: a click creates an order with
 * the service, a checkout opens, and the page waits — it never decides for
 * itself that a payment succeeded, because the only thing that could make
 * that work is trusting the client's word for it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import SubscriptionPage from './SubscriptionPage';
import SubscriptionStatusBar from '../components/SubscriptionStatusBar';
import { LOADING_STATE, type LicenseState, type LicenseStatus, type PaymentMethod, type Plan, type TrialState } from '../subscription';
import { setLocale } from '../i18n';

const DAY = 24 * 60 * 60 * 1000;

const PLANS: Plan[] = [
  { id: 'monthly', period: 'month', durationDays: 30, discountPercent: 0, price: 99, priceUSD: 14, originalPrice: 99, originalPriceUSD: 14, currency: 'cny' },
  { id: 'quarterly', period: 'quarter', durationDays: 90, discountPercent: 5, price: 282, priceUSD: 40, originalPrice: 297, originalPriceUSD: 42, currency: 'cny' },
  { id: 'semi_annual', period: 'half_year', durationDays: 180, discountPercent: 10, price: 535, priceUSD: 76, originalPrice: 594, originalPriceUSD: 85, currency: 'cny' },
  { id: 'annual', period: 'year', durationDays: 365, discountPercent: 15, price: 1010, priceUSD: 144, originalPrice: 1188, originalPriceUSD: 170, currency: 'cny' },
];

const METHODS: PaymentMethod[] = [
  { id: 'wechat_pay', enabled: true, name: 'WeChat Pay', icon: '微', color: '#07c160' },
  { id: 'alipay', enabled: true, name: 'Alipay', icon: '支', color: '#1677ff' },
];

const trial = (over: Partial<TrialState> = {}): TrialState => ({
  used: false, active: false, start: null, end: null, msRemaining: 0, durationDays: 3, source: 'server', ...over,
});

const state = (status: LicenseStatus, over: Partial<LicenseState> = {}): LicenseState => ({
  ...LOADING_STATE, status, trial: trial(), ...over,
});

const TRIALING = state('unlicensed', { trial: trial({ used: true, active: true, msRemaining: 2 * DAY }) });

function stubElectronAPI() {
  const api = {
    licenseConfig: vi.fn().mockResolvedValue({ orderPollIntervalMs: 1, orderPollTimeoutMs: 50 }),
    paymentOpenExternal: vi.fn().mockResolvedValue(true),
    paymentOpenEmbedded: vi.fn().mockResolvedValue(true),
    paymentCloseEmbedded: vi.fn().mockResolvedValue(true),
    onPaymentWindowClosed: vi.fn(),
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = api;
  return api;
}

function renderPage(licenseState = TRIALING, over: Partial<Parameters<typeof SubscriptionPage>[0]> = {}) {
  const createOrder = vi.fn().mockResolvedValue({
    orderId: 'o-1', planId: 'quarterly', method: 'wechat_pay', status: 'pending',
    amount: 28200, currency: 'cny', createdAt: 0, presentAs: 'embedded', redirectUrl: 'https://pay.example/o-1',
  });
  const watchOrder = vi.fn().mockResolvedValue('paid');
  const refresh = vi.fn().mockResolvedValue(undefined);
  const props = {
    state: licenseState, plans: PLANS, plansAreFallback: false, methods: METHODS,
    trialMsRemaining: licenseState.trial.msRemaining,
    createOrder, watchOrder, refresh, ...over,
  };
  render(<SubscriptionPage {...props} />);
  return { createOrder, watchOrder, refresh };
}

let api: ReturnType<typeof stubElectronAPI>;

beforeEach(() => {
  api = stubElectronAPI();
  setLocale('en');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the plans', () => {
  it('are shown at the prices the service returned', () => {
    renderPage();
    expect(screen.getByTestId('plan-monthly')).toHaveTextContent('¥99/month');
    expect(screen.getByTestId('plan-quarterly')).toHaveTextContent('¥282/quarter');
    expect(screen.getByTestId('plan-semi_annual')).toHaveTextContent('¥535/6 months');
    expect(screen.getByTestId('plan-annual')).toHaveTextContent('¥1010/year');
  });

  it('show the discount and the pre-discount total the service computed', () => {
    renderPage();
    expect(screen.getByTestId('plan-annual')).toHaveTextContent('15% off');
    expect(screen.getByTestId('plan-annual')).toHaveTextContent('¥1188');
    expect(screen.getByTestId('plan-monthly')).toHaveTextContent('No discount');
  });

  it('say so when they are the offline fallback rather than live', () => {
    renderPage(TRIALING, { plansAreFallback: true });
    expect(screen.getByTestId('plans-offline')).toBeInTheDocument();
  });

  it('wait rather than inventing prices before the service answers', () => {
    renderPage(TRIALING, { plans: [] });
    expect(screen.getByTestId('plans-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('plan-monthly')).toBeNull();
  });
});

describe('the payment methods', () => {
  it('are the ones the service says are usable, under its own names', () => {
    renderPage();
    expect(screen.getByTestId('pay-wechat_pay')).toHaveTextContent('WeChat Pay');
    expect(screen.getByTestId('pay-alipay')).toHaveTextContent('Alipay');
  });

  it('default to the first one offered rather than a hardcoded favourite', () => {
    renderPage(TRIALING, { methods: [METHODS[1]] });
    expect(screen.getByTestId('pay-alipay')).toHaveAttribute('aria-pressed', 'true');
  });

  it('say plainly when none is available, instead of offering one that fails', () => {
    renderPage(TRIALING, { methods: [] });
    expect(screen.getByTestId('methods-unavailable')).toBeInTheDocument();
  });
});

describe('paying', () => {
  it('creates an order for the chosen plan and method, then opens the checkout', async () => {
    const { createOrder } = renderPage();

    fireEvent.click(screen.getByTestId('pay-alipay'));
    fireEvent.click(screen.getByTestId('subscribe-quarterly'));

    await waitFor(() => expect(createOrder).toHaveBeenCalledWith('quarterly', 'alipay'));
    // A QR-code method gets its own window; the checkout page is never
    // loaded into the app's own.
    await waitFor(() => expect(api.paymentOpenEmbedded).toHaveBeenCalledWith('https://pay.example/o-1'));
  });

  it('opens the system browser for a method that presents there', async () => {
    const createOrder = vi.fn().mockResolvedValue({
      orderId: 'o-2', planId: 'annual', method: 'card', status: 'pending', amount: 101000,
      currency: 'cny', createdAt: 0, presentAs: 'external', redirectUrl: 'https://pay.example/o-2',
    });
    renderPage(TRIALING, { createOrder });

    fireEvent.click(screen.getByTestId('subscribe-annual'));
    await waitFor(() => expect(api.paymentOpenExternal).toHaveBeenCalledWith('https://pay.example/o-2'));
    expect(api.paymentOpenEmbedded).not.toHaveBeenCalled();
  });

  it('waits for the service rather than asking the user whether they paid', async () => {
    // No "I have paid" button: the provider's webhook is what settles an
    // order, and the client's opinion of it is worth nothing.
    const watchOrder = vi.fn(() => new Promise<'paid'>(() => {}));
    renderPage(TRIALING, { watchOrder });

    fireEvent.click(screen.getByTestId('subscribe-monthly'));
    await waitFor(() => expect(screen.getByTestId('payment-dialog')).toBeInTheDocument());
    expect(screen.queryByText(/I have paid/i)).toBeNull();
  });

  it('reports success once the order is paid', async () => {
    renderPage();
    fireEvent.click(screen.getByTestId('subscribe-quarterly'));
    await waitFor(() => expect(screen.getByTestId('subscribe-success')).toBeInTheDocument());
    expect(api.paymentCloseEmbedded).toHaveBeenCalled();
  });

  it('says what went wrong when the order could not be created', async () => {
    const createOrder = vi.fn().mockResolvedValue({ error: 'payment method not available' });
    renderPage(TRIALING, { createOrder });

    fireEvent.click(screen.getByTestId('subscribe-monthly'));
    await waitFor(() => expect(screen.getByTestId('subscribe-error')).toHaveTextContent('payment method not available'));
    expect(api.paymentOpenEmbedded).not.toHaveBeenCalled();
  });

  it('explains an order the service scoped to another app, rather than a raw reason', async () => {
    // Retrying never fixes this one, so it gets its own wording telling the
    // user to activate here — not "could not start the payment: …".
    const createOrder = vi.fn().mockResolvedValue({ error: 'appId mismatch', code: 'app_mismatch' });
    renderPage(TRIALING, { createOrder });

    fireEvent.click(screen.getByTestId('subscribe-monthly'));
    await waitFor(() => expect(screen.getByTestId('subscribe-error')).toHaveTextContent(/different app/i));
    expect(screen.getByTestId('subscribe-error')).not.toHaveTextContent('appId mismatch');
  });

  it('does not claim a payment unlocked anything when the licence was another app\'s', async () => {
    // The money went through; what it bought was scoped elsewhere. Reporting
    // success here would leave the user looking for features they cannot use.
    const watchOrder = vi.fn().mockResolvedValue('mismatch');
    renderPage(TRIALING, { watchOrder });

    fireEvent.click(screen.getByTestId('subscribe-monthly'));
    await waitFor(() => expect(screen.getByTestId('subscribe-error')).toHaveTextContent(/different app/i));
    expect(screen.queryByTestId('subscribe-success')).toBeNull();
  });

  it('gives up watching after the timeout, and says what to do about it', async () => {
    const watchOrder = vi.fn().mockResolvedValue('timeout');
    renderPage(TRIALING, { watchOrder });

    fireEvent.click(screen.getByTestId('subscribe-monthly'));
    await waitFor(() => expect(screen.getByTestId('subscribe-timeout')).toBeInTheDocument());
  });

  it('stops waiting when asked, and closes the checkout window with it', async () => {
    let stop: (v: 'cancelled') => void = () => {};
    const watchOrder = vi.fn((_id: string, signal: { cancelled: boolean }) =>
      new Promise<'cancelled'>((resolve) => { stop = () => { signal.cancelled = true; resolve('cancelled'); }; }));
    renderPage(TRIALING, { watchOrder });

    fireEvent.click(screen.getByTestId('subscribe-monthly'));
    await waitFor(() => expect(screen.getByTestId('payment-dialog')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('payment-cancel'));
    stop('cancelled');
    await waitFor(() => expect(screen.queryByTestId('payment-dialog')).toBeNull());
    expect(api.paymentCloseEmbedded).toHaveBeenCalled();
  });
});

describe('what the page says about the current state', () => {
  it('counts the trial down', () => {
    renderPage();
    expect(screen.getByTestId('subscription-status')).toHaveTextContent('Free trial');
    expect(screen.getByTestId('subscription-status')).toHaveTextContent('2 days');
  });

  it('explains a trial that has run out', () => {
    renderPage(state('unlicensed', { trial: trial({ used: true, active: false }) }));
    expect(screen.getByTestId('trial-ended')).toBeInTheDocument();
  });

  it('explains the grace period rather than just saying "expired"', () => {
    renderPage(state('grace_period', { graceDaysLeft: 2 }));
    expect(screen.getByTestId('grace-notice')).toHaveTextContent('2 more days');
  });

  it('shows the plan, its end date and that nothing renews itself', () => {
    const licensed = state('active', {
      payload: { userId: 'u', planId: 'annual', licenseKey: 'K', expiresAt: 0, issuedAt: 0 },
      expiresAt: '2027-03-01T12:00:00.000Z',
      daysRemaining: 200,
    });
    renderPage(licensed);

    const panel = screen.getByTestId('manage-subscription');
    expect(panel).toHaveTextContent('Yearly');
    expect(panel).toHaveTextContent('Runs until');
    // One-off periods: there is no auto-renewal, so there is nothing to cancel.
    expect(panel).toHaveTextContent('nothing renews automatically');
  });

  it('offers nothing to manage without a license', () => {
    renderPage();
    expect(screen.queryByTestId('manage-subscription')).toBeNull();
  });

  it('re-checks the license on request, for a payment that landed late', async () => {
    const licensed = state('active', {
      payload: { userId: 'u', planId: 'monthly', licenseKey: 'K', expiresAt: 0, issuedAt: 0 },
      expiresAt: '2027-03-01T12:00:00.000Z',
    });
    const { refresh } = renderPage(licensed);
    fireEvent.click(screen.getByTestId('refresh-license'));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('translates the page', () => {
    setLocale('zh');
    renderPage();
    expect(screen.getByTestId('plan-quarterly')).toHaveTextContent('季卡');
    expect(screen.getByTestId('subscription-status')).toHaveTextContent('免费试用');
  });
});

describe('SubscriptionStatusBar', () => {
  const bar = (s: LicenseState, ms = s.trial.msRemaining, loading = false) =>
    render(<SubscriptionStatusBar state={s} trialMsRemaining={ms} loading={loading} onOpen={vi.fn()} />);

  it('counts the trial down and offers the way to subscribe', () => {
    bar(TRIALING);
    expect(screen.getByTestId('subscription-bar-label')).toHaveTextContent('free trial');
    expect(screen.getByTestId('subscription-bar-label')).toHaveTextContent('2 days');
    expect(screen.getByTestId('status-bar-subscribe')).toBeInTheDocument();
  });

  it('names the plan, and drops the prompt, once one is in force', () => {
    bar(state('active', { payload: { userId: 'u', planId: 'monthly', licenseKey: 'K', expiresAt: 0, issuedAt: 0 } }));
    expect(screen.getByTestId('subscription-bar-label')).toHaveTextContent('Subscription: Monthly');
    expect(screen.queryByTestId('status-bar-subscribe')).toBeNull();
  });

  it('says the grace period is running, and still offers to renew', () => {
    bar(state('grace_period', { graceDaysLeft: 2 }));
    expect(screen.getByTestId('subscription-bar-label')).toHaveTextContent('2 days of grace');
    expect(screen.getByTestId('status-bar-subscribe')).toBeInTheDocument();
  });

  it('says the trial has ended once it has', () => {
    bar(state('unlicensed', { trial: trial({ used: true, active: false }) }));
    expect(screen.getByTestId('subscription-bar-label')).toHaveTextContent('trial ended');
  });

  it('claims nothing before the state has been read', () => {
    bar(LOADING_STATE, 0, true);
    expect(screen.getByTestId('subscription-bar-label')).toHaveTextContent('');
    expect(screen.queryByTestId('status-bar-subscribe')).toBeNull();
  });
});
