// Static server for the end-to-end tests:
//   node e2e/server.mjs <dist dir> <base path> <port> [--isolation-headers]
// Without --isolation-headers it behaves like GitHub Pages (no COOP/COEP).
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";

const [distArg, base = "/", portArg = "4173", flag] = process.argv.slice(2);
if (!distArg) {
  console.error("Usage: node e2e/server.mjs <dist> <base path> <port> [--isolation-headers]");
  process.exit(1);
}
const dist = resolve(distArg);
const isolationHeaders = flag === "--isolation-headers";
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

createServer((request, response) => {
  const path = decodeURIComponent((request.url ?? "/").split("?")[0]);
  if (!path.startsWith(base)) {
    response.writeHead(404).end("Not found");
    return;
  }
  let file = join(dist, path.slice(base.length));
  if (!file.startsWith(dist)) {
    response.writeHead(404).end("Not found");
    return;
  }
  if (existsSync(file) && statSync(file).isDirectory()) {
    file = join(file, "index.html");
  }
  if (!existsSync(file)) {
    response.writeHead(404).end("Not found");
    return;
  }
  const headers = {
    "Content-Type": types[extname(file)] ?? "application/octet-stream",
    "Content-Length": statSync(file).size,
    "Cache-Control": "no-cache",
  };
  if (isolationHeaders) {
    headers["Cross-Origin-Opener-Policy"] = "same-origin";
    headers["Cross-Origin-Embedder-Policy"] = "require-corp";
  }
  response.writeHead(200, headers);
  createReadStream(file).pipe(response);
}).listen(Number(portArg), () => {
  console.log(`Serving ${dist} at http://localhost:${portArg}${base}`);
});
