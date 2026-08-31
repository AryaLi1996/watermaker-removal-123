/**
 * Type declarations for window.electronAPI (provided by preload.js).
 */
import type { PaidPlanId, PaymentMethod, Subscription } from './subscription';

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
      /** Absent from a main process older than the subscription feature. */
      subscriptionStatus?: () => Promise<Subscription | null>;
      subscribe?: (plan: PaidPlanId, paymentMethod: PaymentMethod) => Promise<Subscription | null>;
      cancelAutoRenew?: () => Promise<Subscription | null>;
      tempDir: () => Promise<string>;
      notify: (title: string, body: string) => Promise<boolean>;
      removeJobListeners: () => void;
    };
  }
}
