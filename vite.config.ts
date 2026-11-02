import { cpSync, createReadStream, existsSync } from "node:fs";
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
const crossOriginHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

function serveAndPackageModels(): Plugin {
  return {
    name: "osplit-model-assets",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = request.url?.split("?")[0] ?? "";
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
      const output = resolve(webDirectory, "dist", "models");
      cpSync(modelRoot, output, { recursive: true });
      cpSync(ytDlpRoot, resolve(webDirectory, "dist", "yt-dlp"), {
        recursive: true,
      });
    },
  };
}

export default defineConfig({
  base: "./",
  publicDir: resolve(webDirectory, "public"),
  plugins: [serveAndPackageModels()],
  server: { headers: crossOriginHeaders },
  preview: { headers: crossOriginHeaders },
  worker: { format: "es" },
});
