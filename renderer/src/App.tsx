// ─── Full App replaced by watermark-remover implementation ─────────────────
import { useCallback, useEffect, useRef, useState } from 'react';
import EmptyState from './components/EmptyState';
import VideoCanvas from './components/VideoCanvas';
import MethodPicker from './components/MethodPicker';
import ProgressPanel from './components/ProgressPanel';
import DonePanel from './components/DonePanel';
import PresetPicker from './components/PresetPicker';
import type { AppState, JobConfig, RemovalMethod, ROI, VideoMeta } from './types';
import { normalizeCoordinates, defaultOutputName, formatDuration, mediaUrl } from './utils';
import { classifyError, hasTechnicalDetail, OWN_MESSAGE_PREFIX, PREVIEW_TIMEOUT_MS } from './errors';
import type { FriendlyError } from './errors';
import { BUILT_IN_PRESETS, loadCustomPresets, saveCustomPresets, presetFromCurrent } from './presets';
import type { Preset, PresetParams } from './presets';
import { useHistory } from './hooks/useHistory';
import type { JobSettings } from './hooks/useHistory';
import { useKeyboardShortcuts, SHORTCUT_HINTS } from './hooks/useKeyboardShortcuts';
import { useTranslation } from './hooks/useTranslation';
import { LOCALES, LOCALE_NAMES } from './i18n';
import { estimateSecondsRemaining, recordSample } from './eta';
import { stageLabel, stageState } from './stages';
import type { ProgressSample } from './eta';

const SIDEBAR_W = 280;

function App() {
  const { t, locale, setLocale } = useTranslation();
  const [appState, setAppState] = useState<AppState>('empty');
  const [inputPath, setInputPath] = useState<string | null>(null);
  const [outputPath, setOutputPath] = useState<string | null>(null);
  const [previewFrameUrl, setPreviewFrameUrl] = useState<string | null>(null);
  const [previewClipUrl, setPreviewClipUrl] = useState<string | null>(null);
  const [videoMeta, setVideoMeta] = useState<VideoMeta | null>(null);
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ w: 800, h: 600 });
  const [canvasScale, setCanvasScale] = useState(1);
  const [canvasROI, setCanvasROI] = useState<ROI>({ x: 0, y: 0, w: 200, h: 100 });
  const [method, setMethod] = useState<RemovalMethod>('inpaint');
  const [radius, setRadius] = useState(3);
  const [kernelSize, setKernelSize] = useState(51);
  const [color, setColor] = useState<[number, number, number]>([0, 0, 0]);
  const [dx, setDx] = useState(0);
  const [dy, setDy] = useState(-50);
  const [progress, setProgress] = useState(0);
  const [stateLabel, setStateLabel] = useState('');
  const [error, setError] = useState<FriendlyError>({ key: null, raw: '' });
  const [doneOutputPath, setDoneOutputPath] = useState('');
  const [updateReady, setUpdateReady] = useState<string | null>(null);
  const [copiedDetail, setCopiedDetail] = useState(false);
  const [customPresets, setCustomPresets] = useState<Preset[]>(() => loadCustomPresets());
  const [samples, setSamples] = useState<ProgressSample[]>([]);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** One place to fail: keeps the raw text for a report, shows plain language. */
  const failWith = useCallback((raw: string) => {
    setError(classifyError(raw));
    setAppState('error');
    setCopiedDetail(false);
    window.electronAPI.removeJobListeners();
  }, []);

  const clearPreviewTimer = useCallback(() => {
    if (previewTimer.current) {
      clearTimeout(previewTimer.current);
      previewTimer.current = null;
    }
  }, []);

  useEffect(() => clearPreviewTimer, [clearPreviewTimer]);

  useEffect(() => {
    const update = () => {
      if (canvasContainerRef.current) {
        setContainerSize({ w: canvasContainerRef.current.offsetWidth, h: canvasContainerRef.current.offsetHeight });
      }
    };
    update();
    const ro = new ResizeObserver(update);
    if (canvasContainerRef.current) ro.observe(canvasContainerRef.current);
    return () => ro.disconnect();
  }, []);

  // Drop any IPC listeners still attached when the app unmounts
  useEffect(() => () => window.electronAPI.removeJobListeners(), []);

  // A downloaded update installs on the user's say-so, never mid-export.
  useEffect(() => {
    window.electronAPI.onUpdateDownloaded((version) => setUpdateReady(version ?? ''));
  }, []);

  const handleSelectFile = useCallback(async () => {
    const path = await window.electronAPI.openFile();
    if (!path) return;
    setInputPath(path);
    // Auto-derive default output path alongside the input file
    const dir = path.split(/[\\/]/).slice(0, -1).join('/');
    setOutputPath(dir + '/' + defaultOutputName(path));
    setPreviewFrameUrl(null);
    setPreviewClipUrl(null);
    setVideoMeta(null);
    // Opening a file is two ffmpeg calls on a file that may be very large.
    // Saying which one is running is the difference between a wait and a
    // hang, so the loading canvas follows the backend's stages.
    setStateLabel(stageState('probing'));
    setAppState('loaded');
    // Request preview frame extraction from the backend
    window.electronAPI.removeJobListeners();
    window.electronAPI.onJobMeta((meta) => { setVideoMeta(meta); });
    window.electronAPI.onJobState(setStateLabel);
    window.electronAPI.onPreviewReady((previewPath: string) => {
      clearPreviewTimer();
      setPreviewFrameUrl(mediaUrl(previewPath));
      setStateLabel('');
      window.electronAPI.removeJobListeners();
    });
    window.electronAPI.onJobError((msg: string) => {
      // Without this the canvas sits on "Loading preview…" forever whenever
      // the backend fails to produce the still.
      clearPreviewTimer();
      failWith(msg);
    });

    // A backend that never answers would leave the spinner running for good.
    clearPreviewTimer();
    previewTimer.current = setTimeout(
      () => failWith(`${OWN_MESSAGE_PREFIX}errors.previewTimeout`),
      PREVIEW_TIMEOUT_MS,
    );
    window.electronAPI.startJob({
      inputPath: path, outputPath: '/dev/null',
      roi: { x: 0, y: 0, w: 1, h: 1 },
      method: 'inpaint', mode: 'preview_frame',
    });
  }, [failWith, clearPreviewTimer]);

  const handleSelectOutput = useCallback(async () => {
    if (!inputPath) return;
    const path = await window.electronAPI.saveFile(defaultOutputName(inputPath));
    if (path) setOutputPath(path);
  }, [inputPath]);

  const registerJobListeners = useCallback(() => {
    window.electronAPI.removeJobListeners();
    window.electronAPI.onJobProgress((value) => {
      setProgress(value);
      setSamples((prev) => recordSample(prev, value, Date.now()));
    });
    window.electronAPI.onJobState(setStateLabel);
    window.electronAPI.onJobDone((finalPath) => {
      // Prefer the path the backend actually wrote; fall back to the requested one.
      const written = finalPath ?? outputPath ?? '';
      setDoneOutputPath(written);
      setProgress(100);
      setAppState('done');
      // A long export usually finishes while the user is in another window.
      if (written) {
        void window.electronAPI.notify(
          t('notifications.exportDoneTitle'),
          t('notifications.exportDoneBody', { name: written.split(/[\\/]/).pop() ?? '' }),
        );
      }
      // Surface the result straight away — the DonePanel's Reveal button is
      // there for a second look.
      if (written) window.electronAPI.openPath(written);
      window.electronAPI.removeJobListeners();
    });
    window.electronAPI.onJobError(failWith);
  }, [outputPath, failWith, t]);

  const handleExport = useCallback(async () => {
    if (!inputPath) return;
    let out = outputPath;
    if (!out) {
      out = await window.electronAPI.saveFile(defaultOutputName(inputPath));
      if (!out) return;
      setOutputPath(out);
    }
    const videoROI = normalizeCoordinates(canvasROI.x, canvasROI.y, canvasROI.w, canvasROI.h, canvasScale);
    const payload: JobConfig = { inputPath, outputPath: out, roi: videoROI, method, mode: 'full', radius, kernelSize, color, dx, dy };
    setProgress(0); setStateLabel(''); setSamples([]); setAppState('processing');
    registerJobListeners();
    const started = await window.electronAPI.startJob(payload);
    if (!started) {
      // Refused because another job holds the backend; don't sit in a
      // "processing" state that nothing will ever complete.
      failWith(`${OWN_MESSAGE_PREFIX}errors.jobRunning`);
    }
  }, [inputPath, outputPath, canvasROI, canvasScale, method, radius, kernelSize, color, dx, dy, registerJobListeners, failWith]);

  const handlePreview = useCallback(async () => {
    if (!inputPath) return;
    const videoROI = normalizeCoordinates(canvasROI.x, canvasROI.y, canvasROI.w, canvasROI.h, canvasScale);
    // outputPath is passed as placeholder; backend generates its own temp file for the preview clip
    const payload: JobConfig = { inputPath, outputPath: outputPath ?? '/dev/null', roi: videoROI, method, mode: 'preview', radius, kernelSize, color, dx, dy };
    setProgress(0); setStateLabel(stageState('preparingPreview')); setSamples([]); setAppState('processing');
    window.electronAPI.removeJobListeners();
    window.electronAPI.onJobProgress((value) => {
      setProgress(value);
      setSamples((prev) => recordSample(prev, value, Date.now()));
    });
    window.electronAPI.onJobState(setStateLabel);
    window.electronAPI.onPreviewReady((clipPath: string) => {
      setPreviewClipUrl(mediaUrl(clipPath));
      setAppState('loaded');
      window.electronAPI.removeJobListeners();
    });
    window.electronAPI.onJobError(failWith);
    const started = await window.electronAPI.startJob(payload);
    if (!started) {
      failWith(`${OWN_MESSAGE_PREFIX}errors.jobRunning`);
    }
  }, [inputPath, outputPath, canvasROI, canvasScale, method, radius, kernelSize, color, dx, dy, failWith]);

  const handleCancel = useCallback(async () => {
    await window.electronAPI.cancelJob();
    window.electronAPI.removeJobListeners();
    setAppState('loaded'); setProgress(0); setStateLabel('');
  }, []);

  const handleMethodChange = useCallback((updates: Partial<{ method: RemovalMethod; radius: number; kernelSize: number; color: [number,number,number]; dx: number; dy: number }>) => {
    if (updates.method !== undefined) setMethod(updates.method);
    if (updates.radius !== undefined) setRadius(updates.radius);
    if (updates.kernelSize !== undefined) setKernelSize(updates.kernelSize);
    if (updates.color !== undefined) setColor(updates.color);
    if (updates.dx !== undefined) setDx(updates.dx);
    if (updates.dy !== undefined) setDy(updates.dy);
  }, []);

  // ── Undo / redo over the settings that define a job ───────────────────
  const params: PresetParams = { radius, kernelSize, color, dx, dy };
  const settings: JobSettings = { roi: canvasROI, method, params };
  const history = useHistory(settings);

  const applySettings = useCallback((next: JobSettings) => {
    setCanvasROI(next.roi);
    setMethod(next.method);
    setRadius(next.params.radius);
    setKernelSize(next.params.kernelSize);
    setColor(next.params.color);
    setDx(next.params.dx);
    setDy(next.params.dy);
  }, []);

  // Settle before recording: a drag or a slider sweep is one edit, not fifty.
  const { push: pushHistory } = history;
  useEffect(() => {
    const timer = setTimeout(() => pushHistory({ roi: canvasROI, method, params: { radius, kernelSize, color, dx, dy } }), 400);
    return () => clearTimeout(timer);
  }, [canvasROI, method, radius, kernelSize, color, dx, dy, pushHistory]);

  const handleUndo = useCallback(() => {
    const previous = history.undo();
    if (previous) applySettings(previous);
  }, [history, applySettings]);

  const handleRedo = useCallback(() => {
    const next = history.redo();
    if (next) applySettings(next);
  }, [history, applySettings]);

  // ── Presets ───────────────────────────────────────────────────────────
  const presets = [...BUILT_IN_PRESETS, ...customPresets];

  const applyPreset = useCallback((preset: Preset) => {
    setMethod(preset.method);
    setRadius(preset.params.radius);
    setKernelSize(preset.params.kernelSize);
    setColor(preset.params.color);
    setDx(preset.params.dx);
    setDy(preset.params.dy);
  }, []);

  const saveCurrentPreset = useCallback((name: string) => {
    setCustomPresets((prev) => {
      const next = [...prev, presetFromCurrent(name, method, { radius, kernelSize, color, dx, dy })];
      saveCustomPresets(next);
      return next;
    });
  }, [method, radius, kernelSize, color, dx, dy]);

  const deletePreset = useCallback((id: string) => {
    setCustomPresets((prev) => {
      const next = prev.filter((p) => p.id !== id);
      saveCustomPresets(next);
      return next;
    });
  }, []);

  /** Which preset the current settings match, so the picker can show it. */
  const activePresetId = presets.find((p) =>
    p.method === method &&
    p.params.radius === radius &&
    p.params.kernelSize === kernelSize &&
    p.params.dx === dx &&
    p.params.dy === dy &&
    p.params.color[0] === color[0] && p.params.color[1] === color[1] && p.params.color[2] === color[2]
  )?.id ?? null;

  const isLoaded = appState === 'loaded';
  const isProcessing = appState === 'processing';
  const canExport = isLoaded && !!inputPath;

  const [namingPreset, setNamingPreset] = useState(false);

  useKeyboardShortcuts({
    onExport: () => { if (canExport) void handleExport(); },
    onPreview: () => { if (canExport) void handlePreview(); },
    onCancel: () => { if (isProcessing) void handleCancel(); },
    onUndo: handleUndo,
    onRedo: handleRedo,
    onSavePreset: () => { if (isLoaded) setNamingPreset(true); },
    onSelectMethod: (next) => { if (isLoaded) setMethod(next); },
  }, appState !== 'empty');

  const secondsRemaining = estimateSecondsRemaining(samples);

  return (
    <div className="app-shell" style={{ display: 'flex', width: '100%', height: '100%', background: '#18181b' }}>
      {/* Sidebar */}
      <div className="app-sidebar" style={{ width: SIDEBAR_W, minWidth: SIDEBAR_W, background: '#27272a', borderRight: '1px solid #3f3f46', display: 'flex', flexDirection: 'column', padding: 24, gap: 20, overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <p style={{ color: '#f4f4f5', fontSize: 14, fontWeight: 500 }}>{t('app.title')}</p>
          <select
            data-testid="language-select"
            aria-label={t('app.language')}
            value={locale}
            onChange={(e) => setLocale(e.target.value as typeof locale)}
            style={{
              background: '#18181b', color: '#a1a1aa', border: '1px solid #3f3f46',
              borderRadius: 4, fontSize: 11, padding: '2px 4px', cursor: 'pointer',
            }}
          >
            {LOCALES.map((code) => (
              <option key={code} value={code}>{LOCALE_NAMES[code]}</option>
            ))}
          </select>
        </div>

        {appState === 'empty' && (
          <button
            data-testid="btn-load-video"
            onClick={handleSelectFile}
            style={{ background: '#6366f1', border: 'none', borderRadius: 6, padding: '8px 0', color: '#fff', fontSize: 13, fontWeight: 500, cursor: 'pointer' }}
          >
            {t('file.load')}
          </button>
        )}

        {updateReady !== null && !isProcessing && (
          <div data-testid="update-banner" style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 6, padding: '8px 12px', color: '#cbd5e1', fontSize: 12 }}>
            {updateReady
              ? t('status.updateReady', { version: updateReady })
              : t('status.updateReadyNoVersion')}
            <button
              data-testid="install-update"
              onClick={() => window.electronAPI.installUpdate()}
              style={{ display: 'block', marginTop: 6, background: 'none', border: 'none', color: '#818cf8', cursor: 'pointer', fontSize: 11, textDecoration: 'underline', padding: 0 }}
            >
              {t('actions.restartAndInstall')}
            </button>
          </div>
        )}

        {isProcessing && (
          <ProgressPanel
            progress={progress}
            stateLabel={stateLabel}
            secondsRemaining={secondsRemaining}
            onCancel={handleCancel}
          />
        )}

        {appState === 'done' && (
          <DonePanel outputPath={doneOutputPath} onReveal={() => window.electronAPI.openPath(doneOutputPath)} onReset={() => setAppState('loaded')} />
        )}

        {appState === 'error' && (
          <div data-testid="error-panel" style={{ background: '#450a0a', border: '1px solid #b91c1c', borderRadius: 6, padding: '8px 12px', color: '#fca5a5', fontSize: 12 }}>
            {error.key ? t(error.key) : error.raw}
            <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
              <button data-testid="dismiss-error" onClick={() => setAppState('loaded')} style={{ background: 'none', border: 'none', color: '#f87171', cursor: 'pointer', fontSize: 11, textDecoration: 'underline', padding: 0 }}>{t('actions.dismiss')}</button>
              {hasTechnicalDetail(error) && (
                <button
                  data-testid="copy-error"
                  onClick={() => {
                    // Clipboard access can be refused; the button must not throw.
                    void navigator.clipboard?.writeText(error.raw)
                      .then(() => setCopiedDetail(true))
                      .catch(() => setCopiedDetail(false));
                  }}
                  style={{ background: 'none', border: 'none', color: '#f87171', cursor: 'pointer', fontSize: 11, textDecoration: 'underline', padding: 0 }}
                >
                  {copiedDetail ? t('actions.copied') : t('actions.copyDetails')}
                </button>
              )}
            </div>
          </div>
        )}

        {isLoaded && (
          <>
            {inputPath && videoMeta && (
              <div style={{ borderBottom: '1px solid #3f3f46', paddingBottom: 12 }}>
                <p style={{ color: '#f4f4f5', fontSize: 12, wordBreak: 'break-all' }}>{inputPath.split(/[\\/]/).pop()}</p>
                <p style={{ color: '#71717a', fontSize: 11, marginTop: 3 }}>{videoMeta.width}×{videoMeta.height} · {Math.round(videoMeta.fps)}fps · {formatDuration(videoMeta.duration)}</p>
              </div>
            )}

            <PresetPicker
              presets={presets}
              activeId={activePresetId}
              disabled={!isLoaded}
              onApply={applyPreset}
              onDelete={deletePreset}
              naming={namingPreset}
              onNamingChange={setNamingPreset}
              onSaveCurrent={saveCurrentPreset}
            />

            <MethodPicker method={method} radius={radius} kernelSize={kernelSize} color={color} dx={dx} dy={dy} disabled={!isLoaded} onChange={handleMethodChange} />

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <p style={{ color: '#a1a1aa', fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{t('file.output')}</p>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <p style={{ color: outputPath ? '#d4d4d8' : '#52525b', fontSize: 11, flex: 1, wordBreak: 'break-all' }}>{outputPath ? outputPath.split(/[\\/]/).pop() : t('file.notSet')}</p>
                <button data-testid="browse-output" onClick={handleSelectOutput} style={{ background: 'transparent', border: '1px solid #3f3f46', borderRadius: 6, padding: '4px 10px', color: '#a1a1aa', fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap' }}>{t('file.browse')}</button>
              </div>
            </div>

            {/* Shortcuts are worth nothing if nobody can find them. */}
            <details data-testid="shortcut-hints" style={{ marginTop: 4 }}>
              <summary style={{ color: '#71717a', fontSize: 11, cursor: 'pointer', listStyle: 'none' }}>
                {t('shortcuts.heading')}
              </summary>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 6 }}>
                {SHORTCUT_HINTS.map((hint) => (
                  <div key={hint.keys} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ color: '#71717a', fontSize: 10 }}>{t(hint.labelKey)}</span>
                    <span style={{ color: '#a1a1aa', fontSize: 10, fontVariantNumeric: 'tabular-nums' }}>{hint.keys}</span>
                  </div>
                ))}
              </div>
            </details>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 'auto' }}>
              <button data-testid="btn-preview" onClick={handlePreview} disabled={!canExport} style={{ background: 'transparent', border: `1px solid ${canExport ? '#3f3f46' : '#27272a'}`, borderRadius: 6, padding: '7px 0', color: canExport ? '#d4d4d8' : '#52525b', fontSize: 12, cursor: canExport ? 'pointer' : 'not-allowed' }}>{t('actions.preview')}</button>
              <button data-testid="btn-export" onClick={() => { void handleExport(); }} disabled={!canExport} style={{ background: canExport ? '#6366f1' : '#312e81', border: 'none', borderRadius: 6, padding: '8px 0', color: canExport ? '#fff' : '#4338ca', fontSize: 13, fontWeight: 500, cursor: canExport ? 'pointer' : 'not-allowed' }}>{t('actions.export')}</button>
            </div>
          </>
        )}
      </div>

      {/* Canvas */}
      <div ref={canvasContainerRef} className="app-canvas" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#000', overflow: 'hidden', position: 'relative' }}>
        {appState === 'empty' && <EmptyState onSelectFile={handleSelectFile} />}

        {appState !== 'empty' && previewFrameUrl && !previewClipUrl && (
          <VideoCanvas previewSrc={previewFrameUrl} containerWidth={containerSize.w} containerHeight={containerSize.h} onScaleChange={setCanvasScale} onROIChange={setCanvasROI} />
        )}

        {previewClipUrl && (
          <div style={{ position: 'absolute', inset: 0, background: '#000', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', zIndex: 10 }}>
            <video src={previewClipUrl} autoPlay controls loop style={{ maxWidth: '100%', maxHeight: 'calc(100% - 44px)', outline: 'none' }} />
            <button onClick={() => setPreviewClipUrl(null)} style={{ marginTop: 10, background: 'rgba(39,39,42,0.9)', border: '1px solid #3f3f46', borderRadius: 6, padding: '5px 16px', color: '#d4d4d8', fontSize: 11, cursor: 'pointer' }}>{t('file.closePreview')}</button>
          </div>
        )}

        {appState !== 'empty' && !previewFrameUrl && (
          <div style={{ color: '#52525b', fontSize: 12, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
            <div style={{ width: 24, height: 24, border: '2px solid #52525b', borderTopColor: '#6366f1', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
            <span data-testid="loading-stage">
              {stateLabel ? stageLabel(stateLabel, t) : t('file.loadingPreview')}
            </span>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          </div>
        )}

        {appState !== 'empty' && (
          <button data-testid="change-video" onClick={handleSelectFile} style={{ position: 'absolute', top: 12, right: 12, background: 'rgba(39,39,42,0.85)', border: '1px solid #3f3f46', borderRadius: 6, padding: '5px 12px', color: '#d4d4d8', fontSize: 11, cursor: 'pointer' }}>{t('file.change')}</button>
        )}
      </div>
    </div>
  );
}

export default App;

