# TalktoSim FrameLab website

**Open the website: https://utkauraslab.github.io/TalktoSim-DataLabeling/**

Add one clip, label and save it, then add the next. No installation or GitHub account is required for local work. All videos and annotations stay on this device unless an optional upload is authorized.

## PDF-based doctor workspace

The upload page and annotator input are retained. Clip projects open a three-row workspace matching the supplied design.

1. **Add Clip / Delete Clip:** the original video is on the left with +1/−1, +5/−5, +30/−30 and custom +x/−x second buttons. Drag the timeline, click **Set clip start**, seek again and click **Set clip end**, then **Done!** to create the clip. Overlaps are allowed. A scrollable two-column video gallery and dropdown on the right select the current clip. **Delete Clip** asks before removing that clip and its media; other clips are preserved.
2. **Clip video + labels:** click one Action (A), one Tool (X), and one Tissue (Y). **Other +** opens a short input; **Add option** adds a reusable button, which you then click to select. Options persist with the project. Goal (I) and Outcome (O) use audio recordings, with Record, Stop, playback, re-record and Remove controls. Browser microphone permission is required, and recordings are limited to three minutes / 20 MB each. Drafts save locally. **Save** requires all three selections and both recordings, then displays **Done!**. No text transcription is required or performed.
3. **One-frame regions:** this row appears only for the **Tension** and **Exposure** actions. Scrub the clip, then click green **Go** (goal) or pink **Go** (avoid) to freeze one frame. Click at least three vertices on the image; a polygon closes automatically. Use the matching **Save goal areas / Save avoid areas** button. Multiple polygons can share that same frame. **Redo** clears only the corresponding color. Choosing a different frame asks before replacing both sets of regions. Finish with the main **Save** button to mark the updated clip Done.

### Local saving, recovery and exports

Videos, choices, audio, selected frame and polygons stay in this browser/device. **Download progress** produces a portable JSON backup containing the actual recordings and frame image, as well as project metadata. Restore it with the original video on the upload page. The original video is kept separately. JSON-only `annotations.json` imports restore labels/regions as drafts; use the progress backup to restore the actual media. Existing frame projects remain readable. Older clip labels are retained as legacy data and can supply initial choices in the new UI.

Version **4.0** datasets include `videos`, `clips`, `categories`, `annotations` and `events`. Each annotation contains single-valued `action`, `tool`, `tissue`, `goal_audio` / `outcome_audio` media references, and optionally `region` with one clip-relative `timestamp`, original image dimensions and normalized `[x,y]` polygons under `goal` and `avoid`. `frame_image` points to the unpainted source frame; polygons are stored separately. Clip boundaries remain source-video seconds, while event/frame times begin at clip second 0. Previous XYTZO exports remain available as preserved `legacy_labels`.

Local ZIP exports include JSON, `audio/`, `images/` and a README. Source video inclusion is optional for local ZIP only. Separate trimmed MP4s are not generated. JSON-only exports reference media and do not contain its bytes. **Finish project** enables optional authorized GitHub upload. For this interface, uploads include JSON plus `recordings.zip` containing audio and annotated frames; the source video is never uploaded. The authorization screen explicitly names these media types. Each uploaded file must fit the 50 MiB GitHub upload limit. Nothing uploads automatically.

## Optional GitHub upload

After **Finish project**, in **Export / upload**, expand **Optional: upload labeling to GitHub**.

1. Choose reviewed clips only (default). Doctor projects include recordings and the selected annotation frame in `recordings.zip`. Legacy frame projects can separately opt into a frame-image ZIP.
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
    ├── recordings.zip    # doctor audio and selected annotation frames
    └── dataset.zip       # legacy frame projects, when images are selected
```

The folder is `annotator_UTC-time`, with millisecond precision. Names support Unicode; path separators and unsafe characters are replaced, and long names are shortened. `submission.json` records annotator, upload time, GitHub account, selected scope, explicit consent, and file names. Existing folders are never overwritten. Clip submissions record `unit_type: clips` and `clip_count` in their manifest. Each submission becomes one atomic commit on `main`; concurrent updates retry without forcing or replacing repository history. Website code remains on `gh-pages`.

Each upload file is limited to 50 MiB. For larger image datasets, upload JSON labels only and download the full ZIP locally. If authorization is missing, expired, pending organization approval, or lacks write permission, local downloads remain available. Closing the export dialog cancels further upload requests; if the commit was already sent, check the repository.

GitHub references: [fine-grained token setup](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens), [Git blob permissions](https://docs.github.com/en/rest/git/blobs#create-a-blob).

## Annotation schema and examples

The new English doctor interface uses A/X/Y selections and I/O audio. Tension and Exposure are Actions. Older XYTZO annotations and custom fields remain preserved in backups and legacy export data. Exports preserve `event_id`, `time`, `X`, `Y`, `T`, `Z`, `O`, Class, annotator, review status, and edit timestamps. COCO-compatible tables are provided for frame-level semantics; detection boxes are not generated.

Use an H.264 MP4 for broad compatibility. Keep the tab open during extraction. Supported codecs, storage limits, and maximum video sizes depend on the browser/device. Export a dataset before clearing browser data or switching devices.

## Development verification

The site is static HTML/CSS/JS. Install test dependencies with `npm install` and run `npm test` using Node 22+; Python 3 is used for independent ZIP integrity checks. Tests cover incremental overlapping clips, draft disk backup/restore, project completion upload gating, legacy clip partitions, annotation preservation when boundaries change, source-video persistence, clip time validation, version-1 database migration, legacy frame sampling, JSON/ZIP export, custom fields, authorization gating, token handling, optional images, repository permissions, folder collisions, and concurrent Git commits. GitHub upload tests use mocked API calls and never upload test labels or real credentials to the repository.
