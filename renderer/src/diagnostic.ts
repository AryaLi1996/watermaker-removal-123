/**
 * Formatting for the diagnostic report.
 *
 * Apart from the panel that renders it because this is the half worth testing
 * and reusing: the text form is what actually reaches a support inbox, and it
 * has to stay readable after being pasted into an email that reflows it.
 */
import type { PathDiagnostic } from './types';

/** A size in whichever unit keeps it readable. */
export function formatSize(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * The report as plain text, which is the form it travels in.
 *
 * Labels are padded to a fixed width and left in English: this is read by
 * whoever is helping, not by the person who copied it, and a report that
 * changes shape with the reader's language is one that cannot be grepped.
 */
export function formatReport(report: PathDiagnostic): string {
  const lines = [
    `path              : ${report.path}`,
    `platform          : ${report.platform}`,
    `path length       : ${report.length}${report.exceedsMaxPath ? ' (at or past MAX_PATH)' : ''}`,
    `exists            : ${report.exists}`,
    `readable          : ${report.readable}`,
    `size              : ${formatSize(report.size)}`,
    `volume root       : ${report.volumeRoot || '—'}`,
    `volume reachable  : ${report.volumeReachable}`,
    `network drive     : ${report.isNetworkDrive}`,
    `same volume as tmp: ${report.onSameVolumeAsTemp === null ? 'unknown' : report.onSameVolumeAsTemp}`,
    `non-ascii in path : ${report.hasNonAscii}`,
    `mis-decoded path  : ${report.looksMisdecoded}`,
    `last error        : ${report.error ?? 'none'}`,
  ];
  if (report.longPath.applicable) {
    const state = report.longPath.enabled === null ? 'unknown' : report.longPath.enabled;
    lines.push(`long paths        : ${state} (${report.longPath.registryKey})`);
  }
  return lines.join('\n');
}
