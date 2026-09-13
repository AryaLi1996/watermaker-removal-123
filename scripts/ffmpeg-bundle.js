'use strict';
/**
 * Choosing and checking the ffmpeg/ffprobe a release ships.
 *
 * Apart from build.js because the interesting parts are decisions rather than
 * steps, and a decision that ships a broken installer is worth testing.
 *
 * The hazard this exists for: `where`/`which` answers with whatever is on
 * PATH, which is not always the program. Chocolatey — which the release
 * workflow installs ffmpeg with — puts a *shim* on PATH that locates the real
 * binary relative to chocolatey's own directory. Copied into the bundle, that
 * shim starts, resolves nothing, writes nothing, and exits non-zero. A shared
 * build copied without the libraries beside it fails the same way.
 *
 * Either one ships an app that cannot read a single video, while every test on
 * the build machine passes — because the build machine has a working ffmpeg on
 * PATH and nothing ever runs the copy. So the copy gets run.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * The libraries a shared ffmpeg build needs beside it.
 *
 * Matched by name rather than by copying every DLL in the directory: the
 * source may be a shared bin directory belonging to something else entirely
 * (chocolatey's shim directory, or worse, System32), and emptying that into
 * the bundle is not a mistake worth risking for a convenience.
 */
const FFMPEG_LIBRARY_DLL =
  /^(avcodec|avdevice|avfilter|avformat|avutil|swresample|swscale|postproc)-\d+\.dll$/i;

/** Whether `output` is `tool` identifying itself, rather than something else running. */
function isVersionBanner(output, tool) {
  return typeof output === 'string' && output.toLowerCase().includes(`${tool} version`);
}

/**
 * Why the bundled `binary` cannot be shipped, or null if it can.
 *
 * Executing it is the only check that tells the program apart from a launcher
 * for the program. Everything cheaper — that the file exists, that it has a
 * plausible size — passes for exactly the cases that break.
 */
function whyUnusable(binary, tool, exec = execFileSync) {
  let output;
  try {
    output = exec(binary, ['-version'], {
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    if (err.status !== undefined && err.status !== null) {
      // The signature of a chocolatey shim outside chocolatey, and of a
      // shared build with no libraries: it runs, says nothing, and fails.
      return `it exited with status ${err.status} instead of reporting its version`;
    }
    return `it could not be run (${err.message})`;
  }
  if (!isVersionBanner(output, tool)) {
    return `it ran but did not identify itself as ${tool} — the copy is probably a launcher for one`;
  }
  return null;
}

/** The ffmpeg libraries in `sourceDir`, which a shared build cannot start without. */
function librariesIn(sourceDir, readdir = fs.readdirSync) {
  try {
    return readdir(sourceDir).filter((name) => FFMPEG_LIBRARY_DLL.test(name));
  } catch {
    return [];
  }
}

/**
 * Copy `tool` from `source` into `dist` and prove the copy works.
 *
 * Returns null on success, or the reason it cannot be shipped. An unusable
 * copy is deleted rather than left behind: the app points `FFMPEG_PATH` at
 * whatever is bundled and that overrides the user's own ffmpeg, so a broken
 * file in the bundle is worse than no file at all.
 */
function bundleTool({ tool, source, dist, isWindows, exec = execFileSync }) {
  const binary = tool + (isWindows ? '.exe' : '');
  const target = path.join(dist, binary);

  if (isWindows) {
    const sourceDir = path.dirname(source);
    for (const library of librariesIn(sourceDir)) {
      fs.copyFileSync(path.join(sourceDir, library), path.join(dist, library));
    }
  }

  fs.copyFileSync(source, target);
  fs.chmodSync(target, 0o755);

  const reason = whyUnusable(target, tool, exec);
  if (reason) {
    try { fs.unlinkSync(target); } catch { /* nothing shipped either way */ }
  }
  return reason;
}

module.exports = { FFMPEG_LIBRARY_DLL, isVersionBanner, whyUnusable, librariesIn, bundleTool };
