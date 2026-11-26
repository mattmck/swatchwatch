// A closed or locked store is "store closed", not a failure (#529). The responses below copy what
// the 2026-11-25 bulk run saw on deployed dev: Shopify stores answering /products.json with 401 or
// redirecting to /password, and Big Cartel answering 403 {"reason":"Store is under maintenance"}.
// A Cloudflare challenge (cf-mitigated: challenge, 403 HTML) must stay a normal failure.
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  StoreClosedError,
  detectBigCartelMaintenance,
  detectShopifyStoreClosed,
  isCloudflareChallenge,
  isStoreClosedError,
} = require("../dist/lib/connectors/store-closed");
const { ShopifyGenericConnector } = require("../dist/lib/connectors/shopify-generic");
const { HoloTacoShopifyConnector } = require("../dist/lib/connectors/holo-taco-shopify");
const { BigCartelConnector } = require("../dist/lib/connectors/big-cartel");
const { readSourceSettings } = require("../dist/lib/source-settings");

const PULL = { searchTerm: "", page: 1, pageSize: 100, maxRecords: 100 };

function headers(map = {}) {
  const lower = Object.fromEntries(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name) => lower[name.toLowerCase()] ?? null };
}

let cancelledBodies = 0;

/** A fetch Response stand-in; `url` is the final URL after redirects. */
function response({ status, url, redirected = false, body = "", headerMap = {} }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    url,
    redirected,
    headers: headers(headerMap),
    body: {
      cancel: async () => {
        cancelledBodies += 1;
      },
    },
    text: async () => body,
  };
}

const PASSWORD_HTML = "<html><body><h1>Opening soon</h1><p>closed for this month</p></body></html>";
const CLOUDFLARE_HTML = "<!DOCTYPE html><html><head><title>Just a moment...</title></head></html>";

describe("detectShopifyStoreClosed", () => {
  it("treats a 401 on the catalog as a password-locked store", () => {
    assert.equal(detectShopifyStoreClosed({ status: 401, url: "https://shop.example/products.json" }), "password_page");
  });

  it("treats a redirect to /password as a password-locked store, whatever the final status", () => {
    for (const status of [200, 401]) {
      assert.equal(
        detectShopifyStoreClosed({ status, url: "https://shop.example/password", redirected: true }),
        "password_page"
      );
    }
    assert.equal(detectShopifyStoreClosed({ status: 200, url: "https://shop.example/password/" }), "password_page");
  });

  it("ignores ordinary responses, other refusals and lookalike paths", () => {
    assert.equal(detectShopifyStoreClosed({ status: 200, url: "https://shop.example/products.json" }), null);
    assert.equal(detectShopifyStoreClosed({ status: 403, url: "https://shop.example/products.json" }), null);
    assert.equal(detectShopifyStoreClosed({ status: 404, url: "https://shop.example/products.json" }), null);
    assert.equal(detectShopifyStoreClosed({ status: 200, url: "https://shop.example/pages/password-help" }), null);
    assert.equal(detectShopifyStoreClosed({ status: 200 }), null);
  });

  it("never calls a Cloudflare challenge a closed store", () => {
    const challenge = headers({ "cf-mitigated": "challenge" });
    assert.equal(isCloudflareChallenge({ headers: challenge }), true);
    assert.equal(detectShopifyStoreClosed({ status: 401, url: "https://shop.example/products.json", headers: challenge }), null);
    assert.equal(detectShopifyStoreClosed({ status: 403, url: "https://shop.example/products.json", headers: challenge }), null);
  });
});

describe("detectBigCartelMaintenance", () => {
  it("returns the vendor's reason for a maintenance 403", () => {
    assert.equal(detectBigCartelMaintenance(403, '{"reason":"Store is under maintenance"}'), "Store is under maintenance");
  });

  it("ignores other statuses, other reasons and non-JSON bodies", () => {
    assert.equal(detectBigCartelMaintenance(500, '{"reason":"Store is under maintenance"}'), null);
    assert.equal(detectBigCartelMaintenance(403, '{"reason":"Forbidden"}'), null);
    assert.equal(detectBigCartelMaintenance(403, CLOUDFLARE_HTML), null);
    assert.equal(detectBigCartelMaintenance(403, '["maintenance"]'), null);
    assert.equal(detectBigCartelMaintenance(403, ""), null);
  });
});

describe("releaseResponseBody", () => {
  it("cancels the body and never throws", async () => {
    const { releaseResponseBody } = require("../dist/lib/connectors/store-closed");
    let cancelled = false;
    await releaseResponseBody({ body: { cancel: async () => { cancelled = true; } } });
    assert.equal(cancelled, true);
    await releaseResponseBody({ body: { cancel: async () => { throw new TypeError("locked"); } } });
    await releaseResponseBody({ body: null });
    await releaseResponseBody({});
  });
});

describe("isStoreClosedError", () => {
  it("recognizes the typed error and nothing else", () => {
    const error = new StoreClosedError({ source: "X", reason: "maintenance", httpStatus: 403, url: "u", detail: "d" });
    assert.equal(isStoreClosedError(error), true);
    assert.match(error.message, /X store is under maintenance \(HTTP 403\): d/);
    assert.equal(isStoreClosedError(new Error("X request failed: 401 Unauthorized")), false);
    assert.equal(isStoreClosedError(null), false);
  });
});

describe("Shopify connectors stop on a locked store", () => {
  let originalFetch;
  let requests;
  let answer;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    requests = [];
    cancelledBodies = 0;
    globalThis.fetch = async (url, init) => {
      requests.push({ url, init });
      return answer(url);
    };
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const generic = () => new ShopifyGenericConnector("TestBrandShopify", "https://shop.example", { currency: "USD" });

  it("ShopifyGenericConnector: a 401 on /products.json throws StoreClosedError after one request", async () => {
    answer = (url) => response({ status: 401, url, body: "Unauthorized" });
    await assert.rejects(generic().pullProducts(PULL), (error) => {
      assert.equal(isStoreClosedError(error), true);
      assert.equal(error.reason, "password_page");
      assert.equal(error.httpStatus, 401);
      assert.equal(error.source, "TestBrandShopify");
      assert.match(error.url, /^https:\/\/shop\.example\/products\.json/);
      return true;
    });
    assert.equal(requests.length, 1, "a locked store is not retried");
    assert.equal(cancelledBodies, 1, "the unread body is released");
    assert.equal(requests[0].init.headers["User-Agent"], "SwatchWatch/connector-ingestion (+https://github.com/mattmck/swatchwatch)");
  });

  it("ShopifyGenericConnector: a redirect to /password throws StoreClosedError", async () => {
    answer = () => response({ status: 200, url: "https://shop.example/password", redirected: true, body: PASSWORD_HTML });
    await assert.rejects(generic().pullProducts(PULL), (error) => {
      assert.equal(isStoreClosedError(error), true);
      assert.equal(error.reason, "password_page");
      return true;
    });
    assert.equal(requests.length, 1);
    assert.equal(cancelledBodies, 1);
  });

  it("ShopifyGenericConnector: a Cloudflare challenge stays an ordinary failure", async () => {
    answer = (url) => response({ status: 403, url, body: CLOUDFLARE_HTML, headerMap: { "cf-mitigated": "challenge" } });
    await assert.rejects(generic().pullProducts(PULL), (error) => {
      assert.equal(isStoreClosedError(error), false);
      assert.match(error.message, /request failed: 403/);
      return true;
    });
  });

  it("HoloTacoShopifyConnector: a 401 on /products.json throws StoreClosedError", async () => {
    answer = (url) => response({ status: 401, url, body: "Unauthorized" });
    await assert.rejects(new HoloTacoShopifyConnector("https://holotaco.example", { currency: "USD" }).pullProducts(PULL), (error) => {
      assert.equal(isStoreClosedError(error), true);
      assert.equal(error.source, "HoloTacoShopify");
      return true;
    });
    assert.equal(requests.length, 1);
  });
});

describe("BigCartelConnector stops on a store in maintenance", () => {
  const SOURCE = "PaintedPolishBigCartel";
  const SETTINGS = readSourceSettings({ brand: "Painted Polish", subdomain: "paintedpolish" }, SOURCE);
  const PRODUCTS = "https://api.bigcartel.com/paintedpolish/products.json";

  function connector(status, body) {
    const log = [];
    const fetchImpl = async (url) => {
      log.push(url);
      return { ok: false, status, statusText: "Forbidden", text: async () => body };
    };
    const instance = new BigCartelConnector(SOURCE, null, SETTINGS, { fetchImpl, now: () => 0, sleep: async () => {} });
    return { instance, log };
  }

  it("a 403 with a maintenance reason throws StoreClosedError", async () => {
    const { instance, log } = connector(403, '{"reason":"Store is under maintenance"}');
    await assert.rejects(instance.pullProducts(PULL), (error) => {
      assert.equal(isStoreClosedError(error), true);
      assert.equal(error.reason, "maintenance");
      assert.equal(error.httpStatus, 403);
      assert.equal(error.detail, "Store is under maintenance");
      assert.equal(error.url, PRODUCTS);
      return true;
    });
    assert.deepEqual(log, [PRODUCTS], "no retry and no store.json request");
  });

  it("a Cloudflare-style 403 (HTML) stays an ordinary failure", async () => {
    const { instance } = connector(403, CLOUDFLARE_HTML);
    await assert.rejects(instance.pullProducts(PULL), (error) => {
      assert.equal(isStoreClosedError(error), false);
      assert.match(error.message, /Big Cartel API request failed: HTTP 403/);
      return true;
    });
  });

  it("a 403 with another reason stays an ordinary failure", async () => {
    const { instance } = connector(403, '{"reason":"Forbidden"}');
    await assert.rejects(instance.pullProducts(PULL), (error) => isStoreClosedError(error) === false);
  });
});
