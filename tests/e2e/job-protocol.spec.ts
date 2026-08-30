/**
 * E2E: job stdout protocol
 *
 * Launches Electron against a stand-in Python backend (fixtures/fake_backend.py)
 * so the main-process parser — progress, state, meta, preview, done and cancel —
 * can be verified without ffmpeg or the real pipeline.
 */
import { test, expect } from './fixtures/stub-backend-fixture';
import type { Page } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';

test.use({ appTag: 'job-protocol' });

/** Collect every job event the renderer receives into window.__events. */
async function startCollecting(page: Page) {
  await page.evaluate(() => {
    const api = (window as any).electronAPI;
    api.removeJobListeners();
    const events: Array<{ type: string; value: unknown }> = [];
    (window as any).__events = events;
    api.onJobProgress((v: number) => events.push({ type: 'progress', value: v }));
    api.onJobState((v: string) => events.push({ type: 'state', value: v }));
    api.onJobMeta((v: object) => events.push({ type: 'meta', value: v }));
    api.onPreviewReady((v: string) => events.push({ type: 'preview', value: v }));
    api.onJobError((v: string) => events.push({ type: 'error', value: v }));
    api.onJobDone((v: string | null) => events.push({ type: 'done', value: v }));
    api.onTemporalFallback((v: object) => events.push({ type: 'temporal-fallback', value: v }));
  });
}

function events(page: Page) {
  return page.evaluate(() => (window as any).__events as Array<{ type: string; value: unknown }>);
}

function startJob(page: Page, payload: object) {
  return page.evaluate((p) => (window as any).electronAPI.startJob(p), payload);
}

test.describe('job stdout protocol', () => {
  test('forwards meta, progress and state, then done with the backend output path', async ({ page }) => {
    await startCollecting(page);
    await startJob(page, { scenario: 'success', outputPath: '/tmp/protocol-out.mp4' });

    await page.waitForFunction(
      () => (window as any).__events.some((e: any) => e.type === 'done'),
      { timeout: 10_000 },
    );
    const received = await events(page);

    expect(received.find((e) => e.type === 'meta')?.value).toMatchObject({ width: 640, height: 480 });
    expect(received.find((e) => e.type === 'progress')?.value).toBe(50);
    // Stages cross the protocol as keys; the renderer owns the wording.
    expect(received.find((e) => e.type === 'state')?.value).toBe('stage:processing');
    // job:done carries the path the backend reported, not just the requested one
    expect(received.find((e) => e.type === 'done')?.value).toBe('/tmp/protocol-out.mp4');
    expect(received.some((e) => e.type === 'error')).toBe(false);
  });

  test('parses a message split across two stdout chunks', async ({ page }) => {
    await startCollecting(page);
    await startJob(page, { scenario: 'split_line', outputPath: '/tmp/split-out.mp4' });

    await page.waitForFunction(
      () => (window as any).__events.some((e: any) => e.type === 'done'),
      { timeout: 10_000 },
    );
    const received = await events(page);
    expect(received.find((e) => e.type === 'progress')?.value).toBe(73.5);
  });

  test('preview_ready is delivered on its own channel', async ({ page }) => {
    await startCollecting(page);
    await startJob(page, { scenario: 'preview', outputPath: '/tmp/preview-frame.png' });

    await page.waitForFunction(
      () => (window as any).__events.some((e: any) => e.type === 'preview'),
      { timeout: 10_000 },
    );
    const received = await events(page);
    expect(received.find((e) => e.type === 'preview')?.value).toBe('/tmp/preview-frame.png');
    // A preview line must not also surface as a generic state label
    expect(received.some((e) => e.type === 'state')).toBe(false);
  });

  test('an ERROR line is reported once, not doubled by the non-zero exit', async ({ page }) => {
    await startCollecting(page);
    await startJob(page, { scenario: 'error', outputPath: '/tmp/err.mp4' });

    await page.waitForFunction(
      () => (window as any).__events.some((e: any) => e.type === 'error'),
      { timeout: 10_000 },
    );
    await page.waitForTimeout(500); // allow a duplicate to arrive if the guard fails
    const received = await events(page);
    const errors = received.filter((e) => e.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].value).toBe('Something went wrong in the backend');
    expect(received.some((e) => e.type === 'done')).toBe(false);
  });

  test('the count of frames that could not be rebuilt arrives on its own channel', async ({ page }) => {
    // It must not come through job:state: that channel is the status line,
    // and the raw protocol text would be shown to the user as prose.
    await startCollecting(page);
    await startJob(page, { scenario: 'temporal_fallback', outputPath: '/tmp/temporal-out.mp4' });

    await page.waitForFunction(
      () => (window as any).__events.some((e: any) => e.type === 'done'),
      { timeout: 10_000 },
    );
    const received = await events(page);

    expect(received.find((e) => e.type === 'temporal-fallback')?.value)
      .toEqual({ degraded: 7, total: 90 });
    // Parsed into numbers on its own channel, and never leaked to the status line.
    expect(received.some(
      (e) => e.type === 'state' && String(e.value).includes('temporal_fallback'),
    )).toBe(false);
  });

  test('a finished preview job does not report itself as a completed export', async ({ page }) => {
    // A preview finishing late used to fire job:done, flipping the UI to
    // "Export complete" with the preview's own output path.
    await startCollecting(page);
    await startJob(page, { mode: 'preview', outputPath: '/tmp/preview-clip.mp4' });

    await page.waitForFunction(
      () => (window as any).__events.some((e: any) => e.type === 'preview'),
      { timeout: 10_000 },
    );
    await page.waitForTimeout(500); // let the process exit land

    const received = await events(page);
    expect(received.some((e) => e.type === 'done')).toBe(false);
    expect(received.some((e) => e.type === 'error')).toBe(false);
  });

  test('a preview_frame job does not report itself as a completed export', async ({ page }) => {
    await startCollecting(page);
    await startJob(page, { mode: 'preview_frame', outputPath: '/dev/null' });

    await page.waitForFunction(
      () => (window as any).__events.some((e: any) => e.type === 'preview'),
      { timeout: 10_000 },
    );
    await page.waitForTimeout(500);

    expect((await events(page)).some((e) => e.type === 'done')).toBe(false);
  });

  test('cancel stops the job without emitting done or error', async ({ page }) => {
    await startCollecting(page);
    await startJob(page, { scenario: 'hang', outputPath: '/tmp/hang.mp4' });
    await page.waitForTimeout(500);

    const cancelled = await page.evaluate(() => (window as any).electronAPI.cancelJob());
    expect(cancelled).toBe(true);

    await page.waitForTimeout(1_000);
    const received = await events(page);
    expect(received.some((e) => e.type === 'done')).toBe(false);
    expect(received.some((e) => e.type === 'error')).toBe(false);

    // The cancelled process was reaped, so a new job can start
    const started = await startJob(page, { scenario: 'success', outputPath: '/tmp/after-cancel.mp4' });
    expect(started).toBe(true);
    await page.waitForFunction(
      () => (window as any).__events.some((e: any) => e.type === 'done'),
      { timeout: 10_000 },
    );
  });

  test('a second export is refused while one is running', async ({ page }) => {
    await startCollecting(page);
    expect(await startJob(page, { scenario: 'hang', outputPath: '/tmp/hang.mp4' })).toBe(true);
    expect(await startJob(page, { scenario: 'success', outputPath: '/tmp/second.mp4' })).toBe(false);
    await page.evaluate(() => (window as any).electronAPI.cancelJob());
  });

  // ── Lifetime of the temp files the backend leaves behind ──────────────
  //
  // The still is what the canvas draws from, for as long as the video stays
  // loaded. The clip is watched once and replaced. Deleting them on the same
  // schedule cost the canvas its image the moment the user asked for a
  // preview, leaving a blank stage after they closed the clip.

  test('the preview still survives the next job', async ({ page }) => {
    // Where fixtures/fake_backend.py writes its still.
    const still = path.join(os.tmpdir(), 'fake_backend_frame.png');

    await startCollecting(page);
    await startJob(page, { mode: 'preview_frame', outputPath: '/dev/null' });
    await page.waitForFunction(
      () => (window as any).__events.some((e: any) => e.type === 'preview'),
      { timeout: 10_000 },
    );
    expect(fs.existsSync(still)).toBe(true);

    await startJob(page, { scenario: 'success', mode: 'full', outputPath: '/tmp/after-still.mp4' });
    await page.waitForFunction(
      () => (window as any).__events.some((e: any) => e.type === 'done'),
      { timeout: 10_000 },
    );

    // The canvas re-reads this path whenever it remounts.
    expect(fs.existsSync(still)).toBe(true);
  });

  test('a preview clip is cleaned up when the next job starts', async ({ page }) => {
    const clip = path.join(os.tmpdir(), `stub-preview-clip-${Date.now()}.mp4`);
    fs.writeFileSync(clip, 'not really a video');

    await startCollecting(page);
    // The stub reports outputPath as the clip it produced.
    await startJob(page, { mode: 'preview', outputPath: clip });
    await page.waitForFunction(
      () => (window as any).__events.some((e: any) => e.type === 'preview'),
      { timeout: 10_000 },
    );

    await startJob(page, { scenario: 'success', mode: 'full', outputPath: '/tmp/after-clip.mp4' });
    await page.waitForFunction(
      () => (window as any).__events.some((e: any) => e.type === 'done'),
      { timeout: 10_000 },
    );

    expect(fs.existsSync(clip)).toBe(false);
  });

  test('an export supersedes a preview that is still running', async ({ page }) => {
    // The app starts a preview probe by itself on file load. If the user hits
    // Export while it is still going, the export must win — refusing it
    // silently reads as a dead button.
    await startCollecting(page);
    expect(await startJob(page, { scenario: 'hang', mode: 'preview_frame', outputPath: '/dev/null' })).toBe(true);

    const started = await startJob(page, {
      scenario: 'success', mode: 'full', outputPath: '/tmp/export-wins.mp4',
    });
    expect(started).toBe(true);

    await page.waitForFunction(
      () => (window as any).__events.some((e: any) => e.type === 'done'),
      { timeout: 10_000 },
    );
    const received = await events(page);
    // The completion belongs to the export, not the preview it replaced
    expect(received.find((e) => e.type === 'done')?.value).toBe('/tmp/export-wins.mp4');
    expect(received.some((e) => e.type === 'error')).toBe(false);
  });
});
