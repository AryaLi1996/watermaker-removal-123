/**
 * Pipeline stage labels.
 *
 * The backend announces where it is as a key (`STATE:stage:encoding`) rather
 * than as a sentence, because the UI is bilingual and the backend has no way
 * to know which language the user is reading. The words live here, with every
 * other string in the app, so switching language changes the status line too —
 * including while a job is running.
 */

/** Marks a state line that carries a stage key rather than prose. */
export const STAGE_PREFIX = 'stage:';

/**
 * Stages the backend can report. A label it sends that is not on this list is
 * shown as it arrived: an older backend, or a newer one, is better read
 * verbatim than as a missing translation key.
 */
export const STAGES = [
  'probing',
  'extractingStill',
  'extractingClip',
  'extractingFrames',
  'processing',
  'temporalProcessing',
  'encoding',
  'preparingPreview',
] as const;

export type Stage = (typeof STAGES)[number];

function isStage(value: string): value is Stage {
  return (STAGES as readonly string[]).includes(value);
}

/** The stage key a backend state line carries, or null if it carries prose. */
export function stageOf(label: string): Stage | null {
  if (!label.startsWith(STAGE_PREFIX)) return null;
  const key = label.slice(STAGE_PREFIX.length).trim();
  return isStage(key) ? key : null;
}

/** A state line as the user should read it, in the active language. */
export function stageLabel(label: string, t: (key: string) => string): string {
  const stage = stageOf(label);
  return stage ? t(`stages.${stage}`) : label;
}

/** The state line to show for a stage the app itself is driving. */
export function stageState(stage: Stage): string {
  return STAGE_PREFIX + stage;
}
