/**
 * ProgressPanel — replaces the sidebar controls during processing.
 * Shows a thin progress bar, stage label, time remaining, and a Cancel button.
 */
import { formatRemaining } from '../eta';
import { useTranslation } from '../hooks/useTranslation';
import { stageLabel } from '../stages';

interface ProgressPanelProps {
  progress: number; // 0–100
  /** The backend's raw state line — translated here, so it follows the language. */
  stateLabel: string;
  /** Seconds remaining, or null while there is too little signal to say. */
  secondsRemaining: number | null;
  onCancel: () => void;
}

export default function ProgressPanel({ progress, stateLabel, secondsRemaining, onCancel }: ProgressPanelProps) {
  const { t } = useTranslation();

  return (
    <div data-testid="progress-panel" className="flex flex-col gap-4 pt-2">
      {/* Stage label */}
      <p style={{ color: 'var(--text-muted)', fontSize: 12 }}>{stateLabel ? stageLabel(stateLabel, t) : t('status.starting')}</p>

      {/* Progress bar */}
      <div style={{ background: 'var(--surface)', borderRadius: 2, height: 2, overflow: 'hidden' }}>
        <div
          style={{
            height: '100%',
            width: `${progress}%`,
            background: 'var(--accent)',
            borderRadius: 2,
            transition: 'width 0.3s ease',
          }}
        />
      </div>

      {/* Percentage and time remaining */}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <p style={{ color: 'var(--text-faint)', fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
          {Math.round(progress)}%
        </p>
        <p data-testid="eta" style={{ color: 'var(--text-faint)', fontSize: 11 }}>
          {formatRemaining(secondsRemaining, t)}
        </p>
      </div>

      {/* Cancel */}
      <button
        data-testid="btn-cancel"
        onClick={onCancel}
        style={{
          background: 'transparent',
          border: 'none',
          color: 'var(--text-faint)',
          fontSize: 12,
          cursor: 'pointer',
          padding: '4px 0',
          textAlign: 'left',
          textDecoration: 'underline',
        }}
      >
        {t('actions.cancel')}
      </button>
    </div>
  );
}
