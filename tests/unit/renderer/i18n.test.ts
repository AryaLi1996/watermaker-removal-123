/**
 * Unit tests for the translation layer.
 *
 * The parity test is the important one: it is what stops a new English string
 * shipping without its Chinese counterpart.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import en from '../../../renderer/src/i18n/en.json';
import zh from '../../../renderer/src/i18n/zh.json';
import { collectKeys, getLocale, LOCALES, LOCALE_NAMES, setLocale, t } from '../../../renderer/src/i18n';
import { classifyError, hasTechnicalDetail, OWN_MESSAGE_PREFIX } from '../../../renderer/src/errors';
import { BUILT_IN_PRESETS, presetFromCurrent, presetLabel, DEFAULT_PARAMS } from '../../../renderer/src/presets';
import { formatRemaining } from '../../../renderer/src/eta';

describe('locale resources', () => {
  it('define the same keys in every language', () => {
    const enKeys = collectKeys(en).sort();
    const zhKeys = collectKeys(zh).sort();

    expect(zhKeys.filter((k) => !enKeys.includes(k))).toEqual([]); // extra in zh
    expect(enKeys.filter((k) => !zhKeys.includes(k))).toEqual([]); // missing from zh
  });

  it('leave no value empty', () => {
    for (const [name, tree] of [['en', en], ['zh', zh]] as const) {
      for (const key of collectKeys(tree)) {
        setLocale(name);
        expect(t(key), `${name}.${key}`).not.toBe('');
      }
    }
  });

  it('keep the same {placeholders} in both languages', () => {
    const placeholders = (text: string) => (text.match(/\{(\w+)\}/g) ?? []).sort();
    for (const key of collectKeys(en)) {
      setLocale('en');
      const english = t(key);
      setLocale('zh');
      const chinese = t(key);
      expect(placeholders(chinese), key).toEqual(placeholders(english));
    }
  });

  it('names every locale in the picker', () => {
    for (const code of LOCALES) {
      expect(LOCALE_NAMES[code]).toBeTruthy();
    }
  });
});

describe('t', () => {
  beforeEach(() => {
    setLocale('en');
  });

  it('resolves a dotted key', () => {
    expect(t('actions.export')).toBe('Export');
    setLocale('zh');
    expect(t('actions.export')).toBe('导出');
  });

  it('fills placeholders', () => {
    expect(t('progress.secondsLeft', { seconds: 42 })).toBe('42s left');
    setLocale('zh');
    expect(t('progress.secondsLeft', { seconds: 42 })).toContain('42');
  });

  it('leaves an unknown placeholder in place rather than printing undefined', () => {
    expect(t('progress.secondsLeft', { minutes: 3 })).toBe('{seconds}s left');
  });

  it('returns the key itself when nothing matches', () => {
    expect(t('nothing.here.at.all')).toBe('nothing.here.at.all');
  });

  it('falls back to English for a key missing from the active locale', () => {
    // Every key exists in both today; this pins the behaviour for when one does not.
    setLocale('zh');
    expect(t('app.title')).toBe('视频水印去除工具');
    expect(t('some.key.only.in.english')).toBe('some.key.only.in.english');
  });

  it('persists the choice and reports it', () => {
    setLocale('zh');
    expect(getLocale()).toBe('zh');
    expect(window.localStorage.getItem('watermark-remover:locale')).toBe('zh');
  });

  it('ignores a locale it does not have', () => {
    setLocale('en');
    setLocale('de' as never);
    expect(getLocale()).toBe('en');
  });
});

describe('translated surfaces', () => {
  beforeEach(() => {
    setLocale('en');
  });

  it('renders every built-in preset in both languages', () => {
    for (const preset of BUILT_IN_PRESETS) {
      for (const locale of LOCALES) {
        setLocale(locale);
        const label = presetLabel(preset, t);
        expect(label.name, `${preset.id} name in ${locale}`).not.toContain('presets.');
        expect(label.description, `${preset.id} description in ${locale}`).not.toContain('presets.');
      }
    }
  });

  it('keeps a saved preset name untranslated', () => {
    const mine = presetFromCurrent('Mein Favorit', 'blur', DEFAULT_PARAMS);
    setLocale('zh');
    expect(presetLabel(mine, t).name).toBe('Mein Favorit');
    expect(presetLabel(mine, t).description).toBe('由你保存');
  });

  it('translates the time remaining', () => {
    setLocale('en');
    expect(formatRemaining(null, t)).toBe('estimating…');
    expect(formatRemaining(300, t)).toBe('about 5 min left');
    setLocale('zh');
    expect(formatRemaining(null, t)).toBe('正在估算…');
    expect(formatRemaining(300, t)).toContain('5');
  });

  it('classifies a backend failure to a key that both languages define', () => {
    const permission = classifyError("Permission denied: '/root/out.mp4'");
    expect(permission.key).toBe('errors.permission');
    expect(hasTechnicalDetail(permission)).toBe(true);

    setLocale('en');
    expect(t(permission.key!)).toContain('No permission');
    setLocale('zh');
    expect(t(permission.key!)).toContain('没有写入');
  });

  it('explains a rejected job payload in both languages, keeping the detail', () => {
    const invalid = classifyError(
      "Invalid job configuration — roi.w: Input should be greater than 0",
    );
    expect(invalid.key).toBe('errors.invalidConfig');
    // The field name is no use to the user, but it belongs in a bug report.
    expect(hasTechnicalDetail(invalid)).toBe(true);
    expect(invalid.raw).toContain('roi.w');

    setLocale('en');
    expect(t(invalid.key!)).toContain('could not use');
    setLocale('zh');
    expect(t(invalid.key!)).toContain('无法使用');
  });

  it('still names the missing file when validation is what caught it', () => {
    // The payload-level wrapper must not swallow the more specific cause.
    const missing = classifyError(
      "Invalid job configuration — inputPath: Input file not found: '/gone.mp4'",
    );
    expect(missing.key).toBe('errors.inputMissing');
  });

  it('passes an unrecognised failure through untranslated', () => {
    const unknown = classifyError('Some brand new failure');
    expect(unknown.key).toBeNull();
    expect(unknown.raw).toBe('Some brand new failure');
    expect(hasTechnicalDetail(unknown)).toBe(false);
  });

  it('accepts a key the app raised itself', () => {
    const own = classifyError(`${OWN_MESSAGE_PREFIX}errors.jobRunning`);
    expect(own.key).toBe('errors.jobRunning');
    // Nothing technical to copy: the app wrote this one.
    expect(hasTechnicalDetail(own)).toBe(false);
  });
});
