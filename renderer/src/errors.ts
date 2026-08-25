/**
 * Turn backend failures into something a user can act on.
 *
 * The backend reports technical detail — ffmpeg exit codes, pydantic
 * validation, OpenCV messages — always in English. That detail is worth
 * keeping for a bug report, but it is not what someone staring at a failed
 * export needs to read, and it is not in their language.
 *
 * Matching therefore happens on the raw English text and yields a translation
 * key, which the UI renders in whichever locale is active.
 */

interface ErrorRule {
  /** Matched case-insensitively against the raw message. */
  match: RegExp;
  /** Key into the translation resources. */
  key: string;
}

const RULES: ErrorRule[] = [
  { match: /ffmpeg|ffprobe/i, key: 'errors.ffmpeg' },
  { match: /python environment not found/i, key: 'errors.pythonMissing' },
  { match: /bundled backend not found/i, key: 'errors.backendMissing' },
  { match: /permission denied|EACCES|read-only file system/i, key: 'errors.permission' },
  { match: /no space left|ENOSPC/i, key: 'errors.diskFull' },
  { match: /input file not found|no such file/i, key: 'errors.inputMissing' },
  { match: /selection .* lies outside|outside the frame bounds/i, key: 'errors.roiOutside' },
  { match: /no video stream/i, key: 'errors.noVideoStream' },
  { match: /out of memory|cannot allocate|MemoryError/i, key: 'errors.outOfMemory' },
  { match: /timed out|timeout/i, key: 'errors.timeout' },
];

/** Marks a message the app itself raised, already translated. */
export const OWN_MESSAGE_PREFIX = 'i18n:';

export interface FriendlyError {
  /** A translation key, or null when the raw text should be shown as-is. */
  key: string | null;
  /** The untranslated text, for a bug report. */
  raw: string;
}

/**
 * Classify a raw failure.
 *
 * An unrecognised message keeps its own text: inventing an explanation for a
 * failure we do not understand is worse than showing what the backend said.
 */
export function classifyError(raw: unknown): FriendlyError {
  const text = raw instanceof Error ? raw.message : String(raw ?? '').trim();
  if (!text) return { key: 'errors.unknown', raw: '' };

  // Messages the app raises itself arrive as a key already.
  if (text.startsWith(OWN_MESSAGE_PREFIX)) {
    return { key: text.slice(OWN_MESSAGE_PREFIX.length), raw: '' };
  }

  const rule = RULES.find((r) => r.match.test(text));
  return { key: rule ? rule.key : null, raw: text };
}

/**
 * Whether the raw detail is worth offering separately: only when the message
 * shown to the user replaced it.
 */
export function hasTechnicalDetail(error: FriendlyError): boolean {
  return error.key !== null && error.raw !== '';
}

/** How long to wait for the first preview frame before calling it stuck. */
export const PREVIEW_TIMEOUT_MS = 90_000;
