# Plan: UI revamp

This plan turns the "OSplit UI Revamp" design canvas
(<https://claude.ai/artifact/DpA2xT8eqQAc8nZ9yuFVb3>) into a series of pull
requests. The canvas holds the mockups for desktop and mobile; this file says
what each screen reuses, what is new, and in which order to build it.

OSplit's rules still hold:

- separation and analysis run on the device, with no processing server;
- the app keeps working offline once installed (cloud sync, to the user's own
  Dropbox or OneDrive, is optional);
- both playback engines keep working (`BufferEngine` and `MediaEngine`);
- the static site still deploys under the strict CSP.

The app is not public yet, so stored data may change without migrations where
this plan says so.

---

## Screens

| Screen | Desktop | Mobile | Status |
| --- | --- | --- | --- |
| Library | List of projects, search, filters, storage, sync column | Cards, floating **New split** button | Rebuild of `src/view/projects.ts` |
| New split | Dialog over the library | Full-height sheet | Merges "create project" and "add audio" into one step |
| Splitting in progress | Page with steps and progress | Same, one column | New view over the existing separation task |
| Practice: chords | Chord chart, markers column, mixer on the right, player at the bottom | Chord chart, player above the tab bar | Rebuild of `src/view/detail.ts`, `harmony.ts`, `practice.ts`, `tempo.ts` |
| Practice: mixer | Panel beside the chart | **Mixer** tab | Rebuild of `src/view/mixer.ts` |
| Speed, Key, Rhythm, Add marker | Popovers | Bottom sheets | Same controls on both |
| Export | Popover from the header | Sheet from the **Export** tab | Rebuild of the export controls in `mixer.ts` |
| Project menu | Popover from ⋯ | Action sheet | New |
| Settings | Page | Page | New; takes over the yt-dlp button from the projects screen |

Navigation: desktop has a left rail with Library, New split and Settings.
Mobile has the library as its home, and inside a project the tabs
**Chords / Mixer / Export**. The old Models tab is gone: model management
lives in Settings.

---

## What each control maps to

Existing means the logic is already in the app and only the UI changes.

### Practice

| Control | Status | Where it lives today |
| --- | --- | --- |
| Chord chart, 4 bars per row (mobile) or 8 with section breaks (desktop) | New layout, existing data | `src/analysis/chord-sheet.ts`, `harmony.ts` |
| Song peaks behind each bar | New layout, existing data | `src/peaks.ts` |
| Click a bar to seek; shift-click to loop to it (desktop) | New | `waveform-seek` today |
| Speed slider, ±5 %, presets | Existing | `speed`, `speed-step` |
| Key shift, ±1, key grid | Existing | `key-step` |
| Chord names in the new key (switch) | Existing | `chord-names` original / transposed |
| Song key: set by hand, use the detected alternative | Existing | `key-select`, `key-alternative` |
| Tempo ÷2 / ×2, tap tempo, back to detected | Existing | `tempo-factor`, `tempo-tap`, `tempo-reset` (`GridEdits`) |
| Bar 1 starts earlier / later | Existing | `tempo-downbeat` (`GridEdits.downbeatShift`) |
| Beats per measure 3/4 and 4/4 | Existing | `tempo-metre` (`BeatsPerBar`) |
| Beats per measure 2/4, 5/4, 6/8, 7/8 | **New** | `BeatsPerBar` is `3 \| 4` |
| Click on/off = the Click row's M in the mixer | Existing, now one state | mixer `click` track |
| Click volume = the Click row's slider | Existing, now one state | mixer `click` track |
| Accent on beat 1 (switch) | **New switch**; the accent itself exists | `src/player/click.ts` always accents |
| Subdivision (8ths, triplets, 16ths) | **New** | — |
| Count-in (off, 1 bar, 2 bars) | **New** | — |
| A–B loop, loop on/off | Existing | `loop-set`, `loop-toggle`, `loop-clear` |
| Loop 1 / 2 / 4 / 8 bars from the playhead | Existing, **not drawn yet** | `loop-bars` — keep it, e.g. in the Loop chip |
| Markers, jump, loop a section | **New** | — |
| Capo | **New**, not specified yet | — |
| Mix presets (Full mix, No vocals, Drums + bass) | **New** | — |
| Announce chord changes | Existing, **not drawn yet** | `announce-chords` — keep it, in the Key sheet or Settings |

### Library, new split, settings

| Control | Status | Where it lives today |
| --- | --- | --- |
| Project status: ready, separating, interrupted, empty | Existing | `ProjectStatus`, `taskProgress` |
| Resume an interrupted split | Existing | separation task |
| Search and filters | **New** | — |
| File or link as the source | Existing | `import`, `download-url` |
| Model choice: Spleeter or Demucs | Existing | `model` |
| Spleeter quality | **Removed** (see below) | `quality` |
| Analysis after the split | Existing, now always on | `analyze` |
| Delete the original audio when done | Existing, moved to the progress screen | `delete-source-option` |
| Cancel a split | Existing | `cancel` |
| Rename a project | **New** | — |
| Delete a project | Existing, now with a confirmation | `delete` |
| Models: downloaded or not, delete, download | **New UI**; caching exists | `src/models.ts`, `storage.ts` |
| WebGPU status | Existing | `src/gpu.ts` |
| yt-dlp update | Existing, moved to Settings | `yt-update` |
| Connect Dropbox or OneDrive, disconnect | Existing | `cloud-connect`, `cloud-disconnect` (`src/cloud/`) |
| Sync now, sync automatically | Existing | `cloud-sync`, `setAutoSync` |
| Sync state per project: synced, changed, this device only | Existing | `cloudState()` |
| Cloud-only projects: download, remove from the cloud | Existing | `cloud-download`, `cloud-remove` |
| Automatic sync only for projects in both places | **Change** | `planSync()` also uploads projects that are only on this device |
| Upload one project, download one project (manual) | Upload is **new**; download exists | `uploadProject()`, `cloud-download` |
| "Add to the cloud when done" in New split | **New** | upload after the split and analysis |
| "Remove from this device" (keeps the cloud copy) | **New** | delete the local copy only |
| Cloud storage: used, total, free, and OSplit's share | **New** | provider quota API; OSplit's share is the sum of `RemoteProject.size` |
| Export and import a project file (.osplit) | Existing | `export-project`, `import-project`; now in the ⋯ menu and the library header |

### Export

| Control | Status | Where it lives today |
| --- | --- | --- |
| One stem, several stems (zip), all stems | Existing; choosing a subset is **new** | `export-stem`, `export-all` |
| Mix of what you hear | Existing | `export-mix` |
| Mix with speed, key and loop | Existing | `export-practice` |
| FLAC or WAV | Existing | `export-format` |
| Chords as .txt | Existing; markers as headings are **new** | `export-chords` |

---

## Data model changes

`Project` (`src/types.ts`) gains optional fields; no migration is needed, as
with `soloStems`.

- `markers?: { bar: number; name: string }[]` — sorted by bar. A marker's loop
  runs from its bar to the bar before the next marker, or to the end. Presets
  in the Add marker sheet only fill in the name; nothing else is stored.
  Markers are stored by bar, so they follow speed changes. When
  `GridEdits.downbeatShift` or `bpmFactor` changes, bar numbers change
  meaning: store the marker's time as well and snap it to the nearest bar when
  the grid changes.
- `clickAccent?: boolean` (default true), `clickSubdivision?: 1 | 2 | 3 | 4`,
  `countInBars?: 0 | 1 | 2` — only if those features are kept (see open
  questions).
- `BeatsPerBar` widens if more time signatures are kept. 6/8 and 7/8 need the
  grid to know the beat unit, not only the count.
- No sync field is needed: `cloudState()` in `src/cloud/cloud.ts` already gives
  each project's state from the last sync.

Spleeter low quality goes away: remove `models/fp16/`, the `fp16` entry in
`src/memory.ts` and the quality buttons. Keep reading old projects whose
`quality` is `fp16`; they show as plain "Spleeter". The `quality` field can
then be dropped from new projects.

---

## Pull requests

Each one ships with unit tests, Playwright coverage (`e2e/`) and README
updates where behaviour changes, as earlier milestones did.

1. **Shell and design tokens.** Colours, type (Inter, Space Grotesk) and
   spacing as CSS custom properties in `src/style.css`; the desktop rail and
   mobile layouts; routing between library, project and settings. No feature
   changes.
2. **Library and new split.** New library list and cards, search and filters,
   the one-step New split (file or link, name, model). Remove Spleeter low
   quality in the same PR.
3. **Splitting in progress.** The steps view over the existing separation and
   analysis tasks, Cancel, and "delete the original audio when done".
4. **Practice view.** Chord chart with peaks, player bar, mixer panel and tab,
   and the Speed, Key and Rhythm sheets and popovers wired to the existing
   logic (including tempo ÷2 / ×2 / tap, song key, and loop N bars). The click
   on/off and the Click row's mute become one state.
5. **Markers.** Data, chart headings, marker strip (mobile) and column
   (desktop), scrub-bar ticks, section loops, Add marker; rename and delete
   by long-press or context menu (not drawn yet).
6. **Export and project menu.** The shared Export panel, the ⋯ menu, rename,
   delete with confirmation; markers as headings in the .txt chord chart.
7. **Settings.** Storage, models (delete and download), WebGPU status, yt-dlp.
8. **Rhythm extras** (only those kept): more time signatures, accent switch,
   subdivision, count-in.
9. **Cloud sync.** Sync exists (the user's own Dropbox or OneDrive; there is
   no OSplit account or backend). Changes:
   - Automatic sync and **Sync now** only update projects that are both on
     this device and in the cloud: `planSync()` stops uploading projects
     that have no cloud copy. Upload and download stay manual, per project.
   - Per-project **Upload** (new, around `uploadProject()`) and
     **Download** (exists).
   - "Add to the cloud when done" in New split: upload once the split and
     analysis finish, then the project syncs automatically.
   - "Remove from this device": delete the local copy; the project becomes
     cloud only.
   - Sync states in the library: synced, changed (not synced yet), this
     device only, cloud only, uploading, downloading.
   - Settings: "Connected to Dropbox as …", Disconnect, cloud storage (used,
     total, free, OSplit's share), "Sync automatically", **Sync now** and the
     last sync time. Quota needs a new call per provider (Dropbox
     `users/get_space_usage`, OneDrive `GET /me/drive` `quota`), added to the
     `CloudStore` interface.
   - The .osplit project file: **Save as project file** in the ⋯ menu,
     **Import project file** in the library header.

PRs 1 to 7 change no stored data except markers and the dropped quality;
8 adds features, and 9 changes how sync chooses what to upload.

---

## States not drawn yet

Design these as part of the PR that needs them:

- empty library on first launch;
- a split that failed (today: `ProjectStatus` `failed`);
- no WebGPU: the Demucs card disabled, with the reason;
- not enough storage, before and during a split;
- a link download that failed;
- a project opened before analysis finishes: no chords, bars or markers yet;
- not connected to a cloud (Settings shows Connect Dropbox / Connect
  OneDrive; the library hides sync icons), the connection expired
  (`needsReconnect`), or offline, with projects that are cloud only;
- renaming and deleting a marker;
- a tablet width, between the mobile and desktop layouts.

---

## Open questions

- Which rhythm extras to keep: time signatures beyond 3/4 and 4/4,
  subdivision, the accent switch, count-in.
- What Capo does: shows chord shapes for a capo position without changing the
  audio, like the "chords in the new key" switch?
- Mix presets: fixed, or saved by the user?
- Cloud: when "Sync automatically" is off, does "Add to the cloud when
  done" still upload? (The mockups assume yes: it is a one-off upload.)
- Cloud: a project changed on two devices before a sync. Today the newest
  `updatedAt` wins; keep that, or warn?

---

## Tests

- Unit: marker ordering, section ranges and the marker loop rule; markers
  after a downbeat shift or tempo ×2; one click state for the mixer and the
  rhythm controls; export file naming for a stem subset.
- Playwright: open a project, jump to a marker, loop a section, change speed
  and key from the sheets, export a stem subset, cancel a split, delete a
  project with confirmation, on desktop and on a phone viewport.
