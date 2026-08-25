/**
 * Time-remaining estimate for a running job.
 *
 * Progress is not linear: extraction, per-frame work and encoding move at
 * different rates, so an estimate from total average speed lurches around.
 * This fits recent samples instead, which tracks the current phase.
 */

export interface ProgressSample {
  /** Percent complete, 0–100. */
  percent: number;
  /** Milliseconds since the epoch. */
  at: number;
}

/** How many samples the estimate looks back over. */
const WINDOW = 8;

/** Below this, an estimate is noise. */
const MIN_PERCENT = 3;

export function recordSample(samples: ProgressSample[], percent: number, at: number): ProgressSample[] {
  const last = samples[samples.length - 1];
  // Progress can repeat or, after a restart, go backwards; neither is a sample.
  if (last && percent <= last.percent) {
    return percent < last.percent ? [{ percent, at }] : samples;
  }
  return [...samples, { percent, at }].slice(-WINDOW);
}

/**
 * Seconds remaining, or null when there is not enough signal to say.
 */
export function estimateSecondsRemaining(samples: ProgressSample[]): number | null {
  if (samples.length < 2) return null;

  const first = samples[0];
  const last = samples[samples.length - 1];
  if (last.percent < MIN_PERCENT || last.percent >= 100) return null;

  const percentDelta = last.percent - first.percent;
  const msDelta = last.at - first.at;
  if (percentDelta <= 0 || msDelta <= 0) return null;

  const percentPerMs = percentDelta / msDelta;
  const remaining = (100 - last.percent) / percentPerMs;
  return remaining / 1000;
}

/** "about 2 min", "45s" — deliberately vague, because the estimate is. */
export function formatRemaining(seconds: number | null): string {
  if (seconds === null) return 'estimating…';
  if (seconds < 10) return 'almost done';
  if (seconds < 90) return `${Math.round(seconds)}s left`;
  const minutes = Math.round(seconds / 60);
  return `about ${minutes} min left`;
}
