/**
 * The subscription page and the bar that reports it, rendered.
 *
 * Beside the component rather than in tests/unit/renderer for the same reason
 * as the other component tests: rendering needs @testing-library/react, which
 * only files inside the renderer root can resolve.
 *
 * The prices, the trial arithmetic and what a plan unlocks are covered in
 * tests/unit/renderer/subscription.test.ts. What is left, and what these
 * cover, is the flow from a card to a paid plan.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import SubscriptionPage from './SubscriptionPage';
import SubscriptionStatusBar from '../components/SubscriptionStatusBar';
import { applyPurchase, startTrial, statusOf } from '../subscription';
import { setLocale } from '../i18n';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-03-01T12:00:00.000Z');

afterEach(() => {
  cleanup();
  setLocale('en');
});

function renderPage(status = statusOf(startTrial(NOW), NOW + DAY)) {
  const onSubscribe = vi.fn().mockResolvedValue(undefined);
  const onCancelAutoRenew = vi.fn().mockResolvedValue(undefined);
  render(
    <SubscriptionPage status={status} onSubscribe={onSubscribe} onCancelAutoRenew={onCancelAutoRenew} />,
  );
  return { onSubscribe, onCancelAutoRenew };
}

describe('SubscriptionPage', () => {
  it('shows all four plans at their discounted prices', () => {
    renderPage();
    expect(screen.getByTestId('plan-monthly')).toHaveTextContent('¥99/month');
    expect(screen.getByTestId('plan-quarterly')).toHaveTextContent('¥282/quarter');
    expect(screen.getByTestId('plan-halfyear')).toHaveTextContent('¥534/6 months');
    expect(screen.getByTestId('plan-yearly')).toHaveTextContent('¥1009/year');
  });

  it('marks the quarterly plan as the recommended one', () => {
    renderPage();
    expect(screen.getByTestId('plan-quarterly')).toHaveTextContent('Most popular');
  });

  it('reports the trial and how long is left on it', () => {
    renderPage();
    expect(screen.getByTestId('subscription-status')).toHaveTextContent('Free trial');
    expect(screen.getByTestId('subscription-status')).toHaveTextContent('2 days');
  });

  it('explains itself once the trial has run out', () => {
    renderPage(statusOf(startTrial(NOW), NOW + 5 * DAY));
    expect(screen.getByTestId('trial-ended')).toBeInTheDocument();
  });

  it('takes a plan from a click to a paid subscription through the QR dialog', async () => {
    const { onSubscribe } = renderPage();

    // Nothing is bought until the dialog is confirmed.
    fireEvent.click(screen.getByTestId('subscribe-quarterly'));
    expect(onSubscribe).not.toHaveBeenCalled();

    expect(screen.getByTestId('payment-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('payment-qr')).toBeInTheDocument();
    expect(screen.getByTestId('payment-summary')).toHaveTextContent('¥282');
    // WeChat Pay is the default, and the summary says which one is going to run.
    expect(screen.getByTestId('payment-summary')).toHaveTextContent('WeChat Pay');

    fireEvent.click(screen.getByTestId('payment-confirm'));
    expect(onSubscribe).toHaveBeenCalledWith('quarterly', 'wechat');
    await waitFor(() => expect(screen.queryByTestId('payment-dialog')).toBeNull());
    expect(screen.getByTestId('subscribe-success')).toBeInTheDocument();
  });

  it('pays with whichever method was chosen', async () => {
    const { onSubscribe } = renderPage();

    fireEvent.click(screen.getByTestId('pay-alipay'));
    fireEvent.click(screen.getByTestId('subscribe-yearly'));
    expect(screen.getByTestId('payment-summary')).toHaveTextContent('Alipay');

    fireEvent.click(screen.getByTestId('payment-confirm'));
    expect(onSubscribe).toHaveBeenCalledWith('yearly', 'alipay');
  });

  it('buys nothing when the dialog is dismissed', async () => {
    const { onSubscribe } = renderPage();

    fireEvent.click(screen.getByTestId('subscribe-monthly'));
    fireEvent.click(screen.getByTestId('payment-cancel'));

    expect(onSubscribe).not.toHaveBeenCalled();
    expect(screen.queryByTestId('payment-dialog')).toBeNull();
  });

  it('shows a paid plan, its end date and the switch that stops it renewing', async () => {
    const { onCancelAutoRenew } = renderPage(statusOf(applyPurchase(null, 'halfyear', NOW), NOW + DAY));

    const panel = screen.getByTestId('manage-subscription');
    expect(panel).toHaveTextContent('6 months');
    expect(panel).toHaveTextContent('Auto-renewal is on');

    fireEvent.click(screen.getByTestId('cancel-auto-renew'));
    expect(onCancelAutoRenew).toHaveBeenCalled();
  });

  it('offers nothing to manage while nothing is paid for', () => {
    renderPage();
    expect(screen.queryByTestId('manage-subscription')).toBeNull();
  });

  it('translates the page', () => {
    setLocale('zh');
    renderPage();
    expect(screen.getByTestId('plan-quarterly')).toHaveTextContent('季卡');
    expect(screen.getByTestId('plan-quarterly')).toHaveTextContent('95折');
    expect(screen.getByTestId('subscription-status')).toHaveTextContent('免费试用');
  });
});

describe('SubscriptionStatusBar', () => {
  it('counts the trial down and offers the way to subscribe', () => {
    const onOpen = vi.fn();
    render(
      <SubscriptionStatusBar status={statusOf(startTrial(NOW), NOW + DAY)} loading={false} onOpen={onOpen} />,
    );
    expect(screen.getByTestId('subscription-bar-label')).toHaveTextContent('free trial');
    expect(screen.getByTestId('subscription-bar-label')).toHaveTextContent('2 days');
    expect(screen.getByTestId('status-bar-subscribe')).toBeInTheDocument();
  });

  it('names the plan, and drops the prompt, once one is paid for', () => {
    render(
      <SubscriptionStatusBar
        status={statusOf(applyPurchase(null, 'monthly', NOW), NOW)}
        loading={false}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByTestId('subscription-bar-label')).toHaveTextContent('Subscription: Monthly');
    expect(screen.queryByTestId('status-bar-subscribe')).toBeNull();
  });

  it('says the trial has ended once it has', () => {
    render(
      <SubscriptionStatusBar status={statusOf(startTrial(NOW), NOW + 5 * DAY)} loading={false} onOpen={vi.fn()} />,
    );
    expect(screen.getByTestId('subscription-bar-label')).toHaveTextContent('trial ended');
  });

  it('claims nothing before the record has been read', () => {
    render(<SubscriptionStatusBar status={statusOf(null, NOW)} loading onOpen={vi.fn()} />);
    expect(screen.getByTestId('subscription-bar-label')).toHaveTextContent('');
    expect(screen.queryByTestId('status-bar-subscribe')).toBeNull();
  });
});
