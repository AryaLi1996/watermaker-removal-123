# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
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
- Packaged builds could not run a job at all: they pointed at the excluded
  `backend/.venv` and at a script path inside `app.asar`, which no child
  process can execute.

## [1.0.0] - 2026-03-26

### Added
- Initial release: ROI selection, four removal methods (Smart Fill, Blur,
  Solid Color, Clone Stamp), 3-second preview, and full export with the
  original audio preserved.
