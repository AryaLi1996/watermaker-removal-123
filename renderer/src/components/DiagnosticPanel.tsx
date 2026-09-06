/**
 * DiagnosticPanel — what to send support when a video will not open.
 *
 * A file that refuses to load is the hardest kind of bug to hear about second
 * hand: the one fact that settles it, the path, is the one thing that does not
 * survive being retyped into an email. This asks the main process what the
 * filesystem says about the path and lays the answer out to be copied in one
 * click.
 *
 * Read-only, and shown only where the main process says it is enabled — it is
 * a support tool, not something to put in front of everyone who mistypes a
 * filename.
 */
import { useCallback, useState } from 'react';
import { useTranslation } from '../hooks/useTranslation';
import type { PathDiagnostic } from '../types';
import { formatReport, formatSize } from '../diagnostic';

interface DiagnosticPanelProps {
  /** The file to ask about. */
  filePath: string;
}

/** One row of the table, with an optional warning tint. */
function Row({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between' }}>
      <span style={{ color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>{label}</span>
      <span
        style={{
          color: warn ? 'var(--danger-text)' : 'var(--text)',
          wordBreak: 'break-all',
          textAlign: 'right',
        }}
      >
        {value}
      </span>
    </div>
  );
}

export default function DiagnosticPanel({ filePath }: DiagnosticPanelProps) {
  const { t } = useTranslation();
  const [report, setReport] = useState<PathDiagnostic | null>(null);
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState(false);

  const run = useCallback(async () => {
    const probe = window.electronAPI.diagnosePath;
    if (!probe) return;
    setRunning(true);
    try {
      setReport(await probe(filePath));
    } catch {
      // A diagnostic that fails is not worth an error of its own; the panel
      // simply stays empty and the user still has the message above it.
      setReport(null);
    } finally {
      setRunning(false);
    }
  }, [filePath]);

  const yes = t('diagnostic.yes');
  const no = t('diagnostic.no');
  const unknown = t('diagnostic.unknown');

  return (
    <div data-testid="diagnostic-panel" style={{ marginTop: 8 }}>
      <button
        data-testid="run-diagnostic"
        onClick={() => void run()}
        disabled={running}
        style={{
          background: 'none', border: 'none', color: 'var(--danger-action)',
          cursor: running ? 'default' : 'pointer', fontSize: 11,
          textDecoration: 'underline', padding: 0,
        }}
      >
        {running ? t('diagnostic.running') : t('diagnostic.run')}
      </button>

      {report && (
        <div
          data-testid="diagnostic-result"
          style={{
            marginTop: 8, display: 'flex', flexDirection: 'column', gap: 3,
            fontSize: 11, fontFamily: 'var(--mono, monospace)',
            background: 'var(--bg)', border: '1px solid var(--border)',
            borderRadius: 4, padding: '8px 10px',
          }}
        >
          <Row label={t('diagnostic.path')} value={report.path} />
          <Row
            label={t('diagnostic.length')}
            value={String(report.length)}
            warn={report.exceedsMaxPath}
          />
          <Row label={t('diagnostic.exists')} value={report.exists ? yes : no} warn={!report.exists} />
          <Row label={t('diagnostic.readable')} value={report.readable ? yes : no} warn={!report.readable} />
          <Row label={t('diagnostic.size')} value={formatSize(report.size)} />
          <Row
            label={t('diagnostic.volume')}
            value={`${report.volumeRoot || '—'} · ${report.volumeReachable ? yes : no}`}
            warn={!report.volumeReachable}
          />
          <Row label={t('diagnostic.networkDrive')} value={report.isNetworkDrive ? yes : no} />
          <Row
            label={t('diagnostic.externalVolume')}
            value={report.onSameVolumeAsTemp === null ? unknown : (report.onSameVolumeAsTemp ? no : yes)}
          />
          <Row
            label={t('diagnostic.encoding')}
            value={report.looksMisdecoded ? t('diagnostic.misdecoded') : (report.hasNonAscii ? t('diagnostic.nonAscii') : 'ASCII')}
            warn={report.looksMisdecoded}
          />
          {report.longPath.applicable && (
            <Row
              label={t('diagnostic.longPaths')}
              value={report.longPath.enabled === null ? unknown : (report.longPath.enabled ? yes : no)}
              warn={report.longPath.enabled === false && report.exceedsMaxPath}
            />
          )}
          {report.error && <Row label={t('diagnostic.lastError')} value={report.error} warn />}

          <button
            data-testid="copy-diagnostic"
            onClick={() => {
              void navigator.clipboard?.writeText(formatReport(report))
                .then(() => setCopied(true))
                .catch(() => setCopied(false));
            }}
            style={{
              alignSelf: 'flex-start', marginTop: 6, background: 'none', border: 'none',
              color: 'var(--danger-action)', cursor: 'pointer', fontSize: 11,
              textDecoration: 'underline', padding: 0,
            }}
          >
            {copied ? t('actions.copied') : t('diagnostic.copy')}
          </button>
        </div>
      )}
    </div>
  );
}
