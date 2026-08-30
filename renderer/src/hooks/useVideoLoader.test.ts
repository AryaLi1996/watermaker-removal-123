/**
 * Unit tests for useVideoLoader — the wait between picking a file and seeing
 * a frame on the canvas.
 *
 * That wait is two ffmpeg calls on a file that may be several gigabytes, and
 * the complaint behind this hook is that it used to look like nothing was
 * happening. What is tested here is therefore not the happy path alone but
 * every way it can leave the user stuck: a backend that fails, one that never
 * answers, and one that is busy with something else.
 *
 * It sits beside the hook rather than in tests/unit/renderer because it
 * renders React, and only the renderer package has the testing library.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import { useVideoLoader } from './useVideoLoader';
import { PREVIEW_TIMEOUT_MS } from '../errors';
import { stageOf } from '../stages';
import type { JobConfig, VideoMeta } from '../types';

/** The bits of the preload bridge the hook uses, driven from the test. */
function fakeElectronAPI(startJob: () => boolean | Promise<boolean> = () => true) {
  const listeners: {
    meta?: (meta: VideoMeta) => void;
    state?: (label: string) => void;
    preview?: (path: string) => void;
    error?: (message: string) => void;
  } = {};

  const api = {
    jobs: [] as JobConfig[],
    listeners,
    removeJobListeners: vi.fn(() => {
      listeners.meta = undefined;
      listeners.state = undefined;
      listeners.preview = undefined;
      listeners.error = undefined;
    }),
    onJobMeta: (cb: (meta: VideoMeta) => void) => { listeners.meta = cb; },
    onJobState: (cb: (label: string) => void) => { listeners.state = cb; },
    onPreviewReady: (cb: (path: string) => void) => { listeners.preview = cb; },
    onJobError: (cb: (message: string) => void) => { listeners.error = cb; },
    startJob: vi.fn((payload: JobConfig) => {
      api.jobs.push(payload);
      return Promise.resolve(startJob());
    }),
  };

  (window as unknown as { electronAPI: unknown }).electronAPI = api;
  return api;
}

function callbacks() {
  return { onMeta: vi.fn(), onFrame: vi.fn(), onError: vi.fn() };
}

const META: VideoMeta = {
  width: 1920, height: 1080, fps: 30, duration: 12,
  videoCodec: 'h264', audioCodec: 'aac',
};

afterEach(() => {
  vi.useRealTimers();
});

describe('useVideoLoader', () => {
  let api: ReturnType<typeof fakeElectronAPI>;

  beforeEach(() => {
    api = fakeElectronAPI();
  });

  it('asks the backend for a still and says so before the backend answers', () => {
    const cbs = callbacks();
    const { result } = renderHook(() => useVideoLoader(cbs));

    act(() => result.current.load('/videos/holiday.mp4'));

    // The status line is up from the moment the dialog closes, not from
    // whenever the backend gets round to reporting its first stage.
    expect(result.current.loading).toBe(true);
    expect(stageOf(result.current.stage)).toBe('probing');
    expect(api.jobs).toHaveLength(1);
    expect(api.jobs[0]).toMatchObject({ inputPath: '/videos/holiday.mp4', mode: 'preview_frame' });
  });

  it('follows the stages the backend reports', () => {
    const cbs = callbacks();
    const { result } = renderHook(() => useVideoLoader(cbs));
    act(() => result.current.load('/videos/holiday.mp4'));

    act(() => api.listeners.state?.('stage:extractingStill'));
    expect(stageOf(result.current.stage)).toBe('extractingStill');
  });

  it('passes the metadata on as soon as it arrives, before the frame', () => {
    const cbs = callbacks();
    const { result } = renderHook(() => useVideoLoader(cbs));
    act(() => result.current.load('/videos/holiday.mp4'));

    act(() => api.listeners.meta?.(META));
    expect(cbs.onMeta).toHaveBeenCalledWith(META);
    // Still loading: the still is what ends the wait.
    expect(result.current.loading).toBe(true);
  });

  it('ends the wait when the still is ready', () => {
    const cbs = callbacks();
    const { result } = renderHook(() => useVideoLoader(cbs));
    act(() => result.current.load('/videos/holiday.mp4'));

    act(() => api.listeners.preview?.('/tmp/frame.png'));

    expect(cbs.onFrame).toHaveBeenCalledWith('/tmp/frame.png');
    expect(result.current.loading).toBe(false);
    expect(result.current.stage).toBe('');
  });

  it('reports a backend failure instead of spinning on', () => {
    const cbs = callbacks();
    const { result } = renderHook(() => useVideoLoader(cbs));
    act(() => result.current.load('/videos/holiday.mp4'));

    act(() => api.listeners.error?.('ffmpeg: Invalid data found when processing input'));

    expect(cbs.onError).toHaveBeenCalledWith('ffmpeg: Invalid data found when processing input');
    expect(result.current.loading).toBe(false);
    expect(result.current.failed).toBe(true);
  });

  it("does not call an export's failure its own", () => {
    // The app wires its own listeners for a job it starts; a failure there
    // reaches the loader through neither, so there is nothing to retry here.
    const cbs = callbacks();
    const { result } = renderHook(() => useVideoLoader(cbs));
    act(() => result.current.load('/videos/holiday.mp4'));
    act(() => api.listeners.preview?.('/tmp/frame.png'));

    expect(result.current.failed).toBe(false);
  });

  it('gives up on a backend that never answers', () => {
    vi.useFakeTimers();
    const cbs = callbacks();
    const { result } = renderHook(() => useVideoLoader(cbs));
    act(() => result.current.load('/videos/holiday.mp4'));

    act(() => { vi.advanceTimersByTime(PREVIEW_TIMEOUT_MS - 1); });
    expect(cbs.onError).not.toHaveBeenCalled();

    act(() => { vi.advanceTimersByTime(1); });
    expect(cbs.onError).toHaveBeenCalledWith(expect.stringContaining('errors.previewTimeout'));
    expect(result.current.loading).toBe(false);
  });

  it('does not fire the timeout once the frame has arrived', () => {
    vi.useFakeTimers();
    const cbs = callbacks();
    const { result } = renderHook(() => useVideoLoader(cbs));
    act(() => result.current.load('/videos/holiday.mp4'));
    act(() => api.listeners.preview?.('/tmp/frame.png'));

    act(() => { vi.advanceTimersByTime(PREVIEW_TIMEOUT_MS * 2); });
    expect(cbs.onError).not.toHaveBeenCalled();
  });

  it('says so when the backend is busy, rather than waiting out the timeout', async () => {
    api = fakeElectronAPI(() => false);
    const cbs = callbacks();
    const { result } = renderHook(() => useVideoLoader(cbs));

    act(() => result.current.load('/videos/holiday.mp4'));

    await waitFor(() => expect(cbs.onError).toHaveBeenCalledWith(expect.stringContaining('errors.jobRunning')));
    expect(result.current.loading).toBe(false);
  });

  it('retries the same file, so a failure costs no second trip to the dialog', () => {
    const cbs = callbacks();
    const { result } = renderHook(() => useVideoLoader(cbs));
    act(() => result.current.load('/videos/holiday.mp4'));
    act(() => api.listeners.error?.('ffmpeg: something went wrong'));

    act(() => result.current.retry());

    expect(api.jobs).toHaveLength(2);
    expect(api.jobs[1].inputPath).toBe('/videos/holiday.mp4');
    expect(result.current.loading).toBe(true);
    expect(result.current.failed).toBe(false);
    expect(stageOf(result.current.stage)).toBe('probing');
  });

  it('has nothing to retry before a file has been picked', () => {
    const cbs = callbacks();
    const { result } = renderHook(() => useVideoLoader(cbs));

    act(() => result.current.retry());
    expect(api.jobs).toHaveLength(0);
  });

  it('drops a pending timeout when the app goes away', () => {
    vi.useFakeTimers();
    const cbs = callbacks();
    const { result, unmount } = renderHook(() => useVideoLoader(cbs));
    act(() => result.current.load('/videos/holiday.mp4'));

    unmount();
    act(() => { vi.advanceTimersByTime(PREVIEW_TIMEOUT_MS * 2); });
    expect(cbs.onError).not.toHaveBeenCalled();
  });
});
