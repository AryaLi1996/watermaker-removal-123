/**
 * Keyboard shortcuts for the actions people repeat.
 *
 * Only actions that already exist in the UI are bound — a shortcut that does
 * nothing is worse than no shortcut.
 */
import { useEffect } from 'react';
import type { RemovalMethod } from '../types';

export interface ShortcutHandlers {
  onExport: () => void;
  onPreview: () => void;
  onCancel: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onSavePreset: () => void;
  onSelectMethod: (method: RemovalMethod) => void;
}

/** Number keys pick a method, in the order the picker shows them. */
const METHOD_ORDER: RemovalMethod[] = ['inpaint', 'blur', 'solidFill', 'cloneStamp'];

/** Typing in a field must never trigger an export. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

export function useKeyboardShortcuts(handlers: ShortcutHandlers, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();

      // Escape cancels even from a field — it is the "get me out" key.
      if (key === 'escape') {
        handlers.onCancel();
        return;
      }

      if (isTyping(event.target)) return;

      if (mod && key === 'e') {
        event.preventDefault();
        handlers.onExport();
        return;
      }
      if (mod && key === 'p') {
        event.preventDefault();
        handlers.onPreview();
        return;
      }
      if (mod && key === 's') {
        event.preventDefault();
        handlers.onSavePreset();
        return;
      }
      if (mod && key === 'z') {
        event.preventDefault();
        if (event.shiftKey) handlers.onRedo();
        else handlers.onUndo();
        return;
      }
      // Ctrl+Y is the Windows convention for redo.
      if (mod && key === 'y') {
        event.preventDefault();
        handlers.onRedo();
        return;
      }

      if (!mod && key >= '1' && key <= '4') {
        const method = METHOD_ORDER[Number(key) - 1];
        if (method) {
          event.preventDefault();
          handlers.onSelectMethod(method);
        }
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [handlers, enabled]);
}

/** Rendered in the sidebar so the shortcuts are discoverable. */
export const SHORTCUT_HINTS: { keys: string; label: string }[] = [
  { keys: '1–4', label: 'Method' },
  { keys: '⌘/Ctrl + P', label: 'Preview' },
  { keys: '⌘/Ctrl + E', label: 'Export' },
  { keys: '⌘/Ctrl + Z', label: 'Undo' },
  { keys: '⌘/Ctrl + S', label: 'Save preset' },
  { keys: 'Esc', label: 'Cancel' },
];
