# Testing & Validation Guide

How to run, understand, and extend the automated test suite.

---

## Quick Reference

| Suite | Command | Tests | Location |
|---|---|---|---|
| Backend (Python) | `npm run test:backend` | 90 pytest | `tests/unit/backend/` |
| Backend coverage | `npm run test:coverage` | ≥ 80% required | `htmlcov/` |
| Renderer (TypeScript) | `npm run test:frontend` | 61 vitest | `tests/unit/renderer/` |
| E2E (Electron) | `npm run test:e2e` | 48 Playwright | `tests/e2e/` |
| Docs screenshots | `npm run screenshots` | 2 Playwright | `tests/e2e/capture-screenshots.spec.ts` |
| Everything | `npm run test:all` | all of the above | root |
| Environment check | `python scripts/validate_env.py` | manual | `scripts/` |
| Full build validation | `npm run build` | build passes | root |

---

## 1. Backend Tests (Pytest)

### Prerequisites

The Python virtual environment must exist and be populated:

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate   # macOS/Linux
pip install -r requirements.txt
```

### Running

From the **project root**:

```bash
npm run test:backend
```

This runs `pytest tests/unit/backend -v` inside the backend venv.

Or run pytest directly:

```bash
cd /path/to/watermark-remove
backend/.venv/bin/python -m pytest tests/unit/backend -v
```

### What is tested

**File:** `tests/unit/backend/test_image_core.py` — the removal engines

| Test | What it checks |
|---|---|
| `test_create_mask_shape` | Mask output shape equals `(height, width)` |
| `test_create_mask_roi_white` | Pixels inside ROI are 255 |
| `test_create_mask_outside_black` | Pixels outside ROI are 0 |
| `test_mask_full_frame` | Mask that covers the whole frame is all-white |
| `test_inpaint_returns_same_shape` | `process_inpaint` output shape matches input |
| `test_blur_modifies_roi` | Blur changes pixel values inside ROI |
| `test_blur_preserves_outside` | Blur does not modify pixels outside ROI |
| `test_solid_fill_correct_color` | `process_solid_fill` sets ROI to exact target color |
| `test_clone_stamp_copies_pixels` | `process_clone_stamp` copies source block correctly |
| `test_clone_stamp_oob_raises` | Out-of-bounds source offset raises `ValueError` |
| `test_apply_removal_routes_inpaint` | `apply_removal` dispatcher calls the right engine |

**File:** `tests/unit/backend/test_backend_helpers.py` — clamping and the cancel path

| Test group | What it checks |
|---|---|
| `clamp_roi` | A box running off any edge is trimmed; a fully outside box raises |
| `clamp_clone_offset` | The clone source is nudged back in-frame instead of failing |
| `apply_removal` | Every engine survives an ROI hanging off the frame edge |
| `preview_window` | The 3s window is centred, and shrinks for a shorter video |
| `audio_args_for` | MP4-native audio is copied; vorbis/opus/flac transcode to AAC |
| `_run` / `terminate` | Child stdout and failures propagate; a cancel stops the child |

**File:** `tests/unit/backend/test_ff_utils.py` — the ffmpeg layer (real ffmpeg, tiny synthetic clips)

| Test group | What it checks |
|---|---|
| `probe_video` | Dimensions, fps, duration, codecs; missing and non-video files raise |
| `extract_frames` / `extract_preview_frame` / `extract_clip` | One PNG per frame, a readable still, a trimmed clip |
| `reassemble_video` | Audio preserved, silent sources handled, vorbis transcoded, temp file removed |

**File:** `tests/unit/backend/test_processor.py` — the multi-core batch

| Test group | What it checks |
|---|---|
| `run_batch` | Every frame rewritten, pixels outside the ROI untouched, progress 0→100 |
| Engine sweep | All four methods run through the pool |
| Worker body | One frame processed on disk; an unreadable frame raises |

**File:** `tests/unit/backend/test_main_pipeline.py` — schema, protocol and dispatch

| Test group | What it checks |
|---|---|
| `JobConfig` | Absolute paths required, missing input rejected, `/dev/null` allowed |
| Protocol | `PROGRESS:`, `STATE:` and camelCase `STATE:meta:` line formats |
| `run_pipeline` | Produces a playable video with its audio intact |
| Dispatch | full / preview_frame / preview modes, error lines, temp dir cleaned up |

Tests needing ffmpeg are marked `requires_ffmpeg` and skip (rather than fail)
where it is not installed. `tests/unit/backend/conftest.py` builds the
synthetic clips they use.

### Expected output

```
tests/unit/backend/ ......................   90 passed
```

### Coverage

```bash
npm run test:coverage
```

Prints a per-file table and writes a browsable report to `htmlcov/index.html`.
Settings live in `backend/.coveragerc`, which fails the run below **80%**
(currently ~96%).

---

## 2. Renderer Tests (Vitest)

### Prerequisites

Install renderer dependencies if not already done:

```bash
cd renderer && npm install
```

### Running

**Watch mode** (re-runs on file changes — useful during development):

```bash
cd renderer && npm run test
```

**Single run** (CI / quick check):

```bash
cd renderer && npm run test:run
```

Or from the project root:

```bash
cd renderer && npm run test:run
```

### What is tested

**File:** `tests/unit/renderer/utils.test.ts`

| Test group | Tests | What is checked |
|---|---|---|
| `normalizeCoordinates` | 4 | Scale-up math, zero origin, partial offset, identity scale |
| `calcScaleFactor` | 4 | Wide video, tall video, exact fit, small container |
| `formatDuration` | 4 | Seconds-only, with minutes, with hours, zero |
| `defaultOutputName` | 3 | Unix path, Windows path backslash, no extension |

### Expected output

```
✓ tests/unit/renderer/utils.test.ts (15 tests)
Test Files  1 passed (1)
Tests       15 passed (15)
```

---

## 3. E2E Tests (Playwright + Electron)

Playwright has first-class Electron support. It launches the real Electron app, interacts with its windows via the Chrome DevTools Protocol, and can call `ipcMain` handlers directly from test code.

### Prerequisites

Install Playwright (already in `devDependencies` if you ran `npm install`):

```bash
npm install   # installs @playwright/test
```

The renderer must be built before E2E tests run. The global setup does this automatically if `renderer/dist/` is missing.

### Running

```bash
# Headless (CI-style)
npm run test:e2e

# Interactive UI mode — shows a test browser with rerun controls
npm run test:e2e:ui

# Headed — watch the Electron window open and actions happen live
npm run test:e2e:headed

# Debug mode — pause on each step, inspect selectors
npm run test:e2e:debug
```

### What is tested

**`tests/e2e/app-launch.spec.ts`** — App startup

| Test | What it checks |
|---|---|
| Window opens and reaches idle state | `[data-testid="empty-state"]` is visible |
| Correct prompt text | "Click to browse for a video file" |
| Sidebar title | "Watermark Remover" |
| Export/Preview hidden in idle state | Buttons absent before file load |
| Window minimum size | ≥ 900×600 via `BrowserWindow.getSize()` |
| Context isolation enabled | `nodeIntegration = false` via `getWebPreferences()` |
| `electronAPI` exposed | `typeof window.electronAPI === 'object'` |
| All 12 API methods exposed | `typeof fn === 'function'` for each |

**`tests/e2e/ipc-bridge.spec.ts`** — IPC communication layer

| Test | What it checks |
|---|---|
| `dialog:openFile` returns null on cancel | Mock handler returns null |
| `dialog:saveFile` returns path on confirm | Mock handler returns a path |
| `job:cancel` is safe with no active job | Resolves without throwing |
| `PROGRESS:` events forwarded | `job:progress` IPC reaches renderer |
| `STATE:` events forwarded | `job:state` IPC reaches renderer |
| `STATE:meta:` events forwarded | `job:meta` IPC delivers full VideoMeta object |

**`tests/e2e/sidebar.spec.ts`** — Sidebar and UI state machine

| Test | What it checks |
|---|---|
| Browse hidden in idle state | `[data-testid="browse-output"]` not visible |
| Export disabled until both paths set | Mocks openFile + saveFile, asserts disabled→enabled |
| Method picker renders after load | All 4 radio labels visible |
| Error panel dismissed | Force `job:error` IPC, click Dismiss, panel hidden |

### Test Architecture

```
tests/e2e/
├── fixtures/
│   └── electron-fixture.ts   # Custom test() with electronApp + page fixtures
├── global-setup.ts            # Builds renderer/dist/ if missing
├── app-launch.spec.ts
├── ipc-bridge.spec.ts
└── sidebar.spec.ts
```

**`electron-fixture.ts`** provides two fixtures scoped to the worker (one Electron instance per spec file):

- `electronApp` — the `ElectronApplication` object; can call `evaluate()` to run code in the main process
- `page` — the first `BrowserWindow` as a Playwright `Page`; use standard locators and assertions

**Mocking IPC handlers in tests:**

```typescript
// Replace a real ipcMain handler with a mock
await electronApp.evaluate(({ ipcMain }) => {
  ipcMain.removeHandler('dialog:openFile');
  ipcMain.handle('dialog:openFile', async () => '/path/to/fake.mp4');
});
```

**Sending IPC events from main to renderer in tests:**

```typescript
await electronApp.evaluate(({ BrowserWindow }) => {
  BrowserWindow.getAllWindows()[0].webContents.send('job:progress', 42.5);
});
```

### Selectors Used (`data-testid` attributes)

| Attribute | Element |
|---|---|
| `empty-state` | Full-screen idle drop zone |
| `browse-output` | "Browse" button in Output row |
| `btn-export` | "Export" button |
| `btn-preview` | "Preview (3s)" button |
| `btn-cancel` | "Cancel" button in ProgressPanel |
| `progress-panel` | ProgressPanel wrapper |
| `done-panel` | DonePanel wrapper |
| `btn-reveal` | "Reveal in Finder" button |
| `error-panel` | Error message container |
| `dismiss-error` | "Dismiss" link inside error panel |
| `change-video` | "Change video" overlay button |

### Reports

After a run, open the HTML report:

```bash
npx playwright show-report
```

Screenshots and traces for any failures are saved to `test-results/`.

---

## 4. Environment Validation

Run this after initial setup and after any change to Python dependencies or FFmpeg version:

```bash
python scripts/validate_env.py
```

**What it checks:**

- Python version ≥ 3.11
- `cv2` (OpenCV) importable and version reported
- `numpy` importable
- `pydantic` importable
- `ffmpeg` executable found on system PATH via `shutil.which`
- `ffprobe` executable found on system PATH

**Expected output:**

```
✅ Python 3.x.x
✅ cv2 4.x.x
✅ numpy 2.x.x
✅ pydantic 2.x.x
✅ ffmpeg found at /opt/homebrew/bin/ffmpeg
✅ ffprobe found at /opt/homebrew/bin/ffprobe
EXIT:0
```

---

## 5. Build Validation

Confirm the TypeScript compiles and Vite bundles cleanly (catches type errors before they reach Electron):

```bash
npm run build
```

This runs:
1. `npm run build:renderer` — Vite bundles `renderer/src/` → `renderer/dist/`

**Expected output:** No errors. `renderer/dist/` contains `index.html` and bundled assets.

---

## 6. Test Architecture

### Why two separate test runners?

| Concern | Runner | Why |
|---|---|---|
| Python algorithms | pytest | Native Python; can import `cv2`, `numpy` directly |
| TypeScript utilities | vitest | Vite-native; knows the module graph; fast HMR-style reruns |

### `tests/conftest.py`

Inserts `backend/` onto `sys.path` so pytest can `import image_core` without installing the package:

```python
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'backend'))
```

### `renderer/vite.config.ts` — test config

```typescript
test: {
  globals: true,
  environment: 'jsdom',
  setupFiles: ['./src/test-setup.ts'],
  include: ['src/**/*.test.{ts,tsx}', '../tests/unit/renderer/**/*.test.ts'],
}
```

Vitest picks up test files from both `renderer/src/` and `tests/unit/renderer/` in a single run.

---

## 7. What is NOT yet tested (Post-MVP)

| Area | Status | Notes |
|---|---|---|
| `ff_utils.py` | Not covered | Requires a real video file; use `pytest-mock` to mock `subprocess.run` |
| `processor.py` | Not covered | Integration-level; needs temp PNG files |
| IPC bridge | ✅ Covered in E2E | `tests/e2e/ipc-bridge.spec.ts` |
| E2E (full workflow) | ✅ Covered | `tests/e2e/watermark-removal.spec.ts` — real Python pipeline |
| Integration | Not covered | `tests/integration/` stub |

### Adding a new backend test

1. Add a function starting with `test_` to `tests/unit/backend/test_image_core.py` (or create `test_ff_utils.py` in the same folder)
2. Run `npm run test:backend`

### Adding a new renderer test

1. Add a `.test.ts` file inside `renderer/src/` or `tests/unit/renderer/`
2. Run `cd renderer && npm run test:run`

---

## 8. CI/CD (GitHub Actions)

All tests run automatically in the [`.github/workflows/release.yml`](.github/workflows/release.yml) pipeline, which triggers on every version tag push (`v*`).

The `test` job (runs first, blocks all builds on failure):

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-python@v5
      - run: pip install -r backend/requirements.txt
      - run: python -m pytest tests/unit/backend -v
      - uses: actions/setup-node@v4
      - run: npm ci && npm ci --prefix renderer
      - run: npm run test:run --prefix renderer
```

After `test` passes, three platform builds run in parallel (`build-mac`, `build-win`, `build-linux`), and the `publish` job assembles the GitHub Release.

To trigger the pipeline:

```bash
npm version patch          # bumps version, creates tag
git push origin main --follow-tags
```

---

## Note: the file-manager reveal is suppressed under test

When an export finishes, the app reveals the output file in the OS file
manager. `electron/main.js` skips that when `NODE_ENV=test`, which every E2E
run sets.

The reason is not cosmetic. On a headless Linux runner — xdg-utils installed,
no desktop session behind it — `shell.showItemInFolder` leaves a helper process
that keeps Electron alive, so Playwright's `app.close()` never returns. That
failed the Ubuntu job during *teardown* even when every test passed, and it
consumed the whole test budget in `capture-screenshots.spec.ts`, which finishes
a real export of its own (3.0m against a 180s limit, then 7.0m against 420s).
macOS and Windows were unaffected, as both have a real file manager to hand the
path to.

`tests/e2e/renderer-flow.spec.ts` still verifies that a finished export asks to
reveal the file: it replaces the `shell:openPath` handler with its own recorder,
so it observes the request without the OS ever being involved.

---

## A note on language in tests

The app follows the host's system language on first run, so assertions on
visible text would otherwise depend on the machine running the suite. Both
Electron fixtures pin the locale to English before handing the window over;
`tests/e2e/i18n.spec.ts` drives the switcher itself and restores English
afterwards.

`tests/unit/renderer/i18n.test.ts` checks that `en.json` and `zh.json` define
exactly the same keys, with the same `{placeholders}` — that is what stops a
new English string shipping without its Chinese counterpart.
