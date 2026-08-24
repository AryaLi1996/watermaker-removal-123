# Watermark Remover — User Guide

This guide walks you through using the app from start to finish.

---

## Step-by-step Workflow

### Step 1 — Open a Video

Click anywhere on the **"Click to browse for a video file"** welcome screen to open a file picker.

Alternatively, click the **Browse** button that appears once you are in the loaded state to switch to a different file, or use the **"Change video"** button in the top-right corner.

Supported formats: `.mp4`, `.mkv`, `.mov`, `.avi`

Once a file is loaded:
- A representative frame from the video appears on the canvas
- The sidebar shows the video's **resolution, frame rate, and duration**

---

### Step 2 — Draw the ROI Box

A selection box appears on the canvas. Drag it over the watermark you want to remove.

**Resize** — drag any of the 8 anchor handles (corners + sides)  
**Move** — click and drag the centre of the box  
**Precision** — zoom in using your OS window controls if the watermark is small

> **Tip:** The box snaps to the video frame boundary — you cannot drag it outside the frame.

---

### Step 3 — Choose a Removal Method

Select one of the four methods in the sidebar:

| Method | Best for | Parameter |
|---|---|---|
| **Inpaint (TELEA)** | Logos, text on complex backgrounds | **Radius** (1–20 px) — how far the algorithm reaches outside the box to sample texture. Start at 3. |
| **Gaussian Blur** | Censor-style obscuring, simple backgrounds | **Kernel Size** (3–99, odd numbers) — larger = heavier blur. 21 is a good start. |
| **Solid Fill** | Uniform / black-bar backgrounds | **Color** — pick the exact background colour. Use the eyedropper on the canvas if available. |
| **Clone Stamp** | Tileable textures (sky, grass, brickwork) | **dx / dy** — pixel offset to the source patch that will be copied into the watermark region. |

#### Which method should I pick?

- **Text or PNG logo on a gradient background** → Inpaint
- **"SAMPLE" text on a plain white/black bar** → Solid Fill
- **Security cam timestamp on a plain wall** → Clone Stamp (dx = 0, dy = -80 shifts up 80px)
- **You just want it blurry** → Blur with kernel 31+

---

### Step 4 — Preview (Recommended)

Click **"Preview (3s)"** to render a 3-second test clip around the 5-second mark.

- Processing takes 5–20 seconds depending on resolution
- The output plays back inline in the canvas area
- Adjust the method/parameters and re-preview as needed
- **No files are saved** during preview — it uses a temporary path

---

### Step 5 — Set Output Path

Click **"Browse"** in the Output row of the sidebar.

A native Save As dialog opens, pre-filled with `<original_name>_processed.mp4`.  
Choose any location and click Save.

---

### Step 6 — Export

Click **"Export"** to run the full render.

- Progress is shown in the progress bar (0–100%)
- You can click **"Cancel"** at any time — processing stops within ~3 seconds and all temp files are cleaned up
- When complete, the **Done** panel appears with the output file path and an **"Open in Finder / Explorer"** button

---

## Troubleshooting

### The canvas is blank after opening a file

FFmpeg extracts a preview frame on load. If it's blank, the video may start with a black leader — the frame is taken at `min(5s, duration - 0.5s)`.  
**Fix:** The canvas still works. Draw your box and proceed.

### "FFmpeg not found" error

FFmpeg must be on your system PATH.  
- **macOS:** `brew install ffmpeg`  
- **Windows:** Download from [ffmpeg.org](https://ffmpeg.org/download.html) and add the `bin/` folder to your PATH environment variable  
- **Linux:** `sudo apt install ffmpeg` or `sudo dnf install ffmpeg`

Verify: open a terminal and run `ffmpeg -version`.

### Inpainting leaves artifacts / blurry region

- Increase the **Radius** parameter (try 5–7)
- Make sure the ROI box is tight around the watermark — do not include large amounts of clean background
- On very complex textures, **Clone Stamp** often gives cleaner results

### Clone Stamp looks wrong

The dx/dy offset must point to a region with similar texture. If the source region is outside the frame bounds, the job will error. Try smaller offsets (±20–50px first).

### Export is very slow

Normal. Processing time scales with resolution × frame count. Rough guide:
- 1080p 30fps 1 min ≈ 2–4 minutes on a modern 8-core CPU
- 4K 30fps 1 min ≈ 8–15 minutes

All CPU cores are used automatically via `multiprocessing.Pool`.

### The app crashes on launch / "Python not found"

Run the environment validator:

```bash
python scripts/validate_env.py
```

This checks that the `.venv` exists, all Python packages are installed, and `ffmpeg` is on PATH.

---

## Keyboard Shortcuts

| Action | Shortcut |
|---|---|
| Cancel job | `Esc` (while exporting) |

---

## Supported Codecs (Output)

The app always outputs **H.264 in an MP4 container** (CRF 18 — visually lossless quality).  
Input can be any codec FFmpeg can decode (H.264, H.265/HEVC, VP9, AV1, ProRes, etc.).

Audio is copied without re-encoding. If the source has no audio track, the output will be silent — no error.
