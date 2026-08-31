/**
 * The subscription wired into the app: the bottom bar, the top-bar navigation,
 * and a purchase that changes what the app reports.
 *
 * The page itself is covered in pages/SubscriptionPage.test.tsx and the stored
 * record in tests/unit/renderer/subscription-store.test.ts. What is left, and
 * what this covers, is that App puts the pieces together — including the
 * localStorage fallback the hook uses when the main process has no
 * subscription handlers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import App from './App';
import { setLocale } from './i18n';

const noop = () => {};

/** Enough of the bridge for App to mount: no subscription handlers, so the
 *  hook falls back to localStorage — the older-main-process case. */
function stubElectronAPI() {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    systemInfo: vi.fn().mockResolvedValue({
      platform: 'linux', arch: 'x64', packaged: false, appVersion: '1.1.0',
      cpuCount: 8, totalMemoryMB: 16384,
    }),
    openFile: vi.fn(), saveFile: vi.fn(), openPath: vi.fn(), notify: vi.fn(),
    tempDir: vi.fn(), installUpdate: vi.fn(), startJob: vi.fn(), cancelJob: vi.fn(),
    onJobProgress: noop, onJobState: noop, onJobError: noop, onJobDone: noop,
    onJobMeta: noop, onPreviewReady: noop, onTemporalFallback: noop,
    onDeepNotice: noop, onUpdateAvailable: noop, onUpdateDownloaded: noop,
    removeJobListeners: noop,
  };
}

beforeEach(() => {
  // jsdom has no ResizeObserver, and the canvas container observes its size.
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  window.localStorage.removeItem('watermark-remover:subscription');
  stubElectronAPI();
});

afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('App — subscription', () => {
  it('starts the trial on first launch and counts it down in the bottom bar', async () => {
    render(<App />);
    // Three days, counting down. The first render can land on "3 days 00:00"
    // when the grant and the read fall in the same millisecond, so this pins
    // the shape of the countdown rather than which side of that tick it is.
    await waitFor(() =>
      expect(screen.getByTestId('subscription-bar-label'))
        .toHaveTextContent(/free trial \([23] days \d{2}:\d{2} left\)/),
    );
  });

  it('opens the subscription page from the top bar and from the bar itself', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('status-bar-subscribe')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('status-bar-subscribe'));
    expect(screen.getByTestId('subscription-page')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('nav-editor'));
    expect(screen.queryByTestId('subscription-page')).toBeNull();

    fireEvent.click(screen.getByTestId('nav-subscription'));
    expect(screen.getByTestId('subscription-page')).toBeInTheDocument();
  });

  it('reports the plan, and drops the prompt, once one is paid for', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('status-bar-subscribe')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('nav-subscription'));
    fireEvent.click(screen.getByTestId('subscribe-monthly'));
    fireEvent.click(screen.getByTestId('payment-confirm'));

    await waitFor(() =>
      expect(screen.getByTestId('subscription-bar-label')).toHaveTextContent('Subscription: Monthly'),
    );
    expect(screen.queryByTestId('status-bar-subscribe')).toBeNull();
  });

  it('keeps the plan across a restart', async () => {
    const { unmount } = render(<App />);
    await waitFor(() => expect(screen.getByTestId('status-bar-subscribe')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('nav-subscription'));
    fireEvent.click(screen.getByTestId('subscribe-yearly'));
    fireEvent.click(screen.getByTestId('payment-confirm'));
    await waitFor(() =>
      expect(screen.getByTestId('subscription-bar-label')).toHaveTextContent('Yearly'),
    );

    unmount();
    render(<App />);
    await waitFor(() =>
      expect(screen.getByTestId('subscription-bar-label')).toHaveTextContent('Subscription: Yearly'),
    );
  });
});
