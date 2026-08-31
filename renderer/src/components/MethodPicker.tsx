/**
 * MethodPicker — sidebar control panel for removal algorithm and parameters.
 */
import type { RemovalMethod, TemporalQuality, VideoMeta } from '../types';
import type { Availability } from '../capabilities';
import { TEMPORAL_QUALITIES, PREVIEW_TEMPORAL_QUALITY, previewIsDowngraded } from '../capabilities';
import { estimateTemporalSeconds, formatEstimate } from '../estimate';
import { useTranslation } from '../hooks/useTranslation';

interface MethodPickerProps {
  method: RemovalMethod;
  /** Whether temporal fill should hand the job to the learned engine. */
  deepLearning: boolean;
  /** Whether this machine can run that engine, and why not if it cannot. */
  deep: Availability;
  /**
   * The preset the learned engine would actually run here — below the dial
   * where the card is too small for it. Null when nothing fits, which
   * `deep.available` has already ruled out.
   */
  deepPreset: TemporalQuality | null;
  radius: number;
  kernelSize: number;
  color: [number, number, number];
  dx: number;
  dy: number;
  temporalQuality: TemporalQuality;
  /** Whether this machine can run temporal inpainting, and why not if it cannot. */
  temporal: Availability;
  /** The loaded video, for the "how long will this take" forecast. Null before one is. */
  videoMeta: VideoMeta | null;
  /** Cores the frame pool will spread the work over, where the host said. */
  cpuCount?: number;
  /**
   * Seconds of video a preview will actually cover — already capped for this
   * method, since a temporal preview runs shorter than the dial offers. The
   * forecast has to price the run that will happen, not the one that was
   * asked for.
   */
  previewSeconds: number;
  disabled: boolean;
  onChange: (updates: Partial<{
    method: RemovalMethod;
    radius: number;
    kernelSize: number;
    color: [number, number, number];
    dx: number;
    dy: number;
    temporalQuality: TemporalQuality;
    deepLearning: boolean;
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
  deepLearning,
  deep,
  deepPreset,
  radius,
  kernelSize,
  color,
  dx,
  dy,
  temporalQuality,
  temporal,
  videoMeta,
  cpuCount,
  previewSeconds,
  disabled,
  onChange,
}: MethodPickerProps) {
  const { t } = useTranslation();

  /** A method can be off the table on its own account, not just because a job is running. */
  const unavailable = (id: RemovalMethod) => id === 'temporal' && !temporal.available;

  // Both forecasts come from the same model; they differ only in how much
  // video they cover and — because a preview is always run at the quick
  // setting — in which quality they price.
  // The switch only bites under temporal fill and only where the machine can
  // honour it; everywhere else the sidebar should describe the CPU engine.
  const usesDeep = method === 'temporal' && deepLearning && deep.available;

  const exportEstimate = videoMeta && formatEstimate(
    estimateTemporalSeconds({
      fps: videoMeta.fps,
      seconds: videoMeta.duration,
      quality: temporalQuality,
      cpuCount,
    }),
    t,
  );
  const previewEstimate = videoMeta && formatEstimate(
    estimateTemporalSeconds({
      fps: videoMeta.fps,
      seconds: previewSeconds,
      quality: PREVIEW_TEMPORAL_QUALITY,
      cpuCount,
    }),
    t,
  );

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
              title={
                off && temporal.reasonKey ? t(temporal.reasonKey)
                  : id === 'temporal' ? t('method.temporalTooltip')
                  : undefined
              }
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
                  <>
                    <span style={{ color: '#818cf8', background: '#312e81', borderRadius: 3, fontSize: 9, padding: '1px 4px', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                      {t('method.temporalBeta')}
                    </span>
                    {/* "Beta" says the feature is new; it does not say what it
                        does, and a method nobody understands is a method
                        nobody picks.

                        Marked aria-hidden and carrying no label of its own:
                        it sits inside the method button, and an accessible
                        name here would be concatenated into that button's,
                        announcing a paragraph where a name belongs. The
                        explanation reaches assistive tech as the button's own
                        description instead — see its `title` below, which
                        also makes the whole row hoverable, not just the
                        glyph. */}
                    <span
                      data-testid="temporal-info"
                      aria-hidden="true"
                      title={t('method.temporalTooltip')}
                      style={{ color: '#818cf8', fontSize: 11, cursor: 'help' }}
                    >
                      ⓘ
                    </span>
                  </>
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
            {/* What the choice above actually costs, in the only unit that
                helps someone decide whether to make it. Absent until a video
                is loaded, because until then there is nothing to forecast. */}
            {/* Whether the job goes to the graphics card. Under the quality
                dial, not beside the method: it is a second implementation of
                temporal fill, not a sixth method, and it reads the same
                quality setting. Greyed out with a reason where the machine
                cannot run it — a switch that does nothing is worse than one
                that is not offered. */}
            <label
              data-testid="deep-toggle"
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 8,
                cursor: disabled || !deep.available ? 'not-allowed' : 'pointer',
                opacity: deep.available ? 1 : 0.5,
              }}
              title={!deep.available && deep.reasonKey ? t(deep.reasonKey) : t('method.deepLearningHint')}
            >
              <input
                type="checkbox"
                checked={deepLearning && deep.available}
                disabled={disabled || !deep.available}
                onChange={(e) => onChange({ deepLearning: e.target.checked })}
                style={{ marginTop: 2, accentColor: '#6366f1' }}
              />
              <span style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ color: '#d4d4d8', fontSize: 12 }}>{t('method.deepLearning')}</span>
                  <span style={{ color: '#818cf8', background: '#312e81', borderRadius: 3, fontSize: 9, padding: '1px 4px', letterSpacing: '0.04em' }}>
                    {t('method.deepBadge')}
                  </span>
                </span>
                {/* A disabled switch has to say why, or it reads as a bug. */}
                {!deep.available && deep.reasonKey && (
                  <span data-testid="deep-reason" style={{ color: '#71717a', fontSize: 11 }}>
                    {t(deep.reasonKey)}
                  </span>
                )}
              </span>
            </label>

            {/* What the card will actually do with the setting above. Said
                before the run, not reported after it. */}
            {deepLearning && deep.available && deepPreset && deepPreset !== temporalQuality && (
              <p data-testid="deep-downgrade" style={{ color: '#a1a1aa', fontSize: 11 }}>
                {t('method.deepDowngrade', { quality: t(`quality.${deepPreset}`) })}
              </p>
            )}

            {deepLearning && deep.available && (
              <p data-testid="deep-note" style={{ color: '#a1a1aa', fontSize: 11, lineHeight: 1.5, background: '#1e1b4b', border: '1px solid #312e81', borderRadius: 4, padding: '6px 8px' }}>
                {t('method.deepNote')}
              </p>
            )}

            {/* The forecast below models the CPU engine, frame by frame over
                the core count. It says nothing useful about a run on a
                graphics card, and a wrong number is worse than none. */}
            {!usesDeep && exportEstimate && (
              <p data-testid="temporal-estimate" style={{ color: '#a1a1aa', fontSize: 11 }}>
                {t('estimate.export', { time: exportEstimate })}
                {previewEstimate && (
                  <>
                    {' · '}
                    {t('estimate.preview', { time: previewEstimate })}
                  </>
                )}
              </p>
            )}
            {/* The preview does not run at the setting above, and a preview
                that is quietly rougher than the export is a preview that
                misleads. Only shown when the two actually differ. */}
            {!usesDeep && previewIsDowngraded(method, temporalQuality) && (
              <p data-testid="temporal-preview-fast" style={{ color: '#a1a1aa', fontSize: 11 }}>
                {t('method.temporalPreviewFast', { quality: t(`quality.${PREVIEW_TEMPORAL_QUALITY}`) })}
              </p>
            )}
            {/* Slower by a lot, and worth it for the right footage: both
                halves of that belong on screen before the user starts. */}
            {usesDeep && (
              <p data-testid="deep-preview-fast" style={{ color: '#a1a1aa', fontSize: 11 }}>
                {t('method.deepPreviewFast')}
              </p>
            )}
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
