# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Temporal Fill (beta)** — a fifth removal method that reconstructs the
  watermark region from the frames around it rather than from the frame it is
  in. Where the background moves, the pixels behind a static mark are usually
  visible a few frames away: the engine tracks the motion with optical flow,
  composing frame-to-frame estimates as it walks outwards, samples the real
  background from the frames that verify, and fuses the samples per pixel. The
  result is feathered into a band just outside the selection, so the seam falls
  on reconstructed background instead of on the edge of the mark — which is
  what the soft patches and hard edges of single-frame filling were.
  - A **Quality** setting (Fast / Balanced / High) trades wait for accuracy,
    and two presets ship with it.
  - The walk stops as soon as the selection is covered, so footage that moves
    costs a couple of neighbours per frame and only a hard shot pays the full
    reach. A locked-off camera over a still background uncovers nothing and
    falls back to single-frame inpainting rather than inventing motion.
  - Expect 5–10x the processing time of the single-frame methods. The status
    line and the share of the progress bar the per-frame work gets both say so.
  - The method is greyed out, with the reason, on machines with fewer than four
    cores or less than 4 GB of memory. The backend refuses such a job too, in
    plain language: the UI is not the only way one can be sent.
  - A temporal preview is capped at three seconds, in the control and in the
    backend. A preview costs the same per frame as the export, so the length
    that makes the other methods feel instant would make this one the slowest
    thing in the app.

- **Deep learning enhancement (optional)** — a switch under Temporal Fill that
  hands the job to [ProPainter](https://github.com/sczhou/ProPainter), a
  learned video-inpainting model, instead of the optical-flow engine. It is the
  answer to the one case flow cannot help with: a locked-off camera over a
  still background, where no frame in the video ever shows what is behind the
  mark, so there is nothing to recover and something has to be invented.
  - Not bundled, and not downloaded on your behalf: it needs PyTorch, CUDA and
    an NVIDIA card. See [docs/deep-learning.md](docs/deep-learning.md) for the
    install. Without it the switch is greyed out with the reason and everything
    behaves exactly as before.
  - The model weights (about 200 MB, three files) *are* fetched automatically,
    on the first job that uses the engine, with progress as they come down.
  - The quality dial picks the resolution the model runs at. A card too small
    for the preset chosen steps down to the next one rather than refusing, and
    the sidebar says which preset will run before the job starts.
  - Only the repainted rectangle is pasted back, feathered into the frame. The
    model works at a resolution its memory budget allows; everything outside
    the selection keeps the pixels ffmpeg extracted, at full resolution.
  - Long videos are processed in chunks, so length costs time rather than video
    memory.
  - Every way this can fail is a fallback, never a lost export: the optical-flow
    engine finishes the job and the app says what happened and why. It is never
    silent about it — an export that quietly used a different engine than the
    one selected is an export nobody can reason about.

### Changed
- The method shortcuts now run 1–5, the fifth being temporal fill. On a
  machine where the method is unavailable, the key does nothing rather than
  selecting something that cannot be exported.
- `system:info` reports the host's core count and total memory, so the
  renderer can tell whether the heavier methods are worth offering. It now also
  reports the GPU — name and video memory, asked of the NVIDIA driver — which
  is what decides whether the deep-learning switch is offered and which preset
  it promises.
- The core and memory bar for temporal fill applies to the optical-flow engine
  only. A two-core machine with a large graphics card runs the deep engine
  faster than an eight-core one runs the flow engine; refusing it for want of
  cores would refuse the fastest job the app can do.

## [1.1.0] - 2026-08-30

### Added
- The progress bar moves during extraction and encoding. Both stages ask
  ffmpeg where it is and report it as they go, so a long export climbs
  continuously instead of standing still at 5% and 80% for minutes at a time.
- A load that fails or times out offers to try the same file again, on the
  canvas and in the sidebar, instead of leaving a spinner running behind an
  error nobody can clear.
- The pipeline reports which stage it is at in the interface language, not in
  English. Stages now cross the stdout protocol as keys (`STATE:stage:encoding`)
  that the renderer looks up alongside every other string, so the status line
  follows the language picker — including for a job already running.
- Loading a video says what it is doing. Reading the file's details and
  preparing its first frame each report themselves, so a large file looks like
  a wait rather than a hang.
- A quick preview's length is a job setting (`previewSeconds`), defaulting to
  the one second the button now offers.
- Intel Macs get their own build. Releases now carry both
  `Watermark Remover-<version>-x64.dmg` and `-arm64.dmg`, each packaged on a
  runner of that architecture — the frozen backend and the bundled ffmpeg are
  native executables, so one Mac build cannot serve both.
- English and Chinese interfaces, switchable from the sidebar without a
  restart. The choice is remembered; a first run follows the system language.
  Backend failures are translated too, since they are classified to a key
  rather than a sentence.
- `electron/system.js` gathers the platform-specific calls — app data and temp
  directories, revealing a file, notifications, host facts — behind one module.
- A desktop notification when an export finishes, for when the app is in the
  background.
- Linux builds now produce a `.deb` alongside the `.AppImage`.
- Presets: eight built-ins covering the common cases, plus your own saved to
  this machine and restored on the next launch.
- Keyboard shortcuts for the repeated actions — 1–4 pick a method, ⌘/Ctrl+P
  previews, ⌘/Ctrl+E exports, ⌘/Ctrl+Z undoes, ⌘/Ctrl+S saves a preset, Esc
  cancels — listed in the sidebar so they are findable.
- Undo/redo over the selection, method and parameters.
- A time-remaining estimate beside the progress bar, fitted to recent progress
  so it tracks the current stage rather than a whole-job average.
- Backend failures are explained in plain language, with the technical detail
  kept behind "Copy details" for a bug report.
- A timeout on preview extraction, so a backend that never answers reports
  that instead of spinning forever. Reading a file's details and decoding its
  first frame carry their own ceilings in the backend as well, so a stuck
  ffmpeg is stopped and reported rather than waited out.
- The layout stacks and the sidebar scrolls in a narrow or short window.
- Frozen Python backend (PyInstaller) shipped inside the installer, so an
  installed app needs neither a Python environment nor ffmpeg of its own.
- ffmpeg and ffprobe bundled from the build machine into `resources/backend/`.
- `scripts/build.js` preflight and `scripts/build_backend.py`, plus
  `dist:mac` / `dist:win` / `dist:linux` / `build:backend` scripts.
- Application icon, macOS entitlements, and NSIS/DMG installer options.
- CI workflow running backend, renderer and E2E tests with ffmpeg on Linux,
  macOS and Windows; release workflow packaging all three on a `v*` tag.
- Opt-in auto-update: a downloaded update surfaces a banner and installs on
  the user's confirmation.

### Changed
- Previews are quicker to produce. They cover one second rather than three,
  the frames go to disk at the cheapest lossless PNG level instead of the
  slowest, inpainting is handed the neighbourhood of the selection rather than
  the whole frame, and the clip is encoded with a preset chosen for speed — an
  export still encodes for quality. Measured on a 784×1168 clip and four
  cores, a preview went from 8.4s to 3.0s; comparing the same three seconds of
  video, from 8.4s to 6.4s.
- Loading a video no longer imports OpenCV. Reading a file's details and
  pulling out its first frame need ffprobe and one ffmpeg call, and the import
  was pure delay between picking a file and seeing it.
- A batch of a handful of frames runs in the dispatcher process rather than
  starting a pool that cannot repay its first worker, and a pool is never
  larger than the work it has.

### Fixed
- A preview no longer reports "No input received on stdin." halfway through.
  The release freezes the backend into one executable, and the frame pool
  starts its workers by re-running that executable — with nothing to tell them
  they are workers, each ran the dispatcher again, found the stdin Electron had
  already closed, and reported that on the same stdout the real job was
  reporting on. The entry point now arms `multiprocessing.freeze_support()`
  before anything reads stdin. ffmpeg children are also given
  `stdin=DEVNULL` rather than inheriting the pipe the job payload arrives on.
- A rejected job now says which field it rejected and why. The backend's
  stdout protocol is line-based, so only the first line of a pydantic failure
  survived the trip to the UI — and pydantic puts the count there
  ("1 validation error for JobConfig") and the field and reason on the lines
  after, which the parser dropped. The message is flattened onto one line
  before it is emitted, and classified to plain language in both interface
  languages.
- An export no longer fails over a selection the user drew correctly. A canvas
  that had not been measured yet left the zoom factor at zero, so converting
  the box to video pixels produced `Infinity`, which crosses IPC as `null`;
  fractional pixel counts, which the same conversion produces routinely, are
  now rounded by the backend rather than refused.
- Backend messages now reach the UI as UTF-8 whatever the console encoding
  is. Electron decodes the backend's output as UTF-8, but Python followed the
  console code page — so on Windows, or in a Chinese locale, an error naming a
  file with non-ASCII characters failed to encode inside the emit itself and
  no `ERROR:` line was written at all, leaving the user with a bare exit code.
- The job payload is validated where it arrives rather than deep in a frame
  worker: an unknown removal method, an unknown mode, a selection with no
  area, and a fill colour that is not three channels in range are all refused
  before a video is extracted, instead of failing one frame at a time after
  minutes of work.
- A failed export no longer reports itself as finished. The backend exited 0
  after printing its error, and Electron reads a zero exit as success, so an
  `ERROR:` line could be followed by `job:done` naming a file that was never
  written.
- Failures now say what actually went wrong. ffmpeg's own explanation — a full
  disk, a refused path, an unreadable file — was captured and then dropped,
  leaving only an exit status; and the rule that recognises an ffmpeg failure
  ran before the ones for those specific causes, so every such failure was
  reported to the user as a corrupt video.
- The preview still is no longer deleted while the canvas is drawing it.
  Asking for a preview clip purged it along with the previous job's temp
  files, so closing the clip left an empty canvas with no selection box and no
  way back short of reloading the video.
- A video that yields no frames is reported as such, at the point extraction
  produced nothing, instead of failing several steps later inside the encoder
  with a message about a missing input pattern.
- The release workflow packaged on Linux only. macOS failed in
  electron-builder because an unset `CSC_LINK` secret still arrives as an
  empty string and was read as a certificate path; Windows failed *after*
  freezing the backend, when a status line containing `✅` met the runner's
  cp1252 stdout. Signing variables are now exported only when they hold
  something, and the build scripts ask for UTF-8 output.
- OpenCV no longer oversubscribes the CPU: each pool worker was spawning
  threads up to the core count while the pool already used every core.
  Measured a few percent faster end to end on a 4-core machine.
- Packaged builds could not run a job at all: they pointed at the excluded
  `backend/.venv` and at a script path inside `app.asar`, which no child
  process can execute.

### Removed
- `python:run`, the "does Python answer" IPC channel from the first
  milestone's validation. Nothing had called it since.

### Security
- Preview stills and clips travel over the app's own `wm-media://` scheme
  rather than `file://`. It serves only the files the main process published —
  the still the canvas is showing, and the clips of the job in flight — so the
  interface can no longer ask for an arbitrary path, and it answers range
  requests, which is what lets a clip seek and loop. Development ran with
  `webSecurity` switched off to allow the old `file://` URLs, which disabled
  the same-origin policy for the whole page; it is on everywhere now.
- The renderer runs in a sandboxed process. Its preload reaches only for
  `contextBridge` and `ipcRenderer`, both of which survive the sandbox.

## [1.0.0] - 2026-03-26

### Added
- Initial release: ROI selection, four removal methods (Smart Fill, Blur,
  Solid Color, Clone Stamp), 3-second preview, and full export with the
  original audio preserved.
