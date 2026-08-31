/**
 * PresetPicker — one click sets the method and its parameters.
 *
 * Built-in presets cover the usual cases; whatever the user saves sits
 * alongside them and can be removed again.
 */
import { useState } from 'react';
import { presetLabel, type Preset } from '../presets';
import { useTranslation } from '../hooks/useTranslation';

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
  const { t } = useTranslation();
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
        <p style={{ color: 'var(--text-muted)', fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
          {t('presets.heading')}
        </p>
        <button
          data-testid="save-preset"
          onClick={() => onNamingChange(true)}
          disabled={disabled}
          style={{
            background: 'none', border: 'none', color: 'var(--accent-link)', fontSize: 11,
            cursor: disabled ? 'not-allowed' : 'pointer', padding: 0, textDecoration: 'underline',
          }}
        >
          {t('presets.saveCurrent')}
        </button>
      </div>

      {naming && (
        <div data-testid="preset-name-form" style={{ display: 'flex', gap: 6 }}>
          <input
            data-testid="preset-name"
            autoFocus
            value={name}
            placeholder={t('presets.namePlaceholder')}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save();
              if (e.key === 'Escape') { onNamingChange(false); setName(''); }
            }}
            style={{
              flex: 1, minWidth: 0, background: 'var(--bg)', border: '1px solid var(--border)',
              borderRadius: 4, padding: '4px 8px', color: 'var(--text)', fontSize: 11,
            }}
          />
          <button
            data-testid="preset-name-confirm"
            onClick={save}
            style={{
              background: 'var(--accent)', border: 'none', borderRadius: 4, padding: '4px 10px',
              color: 'var(--accent-contrast)', fontSize: 11, cursor: 'pointer',
            }}
          >
            {t('presets.save')}
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
          const label = presetLabel(preset, t);
          return (
            <div key={preset.id} style={{ position: 'relative' }}>
              <button
                data-testid={`preset-${preset.id}`}
                onClick={() => onApply(preset)}
                disabled={disabled}
                title={label.description}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  background: active ? 'var(--accent-soft)' : 'var(--surface)',
                  border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                  borderRadius: 6,
                  padding: '6px 8px',
                  cursor: disabled ? 'not-allowed' : 'pointer',
                }}
              >
                <span style={{ display: 'block', color: 'var(--text)', fontSize: 11 }}>{label.name}</span>
                <span style={{ display: 'block', color: 'var(--text-faint)', fontSize: 10, marginTop: 2 }}>
                  {label.description}
                </span>
              </button>
              {preset.custom && (
                <button
                  data-testid={`delete-${preset.id}`}
                  onClick={() => onDelete(preset.id)}
                  aria-label={t('presets.delete', { name: label.name })}
                  style={{
                    position: 'absolute', top: 2, right: 4, background: 'none', border: 'none',
                    color: 'var(--text-faint)', fontSize: 12, lineHeight: 1, cursor: 'pointer', padding: 2,
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
