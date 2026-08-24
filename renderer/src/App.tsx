// ─── Full App replaced by watermark-remover implementation ─────────────────
import { useCallback, useEffect, useRef, useState } from 'react';
import EmptyState from './components/EmptyState';
import VideoCanvas from './components/VideoCanvas';
import MethodPicker from './components/MethodPicker';
import ProgressPanel from './components/ProgressPanel';
import DonePanel from './components/DonePanel';
import type { AppState, JobConfig, RemovalMethod, ROI } from './types';
import { normalizeCoordinates, defaultOutputName, formatDuration } from './utils';

const SIDEBAR_W = 280;

function App() {
  const [appState, setAppState] = useState<AppState>('empty');
  const [inputPath, setInputPath] = useState<string | null>(null);
  const [outputPath, setOutputPath] = useState<string | null>(null);
  const [previewFrameUrl, setPreviewFrameUrl] = useState<string | null>(null);
  const [previewClipUrl, setPreviewClipUrl] = useState<string | null>(null);
  const [videoMeta, setVideoMeta] = useState<{ width: number; height: number; fps: number; duration: number } | null>(null);
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
  const [errorMsg, setErrorMsg] = useState('');
  const [doneOutputPath, setDoneOutputPath] = useState('');

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
    setAppState('loaded');
    // Request preview frame extraction from the backend
    window.electronAPI.removeJobListeners();
    window.electronAPI.onJobMeta((meta) => { setVideoMeta(meta); });
    window.electronAPI.onPreviewReady((previewPath: string) => {
      setPreviewFrameUrl(`file://${previewPath}`);
      window.electronAPI.removeJobListeners();
    });
    window.electronAPI.onJobError(() => { window.electronAPI.removeJobListeners(); });
    window.electronAPI.startJob({
      inputPath: path, outputPath: '/dev/null',
      roi: { x: 0, y: 0, w: 1, h: 1 },
      method: 'inpaint', mode: 'preview_frame',
    });
  }, []);

  const handleSelectOutput = useCallback(async () => {
    if (!inputPath) return;
    const path = await window.electronAPI.saveFile(defaultOutputName(inputPath));
    if (path) setOutputPath(path);
  }, [inputPath]);

  const registerJobListeners = useCallback(() => {
    window.electronAPI.removeJobListeners();
    window.electronAPI.onJobProgress(setProgress);
    window.electronAPI.onJobState(setStateLabel);
    window.electronAPI.onJobDone(() => {
      setDoneOutputPath(outputPath ?? '');
      setAppState('done');
      window.electronAPI.removeJobListeners();
    });
    window.electronAPI.onJobError((msg: string) => {
      setErrorMsg(msg);
      setAppState('error');
      window.electronAPI.removeJobListeners();
    });
  }, [outputPath]);

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
    setProgress(0); setStateLabel(''); setAppState('processing');
    registerJobListeners();
    await window.electronAPI.startJob(payload);
  }, [inputPath, outputPath, canvasROI, canvasScale, method, radius, kernelSize, color, dx, dy, registerJobListeners]);

  const handlePreview = useCallback(async () => {
    if (!inputPath) return;
    const videoROI = normalizeCoordinates(canvasROI.x, canvasROI.y, canvasROI.w, canvasROI.h, canvasScale);
    // outputPath is passed as placeholder; backend generates its own temp file for the preview clip
    const payload: JobConfig = { inputPath, outputPath: outputPath ?? '/dev/null', roi: videoROI, method, mode: 'preview', radius, kernelSize, color, dx, dy };
    setProgress(0); setStateLabel('Generating 3s preview…'); setAppState('processing');
    window.electronAPI.removeJobListeners();
    window.electronAPI.onJobProgress(setProgress);
    window.electronAPI.onJobState(setStateLabel);
    window.electronAPI.onPreviewReady((clipPath: string) => {
      setPreviewClipUrl(`file://${clipPath}`);
      setAppState('loaded');
      window.electronAPI.removeJobListeners();
    });
    window.electronAPI.onJobError((msg: string) => { setErrorMsg(msg); setAppState('error'); window.electronAPI.removeJobListeners(); });
    await window.electronAPI.startJob(payload);
  }, [inputPath, outputPath, canvasROI, canvasScale, method, radius, kernelSize, color, dx, dy]);

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

  const isLoaded = appState === 'loaded';
  const isProcessing = appState === 'processing';
  const canExport = isLoaded && !!inputPath;

  return (
    <div style={{ display: 'flex', width: '100%', height: '100%', background: '#18181b' }}>
      {/* Sidebar */}
      <div style={{ width: SIDEBAR_W, minWidth: SIDEBAR_W, background: '#27272a', borderRight: '1px solid #3f3f46', display: 'flex', flexDirection: 'column', padding: 24, gap: 20, overflowY: 'auto' }}>
        <p style={{ color: '#f4f4f5', fontSize: 14, fontWeight: 500 }}>Watermark Remover</p>

        {isProcessing && <ProgressPanel progress={progress} stateLabel={stateLabel} onCancel={handleCancel} />}

        {appState === 'done' && (
          <DonePanel outputPath={doneOutputPath} onReveal={() => window.electronAPI.openPath(doneOutputPath)} onReset={() => setAppState('loaded')} />
        )}

        {appState === 'error' && (
          <div data-testid="error-panel" style={{ background: '#450a0a', border: '1px solid #b91c1c', borderRadius: 6, padding: '8px 12px', color: '#fca5a5', fontSize: 12 }}>
            <strong>Error: </strong>{errorMsg}
            <br />
            <button data-testid="dismiss-error" onClick={() => setAppState('loaded')} style={{ marginTop: 8, background: 'none', border: 'none', color: '#f87171', cursor: 'pointer', fontSize: 11, textDecoration: 'underline' }}>Dismiss</button>
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

            <MethodPicker method={method} radius={radius} kernelSize={kernelSize} color={color} dx={dx} dy={dy} disabled={!isLoaded} onChange={handleMethodChange} />

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <p style={{ color: '#a1a1aa', fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Output</p>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <p style={{ color: outputPath ? '#d4d4d8' : '#52525b', fontSize: 11, flex: 1, wordBreak: 'break-all' }}>{outputPath ? outputPath.split(/[\\/]/).pop() : 'Not set'}</p>
                <button data-testid="browse-output" onClick={handleSelectOutput} style={{ background: 'transparent', border: '1px solid #3f3f46', borderRadius: 6, padding: '4px 10px', color: '#a1a1aa', fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap' }}>Browse</button>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 'auto' }}>
              <button data-testid="btn-preview" onClick={handlePreview} disabled={!canExport} style={{ background: 'transparent', border: `1px solid ${canExport ? '#3f3f46' : '#27272a'}`, borderRadius: 6, padding: '7px 0', color: canExport ? '#d4d4d8' : '#52525b', fontSize: 12, cursor: canExport ? 'pointer' : 'not-allowed' }}>Preview (3s)</button>
              <button data-testid="btn-export" onClick={handleExport} disabled={!canExport} style={{ background: canExport ? '#6366f1' : '#312e81', border: 'none', borderRadius: 6, padding: '8px 0', color: canExport ? '#fff' : '#4338ca', fontSize: 13, fontWeight: 500, cursor: canExport ? 'pointer' : 'not-allowed' }}>Export</button>
            </div>
          </>
        )}
      </div>

      {/* Canvas */}
      <div ref={canvasContainerRef} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#000', overflow: 'hidden', position: 'relative' }}>
        {appState === 'empty' && <EmptyState onSelectFile={handleSelectFile} />}

        {appState !== 'empty' && previewFrameUrl && !previewClipUrl && (
          <VideoCanvas previewSrc={previewFrameUrl} containerWidth={containerSize.w} containerHeight={containerSize.h} onScaleChange={setCanvasScale} onROIChange={setCanvasROI} />
        )}

        {previewClipUrl && (
          <div style={{ position: 'absolute', inset: 0, background: '#000', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', zIndex: 10 }}>
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video src={previewClipUrl} autoPlay controls loop style={{ maxWidth: '100%', maxHeight: 'calc(100% - 44px)', outline: 'none' }} />
            <button onClick={() => setPreviewClipUrl(null)} style={{ marginTop: 10, background: 'rgba(39,39,42,0.9)', border: '1px solid #3f3f46', borderRadius: 6, padding: '5px 16px', color: '#d4d4d8', fontSize: 11, cursor: 'pointer' }}>Close preview</button>
          </div>
        )}

        {appState !== 'empty' && !previewFrameUrl && (
          <div style={{ color: '#52525b', fontSize: 12, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
            <div style={{ width: 24, height: 24, border: '2px solid #52525b', borderTopColor: '#6366f1', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
            <span>Loading preview…</span>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          </div>
        )}

        {appState !== 'empty' && (
          <button data-testid="change-video" onClick={handleSelectFile} style={{ position: 'absolute', top: 12, right: 12, background: 'rgba(39,39,42,0.85)', border: '1px solid #3f3f46', borderRadius: 6, padding: '5px 12px', color: '#d4d4d8', fontSize: 11, cursor: 'pointer' }}>Change video</button>
        )}
      </div>
    </div>
  );
}

export default App;

