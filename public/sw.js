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
// Holds a file shared to the installed app until the page picks it up.
const INBOX_CACHE = "osplit-inbox";
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
      .filter((key) => ![SHELL_CACHE, ASSET_CACHE, INBOX_CACHE].includes(key))
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

// "Share to OSplit" (manifest share_target): keep the shared file, then open
// the app, which creates a project from it (src/tasks/import.ts).
async function receiveShare(request) {
  try {
    const file = (await request.formData()).get("audio");
    if (file && typeof file !== "string") {
      const cache = await caches.open(INBOX_CACHE);
      await cache.put(
        `${BASE}inbox`,
        new Response(file, {
          headers: {
            "Content-Type": file.type || "application/octet-stream",
            "X-File-Name": encodeURIComponent(file.name || "shared-audio"),
          },
        }),
      );
    }
  } catch (error) {
    console.warn("The shared file could not be received.", error);
  }
  return Response.redirect(`${BASE}?shared=1`, 303);
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (
    request.method === "POST" && url.origin === self.location.origin &&
    url.pathname === `${BASE}share`
  ) {
    event.respondWith(receiveShare(request));
    return;
  }
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
