/**
 * The check that decides whether a release ships a working ffmpeg.
 *
 * From a Windows report: the shipped ffprobe.exe exited 4294967295 without a
 * word, because `where ffmpeg` had answered with a chocolatey shim and the
 * build copied that. Nothing on the build machine noticed — it had a working
 * ffmpeg on PATH and never ran the copy.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FFMPEG_LIBRARY_DLL,
  isVersionBanner,
  whyUnusable,
  librariesIn,
  bundleFfmpeg,
} from '../../../scripts/ffmpeg-bundle.js';

describe('spotting a copy that will not run', () => {
  it('accepts a binary that identifies itself', () => {
    const exec = vi.fn().mockReturnValue('ffprobe version 7.1 Copyright (c) the FFmpeg developers');
    expect(whyUnusable('/dist/ffprobe', 'ffprobe', exec)).toBeNull();
  });

  it('rejects the reported failure: it runs, says nothing, and exits', () => {
    // A chocolatey shim outside chocolatey, and a shared build with no
    // libraries, both fail exactly this way.
    const exec = vi.fn().mockImplementation(() => {
      const err = new Error('Command failed') as Error & { status: number };
      err.status = 4294967295;
      throw err;
    });

    const reason = whyUnusable('/dist/ffprobe.exe', 'ffprobe', exec);

    expect(reason).toContain('exited with status 4294967295');
  });

  it('rejects something that runs but is not the tool', () => {
    const exec = vi.fn().mockReturnValue('Microsoft Windows [Version 10.0]');
    expect(whyUnusable('/dist/ffprobe.exe', 'ffprobe', exec)).toContain('launcher');
  });

  it('rejects a binary that cannot be executed at all', () => {
    const exec = vi.fn().mockImplementation(() => { throw new Error('spawn EACCES'); });
    expect(whyUnusable('/dist/ffmpeg', 'ffmpeg', exec)).toContain('could not be run');
  });

  it('does not mistake ffmpeg for ffprobe', () => {
    const exec = vi.fn().mockReturnValue('ffmpeg version 7.1');
    expect(whyUnusable('/dist/ffprobe', 'ffprobe', exec)).not.toBeNull();
  });

  it('reads a banner whatever its case', () => {
    expect(isVersionBanner('FFprobe Version 7.1', 'ffprobe')).toBe(true);
    expect(isVersionBanner('', 'ffprobe')).toBe(false);
    expect(isVersionBanner(undefined, 'ffprobe')).toBe(false);
  });
});

describe('the libraries a shared build needs beside it', () => {
  it('takes ffmpeg’s own libraries', () => {
    for (const name of [
      'avcodec-61.dll', 'avformat-61.dll', 'avutil-59.dll',
      'swresample-5.dll', 'swscale-8.dll', 'avfilter-10.dll',
      'avdevice-61.dll', 'postproc-58.dll',
    ]) {
      expect(FFMPEG_LIBRARY_DLL.test(name), name).toBe(true);
    }
  });

  it('leaves everything else where it is', () => {
    // The source may be a directory shared with other programs — chocolatey's
    // shim directory, or System32. Emptying that into the bundle is not a
    // risk worth taking for a convenience.
    for (const name of [
      'kernel32.dll', 'msvcp140.dll', 'vcruntime140.dll',
      'python311.dll', 'avalanche.dll', 'swagger.dll', 'notavcodec.dll',
      'avcodec.dll', 'avcodec-61.exe',
    ]) {
      expect(FFMPEG_LIBRARY_DLL.test(name), name).toBe(false);
    }
  });

  it('picks them out of a real-looking directory listing', () => {
    const readdir = vi.fn().mockReturnValue([
      'ffmpeg.exe', 'ffprobe.exe', 'avcodec-61.dll', 'avutil-59.dll',
      'kernel32.dll', 'README.txt',
    ]);
    expect(librariesIn('C:\\ffmpeg\\bin', readdir)).toEqual(['avcodec-61.dll', 'avutil-59.dll']);
  });

  it('treats an unreadable directory as having none', () => {
    const readdir = vi.fn().mockImplementation(() => { throw new Error('ENOENT'); });
    expect(librariesIn('/nowhere', readdir)).toEqual([]);
  });
});

/**
 * The whole chain, which is what CI runs and what a release runs. Both call
 * bundleFfmpeg, so a regression here is a regression in both.
 */
describe('bundling what PATH resolves to', () => {
  /** A `where`/`which` that answers with `resolved`, and a copy that behaves as `banner`. */
  const execStub = (resolved: string | null, banner: Record<string, string>) =>
    vi.fn((file: string, args: string[]) => {
      if (file === 'where' || file === 'which') {
        if (resolved === null) throw new Error('not found');
        // Joined rather than concatenated with a backslash: these tests assert
        // the Windows behaviour but run on every runner, and a path built with
        // the wrong separator simply would not exist.
        return `${path.join(resolved, `${args[0]}.exe`)}\r\n`;
      }
      const tool = path.basename(file).replace(/\.exe$/, '');
      if (!(tool in banner)) throw new Error('cannot execute');
      return banner[tool];
    });

  let dist: string;
  beforeEach(() => {
    dist = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-ffmpeg-test-'));
  });
  afterEach(() => {
    fs.rmSync(dist, { recursive: true, force: true });
  });

  /** A source directory holding binaries that are real files, so they can be copied. */
  const sourceDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-ffmpeg-src-'));
    fs.writeFileSync(path.join(dir, 'ffmpeg.exe'), 'not really ffmpeg');
    fs.writeFileSync(path.join(dir, 'ffprobe.exe'), 'not really ffprobe');
    return dir;
  };

  it('reports both tools when each copy identifies itself', () => {
    const src = sourceDir();
    const exec = execStub(src, {
      ffmpeg: 'ffmpeg version 9.0.1 Copyright (c) 2000-2025',
      ffprobe: 'ffprobe version 9.0.1 Copyright (c) 2000-2025',
    });

    const { bundled, missing, unusable } = bundleFfmpeg({ dist, isWindows: true, exec });

    expect(missing).toEqual([]);
    expect(unusable).toEqual([]);
    expect(bundled.map((b) => b.tool)).toEqual(['ffmpeg', 'ffprobe']);
    expect(fs.existsSync(path.join(dist, 'ffmpeg.exe'))).toBe(true);
    fs.rmSync(src, { recursive: true, force: true });
  });

  it('reports the shim, and ships nothing, when the copy runs but says nothing', () => {
    // The reported failure: exits non-zero, writes nothing. The copy must not
    // survive — a bundle with a dead ffmpeg in it is the thing being prevented.
    const src = sourceDir();
    const exec = execStub(src, {});

    const { bundled, unusable } = bundleFfmpeg({ dist, isWindows: true, exec });

    expect(bundled).toEqual([]);
    expect(unusable).toHaveLength(2);
    expect(unusable[0]).toContain('ffmpeg');
    expect(fs.existsSync(path.join(dist, 'ffmpeg.exe'))).toBe(false);
    fs.rmSync(src, { recursive: true, force: true });
  });

  it('separates a tool that is absent from one that is broken', () => {
    // The build tolerates the first and refuses the second, so they cannot be
    // reported as the same thing.
    const exec = execStub(null, {});

    const { bundled, missing, unusable } = bundleFfmpeg({ dist, isWindows: true, exec });

    expect(bundled).toEqual([]);
    expect(missing).toEqual(['ffmpeg', 'ffprobe']);
    expect(unusable).toEqual([]);
  });
});
