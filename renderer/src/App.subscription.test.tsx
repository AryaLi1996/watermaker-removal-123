/**
 * Licensing wired into the app: the top bar, the navigation, and the feature
 * gating that follows from the state the main process reports.
 *
 * The state machine itself is covered in
 * tests/unit/renderer/subscription-monitor.test.ts. What is left, and what
 * this covers, is that App reads it and acts on it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import App from './App';
import {
  DEMO_PLAN_ID, LOADING_STATE, type LicenseState, type LicenseStatus, type TrialState,
} from './subscription';
import { setLocale } from './i18n';

const DAY = 24 * 60 * 60 * 1000;
const noop = () => {};

const trial = (over: Partial<TrialState> = {}): TrialState => ({
  used: false, active: false, start: null, end: null, msRemaining: 0, durationDays: 3, source: 'server', ...over,
});

const state = (status: LicenseStatus, over: Partial<LicenseState> = {}): LicenseState => ({
  ...LOADING_STATE, status, trial: trial(), ...over,
});

const TRIALING = state('unlicensed', { trial: trial({ used: true, active: true, msRemaining: 2 * DAY }) });
const LICENSED = state('active', {
  payload: { userId: 'u', planId: 'annual', licenseKey: 'K', expiresAt: 0, issuedAt: 0 },
  expiresAt: '2027-03-01T12:00:00.000Z',
  daysRemaining: 200,
});

/** Enough of the bridge for App to mount, with the licence state injectable. */
function stubElectronAPI(licenseState: LicenseState) {
  const listeners: ((s: LicenseState) => void)[] = [];
  const api = {
    systemInfo: vi.fn().mockResolvedValue({
      platform: 'linux', arch: 'x64', packaged: false, appVersion: '1.1.0',
      cpuCount: 8, totalMemoryMB: 16384,
    }),
    openFile: vi.fn().mockResolvedValue('/fake/clip.mp4'),
    saveFile: vi.fn(), openPath: vi.fn(), notify: vi.fn(), tempDir: vi.fn(), installUpdate: vi.fn(),
    startJob: vi.fn().mockResolvedValue(true), cancelJob: vi.fn(),
    onJobProgress: noop, onJobState: noop, onJobError: noop, onJobDone: noop,
    onJobMeta: (cb: (m: unknown) => void) => { api.__meta = cb; },
    onPreviewReady: noop, onTemporalFallback: noop, onDeepNotice: noop,
    onUpdateAvailable: noop, onUpdateDownloaded: noop, removeJobListeners: noop,

    licenseState: vi.fn().mockResolvedValue(licenseState),
    licenseRefresh: vi.fn().mockResolvedValue({ success: true }),
    licenseConfig: vi.fn().mockResolvedValue({
      orderPollIntervalMs: 1, orderPollTimeoutMs: 10, demoLicenseEnabled: true,
    }),
    licenseDemoState: vi.fn().mockResolvedValue({
      used: false, durationDays: 7, issuedAt: null, expiresAt: null,
    }),
    licenseActivateDemo: vi.fn(),
    onLicenseState: (cb: (s: LicenseState) => void) => { listeners.push(cb); },
    removeLicenseListeners: noop,
    paymentPlans: vi.fn().mockResolvedValue({ plans: [], source: 'server' }),
    paymentMethods: vi.fn().mockResolvedValue({ methods: [], source: 'server' }),
    paymentCreateOrder: vi.fn(),
    paymentOrderStatus: vi.fn(),
    paymentHistory: vi.fn().mockResolvedValue([]),
    paymentOpenExternal: vi.fn(), paymentOpenEmbedded: vi.fn(), paymentCloseEmbedded: vi.fn(),
    onPaymentWindowClosed: noop,
  } as Record<string, unknown> & { __meta?: (m: unknown) => void };

  (window as unknown as { electronAPI: unknown }).electronAPI = api;
  /** Push a new state the way the main process does. */
  return { api, push: (s: LicenseState) => act(() => { listeners.forEach((fn) => fn(s)); }) };
}

/** Get the editor to the state where the method picker exists. */
async function loadVideo(api: { __meta?: (m: unknown) => void }) {
  fireEvent.click(screen.getByTestId('btn-load-video'));
  await waitFor(() => expect(api.__meta).toBeTypeOf('function'));
  act(() => {
    api.__meta?.({ width: 1920, height: 1080, fps: 30, duration: 61, videoCodec: 'h264', audioCodec: 'aac' });
  });
  await waitFor(() => expect(screen.getByTestId('btn-export')).toBeInTheDocument());
}

beforeEach(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {} unobserve() {} disconnect() {}
  };
  window.localStorage.clear();
  setLocale('en');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('App — the licence in the top bar', () => {
  it('counts the trial down', async () => {
    stubElectronAPI(TRIALING);
    render(<App />);
    await waitFor(() =>
      expect(screen.getByTestId('subscription-status-top')).toHaveTextContent(/Trial · 2 days \d{2}:\d{2} left/),
    );
  });

  it('names the plan once one is in force', async () => {
    stubElectronAPI(LICENSED);
    render(<App />);
    await waitFor(() =>
      expect(screen.getByTestId('subscription-status-top')).toHaveTextContent('Subscribed · Yearly'),
    );
  });

  it('follows a state the main process pushes, without being asked again', async () => {
    const { push } = stubElectronAPI(TRIALING);
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('subscription-status-top')).toHaveTextContent('Trial'));

    // A payment settling, or the trial running out, arrives this way.
    push(LICENSED);
    await waitFor(() =>
      expect(screen.getByTestId('subscription-status-top')).toHaveTextContent('Subscribed · Yearly'),
    );
  });

  it('has no strip along the bottom any more', async () => {
    // The status moved up; leaving the old one behind would say the same
    // thing twice, in two different sets of words.
    stubElectronAPI(TRIALING);
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('subscription-status-top')).toBeInTheDocument());
    expect(screen.queryByTestId('status-bar')).toBeNull();
  });
});

describe('App — what the licence unlocks', () => {
  it('greys out temporal fill on a trial, with the subscription as the reason', async () => {
    const { api } = stubElectronAPI(TRIALING);
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('subscription-status-top')).toHaveTextContent(/Trial|Expired|Not activated/));
    await loadVideo(api);

    const temporal = screen.getByTestId('method-temporal');
    expect(temporal).toBeDisabled();
    expect(temporal).toHaveTextContent('Needs a subscription');
    expect(screen.getByTestId('preview-locked')).toBeInTheDocument();
  });

  it('unlocks it for a licence, and lifts the preview cap with it', async () => {
    const { api } = stubElectronAPI(LICENSED);
    render(<App />);
    await waitFor(() =>
      expect(screen.getByTestId('subscription-status-top')).toHaveTextContent('Yearly'),
    );
    await loadVideo(api);

    expect(screen.getByTestId('method-temporal')).toBeEnabled();
    expect(screen.queryByTestId('preview-locked')).toBeNull();
  });

  it('keeps it unlocked through the grace period, while still prompting to renew', async () => {
    const { api } = stubElectronAPI(state('grace_period', {
      payload: { userId: 'u', planId: 'monthly', licenseKey: 'K', expiresAt: 0, issuedAt: 0 },
      graceDaysLeft: 2,
    }));
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('subscription-status-top')).toHaveTextContent('Grace period'));
    await loadVideo(api);

    expect(screen.getByTestId('method-temporal')).toBeEnabled();
    // Still told the clock is running: the grace period is the last chance
    // to notice before the features go.
    expect(screen.getByTestId('subscription-status-top')).toHaveTextContent('2 days left');
  });

  it('takes the paid features away again when a pushed state expires', async () => {
    const { api, push } = stubElectronAPI(LICENSED);
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('subscription-status-top')).toHaveTextContent('Yearly'));
    await loadVideo(api);
    expect(screen.getByTestId('method-temporal')).toBeEnabled();

    push(state('expired', { trial: trial({ used: true }) }));
    await waitFor(() => expect(screen.getByTestId('method-temporal')).toBeDisabled());
  });
});


describe('App — a demo licence in force', () => {
  /**
   * The button that took one is gone with the demo card — the licence box on
   * the subscription page replaced both doors. What still has to hold is the
   * far end of the wire: a demo licence the main process issued unlocks the
   * features it exists to show off, is named as a demo while it runs, and
   * takes them back when it ends.
   */
  const DEMO_LICENSED = state('active', {
    payload: {
      userId: 'u', appId: 'smoothvoice', planId: DEMO_PLAN_ID,
      licenseKey: 'DEMO-ABC', expiresAt: 0, issuedAt: 0,
    },
    expiresAt: new Date(Date.now() + 7 * DAY).toISOString(),
    daysRemaining: 7,
  });

  it('unlocks temporal fill while it runs, and names it a demo', async () => {
    const { api, push } = stubElectronAPI(TRIALING);
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('subscription-status-top')).toHaveTextContent('Trial'));
    await loadVideo(api);
    expect(screen.getByTestId('method-temporal')).toBeDisabled();

    push(DEMO_LICENSED);

    await waitFor(() =>
      expect(screen.getByTestId('subscription-status-top')).toHaveTextContent('Demo · '),
    );
    expect(screen.getByTestId('method-temporal')).toBeEnabled();
    expect(screen.queryByTestId('preview-locked')).toBeNull();
  });

  it('locks the features again when it runs out, and asks for a plan', async () => {
    const { api, push } = stubElectronAPI(DEMO_LICENSED);
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('subscription-status-top')).toHaveTextContent('Demo'));
    await loadVideo(api);
    expect(screen.getByTestId('method-temporal')).toBeEnabled();

    // Seven days later, and past the grace period the main process allows.
    push(state('expired', { trial: trial({ used: true }) }));

    await waitFor(() => expect(screen.getByTestId('method-temporal')).toBeDisabled());
    expect(screen.getByTestId('method-temporal')).toHaveTextContent('Needs a subscription');
    expect(screen.getByTestId('subscription-status-top')).toHaveTextContent('Expired');
  });

  it('offers no way to take one from the subscription page', async () => {
    stubElectronAPI(TRIALING);
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('subscription-status-top')).toHaveTextContent('Trial'));
    fireEvent.click(screen.getByTestId('nav-subscription'));

    await waitFor(() => expect(screen.getByTestId('subscription-page')).toBeInTheDocument());
    expect(screen.queryByTestId('demo-license')).toBeNull();
    expect(screen.queryByTestId('demo-activate')).toBeNull();
    // What stands there instead is the box for a key somebody already has.
    expect(screen.getByTestId('license-input')).toBeInTheDocument();
  });
});

describe('App — navigation', () => {
  it('moves between the three screens from the sidebar', async () => {
    stubElectronAPI(TRIALING);
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('subscription-status-top')).toHaveTextContent('Trial'));

    fireEvent.click(screen.getByTestId('nav-subscription'));
    expect(screen.getByTestId('subscription-page')).toBeInTheDocument();
    expect(screen.getByTestId('nav-subscription')).toHaveAttribute('aria-current', 'page');

    // Settings is reachable from the same rail; what it renders needs the
    // ThemeProvider the real entry point wraps App in, so it is covered by
    // its own tests rather than mounted here.
    expect(screen.getByTestId('nav-settings')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('nav-editor'));
    expect(screen.queryByTestId('subscription-page')).toBeNull();
    expect(screen.getByTestId('nav-editor')).toHaveAttribute('aria-current', 'page');
  });

  it('opens the subscription screen from the account panel too', async () => {
    stubElectronAPI(TRIALING);
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('subscription-status-top')).toHaveTextContent('Trial'));

    fireEvent.click(screen.getByTestId('user-avatar'));
    fireEvent.click(screen.getByTestId('account-subscribe'));
    expect(screen.getByTestId('subscription-page')).toBeInTheDocument();
  });

  it("keeps the editor's video and its running job behind the other screens", async () => {
    // Hidden, not unmounted: a user checking a price mid-export must not come
    // back to an empty canvas.
    const { api } = stubElectronAPI(TRIALING);
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('subscription-status-top')).toHaveTextContent('Trial'));
    await loadVideo(api);

    fireEvent.click(screen.getByTestId('nav-subscription'));
    fireEvent.click(screen.getByTestId('nav-editor'));
    expect(screen.getByTestId('btn-export')).toBeInTheDocument();
  });
});
