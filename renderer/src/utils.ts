import type { ROI } from './types';

/**
 * Converts coordinates from UI canvas pixels to original video pixels.
 * scale = canvasWidth / videoWidth
 */
export function normalizeCoordinates(
  ui_x: number,
  ui_y: number,
  ui_w: number,
  ui_h: number,
  scale: number,
): ROI {
  return {
    x: Math.round(ui_x / scale),
    y: Math.round(ui_y / scale),
    w: Math.round(ui_w / scale),
    h: Math.round(ui_h / scale),
  };
}

/**
 * Calculates the uniform scale factor to fit a video frame into the container,
 * preserving aspect ratio.
 */
export function calcScaleFactor(
  videoWidth: number,
  videoHeight: number,
  containerWidth: number,
  containerHeight: number,
): number {
  const scaleX = containerWidth / videoWidth;
  const scaleY = containerHeight / videoHeight;
  return Math.min(scaleX, scaleY);
}

/** Format seconds to "mm:ss" */
export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Derive the default output filename from an input path */
export function defaultOutputName(inputPath: string): string {
  const parts = inputPath.split(/[\\/]/);
  const filename = parts[parts.length - 1];
  const dot = filename.lastIndexOf('.');
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  return `${base}_processed.mp4`;
}
