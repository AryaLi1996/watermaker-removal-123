/**
 * Unit tests for the temporal-fill surface: whether the method is offered on
 * this machine, and whether everything it puts on screen is translated.
 */
import { describe, expect, it } from 'vitest';

import {
  TEMPORAL_MIN_CPUS,
  TEMPORAL_MIN_MEMORY_MB,
  TEMPORAL_QUALITIES,
  temporalAvailability,
} from '../../../renderer/src/capabilities';
import type { SystemInfo } from '../../../renderer/src/types';
import { LOCALES, setLocale, t } from '../../../renderer/src/i18n';
import { BUILT_IN_PRESETS, DEFAULT_PARAMS, presetLabel } from '../../../renderer/src/presets';
import { sameSettings } from '../../../renderer/src/hooks/useHistory';
import { STAGES, stageLabel, stageState } from '../../../renderer/src/stages';

const capable: SystemInfo = {
  platform: 'darwin',
  arch: 'arm64',
  packaged: true,
  appVersion: '1.1.0',
  cpuCount: 8,
  totalMemoryMB: 16384,
};

describe('temporalAvailability', () => {
  it('offers the method on a machine that can run it', () => {
    expect(temporalAvailability(capable)).toEqual({ available: true, reasonKey: null });
  });

  it('offers it while the machine is still unknown', () => {
    // systemInfo resolves after the first render; hiding a method for that
    // moment would make it flicker in.
    expect(temporalAvailability(null).available).toBe(true);
  });

  it('offers it to a main process too old to report the hardware', () => {
    const { cpuCount, totalMemoryMB, ...older } = capable;
    void cpuCount;
    void totalMemoryMB;
    expect(temporalAvailability(older).available).toBe(true);
  });

  it('withholds it from a machine with too few cores, and says so', () => {
    const result = temporalAvailability({ ...capable, cpuCount: TEMPORAL_MIN_CPUS - 1 });
    expect(result.available).toBe(false);
    expect(result.reasonKey).toBe('method.temporalNeedsCpu');
  });

  it('withholds it from a machine with too little memory, and says so', () => {
    const result = temporalAvailability({ ...capable, totalMemoryMB: TEMPORAL_MIN_MEMORY_MB - 1 });
    expect(result.available).toBe(false);
    expect(result.reasonKey).toBe('method.temporalNeedsMemory');
  });

  it('keeps the method for a machine that is exactly at the bar', () => {
    expect(temporalAvailability({
      ...capable,
      cpuCount: TEMPORAL_MIN_CPUS,
      totalMemoryMB: TEMPORAL_MIN_MEMORY_MB,
    }).available).toBe(true);
  });

  it('ignores a nonsense reading rather than taking the feature away', () => {
    expect(temporalAvailability({ ...capable, cpuCount: 0, totalMemoryMB: 0 }).available).toBe(true);
  });

  it('gives a reason both languages can show', () => {
    for (const info of [
      { ...capable, cpuCount: 1 },
      { ...capable, totalMemoryMB: 512 },
    ]) {
      const { reasonKey } = temporalAvailability(info);
      for (const locale of LOCALES) {
        setLocale(locale);
        expect(t(reasonKey!), `${reasonKey} in ${locale}`).not.toBe(reasonKey);
      }
    }
  });
});

describe('the temporal surface', () => {
  it('names the method, its warning and its beta badge in both languages', () => {
    const keys = [
      'method.temporal',
      'method.temporalDescription',
      'method.temporalBeta',
      'method.temporalNote',
      'params.temporalQuality',
    ];
    for (const locale of LOCALES) {
      setLocale(locale);
      for (const key of keys) {
        expect(t(key), `${key} in ${locale}`).not.toBe(key);
      }
    }
  });

  it('names every quality step in both languages', () => {
    for (const locale of LOCALES) {
      setLocale(locale);
      for (const level of TEMPORAL_QUALITIES) {
        expect(t(`quality.${level}`), `${level} in ${locale}`).not.toBe(`quality.${level}`);
      }
    }
  });

  it('offers the quality steps slowest last', () => {
    expect(TEMPORAL_QUALITIES).toEqual(['fast', 'balanced', 'quality']);
  });

  it('translates the stage the backend reports for a temporal job', () => {
    expect(STAGES).toContain('temporalProcessing');
    setLocale('en');
    expect(stageLabel(stageState('temporalProcessing'), t)).toContain('longer');
    setLocale('zh');
    expect(stageLabel(stageState('temporalProcessing'), t)).toContain('时间修复');
  });

  it('ships temporal presets that carry a quality', () => {
    const temporal = BUILT_IN_PRESETS.filter((p) => p.method === 'temporal');
    expect(temporal.length).toBeGreaterThan(0);
    for (const preset of temporal) {
      expect(TEMPORAL_QUALITIES).toContain(preset.params.temporalQuality);
      for (const locale of LOCALES) {
        setLocale(locale);
        expect(presetLabel(preset, t).name).not.toContain('presets.');
        expect(presetLabel(preset, t).description).not.toContain('presets.');
      }
    }
  });

  it('starts on the balanced quality', () => {
    expect(DEFAULT_PARAMS.temporalQuality).toBe('balanced');
  });

  it('counts a change of quality as an edit worth undoing', () => {
    const base = {
      roi: { x: 0, y: 0, w: 10, h: 10 },
      method: 'temporal' as const,
      params: DEFAULT_PARAMS,
    };
    expect(sameSettings(base, base)).toBe(true);
    expect(sameSettings(base, {
      ...base,
      params: { ...DEFAULT_PARAMS, temporalQuality: 'quality' },
    })).toBe(false);
  });
});
