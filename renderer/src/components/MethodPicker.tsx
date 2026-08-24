/**
 * MethodPicker — sidebar control panel for removal algorithm and parameters.
 */
import type { RemovalMethod } from '../types';

interface MethodPickerProps {
  method: RemovalMethod;
  radius: number;
  kernelSize: number;
  color: [number, number, number];
  dx: number;
  dy: number;
  disabled: boolean;
  onChange: (updates: Partial<{
    method: RemovalMethod;
    radius: number;
    kernelSize: number;
    color: [number, number, number];
    dx: number;
    dy: number;
  }>) => void;
}

const METHODS: { id: RemovalMethod; label: string; description: string }[] = [
  { id: 'inpaint',    label: 'Smart Fill',   description: 'Reconstructs background (best for logos)' },
  { id: 'blur',       label: 'Blur',         description: 'Gaussian blur censor effect' },
  { id: 'solidFill',  label: 'Solid Color',  description: 'Paint a solid color over the area' },
  { id: 'cloneStamp', label: 'Clone Stamp',  description: 'Copy nearby pixels over the watermark' },
];

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
  disabled,
  onChange,
}: MethodPickerProps) {
  return (
    <div className="flex flex-col gap-4" style={{ opacity: disabled ? 0.5 : 1 }}>
      <p style={{ color: '#a1a1aa', fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
        Removal Method
      </p>

      <div className="flex flex-col gap-1">
        {METHODS.map((m) => (
          <button
            key={m.id}
            disabled={disabled}
            onClick={() => !disabled && onChange({ method: m.id })}
            style={{
              background: method === m.id ? '#312e81' : 'transparent',
              border: `1px solid ${method === m.id ? '#6366f1' : '#3f3f46'}`,
              borderRadius: 6,
              padding: '7px 10px',
              cursor: disabled ? 'not-allowed' : 'pointer',
              textAlign: 'left',
              transition: 'background 0.15s, border-color 0.15s',
            }}
          >
            <div style={{ color: method === m.id ? '#e0e7ff' : '#d4d4d8', fontSize: 13 }}>{m.label}</div>
            <div style={{ color: '#71717a', fontSize: 11, marginTop: 1 }}>{m.description}</div>
          </button>
        ))}
      </div>

      {/* Method-specific controls */}
      <div className="flex flex-col gap-3 pt-1" style={{ borderTop: '1px solid #27272a' }}>
        {method === 'inpaint' && (
          <Slider
            label="Smoothness (radius px)"
            value={radius}
            min={1} max={20}
            disabled={disabled}
            onChange={(v) => onChange({ radius: v })}
          />
        )}
        {method === 'blur' && (
          <Slider
            label="Blur Strength"
            value={kernelSize}
            min={3} max={99} step={2}
            disabled={disabled}
            onChange={(v) => onChange({ kernelSize: v % 2 === 0 ? v + 1 : v })}
          />
        )}
        {method === 'solidFill' && (
          <div className="flex flex-col gap-1">
            <span style={{ color: '#a1a1aa', fontSize: 11 }}>Fill Color</span>
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
