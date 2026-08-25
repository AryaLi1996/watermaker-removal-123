# Packaging & Release Guide

How to build distributable installers and publish a release for macOS, Windows, and Linux.

---

## Prerequisites

Make sure the build tools are installed:

```bash
npm install          # root workspace
npm install --prefix renderer
python3 -m venv backend/.venv                             # or: ./dev.sh
backend/.venv/bin/pip install -r backend/requirements.txt # includes PyInstaller
```

FFmpeg must be on the build machine's `PATH`. `scripts/build.js` copies
`ffmpeg` and `ffprobe` into the installer, so the app your users install does
**not** need ffmpeg of their own. If the build machine has no ffmpeg the build
still succeeds, but prints a warning and produces an installer that falls back
to the user's own ffmpeg — say so in the release notes if you ship one.

---

## What ends up inside the installer

A packaged app cannot use the development setup: `backend/.venv` is not shipped,
and `backend/main.py` would live inside `app.asar`, a virtual filesystem that a
child process cannot execute. So the build ships a **frozen backend** instead.

| Piece | Where it comes from | Where it lands |
|---|---|---|
| Electron main + preload | `electron/` | `app.asar` |
| Renderer bundle | `npm run build:renderer` | `app.asar` |
| Frozen Python backend | `scripts/build_backend.py` (PyInstaller) | `resources/backend/watermark-backend` |
| ffmpeg + ffprobe | copied from the build machine's `PATH` | `resources/backend/` |

At runtime `electron/main.js` detects `app.isPackaged` and runs the frozen
binary, pointing it at the bundled ffmpeg through `FFMPEG_PATH` / `FFPROBE_PATH`.
In development it keeps using `backend/.venv` and `backend/main.py`.

To verify a build is genuinely self-contained, run its backend with nothing on
`PATH`:

```bash
R=release/linux-unpacked/resources/backend
echo '{"inputPath":"/abs/clip.mp4","outputPath":"/tmp/out.mp4",
       "roi":{"x":10,"y":10,"w":120,"h":40},"method":"blur","mode":"full"}' \
  | env -i HOME=$HOME PATH=/nonexistent \
      FFMPEG_PATH=$R/ffmpeg FFPROBE_PATH=$R/ffprobe $R/watermark-backend
```

It should end with `STATE:done:/tmp/out.mp4`.

---

## 1. Local Build (Test Before Releasing)

### 1a. Verify tests pass

```bash
npm run test:all       # backend pytest + renderer vitest + Playwright E2E
npm run test:coverage  # backend coverage, fails under 80%
```

### 1b. Production build

```bash
npm run dist          # current platform
npm run dist:mac      # .dmg + .zip
npm run dist:win      # NSIS .exe
npm run dist:linux    # .AppImage
```

Each runs `scripts/build.js` first, which installs the Python dependencies,
freezes the backend, bundles ffmpeg and builds the renderer, then hands over to
electron-builder. Output lands in `release/`.

To rebuild just the frozen backend:

```bash
npm run build:backend   # → backend/dist/watermark-backend
```

### 1c. Smoke test the packaged app

```bash
./release/linux-unpacked/watermark-remover     # or open the .dmg / run the installer
```

Confirm it launches, opens a file, previews, and exports — on a machine without
a Python venv, to prove the frozen backend is doing the work.

---

## 2. Packaging with electron-builder

### macOS — `.dmg`

```bash
npm run dist
```

Output: `dist/Watermark Remover-1.0.0.dmg`

The DMG contains a drag-to-Applications installer. The app bundle is at `dist/mac/Watermark Remover.app`.

#### Code signing (required for distribution outside App Store)

Set these environment variables before running `npm run dist`:

```bash
export CSC_LINK="path/to/certificate.p12"
export CSC_KEY_PASSWORD="your_password"
npm run dist
```

Or use environment variables in your CI pipeline (see §5).

For **notarization** (required for Gatekeeper on macOS 10.15+):

```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="XXXXXXXXXX"
npm run dist
```

Add to `package.json` `build` section:

```json
"mac": {
  "target": "dmg",
  "notarize": true
}
```

---

### Windows — `.exe` (NSIS installer)

```bash
npm run dist
```

Output: `dist/Watermark Remover Setup 1.0.0.exe`

#### Code signing (optional but prevents SmartScreen warnings)

```bash
export CSC_LINK="path/to/certificate.pfx"
export CSC_KEY_PASSWORD="your_password"
npm run dist
```

---

### Linux — `.AppImage`

```bash
npm run dist
```

Output: `dist/Watermark Remover-1.0.0.AppImage`

AppImages are self-contained and run on any modern distro without installation. Users may need to `chmod +x` the file before running:

```bash
chmod +x "Watermark Remover-1.0.0.AppImage"
./"Watermark Remover-1.0.0.AppImage"
```

---

### Build for all platforms at once

On macOS you can cross-compile for all three targets:

```bash
npm run dist -- --mac --win --linux
```

> **Note:** Windows NSIS installer cross-compilation from macOS requires `wine` (`brew install --cask wine-stable`).

---

## 2b. Linux `.deb`

Linux builds produce both an `.AppImage` and a `.deb`. `.deb` requires a
package maintainer with an email address; `package.json` declares the
repository owner's GitHub noreply address, which is public and account-scoped
rather than a personal inbox. Change it in `build.linux.maintainer` if you
publish under a different identity.

Packaging an AppImage needs FUSE on the build machine (`libfuse2` on Debian
and Ubuntu); the release workflow installs it.

---

## 2c. Continuous integration

| Workflow | Trigger | What it does |
|---|---|---|
| `.github/workflows/ci.yml` | push to `main`, every PR | Installs ffmpeg, runs backend + renderer + E2E tests and lint on Linux, macOS and Windows |
| `.github/workflows/release.yml` | tag `v*`, or manual dispatch | Packages on all three platforms and attaches the installers to a GitHub release |

Signing secrets are read by the release workflow when set (`CSC_LINK`,
`CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`).
Without them the build still succeeds and produces **unsigned** artifacts.

The "Signing environment" step is what makes that true, and it is not
decoration. An unset secret expands to an empty string rather than to nothing
at all, and electron-builder reads `CSC_LINK` as a certificate *path* whenever
the variable is defined — empty included. Passing the secrets straight to the
build step therefore resolved `""` against the checkout directory and failed
the macOS job with `<workspace> not a file`. The step exports each variable
only when it actually holds something, and otherwise sets
`CSC_IDENTITY_AUTO_DISCOVERY=false` so electron-builder stops looking for a
keychain identity that a fresh runner does not have.

---

## 3. Versioning

Version is read from `package.json` → `"version"`. Update it before every release:

```bash
# patch: 1.0.0 → 1.0.1
npm version patch

# minor feature release: 1.0.0 → 1.1.0
npm version minor

# breaking change: 1.0.0 → 2.0.0
npm version major
```

`npm version` automatically:
1. Bumps the version in `package.json`
2. Creates a git commit
3. Creates a git tag `v1.x.x`

---

## 4. GitHub Release Workflow

### Step-by-step manual release

```bash
# 1. Make sure you are on main and tests pass
git checkout main
npm run test:backend
cd renderer && npm run test:run && cd ..

# 2. Bump version (creates commit + tag)
npm version minor   # or patch / major

# 3. Push commit and tag
git push origin main --follow-tags

# 4. Build installers
npm run dist -- --mac --win --linux

# 5. Create a GitHub Release
gh release create v1.1.0 \
  --title "Watermark Remover v1.1.0" \
  --notes-file CHANGELOG.md \
  "dist/Watermark Remover-1.1.0.dmg" \
  "dist/Watermark Remover Setup 1.1.0.exe" \
  "dist/Watermark Remover-1.1.0.AppImage"
```

> **Requires:** [GitHub CLI](https://cli.github.com/) (`brew install gh`, then `gh auth login`)

---

## 5. Automated Releases via GitHub Actions

The workflow lives at [`.github/workflows/release.yml`](.github/workflows/release.yml). It triggers on any tag push matching `v*`, and can also be run manually from the Actions tab.

**Pipeline overview:**

| Job | Runner | What it does |
|---|---|---|
| `build` | ubuntu / macos / windows (matrix) | Installs ffmpeg and the Python venv, runs `npm run dist`, uploads the installers as artifacts |
| `publish` | ubuntu-latest | Downloads every artifact and attaches them to a GitHub Release with generated notes |

Tags containing `-` (e.g. `v1.0.0-beta`) are published as **pre-releases**.

Tests are not re-run here — `.github/workflows/ci.yml` covers every push to
`main` and every PR. Run `npm run test:all` before tagging.

To trigger a release, complete Steps 1–3 above (run tests, bump version, push tag):

```bash
npm version patch           # bumps version, commits, creates tag
git push origin main --follow-tags   # push both commit and tag → workflow starts
```

### Required GitHub Secrets

Add these in **Settings → Secrets and variables → Actions**:

All of these are optional: with none set, the workflow still builds and
publishes **unsigned** installers.

| Secret | Description |
|---|---|
| `CSC_LINK` | Base64-encoded signing certificate (`.p12` on macOS, `.pfx` on Windows) |
| `CSC_KEY_PASSWORD` | Password for that certificate |
| `APPLE_ID` | Apple Developer account email (notarization) |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password from appleid.apple.com |
| `APPLE_TEAM_ID` | 10-character Apple Developer Team ID |

`GITHUB_TOKEN` is provided by Actions automatically — no need to add it.

#### Encode a certificate to base64 for a GitHub Secret:
```bash
base64 -i certificate.p12 | pbcopy   # macOS — copies to clipboard
```

---

## 6. CHANGELOG

Keep a `CHANGELOG.md` at the project root. Use [Keep a Changelog](https://keepachangelog.com) format:

```markdown
# Changelog

## [Unreleased]

## [1.0.0] - 2026-03-26
### Added
- Interactive ROI selector with 8-point Transformer
- Four removal engines: Inpaint (TELEA), Blur, Solid Fill, Clone Stamp
- Frame-accurate preview mode (3-second clip)
- Multi-core parallel frame processing
- Real-time progress bar via IPC stdout protocol
- Cancel in-progress job (SIGTERM + pool.terminate)
- Audio preservation (original track muxed back, no re-encode)
- Automatic temp-file cleanup on completion or error
```

---

## 7. Distributing Without Code Signing

If you skip code signing, users will see security warnings:

| Platform | Warning | User workaround |
|---|---|---|
| **macOS** | "App cannot be opened because it is from an unidentified developer" | Right-click the app → Open → Open anyway |
| **Windows** | SmartScreen: "Windows protected your PC" | Click "More info" → "Run anyway" |
| **Linux** | None — AppImages run freely | `chmod +x` required |

Document this in your release notes for unsigned builds.

---

## 8. Auto-Update (Future)

electron-builder supports `electron-updater` for automatic in-app updates. To enable:

1. `npm install electron-updater`
2. Configure an update server URL or use GitHub Releases as the update feed
3. Add `publish` config to `package.json`:

```json
"publish": {
  "provider": "github",
  "owner": "YOUR_USERNAME",
  "repo": "watermark-remover"
}
```

4. Call `autoUpdater.checkForUpdatesAndNotify()` in `electron/main.js`

This is a post-v1.0 feature and not currently implemented.
