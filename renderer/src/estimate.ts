/**
 * How long temporal fill is going to take, before it is started.
 *
 * The running job already reports a time remaining (see `eta.ts`), fitted to
 * samples it has actually observed. That is the accurate estimate, and it is
 * useless for the decision this one is for: whether to press Export at all.
 * Temporal fill is the one method where that decision is real — minutes
 * rather than seconds — and the user is making it with nothing on screen but
 * a quality dial.
 *
 * So this is a forecast, not a measurement, and it is deliberately coarse:
 * frames times a per-frame cost, divided across the cores that will share the
 * work. It is shown rounded to the same vague buckets the live estimate uses,
 * because a number like "4:12" would claim a precision that is not there.
 */
import type { TemporalQuality } from './types';

/**
 * Seconds one frame of temporal fill costs on one core, per quality.
 *
 * Anchored on the numbers the backend already documents: a single-frame
 * engine runs ~0.14 s/frame/core on the preview-sized frames measured in
 * `backend/processor.py`, and temporal fill is five to ten times that at
 * `balanced` (`backend/main.py`), more at the top setting where the flow runs
 * at full resolution and the walk reaches twice as far.
 *
 * The real cost also moves with the size of the selection and with how much
 * the footage moves — a fast pan finds its pixels in two frames and stops.
 * Both push the true figure *down*, which is the direction an estimate should
 * err in when the user is deciding whether to wait.
 */
const SECONDS_PER_FRAME_PER_CORE: Record<TemporalQuality, number> = {
  fast: 0.35,
  balanced: 0.7,
  high: 2.0,
};

/** Assumed when the main process has not said how many cores there are. */
const ASSUMED_CORES = 4;

export interface EstimateInput {
  /** Frames per second of the source. */
  fps: number;
  /** Seconds of video the job will cover: the whole clip, or the preview window. */
  seconds: number;
  quality: TemporalQuality;
  /** Cores the pool will spread the frames across, if known. */
  cpuCount?: number;
}

/**
 * Seconds the per-frame work will take, or null when the inputs cannot
 * support a guess — a video whose metadata has not arrived, or a duration
 * ffprobe could not read.
 */
export function estimateTemporalSeconds({
  fps,
  seconds,
  quality,
  cpuCount,
}: EstimateInput): number | null {
  if (!Number.isFinite(fps) || fps <= 0) return null;
  if (!Number.isFinite(seconds) || seconds <= 0) return null;

  const cores = Number.isFinite(cpuCount) && (cpuCount ?? 0) > 0 ? (cpuCount as number) : ASSUMED_CORES;
  const frames = fps * seconds;
  return (frames * SECONDS_PER_FRAME_PER_CORE[quality]) / cores;
}

/**
 * The forecast as a phrase, or null when there is nothing to say.
 *
 * The wording is hedged in the resources ("about"), and the buckets are wide,
 * because the spread between a locked-off shot and a fast pan is larger than
 * any rounding done here.
 */
export function formatEstimate(
  seconds: number | null,
  translate: (key: string, vars?: Record<string, string | number>) => string,
): string | null {
  if (seconds === null) return null;
  if (seconds < 45) return translate('estimate.seconds', { seconds: Math.max(5, Math.round(seconds / 5) * 5) });
  const minutes = Math.max(1, Math.round(seconds / 60));
  return translate('estimate.minutes', { minutes });
}
