/**
 * Asking the backend what is on the video, and holding the answer.
 *
 * The survey is a job like any other — it decodes frames and takes real time —
 * so it gets a hook of its own rather than being folded into loading. Two
 * things follow from that and are the reason this file exists.
 *
 * **It must never be able to break loading a video.** A survey that fails, or
 * that a main process is too old to run at all, leaves the app exactly where
 * it was before there was a survey: the user draws a box. So nothing here
 * reports an error upward, and everything it touches is its own state.
 *
 * **It must never outlive its video.** Job listeners are global — there is one
 * backend and one channel — so a survey still running when the user opens
 * another file would deliver that file's findings against this one's frame.
 * Each scan stamps the path it was started for and drops anything that comes
 * back for a different one.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Finding } from '../types';
import { NULL_SINK } from '../utils';

/**
 * How long to wait before giving up on a survey.
 *
 * Generous: it decodes the whole video at eight frames a second and solves
 * every region it finds, which on a long clip is minutes. Giving up only means
 * the list never appears, so the cost of waiting too long is a panel that
 * arrives late, and the cost of giving up too early is a feature that looks
 * broken on exactly the long videos it is most useful for.
 */
export const DETECT_TIMEOUT_MS = 10 * 60 * 1000;

export interface Detection {
  /** What the survey found, newest scan only. */
  findings: Finding[];
  /** Whether a scan is in flight. */
  scanning: boolean;
  /** How far along it is, 0–100. */
  progress: number;
  /** Whether the last scan ended without an answer. */
  failed: boolean;
  /** Survey `path`, replacing any scan already running. */
  scan: (path: string) => void;
  /** Forget the findings — called when the video changes. */
  clear: () => void;
}

export function useDetection(): Detection {
  const [findings, setFindings] = useState<Finding[]>([]);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [failed, setFailed] = useState(false);
  // The file the scan in flight belongs to. A ref rather than state: the
  // listeners below close over it, and they must read what is true when the
  // answer arrives, not what was true when they were attached.
  const scanningPath = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  useEffect(() => clearTimer, [clearTimer]);

  const clear = useCallback(() => {
    clearTimer();
    scanningPath.current = null;
    setFindings([]);
    setScanning(false);
    setProgress(0);
    setFailed(false);
  }, [clearTimer]);

  const finish = useCallback((result: Finding[] | null) => {
    clearTimer();
    scanningPath.current = null;
    setScanning(false);
    setProgress(0);
    if (result) setFindings(result);
    setFailed(result === null);
  }, [clearTimer]);

  const scan = useCallback((path: string) => {
    const api = window.electronAPI;
    // An older main process has no channel to answer on. Saying so by leaving
    // `failed` false and `findings` empty is the same as a survey that found
    // nothing, which is what the UI already knows how to show.
    if (!api.onFindings) return;

    scanningPath.current = path;
    setScanning(true);
    setFailed(false);
    setProgress(0);

    api.removeJobListeners();
    api.onJobProgress((value: number) => {
      if (scanningPath.current === path) setProgress(value);
    });
    api.onFindings((result: Finding[]) => {
      if (scanningPath.current !== path) return;
      api.removeJobListeners();
      finish(Array.isArray(result) ? result : []);
    });
    api.onJobError(() => {
      if (scanningPath.current !== path) return;
      api.removeJobListeners();
      finish(null);
    });

    clearTimer();
    timer.current = setTimeout(() => {
      if (scanningPath.current !== path) return;
      api.removeJobListeners();
      finish(null);
    }, DETECT_TIMEOUT_MS);

    void Promise.resolve(
      api.startJob({
        inputPath: path,
        outputPath: NULL_SINK,
        // The survey looks at the whole frame; the box is carried only because
        // the job schema has always had one.
        roi: { x: 0, y: 0, w: 1, h: 1 },
        method: 'recover',
        mode: 'detect',
      }),
    ).then((started) => {
      // Refused because something else holds the backend. Not an error worth
      // showing: the export the user started is what they asked for, and the
      // survey is what they did not.
      if (!started && scanningPath.current === path) {
        api.removeJobListeners();
        finish(null);
      }
    }).catch(() => {
      if (scanningPath.current === path) finish(null);
    });
  }, [clearTimer, finish]);

  return { findings, scanning, progress, failed, scan, clear };
}
