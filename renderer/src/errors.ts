/**
 * Turn backend failures into something a user can act on.
 *
 * The backend reports technical detail — ffmpeg exit codes, pydantic
 * validation, OpenCV messages. That detail is worth keeping for a bug report,
 * but it is not what someone staring at a failed export needs to read.
 */

interface ErrorRule {
  /** Matched case-insensitively against the raw message. */
  match: RegExp;
  /** What the user should see: what went wrong, and what to do about it. */
  message: string;
}

const RULES: ErrorRule[] = [
  {
    match: /ffmpeg|ffprobe/i,
    message:
      'Could not read or write the video. The file may be corrupted, or in a format this build of FFmpeg does not support.',
  },
  {
    match: /python environment not found/i,
    message: 'The Python environment is missing. Run ./dev.sh to create it, then restart the app.',
  },
  {
    match: /bundled backend not found/i,
    message: 'This installation is incomplete — the processing backend is missing. Reinstalling should fix it.',
  },
  {
    match: /permission denied|EACCES|read-only file system/i,
    message: 'No permission to write there. Choose a different output location.',
  },
  {
    match: /no space left|ENOSPC/i,
    message: 'The disk is full. Free some space or choose another location, then try again.',
  },
  {
    match: /input file not found|no such file/i,
    message: 'The video file is no longer where it was. It may have been moved, renamed or deleted.',
  },
  {
    match: /selection .* lies outside|outside the frame bounds/i,
    message: 'The selection sits outside the video frame. Draw the box over the area you want removed.',
  },
  {
    match: /no video stream/i,
    message: 'That file has no video track, so there is nothing to process.',
  },
  {
    match: /out of memory|cannot allocate|MemoryError/i,
    message:
      'Ran out of memory processing this video. A shorter clip, or a smaller selection, should get through.',
  },
  {
    match: /timed out|timeout/i,
    message: 'The job took too long and was stopped. Try a shorter video, or a smaller selection.',
  },
];

/** The plain-language message to show for a raw backend error. */
export function friendlyError(raw: unknown): string {
  const text = raw instanceof Error ? raw.message : String(raw ?? '').trim();
  if (!text) return 'Something went wrong, and the backend gave no reason.';

  const rule = RULES.find((r) => r.match.test(text));
  if (rule) return rule.message;

  // Nothing matched: show the raw text rather than inventing an explanation.
  return text;
}

/**
 * Whether the friendly message hides detail worth offering separately.
 * When it does, the UI shows a "Copy details" affordance.
 */
export function hasTechnicalDetail(raw: unknown): boolean {
  const text = raw instanceof Error ? raw.message : String(raw ?? '').trim();
  return Boolean(text) && friendlyError(text) !== text;
}

/** How long to wait for the first preview frame before calling it stuck. */
export const PREVIEW_TIMEOUT_MS = 90_000;

export const PREVIEW_TIMEOUT_MESSAGE =
  'Still waiting for a preview of this video after 90 seconds. It may be very large, or the backend may be stuck — try loading it again.';
