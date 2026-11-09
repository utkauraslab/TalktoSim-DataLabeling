# TalktoSim FrameLab website

**Open the website: https://utkauraslab.github.io/TalktoSim-DataLabeling/**

Choose a video, drag timeline dividers to define clips, label each clip, and export the dataset. No installation, repository clone, or GitHub account is needed for local annotation and downloads. Videos, cut positions and labels are stored on this browser and device. Nothing is shared without your optional GitHub upload authorization.


## Doctor workflow: split first, then label clips

1. **Upload video** and enter the doctor / annotator name. New projects open the full video directly; there is no frame-frequency setting.
2. **Split into clips**: drag the playhead to a boundary and click **Split** (shortcut **S**). Drag the vertical dividers to adjust cuts. Select a divider to remove it, type an exact time, or use arrow keys for 0.1-second adjustments (Shift + arrow: 1 second). **Undo** restores a previous partition. Click a clip in the list to preview that range.
3. **Confirm clips → Annotate** opens a video player for each clip. **Play this clip** starts at its beginning and stops at its end. Use **Review full video** to inspect outcome evidence later in the recording. The clip selector and Previous / Next controls navigate between clips.
4. Choose a Class and fill in X/Y/T/Z/O fields and optional custom fields. Selecting a Class prefills the event ID and the clip's start/end times. Outcome and evidence times remain doctor-entered and can extend beyond the action clip, within the source video. Times always refer to the beginning of the original video. Complete each clip, then download or optionally authorize a GitHub upload.

Cuts cover the entire video without gaps or overlaps. Each clip is at least 0.25 seconds (a shorter video can remain one clip), with up to 2,000 clips. Cut positions autosave, so segmentation can be resumed. **Edit clips** reopens the timeline: unchanged intervals keep their clip IDs, labels and review states; changes affecting annotated or reviewed clips require explicit confirmation before clearing only those affected annotations.

The source video is stored in IndexedDB for playback after reopening. Browser storage must have enough free space for it; unsupported codecs or insufficient space produce an actionable error. Original frame projects from previous releases remain readable and exportable. New projects use clip annotation.

### Clip export schema

Clip exports use version 3.0: `videos`, `clips`, `categories`, `annotations`, and `events`. Each clip has a stable `clip_id`, source `video_id`, `start` and `end` times, duration, annotator and review state. Each event references its clip; action start/end must lie inside the clip, while later outcome evidence may lie elsewhere in the same video.

The ZIP contains `clips.json`, `annotations.json`, `events.json`, and a README. An optional **Include source video in the local ZIP** adds the original under `source/`. Clip boundaries are stored as exact time ranges; separate re-encoded MP4 files are not generated. Local archives support ZIP64 for large source files, subject to browser/device limits. GitHub uploads include clip JSON only; the source video is never uploaded. Legacy frame exports retain their existing format.

## Optional GitHub upload

In **Export / upload**, expand **Optional: upload labeling to GitHub**.

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

The site is static HTML/CSS/JS. Install test dependencies with `npm install` and run `npm test` using Node 22+; Python 3 is used for independent ZIP integrity checks. Tests cover clip partitions, annotation preservation when boundaries change, source-video persistence, clip time validation, version-1 database migration, legacy frame sampling, JSON/ZIP export, custom fields, authorization gating, token handling, optional images, repository permissions, folder collisions, and concurrent Git commits. GitHub upload tests use mocked API calls and never upload test labels or real credentials to the repository.
