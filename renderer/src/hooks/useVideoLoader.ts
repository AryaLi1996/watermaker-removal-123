/**
 * Loading a video, from the file the user picked to the frame on the canvas.
 *
 * Between those two moments the backend probes the file and decodes a still —
 * two ffmpeg calls on a file that may be several gigabytes. That is the wait
 * people describe as "nothing happens", so the whole point of this hook is
 * that the wait is never silent: it holds the stage the backend is reporting,
 * gives up rather than spinning for ever, and remembers which file failed so
 * the UI can offer to try it again without making the user find it a second
 * time.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { VideoMeta } from '../types';
import { OWN_MESSAGE_PREFIX, PREVIEW_TIMEOUT_MS } from '../errors';
import { stageState } from '../stages';
import { NULL_SINK } from '../utils';

export interface VideoLoaderCallbacks {
  /** The probe results, as soon as they arrive — before the still is ready. */
  onMeta: (meta: VideoMeta) => void;
  /** The still the canvas draws, as a path on disk. */
  onFrame: (framePath: string) => void;
  /** Raw failure text, for the caller to classify and show. */
  onError: (raw: string) => void;
}

export interface VideoLoader {
  /** The file being loaded, or the last one that failed. */
  path: string | null;
  /** The backend's current state line, or '' when nothing is loading. */
  stage: string;
  /** Whether a load is in flight. */
  loading: boolean;
  /**
   * Whether the last load failed. Kept here rather than inferred from "no
   * frame on the canvas": a video whose still is still being decoded when an
   * export falls over has no frame either, and that failure is not a load's.
   */
  failed: boolean;
  /** Start loading `path`, replacing any load already running. */
  load: (path: string) => void;
  /** Load `path` again — what the retry button calls. */
  retry: () => void;
}

export function useVideoLoader({ onMeta, onFrame, onError }: VideoLoaderCallbacks): VideoLoader {
  const [path, setPath] = useState<string | null>(null);
  const [stage, setStage] = useState('');
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  // A load still running when the app closes would fire its timeout into a
  // component that is no longer there.
  useEffect(() => clearTimer, [clearTimer]);

  const fail = useCallback((raw: string) => {
    clearTimer();
    setLoading(false);
    setFailed(true);
    setStage('');
    onError(raw);
  }, [clearTimer, onError]);

  const load = useCallback((next: string) => {
    setPath(next);
    setLoading(true);
    setFailed(false);
    // Named from the first thing the backend does, so the canvas says what is
    // happening from the moment the file dialog closes rather than after the
    // backend has started and answered.
    setStage(stageState('probing'));

    const api = window.electronAPI;
    api.removeJobListeners();
    api.onJobMeta(onMeta);
    api.onJobState(setStage);
    api.onPreviewReady((framePath: string) => {
      clearTimer();
      setLoading(false);
      setStage('');
      api.removeJobListeners();
      onFrame(framePath);
    });
    api.onJobError((message: string) => {
      // Without this the canvas sits on a spinner for good whenever the
      // backend fails to produce the still.
      api.removeJobListeners();
      fail(message);
    });

    // A backend that never answers at all would leave it spinning just the same.
    clearTimer();
    timer.current = setTimeout(
      () => {
        api.removeJobListeners();
        fail(`${OWN_MESSAGE_PREFIX}errors.previewTimeout`);
      },
      PREVIEW_TIMEOUT_MS,
    );

    void Promise.resolve(
      api.startJob({
        inputPath: next,
        outputPath: NULL_SINK,
        roi: { x: 0, y: 0, w: 1, h: 1 },
        method: 'inpaint',
        mode: 'preview_frame',
      }),
    ).then((started) => {
      // Refused because an export holds the backend. Saying so beats a
      // spinner that runs until the timeout for a job that never started.
      if (!started) {
        api.removeJobListeners();
        fail(`${OWN_MESSAGE_PREFIX}errors.jobRunning`);
      }
    });
  }, [clearTimer, fail, onFrame, onMeta]);

  const retry = useCallback(() => {
    if (path) load(path);
  }, [path, load]);

  // A fresh object every render would make every caller that depends on the
  // loader re-create its own callbacks on every keystroke elsewhere in the app.
  return useMemo(
    () => ({ path, stage, loading, failed, load, retry }),
    [path, stage, loading, failed, load, retry],
  );
}
