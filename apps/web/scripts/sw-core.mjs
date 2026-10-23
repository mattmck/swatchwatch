// Request classification shared by the service worker (inlined into out/sw.js by
// scripts/build-sw.mjs, with the `export` keywords stripped) and the unit tests.
// Plain ES2019, no imports: it runs inside the worker as-is.

/** Cache name prefix; the full name carries the precache manifest hash. */
export const SW_CACHE_PREFIX = "swatchwatch-shell-";

/** Route the shell falls back to when a navigation matches no precached page. */
export const SW_FALLBACK_ROUTE = "/polishes/";

/** `/polishes` and `/polishes/` are the same exported page (trailingSlash: true). */
export function normalizeRoutePath(pathname) {
  if (pathname === "" || pathname === "/") return "/";
  if (/\.[a-z0-9]+$/i.test(pathname)) return pathname;
  return pathname.endsWith("/") ? pathname : pathname + "/";
}

/**
 * What the worker does with a request:
 * - "passthrough": untouched, never cached (non-GET, cross-origin, `/api/*` including
 *   `/api/images/*`, anything with an Authorization header, Range requests);
 * - "precache": same-origin GET of a precached URL (cache-first for assets, network-first
 *   with the cached copy as fallback for page navigations);
 * - "static": any other hashed `/_next/static/*` asset, cache-first, stored on first use;
 * - "navigation": a same-origin page navigation, network-first with the cached shell as fallback.
 *
 * `req` is `{ method, url, origin, mode, hasAuthorization, hasRange }`; `precacheUrls` is a Set
 * of same-origin paths.
 */
export function classifyRequest(req, precacheUrls) {
  if (req.method !== "GET") return "passthrough";
  if (req.hasAuthorization || req.hasRange) return "passthrough";
  let url;
  try {
    url = new URL(req.url);
  } catch (e) {
    return "passthrough";
  }
  if (url.origin !== req.origin) return "passthrough";
  const path = url.pathname;
  if (path === "/api" || path.indexOf("/api/") === 0) return "passthrough";
  // A precached page (a route ending in "/") only answers navigations, never fetch() requests.
  const isPage = path.charAt(path.length - 1) === "/";
  if (req.mode === "navigate" ? precacheUrls.has(normalizeRoutePath(path)) : !isPage && precacheUrls.has(path)) {
    return "precache";
  }
  if (path.indexOf("/_next/static/") === 0) return "static";
  if (req.mode === "navigate") return "navigation";
  return "passthrough";
}

/** The precached HTML to serve for an offline navigation, or null when there is none. */
export function navigationFallback(pathname, precacheUrls) {
  const route = normalizeRoutePath(pathname);
  if (precacheUrls.has(route)) return route;
  if (precacheUrls.has(SW_FALLBACK_ROUTE)) return SW_FALLBACK_ROUTE;
  return null;
}
