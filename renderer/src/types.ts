/**
 * Type declarations for window.electronAPI (provided by preload.js).
 */
export interface ROI {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type RemovalMethod = 'inpaint' | 'blur' | 'solidFill' | 'cloneStamp';

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

declare global {
  interface Window {
    electronAPI: {
      openFile: () => Promise<string | null>;
      saveFile: (defaultName?: string) => Promise<string | null>;
      openPath: (filePath: string) => Promise<void>;
      runPython: (payload: object) => Promise<string>;
      startJob: (payload: JobConfig) => Promise<void>;
      cancelJob: () => Promise<void>;
      onJobProgress: (cb: (value: number) => void) => void;
      onJobState: (cb: (label: string) => void) => void;
      onJobError: (cb: (message: string) => void) => void;
      onJobDone: (cb: () => void) => void;
      onJobMeta: (cb: (meta: VideoMeta) => void) => void;
      onPreviewReady: (cb: (path: string) => void) => void;
      removeJobListeners: () => void;
    };
  }
}
