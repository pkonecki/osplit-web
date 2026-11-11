import { createHash } from "node:crypto";
import {
  cpSync,
  createReadStream,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const webDirectory = dirname(fileURLToPath(import.meta.url));
const modelRoot = resolve(webDirectory, "models");
const ytDlpRoot = resolve(
  webDirectory,
  "node_modules",
  "@project516",
  "yt-dlp-wasm",
  "dist",
);
/**
 * Path the site is served from, from the BASE_PATH environment variable:
 * "/" by default, or e.g. "/osplit-web/" for a GitHub Pages project site.
 */
function basePath(value: string | undefined): string {
  const trimmed = (value ?? "").trim().replace(/^\/+|\/+$/g, "");
  return trimmed ? `/${trimmed}/` : "/";
}
const base = basePath(process.env.BASE_PATH);
const crossOriginHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

/** Public files the service worker precaches; their content versions the cache. */
const SHELL_FILES = [
  "index.html",
  "manifest.webmanifest",
  "icon.svg",
  "README-web.html",
];

function replaceOnce(source: string, token: string, value: string): string {
  if (source.split(token).length !== 2) {
    throw new Error(`Expected one "${token}" in sw.js.`);
  }
  return source.replace(token, () => value);
}

/**
 * Writes the build's asset list and a version derived from the build output
 * into dist/sw.js, so each release gets a fresh shell cache and stale assets
 * are removed.
 */
function stampServiceWorker(dist: string): void {
  const assets = readdirSync(resolve(dist, "assets")).sort().map((name) =>
    `${base}assets/${name}`
  );
  // The ONNX Runtime WASM file is large; cache it on first use, not on install.
  const precache = [
    ...assets.filter((path) => !path.endsWith(".wasm")),
    `${base}README-web.html`,
  ];
  const hash = createHash("sha256").update(assets.join("\n"));
  for (const file of SHELL_FILES) hash.update(readFileSync(resolve(dist, file)));
  const buildId = hash.digest("hex").slice(0, 12);

  const swPath = resolve(dist, "sw.js");
  let sw = readFileSync(swPath, "utf8");
  sw = replaceOnce(sw, 'const BUILD_ID = "dev";', `const BUILD_ID = "${buildId}";`);
  sw = replaceOnce(
    sw,
    "/* __OSPLIT_PRECACHE__ */ []",
    JSON.stringify(precache),
  );
  sw = replaceOnce(sw, "/* __OSPLIT_ASSETS__ */ []", JSON.stringify(assets));
  writeFileSync(swPath, sw);
}

function serveAndPackageModels(): Plugin {
  return {
    name: "osplit-model-assets",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const fullUrl = request.url?.split("?")[0] ?? "";
        if (!fullUrl.startsWith(base)) return next();
        const url = `/${fullUrl.slice(base.length)}`;
        if (url.startsWith("/yt-dlp/")) {
          const requested = decodeURIComponent(url.slice("/yt-dlp/".length));
          if (
            !/^(wheel\.json|yt_dlp-[0-9.]+-py3-none-any\.whl)$/.test(requested)
          ) {
            response.statusCode = 404;
            response.end("yt-dlp runtime file not found");
            return;
          }
          const file = resolve(ytDlpRoot, requested);
          if (!existsSync(file)) {
            response.statusCode = 404;
            response.end("yt-dlp runtime file not found");
            return;
          }
          response.setHeader(
            "Content-Type",
            requested.endsWith(".json")
              ? "application/json"
              : "application/octet-stream",
          );
          createReadStream(file).pipe(response);
          return;
        }
        if (!url.startsWith("/models/")) return next();
        const requested = decodeURIComponent(url.slice("/models/".length));
        if (!/^(fp16|fp32)\/[a-z]+(?:\.fp16)?\.onnx$/.test(requested)) {
          response.statusCode = 404;
          response.end("Model not found");
          return;
        }
        const file = resolve(modelRoot, requested);
        const pathFromRoot = relative(modelRoot, file);
        if (pathFromRoot.startsWith(`..${sep}`) || !existsSync(file)) {
          response.statusCode = 404;
          response.end("Model not found");
          return;
        }
        response.setHeader("Content-Type", "application/octet-stream");
        response.setHeader(
          "Cache-Control",
          "public, max-age=31536000, immutable",
        );
        createReadStream(file).pipe(response);
      });
    },
    closeBundle() {
      stampServiceWorker(resolve(webDirectory, "dist"));
      const output = resolve(webDirectory, "dist", "models");
      cpSync(modelRoot, output, { recursive: true });
      cpSync(ytDlpRoot, resolve(webDirectory, "dist", "yt-dlp"), {
        recursive: true,
      });
    },
  };
}

export default defineConfig({
  base,
  publicDir: resolve(webDirectory, "public"),
  plugins: [serveAndPackageModels()],
  server: { headers: crossOriginHeaders },
  preview: { headers: crossOriginHeaders },
  worker: { format: "es" },
});
