/**
 * Frames the paid filler could not fill, and this machine finished.
 *
 * Same shape and the same reasoning as `TemporalFallbackNote` and
 * `DeepNoticeNote`: a summary after the fact, not a stage. The export wrote
 * its file, so this is not an error — but the frames it names were filled by
 * a different method than the rest, which is a seam the user may be able to
 * see, and they paid for the one that did not run.
 *
 * It was silent until now. The backend emitted the notice on the debug
 * channel, which no user reads, while `cloud_fill.py` described this path as
 * "a fallback to the local filler and a note saying so". This is the note.
 */
import type { CloudFallback } from '../types';
import { useTranslation } from '../hooks/useTranslation';

export default function CloudFallbackNote({ report }: { report: CloudFallback | null }) {
  const { t } = useTranslation();
  if (!report || report.count <= 0) return null;

  return (
    <div
      data-testid="cloud-fallback-note"
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
      <div>{t('cloud.fallbackNotice', { count: report.count })}</div>
      {/* The reason names which of a dozen causes applied — a timeout, a
          refusal, a patch too large — and is the difference between "try
          again" and "stop paying for it". Left in English, as the deep
          notice leaves its own. */}
      {report.detail && (
        <div data-testid="cloud-fallback-detail"
             style={{ opacity: 0.75, marginTop: 2, wordBreak: 'break-word' }}>
          {report.detail}
        </div>
      )}
    </div>
  );
}
