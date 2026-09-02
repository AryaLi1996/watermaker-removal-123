/**
 * The subscription page against the payment flow it actually drives.
 *
 * The flow is the thing worth covering here: a plan and a method are chosen,
 * one button creates the order with the service, a checkout opens, and the
 * page waits — it never decides for itself that a payment succeeded, because
 * the only thing that could make that work is trusting the client's word for
 * it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import SubscriptionPage from './SubscriptionPage';
import {
  DEMO_PLAN_ID, LOADING_STATE,
  type LicenseState, type LicenseStatus, type PaymentMethod, type Plan, type TrialState,
} from '../subscription';
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

/** Choose a plan, then spend on it — the two steps the page now separates. */
function choosePlan(id: string) {
  fireEvent.click(screen.getByTestId(`subscribe-${id}`));
}

function payNow() {
  fireEvent.click(screen.getByTestId('pay-now'));
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

  it('carry the popularity chip the row is read by', () => {
    renderPage();
    expect(screen.getByTestId('plan-monthly')).toHaveTextContent('Good for trying it out');
    expect(screen.getByTestId('plan-quarterly')).toHaveTextContent('Most popular');
    expect(screen.getByTestId('plan-semi_annual')).toHaveTextContent('Great value');
    expect(screen.getByTestId('plan-annual')).toHaveTextContent('Best price');
  });

  it('start with nothing chosen, so nobody pays for a plan they never picked', () => {
    renderPage();
    for (const id of ['monthly', 'quarterly', 'semi_annual', 'annual']) {
      expect(screen.getByTestId(`plan-${id}`)).toHaveAttribute('aria-pressed', 'false');
    }
    expect(screen.getByTestId('pay-hint')).toHaveTextContent('Choose a plan');
  });

  it('mark the chosen one, and only that one', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('plan-annual'));

    expect(screen.getByTestId('plan-annual')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('plan-monthly')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('pay-hint')).toHaveTextContent('Yearly');

    // The choice moves rather than accumulating.
    fireEvent.click(screen.getByTestId('plan-monthly'));
    expect(screen.getByTestId('plan-annual')).toHaveAttribute('aria-pressed', 'false');
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
  it('will not spend anything until a plan has been chosen', () => {
    const { createOrder } = renderPage();

    // The method defaults to the first the service listed, so the plan is the
    // only thing still missing — and the button says so rather than failing
    // silently on a click.
    expect(screen.getByTestId('pay-now')).toBeDisabled();
    payNow();
    expect(createOrder).not.toHaveBeenCalled();
  });

  it('says which choice is missing when no method is on offer', () => {
    renderPage(TRIALING, { methods: [] });
    choosePlan('annual');
    expect(screen.getByTestId('pay-now')).toBeDisabled();
    expect(screen.getByTestId('pay-hint')).toHaveTextContent('payment method');
  });

  it('creates an order for the chosen plan and method, then opens the checkout', async () => {
    const { createOrder } = renderPage();

    fireEvent.click(screen.getByTestId('pay-alipay'));
    choosePlan('quarterly');
    payNow();

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

    choosePlan('annual');
    payNow();
    await waitFor(() => expect(api.paymentOpenExternal).toHaveBeenCalledWith('https://pay.example/o-2'));
    expect(api.paymentOpenEmbedded).not.toHaveBeenCalled();
  });

  it('waits for the service rather than asking the user whether they paid', async () => {
    // No "I have paid" button: the provider's webhook is what settles an
    // order, and the client's opinion of it is worth nothing.
    const watchOrder = vi.fn(() => new Promise<'paid'>(() => {}));
    renderPage(TRIALING, { watchOrder });

    choosePlan('monthly');
    payNow();
    await waitFor(() => expect(screen.getByTestId('payment-dialog')).toBeInTheDocument());
    expect(screen.queryByText(/I have paid/i)).toBeNull();
  });

  it('reports success once the order is paid', async () => {
    renderPage();
    choosePlan('quarterly');
    payNow();
    await waitFor(() => expect(screen.getByTestId('subscribe-success')).toBeInTheDocument());
    expect(api.paymentCloseEmbedded).toHaveBeenCalled();
  });

  it('says what went wrong when the order could not be created', async () => {
    const createOrder = vi.fn().mockResolvedValue({ error: 'payment method not available' });
    renderPage(TRIALING, { createOrder });

    choosePlan('monthly');
    payNow();
    await waitFor(() => expect(screen.getByTestId('subscribe-error')).toHaveTextContent('payment method not available'));
    expect(api.paymentOpenEmbedded).not.toHaveBeenCalled();
  });

  it('explains an order the service scoped to another app, rather than a raw reason', async () => {
    // Retrying never fixes this one, so it gets its own wording telling the
    // user to activate here — not "could not start the payment: …".
    const createOrder = vi.fn().mockResolvedValue({ error: 'appId mismatch', code: 'app_mismatch' });
    renderPage(TRIALING, { createOrder });

    choosePlan('monthly');
    payNow();
    await waitFor(() => expect(screen.getByTestId('subscribe-error')).toHaveTextContent(/different app/i));
    expect(screen.getByTestId('subscribe-error')).not.toHaveTextContent('appId mismatch');
  });

  it('does not claim a payment unlocked anything when the licence was another app\'s', async () => {
    // The money went through; what it bought was scoped elsewhere. Reporting
    // success here would leave the user looking for features they cannot use.
    const watchOrder = vi.fn().mockResolvedValue('mismatch');
    renderPage(TRIALING, { watchOrder });

    choosePlan('monthly');
    payNow();
    await waitFor(() => expect(screen.getByTestId('subscribe-error')).toHaveTextContent(/different app/i));
    expect(screen.queryByTestId('subscribe-success')).toBeNull();
  });

  it('gives up watching after the timeout, and says what to do about it', async () => {
    const watchOrder = vi.fn().mockResolvedValue('timeout');
    renderPage(TRIALING, { watchOrder });

    choosePlan('monthly');
    payNow();
    await waitFor(() => expect(screen.getByTestId('subscribe-timeout')).toBeInTheDocument());
  });

  it('stops waiting when asked, and closes the checkout window with it', async () => {
    let stop: (v: 'cancelled') => void = () => {};
    const watchOrder = vi.fn((_id: string, signal: { cancelled: boolean }) =>
      new Promise<'cancelled'>((resolve) => { stop = () => { signal.cancelled = true; resolve('cancelled'); }; }));
    renderPage(TRIALING, { watchOrder });

    choosePlan('monthly');
    payNow();
    await waitFor(() => expect(screen.getByTestId('payment-dialog')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('payment-cancel'));
    stop('cancelled');
    await waitFor(() => expect(screen.queryByTestId('payment-dialog')).toBeNull());
    expect(api.paymentCloseEmbedded).toHaveBeenCalled();
  });

  it('will not start a second order while one is in flight', async () => {
    const watchOrder = vi.fn(() => new Promise<'paid'>(() => {}));
    const { createOrder } = renderPage(TRIALING, { watchOrder });

    choosePlan('monthly');
    payNow();
    await waitFor(() => expect(screen.getByTestId('payment-dialog')).toBeInTheDocument());

    payNow();
    expect(createOrder).toHaveBeenCalledTimes(1);
  });
});

describe('the licence box', () => {
  /**
   * The box that takes a key somebody already has. It stands where the demo
   * card used to and is always on now: the shop issues these keys, so hiding
   * it behind a build flag only generates support questions.
   */
  it('is always there, with the key format it accepts in the box', () => {
    renderPage();
    expect(screen.getByTestId('license-input')).toBeInTheDocument();
    expect(screen.getByTestId('activation-code'))
      .toHaveAttribute('placeholder', 'SOOTHEVOICE-XXXX-XXXX-XXXX');
  });

  it('passes what was typed to the same verification a purchase uses', async () => {
    const activate = vi.fn().mockResolvedValue({ success: true });
    renderPage(TRIALING, { activate });

    fireEvent.change(screen.getByTestId('activation-code'), { target: { value: '  KEY12345  ' } });
    fireEvent.click(screen.getByTestId('activation-submit'));

    // Trimmed: a code copied out of an email brings whitespace with it.
    await waitFor(() => expect(activate).toHaveBeenCalledWith('KEY12345'));
    await waitFor(() => expect(screen.getByTestId('activation-success')).toBeTruthy());
  });

  it('shows what the key unlocked, rather than listing it before there is one', async () => {
    // The benefits used to sit halfway up the page as a promise. They appear
    // once, here, at the moment they have stopped being one.
    const activate = vi.fn().mockResolvedValue({ success: true });
    renderPage(TRIALING, { activate });
    expect(screen.queryByTestId('unlocked-dialog')).toBeNull();

    fireEvent.change(screen.getByTestId('activation-code'), { target: { value: 'KEY12345' } });
    fireEvent.click(screen.getByTestId('activation-submit'));

    const dialog = await screen.findByTestId('unlocked-dialog');
    expect(dialog).toHaveTextContent('Temporal fill');
    fireEvent.click(screen.getByTestId('unlocked-close'));
    await waitFor(() => expect(screen.queryByTestId('unlocked-dialog')).toBeNull());
  });

  it('says nothing was unlocked when the key was refused', async () => {
    const activate = vi.fn().mockResolvedValue({ success: false, error: 'License key not accepted' });
    renderPage(TRIALING, { activate });

    fireEvent.change(screen.getByTestId('activation-code'), { target: { value: 'NOPE1234' } });
    fireEvent.click(screen.getByTestId('activation-submit'));

    await waitFor(() => expect(screen.getByTestId('activation-error'))
      .toHaveTextContent('License key not accepted'));
    expect(screen.queryByTestId('unlocked-dialog')).toBeNull();
  });

  it('will not submit an empty box', () => {
    const activate = vi.fn();
    renderPage(TRIALING, { activate });

    expect((screen.getByTestId('activation-submit') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('activation-submit'));
    expect(activate).not.toHaveBeenCalled();
  });

  it('words an expired licence as expired, not as a typo', async () => {
    const activate = vi.fn().mockResolvedValue({ success: false, code: 'expired', error: 'This license has already expired' });
    renderPage(TRIALING, { activate });

    fireEvent.change(screen.getByTestId('activation-code'), { target: { value: 'a.b.c' } });
    fireEvent.click(screen.getByTestId('activation-submit'));

    await waitFor(() => expect(screen.getByTestId('activation-error')).toHaveTextContent(/expired/i));
  });

  it('words a licence bought for another app as such', async () => {
    const activate = vi.fn().mockResolvedValue({ success: false, code: 'app_mismatch', error: 'belongs to soothevoice' });
    renderPage(TRIALING, { activate });

    fireEvent.change(screen.getByTestId('activation-code'), { target: { value: 'a.b.c' } });
    fireEvent.click(screen.getByTestId('activation-submit'));

    await waitFor(() => expect(screen.getByTestId('activation-error')).toHaveTextContent(/different app/i));
  });

  it('submits on Enter, since a pasted token is long enough to want it', async () => {
    const activate = vi.fn().mockResolvedValue({ success: true });
    renderPage(TRIALING, { activate });

    const box = screen.getByTestId('activation-code');
    fireEvent.change(box, { target: { value: 'a.b.c' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(activate).toHaveBeenCalledWith('a.b.c'));
  });

  it('fills the box from the clipboard', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { readText: vi.fn().mockResolvedValue(' pasted.token.here ') },
      configurable: true,
    });
    renderPage(TRIALING, { activate: vi.fn() });

    fireEvent.click(screen.getByTestId('activation-paste'));
    await waitFor(() => expect((screen.getByTestId('activation-code') as HTMLInputElement).value)
      .toBe('pasted.token.here'));
  });

  it('carries on when the clipboard is refused, rather than throwing', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { readText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    });
    renderPage(TRIALING, { activate: vi.fn() });

    fireEvent.click(screen.getByTestId('activation-paste'));
    await waitFor(() => expect((screen.getByTestId('activation-code') as HTMLInputElement).value).toBe(''));
    expect(screen.queryByTestId('activation-error')).toBeNull();
  });
});


describe('a demo licence in force', () => {
  /**
   * The demo card and its code box are gone from this page — the licence box
   * above replaced both. What is left is a demo the main process issued
   * earlier, which the page still has to name honestly and still has to sell
   * a subscription over the top of.
   */
  const running = (over: Partial<LicenseState> = {}) => state('active', {
    payload: {
      userId: 'u1', appId: 'shuyin', planId: DEMO_PLAN_ID,
      licenseKey: 'DEMO-ABC', expiresAt: 0, issuedAt: 0,
    },
    ...over,
  });

  it('is named as a demo, not as a plan somebody bought, and counts down', () => {
    renderPage(running(), { licenseMsRemaining: 6 * DAY + 3 * 60 * 60 * 1000 });

    expect(screen.getByTestId('subscription-status')).toHaveTextContent('Demo licence');
    expect(screen.getByTestId('subscription-status')).toHaveTextContent('6 days 03:00 left');
  });

  it('says a demo cannot be extended, since the service never issued it', () => {
    renderPage(running());
    expect(screen.getByTestId('manage-subscription')).toHaveTextContent('not a purchase');
  });

  it('leaves the paid plans buyable throughout, so a demo can be upgraded', async () => {
    const { createOrder } = renderPage(running());

    choosePlan('annual');
    payNow();

    await waitFor(() => expect(createOrder).toHaveBeenCalledWith('annual', 'wechat_pay'));
  });

  it('offers no way to take another one', () => {
    renderPage(running());
    expect(screen.queryByTestId('demo-license')).toBeNull();
    expect(screen.queryByTestId('demo-activate')).toBeNull();
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
    expect(screen.getByTestId('pay-now')).toHaveTextContent('立即支付');
  });

  it('answers the three questions people write in about, folded away', () => {
    renderPage();
    const faq = screen.getByTestId('faq');
    expect(faq).toHaveTextContent('What happens when the trial ends?');
    expect(faq).toHaveTextContent('How do I upgrade my plan?');
    expect(faq).toHaveTextContent('Which payment methods are supported?');
    // Folded: three answers open at once would bury the plans above them.
    expect(screen.getByTestId('faq-faqTrial')).not.toHaveAttribute('open');
  });
});
