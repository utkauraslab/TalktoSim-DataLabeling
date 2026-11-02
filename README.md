# FrameLab · Video Annotation Workspace

An English-language, local web app for turning videos into annotated image datasets.
Upload a video → select a sampling interval → annotate each frame → export JPG images and JSON.

## Start

On macOS, double-click **start.command**. It starts the local server and opens your browser.
The first run requires Python 3.10+ and an internet connection to install dependencies. FFmpeg is bundled with `imageio-ffmpeg`.

```bash
cd /Users/snow/Desktop/talktosim/label
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python app.py
```

Open http://127.0.0.1:5055. Keep the terminal running; Ctrl+C stops the server.
For another port, run `PORT=5056 .venv/bin/python app.py` and open that port.

## Annotate

1. Upload a video and enter an annotator name or ID.
2. Choose the interval: **1 s** means one frame per second; **0.5 s** means two frames per second. Custom intervals range from 0.04 to 3600 seconds. Images retain the original resolution. Limits: 20 GB per video and 50,000 frames per project.
3. Add one or more event annotations to a frame. Each record contains **Class**, **Event ID**, **Time**, and the structured **X/Y/T/Z/O** fields below.
4. Edits autosave as drafts after a short delay. Every nonempty annotation needs a Class to save. All fields must be filled to mark a frame complete. To record a negative example, remove all annotations and mark the frame complete.
5. Use **Copy previous**, the unreviewed filter, or arrow keys to navigate. Ctrl/⌘ + Enter completes the frame and advances. Editing a reviewed frame returns it to draft status.
6. Export all frames (including drafts) or reviewed frames only.

| Group | Fields |
| --- | --- |
| Identity | `event_id`, `class` |
| Time | `start`, `end`, `outcome_observed_at` |
| X · Instrument | `instrument` |
| Y · Action | `action`, `direction` |
| T · Target | `anatomy`, `region` |
| Z · Intention | `intended_goal`, `goal_type`, `source` |
| O · Outcome | `observed_effect`, `goal_achieved`, `evidence_interval`, `source` |

All times are numeric seconds relative to the uploaded video's start, including the outcome observation and evidence interval. They may extend beyond the current sampled frame. The server checks that times are within the source video, start ≤ end ≤ outcome observation, and evidence start ≤ evidence end. A zero timestamp is valid. Drafts may contain blank fields, represented by empty strings or null times. Source fields are entered by the annotator; the app does not verify their provenance.

## Annotation example

Click **View annotation example** on the home page or in the annotation panel to view and download the supplied reference record. The full, unmodified reference is also in [static/example.json](static/example.json).

The example describes grasper retraction of the gallbladder fundus from 42.0 to 49.5 seconds, with an outcome observed at 52.0 seconds. It is a reference only and never populates real labels automatically. Use the actual video when entering values. Class remains an additional dataset category, for example `anatomical_exposure`.

## Export formats

```text
 dataset-xxxxxxxx.zip
 ├── images/
 │   ├── 000001.jpg
 │   └── 000002.jpg
 ├── annotations.json
 ├── events.json
 └── README.txt
```

- **Images + JSON (ZIP)** includes all selected images and both JSON files.
- **Dataset JSON only** exports the full dataset object without image binaries.
- **Event JSON only** exports an array of nested records matching the example, with additional `class`, `image_id`, `annotator`, `updated_at`, and `reviewed` metadata.

`annotations.json` uses COCO-compatible `images`, `annotations`, and `categories` tables, extended with nested event records. Each annotation includes `event_id`, `time`, `X`, `Y`, `T`, `Z`, `O`, and `class`; `image_id` connects it to an image. The top-level `events` array matches `events.json`. Legacy `attributes` are retained as a compact projection for existing consumers. This is frame-level semantic data, without detection boxes or segmentation; strict COCO detection trainers need an adapter.

`info` records source video, sampling interval, and schema version (2.0). Categories are generated from Class names with deterministic alphabetical IDs. `reviewed=false` indicates a draft; a reviewed image without annotations is an explicit negative example. Event IDs are user-entered and can repeat across frames for the same event; use `(image_id, event_id)` to resolve frame-specific records. JSON-only exports refer to the image paths available in the corresponding ZIP.

Existing projects with flat five-field labels remain readable. Their semantic values are mapped to the new fields; unavailable timing, direction, region, and provenance fields remain blank rather than being invented. Fill them before marking an edited record complete. Backups are recommended before upgrading a stored dataset.

## Storage and privacy

Everything persists under `data/<project ID>/`: source video, extracted JPGs, and `project.json`. Reopen a project from the sidebar after closing the browser. Back up the entire `data/` directory to retain original videos and labels. Exported ZIPs omit source videos. Set `LABEL_DATA_DIR` to use another storage location.

Each frame records the latest annotator and UTC edit time. There is no multi-user edit history, login, or collaborative conflict handling; this app is intended for one annotator at a time on one computer. The server listens only on 127.0.0.1. After dependency installation, the app requires no external services or web assets.

Image timestamps describe a regular sampling grid starting at zero; FFmpeg selects nearby decoded frames. Precision is limited by source frame rate; these are not original PTS values. If extraction fails or the server stops, the project displays an error and can be recreated by uploading again. Large videos require disk space for source video, extracted images, and temporary ZIP archives.

## Tests

```bash
.venv/bin/pip install pytest
.venv/bin/python -m pytest -q
```

Tests cover video extraction at 0.5/1 s intervals, frame timestamps, persistence, multiple labels, negative examples, annotator metadata, JSON/ZIP export, complete nested event round trips, partial drafts, zero/invalid timestamps, legacy labels, invalid uploads, and the English reference UI.
