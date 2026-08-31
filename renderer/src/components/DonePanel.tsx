/**
 * DonePanel — shown after a successful export (State 4).
 * Auto-transitions back to loaded state after 5 seconds.
 */
import { useEffect, useState } from 'react';
import type { DeepNotice, TemporalFallback } from '../types';
import TemporalFallbackNote from './TemporalFallbackNote';
import DeepNoticeNote from './DeepNoticeNote';
import { useTranslation } from '../hooks/useTranslation';

interface DonePanelProps {
  outputPath: string;
  /** Frames the temporal engine could not rebuild, or null if none were. */
  temporalFallback?: TemporalFallback | null;
  /** What the learned engine did differently, or null where it did not. */
  deepNotice?: DeepNotice | null;
  onReveal: () => void;
  onReset: () => void;
}

export default function DonePanel({
  outputPath,
  temporalFallback = null,
  deepNotice = null,
  onReveal,
  onReset,
}: DonePanelProps) {
  const { t } = useTranslation();
  const [countdown, setCountdown] = useState(5);

  // An export with a caveat stays on screen. Five seconds is enough to read
  // "done" and nothing else, and the one panel that carries the news about a
  // degraded result is the wrong thing to snatch away — there is nowhere else
  // the user could go to find it again.
  // Either caveat counts: an export that used a different engine than the one
  // selected is exactly as much a thing to read as frames that fell back.
  const hasNotice = (!!temporalFallback && temporalFallback.degraded > 0) || !!deepNotice;

  useEffect(() => {
    if (hasNotice) return;
    const interval = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) { clearInterval(interval); onReset(); return 0; }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [onReset, hasNotice]);

  const filename = outputPath.split(/[\\/]/).pop() ?? outputPath;

  return (
    <div data-testid="done-panel" className="flex flex-col gap-3 pt-2">
      {/* Success banner */}
      <div style={{
        background: 'var(--success-bg)',
        border: '1px solid var(--success-border)',
        borderRadius: 6,
        padding: '8px 12px',
        color: 'var(--success-text)',
        fontSize: 13,
      }}>
        ✓ {t('status.exportComplete')}
      </div>

      <p style={{ color: 'var(--text-muted)', fontSize: 11, wordBreak: 'break-all' }}>{filename}</p>

      <TemporalFallbackNote report={temporalFallback} />
      <DeepNoticeNote notice={deepNotice} />

      <button
        data-testid="btn-reveal"
        onClick={onReveal}
        style={{
          background: 'transparent',
          border: '1px solid var(--border)',
          borderRadius: 6,
          padding: '6px 12px',
          color: 'var(--text-secondary)',
          fontSize: 12,
          cursor: 'pointer',
        }}
      >
        {t('actions.reveal')}
      </button>

      {hasNotice ? (
        <button
          data-testid="btn-done-dismiss"
          onClick={onReset}
          style={{
            background: 'transparent', border: 'none', padding: 0,
            color: 'var(--text-disabled)', fontSize: 11, cursor: 'pointer', textAlign: 'left',
          }}
        >
          {t('actions.dismiss')}
        </button>
      ) : (
        <p style={{ color: 'var(--text-disabled)', fontSize: 11 }}>
          {t('status.returningIn', { seconds: countdown })}
        </p>
      )}
    </div>
  );
}
