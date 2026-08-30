/**
 * Removal presets: a named method plus the parameters that go with it.
 *
 * Built-ins cover the common cases; anything the user saves is kept in
 * localStorage, which is per-machine and survives restarts.
 */
import type { RemovalMethod, TemporalQuality } from './types';

export interface PresetParams {
  radius: number;
  kernelSize: number;
  color: [number, number, number];
  dx: number;
  dy: number;
  temporalQuality: TemporalQuality;
}

export interface Preset {
  id: string;
  /** Built-ins carry a translation key; a saved preset carries its own name. */
  nameKey?: string;
  name?: string;
  /** What it is good for — shown under the name. Key for built-ins. */
  descriptionKey?: string;
  method: RemovalMethod;
  params: PresetParams;
  custom?: boolean;
}

/** The parameter defaults a preset starts from. */
export const DEFAULT_PARAMS: PresetParams = {
  radius: 3,
  kernelSize: 51,
  color: [0, 0, 0],
  dx: 0,
  dy: -50,
  temporalQuality: 'balanced',
};

function preset(
  id: string,
  key: string,
  method: RemovalMethod,
  params: Partial<PresetParams>,
): Preset {
  return {
    id,
    nameKey: `presets.${key}`,
    descriptionKey: `presets.${key}Description`,
    method,
    params: { ...DEFAULT_PARAMS, ...params },
  };
}

export const BUILT_IN_PRESETS: Preset[] = [
  preset('smart-small', 'smartSmall', 'inpaint', { radius: 3 }),
  preset('smart-large', 'smartLarge', 'inpaint', { radius: 7 }),
  preset('blur-soft', 'blurSoft', 'blur', { kernelSize: 21 }),
  preset('blur-strong', 'blurStrong', 'blur', { kernelSize: 81 }),
  preset('fill-black', 'fillBlack', 'solidFill', { color: [0, 0, 0] }),
  preset('fill-white', 'fillWhite', 'solidFill', { color: [255, 255, 255] }),
  preset('clone-above', 'cloneAbove', 'cloneStamp', { dx: 0, dy: -50 }),
  preset('clone-left', 'cloneLeft', 'cloneStamp', { dx: -80, dy: 0 }),
  preset('temporal-balanced', 'temporalBalanced', 'temporal', { temporalQuality: 'balanced' }),
  preset('temporal-high', 'temporalHigh', 'temporal', { temporalQuality: 'quality' }),
];

const STORAGE_KEY = 'watermark-remover:custom-presets';

/**
 * Custom presets from localStorage.
 *
 * Storage can be unavailable or hold something unexpected — a corrupt entry
 * should cost the user their presets, never the app.
 */
export function loadCustomPresets(): Preset[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // A preset saved by an older version is missing whatever parameters have
    // been added since; the defaults fill those in rather than reaching the
    // backend as undefined.
    return parsed
      .filter(isPreset)
      .map((p) => ({ ...p, params: { ...DEFAULT_PARAMS, ...p.params }, custom: true }));
  } catch {
    return [];
  }
}

export function saveCustomPresets(presets: Preset[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(presets.filter((p) => p.custom)));
  } catch {
    // Out of quota or storage disabled: the presets are lost on restart, which
    // is better than breaking the export the user is in the middle of.
  }
}

function isPreset(value: unknown): value is Preset {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Partial<Preset>;
  return (
    typeof p.id === 'string' &&
    typeof p.name === 'string' &&
    typeof p.method === 'string' &&
    typeof p.params === 'object' &&
    p.params !== null
  );
}

/** Build a custom preset from the settings currently on screen. */
export function presetFromCurrent(name: string, method: RemovalMethod, params: PresetParams): Preset {
  return {
    id: `custom-${Date.now()}`,
    name: name.trim(),
    // Description is a fixed key: the user's own name carries the meaning.
    descriptionKey: 'presets.savedByYou',
    method,
    params: { ...params },
    custom: true,
  };
}

/** The label to show for a preset, translated for built-ins. */
export function presetLabel(
  preset: Preset,
  translate: (key: string) => string,
): { name: string; description: string } {
  return {
    name: preset.name ?? (preset.nameKey ? translate(preset.nameKey) : preset.id),
    description: preset.descriptionKey ? translate(preset.descriptionKey) : '',
  };
}
