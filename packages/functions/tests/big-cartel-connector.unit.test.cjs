// Big Cartel connector (brand sources plan, Task 17). The fixture tests/fixtures/big-cartel-sample.json
// is hand-written from the Big Cartel v0 API docs (developers.bigcartel.com/api/v0, products.json
// fields; no store was contacted to write it): two polishes (one sold out), a "Mystery Bag" under
// the Nail Polish category and a stamping plate.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  BigCartelConnector,
  bigCartelStoreFilterProduct,
  buildBigCartelRecord,
  gateBigCartelProduct,
} = require("../dist/lib/connectors/big-cartel");
const { MYSTERY_TITLE_REGEX } = require("../dist/lib/connectors/store-filters/shared");
const { readSourceSettings } = require("../dist/lib/source-settings");

const SAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "big-cartel-sample.json"), "utf8"));
const SOURCE = "PaintedPolishBigCartel";
const API = "https://api.bigcartel.com/paintedpolish";
const PRODUCTS = `${API}/products.json`;
const STORE = `${API}/store.json`;
const STORE_URL = "https://shop.example-polish.com";
const STORE_JSON = JSON.stringify({
  name: "Painted Polish",
  url: STORE_URL,
  currency: { code: "USD", name: "U.S. Dollar", sign: "$" },
});
const SETTINGS = readSourceSettings({ brand: "Painted Polish", subdomain: "paintedpolish" }, SOURCE);
const PULL = { searchTerm: "", page: 1, pageSize: 100, maxRecords: 100 };
const UA = "SwatchWatch/connector-ingestion (+https://github.com/mattmck/swatchwatch)";

/** Fetch stub: `routes` maps a URL to a body (200) or `{ status, body }`; every request is logged. */
function stubFetch(routes) {
  const log = [];
  const fetchImpl = async (url, init) => {
    log.push({ url, headers: init.headers });
    const route = routes[url];
    const answer = route === undefined ? { status: 404, body: "" } : typeof route === "string" ? { status: 200, body: route } : route;
    return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, statusText: "", text: async () => answer.body };
  };
  return { fetchImpl, log };
}

/** A connector on a fake clock: `sleep` records the wait and advances the clock by it. */
function connector(fetchImpl, options = {}) {
  const sleeps = [];
  let clock = 1_000_000;
  const instance = new BigCartelConnector(SOURCE, options.baseUrl ?? null, options.settings ?? SETTINGS, {
    fetchImpl,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  });
  return { instance, sleeps };
}

describe("BigCartelConnector: fixture", () => {
  it("reads products.json and store.json once, keeps the 2 polishes (a Mystery Bag and a plate dropped)", async () => {
    const { fetchImpl, log } = stubFetch({ [PRODUCTS]: JSON.stringify(SAMPLE), [STORE]: STORE_JSON });
    const { instance, sleeps } = connector(fetchImpl);
    const result = await instance.pullProducts(PULL);

    assert.deepEqual(log.map((entry) => entry.url), [PRODUCTS, STORE]);
    assert.ok(log.every((entry) => entry.headers["User-Agent"] === UA && entry.headers.Accept === "application/json"));
    assert.deepEqual(sleeps, [1000], "store.json waits 1 s after products.json");

    assert.deepEqual(result.records.map((record) => record.externalId), ["pumpkin-spice-crelly", "midnight-orchard"]);
    assert.deepEqual(result.catalog, {
      externalIds: ["pumpkin-spice-crelly", "midnight-orchard", "mystery-bag", "stamping-plate-sp-01"],
      complete: true,
    });
    assert.equal(result.metadata.fetchedProductCount, 4);
    assert.equal(result.metadata.connectorType, "big-cartel");

    const [pumpkin, midnight] = result.records;
    assert.equal(pumpkin.gtin, null);
    assert.equal(pumpkin.raw.id, 91000001);
    assert.deepEqual(
      {
        brand: pumpkin.normalized.brand,
        name: pumpkin.normalized.name,
        rawTitle: pumpkin.normalized.rawTitle,
        productType: pumpkin.normalized.productType,
        productCategory: pumpkin.normalized.productCategory,
        tags: pumpkin.normalized.tags,
        descriptors: pumpkin.normalized.descriptors,
        descriptionText: pumpkin.normalized.descriptionText,
        imageUrls: pumpkin.normalized.imageUrls,
        primaryImageUrl: pumpkin.normalized.primaryImageUrl,
        productUrl: pumpkin.normalized.productUrl,
        price: pumpkin.normalized.price,
        currency: pumpkin.normalized.currency,
        available: pumpkin.normalized.available,
        kind: pumpkin.normalized.kind,
      },
      {
        brand: "Painted Polish",
        name: "Pumpkin Spice Crelly",
        rawTitle: "Pumpkin Spice Crelly",
        productType: "Nail Polish",
        productCategory: "color",
        tags: ["Nail Polish", "Crellies"],
        descriptors: ["Full Size (15 ml)", "Mini (5 ml)", "Nail Polish", "Crellies"],
        descriptionText: pumpkin.normalized.descriptionText,
        imageUrls: [
          "https://images.bigcartel.com/product_images/400000001/pumpkin-spice.jpg",
          "https://images.bigcartel.com/product_images/400000002/pumpkin-spice-swatch.jpg",
        ],
        primaryImageUrl: "https://images.bigcartel.com/product_images/400000001/pumpkin-spice.jpg",
        productUrl: `${STORE_URL}/product/pumpkin-spice-crelly`,
        price: "12.00",
        currency: "USD",
        available: true,
        kind: "brand",
      }
    );
    assert.match(pumpkin.normalized.descriptionText, /^A warm orange crelly packed with copper flakies\.\s+15 ml\.$/);
    assert.equal(pumpkin.normalized.listingTitle, undefined, "brand mode");

    // Sold out is kept, unavailable; an absolute url is kept; a "Default" option is no descriptor.
    assert.equal(midnight.normalized.available, false);
    assert.equal(midnight.normalized.productUrl, "https://shop.example-polish.com/product/midnight-orchard");
    assert.equal(midnight.normalized.price, "11.50");
    assert.deepEqual(midnight.normalized.descriptors, ["Nail Polish"]);
  });

  it("metadata.currency overrides store.json's currency.code", async () => {
    const settings = readSourceSettings({ brand: "Painted Polish", subdomain: "paintedpolish", currency: "cad" }, SOURCE);
    const { fetchImpl } = stubFetch({ [PRODUCTS]: JSON.stringify(SAMPLE), [STORE]: STORE_JSON });
    const result = await connector(fetchImpl, { settings }).instance.pullProducts(PULL);
    assert.equal(result.records[0].normalized.currency, "CAD");
  });

  it("without store.json, resolves urls against data_source.base_url and leaves price and currency empty", async () => {
    const { fetchImpl } = stubFetch({ [PRODUCTS]: JSON.stringify(SAMPLE), [STORE]: { status: 404, body: "" } });
    const result = await connector(fetchImpl, { baseUrl: "https://paintedpolish.com/" }).instance.pullProducts(PULL);
    assert.equal(result.records[0].normalized.productUrl, "https://paintedpolish.com/product/pumpkin-spice-crelly");
    assert.equal(result.records[0].normalized.currency, null);
    assert.equal(result.records[0].normalized.price, null);
    assert.equal(result.metadata.storeJsonRead, false);
  });

  it("falls back to the bigcartel.com subdomain when neither store.json nor base_url names the store", async () => {
    const { fetchImpl } = stubFetch({ [PRODUCTS]: JSON.stringify(SAMPLE) });
    const result = await connector(fetchImpl).instance.pullProducts(PULL);
    assert.equal(result.records[0].normalized.productUrl, "https://paintedpolish.bigcartel.com/product/pumpkin-spice-crelly");
  });

  it("serves later pages from the job's catalog cache without any request and without a catalog", async () => {
    let saved = null;
    const cache = { load: async () => saved, save: async (products) => { saved = products; } };
    const { fetchImpl, log } = stubFetch({ [PRODUCTS]: JSON.stringify(SAMPLE), [STORE]: STORE_JSON });
    const first = await connector(fetchImpl).instance.pullProducts({ ...PULL, pageSize: 1, catalogCache: cache });
    const second = await connector(fetchImpl).instance.pullProducts({ ...PULL, page: 2, pageSize: 1, catalogCache: cache });
    assert.equal(log.length, 2, "products.json + store.json, on the first pull only");
    assert.deepEqual(first.records.map((record) => record.externalId), ["pumpkin-spice-crelly"]);
    assert.deepEqual(second.records.map((record) => record.externalId), ["midnight-orchard"]);
    // The cached store facts still apply.
    assert.equal(second.records[0].normalized.currency, "USD");
    assert.equal(second.records[0].normalized.productUrl, "https://shop.example-polish.com/product/midnight-orchard");
    assert.equal(second.records[0].raw.permalink, "midnight-orchard");
    assert.ok(first.catalog);
    assert.equal(second.catalog, undefined);
  });

  it("retailer mode parses the title and keeps listingTitle", async () => {
    const settings = readSourceSettings({ kind: "retailer", brand: "Painted Polish", subdomain: "paintedpolish" }, SOURCE);
    const product = { ...SAMPLE[0], name: "Painted Polish - Pumpkin Spice Crelly #PP101", permalink: "pp-pumpkin" };
    const { fetchImpl } = stubFetch({ [PRODUCTS]: JSON.stringify([product]), [STORE]: STORE_JSON });
    const [record] = (await connector(fetchImpl, { settings }).instance.pullProducts(PULL)).records;
    assert.equal(record.normalized.name, "Pumpkin Spice Crelly");
    assert.equal(record.normalized.vendorCode, "PP101");
    assert.equal(record.normalized.listingTitle, "Painted Polish - Pumpkin Spice Crelly #PP101");
  });

  it("maps metadata.brand through metadata.vendorAliases", async () => {
    const settings = readSourceSettings(
      { brand: "piCture pOlish", subdomain: "paintedpolish", vendorAliases: { "piCture pOlish": "Picture Polish" } },
      SOURCE
    );
    const { fetchImpl } = stubFetch({ [PRODUCTS]: JSON.stringify([SAMPLE[0]]), [STORE]: STORE_JSON });
    const [record] = (await connector(fetchImpl, { settings }).instance.pullProducts(PULL)).records;
    assert.equal(record.normalized.brand, "Picture Polish");
  });

  it("the gate skips a retailer product as vendorless when the source names no brand", () => {
    const settings = readSourceSettings({ kind: "retailer", subdomain: "paintedpolish" }, SOURCE);
    const outcome = gateBigCartelProduct({ product: SAMPLE[0], store: { url: null, currency: null } }, SOURCE, settings);
    assert.deepEqual(outcome, { accept: false, vendorless: true });
  });

  it("keeps a shade whose name only contains the word Mystery; drops a Mystery Bag", () => {
    const store = { url: null, currency: null };
    for (const [name, accept] of [["Midnight Mystery", true], ["Mystery", true], ["Mystery Bag", false]]) {
      const outcome = gateBigCartelProduct({ product: { ...SAMPLE[0], name }, store }, SOURCE, SETTINGS);
      assert.equal(outcome.accept, accept, name);
    }
  });

  it("fails the pull on a products.json error status and on an empty store", async () => {
    const { fetchImpl } = stubFetch({ [PRODUCTS]: { status: 404, body: "" } });
    await assert.rejects(connector(fetchImpl).instance.pullProducts(PULL), /Big Cartel API request failed: HTTP 404/);
    const { fetchImpl: empty } = stubFetch({ [PRODUCTS]: "[]", [STORE]: STORE_JSON });
    await assert.rejects(connector(empty).instance.pullProducts(PULL), /returned no products/);
  });

  it("requires a valid metadata.subdomain", () => {
    const settings = readSourceSettings({ brand: "Painted Polish" }, SOURCE);
    assert.throws(() => new BigCartelConnector(SOURCE, null, settings), /metadata\.subdomain is required/);
    const bad = readSourceSettings({ brand: "Painted Polish", subdomain: "../admin" }, SOURCE);
    assert.throws(() => new BigCartelConnector(SOURCE, null, bad), /metadata\.subdomain/);
  });

  it("maps a product onto the platform-neutral store filter fields", () => {
    assert.deepEqual(bigCartelStoreFilterProduct(SAMPLE[0], "Painted Polish"), {
      title: "Pumpkin Spice Crelly",
      product_type: "Nail Polish",
      tags: ["Nail Polish", "Crellies"],
      handle: "pumpkin-spice-crelly",
      body_html: SAMPLE[0].description,
      vendor: "Painted Polish",
    });
  });
});

describe("Big Cartel factory", () => {
  const { createConnector } = require("../dist/functions/ingestion");

  it("throws without metadata.brand: a Big Cartel record is never given another brand", () => {
    const settings = readSourceSettings({ subdomain: "paintedpolish" }, SOURCE);
    assert.throws(() => createConnector(SOURCE, null, settings), /^Error: BigCartel source PaintedPolishBigCartel has no metadata\.brand$/);
  });

  it("builds a BigCartelConnector with a brand", () => {
    assert.ok(createConnector(SOURCE, null, SETTINGS) instanceof BigCartelConnector);
  });
});

describe("MYSTERY_TITLE_REGEX", () => {
  it("matches mystery and grab-bag titles, not shade names that merely contain the letters", () => {
    for (const title of ["Mystery Bag", "mystery polish", "Halloween Grab Bag", "Surprise Bag", "BLIND BAG #3"]) {
      assert.match(title, MYSTERY_TITLE_REGEX, title);
    }
    for (const title of ["Mystery Polishes", "Mystery Box", "Holiday Mystery Pack"]) {
      assert.match(title, MYSTERY_TITLE_REGEX, title);
    }
    for (const title of ["Mysteryous Orchid", "Grab Bagel", "Blind Date", "Surprise Party", "Mystery", "Midnight Mystery"]) {
      assert.doesNotMatch(title, MYSTERY_TITLE_REGEX, title);
    }
  });
});

// Painted Polish and Potion Polish (enabled 2026-11-10): the store filter and the shade-name
// parser, keyed by source name, through the Big Cartel gate. Hand-made products in the v0 shape.
describe("Big Cartel gate: store filters and title parsers", () => {
  const STORE_FACTS = { url: "https://paintedpolish.com", currency: "USD" };
  const bcProduct = (name, categories, extra = {}) => ({
    name,
    permalink: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    url: "/product/x",
    status: "active",
    price: 14,
    categories: categories.map((category, id) => ({ id, name: category, permalink: category.toLowerCase() })),
    images: [],
    options: [{ id: 1, name: "Default", price: 14 }],
    ...extra,
  });
  const gate = (source, settings, product) => gateBigCartelProduct({ product, store: STORE_FACTS }, source, settings);
  const POTION = "PotionPolishBigCartel";
  const POTION_SETTINGS = readSourceSettings({ brand: "Potion Polish", subdomain: "potionpolish" }, POTION);

  it("Painted Polish: keeps an Individual Shades product and names it without the FINAL stock note", () => {
    const product = bcProduct("Party Fowl (FINAL 3 BOTTLES)", ["Individual Shades", "Thermals"]);
    const outcome = gate(SOURCE, SETTINGS, product);
    assert.equal(outcome.accept, true);
    assert.equal(outcome.gated.category, "color");
    const record = buildBigCartelRecord(outcome.gated, SETTINGS, "https://paintedpolish.com");
    assert.equal(record.normalized.name, "Party Fowl");
    assert.equal(record.normalized.rawTitle, "Party Fowl (FINAL 3 BOTTLES)");
    assert.equal(record.normalized.brand, "Painted Polish");
  });

  it("Painted Polish: drops Sets and the Imperfect Label Bottles listing; a product without either category goes to the generic gate", () => {
    assert.equal(gate(SOURCE, SETTINGS, bcProduct("Booked For Love: Part I", ["Sets"])).accept, false);
    assert.equal(gate(SOURCE, SETTINGS, bcProduct("Imperfect Label Bottles", [])).accept, false);
    // Deferred: no polish signal in "Jellies, Flakies" → the generic gate drops it ...
    assert.equal(gate(SOURCE, SETTINGS, bcProduct("Stay Wicked", ["Jellies", "Flakies"])).accept, false);
    // ... and keeps one under a polish category.
    assert.equal(gate(SOURCE, SETTINGS, bcProduct("Stay Wicked", ["Nail Polish"])).accept, true);
  });

  it("Potion Polish: keeps a polish the generic gate would drop, as a colour polish, without its trailing notes", () => {
    const product = bcProduct("Autumn Enthusiast - Magnetic - Limited Edition", ["Glitter Jellies", "Magnetics", "Autumn 2026"]);
    assert.equal(gate("NotARealBigCartel", POTION_SETTINGS, product).accept, false, "the generic gate alone drops it");
    const outcome = gate(POTION, POTION_SETTINGS, product);
    assert.equal(outcome.accept, true);
    assert.equal(outcome.gated.category, "color");
    const record = buildBigCartelRecord(outcome.gated, POTION_SETTINGS, "https://www.potionpolish.com");
    assert.equal(record.normalized.name, "Autumn Enthusiast");
    assert.equal(record.normalized.rawTitle, "Autumn Enthusiast - Magnetic - Limited Edition");
    assert.equal(record.normalized.productCategory, "color");
    const twoPointOh = gate(POTION, POTION_SETTINGS, bcProduct("Cinnamon Cider 2.0 - Limited Edition", ["Holos"]));
    assert.equal(buildBigCartelRecord(twoPointOh.gated, POTION_SETTINGS, "https://www.potionpolish.com").normalized.name, "Cinnamon Cider 2.0");
  });

  it("Potion Polish: drops the Mystery Polish category", () => {
    assert.equal(gate(POTION, POTION_SETTINGS, bcProduct("Magnetic Mystery Duo", ["Magnetics", "Mystery Polish"])).accept, false);
    assert.equal(gate(POTION, POTION_SETTINGS, bcProduct("Wintery Blues Overpour", ["On Sale", "Mystery Polish"])).accept, false);
  });
});
