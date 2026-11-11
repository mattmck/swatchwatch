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
  gateWooStoreProduct,
  buildWooStoreRecord,
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
    log.push({ url, headers: init.headers });
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

/** A connector on a fake clock: `sleep` records the wait and advances the clock by it. */
function connector(fetchImpl, options = {}) {
  const sleeps = [];
  let clock = 1_000_000;
  const instance = new WooCommerceStoreConnector(SOURCE, BASE, options.settings ?? SETTINGS, {
    fetchImpl,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
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
    assert.deepEqual(sleeps, [1000], "the products request waits 1 s after robots.txt");

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
        tags: ["Orange", "Cremes"],
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
        vendorCode: null,
        kind: "brand",
      }
    );
    assert.equal(atomic.normalized.listingTitle, undefined, "brand mode");
    // The store SKU is kept apart from vendorCode (only a title "#CODE" becomes a shade alias).
    assert.equal(atomic.normalized.sku, "PP-ATOMIC");

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
    assert.deepEqual(sleeps, [1000, 1000]);
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

  it("vendorCode is only the #CODE parsed from the title, never the store SKU (kept in sku), in either mode", async () => {
    const product = { ...SAMPLE[0], id: 5001, name: "Picture Polish – Atomic #PP12", sku: "RET-998877" };
    const retailer = readSourceSettings({ kind: "retailer", brand: "Picture Polish" }, SOURCE);
    for (const settings of [retailer, SETTINGS]) {
      const { fetchImpl } = stubFetch({ [pageUrl(1)]: JSON.stringify([product]) });
      const [record] = (await connector(fetchImpl, { settings }).instance.pullProducts(PULL)).records;
      assert.equal(record.normalized.vendorCode, "PP12", settings.kind);
      assert.equal(record.normalized.sku, "RET-998877", settings.kind);
      const noCode = { ...product, name: "Picture Polish – Atomic" };
      const { fetchImpl: fetchNoCode } = stubFetch({ [pageUrl(1)]: JSON.stringify([noCode]) });
      const [plain] = (await connector(fetchNoCode, { settings }).instance.pullProducts(PULL)).records;
      assert.equal(plain.normalized.vendorCode, null, settings.kind);
      assert.equal(plain.normalized.sku, "RET-998877", settings.kind);
    }
  });

  it("maps the brand through metadata.vendorAliases", async () => {
    const settings = readSourceSettings({ kind: "retailer", vendorAliases: { "piCture pOlish": "Picture Polish" } }, SOURCE);
    const product = { ...SAMPLE[0], id: 5101, name: "Atomic", brands: [{ id: 1, name: "piCture pOlish" }] };
    const { fetchImpl } = stubFetch({ [pageUrl(1)]: JSON.stringify([product]) });
    const [record] = (await connector(fetchImpl, { settings }).instance.pullProducts(PULL)).records;
    assert.equal(record.normalized.brand, "Picture Polish");
  });

  it("skips a retailer product without a brand when the source has no metadata.brand, counting it", async () => {
    const settings = readSourceSettings({ kind: "retailer" }, SOURCE);
    const product = { ...SAMPLE[0], id: 5102, name: "Atomic", brands: [], attributes: [] };
    const { fetchImpl } = stubFetch({ [pageUrl(1)]: JSON.stringify([product]) });
    const result = await connector(fetchImpl, { settings }).instance.pullProducts(PULL);
    assert.equal(result.records.length, 0);
    assert.equal(result.metadata.vendorlessSkipped, 1);
  });

  it("the record's tags are the list the gate read: the tags, then the categories after the first", async () => {
    const product = {
      ...SAMPLE[0],
      id: 5103,
      tags: [{ id: 1, name: "Orange" }],
      categories: [{ id: 2, name: "Nail Polish" }, { id: 3, name: "Cremes" }, { id: 4, name: "Summer" }],
    };
    const { fetchImpl } = stubFetch({ [pageUrl(1)]: JSON.stringify([product]) });
    const [record] = (await connector(fetchImpl).instance.pullProducts(PULL)).records;
    assert.deepEqual(record.normalized.tags, ["Orange", "Cremes", "Summer"]);
  });

  it("fails on a 400/404 for a page X-WP-TotalPages says exists, instead of ending the catalog", async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ ...SAMPLE[0], id: 50000 + i, name: `Shade ${i}` }));
    const { fetchImpl, log } = stubFetch({
      [pageUrl(1)]: { status: 200, body: JSON.stringify(full), headers: { "x-wp-totalpages": "3" } },
      [pageUrl(2)]: { status: 404, body: '{"code":"rest_invalid_param"}' },
    });
    await assert.rejects(
      connector(fetchImpl).instance.pullProducts({ ...PULL, pageSize: 500, maxRecords: 500 }),
      /Store API request failed: HTTP 404 \(page 2 of 3 per X-WP-TotalPages\)/
    );
    assert.deepEqual(log.map((entry) => entry.url), [`${BASE}/robots.txt`, pageUrl(1), pageUrl(2)]);
  });

  it("drops a mystery or grab bag before the category gate, even under Nail Polish", async () => {
    const bags = ["Mystery Bag", "Halloween Grab Bag", "Surprise Bag of Polish", "Blind Bag Nail Polish"].map((name, i) => ({
      ...SAMPLE[0],
      id: 6000 + i,
      name,
    }));
    const { fetchImpl } = stubFetch({ [pageUrl(1)]: JSON.stringify([...bags, SAMPLE[0]]) });
    const result = await connector(fetchImpl).instance.pullProducts(PULL);
    assert.deepEqual(result.records.map((record) => record.externalId), ["4211"]);
  });

  it("keeps a shade whose name only contains the word Mystery", async () => {
    const products = [
      { ...SAMPLE[0], id: 6100, name: "Midnight Mystery" },
      { ...SAMPLE[0], id: 6101, name: "Mystery" },
      { ...SAMPLE[0], id: 6102, name: "Mystery Bag" },
    ];
    const { fetchImpl } = stubFetch({ [pageUrl(1)]: JSON.stringify(products) });
    const result = await connector(fetchImpl).instance.pullProducts(PULL);
    assert.deepEqual(result.records.map((record) => record.externalId), ["6100", "6101"]);
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

  it("maps a product onto the platform-neutral store filter fields (tags = the tags, then every category after the first, as the gate reads them)", () => {
    assert.deepEqual(wooStoreFilterProduct(SAMPLE[0], "Picture Polish"), {
      title: "Picture Polish – Atomic",
      product_type: "Nail Polish",
      tags: ["Orange", ...SAMPLE[0].categories.slice(1).map((category) => category.name)],
      body_html: SAMPLE[0].description,
      vendor: "Picture Polish",
    });
  });
});

describe("WooCommerceStoreConnector: redirects", () => {
  const redirectTo = (location, status = 301) => ({ status, body: "", headers: { location } });
  const ROBOTS = "User-agent: *\nDisallow: /private/\n";

  it("fetches with redirect: manual and follows a same-origin redirect robots.txt allows", async () => {
    const moved = `${BASE}/shop/wp-json/wc/store/v1/products?per_page=100&page=1`;
    const inits = [];
    const { fetchImpl, log } = stubFetch({
      [`${BASE}/robots.txt`]: ROBOTS,
      [pageUrl(1)]: redirectTo("/shop/wp-json/wc/store/v1/products?per_page=100&page=1", 308),
      [moved]: JSON.stringify(SAMPLE),
    });
    const spy = async (url, init) => {
      inits.push(init);
      return fetchImpl(url, init);
    };
    const { instance, sleeps } = connector(spy);
    const result = await instance.pullProducts(PULL);
    assert.deepEqual(log.map((entry) => entry.url), [`${BASE}/robots.txt`, pageUrl(1), moved]);
    assert.deepEqual(sleeps, [1000, 1000], "every hop is paced");
    assert.ok(inits.every((init) => init.redirect === "manual"));
    assert.deepEqual(result.records.map((record) => record.externalId), ["4211", "4212", "4215"]);
  });

  for (const [label, location, origin] of [
    ["to another origin", "https://cdn.example/products.json?token=SECRET", "https://cdn.example"],
    ["to a path robots.txt disallows", `${BASE}/private/products?token=SECRET`, BASE],
  ]) {
    it(`refuses a redirect ${label} without requesting it`, async () => {
      const { fetchImpl, log } = stubFetch({
        [`${BASE}/robots.txt`]: ROBOTS,
        [pageUrl(1)]: redirectTo(location, 302),
        [location]: JSON.stringify(SAMPLE),
      });
      await assert.rejects(connector(fetchImpl).instance.pullProducts(PULL), (error) => {
        assert.equal(error.message, `WooCommerce Store API redirected out of scope: ${origin}`);
        return true;
      });
      assert.deepEqual(log.map((entry) => entry.url), [`${BASE}/robots.txt`, pageUrl(1)]);
    });
  }

  it("fails after more than three hops", async () => {
    const hop = (n) => `${BASE}/hop-${n}`;
    const { fetchImpl, log } = stubFetch({
      [`${BASE}/robots.txt`]: ROBOTS,
      [pageUrl(1)]: redirectTo(hop(1)),
      [hop(1)]: redirectTo(hop(2)),
      [hop(2)]: redirectTo(hop(3)),
      [hop(3)]: redirectTo(hop(4)),
      [hop(4)]: JSON.stringify(SAMPLE),
    });
    await assert.rejects(connector(fetchImpl).instance.pullProducts(PULL), /more than 3 redirects/);
    assert.deepEqual(log.map((entry) => entry.url), [`${BASE}/robots.txt`, pageUrl(1), hop(1), hop(2), hop(3)]);
  });
});

// Picture Polish (enabled 2026-11-10): the store filter and the shade-name parser, keyed by source
// name, through the WooCommerce gate. Hand-made products in the Store API shape; WordPress sends
// names HTML-escaped and lists categories alphabetically, so "Nail Colours" is rarely the first.
describe("WooCommerce gate: Picture Polish store filter and title parser", () => {
  const wooProduct = (id, name, categories, tags = []) => ({
    id,
    name,
    type: "simple",
    permalink: `${BASE}/product/p${id}/`,
    prices: { price: "1295", currency_code: "AUD", currency_minor_unit: 2 },
    categories: categories.map((category, index) => ({ id: index + 1, name: category, slug: category.toLowerCase() })),
    tags: tags.map((tag, index) => ({ id: index + 100, name: tag, slug: tag })),
    images: [],
    is_in_stock: true,
  });

  it("keeps a Nail Colours product (not the first category) and names it by the first \" | \" segment", () => {
    const product = wooProduct(11, "Camelot | Purple | Flakie", ["Flakie", "Halal Breathable Nail Polish", "Nail Colours", "Purple"], ["purple flakie nail polish"]);
    const outcome = gateWooStoreProduct(product, SOURCE, SETTINGS);
    assert.equal(outcome.accept, true);
    const record = buildWooStoreRecord(outcome.gated, SETTINGS);
    assert.equal(record.normalized.name, "Camelot");
    assert.equal(record.normalized.rawTitle, "Camelot | Purple | Flakie");
    assert.equal(record.normalized.brand, "Picture Polish");
  });

  it("decodes an entity-encoded name before parsing it", () => {
    const outcome = gateWooStoreProduct(wooProduct(12, "Rock &amp; Roll | Black | Glitter", ["Glitter", "Nail Colours"]), SOURCE, SETTINGS);
    assert.equal(outcome.accept, true);
    assert.equal(buildWooStoreRecord(outcome.gated, SETTINGS).normalized.name, "Rock & Roll");
  });

  it("classifies the raw name, not the parsed shade, unless only the dropped part reads as a set", () => {
    // "Naked" alone would read as a polish name; the raw "… | Base Coat" keeps the coat category.
    const outcome = gateWooStoreProduct(wooProduct(15, "Naked | Nail Care | Base Coat", ["Base &amp; Top Coats", "Nail Care", "Nail Polish"]), SOURCE, SETTINGS);
    assert.equal(outcome.accept, true);
    assert.equal(outcome.gated.category, "base_coat");
    assert.equal(buildWooStoreRecord(outcome.gated, SETTINGS).normalized.name, "Naked");
  });

  it("drops a Bundles product even under Nail Colours", () => {
    assert.equal(gateWooStoreProduct(wooProduct(13, "Neon Bundle", ["Bundles", "Nail Paint", "Nail Polish"]), SOURCE, SETTINGS).accept, false);
    assert.equal(gateWooStoreProduct(wooProduct(14, "Magnet Kit", ["Bundles", "Nail Colours"]), SOURCE, SETTINGS).accept, false);
  });
});
