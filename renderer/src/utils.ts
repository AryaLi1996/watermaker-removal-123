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
  // A container that has not been measured yet, or a video whose dimensions
  // never arrived, leaves the scale at 0 (or NaN). Dividing by it yields
  // Infinity, which JSON.stringify writes as null — the backend then rejects
  // the whole job over a rectangle the user drew perfectly well. Falling back
  // to 1:1 keeps the box the user sees.
  const factor = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return {
    x: toPixels(ui_x / factor),
    y: toPixels(ui_y / factor),
    // A box has to enclose something: the backend rejects a zero-width
    // selection, and rounding a sub-pixel drag down to 0 would trip it.
    w: Math.max(1, toPixels(ui_w / factor)),
    h: Math.max(1, toPixels(ui_h / factor)),
  };
}

/** Round to a whole pixel, treating an unusable number as 0. */
function toPixels(value: number): number {
  return Number.isFinite(value) ? Math.round(value) : 0;
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

/**
 * The URL for a preview file the main process published.
 *
 * Preview stills and clips are served over the app's own scheme rather than
 * file://, so the renderer keeps the same-origin policy in development and the
 * page can only reach the files the main process chose to publish. The scheme
 * and the shape of this URL are defined in `electron/main.js`.
 */
export function mediaUrl(filePath: string): string {
  return `wm-media://file/${encodeURIComponent(filePath)}`;
}
