/**
 * What the learned engine did that the user did not ask for.
 *
 * Two things can happen to a job that ticked "deep learning enhancement":
 * the engine could not run at all and the optical-flow one finished the
 * export, or it ran at a lower preset than the dial because the graphics card
 * did not have the memory for the one chosen. Neither is a failure — the file
 * is written either way — and neither may be silent, because in both cases
 * the result on screen is not the result the settings describe, and the user
 * would otherwise judge the deep engine on work it did not do.
 *
 * Same shape and the same reasoning as `TemporalFallbackNote`: a summary
 * after the fact, not a stage. The backend's own sentence rides along beneath
 * the translated explanation — it is the line that says *which* of a dozen
 * reasons applied, and it is what goes into a bug report.
 */
import type { DeepNotice } from '../types';
import { useTranslation } from '../hooks/useTranslation';

export default function DeepNoticeNote({ notice }: { notice: DeepNotice | null }) {
  const { t } = useTranslation();
  if (!notice) return null;

  const fallback = notice.kind === 'fallback';
  // The quality notice names the preset that ran, which arrives as the
  // backend's key ('fast' | 'balanced' | 'high') and is translated here.
  const quality = fallback ? '' : t(`quality.${notice.detail}`);

  return (
    <div
      data-testid="deep-notice"
      style={{
        background: fallback ? '#422006' : '#1e1b4b',
        border: `1px solid ${fallback ? '#a16207' : '#312e81'}`,
        borderRadius: 4,
        padding: '6px 8px',
        color: fallback ? '#fde68a' : '#c7d2fe',
        fontSize: 11,
        lineHeight: 1.5,
      }}
    >
      <strong style={{ fontWeight: 500 }}>
        {fallback ? t('deep.fallbackTitle') : t('deep.qualityTitle', { quality })}
      </strong>
      <div>{fallback ? t('deep.fallbackBody') : t('deep.qualityBody')}</div>
      {/* Only on the fallback: there the detail names the actual cause (no
          card, no checkout, an out-of-memory line from the model), and it is
          the difference between "fix it" and "give up". On the quality notice
          the detail is just the preset name, already said above. */}
      {fallback && notice.detail && (
        <div data-testid="deep-notice-detail" style={{ opacity: 0.75, marginTop: 2, wordBreak: 'break-word' }}>
          {notice.detail}
        </div>
      )}
    </div>
  );
}
