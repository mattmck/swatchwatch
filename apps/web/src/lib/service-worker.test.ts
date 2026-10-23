import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { classifyRequest, navigationFallback, normalizeRoutePath } from "../../scripts/sw-core.mjs";
import { buildPrecache, extractStaticAssetUrls } from "../../scripts/sw-precache.mjs";
import { shouldRegisterServiceWorker } from "./service-worker";

const ORIGIN = "https://swatchwatch.app";
const SET = new Set(["/", "/polishes/", "/polishes/detail/", "/blank.html", "/_next/static/chunks/a.js"]);

function req(url: string, extra: Record<string, unknown> = {}) {
  return { method: "GET", url: ORIGIN + url, origin: ORIGIN, mode: "no-cors", ...extra };
}

describe("classifyRequest", () => {
  it("serves precached assets and pages", () => {
    assert.equal(classifyRequest(req("/blank.html"), SET), "precache");
    assert.equal(classifyRequest(req("/_next/static/chunks/a.js"), SET), "precache");
    assert.equal(classifyRequest(req("/polishes", { mode: "navigate" }), SET), "precache");
    assert.equal(classifyRequest(req("/polishes/detail/?id=3", { mode: "navigate" }), SET), "precache");
  });

  it("caches unseen hashed static assets on first use", () => {
    assert.equal(classifyRequest(req("/_next/static/chunks/b.js"), SET), "static");
  });

  it("treats other navigations as navigations", () => {
    assert.equal(classifyRequest(req("/admin/", { mode: "navigate" }), SET), "navigation");
  });

  it("never touches the API, including image proxy URLs", () => {
    for (const p of ["/api/polishes", "/api/images/abc?w=64", "/api/auth/validate", "/api"]) {
      assert.equal(classifyRequest(req(p), SET), "passthrough", p);
      assert.equal(classifyRequest(req(p, { mode: "navigate" }), SET), "passthrough", p);
    }
  });

  it("passes through cross-origin, non-GET, authorized and ranged requests", () => {
    assert.equal(classifyRequest({ ...req("/blank.html"), url: "https://api.example.com/blank.html" }, SET), "passthrough");
    assert.equal(classifyRequest(req("/blank.html", { method: "POST" }), SET), "passthrough");
    assert.equal(classifyRequest(req("/blank.html", { hasAuthorization: true }), SET), "passthrough");
    assert.equal(classifyRequest(req("/_next/static/chunks/a.js", { hasRange: true }), SET), "passthrough");
  });

  it("does not answer fetch() calls with a cached page, nor unknown subresources", () => {
    assert.equal(classifyRequest(req("/polishes/"), SET), "passthrough");
    assert.equal(classifyRequest(req("/polishes/__next.txt"), SET), "passthrough");
    assert.equal(classifyRequest(req("/brand/logo.svg"), SET), "passthrough");
  });

  it("passes through a malformed URL", () => {
    assert.equal(classifyRequest({ method: "GET", url: "not a url", origin: ORIGIN }, SET), "passthrough");
  });
});

describe("navigationFallback", () => {
  it("uses the matching route, else the /polishes/ shell, else nothing", () => {
    assert.equal(normalizeRoutePath("/polishes"), "/polishes/");
    assert.equal(normalizeRoutePath("/blank.html"), "/blank.html");
    assert.equal(navigationFallback("/polishes/detail", SET), "/polishes/detail/");
    assert.equal(navigationFallback("/manis/", SET), "/polishes/");
    assert.equal(navigationFallback("/manis/", new Set(["/"])), null);
  });
});

function fixture(): string {
  const out = mkdtempSync(join(tmpdir(), "sw-out-"));
  const write = (rel: string, body: string | Buffer) => {
    const full = join(out, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  };
  const page = (chunks: string[]) =>
    `<html><script src="${chunks[0]}"></script><link href="${chunks[1]}" rel="stylesheet"/>` +
    `<script>self.__next_f.push(["${chunks[2]}"])</script></html>`;
  write("index.html", page(["/_next/static/chunks/main.js", "/_next/static/css/app.css", "/_next/static/chunks/lazy.js?x=1"]));
  write("polishes/index.html", page(["/_next/static/chunks/main.js", "/_next/static/css/app.css", "/_next/static/chunks/p.js"]));
  write("polishes/detail/index.html", "<html></html>");
  write("dashboard/index.html", "<html></html>");
  write("rapid-add/index.html", "<html></html>");
  write("blank.html", "<html></html>");
  write("manifest.json", "{}");
  write("icon-192.png", "x");
  write("og-image.png", "x");
  write("_next/static/chunks/main.js", "main");
  write("_next/static/chunks/main.js.map", "map");
  write("_next/static/chunks/p.js", Buffer.alloc(1_600_000));
  write("_next/static/chunks/lazy.js", "lazy");
  write("_next/static/css/app.css", "css");
  return out;
}

describe("buildPrecache", () => {
  it("lists pages, their static chunks, blank.html and icons, and skips the rest", () => {
    const { urls, skipped, version } = buildPrecache(fixture());
    assert.ok(urls.includes("/blank.html"));
    for (const route of ["/", "/polishes/", "/polishes/detail/", "/dashboard/", "/rapid-add/"]) {
      assert.ok(urls.includes(route), route);
    }
    assert.ok(urls.includes("/_next/static/chunks/main.js"));
    assert.ok(urls.includes("/_next/static/chunks/lazy.js"));
    assert.ok(urls.includes("/_next/static/css/app.css"));
    assert.ok(urls.includes("/manifest.json") && urls.includes("/icon-192.png"));
    assert.ok(!urls.includes("/og-image.png"), "share image excluded");
    assert.ok(!urls.some((u) => u.endsWith(".map")));
    assert.ok(!urls.some((u) => u.startsWith("/api/")));
    assert.deepEqual(skipped, ["/_next/static/chunks/p.js"]);
    assert.deepEqual(urls, [...urls].sort());
    assert.match(version, /^[0-9a-f]{12}$/);
  });

  it("changes the version when a file changes and not otherwise", () => {
    const out = fixture();
    const a = buildPrecache(out).version;
    assert.equal(buildPrecache(out).version, a);
    writeFileSync(join(out, "blank.html"), "<html>changed</html>");
    assert.notEqual(buildPrecache(out).version, a);
  });

  it("extracts only static asset URLs from HTML", () => {
    const html = `<script src="/_next/static/a/b-c.js"></script> "/_next/static/media/f.woff2" "/api/x.js" "/other.js"`;
    assert.deepEqual(extractStaticAssetUrls(html), ["/_next/static/a/b-c.js", "/_next/static/media/f.woff2"]);
  });
});

describe("shouldRegisterServiceWorker", () => {
  it("registers only in production builds with worker support", () => {
    assert.equal(shouldRegisterServiceWorker({ nodeEnv: "production", hasServiceWorker: true }), true);
    assert.equal(shouldRegisterServiceWorker({ nodeEnv: "development", hasServiceWorker: true }), false);
    assert.equal(shouldRegisterServiceWorker({ nodeEnv: "production", hasServiceWorker: false }), false);
  });
});
