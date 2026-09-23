/**
 * What the survey found, and which of it to remove.
 *
 * The list is the whole point of detection: the app has an opinion about what
 * is on the video, and this is where the user gets to disagree with it before
 * anything is touched. So the marks arrive ticked and everything else arrives
 * unticked — removing a subtitle or a caption is destroying the user's own
 * work, and no amount of confidence in a classifier earns the right to do that
 * without being asked.
 *
 * Everything that is not a mark is behind a disclosure. The survey reports
 * every region it can solve, which on a real clip is a dozen rows of things
 * nobody came here to remove; with them all on screen the two rows that matter
 * are the hardest to find. Collapsed, they are still one click away for the
 * user whose sticker the classifier called something else.
 */
import { useState } from 'react';
import { useTranslation } from '../hooks/useTranslation';
import type { Finding } from '../types';

interface FindingsPanelProps {
  findings: Finding[];
  scanning: boolean;
  failed: boolean;
  /** Indices of `findings` the user wants removed. */
  selected: ReadonlySet<number>;
  /** Whether the box drawn on the canvas is one of the things to remove. */
  drawnBoxChosen: boolean;
  disabled: boolean;
  onToggle: (index: number) => void;
  onToggleDrawnBox: () => void;
  onRescan: () => void;
}

function seconds(value: number): string {
  return value >= 60
    ? `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`
    : `${value.toFixed(1)}s`;
}

function Row({
  finding, index, checked, disabled, onToggle,
}: {
  finding: Finding;
  index: number;
  checked: boolean;
  disabled: boolean;
  onToggle: (index: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <label
      data-testid={`finding-${index}`}
      style={{
        display: 'flex', alignItems: 'baseline', gap: 8, padding: '5px 6px',
        borderRadius: 4, cursor: disabled ? 'not-allowed' : 'pointer',
        background: checked ? 'var(--accent-soft)' : 'transparent',
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={() => onToggle(index)}
        style={{ cursor: disabled ? 'not-allowed' : 'pointer' }}
      />
      <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>
        {t(`findings.${finding.kind}`)}
      </span>
      <span style={{ color: 'var(--text-faint)', fontSize: 11, marginLeft: 'auto' }}>
        {seconds(finding.start)}–{seconds(finding.end)}
      </span>
    </label>
  );
}

/**
 * The box the user drew, as one more thing that can be ticked.
 *
 * It sits in the same list as the survey's rows because it is the same kind of
 * answer — a place to take something out of — and because the thing it is for
 * is being ticked *alongside* them. Before this row existed a drawn box could
 * only replace the survey's findings, so a clip with two watermarks and one
 * thing the survey missed had no way to ask for all three.
 *
 * Unticked by default. A box is always on the canvas, including the one nobody
 * has moved, and a row that arrived ticked would have the app quietly removing
 * a corner of every video.
 */
function DrawnBoxRow({
  checked, disabled, onToggle,
}: {
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  return (
    <label
      data-testid="finding-drawn-box"
      style={{
        display: 'flex', alignItems: 'baseline', gap: 8, padding: '5px 6px',
        borderRadius: 4, cursor: disabled ? 'not-allowed' : 'pointer',
        background: checked ? 'var(--accent-soft)' : 'transparent',
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onToggle}
        style={{ cursor: disabled ? 'not-allowed' : 'pointer' }}
      />
      <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>
        {t('findings.drawnBox')}
      </span>
      <span style={{ color: 'var(--text-faint)', fontSize: 11, marginLeft: 'auto' }}>
        {t('findings.drawnBoxWhen')}
      </span>
    </label>
  );
}

export default function FindingsPanel({
  findings, scanning, failed, selected, drawnBoxChosen, disabled,
  onToggle, onToggleDrawnBox, onRescan,
}: FindingsPanelProps) {
  const { t } = useTranslation();
  const [showRest, setShowRest] = useState(false);

  if (scanning) {
    return (
      <p data-testid="findings-scanning" style={{ color: 'var(--text-muted)', fontSize: 11 }}>
        {t('findings.scanning')}
      </p>
    );
  }

  // Nothing found and nothing to say about why is still worth a line: silence
  // reads as a feature that did not run.
  if (!findings.length) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <p data-testid="findings-empty" style={{ color: 'var(--text-muted)', fontSize: 11 }}>
          {t(failed ? 'findings.failed' : 'findings.none')}
        </p>
        {/* Worth offering even with nothing found. Unticked, the backend takes
            the box as a hint and looks for what holds still under it; ticked,
            it solves the box exactly as drawn. The second is what the user
            wants when the scan has already disagreed with them once. */}
        <DrawnBoxRow checked={drawnBoxChosen} disabled={disabled} onToggle={onToggleDrawnBox} />
        <button
          type="button"
          data-testid="findings-rescan"
          disabled={disabled}
          onClick={onRescan}
          style={{
            alignSelf: 'flex-start', background: 'transparent', fontSize: 11,
            border: '1px solid var(--border)', borderRadius: 4, padding: '3px 8px',
            color: 'var(--text-secondary)', cursor: disabled ? 'not-allowed' : 'pointer',
          }}
        >
          {t('findings.rescan')}
        </button>
      </div>
    );
  }

  const marks = findings.map((f, i) => [f, i] as const).filter(([f]) => f.proposed);
  const rest = findings.map((f, i) => [f, i] as const).filter(([f]) => !f.proposed);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ color: 'var(--text-muted)', fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
        {t('findings.heading')}
      </span>

      {marks.length === 0 && (
        <p data-testid="findings-no-marks" style={{ color: 'var(--text-muted)', fontSize: 11 }}>
          {t('findings.noMarks')}
        </p>
      )}
      {marks.map(([finding, index]) => (
        <Row key={index} finding={finding} index={index} checked={selected.has(index)}
             disabled={disabled} onToggle={onToggle} />
      ))}

      {rest.length > 0 && (
        <>
          <button
            type="button"
            data-testid="findings-toggle-rest"
            onClick={() => setShowRest((open) => !open)}
            style={{
              alignSelf: 'flex-start', background: 'transparent', border: 'none',
              color: 'var(--accent-link)', fontSize: 11, cursor: 'pointer', padding: '2px 0',
            }}
          >
            {t(showRest ? 'findings.hideRest' : 'findings.showRest', { count: rest.length })}
          </button>
          {showRest && rest.map(([finding, index]) => (
            <Row key={index} finding={finding} index={index} checked={selected.has(index)}
                 disabled={disabled} onToggle={onToggle} />
          ))}
        </>
      )}

      <DrawnBoxRow checked={drawnBoxChosen} disabled={disabled} onToggle={onToggleDrawnBox} />

      <p style={{ color: 'var(--text-muted)', fontSize: 11, lineHeight: 1.5, marginTop: 2 }}>
        {t('findings.hint')}
      </p>
    </div>
  );
}
