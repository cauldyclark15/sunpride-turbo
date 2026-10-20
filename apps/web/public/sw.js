/* Sunpride Operations service worker.
 *
 * - App shell: static assets (hashed Next chunks, icons, the offline page) in
 *   a versioned cache; older versions are deleted on activate.
 * - Pages: network-first, falling back to the last copy of the page, then to
 *   the branded offline page.
 * - Data: read-only GET /api/v1/* is network-first with a cached fallback. A
 *   cached answer carries `x-sp-from-cache: 1` and `x-sp-cached-at: <ms>` so
 *   the page can say "Offline. Showing figures from <time>."
 * - Never cached: anything but GET, /api/auth/*, /api/me, media and uploads,
 *   the realtime socket, other origins.
 * - Sign-out (message CLEAR_USER_DATA) and any 401 from the API delete the
 *   data and page caches, so the next person on a shared phone sees nothing.
 * - Updates wait until the page asks (message SKIP_WAITING).
 */

const VERSION =
  new URL(self.location.href).searchParams.get("v") || "development";
const STATIC_CACHE = `sp-static-${VERSION}`;
const PAGES_CACHE = `sp-pages-${VERSION}`;
const DATA_CACHE = "sp-data";
const OFFLINE_URL = "/offline.html";
const PRECACHE = [
  OFFLINE_URL,
  "/sunpride-logo.jpg",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
  "/manifest.webmanifest",
];

/** Which strategy a request gets: static | page | data | none (never touched). */
function classify(request) {
  if (request.method !== "GET") return "none";
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return "none";
  if (request.headers.get("range")) return "none";
  let path;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return "none";
  }
  // F-319 F-322: partner data must never survive current authorization denial.
  if (
    ["/agency", "/agencies", "/distributor", "/distributors"].some(
      (p) => path === p || path.startsWith(p + "/"),
    ) ||
    path.startsWith("/api/v1/partners") ||
    path.startsWith("/api/v1/distributors") ||
    path === "/portal" || path.startsWith("/portal/") || path.startsWith("/api/v1/portal/") || path.startsWith("/api/v1/mt/")
  )
    return "none";
  if (path === "/sw.js" || path === "/ws") return "none";
  if (path.startsWith("/api/")) {
    if (path.startsWith("/api/auth/")) return "none";
    if (path === "/api/me" || path.startsWith("/api/me/")) return "none";
    if (path.startsWith("/api/media/")) return "none";
    if (/upload/i.test(path)) return "none";
    if (path.startsWith("/api/v1/")) return "data";
    return "none";
  }
  if (path.startsWith("/_next/static/") || PRECACHE.includes(path))
    return "static";
  if (request.mode === "navigate") return "page";
  if (request.headers.get("rsc") === "1") return "page";
  return "none";
}

/** Data and page caches hold one person's figures; static assets are shared. */
function isUserCache(name) {
  return name === DATA_CACHE || name.startsWith("sp-pages-");
}

async function clearUserData() {
  const names = await caches.keys();
  await Promise.all(names.filter(isUserCache).map((n) => caches.delete(n)));
}

function cacheable(response) {
  return (
    response &&
    response.status === 200 &&
    response.type === "basic" &&
    !response.redirected
  );
}

async function stamp(response) {
  const headers = new Headers(response.headers);
  headers.set("x-sp-cached-at", String(Date.now()));
  return new Response(await response.clone().blob(), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function fromCache(cached) {
  const headers = new Headers(cached.headers);
  headers.set("x-sp-from-cache", "1");
  return new Response(await cached.blob(), {
    status: cached.status,
    statusText: cached.statusText,
    headers,
  });
}

async function dataStrategy(request) {
  let response;
  try {
    response = await fetch(request);
  } catch (error) {
    const cached = await caches
      .open(DATA_CACHE)
      .then((cache) => cache.match(request));
    if (cached) return fromCache(cached);
    throw error;
  }
  if (response.status === 401) {
    await clearUserData();
    return response;
  }
  const type = response.headers.get("content-type") || "";
  if (cacheable(response) && type.includes("json")) {
    const cache = await caches.open(DATA_CACHE);
    await cache.put(request, await stamp(response));
  }
  return response;
}

async function pageStrategy(request) {
  try {
    const response = await fetch(request);
    if (cacheable(response)) {
      const cache = await caches.open(PAGES_CACHE);
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cache = await caches.open(PAGES_CACHE);
    const cached =
      (await cache.match(request)) ||
      (await cache.match(request, { ignoreSearch: true }));
    if (cached) return cached;
    if (request.mode === "navigate") {
      const offline = await caches.match(OFFLINE_URL);
      if (offline) return offline;
    }
    throw error;
  }
}

async function staticStrategy(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (cacheable(response)) await cache.put(request, response.clone());
  return response;
}

function handle(request) {
  const kind = classify(request);
  if (kind === "data") return dataStrategy(request);
  if (kind === "page") return pageStrategy(request);
  if (kind === "static") return staticStrategy(request);
  return null;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) =>
        Promise.all(
          PRECACHE.map((url) => cache.add(url).catch(() => undefined)),
        ),
      ),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter(
            (name) =>
              name.startsWith("sp-") &&
              name !== STATIC_CACHE &&
              name !== PAGES_CACHE &&
              name !== DATA_CACHE,
          )
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const response = handle(event.request);
  if (response) event.respondWith(response);
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "SKIP_WAITING") {
    self.skipWaiting();
  } else if (data.type === "CLEAR_USER_DATA") {
    event.waitUntil(
      clearUserData().then(() => {
        const port = event.ports && event.ports[0];
        if (port) port.postMessage({ type: "CLEARED" });
      }),
    );
  } else if (data.type === "WARM" && Array.isArray(data.urls)) {
    // The page lists the hashed chunks it already loaded so they work offline.
    event.waitUntil(
      caches.open(STATIC_CACHE).then((cache) =>
        Promise.all(
          data.urls
            .filter((url) => {
              try {
                const parsed = new URL(url, self.location.origin);
                return (
                  parsed.origin === self.location.origin &&
                  parsed.pathname.startsWith("/_next/static/")
                );
              } catch {
                return false;
              }
            })
            .map((url) => cache.add(url).catch(() => undefined)),
        ),
      ),
    );
  }
});

// Test hook: the unit tests evaluate this file in a sandbox and call these.
self.__spSw = {
  classify,
  handle,
  clearUserData,
  STATIC_CACHE,
  PAGES_CACHE,
  DATA_CACHE,
};
