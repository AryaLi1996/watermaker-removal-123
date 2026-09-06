/**
 * The error codes, the advice under them, and the report a user copies out.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { classifyError, actionKeyFor, CODE_MESSAGES, CODE_PREFIX } from '../../../renderer/src/errors';
import type { ErrorCode } from '../../../renderer/src/errors';
import { formatReport, formatSize } from '../../../renderer/src/diagnostic';
import { loadSettings, saveSettings, DEFAULT_SETTINGS } from '../../../renderer/src/config';
import type { PathDiagnostic } from '../../../renderer/src/types';
import { setLocale, t } from '../../../renderer/src/i18n';

const ALL_CODES = Object.keys(CODE_MESSAGES) as ErrorCode[];

describe('error codes', () => {
  it('resolves every code the main process can send', () => {
    for (const code of ALL_CODES) {
      const classified = classifyError(`${CODE_PREFIX}${code}`);
      expect(classified.code, code).toBe(code);
      expect(classified.key, code).toBe(CODE_MESSAGES[code].key);
    }
  });

  it('gives every code a message and a line of advice in both languages', () => {
    for (const locale of ['en', 'zh'] as const) {
      setLocale(locale);
      for (const code of ALL_CODES) {
        const { key, action } = CODE_MESSAGES[code];
        // A missing key comes back as the key itself, which is the failure to
        // catch: a user would see `errors.actions.FILE_LOCKED` on screen.
        expect(t(key), `${locale}/${key}`).not.toBe(key);
        expect(t(action), `${locale}/${action}`).not.toBe(action);
      }
    }
  });

  it('does not trust a code it does not know', () => {
    // An older renderer against a newer main process must still say something.
    const unknown = classifyError(`${CODE_PREFIX}SOMETHING_NEW`);
    expect(unknown.key).toBe('errors.unknown');
    expect(unknown.code).toBeUndefined();
  });

  it('carries a code through from the backend prose too', () => {
    expect(classifyError("Input file not found: '/gone.mp4'").code).toBe('FILE_NOT_FOUND');
    expect(
      classifyError("Input file could not be read: 'D:\\a.mp4' (Permission denied)").code,
    ).toBe('FILE_LOCKED');
  });

  it('offers no advice for a failure that has no specific action', () => {
    const ffmpeg = classifyError('ffmpeg exited with status 1');
    expect(ffmpeg.code).toBeUndefined();
    expect(actionKeyFor(ffmpeg)).toBeNull();
  });

  it('points a locked file and a missing one at different advice', () => {
    setLocale('en');
    const locked = t(actionKeyFor(classifyError(`${CODE_PREFIX}FILE_LOCKED`))!);
    const missing = t(actionKeyFor(classifyError(`${CODE_PREFIX}FILE_NOT_FOUND`))!);
    expect(locked).not.toBe(missing);
    expect(locked).toContain('Close');
  });
});

const REPORT: PathDiagnostic = {
  path: 'D:\\视频\\demo.mp4',
  platform: 'win32',
  length: 20,
  exceedsMaxPath: false,
  exists: true,
  readable: false,
  size: 2_500_000,
  isNetworkDrive: false,
  volumeRoot: 'D:\\',
  volumeReachable: true,
  hasNonAscii: true,
  looksMisdecoded: false,
  onSameVolumeAsTemp: false,
  longPath: { applicable: true, enabled: false, registryKey: 'HKLM\\...\\LongPathsEnabled' },
  error: 'EBUSY',
};

describe('the copied report', () => {
  it('names the facts a support conversation turns on', () => {
    const text = formatReport(REPORT);
    for (const fragment of ['D:\\视频\\demo.mp4', 'win32', 'EBUSY', 'LongPathsEnabled']) {
      expect(text).toContain(fragment);
    }
    // One line each, so it survives being pasted into an email.
    expect(text.split('\n').length).toBeGreaterThan(10);
  });

  it('omits the long-path line where the setting means nothing', () => {
    const posix = { ...REPORT, platform: 'darwin', longPath: { applicable: false, enabled: null, registryKey: '' } };
    expect(formatReport(posix)).not.toContain('long paths');
  });

  it('says unknown rather than guessing when a fact could not be read', () => {
    const partial = { ...REPORT, onSameVolumeAsTemp: null, size: null };
    const text = formatReport(partial);
    expect(text).toContain('same volume as tmp: unknown');
    expect(text).toContain('size              : —');
  });

  it('scales the size to something readable', () => {
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(2048)).toBe('2.0 KB');
    expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatSize(null)).toBe('—');
  });
});

describe('file-handling settings', () => {
  beforeEach(() => localStorage.clear());

  it('leaves the copy off until someone asks for it', () => {
    expect(loadSettings().copyToTempBeforeProcessing).toBe(false);
  });

  it('remembers the choice', () => {
    saveSettings({ ...DEFAULT_SETTINGS, copyToTempBeforeProcessing: true });
    expect(loadSettings().copyToTempBeforeProcessing).toBe(true);
  });

  it('falls back to the defaults for a stored value of the wrong shape', () => {
    localStorage.setItem('app-settings', '{"copyToTempBeforeProcessing":"yes","maxTempFileSizeMB":-4}');
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('survives a stored entry that is not JSON at all', () => {
    localStorage.setItem('app-settings', 'not json');
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });
});
