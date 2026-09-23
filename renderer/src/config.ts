/**
 * Preferences that change how a job is fetched or run, rather than what it does.
 *
 * Kept apart from the removal settings the user picks per video: these are
 * machine-shaped choices that stay put between videos, and they persist the
 * same way the theme and presets do.
 */

const STORAGE_KEY = 'app-settings';

import { NO_CONSENT, type CloudConsent } from './cloud';

export interface AppSettings {
  /**
   * Copy the video to a local temp file before processing it.
   *
   * Off by default, because for a file already on this disk the copy is pure
   * cost. It earns its keep on a network share or an external drive, which an
   * export reads several times over: a share that drops halfway through leaves
   * a half-finished job, and one wait up front avoids that. Files past
   * `maxTempFileSizeMB` are read where they are — duplicating gigabytes to
   * save a re-read is the wrong trade, and the job usually works anyway.
   */
  copyToTempBeforeProcessing: boolean;
  /** Above this, the original is used and no copy is made. */
  maxTempFileSizeMB: number;
  /**
   * Whether to let the fill service repaint what the arithmetic cannot
   * recover. Off until the user turns it on and agrees to the notice: nothing
   * about a video leaves the machine on a default.
   */
  cloudFillEnabled: boolean;
  /**
   * The upload notice this user agreed to, and when. Kept beside the switch
   * rather than inside it, because the two answer different questions — "do I
   * want this on" and "what was I told when I said yes" — and only the second
   * one has to survive a change of wording.
   */
  cloudConsent: CloudConsent;
}

export const DEFAULT_SETTINGS: AppSettings = {
  copyToTempBeforeProcessing: false,
  maxTempFileSizeMB: 500,
  cloudFillEnabled: false,
  cloudConsent: NO_CONSENT,
};

/**
 * The stored settings, falling back to the defaults for anything missing.
 *
 * A stored value that is the wrong shape is ignored rather than trusted: this
 * comes from disk, and a corrupted entry should not stop the app loading.
 */
function readConsent(stored: unknown): CloudConsent {
  if (!stored || typeof stored !== 'object') return NO_CONSENT;
  const { version, agreedAt } = stored as Partial<CloudConsent>;
  if (typeof version !== 'number' || typeof agreedAt !== 'string' || !agreedAt) {
    return NO_CONSENT;
  }
  return { version, agreedAt };
}


export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const stored = JSON.parse(raw) as Partial<AppSettings>;
    return {
      copyToTempBeforeProcessing:
        typeof stored.copyToTempBeforeProcessing === 'boolean'
          ? stored.copyToTempBeforeProcessing
          : DEFAULT_SETTINGS.copyToTempBeforeProcessing,
      maxTempFileSizeMB:
        typeof stored.maxTempFileSizeMB === 'number' && stored.maxTempFileSizeMB > 0
          ? stored.maxTempFileSizeMB
          : DEFAULT_SETTINGS.maxTempFileSizeMB,
      cloudFillEnabled:
        typeof stored.cloudFillEnabled === 'boolean'
          ? stored.cloudFillEnabled
          : DEFAULT_SETTINGS.cloudFillEnabled,
      // A stored consent is only believed where it names a version and a
      // time. Anything else — a hand-edited file, a half-written entry, a
      // shape from a future release — reads as "not agreed", which is the
      // only direction it is safe to be wrong in.
      cloudConsent: readConsent(stored.cloudConsent),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Persist the settings. A refused write is not worth failing the app over. */
export function saveSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch { /* private mode, or a full quota */ }
}
