/**
 * Unit tests for the deep-learning surface: whether the switch is offered on
 * this machine, what preset it promises, and whether everything it can put on
 * screen is translated in both languages.
 */
import { describe, expect, it } from 'vitest';

import {
  DEEP_MIN_VRAM_MB,
  DEEP_PRESET_VRAM_MB,
  deepAvailability,
  deepPresetFor,
  usesDeepEngine,
} from '../../../renderer/src/capabilities';
import type { GpuInfo, SystemInfo } from '../../../renderer/src/types';
import { LOCALES, setLocale, t } from '../../../renderer/src/i18n';

const base: SystemInfo = {
  platform: 'linux',
  arch: 'x64',
  packaged: true,
  appVersion: '1.1.0',
  cpuCount: 8,
  totalMemoryMB: 16384,
};

const withGpu = (gpu: Partial<GpuInfo>): SystemInfo => ({
  ...base,
  gpu: { available: true, name: 'Test card', memoryTotalMB: 24564, ...gpu },
});

const NO_GPU: SystemInfo = { ...base, gpu: { available: false, name: '', memoryTotalMB: 0 } };

describe('deepAvailability', () => {
  it('offers the switch on a machine with a big enough card', () => {
    expect(deepAvailability(withGpu({})).available).toBe(true);
  });

  it('withholds it where there is no card, and says so', () => {
    const result = deepAvailability(NO_GPU);
    expect(result.available).toBe(false);
    expect(result.reasonKey).toBe('deep.needsGpu');
  });

  it('withholds it where the card is too small, and says so', () => {
    const result = deepAvailability(withGpu({ memoryTotalMB: DEEP_MIN_VRAM_MB - 1 }));
    expect(result.available).toBe(false);
    expect(result.reasonKey).toBe('deep.needsVram');
  });

  it('offers it while the machine is still unknown', () => {
    // systemInfo resolves after the first render; hiding the switch for that
    // moment makes it flicker into existence.
    expect(deepAvailability(null).available).toBe(true);
  });

  it('offers it to a main process too old to report a GPU', () => {
    // It cannot tell us there is a card, but it cannot tell us there is not
    // either, and the backend checks again and falls back gracefully.
    expect(deepAvailability(base).available).toBe(true);
  });

  it('takes a card exactly at the bar', () => {
    expect(deepAvailability(withGpu({ memoryTotalMB: DEEP_MIN_VRAM_MB })).available).toBe(true);
  });
});

describe('deepPresetFor', () => {
  it('gives a big card what was asked for', () => {
    expect(deepPresetFor('high', withGpu({ memoryTotalMB: DEEP_PRESET_VRAM_MB.high }))).toBe('high');
  });

  it('steps down to what the card can carry', () => {
    expect(deepPresetFor('high', withGpu({ memoryTotalMB: 12000 }))).toBe('balanced');
    expect(deepPresetFor('high', withGpu({ memoryTotalMB: 6000 }))).toBe('fast');
  });

  it('never steps up past what was asked for', () => {
    expect(deepPresetFor('fast', withGpu({ memoryTotalMB: 48000 }))).toBe('fast');
  });

  it('returns nothing where no preset fits', () => {
    expect(deepPresetFor('high', withGpu({ memoryTotalMB: 1024 }))).toBeNull();
  });

  it('takes an unknown card at its word', () => {
    // The backend picks correctly and reports if it had to step down.
    expect(deepPresetFor('balanced', null)).toBe('balanced');
    expect(deepPresetFor('balanced', base)).toBe('balanced');
  });

  it('agrees with the availability check about the smallest card', () => {
    const tiny = withGpu({ memoryTotalMB: DEEP_MIN_VRAM_MB - 1 });
    expect(deepAvailability(tiny).available).toBe(false);
    expect(deepPresetFor('fast', tiny)).toBeNull();
  });
});

describe('usesDeepEngine', () => {
  it('is on only under temporal fill', () => {
    expect(usesDeepEngine('temporal', true, withGpu({}))).toBe(true);
    expect(usesDeepEngine('inpaint', true, withGpu({}))).toBe(false);
  });

  it('is off where the switch is off', () => {
    expect(usesDeepEngine('temporal', false, withGpu({}))).toBe(false);
  });

  it('is off where the machine cannot run it, whatever the switch says', () => {
    // The switch can be left ticked from a session on another machine, or
    // from a preset; it must not send a job that cannot run as asked.
    expect(usesDeepEngine('temporal', true, NO_GPU)).toBe(false);
  });
});

describe('the deep-learning strings', () => {
  const keys = [
    'method.deepLearning',
    'method.deepLearningHint',
    'method.deepBadge',
    'method.deepNote',
    'method.deepDowngrade',
    'method.deepPreviewFast',
    'deep.needsGpu',
    'deep.needsVram',
    'deep.notInstalled',
    'deep.fallbackTitle',
    'deep.fallbackBody',
    'deep.qualityTitle',
    'deep.qualityBody',
    'stages.deepProcessing',
  ];

  for (const locale of LOCALES) {
    it(`are all translated in ${locale}`, () => {
      setLocale(locale);
      for (const key of keys) {
        // A missing key falls through to the key itself, which on screen
        // reads as a bug rather than as a sentence.
        expect(t(key), key).not.toBe(key);
      }
    });
  }

  it('fills the placeholder in the downgrade line', () => {
    setLocale('en');
    const rendered = t('method.deepDowngrade', { quality: t('quality.balanced') });
    expect(rendered).toContain('Balanced');
    expect(rendered).not.toContain('{quality}');
  });
});
