// The build replaces these placeholders (see vite.config.ts); the defaults keep
// the dev server working.
const BUILD_ID = "dev";
const PRECACHE = /* __OSPLIT_PRECACHE__ */ [];
const ASSETS = /* __OSPLIT_ASSETS__ */ [];

// The app shell is versioned per build. Runtime assets (such as the large ONNX
// Runtime WASM file) live in a separate cache that is pruned to the files the
// current build uses, so unchanged files survive app updates.
const SHELL_CACHE = `osplit-shell-${BUILD_ID}`;
const ASSET_CACHE = "osplit-assets";
const SHELL = ["/", "/manifest.webmanifest", "/icon.svg", ...PRECACHE];
const currentAssets = new Set(ASSETS);

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
    url.pathname.startsWith("/models/")
  ) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          void caches.open(SHELL_CACHE).then((cache) => cache.put("/", copy));
        }
        return response;
      }).catch(() =>
        caches.match("/").then((response) =>
          response ??
            new Response("OSplit is not available offline yet.", {
              status: 503,
            })
        )
      ),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok && currentAssets.has(url.pathname)) {
          const copy = response.clone();
          void caches.open(ASSET_CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});
