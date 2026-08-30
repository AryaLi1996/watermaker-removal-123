/**
 * MethodPicker — sidebar control panel for removal algorithm and parameters.
 */
import type { RemovalMethod, TemporalQuality } from '../types';
import type { Availability } from '../capabilities';
import { TEMPORAL_QUALITIES } from '../capabilities';
import { useTranslation } from '../hooks/useTranslation';

interface MethodPickerProps {
  method: RemovalMethod;
  radius: number;
  kernelSize: number;
  color: [number, number, number];
  dx: number;
  dy: number;
  temporalQuality: TemporalQuality;
  /** Whether this machine can run temporal inpainting, and why not if it cannot. */
  temporal: Availability;
  disabled: boolean;
  onChange: (updates: Partial<{
    method: RemovalMethod;
    radius: number;
    kernelSize: number;
    color: [number, number, number];
    dx: number;
    dy: number;
    temporalQuality: TemporalQuality;
  }>) => void;
}

/** Labels come from the resources; the order is what the number keys map to. */
const METHODS: RemovalMethod[] = ['inpaint', 'blur', 'solidFill', 'cloneStamp', 'temporal'];

function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  disabled: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between items-center">
        <span style={{ color: '#a1a1aa', fontSize: 11 }}>{label}</span>
        <span style={{ color: '#f4f4f5', fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-indigo-500 disabled:opacity-40"
        style={{ height: 4 }}
      />
    </div>
  );
}

export default function MethodPicker({
  method,
  radius,
  kernelSize,
  color,
  dx,
  dy,
  temporalQuality,
  temporal,
  disabled,
  onChange,
}: MethodPickerProps) {
  const { t } = useTranslation();

  /** A method can be off the table on its own account, not just because a job is running. */
  const unavailable = (id: RemovalMethod) => id === 'temporal' && !temporal.available;

  return (
    <div data-testid="method-picker" className="flex flex-col gap-4" style={{ opacity: disabled ? 0.5 : 1 }}>
      <p style={{ color: '#a1a1aa', fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
        {t('method.heading')}
      </p>

      <div className="flex flex-col gap-1">
        {METHODS.map((id) => {
          const off = unavailable(id);
          return (
            <button
              key={id}
              data-testid={`method-${id}`}
              disabled={disabled || off}
              title={off && temporal.reasonKey ? t(temporal.reasonKey) : undefined}
              onClick={() => !disabled && !off && onChange({ method: id })}
              style={{
                background: method === id ? '#312e81' : 'transparent',
                border: `1px solid ${method === id ? '#6366f1' : '#3f3f46'}`,
                borderRadius: 6,
                padding: '7px 10px',
                cursor: disabled || off ? 'not-allowed' : 'pointer',
                textAlign: 'left',
                opacity: off ? 0.45 : 1,
                transition: 'background 0.15s, border-color 0.15s',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ color: method === id ? '#e0e7ff' : '#d4d4d8', fontSize: 13 }}>{t(`method.${id}`)}</span>
                {id === 'temporal' && (
                  <span style={{ color: '#818cf8', background: '#312e81', borderRadius: 3, fontSize: 9, padding: '1px 4px', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                    {t('method.temporalBeta')}
                  </span>
                )}
              </div>
              <div style={{ color: '#71717a', fontSize: 11, marginTop: 1 }}>
                {/* A greyed-out method has to say why, or it reads as a bug. */}
                {off && temporal.reasonKey ? t(temporal.reasonKey) : t(`method.${id}Description`)}
              </div>
            </button>
          );
        })}
      </div>

      {/* Method-specific controls */}
      <div className="flex flex-col gap-3 pt-1" style={{ borderTop: '1px solid #27272a' }}>
        {method === 'inpaint' && (
          <Slider
            label={t('params.radius')}
            value={radius}
            min={1} max={20}
            disabled={disabled}
            onChange={(v) => onChange({ radius: v })}
          />
        )}
        {method === 'blur' && (
          <Slider
            label={t('params.kernelSize')}
            value={kernelSize}
            min={3} max={99} step={2}
            disabled={disabled}
            onChange={(v) => onChange({ kernelSize: v % 2 === 0 ? v + 1 : v })}
          />
        )}
        {method === 'solidFill' && (
          <div className="flex flex-col gap-1">
            <span style={{ color: '#a1a1aa', fontSize: 11 }}>{t('params.color')}</span>
            <input
              type="color"
              disabled={disabled}
              value={`#${color.map((c) => c.toString(16).padStart(2, '0')).join('')}`}
              onChange={(e) => {
                const hex = e.target.value.slice(1);
                const r = parseInt(hex.slice(0,2), 16);
                const g = parseInt(hex.slice(2,4), 16);
                const b = parseInt(hex.slice(4,6), 16);
                onChange({ color: [r, g, b] });
              }}
              style={{ width: 40, height: 28, border: '1px solid #3f3f46', borderRadius: 4, background: 'none', cursor: disabled ? 'not-allowed' : 'pointer' }}
            />
          </div>
        )}
        {method === 'temporal' && (
          <>
            <div className="flex flex-col gap-1">
              <span style={{ color: '#a1a1aa', fontSize: 11 }}>{t('params.temporalQuality')}</span>
              <div style={{ display: 'flex', gap: 4 }}>
                {TEMPORAL_QUALITIES.map((level) => (
                  <button
                    key={level}
                    data-testid={`quality-${level}`}
                    disabled={disabled}
                    aria-pressed={temporalQuality === level}
                    onClick={() => !disabled && onChange({ temporalQuality: level })}
                    style={{
                      flex: 1,
                      background: temporalQuality === level ? '#312e81' : 'transparent',
                      border: `1px solid ${temporalQuality === level ? '#6366f1' : '#3f3f46'}`,
                      borderRadius: 4,
                      padding: '4px 0',
                      color: temporalQuality === level ? '#e0e7ff' : '#a1a1aa',
                      fontSize: 11,
                      cursor: disabled ? 'not-allowed' : 'pointer',
                    }}
                  >
                    {t(`quality.${level}`)}
                  </button>
                ))}
              </div>
            </div>
            {/* Slower by a lot, and worth it for the right footage: both
                halves of that belong on screen before the user starts. */}
            <p data-testid="temporal-note" style={{ color: '#a1a1aa', fontSize: 11, lineHeight: 1.5, background: '#1e1b4b', border: '1px solid #312e81', borderRadius: 4, padding: '6px 8px' }}>
              {t('method.temporalNote')}
            </p>
          </>
        )}
        {method === 'cloneStamp' && (
          <>
            <div className="flex flex-col gap-1">
              <span style={{ color: '#a1a1aa', fontSize: 11 }}>Source Offset X (px)</span>
              <input
                type="number"
                disabled={disabled}
                value={dx}
                onChange={(e) => onChange({ dx: parseInt(e.target.value) || 0 })}
                style={{ background: '#27272a', border: '1px solid #3f3f46', borderRadius: 4, padding: '4px 8px', color: '#f4f4f5', width: '100%', fontSize: 12 }}
              />
            </div>
            <div className="flex flex-col gap-1">
              <span style={{ color: '#a1a1aa', fontSize: 11 }}>Source Offset Y (px)</span>
              <input
                type="number"
                disabled={disabled}
                value={dy}
                onChange={(e) => onChange({ dy: parseInt(e.target.value) || 0 })}
                style={{ background: '#27272a', border: '1px solid #3f3f46', borderRadius: 4, padding: '4px 8px', color: '#f4f4f5', width: '100%', fontSize: 12 }}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
