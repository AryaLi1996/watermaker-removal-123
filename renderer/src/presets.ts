/**
 * Removal presets: a named method plus the parameters that go with it.
 *
 * Built-ins cover the common cases; anything the user saves is kept in
 * localStorage, which is per-machine and survives restarts.
 */
import type { RemovalMethod } from './types';

export interface PresetParams {
  radius: number;
  kernelSize: number;
  color: [number, number, number];
  dx: number;
  dy: number;
}

export interface Preset {
  id: string;
  name: string;
  /** What it is good for — shown under the name. */
  description: string;
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
};

function preset(
  id: string,
  name: string,
  description: string,
  method: RemovalMethod,
  params: Partial<PresetParams>,
): Preset {
  return { id, name, description, method, params: { ...DEFAULT_PARAMS, ...params } };
}

export const BUILT_IN_PRESETS: Preset[] = [
  preset('smart-small', 'Smart fill — small', 'Logos and badges', 'inpaint', { radius: 3 }),
  preset('smart-large', 'Smart fill — large', 'Bigger marks on busy backgrounds', 'inpaint', { radius: 7 }),
  preset('blur-soft', 'Soft blur', 'Subtitles and captions', 'blur', { kernelSize: 21 }),
  preset('blur-strong', 'Strong blur', 'Hides a mark completely', 'blur', { kernelSize: 81 }),
  preset('fill-black', 'Black box', 'Letterboxed or dark footage', 'solidFill', { color: [0, 0, 0] }),
  preset('fill-white', 'White box', 'Light backgrounds', 'solidFill', { color: [255, 255, 255] }),
  preset('clone-above', 'Clone from above', 'Marks over flat areas', 'cloneStamp', { dx: 0, dy: -50 }),
  preset('clone-left', 'Clone from the left', 'Marks near the top or bottom edge', 'cloneStamp', { dx: -80, dy: 0 }),
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
    return parsed.filter(isPreset).map((p) => ({ ...p, custom: true }));
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
    description: 'Saved by you',
    method,
    params: { ...params },
    custom: true,
  };
}
