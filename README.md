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
  1.2× Spleeter High quality on a Radeon RX 7800, more on weaker GPUs), and its
  piano stem is weak. It needs WebGPU and never runs on the
  CPU; it is the default for new projects where WebGPU is available. The first
  run downloads 115 MB.
- **Spleeter**: five stems (vocals, piano, drums, bass, other), fast, on any
  device: WebGPU when available, otherwise the WebAssembly CPU provider. The
  first run downloads about 98 MB for Low quality (FP16) or 197 MB for High
  quality (FP32).

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
removes them. OSplit asks the browser to preserve its storage when supported,
but browser quota and eviction policies still apply. Stems are stored as
lossless FLAC, typically about half the size of WAV. Exports are FLAC by
default, or WAV when chosen in the mixer, and are saved through the browser's
download handling.

## Practice tools

The project player can slow down or speed up a track (50–150%) without
changing its pitch, shift its key (±12 semitones) without changing its speed,
and repeat an A–B loop. Speed, key and loop are saved with each project.

- **Loop:** set the start (A) and end (B) at the playhead, or drag across a
  waveform or the strip above the stems to draw a loop. Drag its handles to
  adjust it; a click still seeks. Seeking after the loop end jumps to the
  loop start.
- **Export:** with *Mix with speed, key & loop* ticked in the mixer, the
  exported mix (alone or in the zip) uses the project's speed and key, and
  covers only the loop when it is on. Stem exports are never changed.

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
Projects separated before this ask for it with **Find tempo** in the practice
bar. The analysis is stored with the project and redone when its stems
change.

- **Tempo chip:** shows the tempo, and the tempo heard at the current speed
  (for example "♩ 120 → 102 BPM" at 85%). It opens a panel to correct the
  grid: ×2 / ÷2, 3 or 4 beats per bar, move the bar start a beat earlier or
  later, tap the tempo, undo the corrections, or analyze again.
- **Beat grid:** beats and bar lines are drawn over the waveforms, with bar
  numbers in the strip above the stems.
- **Snapping and bar loops:** dragged loop edges snap to the nearest beat
  (hold Alt for bars, Shift for no snapping). The *Bars* buttons loop 1, 2 or
  4 bars from the bar at the playhead.
- **Click:** a click track on every beat, accented on bar starts, with its own
  row in the mixer (volume, solo, on/off; off by default). It follows the
  speed and the loop, is added to the exported mix when it is heard, and goes
  in the zip as `<name>-click.<format>`.

Accuracy: the analysis follows the drum stem (all stems when the drums are
silent) and tracks tempo drift in live playing. Half or double tempo errors
happen; ×2 / ÷2 is one click away. Music without a steady pulse shows *No
beat found*, or a low-confidence grid that loops don't snap to; tap tempo
replaces it with an even grid. With decoded playback the click is
sample-accurate; with streaming playback it can be some 30 ms off, as the
position of streaming audio is reported less precisely. A browser tab in the
background can delay or drop clicks.

Keyboard shortcuts on a project page (not while typing in a field):

| Key | Action |
| --- | --- |
| Space | Play or pause |
| ← / → | Seek 5 s back or forward |
| Home | Back to the start |
| M / S | Mute or solo the focused stem row |
| `-` / `=` | Speed −5% / +5% |
| `,` / `.` | Key down / up a semitone |
| `0` | Reset speed and key |
| `[` / `]` | Set the loop start / end at the playhead |
| L / Shift+L | Turn the loop on or off / clear it |
| ← / → on a loop handle | Move it 0.1 s (Shift: 1 s) |
| B | Loop the current bar; again to double the loop |
| C | Turn the click on or off |
| T | Tap the tempo (with the tempo panel open) |

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
and half (FP16) precision. Like the original models, they cover frequencies up
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
