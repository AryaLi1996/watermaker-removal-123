/**
 * Whether this machine can run the heavier removal methods.
 *
 * Temporal inpainting reads several frames per frame and computes optical
 * flow against each, on every core at once. On a two-core laptop that turns a
 * ten-second clip into a wait long enough that the honest thing is to say so
 * up front rather than let the user start it and cancel it.
 *
 * The rule is deliberately generous: this greys out a method, and being
 * wrong in that direction takes a working feature away from someone.
 */
import type { RemovalMethod, SystemInfo, TemporalQuality } from './types';

/** Fewer cores than this and the export takes long enough to be a mistake. */
export const TEMPORAL_MIN_CPUS = 4;
/** Frames are held per worker while they are reconstructed. */
export const TEMPORAL_MIN_MEMORY_MB = 4096;

export interface Availability {
  available: boolean;
  /** Why not, as a translation key. Null when it is available. */
  reasonKey: string | null;
}

const AVAILABLE: Availability = { available: true, reasonKey: null };

/**
 * Whether temporal inpainting should be offered here.
 *
 * An unknown machine is a capable one: `info` is null until the main process
 * answers, and an older main process never reports the hardware fields at
 * all. Neither is a reason to hide the method.
 */
export function temporalAvailability(info: SystemInfo | null): Availability {
  if (!info) return AVAILABLE;

  if (typeof info.cpuCount === 'number' && info.cpuCount > 0 && info.cpuCount < TEMPORAL_MIN_CPUS) {
    return { available: false, reasonKey: 'method.temporalNeedsCpu' };
  }
  if (
    typeof info.totalMemoryMB === 'number' &&
    info.totalMemoryMB > 0 &&
    info.totalMemoryMB < TEMPORAL_MIN_MEMORY_MB
  ) {
    return { available: false, reasonKey: 'method.temporalNeedsMemory' };
  }
  return AVAILABLE;
}

/**
 * The longest preview a temporal job may run.
 *
 * A preview costs the same per frame as the export, so the length that makes
 * the other methods feel instant would make this one the slowest thing in the
 * app. The backend caps it too — this is here so the control shows the length
 * that will actually run.
 */
export const TEMPORAL_PREVIEW_MAX_SECONDS = 3;

/** How much of the video a preview of this method covers. */
export function previewSecondsFor(method: RemovalMethod, seconds: number): number {
  return method === 'temporal' ? Math.min(seconds, TEMPORAL_PREVIEW_MAX_SECONDS) : seconds;
}

/** The quality steps, slowest last — the order the picker shows them in. */
export const TEMPORAL_QUALITIES: TemporalQuality[] = ['fast', 'balanced', 'high'];

/**
 * The quality a preview runs at, whatever the dial says.
 *
 * A preview exists to answer one question — is the box in the right place,
 * and is the mark gone — and it has to answer it while the user is still
 * looking. At the top setting temporal fill takes long enough that the honest
 * description of the wait is "minutes", which is not a preview; it is an
 * export with a smaller output. The dial still decides the export, and the UI
 * says so beside it, because the preview is now a slightly rougher picture
 * than the export will be and hiding that would be the worse trade.
 */
export const PREVIEW_TEMPORAL_QUALITY: TemporalQuality = 'fast';

/**
 * The quality to send for a job, given what the user picked.
 *
 * Only temporal fill reads the setting at all, so a preview of any other
 * method passes through untouched.
 */
export function qualityForJob(
  method: RemovalMethod,
  chosen: TemporalQuality,
  isPreview: boolean,
): TemporalQuality {
  return isPreview && method === 'temporal' ? PREVIEW_TEMPORAL_QUALITY : chosen;
}

/** Whether the preview will run at something other than the chosen setting. */
export function previewIsDowngraded(method: RemovalMethod, chosen: TemporalQuality): boolean {
  return method === 'temporal' && chosen !== PREVIEW_TEMPORAL_QUALITY;
}

/**
 * The learned engine (ProPainter) needs a CUDA card, and enough of one.
 *
 * The numbers below mirror `backend/propainter_engine.PRESETS`: each preset
 * has a resolution and a chunk length, and those decide how much video memory
 * a run allocates. They are duplicated here rather than fetched because the
 * sidebar has to answer "can I tick this box" before any backend process has
 * been started — and because being a few hundred megabytes optimistic here
 * costs a fallback notice, while being pessimistic hides a feature that works.
 *
 * A machine below the smallest preset is not offered the switch at all: it
 * would tick, run nothing, and report a fallback every single time.
 */
export const DEEP_PRESET_VRAM_MB: Record<TemporalQuality, number> = {
  fast: 4096,
  balanced: 8192,
  high: 20480,
};

/** The smallest card that can run anything. Below this, no preset fits. */
export const DEEP_MIN_VRAM_MB = DEEP_PRESET_VRAM_MB.fast;

/**
 * Whether the learned engine should be offered here.
 *
 * Unknown is available, as everywhere else in this file: `info` is null until
 * the main process answers. A main process old enough not to report a GPU at
 * all is the one exception where that rule would be wrong — it cannot tell us
 * there is a card, so offering the switch would promise something nothing can
 * deliver — but it also cannot tell us there is not, and the backend checks
 * again and falls back gracefully. So: offered, with the fallback as the net.
 */
export function deepAvailability(info: SystemInfo | null): Availability {
  if (!info || !info.gpu) return AVAILABLE;
  if (!info.gpu.available) return { available: false, reasonKey: 'deep.needsGpu' };
  if (info.gpu.memoryTotalMB > 0 && info.gpu.memoryTotalMB < DEEP_MIN_VRAM_MB) {
    return { available: false, reasonKey: 'deep.needsVram' };
  }
  return AVAILABLE;
}

/**
 * The preset the learned engine will actually run, given the dial and the
 * card. It steps down rather than refusing — see `select_settings` in
 * `backend/propainter_engine.py`, which this mirrors — so the sidebar can
 * say up front that "high" will run as "balanced" here.
 *
 * Null where nothing fits, which `deepAvailability` has already ruled out.
 */
export function deepPresetFor(
  chosen: TemporalQuality,
  info: SystemInfo | null,
): TemporalQuality | null {
  const memory = info?.gpu?.memoryTotalMB ?? 0;
  // An unknown card is taken at its word: the backend will pick correctly and
  // report if it had to step down.
  if (memory <= 0) return chosen;

  const order = TEMPORAL_QUALITIES.slice(0, TEMPORAL_QUALITIES.indexOf(chosen) + 1);
  for (const level of order.reverse()) {
    if (memory >= DEEP_PRESET_VRAM_MB[level]) return level;
  }
  return null;
}

/**
 * Whether the learned engine is what a job will actually use.
 *
 * The switch only means anything under temporal fill: it is that method's
 * second implementation, not a method of its own.
 */
export function usesDeepEngine(
  method: RemovalMethod,
  enabled: boolean,
  info: SystemInfo | null,
): boolean {
  return method === 'temporal' && enabled && deepAvailability(info).available;
}
