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
import type { SystemInfo, TemporalQuality } from './types';

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

/** The quality steps, slowest last — the order the picker shows them in. */
export const TEMPORAL_QUALITIES: TemporalQuality[] = ['fast', 'balanced', 'quality'];
