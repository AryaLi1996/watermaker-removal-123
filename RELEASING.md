# Packaging & Release Guide

How to build distributable installers and publish a release for macOS, Windows, and Linux.

---

## Prerequisites

Make sure the build tools are installed:

```bash
npm install          # root workspace
cd renderer && npm install && cd ..
```

FFmpeg is a **runtime dependency** — it must be present on the end-user's machine. It is **not** bundled into the installer. Document this requirement clearly in the release notes.

---

## 1. Local Build (Test Before Releasing)

### 1a. Verify tests pass

```bash
npm run test:backend             # 11 pytest  → all green
cd renderer && npm run test:run  # 15 vitest  → all green
cd ..
```

### 1b. Production build

```bash
npm run build
```

This produces:
- `renderer/dist/` — bundled React app
- No extra tsc output needed (electron `.js` files are already the source)

### 1c. Smoke test the production build

```bash
npm run dev:electron   # loads renderer/dist instead of dev server
```

Confirm the app launches, opens a file, and runs a quick preview before packaging.

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

The workflow is already configured at [`.github/workflows/release.yml`](.github/workflows/release.yml). It triggers automatically on any tag push matching `v*`.

**Pipeline overview:**

| Job | Runner | What it does |
|---|---|---|
| `test` | ubuntu-latest | Runs Python pytest + Vitest — blocks all builds on failure |
| `build-mac` | macos-latest | `npm run dist -- --mac` → uploads `.dmg` artifact |
| `build-win` | windows-latest | `npm run dist -- --win` → uploads `.exe` artifact |
| `build-linux` | ubuntu-latest | `npm run dist -- --linux` → uploads `.AppImage` artifact |
| `publish` | ubuntu-latest | Downloads all artifacts, creates GitHub Release with `CHANGELOG.md` as notes |

Tags containing `-` (e.g. `v1.0.0-beta`) are automatically published as **pre-releases**.

To trigger a release, complete Steps 1–3 above (run tests, bump version, push tag):

```bash
npm version patch           # bumps version, commits, creates tag
git push origin main --follow-tags   # push both commit and tag → workflow starts
```

### Required GitHub Secrets

Add these in **Settings → Secrets and variables → Actions**:

| Secret | Description |
|---|---|
| `MAC_CERT_P12` | Base64-encoded `.p12` certificate file |
| `MAC_CERT_PASSWORD` | Password for the `.p12` file |
| `APPLE_ID` | Apple Developer account email |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password from appleid.apple.com |
| `APPLE_TEAM_ID` | 10-character Apple Developer Team ID |
| `WIN_CERT_PFX` | Base64-encoded `.pfx` certificate file (optional) |
| `WIN_CERT_PASSWORD` | Password for the `.pfx` file (optional) |

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
