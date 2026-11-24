# OSplit Web

OSplit Web is a browser-based stem separation PWA. Audio inference runs locally
in a worker using WebGPU when supported and WebAssembly otherwise. Projects,
source audio, stems, and cached models are stored in browser IndexedDB.

## Run locally

The ONNX models in `models/` are stored with [Git LFS](https://git-lfs.com/).
Install Git LFS before cloning, or fetch the models in an existing clone:

```powershell
git lfs install
git lfs pull
```

The dev server and build stop with an error if the models are still LFS pointer
files.

Use Deno 2.9+ from this directory:

```powershell
deno install
deno task dev
```

Run the checks and production build with:

```powershell
deno task check
deno task test
deno task build
```

The build copies the models (about 410 MB total: both Spleeter qualities and
the Demucs model) from this repository's `models/` folder into `dist/models`, with `models.json` listing each model's
size and SHA-256. Models are downloaded and cached individually in the browser
when first used; downloads are checked against `models.json`, and a model whose
checksum changes is downloaded again.

## Testing

`deno task test` runs the unit tests (Vitest). The browser tests (Playwright,
headless Chromium) run against two production builds: one at the root served
with the cross-origin isolation headers, like nginx, and one under
`/osplit-web/` served without them, like GitHub Pages:

```bash
deno task build
BASE_PATH=/osplit-web/ deno task build --outDir dist-pages
npx playwright install chromium
npx playwright test
```

They separate a short generated clip with the real models, so the first run
takes a minute or two. CI runs both suites on every pull request.

`e2e/csp.spec.ts` runs separately, against the Docker image, and fails on any
Content-Security-Policy violation. CI runs it after building the image; run it
locally with the container started (see Docker below):

```bash
DOCKER_URL=http://localhost:8080/ npx playwright test
```

The URL-download part needs internet access (it loads Pyodide from jsDelivr);
set `NO_EXTERNAL_NETWORK=1` to skip it.
The PWA can be deployed independently as a static site; production deployment
requires HTTPS and the cross-origin isolation headers documented below.

## Browser and storage limitations

Use a current Chrome, Edge, Firefox, or Safari release. Model inference may be
slow or exceed memory limits on mobile devices. Browser storage limits vary.

Each project picks a separation model; the project page shows whether WebGPU
is available:

- **Demucs v4** (`htdemucs_6s`): six stems (vocals, guitar, piano, drums,
  bass, other) and clearly better separation, but slower than Spleeter (about
  1.2× Spleeter on a Radeon RX 7800, more on weaker GPUs), and its
  piano stem is weak. It needs WebGPU and never runs on the
  CPU; it is the default for new projects where WebGPU is available. The first
  run downloads 115 MB.
- **Spleeter**: five stems (vocals, piano, drums, bass, other), fast, on any
  device: WebGPU when available, otherwise the WebAssembly CPU provider. The
  first run downloads 197 MB (FP32). Projects saved with the former Low
  quality (FP16) option separate with these files too.

The ONNX Runtime is downloaded as well. Separating again with the other model
replaces all of the project's stems. `scripts/export-htdemucs.py` converts
Demucs to the ONNX file in `models/htdemucs_6s` and checks it; see
`docs/htdemucs-6s-plan.md`.

Processing runs in a worker while the app is open. Browsers can suspend or
terminate tabs, so work is not guaranteed to continue after leaving or closing
the app. A stopped task is marked interrupted and can be restarted; source audio
and completed project data remain stored locally.

The browser yt-dlp runtime requires JavaScript Promise Integration and a
network connection. Browser-only retrieval is subject to CORS and site
restrictions; YouTube and many providers may fail. OSplit does not use a proxy
or send media to a processing server. Importing a local audio file is the
reliable alternative. yt-dlp browser runtime prerequisites: Chrome 137+,
Firefox 153+, or Safari 27+. Downloaded runtime updates are checked against
the SHA-256 digest published by PyPI.

Projects are scoped to this browser profile and device. Clearing site data
removes them; export the ones to keep as project files first (see below). OSplit asks the browser to preserve its storage when supported,
but browser quota and eviction policies still apply. Stems are stored as
lossless FLAC, typically about half the size of WAV. Exports are FLAC by
default, or WAV when chosen in the mixer, and are saved through the browser's
download handling.

## Moving projects between devices

**Export project file** (on a project page, or *Export* in the project list)
saves a project as one `.osplit` file: its source audio (when kept), stems,
waveforms, tempo and chord analysis with your corrections, and its mixer and
practice settings. Models are not included; the other device downloads them
only if it separates again. A file is about the size of the stems plus the
source, roughly 100 MB for a 4-minute song.

Move the file any way you like (AirDrop, a USB drive, a synced cloud folder,
email for short tracks), then open it with **Import project file** on the
project list, by dropping it on the app, or with "Open with OSplit" where the
installed app handles `.osplit` files. Importing a project that is already on
the device asks whether to replace it or keep both. Files are checked when
imported: a damaged file is refused, and an export made mid-separation comes
back as interrupted. The files also work as backups.

The file is a ZIP archive (uncompressed) with an `osplit.json` manifest; see
`src/project-file.ts` for the layout. Files from a newer version of OSplit ask
for an update rather than importing partly.

### Cloud sync (Dropbox, OneDrive)

Optionally, projects sync to the user's own Dropbox or OneDrive. The panel
appears only in builds made with an app id (below). **Connect Dropbox** or
**Connect OneDrive** signs in on the provider's page and comes back; OSplit
then sees only its own app folder there (`Apps/<app name>/`).

- **Sync now** uploads projects changed on this device and updates projects
  changed on another one: the most recent change wins. With **Sync
  automatically** (on by default) a sync also runs when the app opens and
  when you leave a project.
- Projects that are only in the cloud are listed under *In Dropbox, not on
  this device*, to **Download** when wanted, so a sync doesn't fill a phone's
  storage. Deleting a project here asks whether to delete its cloud copy too.
- Projects being separated sync after they finish. Models are never
  uploaded.
- Each project is a folder: `project.json` (the project file manifest, plus
  each file's SHA-256) and its files under `blobs/`, named by content. A
  change to the mixer or the grid uploads only `project.json`, and a download
  reuses the files the device already has. Every downloaded file is checked
  against its hash. See `src/cloud/sync.ts`.

Sign-in uses OAuth 2.0 with PKCE and a redirect, with no backend and no
client secret. The tokens are kept in the browser's local storage. Dropbox
keeps the app signed in until you disconnect. Microsoft limits single-page
apps to 24-hour sign-ins, so OneDrive asks you to sign in again after a day
without use; signing in again is usually one click.

To offer cloud sync in your deployment, register an app with each provider
and build with its id (these are public ids, not secrets):

- **Dropbox** ([App Console](https://www.dropbox.com/developers/apps)):
  Scoped access, *App folder*. Under Permissions enable
  `files.metadata.read`, `files.content.read` and `files.content.write`.
  Under OAuth 2 add the site URL (with its trailing slash, e.g.
  `https://example.com/` or `https://user.github.io/osplit-web/`) as a
  redirect URI and allow PKCE ("Allow public clients"). Build with
  `VITE_DROPBOX_APP_KEY=<app key>`.
- **OneDrive** ([Microsoft Entra app registrations](https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade)):
  supported accounts *Personal Microsoft accounts and accounts in any
  organizational directory*; platform **Single-page application** with the
  site URL as the redirect URI; delegated Microsoft Graph permission
  `Files.ReadWrite.AppFolder`. Build with
  `VITE_ONEDRIVE_CLIENT_ID=<application (client) id>`, and
  `VITE_ONEDRIVE_TENANT=consumers` for an app registered for personal
  accounts only.

The GitHub Pages workflow reads `DROPBOX_APP_KEY` and `ONEDRIVE_CLIENT_ID`
from the repository's Actions variables; the Docker build takes them as build
arguments (`--build-arg VITE_DROPBOX_APP_KEY=…`). For local development, put
them in `.env.local`. The Content-Security-Policy already allows the
requests (`connect-src https:`).

## Practice tools

A separated project opens on its practice view: the chord chart in the
middle, the mixer beside it (the **Mixer** tab on a phone, a panel that opens
and closes on a narrow desktop window), and the player at the bottom.
Above the chart, chips open the **Speed**, **Key** and **Loop** panels:
popovers on a desktop, sheets from the bottom on a phone. The player's click
button turns the click on or off; the arrow beside it (on a phone, a long
press, or the tempo line under the title) opens **Rhythm**.

The player can slow down or speed up a track (50–150%, with presets) without
changing its pitch, shift its key (±12 semitones) without changing its speed,
and repeat an A–B loop. Speed, key and loop are saved with each project.

- **Chord chart:** the song in bars of the beat grid, four a row (eight a
  line on a wide window), with the chords of each bar and the song's peaks
  behind them. The bar playing is highlighted with its beats, and the chart
  follows it while playing. Click a bar to go to it; Shift-click a bar to
  loop from the bar playing to that one. Without a beat grid, the chart lists
  the chords in time order.
- **Loop:** the Loop button in the player (or `L`) loops 4 bars from the
  playhead (4 s without a beat grid) when there is no loop, and otherwise
  turns it on or off. The Loop panel sets A and B at the playhead, loops 1,
  2, 4 or 8 bars from the playhead, and clears the loop. The loop shows on the
  seek bar. Seeking after the loop end jumps to the loop start.
- **Mixer:** a volume, mute and solo for each stem and, once the beats are
  known, the click. *Full mix*, *No vocals* and *Drums + bass* set the mutes
  and volumes in one go; any change after that makes the mix custom.
- **Export:** the Export panel exports the mix, one stem, all stems (zip) or
  the chords. With *With speed, key & loop* on, the exported mix (alone or in
  the zip) uses the project's speed and key, and covers only the loop when it
  is on. Stem exports are never changed.

Key and speed changes go through a pitch shifter,
[Signalsmith Stretch](https://signalsmith-audio.co.uk/code/stretch/) (MIT),
running as an AudioWorklet. It is loaded the first time it is needed, adds
about 120 ms of delay (the position shown allows for it), and is bypassed at
the original speed and key. Decoded playback changes the speed of the sources
and lets the shifter correct the pitch; streaming playback (long tracks on
low-memory devices) lets the browser keep the pitch and only shifts the key.
Loops are seamless with decoded playback; with streaming playback, the jump
back to the loop start leaves a short gap.

### Tempo, beat grid and click

After each separation, OSplit finds the tempo, the beats and the bar starts
in the stems, on the device, in a worker (a few seconds for a 4-minute track).
Projects separated before this offer to detect it in the chord chart. The analysis is stored with the project and redone when its stems
change.

- **Tempo:** the header shows the tempo, and the tempo heard at the current
  speed (for example "120 → 102 BPM" at 85%). The Rhythm panel corrects the
  grid: ×2 / ÷2, 3 or 4 beats per measure, bar 1 a beat earlier or later, tap
  the tempo, use the detected tempo again, or detect it again.
- **Click:** a click track on every beat, accented on bar starts, off by
  default. The click button in the player, the switch in Rhythm and the M of
  the Click row in the mixer are the same on/off, and Rhythm's volume is the
  Click row's. It follows the speed and the loop, is added to the exported
  mix when it is heard, and goes in the zip as `<name>-click.<format>`.

Accuracy: the analysis follows the drum stem (all stems when the drums are
silent) and tracks tempo drift in live playing. Half or double tempo errors
happen; ×2 / ÷2 is one click away. Music without a steady pulse shows *No
beat*, or a low-confidence grid marked with a question mark; tap tempo
replaces it with an even grid. With decoded playback the click is
sample-accurate; with streaming playback it can be some 30 ms off, as the
position of streaming audio is reported less precisely. A browser tab in the
background can delay or drop clicks.

### Key and chords

The same analysis finds the song's key and a chord timeline, from the stems
without the drums (bass, piano and other, with the vocals quieter). Having
stems helps here: percussion is the main source of noise when telling notes
apart. The tuning is measured first, so songs tuned to A = 432 Hz or a little
off still work.

- **Key:** the header shows the song's key, and the key heard with the key
  shift (for example "A minor → B minor"). The Key panel shifts the key with
  − / + or a grid of the twelve keys, sets the song's key yourself (or picks
  the second most likely key, often the relative major or minor), and has
  *Show chords in the new key*; off, the chords keep their original names.
- **Chords now:** beside the chips, the chord at the playhead, large, and the
  next three.
- **Export:** *Chord chart (.txt)* writes a chord sheet, four bars a line
  (`| Am    | F     | C     | G     |`), named as shown. *.lab file* writes
  `start end label` lines (MIREX format, such as `A:min`) for DAWs and
  analysis tools.

Accuracy: chords are simplified to major and minor triads (with inversions
such as C/E when the bass makes them clear); sevenths, suspended and
diminished chords show as their nearest triad. A key can be confused with
its relative major or minor (shown as the alternative) or a neighbour on the
circle of fifths; set it in the panel if so. Modal, atonal or very sparse
music shows *Key unclear*. A key change held for 16 bars or more is listed in
the panel.

Keyboard shortcuts on the practice view (not while typing in a field or on a
focused slider):

| Key | Action |
| --- | --- |
| Space | Play or pause |
| ← / → | Previous or next bar (5 s without a beat grid) |
| ↑ / ↓ | Speed +5% / −5% |
| L | Turn the loop on or off (makes one when there is none) |
| Home | Back to the start |
| Esc | Close the open panel |

## Installing the app

Installed from the browser (Install app, or Add to Home Screen), OSplit opens
in its own window and works offline once the models are cached. In Chromium
browsers the installed app also:

- appears in the system share sheet on Android: sharing an audio file to
  OSplit creates a project from it;
- can open audio files from the desktop ("Open with OSplit").

Both need the app to be installed and are not available in Firefox or Safari.
In any browser, dropping an audio file on the project list creates a project,
and dropping one on a project replaces its source audio. A project can delete
its source audio once separation succeeds, to save space; separating it again
then needs the file imported again.

The PNG icons in `public/icons/` are generated from `public/icon.svg`; run
`node scripts/icons.mjs` after changing the SVG.

For further browser details, see
[`public/README-web.html`](./public/README-web.html).

## Production deployment

The PWA is a static site; it needs no application server or database. Build it
with `deno task build`, then publish the contents of `dist/` to a static host
over HTTPS. By default the build expects the domain root (for example,
`https://osplit.example.com/`). To serve it from a sub-path, set `BASE_PATH`
when building:

```powershell
$env:BASE_PATH = "/osplit-web/"; deno task build
```

The host should send these headers on the app and model responses:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

They enable cross-origin isolation, which lets the WebAssembly fallback use
several CPU threads. If the host cannot send them, the service worker adds
them (see GitHub Pages below); without isolation the app still works, but CPU
separation runs on a single thread and is slower. The build
contains around 295 MB of model files, plus the ONNX Runtime WASM asset and
yt-dlp wheel; check the host's upload, storage, and individual-file size limits.
Hashed files under `assets/` can be cached for a long time. Model URLs are
stable across releases, so use a shorter cache lifetime for them; keep
`index.html`, `sw.js`, and `manifest.webmanifest` revalidating so users receive
app updates.

### GitHub Pages

The CI workflow deploys to GitHub Pages on every push to `main`, after the
checks pass. Enable it once under the repository's **Settings → Pages →
Source: GitHub Actions**. The workflow sets `BASE_PATH` from the Pages
configuration, so both project sites (`https://<user>.github.io/<repo>/`) and
custom domains work.

GitHub Pages cannot send the cross-origin isolation headers above, so the
service worker adds them to the responses it serves. The first visit is not
isolated yet: the app reloads once when the service worker takes control, and
later visits, offline ones included, are isolated. A browser that ignores
headers added by a service worker is reloaded at most once and then runs CPU
separation on a single thread.

Each new user downloads 98–197 MB of models, which counts towards GitHub
Pages' soft bandwidth limit of 100 GB per month.

### Nginx and Docker

For Nginx, the included [`deploy/nginx.conf`](./deploy/nginx.conf) demonstrates
the required headers and cache behavior. If configuring another static host,
apply equivalent rules to its responses. Every response also gets the headers
in [`deploy/security-headers.conf`](./deploy/security-headers.conf):

```text
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://cdn.jsdelivr.net; …
```

The policy allows jsDelivr scripts (Pyodide and the FFmpeg core used by URL
downloads), `connect-src https:` (URL downloads fetch the page entered) and
inline style attributes. With `nosniff`, the declared types matter: serve
`.mjs` as JavaScript (ONNX Runtime loads one as a module) and `.wasm` as
`application/wasm`. The Docker build also writes gzip copies of the `.wasm`
files (`PRECOMPRESS=1`), which nginx sends with `gzip_static`: the ONNX Runtime
download shrinks from about 29 MB to about 7 MB. GitHub Pages can't send these
headers, so the Pages site has no Content-Security-Policy.

After deployment, verify that the homepage, `/sw.js`, `/manifest.webmanifest`,
`/yt-dlp/wheel.json`, and at least one file under `/models/` load successfully
over HTTPS and that the required headers are present. Then test a real stem
separation in a supported browser. URL downloads remain best-effort because
browser CORS and provider restrictions still apply.

### Docker

[`Dockerfile`](./Dockerfile) builds the PWA and serves it with unprivileged
Nginx on port 8080. The final image uses Alpine; Deno is only in the build
stage. The web repository includes its own model files, so build it from this
directory:

```powershell
docker build -t osplit-web .
docker run --detach --name osplit-web --publish 8080:8080 --restart unless-stopped osplit-web
```

The container serves HTTP. Put it behind a TLS reverse proxy or load balancer
for public production use. Port 8080 is available for local smoke testing at
`http://localhost:8080`. The build context/image includes the ONNX models
(about 410 MB), in addition to the ONNX Runtime WASM asset and yt-dlp wheel.

## Models

The separation models are the pretrained 5-stems models of
[Spleeter](https://github.com/deezer/spleeter) by Deezer Research, converted to
ONNX: one model per stem (vocals, piano, drums, bass, other), in full (FP32)
precision. Like the original models, they cover frequencies up
to about 11 kHz, so separated stems contain nothing above that.

Spleeter and its models are released under the MIT License by Deezer SA; see
[`models/LICENSE-SPLEETER`](./models/LICENSE-SPLEETER), which the build also
publishes next to the models. If you use OSplit in research, cite Spleeter:

> Romain Hennequin, Anis Khlif, Felix Voituret, Manuel Moussallam.
> "Spleeter: a fast and efficient music source separation tool with
> pre-trained models." *Journal of Open Source Software*, 5(50), 2154, 2020.

The Demucs model is the pretrained `htdemucs_6s` model of
[Demucs v4](https://github.com/facebookresearch/demucs) by Meta AI Research,
converted to ONNX in full precision (FP32) by
[`scripts/export-htdemucs.py`](./scripts/export-htdemucs.py). It produces six
stems (vocals, guitar, piano, drums, bass, other) over the full frequency
range. Demucs is released under the MIT License by Meta Platforms; see
[`models/LICENSE-DEMUCS`](./models/LICENSE-DEMUCS). If you use it in research,
cite Demucs v4:

> Simon Rouard, Francisco Massa, Alexandre Défossez. "Hybrid Transformers for
> Music Source Separation." *ICASSP 2023*.

## License

The OSplit Web code is released under the [MIT License](./LICENSE). The models
are covered by the Spleeter and Demucs licenses above. Pitch shifting uses Signalsmith
Stretch by Geraint Luff, released under the MIT License.
The app bundles the Inter and Space Grotesk fonts (`src/fonts/`), both under
the SIL Open Font License 1.1; their licenses are next to the files. They are
served from the app itself, so the Content-Security-Policy's `font-src 'self'`
holds, and the service worker caches them for offline use.
