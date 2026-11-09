# TalktoSim FrameLab website

**Open the website: https://utkauraslab.github.io/TalktoSim-DataLabeling/**

Add one clip, label and save it, then add the next. No installation or GitHub account is required for local work. All videos and annotations stay on this device unless an optional upload is authorized.

## Doctor workflow: one clip at a time

1. Upload the video and enter your annotator name. No clips are generated automatically.
2. Click **Add a clip**, drag the Start and End sliders or enter exact seconds, preview the interval, and click **Add this clip → Label**. Each interval is independent: overlaps and unannotated gaps are allowed. Minimum clip duration is 0.25 seconds.
3. Fill in Class and X/Y/T/Z/O. **Save clip locally** stores an unfinished draft; edits also autosave. **Save & complete this clip** validates the full record. Click **Add a clip** whenever you want another interval. Existing clips are preserved.
4. Use **Download progress** to save a resumable JSON file on disk. The same browser can reopen projects directly from **Recent projects** after interruption. To restore from a file, choose **Resume saved labeling**, the progress JSON (or complete `annotations.json` dataset), and the original video. The video filename, duration and dimensions must match. Import creates a new local project without overwriting existing work. Progress files contain labels and boundaries, not the video; keep the original separately.
5. When all added clips are reviewed, click **Finish project**. This saves completion locally and enables the optional GitHub upload. Adding a clip or editing labels returns the project to work in progress. Nothing uploads automatically. Dataset downloads and progress backups remain available before finishing.

Event start/end must lie inside its clip. Outcome evidence can occur later in the source video; use **Review full video** to inspect it. Times use seconds from the original video start; playback times display hours for long recordings.

The source video is stored in IndexedDB for playback after reopening. Browser storage must have enough free space for it; unsupported codecs or insufficient space produce an actionable error. Original frame projects from previous releases remain readable and exportable. New projects use clip annotation.

### Clip export schema

Clip exports use version 3.0: `videos`, `clips`, `categories`, `annotations`, and `events`. Each clip has a stable `clip_id`, source `video_id`, `start` and `end` times, duration, annotator and review state. Each event references its clip; action start/end must lie inside the clip, while later outcome evidence may lie elsewhere in the same video.

The ZIP contains `clips.json`, `annotations.json`, `events.json`, and a README. An optional **Include source video in the local ZIP** adds the original under `source/`. Clip boundaries are stored as exact time ranges; separate re-encoded MP4 files are not generated. Local archives support ZIP64 for large source files, subject to browser/device limits. GitHub uploads include clip JSON only; the source video is never uploaded. Legacy frame exports retain their existing format.

## Optional GitHub upload

After **Finish project**, in **Export / upload**, expand **Optional: upload labeling to GitHub**.

1. Choose reviewed clips only (default), or include drafts. Legacy frame projects may optionally include frame images; new clip projects upload JSON only.
2. Read the destination and public-data notice. Check **I authorize uploading…** only if you want to share that data in the repository.
3. Provide your own repository-scoped GitHub authorization token. The on-page help links to GitHub token creation: choose resource owner **utkauraslab**, **Only select repositories → TalktoSim-DataLabeling**, and **Contents: read and write**. Organization approval may be required. The GitHub account must already have write access to this repository; a token cannot grant access the account does not have.
4. Click **Authorize & upload to GitHub**. A successful upload returns a link to its repository folder.

Without authorization, no account lookup or upload request is sent to GitHub. Completing frames and clicking local downloads do not trigger uploads. Consent is reset for each export session and after every upload attempt. Tokens are sent only to GitHub's HTTPS API, remain in memory only for that attempt, and are cleared from the input on upload, dialog close, and authorization revocation. They are never written to IndexedDB, localStorage, sessionStorage, JSON exports, or the repository. No repository owner credential is embedded in the website.

This repository is **public**. Authorized uploads may be viewed by anyone. Labels include the source video filename, annotator information, Class, custom fields, and timestamps; the submission manifest also records the authorized GitHub account. Frame images are included only when separately selected. The original source video is never uploaded.

### Naming and files

```text
labeling/
└── Alice_2026-11-03T23-30-45-123Z/
    ├── annotations.json
    ├── events.json
    ├── clips.json        # clip projects
    ├── submission.json
    └── dataset.zip       # only when images are selected
```

The folder is `annotator_UTC-time`, with millisecond precision. Names support Unicode; path separators and unsafe characters are replaced, and long names are shortened. `submission.json` records annotator, upload time, GitHub account, selected scope, explicit consent, and file names. Existing folders are never overwritten. Clip submissions record `unit_type: clips` and `clip_count` in their manifest. Each submission becomes one atomic commit on `main`; concurrent updates retry without forcing or replacing repository history. Website code remains on `gh-pages`.

Each upload file is limited to 50 MiB. For larger image datasets, upload JSON labels only and download the full ZIP locally. If authorization is missing, expired, pending organization approval, or lacks write permission, local downloads remain available. Closing the export dialog cancels further upload requests; if the commit was already sent, check the repository.

GitHub references: [fine-grained token setup](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens), [Git blob permissions](https://docs.github.com/en/rest/git/blobs#create-a-blob).

## Annotation schema and examples

The English interface includes Class presets (including Tension), Other/custom classes, a downloadable event example, and additional named fields within each X/Y/T/Z/O group. Exports preserve `event_id`, `time`, `X`, `Y`, `T`, `Z`, `O`, Class, annotator, review status, and edit timestamps. COCO-compatible tables are provided for frame-level semantics; detection boxes are not generated.

Use an H.264 MP4 for broad compatibility. Keep the tab open during extraction. Supported codecs, storage limits, and maximum video sizes depend on the browser/device. Export a dataset before clearing browser data or switching devices.

## Development verification

The site is static HTML/CSS/JS. Install test dependencies with `npm install` and run `npm test` using Node 22+; Python 3 is used for independent ZIP integrity checks. Tests cover incremental overlapping clips, draft disk backup/restore, project completion upload gating, legacy clip partitions, annotation preservation when boundaries change, source-video persistence, clip time validation, version-1 database migration, legacy frame sampling, JSON/ZIP export, custom fields, authorization gating, token handling, optional images, repository permissions, folder collisions, and concurrent Git commits. GitHub upload tests use mocked API calls and never upload test labels or real credentials to the repository.
