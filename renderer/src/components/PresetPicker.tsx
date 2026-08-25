/**
 * PresetPicker — one click sets the method and its parameters.
 *
 * Built-in presets cover the usual cases; whatever the user saves sits
 * alongside them and can be removed again.
 */
import { useState } from 'react';
import type { Preset } from '../presets';

interface PresetPickerProps {
  presets: Preset[];
  /** Which preset the current settings match, if any. */
  activeId: string | null;
  disabled: boolean;
  /** Controlled by the parent so ⌘S can open the form too. */
  naming: boolean;
  onNamingChange: (naming: boolean) => void;
  onApply: (preset: Preset) => void;
  onDelete: (id: string) => void;
  onSaveCurrent: (name: string) => void;
}

export default function PresetPicker({
  presets,
  activeId,
  disabled,
  naming,
  onNamingChange,
  onApply,
  onDelete,
  onSaveCurrent,
}: PresetPickerProps) {
  const [name, setName] = useState('');

  const save = () => {
    if (!name.trim()) return;
    onSaveCurrent(name);
    setName('');
    onNamingChange(false);
  };

  return (
    <div className="flex flex-col gap-2" style={{ opacity: disabled ? 0.5 : 1 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <p style={{ color: '#a1a1aa', fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
          Presets
        </p>
        <button
          data-testid="save-preset"
          onClick={() => onNamingChange(true)}
          disabled={disabled}
          style={{
            background: 'none', border: 'none', color: '#818cf8', fontSize: 11,
            cursor: disabled ? 'not-allowed' : 'pointer', padding: 0, textDecoration: 'underline',
          }}
        >
          Save current
        </button>
      </div>

      {naming && (
        <div data-testid="preset-name-form" style={{ display: 'flex', gap: 6 }}>
          <input
            data-testid="preset-name"
            autoFocus
            value={name}
            placeholder="Preset name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save();
              if (e.key === 'Escape') { onNamingChange(false); setName(''); }
            }}
            style={{
              flex: 1, minWidth: 0, background: '#18181b', border: '1px solid #3f3f46',
              borderRadius: 4, padding: '4px 8px', color: '#f4f4f5', fontSize: 11,
            }}
          />
          <button
            data-testid="preset-name-confirm"
            onClick={save}
            style={{
              background: '#6366f1', border: 'none', borderRadius: 4, padding: '4px 10px',
              color: '#fff', fontSize: 11, cursor: 'pointer',
            }}
          >
            Save
          </button>
        </div>
      )}

      {/* Capped: eight presets at full height push the rest of the sidebar —
          the file name, the method picker, the buttons — below the fold. */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 6,
          maxHeight: 148,
          overflowY: 'auto',
          paddingRight: 2,
        }}
      >
        {presets.map((preset) => {
          const active = preset.id === activeId;
          return (
            <div key={preset.id} style={{ position: 'relative' }}>
              <button
                data-testid={`preset-${preset.id}`}
                onClick={() => onApply(preset)}
                disabled={disabled}
                title={preset.description}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  background: active ? '#312e81' : '#27272a',
                  border: `1px solid ${active ? '#6366f1' : '#3f3f46'}`,
                  borderRadius: 6,
                  padding: '6px 8px',
                  cursor: disabled ? 'not-allowed' : 'pointer',
                }}
              >
                <span style={{ display: 'block', color: '#f4f4f5', fontSize: 11 }}>{preset.name}</span>
                <span style={{ display: 'block', color: '#71717a', fontSize: 10, marginTop: 2 }}>
                  {preset.description}
                </span>
              </button>
              {preset.custom && (
                <button
                  data-testid={`delete-${preset.id}`}
                  onClick={() => onDelete(preset.id)}
                  aria-label={`Delete preset ${preset.name}`}
                  style={{
                    position: 'absolute', top: 2, right: 4, background: 'none', border: 'none',
                    color: '#71717a', fontSize: 12, lineHeight: 1, cursor: 'pointer', padding: 2,
                  }}
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
