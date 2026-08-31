// ─── Full App replaced by watermark-remover implementation ─────────────────
import { useCallback, useEffect, useRef, useState } from 'react';
import EmptyState from './components/EmptyState';
import VideoCanvas from './components/VideoCanvas';
import MethodPicker from './components/MethodPicker';
import ProgressPanel from './components/ProgressPanel';
import DonePanel from './components/DonePanel';
import TemporalFallbackNote from './components/TemporalFallbackNote';
import DeepNoticeNote from './components/DeepNoticeNote';
import PresetPicker from './components/PresetPicker';
import SubscriptionStatusBar from './components/SubscriptionStatusBar';
import SubscriptionPage from './pages/SubscriptionPage';
import SettingsPage from './pages/SettingsPage';
import type { AppState, DeepNotice, JobConfig, RemovalMethod, ROI, SystemInfo, TemporalFallback, TemporalQuality, VideoMeta } from './types';
import { deepAvailability, deepPresetFor, previewSecondsFor, qualityForJob, temporalAvailability, usesDeepEngine, TEMPORAL_PREVIEW_MAX_SECONDS } from './capabilities';
import type { Availability } from './capabilities';
import { normalizeCoordinates, defaultOutputName, formatDuration, mediaUrl, NULL_SINK } from './utils';
import { classifyError, hasTechnicalDetail, OWN_MESSAGE_PREFIX } from './errors';
import type { FriendlyError } from './errors';
import { BUILT_IN_PRESETS, loadCustomPresets, saveCustomPresets, presetFromCurrent } from './presets';
import type { Preset, PresetParams } from './presets';
import { useHistory } from './hooks/useHistory';
import type { JobSettings } from './hooks/useHistory';
import { useKeyboardShortcuts, SHORTCUT_HINTS } from './hooks/useKeyboardShortcuts';
import { useVideoLoader } from './hooks/useVideoLoader';
import { useTranslation } from './hooks/useTranslation';
import { useSubscription } from './hooks/useSubscription';
import { LOCALES, LOCALE_NAMES } from './i18n';
import { estimateSecondsRemaining, recordSample } from './eta';
import { stageLabel, stageState } from './stages';
import type { ProgressSample } from './eta';

const SIDEBAR_W = 280;

/** Which screen the top nav is showing. */
type Screen = 'editor' | 'subscription' | 'settings';

/** How a feature reads when the subscription, not the hardware, is what
 *  rules it out. Same shape the capability checks return. */
const LOCKED: Availability = { available: false, reasonKey: 'subscription.lockedFeature' };

/** The screens the top bar switches between, in the order they appear. */
const NAV_ITEMS: { id: Screen; labelKey: string }[] = [
  { id: 'editor', labelKey: 'subscription.navEditor' },
  { id: 'subscription', labelKey: 'subscription.nav' },
  { id: 'settings', labelKey: 'settings.nav' },
];

/** Preview clip lengths on offer, shortest (and cheapest) first. */
const PREVIEW_SECOND_OPTIONS = [
  { value: 1, labelKey: 'actions.preview1s' },
  { value: 3, labelKey: 'actions.preview3s' },
  { value: 5, labelKey: 'actions.preview5s' },
] as const;

function App() {
  const { t, locale, setLocale } = useTranslation();
  const subscription = useSubscription();
  const [screen, setScreen] = useState<Screen>('editor');
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
  const [selectedMethod, setMethod] = useState<RemovalMethod>('inpaint');
  const [radius, setRadius] = useState(3);
  const [kernelSize, setKernelSize] = useState(51);
  const [color, setColor] = useState<[number, number, number]>([0, 0, 0]);
  const [dx, setDx] = useState(0);
  const [dy, setDy] = useState(-50);
  const [temporalQuality, setTemporalQuality] = useState<TemporalQuality>('balanced');
  // Off by default: it needs a graphics card most machines do not have, and a
  // switch that silently falls back on every run is a switch that lies.
  const [selectedDeepLearning, setDeepLearning] = useState(false);
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [progress, setProgress] = useState(0);
  const [stateLabel, setStateLabel] = useState('');
  const [error, setError] = useState<FriendlyError>({ key: null, raw: '' });
  const [doneOutputPath, setDoneOutputPath] = useState('');
  // Frames the temporal engine could not rebuild, reported once at the end.
  // Null for every job that had nothing to report, which is nearly all of them.
  const [temporalFallback, setTemporalFallback] = useState<TemporalFallback | null>(null);
  const [deepNotice, setDeepNotice] = useState<DeepNotice | null>(null);
  const [updateReady, setUpdateReady] = useState<string | null>(null);
  const [copiedDetail, setCopiedDetail] = useState(false);
  const [customPresets, setCustomPresets] = useState<Preset[]>(() => loadCustomPresets());
  const [samples, setSamples] = useState<ProgressSample[]>([]);
  // How much of the video a preview covers. One second is the cheapest look
  // that still answers "is the mark gone?", so it stays the default; the
  // longer options cost proportionally more time to produce.
  const [previewSeconds, setPreviewSeconds] = useState(1);

  // A paid feature is off the table the same way an underpowered machine puts
  // one off the table: greyed out with the reason on the card, rather than a
  // control that accepts a click and then refuses the job.
  const { entitlements } = subscription;
  const temporal = entitlements.temporalFill ? temporalAvailability(systemInfo) : LOCKED;

  // The method and the engine a job would actually run. A trial can run out
  // with temporal fill selected, so the selection is read through what the
  // tier allows rather than written back to state — nothing to keep in sync,
  // and the choice returns intact if the user subscribes.
  const method: RemovalMethod = selectedMethod === 'temporal' && !temporal.available ? 'inpaint' : selectedMethod;
  const deepLearning = selectedDeepLearning && entitlements.deepLearning;

  // Whether the learned engine can run here, whether this job would use it,
  // and which preset it would run. All three follow from the switch, the
  // method and what the host reported about the graphics card, so they are
  // derived on every render rather than kept in state that could drift.
  const deep = entitlements.deepLearning ? deepAvailability(systemInfo) : LOCKED;
  const usesDeep = usesDeepEngine(method, deepLearning, systemInfo);
  const deepPreset = deepPresetFor(temporalQuality, systemInfo);
  // The preview length that will actually run: capped by the method first,
  // then by the tier. A free tier that asks for five seconds gets one, and
  // the control shows that rather than a number the app will not honour.
  const effectivePreviewSeconds = Math.min(previewSecondsFor(method, previewSeconds), entitlements.maxPreviewSeconds);

  /** One place to fail: keeps the raw text for a report, shows plain language. */
  const failWith = useCallback((raw: string) => {
    setError(classifyError(raw));
    setAppState('error');
    setCopiedDetail(false);
    window.electronAPI.removeJobListeners();
  }, []);

  // Opening a file is two ffmpeg calls on a file that may be very large, so
  // the wait reports where it is and can be retried rather than only failed.
  const loader = useVideoLoader({
    onMeta: setVideoMeta,
    onFrame: useCallback((framePath: string) => setPreviewFrameUrl(mediaUrl(framePath)), []),
    onError: failWith,
  });

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

  // What the machine can take on. Asked once: it cannot change while the app
  // is running, and until the answer arrives every method stays on offer.
  useEffect(() => {
    void window.electronAPI.systemInfo().then(setSystemInfo).catch(() => setSystemInfo(null));
  }, []);

  // A downloaded update installs on the user's say-so, never mid-export.
  useEffect(() => {
    window.electronAPI.onUpdateDownloaded((version) => setUpdateReady(version ?? ''));
  }, []);

  // The window is named in the language the user reads. Electron takes the
  // window title from the document, so setting it here is what renames the
  // window itself — no main-process round trip, and it follows the picker.
  useEffect(() => {
    document.title = t('app.name');
  }, [t]);

  /** Take a file from empty state to a frame on the canvas. */
  const startLoad = useCallback((path: string) => {
    setInputPath(path);
    // Auto-derive default output path alongside the input file
    const dir = path.split(/[\\/]/).slice(0, -1).join('/');
    setOutputPath(dir + '/' + defaultOutputName(path));
    setPreviewFrameUrl(null);
    setPreviewClipUrl(null);
    setVideoMeta(null);
    // The note describes the last job's frames, not this video's.
    setTemporalFallback(null); setDeepNotice(null);
    setAppState('loaded');
    loader.load(path);
  }, [loader]);

  const handleSelectFile = useCallback(async () => {
    const path = await window.electronAPI.openFile();
    if (!path) return;
    startLoad(path);
  }, [startLoad]);

  /** Try the same file again after a load that failed or timed out. */
  const handleRetryLoad = useCallback(() => {
    if (!loader.path) return;
    setError({ key: null, raw: '' });
    setPreviewFrameUrl(null);
    setAppState('loaded');
    loader.retry();
  }, [loader]);

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
    window.electronAPI.onTemporalFallback(setTemporalFallback);
    window.electronAPI.onDeepNotice(setDeepNotice);
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
    const payload: JobConfig = { inputPath, outputPath: out, roi: videoROI, method, mode: 'full', radius, kernelSize, color, dx, dy, temporalQuality, useDeepLearning: usesDeep };
    setProgress(0); setStateLabel(''); setSamples([]); setTemporalFallback(null); setDeepNotice(null); setAppState('processing');
    registerJobListeners();
    const started = await window.electronAPI.startJob(payload);
    if (!started) {
      // Refused because another job holds the backend; don't sit in a
      // "processing" state that nothing will ever complete.
      failWith(`${OWN_MESSAGE_PREFIX}errors.jobRunning`);
    }
  }, [inputPath, outputPath, canvasROI, canvasScale, method, radius, kernelSize, color, dx, dy, temporalQuality, usesDeep, registerJobListeners, failWith]);

  const handlePreview = useCallback(async () => {
    if (!inputPath) return;
    const videoROI = normalizeCoordinates(canvasROI.x, canvasROI.y, canvasROI.w, canvasROI.h, canvasScale);
    // outputPath is passed as placeholder; backend generates its own temp file for the preview clip
    // A temporal preview is cut down twice over, because both dimensions cost
    // the same per frame: shorter than the other methods run (`previewSecondsFor`,
    // capped in the backend too, so the length sent is the length that runs),
    // and at the quickest quality whatever the dial says (`qualityForJob`).
    // The export keeps both of the user's choices.
    const payload: JobConfig = { inputPath, outputPath: outputPath ?? NULL_SINK, roi: videoROI, method, mode: 'preview', radius, kernelSize, color, dx, dy, temporalQuality: qualityForJob(method, temporalQuality, true), useDeepLearning: usesDeep, previewSeconds: effectivePreviewSeconds };
    setProgress(0); setStateLabel(stageState('preparingPreview')); setSamples([]); setTemporalFallback(null); setDeepNotice(null); setAppState('processing');
    window.electronAPI.removeJobListeners();
    window.electronAPI.onJobProgress((value) => {
      setProgress(value);
      setSamples((prev) => recordSample(prev, value, Date.now()));
    });
    window.electronAPI.onJobState(setStateLabel);
    window.electronAPI.onTemporalFallback(setTemporalFallback);
    window.electronAPI.onDeepNotice(setDeepNotice);
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
  }, [inputPath, outputPath, canvasROI, canvasScale, method, radius, kernelSize, color, dx, dy, temporalQuality, usesDeep, effectivePreviewSeconds, failWith]);

  const handleCancel = useCallback(async () => {
    await window.electronAPI.cancelJob();
    window.electronAPI.removeJobListeners();
    setAppState('loaded'); setProgress(0); setStateLabel(''); setTemporalFallback(null); setDeepNotice(null);
  }, []);

  const handleMethodChange = useCallback((updates: Partial<{ method: RemovalMethod; radius: number; kernelSize: number; color: [number,number,number]; dx: number; dy: number; temporalQuality: TemporalQuality; deepLearning: boolean }>) => {
    // The note reports on the settings that produced the last preview, so
    // changing them makes it stale — and a stale one is worse than none,
    // because it blames a run the user can no longer see.
    if (updates.method !== undefined || updates.temporalQuality !== undefined
        || updates.deepLearning !== undefined) {
      setTemporalFallback(null); setDeepNotice(null);
    }
    if (updates.method !== undefined) setMethod(updates.method);
    if (updates.radius !== undefined) setRadius(updates.radius);
    if (updates.kernelSize !== undefined) setKernelSize(updates.kernelSize);
    if (updates.color !== undefined) setColor(updates.color);
    if (updates.dx !== undefined) setDx(updates.dx);
    if (updates.dy !== undefined) setDy(updates.dy);
    if (updates.temporalQuality !== undefined) setTemporalQuality(updates.temporalQuality);
    if (updates.deepLearning !== undefined) setDeepLearning(updates.deepLearning);
  }, []);

  // ── Undo / redo over the settings that define a job ───────────────────
  const params: PresetParams = { radius, kernelSize, color, dx, dy, temporalQuality };
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
    setTemporalQuality(next.params.temporalQuality);
  }, []);

  // Settle before recording: a drag or a slider sweep is one edit, not fifty.
  const { push: pushHistory } = history;
  useEffect(() => {
    const timer = setTimeout(() => pushHistory({ roi: canvasROI, method, params: { radius, kernelSize, color, dx, dy, temporalQuality } }), 400);
    return () => clearTimeout(timer);
  }, [canvasROI, method, radius, kernelSize, color, dx, dy, temporalQuality, pushHistory]);

  const handleUndo = useCallback(() => {
    const previous = history.undo();
    if (previous) applySettings(previous);
  }, [history, applySettings]);

  const handleRedo = useCallback(() => {
    const next = history.redo();
    if (next) applySettings(next);
  }, [history, applySettings]);

  // ── Presets ───────────────────────────────────────────────────────────
  // What this machine can actually run: a preset for a method that is greyed
  // out would apply a method the user cannot select or export with.
  const presets = [...BUILT_IN_PRESETS, ...customPresets]
    .filter((p) => p.method !== 'temporal' || temporal.available);

  const applyPreset = useCallback((preset: Preset) => {
    // Same staleness as a manual change: a preset replaces method and quality.
    setTemporalFallback(null); setDeepNotice(null);
    setMethod(preset.method);
    setRadius(preset.params.radius);
    setKernelSize(preset.params.kernelSize);
    setColor(preset.params.color);
    setDx(preset.params.dx);
    setDy(preset.params.dy);
    setTemporalQuality(preset.params.temporalQuality);
  }, []);

  const saveCurrentPreset = useCallback((name: string) => {
    setCustomPresets((prev) => {
      const next = [...prev, presetFromCurrent(name, method, { radius, kernelSize, color, dx, dy, temporalQuality })];
      saveCustomPresets(next);
      return next;
    });
  }, [method, radius, kernelSize, color, dx, dy, temporalQuality]);

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
    p.params.temporalQuality === temporalQuality &&
    p.params.color[0] === color[0] && p.params.color[1] === color[1] && p.params.color[2] === color[2]
  )?.id ?? null;

  const isLoaded = appState === 'loaded';
  const isProcessing = appState === 'processing';
  const canExport = isLoaded && !!inputPath;
  // Only a load that failed can be retried, and only the loader knows which
  // failure was its own — an export can fall over while a still is still
  // being decoded, and that is not a load to try again.
  const loadFailed = loader.failed && !previewFrameUrl;

  const [namingPreset, setNamingPreset] = useState(false);

  useKeyboardShortcuts({
    onExport: () => { if (canExport) void handleExport(); },
    onPreview: () => { if (canExport) void handlePreview(); },
    onCancel: () => { if (isProcessing) void handleCancel(); },
    onUndo: handleUndo,
    onRedo: handleRedo,
    onSavePreset: () => { if (isLoaded) setNamingPreset(true); },
    onSelectMethod: (next) => {
      if (!isLoaded) return;
      if (next === 'temporal' && !temporal.available) return;
      setMethod(next);
    },
  }, appState !== 'empty');

  const secondsRemaining = estimateSecondsRemaining(samples);

  return (
    <div className="app-shell" style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', background: 'var(--bg)' }}>
      {/* Top navigation: which screen, and the language the app speaks */}
      <div
        className="app-topbar"
        style={{
          display: 'flex', alignItems: 'center', gap: 16, padding: '0 14px', height: 40,
          background: 'var(--surface)', borderBottom: '1px solid var(--border)',
        }}
      >
        <p style={{ color: 'var(--text)', fontSize: 13, fontWeight: 500 }}>{t('app.name')}</p>
        <nav style={{ display: 'flex', gap: 4 }}>
          {NAV_ITEMS.map(({ id, labelKey }) => {
            const active = screen === id;
            return (
              <button
                key={id}
                data-testid={`nav-${id}`}
                aria-current={active ? 'page' : undefined}
                onClick={() => setScreen(id)}
                style={{
                  background: active ? 'var(--border)' : 'transparent', border: 'none', borderRadius: 6,
                  padding: '4px 12px', color: active ? 'var(--text)' : 'var(--text-muted)', fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                {t(labelKey)}
              </button>
            );
          })}
        </nav>
        <select
          data-testid="language-select"
          aria-label={t('app.language')}
          value={locale}
          onChange={(e) => setLocale(e.target.value as typeof locale)}
          style={{
            marginLeft: 'auto', background: 'var(--bg)', color: 'var(--text-muted)', border: '1px solid var(--border)',
            borderRadius: 4, fontSize: 11, padding: '2px 4px', cursor: 'pointer',
          }}
        >
          {LOCALES.map((code) => (
            <option key={code} value={code}>{LOCALE_NAMES[code]}</option>
          ))}
        </select>
      </div>

      {/* The editor stays mounted behind the subscription page: hiding it
          keeps the loaded video, the box the user drew and a running job. */}
      <div
        className="app-body"
        style={{ flex: 1, minHeight: 0, display: screen === 'editor' ? 'flex' : 'none' }}
      >
      {/* Sidebar */}
      <div className="app-sidebar" style={{ width: SIDEBAR_W, minWidth: SIDEBAR_W, background: 'var(--surface)', borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', padding: 24, gap: 20, overflowY: 'auto' }}>
        {appState === 'empty' && (
          <button
            data-testid="btn-load-video"
            onClick={handleSelectFile}
            style={{ background: 'var(--accent)', border: 'none', borderRadius: 6, padding: '8px 0', color: 'var(--accent-contrast)', fontSize: 13, fontWeight: 500, cursor: 'pointer' }}
          >
            {t('file.load')}
          </button>
        )}

        {updateReady !== null && !isProcessing && (
          <div data-testid="update-banner" style={{ background: 'var(--info-bg)', border: '1px solid var(--info-border)', borderRadius: 6, padding: '8px 12px', color: 'var(--info-text)', fontSize: 12 }}>
            {updateReady
              ? t('status.updateReady', { version: updateReady })
              : t('status.updateReadyNoVersion')}
            <button
              data-testid="install-update"
              onClick={() => window.electronAPI.installUpdate()}
              style={{ display: 'block', marginTop: 6, background: 'none', border: 'none', color: 'var(--accent-link)', cursor: 'pointer', fontSize: 11, textDecoration: 'underline', padding: 0 }}
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
          <DonePanel outputPath={doneOutputPath} temporalFallback={temporalFallback} deepNotice={deepNotice} onReveal={() => window.electronAPI.openPath(doneOutputPath)} onReset={() => { setTemporalFallback(null); setDeepNotice(null); setAppState('loaded'); }} />
        )}

        {appState === 'error' && (
          <div data-testid="error-panel" style={{ background: 'var(--danger-bg)', border: '1px solid var(--danger-border)', borderRadius: 6, padding: '8px 12px', color: 'var(--danger-text)', fontSize: 12 }}>
            {error.key ? t(error.key) : error.raw}
            <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
              {loadFailed ? (
                <button data-testid="retry-load-sidebar" onClick={handleRetryLoad} style={{ background: 'none', border: 'none', color: 'var(--danger-action)', cursor: 'pointer', fontSize: 11, textDecoration: 'underline', padding: 0 }}>{t('actions.retry')}</button>
              ) : (
                <button data-testid="dismiss-error" onClick={() => setAppState('loaded')} style={{ background: 'none', border: 'none', color: 'var(--danger-action)', cursor: 'pointer', fontSize: 11, textDecoration: 'underline', padding: 0 }}>{t('actions.dismiss')}</button>
              )}
              {hasTechnicalDetail(error) && (
                <button
                  data-testid="copy-error"
                  onClick={() => {
                    // Clipboard access can be refused; the button must not throw.
                    void navigator.clipboard?.writeText(error.raw)
                      .then(() => setCopiedDetail(true))
                      .catch(() => setCopiedDetail(false));
                  }}
                  style={{ background: 'none', border: 'none', color: 'var(--danger-action)', cursor: 'pointer', fontSize: 11, textDecoration: 'underline', padding: 0 }}
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
              <div style={{ borderBottom: '1px solid var(--border)', paddingBottom: 12 }}>
                <p style={{ color: 'var(--text)', fontSize: 12, wordBreak: 'break-all' }}>{inputPath.split(/[\\/]/).pop()}</p>
                <p style={{ color: 'var(--text-faint)', fontSize: 11, marginTop: 3 }}>{videoMeta.width}×{videoMeta.height} · {Math.round(videoMeta.fps)}fps · {formatDuration(videoMeta.duration)}</p>
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

            <MethodPicker method={method} deepLearning={deepLearning} deep={deep} deepPreset={deepPreset} radius={radius} kernelSize={kernelSize} color={color} dx={dx} dy={dy} temporalQuality={temporalQuality} temporal={temporal} videoMeta={videoMeta} cpuCount={systemInfo?.cpuCount} previewSeconds={effectivePreviewSeconds} disabled={!isLoaded} onChange={handleMethodChange} />

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <p style={{ color: 'var(--text-muted)', fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{t('file.output')}</p>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <p style={{ color: outputPath ? 'var(--text-secondary)' : 'var(--text-disabled)', fontSize: 11, flex: 1, wordBreak: 'break-all' }}>{outputPath ? outputPath.split(/[\\/]/).pop() : t('file.notSet')}</p>
                <button data-testid="browse-output" onClick={handleSelectOutput} style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 10px', color: 'var(--text-muted)', fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap' }}>{t('file.browse')}</button>
              </div>
            </div>

            {/* Shortcuts are worth nothing if nobody can find them. */}
            <details data-testid="shortcut-hints" style={{ marginTop: 4 }}>
              <summary style={{ color: 'var(--text-faint)', fontSize: 11, cursor: 'pointer', listStyle: 'none' }}>
                {t('shortcuts.heading')}
              </summary>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 6 }}>
                {SHORTCUT_HINTS.map((hint) => (
                  <div key={hint.keys} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ color: 'var(--text-faint)', fontSize: 10 }}>{t(hint.labelKey)}</span>
                    <span style={{ color: 'var(--text-muted)', fontSize: 10, fontVariantNumeric: 'tabular-nums' }}>{hint.keys}</span>
                  </div>
                ))}
              </div>
            </details>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 'auto' }}>
              {/* The cost of a preview is the length of the clip, so the
                  choice and its price sit next to the button that spends it. */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <label htmlFor="preview-seconds" style={{ color: 'var(--text-muted)', fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{t('actions.previewSeconds')}</label>
                  <select
                    id="preview-seconds"
                    data-testid="preview-seconds"
                    value={effectivePreviewSeconds}
                    disabled={!isLoaded}
                    onChange={(e) => setPreviewSeconds(Number(e.target.value))}
                    style={{
                      background: 'var(--bg)', color: 'var(--text-secondary)', border: '1px solid var(--border)',
                      borderRadius: 4, fontSize: 11, padding: '2px 4px', marginLeft: 'auto',
                      cursor: isLoaded ? 'pointer' : 'not-allowed',
                    }}
                  >
                    {PREVIEW_SECOND_OPTIONS.map(({ value, labelKey }) => (
                      <option
                        key={value}
                        value={value}
                        // Offering a length this method will not run would be
                        // a control that lies about what it does.
                        disabled={
                          (method === 'temporal' && value > TEMPORAL_PREVIEW_MAX_SECONDS)
                          || value > entitlements.maxPreviewSeconds
                        }
                      >
                        {t(labelKey)}
                      </option>
                    ))}
                  </select>
                </div>
                <p data-testid="preview-warning" style={{ color: 'var(--text-faint)', fontSize: 10 }}>{t('actions.previewWarning')}</p>
                {/* Why the longer options are greyed out, said where they are. */}
                {entitlements.maxPreviewSeconds < 5 && (
                  <p data-testid="preview-locked" style={{ color: 'var(--text-faint)', fontSize: 10 }}>{t('subscription.lockedPreview')}</p>
                )}
              </div>
              {/* A preview reports the same caveat, where it is cheapest to
                  act on: the export has not been started yet. */}
              <TemporalFallbackNote report={temporalFallback} />
              {/* Same place, same reasoning: the engine that ran is as much a
                  caveat on the preview as the frames that fell back. */}
              <DeepNoticeNote notice={deepNotice} />
              <button data-testid="btn-preview" onClick={handlePreview} disabled={!canExport} style={{ background: 'transparent', border: `1px solid ${canExport ? 'var(--border)' : 'var(--surface)'}`, borderRadius: 6, padding: '7px 0', color: canExport ? 'var(--text-secondary)' : 'var(--text-disabled)', fontSize: 12, cursor: canExport ? 'pointer' : 'not-allowed' }}>{t('actions.preview')}</button>
              <button data-testid="btn-export" onClick={() => { void handleExport(); }} disabled={!canExport} style={{ background: canExport ? 'var(--accent)' : 'var(--accent-soft)', border: 'none', borderRadius: 6, padding: '8px 0', color: canExport ? 'var(--accent-contrast)' : 'var(--accent-disabled-text)', fontSize: 13, fontWeight: 500, cursor: canExport ? 'pointer' : 'not-allowed' }}>{t('actions.export')}</button>
            </div>
          </>
        )}
      </div>

      {/* Canvas */}
      <div ref={canvasContainerRef} className="app-canvas" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--canvas-bg)', overflow: 'hidden', position: 'relative' }}>
        {appState === 'empty' && <EmptyState onSelectFile={handleSelectFile} />}

        {appState !== 'empty' && previewFrameUrl && !previewClipUrl && (
          <VideoCanvas previewSrc={previewFrameUrl} containerWidth={containerSize.w} containerHeight={containerSize.h} onScaleChange={setCanvasScale} onROIChange={setCanvasROI} />
        )}

        {previewClipUrl && (
          <div style={{ position: 'absolute', inset: 0, background: 'var(--canvas-bg)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', zIndex: 10 }}>
            <video src={previewClipUrl} autoPlay controls loop style={{ maxWidth: '100%', maxHeight: 'calc(100% - 44px)', outline: 'none' }} />
            <button onClick={() => setPreviewClipUrl(null)} style={{ marginTop: 10, background: 'var(--surface-translucent)', border: '1px solid var(--border)', borderRadius: 6, padding: '5px 16px', color: 'var(--text-secondary)', fontSize: 11, cursor: 'pointer' }}>{t('file.closePreview')}</button>
          </div>
        )}

        {/* A load that failed must not keep spinning: the canvas says so, and
            offers the one thing worth trying — the same file again. */}
        {loadFailed && (
          <div data-testid="load-failed" style={{ color: 'var(--canvas-text)', fontSize: 12, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: 24, textAlign: 'center' }}>
            <span>{t('file.loadFailed')}</span>
            {error.key && <span style={{ color: 'var(--canvas-text)', maxWidth: 360 }}>{t(error.key)}</span>}
            <button
              data-testid="retry-load"
              onClick={handleRetryLoad}
              style={{ background: 'var(--accent)', border: 'none', borderRadius: 6, padding: '6px 16px', color: 'var(--accent-contrast)', fontSize: 12, cursor: 'pointer' }}
            >
              {t('actions.retry')}
            </button>
          </div>
        )}

        {appState !== 'empty' && !previewFrameUrl && !loadFailed && (
          <div style={{ color: 'var(--canvas-text)', fontSize: 12, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
            <div style={{ width: 24, height: 24, border: '2px solid var(--canvas-text)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
            <span data-testid="loading-stage">
              {/* The canvas only ever shows a load; a running job reports
                  through the sidebar's progress panel. */}
              {loader.stage ? stageLabel(loader.stage, t) : t('file.loadingPreview')}
            </span>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          </div>
        )}

        {appState !== 'empty' && (
          <button data-testid="change-video" onClick={handleSelectFile} style={{ position: 'absolute', top: 12, right: 12, background: 'var(--surface-translucent)', border: '1px solid var(--border)', borderRadius: 6, padding: '5px 12px', color: 'var(--text-secondary)', fontSize: 11, cursor: 'pointer' }}>{t('file.change')}</button>
        )}
      </div>
      </div>

      {screen === 'subscription' && (
        <SubscriptionPage
          status={subscription.status}
          onSubscribe={subscription.subscribe}
          onCancelAutoRenew={subscription.cancelAutoRenew}
        />
      )}

      {screen === 'settings' && <SettingsPage systemInfo={systemInfo} />}

      <SubscriptionStatusBar
        status={subscription.status}
        loading={subscription.loading}
        onOpen={() => setScreen('subscription')}
      />
    </div>
  );
}

export default App;

