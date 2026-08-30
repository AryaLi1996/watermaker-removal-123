/**
 * Type declarations for window.electronAPI (provided by preload.js).
 */
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
      onUpdateAvailable: (cb: (version: string | null) => void) => void;
      onUpdateDownloaded: (cb: (version: string | null) => void) => void;
      installUpdate: () => Promise<boolean>;
      systemInfo: () => Promise<SystemInfo>;
      tempDir: () => Promise<string>;
      notify: (title: string, body: string) => Promise<boolean>;
      removeJobListeners: () => void;
    };
  }
}
