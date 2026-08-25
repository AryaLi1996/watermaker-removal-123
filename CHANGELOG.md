# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
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
  that instead of spinning forever.
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

### Fixed
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
