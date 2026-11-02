# OSplit Web

OSplit Web is a browser-based stem separation PWA. Audio inference runs locally
in a worker using WebGPU when supported and WebAssembly otherwise. Projects,
source audio, stems, and cached models are stored in browser IndexedDB.

## Run locally

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

The build copies both model qualities (about 295 MB total) from this repository's
`models/` folder into `dist/models`. Models are downloaded and cached
individually in the browser when first used.
The PWA can be deployed independently as a static site; production deployment
requires HTTPS and the cross-origin isolation headers documented below.

## Browser and storage limitations

Use a current Chrome, Edge, Firefox, or Safari release. Model inference may be
slow or exceed memory limits on mobile devices. The first run downloads about
98 MB for Low quality (FP16) or 197 MB for High quality (FP32), plus the ONNX
Runtime. Browser storage limits vary.

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
but browser quota and eviction policies still apply. Exported WAV files are
saved through the browser's download handling.

For further browser details, see
[`public/README-web.html`](./public/README-web.html).

## Production deployment

The PWA is a static site; it needs no application server or database. Build it
with `deno task build`, then publish the contents of `dist/` to a static host
over HTTPS. Deploy it at the domain root (for example,
`https://osplit.example.com/`): worker, model, and yt-dlp asset URLs are
root-relative, so a subdirectory deployment needs path configuration changes.

The host must send these headers on the app and model responses:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

They enable cross-origin isolation used by the browser runtime. The build
contains around 295 MB of model files, plus the ONNX Runtime WASM asset and
yt-dlp wheel; check the host's upload, storage, and individual-file size limits.
Hashed files under `assets/` can be cached for a long time. Model URLs are
stable across releases, so use a shorter cache lifetime for them; keep
`index.html`, `sw.js`, and `manifest.webmanifest` revalidating so users receive
app updates.

For Nginx, the included [`deploy/nginx.conf`](./deploy/nginx.conf) demonstrates
the required headers and cache behavior. If configuring another static host,
apply equivalent rules to its responses.

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
`http://localhost:8080`. The build context/image includes roughly 295 MB of
ONNX models, in addition to the ONNX Runtime WASM asset and yt-dlp wheel.
