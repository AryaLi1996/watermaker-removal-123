/**
 * Type declarations for window.electronAPI (provided by preload.js).
 */
import type { LicenseState, Order, PaymentMethod, PaymentMethodId, Plan, PlanId } from './subscription';

export interface ROI {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type RemovalMethod = 'inpaint' | 'blur' | 'solidFill' | 'cloneStamp' | 'temporal';

/** Speed against edge quality for the temporal engine. */
export type TemporalQuality = 'fast' | 'balanced' | 'high';

export interface JobConfig {
  inputPath: string;
  outputPath: string;
  roi: ROI;
  method: RemovalMethod;
  mode?: 'full' | 'preview' | 'preview_frame';
  radius?: number;
  kernelSize?: number;
  color?: [number, number, number];
  dx?: number;
  dy?: number;
  temporalQuality?: TemporalQuality;
  /**
   * Ask temporal fill to use the learned engine (ProPainter) rather than the
   * optical-flow one. A request: the backend runs the flow engine and says so
   * where the machine cannot carry the learned one.
   */
  useDeepLearning?: boolean;
  /** Seconds of video a preview job covers; ignored for a full export. */
  previewSeconds?: number;
}

export interface VideoMeta {
  width: number;
  height: number;
  fps: number;
  duration: number;
  videoCodec: string;
  audioCodec: string | null;
}

/**
 * How many frames the temporal engine could not rebuild from their
 * neighbours, out of how many it processed. Reported once, when the job is
 * over — a frame falling back is not a stage of the pipeline.
 */
export interface TemporalFallback {
  degraded: number;
  total: number;
}

/**
 * Something the learned engine wants said about a run that is not a failure.
 *
 * `fallback` — it could not run at all and the optical-flow engine took the
 * job. `quality` — it ran, at a lower preset than the dial asked for, because
 * the GPU could not carry that one. `detail` is the backend's own English
 * sentence, shown beside the translated explanation the way a backend error
 * already is.
 */
export interface DeepNotice {
  kind: 'fallback' | 'quality';
  detail: string;
}

export type AppState = 'empty' | 'loaded' | 'processing' | 'done' | 'error';

/**
 * What the main process can tell the renderer about the machine.
 *
 * The two hardware fields are optional on purpose: an older main process does
 * not send them, and a feature must not be hidden because a number is missing.
 */
/**
 * How much of the trial's temporal-fill allowance is left.
 *
 * `limited` is false for a subscriber, for whom the count is meaningless
 * rather than merely large — the UI asks that question, so the main process
 * answers it rather than each caller re-deriving it.
 */
export interface TemporalUsage {
  used: number;
  limit: number;
  /** `Infinity` where nothing is limited. */
  remaining: number;
  limited: boolean;
  exhausted: boolean;
  /** Whether temporal fill may run at all right now — a subscription, or a
   *  live trial with allowance left. The one question the UI and the job
   *  handler both ask, answered by the main process so the two agree. */
  allowed: boolean;
}

export interface SystemInfo {
  platform: string;
  arch: string;
  packaged: boolean;
  appVersion: string;
  cpuCount?: number;
  totalMemoryMB?: number;
  /** Absent from an older main process, which knew nothing about a GPU. */
  gpu?: GpuInfo;
}

/**
 * The CUDA device the learned engine would run on, as the main process found
 * it. `available: false` is the ordinary answer on most machines, not a fault.
 */
export interface GpuInfo {
  available: boolean;
  name: string;
  /** Total video memory. What decides which preset can run. */
  memoryTotalMB: number;
}

/** What the main process will tell the renderer about the license setup.
 *  Deliberately not the signing secret, which never leaves that process. */
export interface LicenseConfig {
  verificationUrl: string;
  /** Which app the service scopes this client's trial and subscription to. */
  appId?: string;
  gracePeriodDays: number;
  trialDurationDays: number;
  orderPollIntervalMs: number;
  orderPollTimeoutMs: number;
  usingDefaultSigningSecret: boolean;
  /** Whether the build asked for the box for entering a licence by hand. The
   *  interface no longer reads it — the box is on in every build — but the
   *  main process still reports what ENABLE_MANUAL_ACTIVATION said. */
  manualActivationEnabled?: boolean;
  /** Whether a signing-secret rotation is in flight — this build accepts
   *  tokens signed with the outgoing secret as well as the current one. Set
   *  by PREVIOUS_LICENSE_SIGNING_SECRET; nothing in the interface reads it,
   *  it is here for a support conversation. */
  rotatingSigningSecret?: boolean;
  /** Whether this build issues demo licences at all. On unless the build sets
   *  VITE_DISABLE_DEMO_LICENSE — see electron/demo-license.js. */
  demoLicenseEnabled?: boolean;
  /** How long a demo licence runs, in days. The service decides; this is
   *  what the main process falls back to before it has been asked. */
  demoDurationDays?: number;
}

/** What the main process knows about this device's demo licence. */
export interface DemoState {
  /** Whether this device has already taken its one demo. */
  used: boolean;
  durationDays: number;
  /** ISO, or null where no demo has been taken. */
  issuedAt: string | null;
  expiresAt: string | null;
  /** Whether the service was reached for this answer, or it came from the
   *  cached record. `local` is not stale by definition — the service holds
   *  the record and refuses a second demo either way — but it is the reason
   *  a device that has just deleted its record may still be offered the
   *  button until the activation itself comes back refused. */
  source?: 'server' | 'local';
}

/** Taking a demo licence, as the main process answers it. `code` is one of
 *  `demo_already_used` (final), `demo_unavailable` (the service could not be
 *  reached, nothing was spent, worth retrying) or `demo_disabled` (this
 *  build does not offer them). */
export interface DemoActivation {
  success: boolean;
  error?: string;
  code?: string;
  demo?: DemoState;
}

/** A create-order that did not produce an order. `code` is set only when the
 *  interface has its own wording for the failure — see `LicenseErrorCode`. */
export interface OrderError {
  error: string;
  code?: string;
}

export interface OrderStatusResult {
  status?: 'pending' | 'paid' | 'failed' | 'expired';
  token?: string;
  licensed?: boolean;
  state?: LicenseState;
  error?: string;
  /** Set when the failure is one the interface words for itself — see
   *  `LicenseErrorCode`. */
  code?: string;
}

export interface PaymentHistoryEntry {
  orderId: string;
  planId: PlanId;
  method: PaymentMethodId;
  status: string;
  amount: number;
  currency: string;
  createdAt: number;
  paidAt?: number;
}

declare global {
  interface Window {
    electronAPI: {
      openFile: () => Promise<string | null>;
      saveFile: (defaultName?: string) => Promise<string | null>;
      openPath: (filePath: string) => Promise<void>;
      startJob: (payload: JobConfig) => Promise<boolean>;
      cancelJob: () => Promise<boolean>;
      onJobProgress: (cb: (value: number) => void) => void;
      onJobState: (cb: (label: string) => void) => void;
      onJobError: (cb: (message: string) => void) => void;
      onJobDone: (cb: (outputPath: string | null) => void) => void;
      onJobMeta: (cb: (meta: VideoMeta) => void) => void;
      onPreviewReady: (cb: (path: string) => void) => void;
      onTemporalFallback: (cb: (report: TemporalFallback) => void) => void;
      onDeepNotice: (cb: (notice: DeepNotice) => void) => void;
      onUpdateAvailable: (cb: (version: string | null) => void) => void;
      onUpdateDownloaded: (cb: (version: string | null) => void) => void;
      installUpdate: () => Promise<boolean>;
      systemInfo: () => Promise<SystemInfo>;
      /**
       * The trial's allowance of temporal-fill exports. Optional: a main
       * process without it imposes no limit, and `NO_TEMPORAL_LIMIT` is what
       * the renderer falls back to.
       */
      temporalUsage?: () => Promise<TemporalUsage>;
      onTemporalUsage?: (cb: (usage: TemporalUsage) => void) => void;
      removeTemporalUsageListeners?: () => void;
      /**
       * Whether the window is full screen. Optional: a main process older
       * than this never sends it, and the top bar's default inset is right
       * for every platform that has no floating window controls.
       */
      onFullScreenChange?: (cb: (isFullScreen: boolean) => void) => void;
      removeWindowListeners?: () => void;
      /**
       * Licensing. Optional because a main process older than this feature
       * does not expose them, and the renderer must still start.
       */
      licenseState?: () => Promise<LicenseState>;
      licenseActivate?: (licenseKey: string) => Promise<{ success: boolean; error?: string; code?: string }>;
      licenseDeactivate?: () => Promise<{ success: boolean }>;
      licenseRefresh?: () => Promise<{ success: boolean; error?: string }>;
      licenseConfig?: () => Promise<LicenseConfig>;
      /** Take this device's demo licence — one click, no code. The service
       *  grants it on "this device has not taken one for this app". */
      licenseActivateDemo?: () => Promise<DemoActivation>;
      licenseDemoState?: () => Promise<DemoState>;
      onLicenseState?: (cb: (state: LicenseState) => void) => void;
      removeLicenseListeners?: () => void;

      paymentPlans?: () => Promise<{ plans: Plan[]; source: 'server' | 'fallback' }>;
      paymentMethods?: (lang: string) => Promise<{ methods: PaymentMethod[]; source: 'server' | 'fallback' }>;
      paymentCreateOrder?: (planId: PlanId, method: PaymentMethodId) => Promise<Order | OrderError>;
      paymentOrderStatus?: (orderId: string) => Promise<OrderStatusResult>;
      paymentHistory?: () => Promise<PaymentHistoryEntry[]>;
      paymentOpenExternal?: (url: string) => Promise<boolean>;
      paymentOpenEmbedded?: (url: string) => Promise<boolean>;
      paymentCloseEmbedded?: () => Promise<boolean>;
      onPaymentWindowClosed?: (cb: () => void) => void;
      tempDir: () => Promise<string>;
      notify: (title: string, body: string) => Promise<boolean>;
      removeJobListeners: () => void;
    };
  }
}
