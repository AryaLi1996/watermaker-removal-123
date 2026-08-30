/**
 * E2E: the wm-media:// preview protocol
 *
 * Preview stills and clips used to reach the renderer as file:// URLs, which
 * only worked in development with webSecurity switched off. They now travel
 * over the app's own scheme, which serves the files the main process published
 * and nothing else.
 *
 * Status codes and range headers are checked from the main process: the page
 * is a different origin from the scheme, so a fetch() there would be a CORS
 * request, and adding the header to allow it would widen what the scheme
 * hands out for the sake of the test. The renderer's own view is covered by
 * loading a published still into an <img>, which needs no CORS.
 */
import { test, expect } from './fixtures/stub-backend-fixture';
import type { ElectronApplication, Page } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';

test.use({ appTag: 'media-protocol' });

/** Same URL the renderer builds — see `mediaUrl` in renderer/src/utils.ts. */
function mediaUrl(filePath: string): string {
  return `wm-media://file/${encodeURIComponent(filePath)}`;
}

type FetchResult = {
  status: number;
  contentType: string | null;
  contentRange: string | null;
  acceptRanges: string | null;
  bytes: number;
};

/** Request a URL from the main process, where the scheme has no origin rules. */
function fetchViaMain(
  app: ElectronApplication,
  url: string,
  headers: Record<string, string> = {},
): Promise<FetchResult> {
  return app.evaluate(async ({ net }, { u, h }) => {
    const res = await net.fetch(u, { headers: h });
    const body = await res.arrayBuffer();
    return {
      status: res.status,
      contentType: res.headers.get('content-type'),
      contentRange: res.headers.get('content-range'),
      acceptRanges: res.headers.get('accept-ranges'),
      bytes: body.byteLength,
    };
  }, { u: url, h: headers });
}

/** Run a stub job and resolve the preview path it publishes. */
async function publish(page: Page, payload: object): Promise<string> {
  await page.evaluate(() => {
    const api = (window as any).electronAPI;
    api.removeJobListeners();
    (window as any).__published = null;
    api.onPreviewReady((v: string) => { (window as any).__published = v; });
  });
  await page.evaluate((p) => (window as any).electronAPI.startJob(p), payload);
  await page.waitForFunction(() => (window as any).__published !== null, { timeout: 10_000 });
  return page.evaluate(() => (window as any).__published as string);
}

test.describe('wm-media:// preview protocol', () => {
  test('serves a published still, and the renderer can decode it', async ({ page, electronApp }) => {
    const still = await publish(page, {
      scenario: 'frame', mode: 'preview_frame', outputPath: '/dev/null',
    });
    expect(fs.existsSync(still)).toBe(true);

    const res = await fetchViaMain(electronApp, mediaUrl(still));
    expect(res.status).toBe(200);
    expect(res.contentType).toBe('image/png');
    expect(res.acceptRanges).toBe('bytes');
    expect(res.bytes).toBe(fs.statSync(still).size);

    // The point of the whole exercise: the page itself can display it.
    const size = await page.evaluate(async (url) => {
      const img = new Image();
      img.src = url;
      await img.decode();
      return { w: img.naturalWidth, h: img.naturalHeight };
    }, mediaUrl(still));
    expect(size).toEqual({ w: 1, h: 1 });
  });

  test('answers a range request, so a clip can be seeked and looped', async ({ page, electronApp }) => {
    const clip = path.join(os.tmpdir(), 'media-protocol-clip.mp4');
    fs.writeFileSync(clip, Buffer.alloc(2048, 7));
    await publish(page, { scenario: 'preview', outputPath: clip });

    const res = await fetchViaMain(electronApp, mediaUrl(clip), { Range: 'bytes=100-199' });
    expect(res.status).toBe(206);
    expect(res.contentType).toBe('video/mp4');
    expect(res.contentRange).toBe('bytes 100-199/2048');
    expect(res.bytes).toBe(100);

    // An open-ended range runs to the last byte.
    const tail = await fetchViaMain(electronApp, mediaUrl(clip), { Range: 'bytes=2040-' });
    expect(tail.status).toBe(206);
    expect(tail.contentRange).toBe('bytes 2040-2047/2048');
    expect(tail.bytes).toBe(8);
  });

  test('refuses a file it never published', async ({ page, electronApp }) => {
    // Published first, so the scheme is live and the refusal is about this path.
    await publish(page, { scenario: 'frame', mode: 'preview_frame', outputPath: '/dev/null' });

    const secret = path.join(os.tmpdir(), 'media-protocol-unpublished.txt');
    fs.writeFileSync(secret, 'not for the renderer');

    const res = await fetchViaMain(electronApp, mediaUrl(secret));
    expect(res.status).toBe(404);
    expect(res.bytes).toBe(0);

    // A path the app never handled at all is refused the same way.
    const etc = await fetchViaMain(electronApp, mediaUrl('/etc/hostname'));
    expect(etc.status).toBe(404);
  });
});
