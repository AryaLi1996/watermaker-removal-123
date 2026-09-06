/**
 * The diagnostic panel: what it asks for, what it shows, and what it copies.
 *
 * Beside the component because rendering one needs @testing-library/react,
 * which only files inside the renderer root can resolve. The report itself is
 * gathered by the main process (covered in tests/e2e/diagnostics.spec.ts) and
 * formatted by `diagnostic.ts` (covered in tests/unit/renderer). What is left,
 * and what these cover, is whether the user can actually get at it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import DiagnosticPanel from './DiagnosticPanel';
import { setLocale } from '../i18n';
import type { PathDiagnostic } from '../types';

/** JSX attributes do not process escapes, so the path goes in as a value. */
const PATH = 'D:\\视频\\demo.mp4';

const REPORT: PathDiagnostic = {
  path: PATH,
  platform: 'win32',
  length: 20,
  exceedsMaxPath: false,
  exists: true,
  readable: false,
  size: 2_500_000,
  isNetworkDrive: true,
  volumeRoot: '\\\\server\\share',
  volumeReachable: false,
  hasNonAscii: true,
  looksMisdecoded: false,
  onSameVolumeAsTemp: false,
  longPath: { applicable: true, enabled: false, registryKey: 'HKLM\\...\\LongPathsEnabled' },
  error: 'EBUSY',
};

function mockApi(overrides: Record<string, unknown> = {}) {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    diagnosePath: vi.fn().mockResolvedValue(REPORT),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('DiagnosticPanel', () => {
  it('asks for nothing until the user asks', () => {
    mockApi();
    render(<DiagnosticPanel filePath={PATH} />);

    expect(screen.queryByTestId('diagnostic-result')).toBeNull();
    expect(window.electronAPI.diagnosePath).not.toHaveBeenCalled();
  });

  it('reports on the path it was given', async () => {
    mockApi();
    render(<DiagnosticPanel filePath={PATH} />);

    fireEvent.click(screen.getByTestId('run-diagnostic'));

    await waitFor(() => expect(screen.getByTestId('diagnostic-result')).toBeTruthy());
    expect(window.electronAPI.diagnosePath).toHaveBeenCalledWith(PATH);
    const shown = screen.getByTestId('diagnostic-result').textContent ?? '';
    // The facts a support conversation turns on: where it is, whether it can
    // be read, how big it is, and what the last failure was.
    expect(shown).toContain(PATH);
    expect(shown).toContain('2.4 MB');
    expect(shown).toContain('EBUSY');
  });

  it('copies the report as text', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    mockApi();
    render(<DiagnosticPanel filePath={PATH} />);
    fireEvent.click(screen.getByTestId('run-diagnostic'));
    await waitFor(() => expect(screen.getByTestId('diagnostic-result')).toBeTruthy());

    fireEvent.click(screen.getByTestId('copy-diagnostic'));

    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText.mock.calls[0][0]).toContain('volume reachable  : false');
  });

  it('shows nothing rather than throwing when the probe fails', async () => {
    mockApi({ diagnosePath: vi.fn().mockRejectedValue(new Error('nope')) });
    render(<DiagnosticPanel filePath="/tmp/x.mp4" />);

    fireEvent.click(screen.getByTestId('run-diagnostic'));

    await waitFor(() => expect(screen.getByTestId('run-diagnostic')).toBeEnabled());
    expect(screen.queryByTestId('diagnostic-result')).toBeNull();
  });

  it('does nothing at all against a main process that cannot diagnose', async () => {
    mockApi({ diagnosePath: undefined });
    render(<DiagnosticPanel filePath="/tmp/x.mp4" />);

    fireEvent.click(screen.getByTestId('run-diagnostic'));

    expect(screen.queryByTestId('diagnostic-result')).toBeNull();
  });

  it('is translated', async () => {
    setLocale('zh');
    mockApi();
    render(<DiagnosticPanel filePath={PATH} />);

    expect(screen.getByTestId('run-diagnostic').textContent).toBe('诊断该文件');
    fireEvent.click(screen.getByTestId('run-diagnostic'));

    await waitFor(() => expect(screen.getByTestId('diagnostic-result')).toBeTruthy());
    expect(screen.getByTestId('diagnostic-result').textContent).toContain('路径长度');
  });
});
