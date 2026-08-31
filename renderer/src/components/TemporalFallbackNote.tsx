/**
 * "Some frames could not be rebuilt" — the one thing the temporal engine has
 * to say after the fact.
 *
 * A frame whose optical flow fails is filled from itself instead, the way
 * Smart Fill would do it. The export still finishes and every frame is still
 * filled, so this is not an error; but the result is not quite what was asked
 * for, and the user is the only one who can judge whether that matters on
 * their footage.
 *
 * It is deliberately not a stage. Stages describe where the pipeline is, and
 * they are replaced by the next one a moment later: announcing a fallback
 * that way would flash a warning for one frame in three thousand and then
 * hide it, which reads as the whole job failing. This is a summary instead,
 * shown once the job is over and the count is final.
 */
import type { TemporalFallback } from '../types';
import { useTranslation } from '../hooks/useTranslation';

export default function TemporalFallbackNote({ report }: { report: TemporalFallback | null }) {
  const { t } = useTranslation();
  if (!report || report.degraded <= 0) return null;

  return (
    <p
      data-testid="temporal-fallback-note"
      style={{
        background: 'var(--warn-bg)',
        border: '1px solid var(--warn-border)',
        borderRadius: 4,
        padding: '6px 8px',
        color: 'var(--warn-text)',
        fontSize: 11,
        lineHeight: 1.5,
      }}
    >
      {t('status.temporalFallback', {
        degraded: report.degraded,
        total: report.total,
      })}
    </p>
  );
}
