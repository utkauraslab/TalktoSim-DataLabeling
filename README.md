# FrameLab · Video Annotation Workspace

**Open the website: https://utkauraslab.github.io/TalktoSim-DataLabeling/**

No installation, GitHub account, or repository clone is required. The website now uses a **clip-first workflow**: upload a video → drag the playhead and click Split → drag dividers to fine-tune clip boundaries → confirm clips → label each clip.

Doctors can preview clips, remove cuts, undo changes, and revisit segmentation with **Edit clips**. Unchanged intervals keep existing annotations; resetting annotations on affected clips requires confirmation. Class, Tension, Other/custom classes, X/Y/T/Z/O custom fields, local exports, and optional authorized GitHub uploads remain available. Existing frame projects remain readable.

Clip exports contain `videos`, `clips`, `categories`, `annotations`, and `events`, with clip IDs and start/end times in original-video seconds. Local ZIPs include `clips.json` and labels, with the original video optionally included under `source/`. Separate trimmed MP4s are not generated. Clip GitHub submissions contain JSON only and never upload the original video.

The source video, segmentation and labels autosave in this browser/device, subject to browser storage capacity. Download a backup before clearing browser data or switching devices. H.264 MP4 is recommended.

The published website source is on the [`gh-pages` branch](https://github.com/utkauraslab/TalktoSim-DataLabeling/tree/gh-pages). The Python app below is the optional local edition for developers.

## Optional GitHub upload (website)

Open **Export / upload → Optional: upload labeling to GitHub**. Select the upload scope, optionally include frame images, explicitly check the authorization box, and provide a GitHub token restricted to this repository with **Contents: read and write**. The on-page help provides a token-creation link. The GitHub account must have repository write access; organization approval may be required. Local downloads need no authorization or GitHub account.

Authorized submissions are committed to `main` under `labeling/annotator_UTC-time/`, for example `labeling/Alice_2026-11-03T23-30-45-123Z/`. Each folder contains `annotations.json`, `events.json`, and `submission.json`; clip projects also include `clips.json`. Legacy frame projects may include `dataset.zip` if images were selected. Each uploaded file is limited to 50 MiB; larger datasets can be downloaded locally. Class, all custom fields, annotator and timestamps are preserved. Names support Unicode, with unsafe path characters replaced.

The repository is **public**, so the upload screen asks permission to publish the selected labels and optional images. The original video is never uploaded. Upload consent is off by default and resets for every attempt; without consent, no GitHub authorization or upload request is sent. Completing frames and downloading files never upload automatically. Tokens are used only in memory for the current upload, sent only to GitHub, and never stored in the browser or repository. Existing submission folders are never overwritten; concurrent commits preserve repository history.

See the [website source and authorization guide](https://github.com/utkauraslab/TalktoSim-DataLabeling/blob/gh-pages/README.md) for details. The Python local edition below does not require GitHub access.

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
3. Add one or more event annotations to a frame. Each record contains **Class**, **Event ID**, **Time**, and the structured **X/Y/T/Z/O** fields below. Choose Class from the dropdown, or select **Other — enter your own** and fill in **Custom class**. Previously saved classes in the project become reusable dropdown choices. The initial options are starter categories, not a fixed clinical ontology.
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

Each X/Y/T/Z/O section has **+ Other · Add a custom field**. Enter a field name and a text value; add more rows or remove a row with ×. For example, adding `xxx` in Intention with value `my note` exports `"Z": {"intended_goal": "...", "goal_type": "...", "source": "...", "xxx": "my note"}`. Custom fields persist through autosave, reopening, Copy previous, and both JSON exports. Field names must be unique within their section, must not duplicate standard fields, and may contain up to 80 characters. Values allow up to 2,000 characters, with at most 50 custom fields per section. Empty custom values can be saved as drafts; fill them in or remove them before marking complete. Custom classes are exported as the actual entered Class/category name.

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
