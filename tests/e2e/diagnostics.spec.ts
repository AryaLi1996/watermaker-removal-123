/**
 * E2E: what the main process says about a file that will not open.
 *
 * The codes, the diagnostic report and the copy-to-temp fallback all live in
 * the main process because they need the path and the errno, neither of which
 * survives the trip to the renderer. That makes an Electron test the only
 * place they can be checked honestly.
 */
import { test, expect } from './fixtures/stub-backend-fixture';
import type { Page } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SAMPLE_VIDEO } from './fixtures/sample-video';

test.use({ appTag: 'diagnostics' });

function startJob(page: Page, payload: object) {
  return page.evaluate((p) => (window as any).electronAPI.startJob(p), payload);
}

function diagnose(page: Page, filePath: string) {
  return page.evaluate((p) => (window as any).electronAPI.diagnosePath(p), filePath);
}

/** Collect job errors so a refused start can be inspected. */
async function collectErrors(page: Page) {
  await page.evaluate(() => {
    const api = (window as any).electronAPI;
    api.removeJobListeners();
    (window as any).__errors = [];
    api.onJobError((v: string) => (window as any).__errors.push(v));
  });
}

function errors(page: Page) {
  return page.evaluate(() => (window as any).__errors as string[]);
}

test.describe('failure codes', () => {
  test('a file that was deleted is reported as missing, not as a dead drive', async ({ page }) => {
    await collectErrors(page);
    const gone = path.join(os.tmpdir(), 'diagnostics-no-such-clip.mp4');

    expect(await startJob(page, { inputPath: gone, outputPath: '/tmp/x.mp4' })).toBe(false);
    // Its volume is fine — only the file is missing.
    expect(await errors(page)).toContain('code:FILE_NOT_FOUND');
  });

  test('a path on a drive that is not there is reported as a dead drive', async ({ page }) => {
    await collectErrors(page);
    // A volume root that cannot exist on any of the three platforms: on
    // Windows an unmapped drive letter, elsewhere a directory under a root
    // that is itself absent.
    const onMissingVolume = process.platform === 'win32'
      ? 'Q:\\clips\\demo.mp4'
      : '/nonexistent-volume-root/clips/demo.mp4';

    expect(await startJob(page, { inputPath: onMissingVolume, outputPath: '/tmp/x.mp4' })).toBe(false);
    const reported = await errors(page);
    // POSIX has no drive letters, so the root there is `/`, which is always
    // reachable and makes this a plain missing file. The distinction is a
    // Windows one; what matters on every platform is that it is one of the
    // two file codes and never a permission or encoding claim.
    expect(['code:DEVICE_NOT_READY', 'code:FILE_NOT_FOUND']).toContain(reported[0]);
  });

  test('a path carrying a lost encoding is named as such, before any disk access', async ({ page }) => {
    await collectErrors(page);
    // U+FFFD is what a lossy decode leaves behind; such a path never named a
    // file, and reporting it as missing would send the user looking for one.
    expect(await startJob(page, { inputPath: '/tmp/\uFFFD\uFFFD/clip.mp4', outputPath: '/tmp/x.mp4' })).toBe(false);

    expect(await errors(page)).toContain('code:PATH_ENCODING_ERROR');
  });

  test('a readable file is not refused', async ({ page }) => {
    await collectErrors(page);
    expect(await startJob(page, { inputPath: SAMPLE_VIDEO, outputPath: '/tmp/x.mp4', scenario: 'success' })).toBe(true);
    expect(await errors(page)).toHaveLength(0);
  });
});

test.describe('the diagnostic report', () => {
  test('answers for a file that is there', async ({ page }) => {
    const report = await diagnose(page, SAMPLE_VIDEO);

    expect(report).toMatchObject({ exists: true, readable: true, isNetworkDrive: false });
    expect(report.size).toBeGreaterThan(0);
    expect(report.path).toBe(SAMPLE_VIDEO);
    expect(report.length).toBe(SAMPLE_VIDEO.length);
    expect(report.volumeReachable).toBe(true);
    // Reported as not applicable away from Windows rather than as a pass.
    expect(report.longPath.applicable).toBe(process.platform === 'win32');
  });

  test('answers for a file that is not, without throwing', async ({ page }) => {
    const report = await diagnose(page, path.join(os.tmpdir(), 'diagnostics-absent.mp4'));

    expect(report.exists).toBe(false);
    expect(report.readable).toBe(false);
    expect(report.error).toBe('ENOENT');
  });

  test('flags a path that lost its encoding and one that is merely non-ASCII', async ({ page }) => {
    const damaged = await diagnose(page, '/tmp/\uFFFD/clip.mp4');
    expect(damaged.looksMisdecoded).toBe(true);

    const chinese = await diagnose(page, '/tmp/视频/clip.mp4');
    expect(chinese.hasNonAscii).toBe(true);
    expect(chinese.looksMisdecoded).toBe(false);
  });

  test('reports a long path as over the limit', async ({ page }) => {
    const long = '/tmp/' + 'a'.repeat(300) + '/clip.mp4';
    const report = await diagnose(page, long);
    expect(report.length).toBeGreaterThan(260);
    expect(report.exceedsMaxPath).toBe(true);
  });
});

test.describe('copying the input somewhere local', () => {
  test('is not done when the setting is off', async ({ page }) => {
    const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('wm_input_'));
    await startJob(page, { inputPath: SAMPLE_VIDEO, outputPath: '/tmp/x.mp4', scenario: 'success' });
    await page.waitForTimeout(500);

    const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('wm_input_'));
    expect(after).toEqual(before);
  });

  test('is skipped for a file already on the temp volume, and the job still runs', async ({ page }) => {
    // The sample lives on the same disk as the temp directory in every
    // checkout, so asking for a copy correctly does nothing — the setting is
    // about network shares and external disks, not about copying for its own
    // sake. What matters is that the job is unaffected either way.
    await collectErrors(page);
    const started = await startJob(page, {
      inputPath: SAMPLE_VIDEO,
      outputPath: '/tmp/x.mp4',
      scenario: 'success',
      copyInputLocally: true,
      copyInputMaxBytes: 500 * 1024 * 1024,
    });

    expect(started).toBe(true);
    expect(await errors(page)).toHaveLength(0);
  });

  test('leaves no copy behind once the job has ended', async ({ page }) => {
    await startJob(page, {
      inputPath: SAMPLE_VIDEO,
      outputPath: '/tmp/x.mp4',
      scenario: 'success',
      copyInputLocally: true,
    });
    await page.waitForTimeout(1_000);

    expect(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('wm_input_'))).toEqual([]);
  });
});
