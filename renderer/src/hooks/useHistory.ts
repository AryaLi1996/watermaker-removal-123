/**
 * Undo/redo over the settings that define a job.
 *
 * Entries are pushed by the caller when a change settles (a finished drag, a
 * released slider) rather than on every keystroke, so one undo steps back one
 * intentional edit.
 */
import { useCallback, useRef, useState } from 'react';
import type { RemovalMethod, ROI } from '../types';
import type { PresetParams } from '../presets';

export interface JobSettings {
  roi: ROI;
  method: RemovalMethod;
  params: PresetParams;
}

/** Deep-ish equality for the small, flat settings shape. */
export function sameSettings(a: JobSettings, b: JobSettings): boolean {
  return (
    a.method === b.method &&
    a.roi.x === b.roi.x && a.roi.y === b.roi.y && a.roi.w === b.roi.w && a.roi.h === b.roi.h &&
    a.params.radius === b.params.radius &&
    a.params.kernelSize === b.params.kernelSize &&
    a.params.dx === b.params.dx &&
    a.params.dy === b.params.dy &&
    a.params.temporalQuality === b.params.temporalQuality &&
    a.params.color[0] === b.params.color[0] &&
    a.params.color[1] === b.params.color[1] &&
    a.params.color[2] === b.params.color[2]
  );
}

const LIMIT = 50;

export function useHistory(initial: JobSettings) {
  const [entries, setEntries] = useState<JobSettings[]>([initial]);
  const [index, setIndex] = useState(0);

  // Undo/redo apply settings, which would otherwise be pushed straight back on
  // as a new entry. This suppresses that for the duration of the apply.
  const applying = useRef(false);

  const push = useCallback((next: JobSettings) => {
    if (applying.current) return;
    setEntries((prev) => {
      const current = prev[index];
      if (current && sameSettings(current, next)) return prev;

      // Anything redone-past is dropped, as in any editor.
      const trimmed = [...prev.slice(0, index + 1), next].slice(-LIMIT);
      setIndex(trimmed.length - 1);
      return trimmed;
    });
  }, [index]);

  const step = useCallback((delta: number): JobSettings | null => {
    const target = index + delta;
    if (target < 0 || target >= entries.length) return null;
    applying.current = true;
    setIndex(target);
    // Cleared after the caller's state updates have flushed.
    queueMicrotask(() => { applying.current = false; });
    return entries[target];
  }, [entries, index]);

  const undo = useCallback(() => step(-1), [step]);
  const redo = useCallback(() => step(1), [step]);

  return {
    push,
    undo,
    redo,
    canUndo: index > 0,
    canRedo: index < entries.length - 1,
    /** Suppresses pushes while the caller applies an undone state. */
    isApplying: applying,
  };
}
