/// <reference types="vitest/config" />
import { createHash } from "node:crypto";
import {
  cpSync,
  createReadStream,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { constants, gzipSync } from "node:zlib";
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

/**
 * Writes a gzip copy next to each WebAssembly file, for servers that send
 * precompressed files (nginx gzip_static in the Docker image): the ONNX
 * Runtime file shrinks from about 29 MB to about 7 MB. Only the Docker build
 * sets PRECOMPRESS, so the GitHub Pages artifact doesn't carry the copies.
 */
function precompressWasm(dist: string): void {
  const assets = resolve(dist, "assets");
  for (const name of readdirSync(assets)) {
    if (!name.endsWith(".wasm")) continue;
    const file = resolve(assets, name);
    writeFileSync(
      `${file}.gz`,
      gzipSync(readFileSync(file), { level: constants.Z_BEST_COMPRESSION }),
    );
  }
}

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

const LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/v1";

function isLfsPointer(file: string): boolean {
  if (statSync(file).size > 1024) return false;
  return readFileSync(file, "utf8").startsWith(LFS_POINTER_PREFIX);
}

/**
 * Size and SHA-256 of every model, keyed by path below models/. The app checks
 * downloads against it and uses the checksum in its cache key (src/models.ts).
 */
function modelManifest(): Record<string, { size: number; sha256: string }> {
  const manifest: Record<string, { size: number; sha256: string }> = {};
  const names = readdirSync(modelRoot, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".onnx"))
    .map((name) => name.split(sep).join("/"))
    .sort();
  for (const name of names) {
    const bytes = readFileSync(resolve(modelRoot, name));
    manifest[name] = {
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }
  return manifest;
}

/** Fails early when the models were checked out without Git LFS. */
function assertModelsPresent(): void {
  const pointers = readdirSync(modelRoot, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".onnx"))
    .filter((name) => isLfsPointer(resolve(modelRoot, name)));
  if (pointers.length) {
    throw new Error(
      `Model files are Git LFS pointers, not model data (${
        pointers.join(", ")
      }). Install Git LFS and run "git lfs pull" before building.`,
    );
  }
}

function serveAndPackageModels(): Plugin {
  // Packaging runs only after a successful build, so an earlier error (such as
  // missing models) is reported instead of a follow-up packaging failure.
  let buildSucceeded = false;
  let outDir = resolve(webDirectory, "dist");
  let devManifest: string | undefined;
  return {
    name: "osplit-model-assets",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    buildStart() {
      buildSucceeded = false;
      assertModelsPresent();
    },
    buildEnd(error) {
      buildSucceeded = !error;
    },
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
        if (requested === "models.json") {
          devManifest ??= JSON.stringify(modelManifest());
          response.setHeader("Content-Type", "application/json");
          response.setHeader("Cache-Control", "no-cache");
          response.end(devManifest);
          return;
        }
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
      if (!buildSucceeded) return;
      stampServiceWorker(outDir);
      const output = resolve(outDir, "models");
      cpSync(modelRoot, output, { recursive: true });
      writeFileSync(
        resolve(output, "models.json"),
        JSON.stringify(modelManifest(), null, 2),
      );
      cpSync(ytDlpRoot, resolve(outDir, "yt-dlp"), { recursive: true });
      if (process.env.PRECOMPRESS === "1") precompressWasm(outDir);
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
  // The browser tests in e2e/ run with Playwright, not Vitest.
  test: { include: ["src/**/*.test.ts"] },
});
