// Service worker TEMPLATE. `pnpm build` runs scripts/generate-sw.ts, which
// substitutes __BUILD_ID__ and writes public/sw.js (gitignored build output).
// Every deploy therefore ships a byte-different /sw.js, which is what makes the
// browser's own service-worker update algorithm the update mechanism: new
// bytes → install → activate → controllerchange → the client reloads once.
//
// Cache design:
// - splitwisest-pages-v8: last-good HTML documents, network-first with a
//   bounded timeout. Tagged per build (x-build-id) in the meta cache.
// - splitwisest-static-v8: content-hashed /_next/static files (immutable) and
//   the precached shell assets, cache-first. Never purged by a version bump —
//   an entry is dropped only by the entry bound, or once every open window is
//   on this worker's build (stale chunks then serve no one).
// - splitwisest-meta-v3: build tags for the two caches above.
//
// The cache NAMES are constants but no longer need hand-bumping per release:
// cross-build reuse is intentional, and per-entry staleness is handled by the
// build tags. Bump a name only when an entry's stored SHAPE changes.

const BUILD_ID = "__BUILD_ID__";
const STATIC_CACHE = "splitwisest-static-v8";
const PAGE_CACHE = "splitwisest-pages-v8";
const META_CACHE = "splitwisest-meta-v3";
const CURRENT_CACHES = [STATIC_CACHE, PAGE_CACHE, META_CACHE];
const OFFLINE_URL = "/offline.html";
const START_URL = "/";
const SHELL_PRECACHE = [OFFLINE_URL, "/icon.svg", "/icon-192.png", "/icon-512.png", "/manifest.json"];
const NAV_TIMEOUT_MS = 3500;
const PAGE_MAX_ENTRIES = 24;
const STATIC_MAX_ENTRIES = 150;
const STATIC_TAG = "/__tag_static__";
const PAGE_TAG = "/__tag_page__";

// ---------- meta helpers ----------

async function metaGet(key) {
  const meta = await caches.open(META_CACHE);
  const hit = await meta.match(key);
  return hit ? hit.text() : null;
}

async function metaPut(key, value) {
  const meta = await caches.open(META_CACHE);
  await meta.put(key, new Response(value));
}

async function metaDelete(key) {
  const meta = await caches.open(META_CACHE);
  await meta.delete(key);
}

// ---------- lifecycle ----------

self.addEventListener("install", (event) => {
  // A failed precache fails the install: no half-populated worker activates.
  event.waitUntil(installWorker());
});

async function installWorker() {
  const staticCache = await caches.open(STATIC_CACHE);
  await staticCache.addAll(SHELL_PRECACHE.map((url) => new Request(url, { cache: "no-cache" })));
  // Precache the start_url shell so a first install (and every deploy) can cold
  // start offline. Only a replayable response may be stored.
  const shell = await fetch(START_URL, { cache: "no-cache", credentials: "same-origin" });
  if (!shell.ok || shell.redirected || !(shell.headers.get("content-type") || "").includes("text/html")) {
    throw new Error("start_url did not return a cacheable document");
  }
  const pages = await caches.open(PAGE_CACHE);
  await pages.put(START_URL, shell);
  await metaPut(PAGE_TAG + START_URL, BUILD_ID);
  await self.skipWaiting();
}

self.addEventListener("activate", (event) => {
  event.waitUntil(activateWorker());
});

async function activateWorker() {
  // One-time migration from the pre-v8 hand-versioned caches.
  for (const key of await caches.keys()) {
    if (key.startsWith("splitwisest-") && !CURRENT_CACHES.includes(key)) await caches.delete(key);
  }
  // Documents from an older build are discarded here (the start_url shell was
  // just re-precached by install). Content-hashed static files are NOT touched:
  // a window still running the previous build may yet lazy-load its own chunks.
  await dropStalePages();
  await self.clients.claim();
}

// ---------- stale-entry disposal ----------

async function dropStalePages() {
  const pages = await caches.open(PAGE_CACHE);
  for (const request of await pages.keys()) {
    const path = new URL(request.url).pathname;
    const tag = await metaGet(PAGE_TAG + path);
    if (tag !== BUILD_ID) {
      await pages.delete(request);
      await metaDelete(PAGE_TAG + path);
    }
  }
}

async function dropStaleStatics() {
  const cache = await caches.open(STATIC_CACHE);
  for (const request of await cache.keys()) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/_next/static/")) continue;
    const tag = await metaGet(STATIC_TAG + path);
    if (tag !== BUILD_ID) {
      await cache.delete(request);
      await metaDelete(STATIC_TAG + path);
    }
  }
}

// Static chunks from the previous build are deleted only once every open
// window reports it is running THIS build — before that, deleting them could
// break a controlled page's next lazy-loaded chunk.
const clientBuilds = new Map();

async function maybeDropStaleStatics() {
  const windows = await self.clients.matchAll({ type: "window" });
  for (const client of windows) {
    if (clientBuilds.get(client.id) !== BUILD_ID) return;
  }
  await dropStaleStatics();
}

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "CLIENT_READY" && event.source) {
    clientBuilds.set(event.source.id, data.build);
    event.waitUntil(maybeDropStaleStatics());
  } else if (data.type === "GET_BUILD" && event.ports && event.ports[0]) {
    event.ports[0].postMessage({ type: "BUILD", build: BUILD_ID });
  }
});

// ---------- fetch ----------

function fetchWithTimeout(request, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(request, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

function replayableDocument(response) {
  return response.ok
    && !response.redirected
    && response.type === "basic"
    && response.status !== 206
    && (response.headers.get("vary") || "") !== "*"
    && (response.headers.get("content-type") || "").includes("text/html");
}

async function trimCache(cacheName, tagPrefix, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  // Cache keys come back in insertion order: drop from the front (oldest).
  for (let i = 0; i < keys.length - maxEntries; i++) {
    const path = new URL(keys[i].url).pathname;
    await cache.delete(keys[i]);
    await metaDelete(tagPrefix + path);
  }
}

async function handleNavigation(event) {
  const { request } = event;
  const path = new URL(request.url).pathname;
  try {
    // The request goes out untouched: same URL (no cache-busting parameter, so
    // the CDN key stays clean), same headers. Documents ship with an ETag and
    // no browser-cache freshness, so this always revalidates at the server.
    const response = await fetchWithTimeout(request, NAV_TIMEOUT_MS);
    if (replayableDocument(response)) {
      const copy = response.clone();
      event.waitUntil((async () => {
        const pages = await caches.open(PAGE_CACHE);
        await pages.put(path, copy);
        await metaPut(PAGE_TAG + path, response.headers.get("x-build-id") || BUILD_ID);
        await trimCache(PAGE_CACHE, PAGE_TAG, PAGE_MAX_ENTRIES);
      })());
    }
    return response;
  } catch (error) {
    const pages = await caches.open(PAGE_CACHE);
    const exact = await pages.match(path);
    if (exact) return exact;
    const shell = await pages.match(START_URL);
    if (shell) return shell;
    const offline = await caches.match(OFFLINE_URL, { cacheName: STATIC_CACHE });
    if (offline) return offline;
    throw error;
  }
}

async function handleStatic(event) {
  const { request } = event;
  const path = new URL(request.url).pathname;
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  if (cached) {
    // Re-tag on every hit: a chunk shared between builds stays owned by the
    // build actually using it, so the stale sweep never deletes a live file.
    event.waitUntil(metaPut(STATIC_TAG + path, BUILD_ID));
    return cached;
  }
  const response = await fetch(request);
  if (response.ok && !response.redirected && response.status !== 206 && response.type === "basic") {
    const copy = response.clone();
    event.waitUntil((async () => {
      await cache.put(request, copy);
      await metaPut(STATIC_TAG + path, BUILD_ID);
      await trimCache(STATIC_CACHE, STATIC_TAG, STATIC_MAX_ENTRIES);
    })());
  }
  return response;
}

async function handlePrecached(event) {
  const cached = await caches.match(event.request, { cacheName: STATIC_CACHE });
  if (cached) return cached;
  return fetch(event.request);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Never touch user-scoped API traffic.
  if (url.pathname.startsWith("/api/")) return;
  // RSC payloads go straight to the network and are never cached: a payload
  // from one build must never be replayed into another build's router, and a
  // document must never answer an RSC request (or the reverse). A payload the
  // server minted for a DIFFERENT build is refused outright — the router
  // treats the failure as a hard navigation, which network-first serves fresh.
  if (request.headers.get("RSC") === "1" || url.searchParams.has("_rsc")) {
    // Compare against the REQUESTING PAGE's build when it has reported one:
    // right after this worker updates, the old page is still running and must
    // not be fed the new build's payloads either.
    const pageBuild = clientBuilds.get(event.clientId) || BUILD_ID;
    event.respondWith(
      fetch(request).then((response) => {
        const serverBuild = response.headers.get("x-build-id");
        if (serverBuild && serverBuild !== pageBuild) return Response.error();
        return response;
      })
    );
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(event));
    return;
  }
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(handleStatic(event));
    return;
  }
  if (SHELL_PRECACHE.includes(url.pathname)) {
    event.respondWith(handlePrecached(event));
    return;
  }
  // Everything else (there is nothing else same-origin today) passes through
  // untouched — this handler never responds with undefined.
});

// A visible notification is required for every push, including in the foreground.
function pushPath(value) {
  if (typeof value !== "string" || !/^\/notifications\/\d+$/.test(value)) return "/notifications";
  return value;
}

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    const data = event.data?.json();
    if (data && typeof data === "object") payload = data;
  } catch { /* A malformed payload still gets a visible, private fallback. */ }
  const id = Number(payload.notificationId);
  event.waitUntil(self.registration.showNotification("SplitWisest", {
    body: payload.test === true ? "Open this test notification to confirm tap-through."
      : "You have new activity. Open SplitWisest to view it.",
    icon: "/icon-192.png", badge: "/icon-192.png",
    tag: Number.isSafeInteger(id) && id > 0 ? `notification-${id}` : "splitwisest-activity",
    data: { url: pushPath(payload.url) },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = pushPath(event.notification.data?.url);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const client = windows.find((w) => new URL(w.url).origin === self.location.origin);
    if (client) {
      try {
        await client.focus();
        const acknowledged = await new Promise((resolve) => {
          const channel = new MessageChannel();
          const timeout = setTimeout(() => { channel.port1.close(); resolve(false); }, 1000);
          channel.port1.onmessage = () => { clearTimeout(timeout); channel.port1.close(); resolve(true); };
          client.postMessage({ type: "SPLITWISEST_NOTIFICATION_CLICK", url: path }, [channel.port2]);
        });
        if (acknowledged) return;
      } catch { /* A closing or older window falls back to a new app window. */ }
    }
    await self.clients.openWindow(path);
  })());
});
