/* SwatchWatch service worker. Generated into out/sw.js by scripts/build-sw.mjs: the request
   classification below is scripts/sw-core.mjs inlined, the precache list is the static export.
   Never caches /api/*, cross-origin, non-GET or Authorization-bearing requests. */
/* eslint-disable */
__SW_CORE__

const VERSION = "__SW_VERSION__";
const CACHE = SW_CACHE_PREFIX + VERSION;
const PRECACHE = __SW_PRECACHE__;
const PRECACHE_SET = new Set(PRECACHE);
const NAVIGATION_TIMEOUT_MS = 5000;

self.addEventListener("install", (event) => {
  // No skipWaiting here: a new worker waits until the page asks (SKIP_WAITING), so an open tab
  // never has its chunks swapped underneath it.
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.all(
        PRECACHE.map((url) =>
          fetch(new Request(url, { cache: "reload", credentials: "same-origin" })).then((res) => {
            if (!res.ok || res.redirected) throw new Error("precache failed: " + url + " " + res.status);
            return cache.put(url, res);
          }),
        ),
      ),
    ),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k.indexOf(SW_CACHE_PREFIX) === 0 && k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

function lookup(url) {
  return caches.open(CACHE).then((cache) => cache.match(url, { ignoreSearch: true }));
}

function cacheFirst(request, store) {
  return lookup(request.url).then((hit) => {
    if (hit) return hit;
    return fetch(request).then((res) => {
      if (store && res.ok && res.type === "basic" && !res.redirected) {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(request.url, copy));
      }
      return res;
    });
  });
}

function networkFirstNavigation(request) {
  const url = new URL(request.url);
  const fromCache = () => {
    const route = navigationFallback(url.pathname, PRECACHE_SET);
    return route ? lookup(new URL(route, url.origin).href) : Promise.resolve(undefined);
  };
  const network = fetch(request);
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), NAVIGATION_TIMEOUT_MS));
  return Promise.race([network, timeout]).catch((err) =>
    fromCache().then((hit) => {
      if (hit) return hit;
      // Nothing cached: let a slow network answer win rather than failing the navigation.
      if (err && err.message === "timeout") return network;
      throw err;
    }),
  );
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const kind = classifyRequest(
    {
      method: request.method,
      url: request.url,
      origin: self.location.origin,
      mode: request.mode,
      hasAuthorization: request.headers.has("authorization"),
      hasRange: request.headers.has("range"),
    },
    PRECACHE_SET,
  );
  if (kind === "passthrough") return;
  if (kind === "static") {
    event.respondWith(cacheFirst(request, true));
  } else if (request.mode === "navigate") {
    // Pages stay network-first so a deploy shows up without waiting for the worker update.
    event.respondWith(networkFirstNavigation(request));
  } else {
    event.respondWith(cacheFirst(request, false));
  }
});
