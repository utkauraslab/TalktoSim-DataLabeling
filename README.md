# TalktoSim FrameLab website

**Open the website: https://utkauraslab.github.io/TalktoSim-DataLabeling/**

Choose a video, select a sampling interval, annotate events, and download a JPG/JSON dataset. No installation, repository clone, or GitHub account is needed for local annotation and downloads. Videos are processed in your browser. Frames and labels autosave on this browser and device.

## Optional GitHub upload

In **Export / upload**, expand **Optional: upload labeling to GitHub**.

1. Choose reviewed frames only (default), or include drafts. Optionally include frame images in `dataset.zip`; images are off by default.
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
    ├── submission.json
    └── dataset.zip       # only when images are selected
```

The folder is `annotator_UTC-time`, with millisecond precision. Names support Unicode; path separators and unsafe characters are replaced, and long names are shortened. `submission.json` records annotator, upload time, GitHub account, selected scope, explicit consent, and file names. Existing folders are never overwritten. Each submission becomes one atomic commit on `main`; concurrent updates retry without forcing or replacing repository history. Website code remains on `gh-pages`.

Each upload file is limited to 50 MiB. For larger image datasets, upload JSON labels only and download the full ZIP locally. If authorization is missing, expired, pending organization approval, or lacks write permission, local downloads remain available. Closing the export dialog cancels further upload requests; if the commit was already sent, check the repository.

GitHub references: [fine-grained token setup](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens), [Git blob permissions](https://docs.github.com/en/rest/git/blobs#create-a-blob).

## Annotation schema and examples

The English interface includes Class presets (including Tension), Other/custom classes, a downloadable event example, and additional named fields within each X/Y/T/Z/O group. Exports preserve `event_id`, `time`, `X`, `Y`, `T`, `Z`, `O`, Class, annotator, review status, and edit timestamps. COCO-compatible tables are provided for frame-level semantics; detection boxes are not generated.

Use an H.264 MP4 for broad compatibility. Keep the tab open during extraction. Supported codecs, storage limits, and maximum video sizes depend on the browser/device. Export a dataset before clearing browser data or switching devices.

## Development verification

The site is static HTML/CSS/JS. Install test dependencies with `npm install` and run `npm test` using Node 22+; Python 3 is used for independent ZIP integrity checks. Tests cover sampling schedules with mocked decoding, IndexedDB persistence, JSON/ZIP export, custom fields, authorization gating, token handling, optional images, repository permissions, folder collisions, and concurrent Git commits. GitHub upload tests use mocked API calls and never upload test labels or real credentials to the repository.
