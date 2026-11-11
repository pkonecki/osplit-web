// The build replaces these placeholders (see vite.config.ts); the defaults keep
// the dev server working. Asset paths include the site's base path.
const BUILD_ID = "dev";
const PRECACHE = /* __OSPLIT_PRECACHE__ */ [];
const ASSETS = /* __OSPLIT_ASSETS__ */ [];

// The app shell is versioned per build. Runtime assets (such as the large ONNX
// Runtime WASM file) live in a separate cache that is pruned to the files the
// current build uses, so unchanged files survive app updates.
const SHELL_CACHE = `osplit-shell-${BUILD_ID}`;
const ASSET_CACHE = "osplit-assets";
// The app's base path, e.g. "/" or "/osplit-web/" on GitHub Pages.
const BASE = new URL(self.registration.scope).pathname;
const SHELL = [BASE, `${BASE}manifest.webmanifest`, `${BASE}icon.svg`, ...PRECACHE];
const currentAssets = new Set(ASSETS);

// Hosts such as GitHub Pages cannot send the cross-origin isolation headers
// that multithreaded WebAssembly needs. Adding them to the responses this
// worker serves isolates every page load after the first; the page reloads
// once when the worker takes control (see src/isolation.ts). On hosts that
// already send them, this changes nothing.
const ISOLATION_HEADERS = [
  ["Cross-Origin-Opener-Policy", "same-origin"],
  ["Cross-Origin-Embedder-Policy", "require-corp"],
];

function withIsolationHeaders(response) {
  // Opaque and redirect responses cannot be rebuilt.
  if (!response || response.status === 0 || response.type === "opaqueredirect") {
    return response;
  }
  const headers = new Headers(response.headers);
  for (const [name, value] of ISOLATION_HEADERS) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([deleteOldCaches(), pruneAssetCache()])
      .then(() => self.clients.claim()),
  );
});

async function deleteOldCaches() {
  const keys = await caches.keys();
  await Promise.all(
    keys
      .filter((key) => key !== SHELL_CACHE && key !== ASSET_CACHE)
      .map((key) => caches.delete(key)),
  );
}

async function pruneAssetCache() {
  const cache = await caches.open(ASSET_CACHE);
  const requests = await cache.keys();
  await Promise.all(
    requests
      .filter((request) => !currentAssets.has(new URL(request.url).pathname))
      .map((request) => cache.delete(request)),
  );
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (
    request.method !== "GET" || url.origin !== self.location.origin ||
    url.pathname.startsWith(`${BASE}models/`)
  ) return;

  if (request.mode === "navigate") {
    // Store the app page under its base path, and other pages (such as the
    // limitations page) under their own URL.
    const isAppPage = url.pathname === BASE ||
      url.pathname === `${BASE}index.html`;
    const cacheKey = isAppPage ? BASE : url.pathname;
    event.respondWith(
      fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          void caches.open(SHELL_CACHE).then((cache) => cache.put(cacheKey, copy));
        }
        return withIsolationHeaders(response);
      }).catch(async () =>
        withIsolationHeaders(
          (await caches.match(cacheKey)) ?? (await caches.match(BASE)) ??
            new Response("OSplit is not available offline yet.", {
              status: 503,
            }),
        )
      ),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return withIsolationHeaders(cached);
      return fetch(request).then((response) => {
        if (response.ok && currentAssets.has(url.pathname)) {
          const copy = response.clone();
          void caches.open(ASSET_CACHE).then((cache) => cache.put(request, copy));
        }
        return withIsolationHeaders(response);
      });
    }),
  );
});
