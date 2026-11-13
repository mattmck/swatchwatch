// Builds the service worker precache list from the static export (`out/`).
// Node only; used by scripts/build-sw.mjs and the unit tests.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";

/** Pages that must open offline. `/` is the installed PWA's start_url. */
export const PRECACHE_ROUTES = ["/", "/dashboard/", "/polishes/", "/polishes/detail/", "/rapid-add/", "/manis/"];

/** Standalone files that must open offline. */
export const PRECACHE_FILES = [
  "/blank.html",
  "/msal-redirect-bridge.min.js",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
  "/apple-touch-icon.png",
];

/** Per-file size ceiling (bytes): large assets are fetched on demand, not precached. */
export const MAX_PRECACHE_FILE_BYTES = 1_500_000;

const EXCLUDED = [/^\/api\//, /\.map$/i, /^\/sw\.js$/, /^\/og-image\./];

export function isExcluded(urlPath) {
  return EXCLUDED.some((re) => re.test(urlPath));
}

function routeToFile(route) {
  return route === "/" ? "/index.html" : route + "index.html";
}

/** `/_next/static/...` URLs referenced from an exported HTML page (scripts, styles, fonts). */
export function extractStaticAssetUrls(html) {
  const found = new Set();
  const re = /\/_next\/static\/[A-Za-z0-9_\-./%~]+?\.(?:js|css|woff2?)(?=["'\\?\s<>)])/g;
  let m;
  while ((m = re.exec(html)) !== null) found.add(m[0]);
  return [...found];
}

export function listFiles(dir, base = "") {
  const out = [];
  for (const name of readdirSync(dir)) {
    const rel = posix.join(base, name);
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full, rel));
    else out.push("/" + rel);
  }
  return out;
}

/**
 * Next.js build ids of the export: the `_next/static/<id>/` folders that hold the build manifest.
 * Next picks a random id on every build and writes it into each exported page.
 */
export function findBuildIds(outDir) {
  const dir = join(outDir, "_next", "static");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => existsSync(join(dir, name, "_buildManifest.js")))
    .sort();
}

/**
 * @returns {{ urls: string[], version: string, skipped: string[] }} sorted precache URLs, a hash
 * over their paths and contents (the cache name suffix), and anything skipped for size.
 *
 * The version leaves out the Next.js build id in the pages: it is the only thing that differs
 * between two builds of the same source, and hashing it gave every deploy (also one that changed
 * nothing in the web app) a new `sw.js`, so installed clients saw "Update available" each time.
 * Without it an unchanged build gives a byte-identical `sw.js` and the browser installs nothing.
 */
export function buildPrecache(outDir) {
  const existing = new Set(listFiles(outDir));
  const urls = new Set();
  const skipped = [];

  const add = (urlPath, file) => {
    if (isExcluded(urlPath) || !existing.has(file)) return false;
    if (statSync(join(outDir, file)).size > MAX_PRECACHE_FILE_BYTES) {
      skipped.push(urlPath);
      return false;
    }
    urls.add(urlPath);
    return true;
  };

  for (const route of PRECACHE_ROUTES) {
    const file = routeToFile(route);
    if (!add(route, file)) continue;
    const html = readFileSync(join(outDir, file), "utf8");
    for (const asset of extractStaticAssetUrls(html)) add(asset, asset);
  }
  for (const file of PRECACHE_FILES) add(file, file);

  const sorted = [...urls].sort();
  const buildIds = findBuildIds(outDir);
  const hash = createHash("sha256");
  for (const u of sorted) {
    const isPage = u.endsWith("/");
    let body = readFileSync(join(outDir, isPage ? routeToFile(u) : u));
    if (isPage && buildIds.length > 0) {
      let html = body.toString("utf8");
      for (const id of buildIds) html = html.replaceAll(id, "");
      body = Buffer.from(html, "utf8");
    }
    hash.update(u).update("\0").update(body).update("\0");
  }
  return { urls: sorted, version: hash.digest("hex").slice(0, 12), skipped };
}
