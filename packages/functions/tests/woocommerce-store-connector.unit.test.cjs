// WooCommerce Store API connector (brand sources plan, Task 16). The fixture
// tests/fixtures/woocommerce-store-sample.json is hand-written from the Store API product shape
// (wp-json/wc/store/v1/products, as Picture Polish's store answered it on 2026-11-08; no store
// was contacted to write it): three polishes, a stamping plate and a "Trio" set.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  WooCommerceStoreConnector,
  minorUnitsToDecimal,
  wooStorePrice,
  wooStoreFilterProduct,
} = require("../dist/lib/connectors/woocommerce-store");
const { readSourceSettings } = require("../dist/lib/source-settings");

const SAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "woocommerce-store-sample.json"), "utf8"));
const BASE = "https://picturepolish.com.au";
const API = `${BASE}/wp-json/wc/store/v1/products`;
const SOURCE = "PicturePolishWooCommerce";
const SETTINGS = readSourceSettings({ brand: "Picture Polish", currency: "AUD" }, SOURCE);
const PULL = { searchTerm: "", page: 1, pageSize: 100, maxRecords: 100 };
const UA = "SwatchWatch/connector-ingestion (+https://github.com/mattmck/swatchwatch)";

/** Fetch stub: `routes` maps a URL to a body (200) or `{ status, body }`; every request is logged. */
function stubFetch(routes) {
  const log = [];
  const fetchImpl = async (url, init) => {
    log.push({ url, headers: init.headers, at: Date.now() });
    const route = typeof routes === "function" ? routes(url) : routes[url];
    const answer = route === undefined ? { status: 404, body: "" } : typeof route === "string" ? { status: 200, body: route } : route;
    const headers = answer.headers ?? {};
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      statusText: "",
      headers: { get: (name) => headers[name.toLowerCase()] ?? null },
      text: async () => answer.body,
    };
  };
  return { fetchImpl, log };
}

function connector(fetchImpl, options = {}) {
  const sleeps = [];
  const instance = new WooCommerceStoreConnector(SOURCE, BASE, options.settings ?? SETTINGS, {
    fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...options,
  });
  return { instance, sleeps };
}

const pageUrl = (page) => `${API}?per_page=100&page=${page}`;

describe("WooCommerceStoreConnector: fixture", () => {
  it("reads robots.txt, then the products, and keeps the 3 polishes (a stamping plate and a Trio dropped)", async () => {
    const { fetchImpl, log } = stubFetch({
      [`${BASE}/robots.txt`]: "User-agent: *\nDisallow: /wp-admin/\n",
      [pageUrl(1)]: JSON.stringify(SAMPLE),
    });
    const { instance, sleeps } = connector(fetchImpl);
    const result = await instance.pullProducts(PULL);

    assert.deepEqual(log.map((entry) => entry.url), [`${BASE}/robots.txt`, pageUrl(1)]);
    assert.ok(log.every((entry) => entry.headers["User-Agent"] === UA));
    assert.equal(sleeps.length, 1, "the products request waits after robots.txt");
    assert.ok(sleeps[0] > 900 && sleeps[0] <= 1000);

    assert.deepEqual(result.records.map((record) => record.externalId), ["4211", "4212", "4215"]);
    assert.deepEqual(result.catalog, { externalIds: ["4211", "4212", "4213", "4214", "4215"], complete: true });
    assert.equal(result.metadata.fetchedProductCount, 5);
    assert.equal(result.metadata.connectorType, "woocommerce-store");

    const [atomic, moonlight, aurora] = result.records;
    assert.equal(atomic.gtin, null);
    assert.equal(atomic.raw.id, 4211);
    assert.deepEqual(
      {
        brand: atomic.normalized.brand,
        name: atomic.normalized.name,
        rawTitle: atomic.normalized.rawTitle,
        productType: atomic.normalized.productType,
        productCategory: atomic.normalized.productCategory,
        tags: atomic.normalized.tags,
        descriptors: atomic.normalized.descriptors,
        descriptionText: atomic.normalized.descriptionText,
        imageUrls: atomic.normalized.imageUrls,
        primaryImageUrl: atomic.normalized.primaryImageUrl,
        productUrl: atomic.normalized.productUrl,
        price: atomic.normalized.price,
        currency: atomic.normalized.currency,
        available: atomic.normalized.available,
        vendorCode: atomic.normalized.vendorCode,
        kind: atomic.normalized.kind,
      },
      {
        brand: "Picture Polish",
        name: "Atomic",
        rawTitle: "Picture Polish – Atomic",
        productType: "Nail Polish",
        productCategory: "color",
        tags: ["Orange"],
        descriptors: ["Creme", "Nail Polish", "Cremes"],
        descriptionText: "A vivid orange crème with a glossy finish.",
        imageUrls: [
          "https://picturepolish.com.au/wp-content/uploads/2026/03/atomic.jpg",
          "https://picturepolish.com.au/wp-content/uploads/2026/03/atomic-swatch.jpg",
        ],
        primaryImageUrl: "https://picturepolish.com.au/wp-content/uploads/2026/03/atomic.jpg",
        productUrl: "https://picturepolish.com.au/product/atomic/",
        price: "12.00",
        currency: "AUD",
        available: true,
        vendorCode: "PP-ATOMIC",
        kind: "brand",
      }
    );
    assert.equal(atomic.normalized.listingTitle, undefined, "brand mode");

    // An empty short_description falls back to the description; out of stock is false.
    assert.equal(moonlight.normalized.descriptionText, "A silver holographic polish that throws rainbows in the sun.");
    assert.equal(moonlight.normalized.price, "10.50");
    assert.equal(moonlight.normalized.available, false);
    // A variable product: the lowest variant price; no images; the Brand attribute is not a descriptor.
    assert.equal(aurora.normalized.price, "13.00");
    assert.deepEqual(aurora.normalized.imageUrls, []);
    assert.equal(aurora.normalized.primaryImageUrl, null);
    assert.deepEqual(aurora.normalized.descriptors, ["11ml", "Mini 5ml", "Nail Polish"]);
    assert.equal(aurora.normalized.vendorCode, null);
  });

  it("rejects before any product request when robots.txt disallows /wp-json/ for *", async () => {
    const { fetchImpl, log } = stubFetch({
      [`${BASE}/robots.txt`]: "User-agent: *\nDisallow: /wp-admin/\nDisallow: /wp-json/\n",
      [pageUrl(1)]: JSON.stringify(SAMPLE),
    });
    await assert.rejects(connector(fetchImpl).instance.pullProducts(PULL), /WooCommerce Store API disallowed by robots\.txt/);
    assert.deepEqual(log.map((entry) => entry.url), [`${BASE}/robots.txt`]);
  });

  it("treats a missing robots.txt (404) as allowed", async () => {
    const { fetchImpl, log } = stubFetch({ [pageUrl(1)]: JSON.stringify(SAMPLE) });
    const result = await connector(fetchImpl).instance.pullProducts(PULL);
    assert.equal(result.records.length, 3);
    assert.equal(log.length, 2);
  });

  it("pages until a short page, 1 s apart, reading robots.txt once", async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ ...SAMPLE[0], id: 10000 + i, name: `Shade ${i}` }));
    const { fetchImpl, log } = stubFetch({
      [`${BASE}/robots.txt`]: "User-agent: *\nDisallow:\n",
      [pageUrl(1)]: JSON.stringify(full),
      [pageUrl(2)]: JSON.stringify(SAMPLE),
    });
    const { instance, sleeps } = connector(fetchImpl, { pageDelayMs: 1000 });
    const result = await instance.pullProducts({ ...PULL, pageSize: 500, maxRecords: 500 });
    assert.deepEqual(log.map((entry) => entry.url), [`${BASE}/robots.txt`, pageUrl(1), pageUrl(2)]);
    assert.equal(sleeps.length, 2);
    assert.equal(result.metadata.storePagesFetched, 2);
    assert.equal(result.catalog.externalIds.length, 105);
    assert.equal(result.catalog.complete, true);
    assert.equal(result.records.length, 103);
  });

  it("stops at metadata.maxPages and reports the catalog as incomplete", async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ ...SAMPLE[0], id: 20000 + i }));
    const { fetchImpl, log } = stubFetch((url) => (url.endsWith("robots.txt") ? undefined : JSON.stringify(full)));
    const settings = readSourceSettings({ brand: "Picture Polish", maxPages: 2 }, SOURCE);
    const result = await connector(fetchImpl, { settings }).instance.pullProducts(PULL);
    assert.equal(log.length, 3);
    assert.equal(result.catalog.complete, false);
    assert.equal(result.metadata.catalogReachedEnd, false);
  });

  it("serves later pages from the job's catalog cache without any request and without a catalog", async () => {
    let saved = null;
    const cache = { load: async () => saved, save: async (products) => { saved = products; } };
    const { fetchImpl, log } = stubFetch({ [pageUrl(1)]: JSON.stringify(SAMPLE) });
    const first = await connector(fetchImpl).instance.pullProducts({ ...PULL, pageSize: 2, catalogCache: cache });
    const second = await connector(fetchImpl).instance.pullProducts({ ...PULL, page: 2, pageSize: 2, catalogCache: cache });
    assert.equal(log.length, 2, "robots.txt + one page, on the first pull only");
    assert.deepEqual(first.records.map((record) => record.externalId), ["4211", "4212"]);
    assert.deepEqual(second.records.map((record) => record.externalId), ["4215"]);
    assert.ok(first.catalog);
    assert.equal(second.catalog, undefined);
  });

  it("retailer mode: brand from the Brand attribute, shade from the title, listingTitle kept", async () => {
    const settings = readSourceSettings({ kind: "retailer" }, SOURCE);
    const { fetchImpl } = stubFetch({ [pageUrl(1)]: JSON.stringify(SAMPLE) });
    const result = await connector(fetchImpl, { settings }).instance.pullProducts(PULL);
    // Only Aurora names its brand (attribute "Brand"); the rest are vendorless.
    assert.deepEqual(result.records.map((record) => record.externalId), ["4215"]);
    assert.equal(result.records[0].normalized.brand, "Picture Polish");
    assert.equal(result.records[0].normalized.name, "Aurora");
    assert.equal(result.records[0].normalized.listingTitle, "Picture Polish – Aurora");
    assert.equal(result.metadata.vendorlessSkipped, 4);
  });

  for (const status of [400, 404]) {
    it(`ends the download as complete when the page after a full page answers ${status}`, async () => {
      const full = Array.from({ length: 100 }, (_, i) => ({ ...SAMPLE[0], id: 30000 + i, name: `Shade ${i}` }));
      const { fetchImpl, log } = stubFetch({
        [pageUrl(1)]: JSON.stringify(full),
        [pageUrl(2)]: { status, body: '{"code":"rest_invalid_param"}' },
      });
      const result = await connector(fetchImpl).instance.pullProducts({ ...PULL, pageSize: 500, maxRecords: 500 });
      assert.deepEqual(log.map((entry) => entry.url), [`${BASE}/robots.txt`, pageUrl(1), pageUrl(2)]);
      assert.equal(result.catalog.complete, true);
      assert.equal(result.catalog.externalIds.length, 100);
      assert.equal(result.metadata.storePagesFetched, 1);
    });
  }

  it("still fails on a 404 for the first page", async () => {
    const { fetchImpl } = stubFetch({});
    await assert.rejects(connector(fetchImpl).instance.pullProducts(PULL), /Store API request failed: HTTP 404 \(page 1\)/);
  });

  it("stops at X-WP-TotalPages without requesting the page after it", async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ ...SAMPLE[0], id: 40000 + i, name: `Shade ${i}` }));
    const { fetchImpl, log } = stubFetch({
      [pageUrl(1)]: { status: 200, body: JSON.stringify(full), headers: { "x-wp-totalpages": "1" } },
      [pageUrl(2)]: JSON.stringify(SAMPLE),
    });
    const result = await connector(fetchImpl).instance.pullProducts({ ...PULL, pageSize: 500, maxRecords: 500 });
    assert.deepEqual(log.map((entry) => entry.url), [`${BASE}/robots.txt`, pageUrl(1)]);
    assert.equal(result.catalog.complete, true);
    assert.equal(result.metadata.storePagesFetched, 1);
  });

  it("retailer mode: the #CODE parsed from the title wins over the store SKU; brand mode keeps the SKU", async () => {
    const product = { ...SAMPLE[0], id: 5001, name: "Picture Polish – Atomic #PP12", sku: "RET-998877" };
    const { fetchImpl } = stubFetch({ [pageUrl(1)]: JSON.stringify([product]) });
    const retailer = readSourceSettings({ kind: "retailer", brand: "Picture Polish" }, SOURCE);
    const [listing] = (await connector(fetchImpl, { settings: retailer }).instance.pullProducts(PULL)).records;
    assert.equal(listing.normalized.vendorCode, "PP12");
    const noCode = { ...product, name: "Picture Polish – Atomic" };
    const { fetchImpl: fetchNoCode } = stubFetch({ [pageUrl(1)]: JSON.stringify([noCode]) });
    const [fallback] = (await connector(fetchNoCode, { settings: retailer }).instance.pullProducts(PULL)).records;
    assert.equal(fallback.normalized.vendorCode, "RET-998877");
    const { fetchImpl: fetchBrand } = stubFetch({ [pageUrl(1)]: JSON.stringify([product]) });
    const [brand] = (await connector(fetchBrand).instance.pullProducts(PULL)).records;
    assert.equal(brand.normalized.vendorCode, "RET-998877");
  });

  it("fails the pull on a Store API error status", async () => {
    const { fetchImpl } = stubFetch({ [pageUrl(1)]: { status: 403, body: "" } });
    await assert.rejects(connector(fetchImpl).instance.pullProducts(PULL), /Store API request failed: HTTP 403/);
  });
});

describe("WooCommerce Store API helpers", () => {
  it("minorUnitsToDecimal divides by 10^minor_unit as a decimal string", () => {
    assert.equal(minorUnitsToDecimal("1200", 2), "12.00");
    assert.equal(minorUnitsToDecimal("5", 2), "0.05");
    assert.equal(minorUnitsToDecimal("1200", 0), "1200.00");
    assert.equal(minorUnitsToDecimal("12345", 3), "12.345");
    assert.equal(minorUnitsToDecimal(1999, "2"), "19.99");
    assert.equal(minorUnitsToDecimal("0", 2), null);
    assert.equal(minorUnitsToDecimal("12.00", 2), null);
    assert.equal(minorUnitsToDecimal("1200", null), null);
  });

  it("wooStorePrice needs an amount and an ISO currency", () => {
    assert.deepEqual(wooStorePrice({ price: "1200", currency_code: "aud", currency_minor_unit: 2 }), { price: "12.00", currency: "AUD" });
    assert.deepEqual(wooStorePrice({ price: "1200", currency_code: "", currency_minor_unit: 2 }), { price: null, currency: null });
    assert.deepEqual(wooStorePrice(null), { price: null, currency: null });
  });

  it("maps a product onto the platform-neutral store filter fields", () => {
    assert.deepEqual(wooStoreFilterProduct(SAMPLE[0], "Picture Polish"), {
      title: "Picture Polish – Atomic",
      product_type: "Nail Polish",
      tags: ["Orange"],
      body_html: SAMPLE[0].description,
      vendor: "Picture Polish",
    });
  });
});
