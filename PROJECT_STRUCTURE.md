# Project Structure

Annotated map of every file and directory in the repository.

---

## Top-Level Layout

```
watermark-remove/
├── .github/
│   └── workflows/
│       └── release.yml     # GitHub Actions: test → build (mac/win/linux) → publish
├── electron/               # Electron main process (Node.js)
├── renderer/               # React UI (Vite + TypeScript)
├── backend/                # Python processing engine
├── tests/                  # All automated tests
├── scripts/                # Developer utility scripts
├── docs/
│   └── screenshots/        # App screenshots used in README
├── sample/                 # Sample video for development & testing
├── README.md               # Project overview, quick-start, and screenshots
├── CHANGELOG.md            # Version history (used in GitHub Releases)
├── HELP.md                 # End-user how-to guide
├── RELEASING.md            # Packaging, signing, and publishing guide
├── TESTING.md              # How to run tests
├── PROJECT_STRUCTURE.md    # This file
├── package.json            # Root workspace — Electron scripts & build config
├── package-lock.json
├── playwright.config.ts    # Playwright E2E test configuration
└── .gitignore
```

---

## `electron/` — Main Process

The Node.js process that owns the native window, all IPC handlers, and the Python child process.

```
electron/
├── main.js           # Entry point. BrowserWindow, IPC handlers, Python spawn
├── preload.js        # contextBridge — exposes window.electronAPI to the renderer
└── tsconfig.json     # TypeScript config for the electron/ directory
```

### Key responsibilities (`main.js`)

| IPC Channel | Direction | Purpose |
|---|---|---|
| `dialog:openFile` | renderer → main | Native video file picker |
| `dialog:saveFile` | renderer → main | Native Save As dialog |
| `shell:openPath` | renderer → main | Open output file in Finder/Explorer |
| `job:start` | renderer → main | Spawn Python process, begin job |
| `job:cancel` | renderer → main | SIGTERM active Python process |
| `job:progress` | main → renderer | Forward `PROGRESS:<n>` from stdout |
| `job:state` | main → renderer | Forward `STATE:<s>` from stdout |
| `job:preview-ready` | main → renderer | Forward `STATE:preview_ready:<path>` |
| `job:meta` | main → renderer | Forward `STATE:meta:<json>` (video metadata) |
| `job:done` | main → renderer | Forward `STATE:done:<path>` |
| `job:error` | main → renderer | Forward `ERROR:<msg>` from stdout |

### stdout protocol (parsed in `main.js`)

Python writes one of these prefixed lines per event. They are matched in specificity order (most specific first) to avoid prefix collisions.

Stages cross as keys rather than sentences: the interface is bilingual, and the backend cannot know which language the person watching reads. The renderer looks each key up in `renderer/src/i18n/*.json` under `stages.<key>` (see `renderer/src/stages.ts`), so the status line follows the language picker — mid-job included.

```
PROGRESS:<float>            e.g. PROGRESS:42.5
STATE:preview_ready:<path>  e.g. STATE:preview_ready:/tmp/abc.png
STATE:meta:<json>           e.g. STATE:meta:{"width":1920,...}
STATE:done:<path>           e.g. STATE:done:/Users/joe/Desktop/out.mp4
STATE:stage:<key>           e.g. STATE:stage:extractingFrames
STATE:<string>              a label with no translation; shown as it arrives
ERROR:<string>              e.g. ERROR:ffmpeg not found
DEBUG:<string>              logged only, not forwarded to renderer
```

---

## `renderer/` — React UI

A Vite-built React + TypeScript single-page app. In dev it runs at `http://localhost:5173`; in prod Electron loads `renderer/dist/index.html`.

```
renderer/
├── src/
│   ├── main.tsx                    # React entry point (ReactDOM.createRoot)
│   ├── App.tsx                     # Root component — layout, state machine, IPC wiring
│   ├── types.ts                    # Shared TypeScript types
│   ├── capabilities.ts             # Whether this machine can run the heavier methods
│   ├── utils.ts                    # Pure utility functions
│   ├── index.css                   # Global dark theme styles (Tailwind base)
│   ├── App.css                     # App-shell layout styles
│   ├── test-setup.ts               # Vitest global setup (@testing-library/jest-dom)
│   └── components/
│       ├── VideoCanvas.tsx         # Konva canvas — preview frame + ROI transformer
│       ├── MethodPicker.tsx        # Sidebar: radio group + dynamic method controls
│       ├── ProgressPanel.tsx       # Progress bar + Cancel button (processing state)
│       ├── DonePanel.tsx           # Completion view — output path + open button
│       └── EmptyState.tsx          # Idle state — drop zone / open prompt
├── public/
│   ├── favicon.svg
│   └── icons.svg
├── index.html                      # Vite HTML shell
├── vite.config.ts                  # Vite + Vitest config
├── package.json                    # Renderer dev/build/test scripts
├── tsconfig.json
├── tsconfig.app.json
├── tsconfig.node.json
└── eslint.config.js
```

### `App.tsx` — UI State Machine

The app moves through these states:

```
idle  →  loaded  →  processing  →  done
                         ↓
                       error
```

- **idle** — `EmptyState` shown; waiting for a file
- **loaded** — `VideoCanvas` + `MethodPicker` + sidebar metadata; preview_frame job fires automatically on load
- **processing** — `ProgressPanel`; full or preview job running
- **done** — `DonePanel`; output ready
- **error** — error message with dismiss

### `types.ts` — Key Interfaces

```typescript
ROI           { x, y, w, h }            // Video-space pixel coordinates
JobConfig     { inputPath, outputPath, roi, method, mode, temporalQuality, … }
VideoMeta     { width, height, fps, duration }
window.electronAPI  // All IPC bindings exposed by preload.js
```

### `utils.ts` — Pure Functions

| Function | Purpose |
|---|---|
| `normalizeCoordinates(x, y, w, h, scale)` | Convert canvas-space ROI → video-space pixels |
| `calcScaleFactor(videoW, videoH, containerW, containerH)` | Fit video into container maintaining aspect ratio |
| `formatDuration(seconds)` | `HH:MM:SS` string for the sidebar |
| `defaultOutputName(inputPath)` | `<name>_processed.mp4` suggestion for Save As |

---

## `backend/` — Python Processing Engine

Runs as a child process, receives a JSON job config on stdin, writes structured progress lines to stdout.

```
backend/
├── main.py           # Entry point — reads stdin, orchestrates pipeline
├── ff_utils.py       # All FFmpeg/FFprobe subprocess calls
├── image_core.py     # OpenCV removal algorithms + mask builder
├── temporal_core.py  # Flow-guided temporal inpainting (the `temporal` method)
├── processor.py      # multiprocessing.Pool dispatcher; exposes terminate() for SIGTERM cancel
├── requirements.txt  # Python dependencies
└── .venv/            # Virtual environment (not committed)
```

### `main.py` — Job Modes

| Mode | What it does |
|---|---|
| `preview_frame` | Extract single PNG at `min(5s, duration-0.5s)`, emit `STATE:meta:` + `STATE:preview_ready:` |
| `preview` | Extract a clip (1s by default, `previewSeconds` on the job) centred in the video, run the full pipeline on it, emit `STATE:preview_ready:` |
| `full` | Run full pipeline on entire video, emit `STATE:done:` |

All modes use a `try/except/finally` block. The `finally` runs `shutil.rmtree(temp_dir)` regardless of outcome.

### `ff_utils.py` — FFmpeg Wrappers

| Function | Description |
|---|---|
| `probe_video(path)` | ffprobe → `{width, height, fps, duration}` |
| `extract_preview_frame(path, out_path, t)` | Single PNG at timestamp `t` |
| `extract_frames(input, out_dir)` | All frames as `frame_%06d.png` |
| `extract_clip(input, out_path, start, duration)` | Short clip for preview mode |
| `reassemble_video(frames_dir, original, output, fps)` | 2-pass: encode + mux audio |

All calls use list-form `subprocess.run` (never `shell=True`).

### `image_core.py` — OpenCV Engines

| Function | Algorithm |
|---|---|
| `create_mask(W, H, x, y, w, h)` | Black numpy array with white rectangle at ROI |
| `process_inpaint(frame, mask, radius)` | `cv2.inpaint` TELEA algorithm |
| `process_blur(frame, x, y, w, h, kernel)` | `cv2.GaussianBlur` on extracted ROI sub-matrix |
| `process_solid_fill(frame, x, y, w, h, color)` | `cv2.rectangle` fill |
| `process_clone_stamp(frame, x, y, w, h, dx, dy)` | Block pixel copy from offset; raises `ValueError` if source OOB |
| `apply_removal(frame, mask, config, neighbor_at)` | Dispatcher — routes to the correct engine. `neighbor_at` is how the temporal engine reaches other frames; the rest ignore it |

### `temporal_core.py` — Temporal Inpainting

The only engine that reads more than the frame it is given. A watermark is
static and the picture behind it usually is not, so the background it hides is
visible in another frame; this recovers it instead of reconstructing it.

| Function | Purpose |
|---|---|
| `quality_settings(name)` | The `fast` / `balanced` / `quality` dial: reach, flow scale, fusion, feather |
| `flow_estimator(settings)` | DIS optical flow where the build has it, Farneback where it does not |
| `fit_affine_flow(flow, ring)` | Fits the motion on the clean ring around the selection, where the flow means something |
| `compose(first, second)` | Chains two frame-to-frame models into one, which is how a large displacement is reached by small measurable steps |
| `flow_residual(...)` | Checks a model against the ring before trusting it — a cut or a lost track fails here |
| `feather_alpha(...)` | The soft edge, ramped per side so a mark on the frame edge is still fully covered |
| `process_temporal(frame, mask, roi, neighbor_at, quality)` | The engine: walk outwards, sample, fuse, fall back to `process_inpaint` for anything uncovered |

The walk stops as soon as every pixel has enough samples, so the reach is a
limit rather than a cost. Neighbours are fetched through `neighbor_at`, which
the processor backs with lazy decoding, so frames the walk never needs are
never read.

### `processor.py` — Parallel Dispatcher

```python
run_batch(frame_paths, config)
```

Uses `multiprocessing.Pool(min(os.cpu_count(), frames))` with `imap_unordered` and `chunksize = workers * 4`. Each worker process loads an image, rebuilds the mask internally, applies removal, and saves back to disk. A batch of `SEQUENTIAL_FRAME_LIMIT` frames or fewer runs in the dispatcher process, where a pool could not repay starting its first worker.

A `temporal` batch takes a different route through the same pool. Each job
carries the paths of the neighbouring frames its quality setting can reach,
and results are written to a sibling `temporal_out/` directory, moved over the
originals only once every worker has finished: a frame is a neighbour of the
frames around it, and painting over it while they still need to read it would
feed each reconstruction the previous one's output. Neighbours are decoded on
demand, with a small per-worker cache (`WATERMARK_TEMPORAL_CACHE`), because
consecutive frames ask for nearly the same ones.

---

## `tests/` — Automated Tests

```
tests/
├── conftest.py                         # sys.path insert so pytest finds backend/
├── unit/
│   ├── backend/
│   │   ├── test_image_core.py          # pytest — mask + the single-frame engines
│   │   ├── test_temporal_core.py       # pytest — flow fitting, fusion, feathering, fallbacks
│   └── renderer/
│       └── utils.test.ts               # 15 vitest tests — all utility functions
├── integration/                        # reserved — not yet implemented
└── e2e/
    ├── fixtures/
    │   └── electron-fixture.ts         # Custom test() — electronApp + page fixtures
    ├── global-setup.ts                 # Builds renderer/dist/ if missing
    ├── app-launch.spec.ts              # 8 tests — startup, window size, API surface
    ├── ipc-bridge.spec.ts              # 6 tests — IPC channel correctness
    ├── sidebar.spec.ts                 # 4 tests — UI state machine
    ├── watermark-removal.spec.ts       # 1 test — real Python pipeline end-to-end
    └── capture-screenshots.spec.ts     # Generates docs/screenshots/*.png for README
```

See [TESTING.md](TESTING.md) for how to run these.

---

## `scripts/` — Developer Utilities

```
scripts/
└── validate_env.py     # Checks Python version, cv2, numpy, ffmpeg on PATH
```

Run after initial setup: `python scripts/validate_env.py`

---

## Data Flow Overview

```
User clicks "Export"
        │
        ▼
renderer/App.tsx
  window.electronAPI.startJob(config)
        │
        ▼ IPC: job:start
electron/main.js
  spawn python backend/.venv/bin/python backend/main.py
  write JSON to stdin
        │
        ▼ stdin
backend/main.py (Pydantic validates JobConfig)
  ff_utils.probe_video()          → STATE:meta:<json>
  tempfile.mkdtemp()              → creates /tmp/watermark_app_XXXX/
  ff_utils.extract_frames()       → PROGRESS:10
  processor.run_batch()           → PROGRESS:10–90 per frame
  ff_utils.reassemble_video()     → PROGRESS:90
  emit(STATE:done:<path>)            ← or STATE:preview_ready:<path>
  finally: shutil.rmtree(temp_dir)   ← always runs; cleans all intermediate files
        │
        ▼ stdout (line-by-line)
electron/main.js (parser)
  forwards to renderer via ipcMain.emit
        │
        ▼ IPC events
renderer/App.tsx
  updates progress bar / state / video metadata
```
