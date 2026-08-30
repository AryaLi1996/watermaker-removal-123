# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

## [1.0.0] - 2026-03-26

### Added
- Initial release: ROI selection, four removal methods (Smart Fill, Blur,
  Solid Color, Clone Stamp), 3-second preview, and full export with the
  original audio preserved.
