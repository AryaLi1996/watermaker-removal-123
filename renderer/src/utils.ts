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

/**
 * Whether this path is spelled the Windows way.
 *
 * The renderer runs in a browser and has no `path` module to ask, and the
 * platform it is displayed on is not the question anyway — what matters is how
 * the path it was handed is written, which is decided by the dialog the main
 * process opened. A drive letter or a UNC prefix is the whole of the tell; a
 * backslash on its own is not, because it is a legal character in a POSIX
 * filename and splitting on it there would carve a name in half.
 */
function isWindowsPath(inputPath: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(inputPath) || inputPath.startsWith('\\\\');
}

/** The separator to build a path alongside this one with. */
function separatorFor(inputPath: string): string {
  return isWindowsPath(inputPath) ? '\\' : '/';
}

/** Split a path into its segments, by whichever convention it is written in. */
function segmentsOf(inputPath: string): string[] {
  return isWindowsPath(inputPath) ? inputPath.split(/[\\/]/) : inputPath.split('/');
}

/** Derive the default output filename from an input path */
export function defaultOutputName(inputPath: string): string {
  const parts = segmentsOf(inputPath);
  const filename = parts[parts.length - 1];
  const dot = filename.lastIndexOf('.');
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  return `${base}_processed.mp4`;
}

/**
 * Where an export lands if the user never picks somewhere: beside the input.
 *
 * Built with the separator the input path uses rather than always with '/'.
 * Both work — Windows accepts a forward slash everywhere the backslash goes —
 * but the derived path is shown to the user and handed back to Explorer, and
 * `D:/My Videos/clip_processed.mp4` is not how anyone on Windows writes that.
 * A UNC path suffers more than cosmetically: `//server/share/…` is a spelling
 * its own tooling does not always take.
 */
export function defaultOutputPath(inputPath: string): string {
  const sep = separatorFor(inputPath);
  const dir = segmentsOf(inputPath).slice(0, -1).join(sep);
  return dir + sep + defaultOutputName(inputPath);
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

/**
 * The outputPath a job with no output file names.
 *
 * `preview` and `preview_frame` both write to a temp file the backend picks,
 * so the field is a protocol token rather than a path anything opens. The
 * backend recognises this spelling on every platform (`is_null_sink` in
 * `backend/main.py`) alongside the host's own null device, so the renderer
 * does not have to know what platform it is on.
 */
export const NULL_SINK = '/dev/null';
