/**
 * Brand list prices on connector products (lib/product-price.ts), the connectors that write
 * them into normalized_json, and `npm run backfill:product-price`. No DB, no network: fetch and
 * the query function are faked.
 */
const { describe, it, afterEach, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeCurrencyCode,
  normalizePriceAmount,
  pickShopifyVariantPrice,
  shopifyProductPrice,
  makeupApiProductPrice,
  currencyFromSourceMetadata,
  currencyFromShopifyMeta,
  fetchShopifyStoreCurrency,
  resolveShopifyStoreCurrency,
  productPriceFromRaw,
} = require("../dist/lib/product-price");
const {
  parseBackfillArgs,
  planProductPricePatch,
  runBackfill,
} = require("../dist/scripts/backfill-product-price");
const fixture = require("./fixtures/shopify-price-products.json");

describe("normalizeCurrencyCode", () => {
  it("accepts ISO 4217 codes in any case", () => {
    assert.equal(normalizeCurrencyCode("USD"), "USD");
    assert.equal(normalizeCurrencyCode(" cad "), "CAD");
    assert.equal(normalizeCurrencyCode("eur"), "EUR");
  });

  it("rejects symbols, junk and unknown codes", () => {
    for (const value of ["$", "US", "USDX", "", null, undefined, 840, "ZZZ"]) {
      assert.equal(normalizeCurrencyCode(value), null, String(value));
    }
  });
});

describe("normalizePriceAmount", () => {
  it("returns a decimal string with at least two decimals", () => {
    assert.equal(normalizePriceAmount("12.5"), "12.50");
    assert.equal(normalizePriceAmount("8"), "8.00");
    assert.equal(normalizePriceAmount(12), "12.00");
    assert.equal(normalizePriceAmount(" 14.00 "), "14.00");
    assert.equal(normalizePriceAmount("0.1234"), "0.1234");
  });

  it("drops missing, zero, negative, non-numeric and absurd prices", () => {
    for (const value of ["", "0", "0.00", "-1", "free", "1,99", "12.345678", "1e3", "200000", NaN, Infinity, null, {}]) {
      assert.equal(normalizePriceAmount(value), null, String(value));
    }
  });
});

describe("pickShopifyVariantPrice", () => {
  const [multi, soldOut, unpriced] = fixture.products;

  it("takes the lowest price among available variants (sold-out cheaper variant ignored)", () => {
    assert.equal(pickShopifyVariantPrice(multi.variants), "14.00");
  });

  it("falls back to the lowest variant price when every variant is sold out", () => {
    assert.equal(pickShopifyVariantPrice(soldOut.variants), "9.00");
  });

  it("is null when no variant has a usable price", () => {
    assert.equal(pickShopifyVariantPrice(unpriced.variants), null);
    assert.equal(pickShopifyVariantPrice([]), null);
    assert.equal(pickShopifyVariantPrice(null), null);
  });

  it("treats a variant without `available` as not known to be available", () => {
    assert.equal(pickShopifyVariantPrice([{ price: "5.00" }, { price: "7.00", available: true }]), "7.00");
    assert.equal(pickShopifyVariantPrice([{ price: "5.00" }, { price: "7.00" }]), "5.00");
  });
});

describe("price + currency pairs", () => {
  it("shopifyProductPrice keeps a currency only with a price", () => {
    assert.deepEqual(shopifyProductPrice(fixture.products[0].variants, "usd"), { price: "14.00", currency: "USD" });
    assert.deepEqual(shopifyProductPrice(fixture.products[0].variants, null), { price: "14.00", currency: null });
    assert.deepEqual(shopifyProductPrice(fixture.products[2].variants, "USD"), { price: null, currency: null });
  });

  it("makeupApiProductPrice never turns price_sign into a currency", () => {
    assert.deepEqual(makeupApiProductPrice({ price: "10.0", price_sign: "$", currency: "CAD" }), { price: "10.00", currency: "CAD" });
    assert.deepEqual(makeupApiProductPrice({ price: "10.0", price_sign: "$", currency: null }), { price: "10.00", currency: null });
    assert.deepEqual(makeupApiProductPrice({ price: "0.0", currency: "USD" }), { price: null, currency: null });
  });

  it("reads currencies from source metadata and /meta.json bodies", () => {
    assert.equal(currencyFromSourceMetadata({ currency: "gbp", notes: "x" }), "GBP");
    assert.equal(currencyFromSourceMetadata({ notes: "x" }), null);
    assert.equal(currencyFromSourceMetadata(null), null);
    assert.equal(currencyFromShopifyMeta({ name: "Shop", currency: "AUD", money_format: "${{amount}}" }), "AUD");
    assert.equal(currencyFromShopifyMeta({ products: [] }), null);
  });

  it("productPriceFromRaw dispatches by source and skips sources without prices", () => {
    assert.deepEqual(productPriceFromRaw("MooncatShopify", fixture.products[1], "CAD"), { price: "9.00", currency: "CAD" });
    assert.deepEqual(productPriceFromRaw("MakeupAPI", { price: "7.5", currency: "usd" }, null), { price: "7.50", currency: "USD" });
    assert.equal(productPriceFromRaw("OpenBeautyFacts", { code: "123" }, "USD"), null);
    assert.equal(productPriceFromRaw("MooncatShopify", null, "USD"), null);
  });
});

describe("store currency lookup", () => {
  it("asks /meta.json once and parses the currency", async () => {
    const urls = [];
    const fetchImpl = async (url) => {
      urls.push(url);
      return { ok: true, status: 200, text: async () => JSON.stringify({ currency: "CAD" }) };
    };
    assert.equal(await fetchShopifyStoreCurrency("https://shop.example/", fetchImpl), "CAD");
    assert.deepEqual(urls, ["https://shop.example/meta.json"]);
  });

  it("never throws: HTTP errors, bad JSON and network failures give null", async () => {
    assert.equal(await fetchShopifyStoreCurrency("https://s.example", async () => ({ ok: false, status: 404, text: async () => "" })), null);
    assert.equal(await fetchShopifyStoreCurrency("https://s.example", async () => ({ ok: true, text: async () => "<html>" })), null);
    assert.equal(
      await fetchShopifyStoreCurrency("https://s.example", async () => {
        throw new Error("ECONNRESET");
      }),
      null
    );
  });

  it("a configured source currency wins without a request", async () => {
    let called = false;
    const result = await resolveShopifyStoreCurrency("eur", "https://s.example", async () => {
      called = true;
      return { ok: true, text: async () => "{}" };
    });
    assert.deepEqual(result, { currency: "EUR", source: "source_metadata" });
    assert.equal(called, false);
  });
});

describe("connectors write price and currency into normalized", () => {
  const originalFetch = global.fetch;
  const originalOpenAi = process.env.AZURE_OPENAI_ENDPOINT;
  let metaRequests;

  beforeEach(() => {
    delete process.env.AZURE_OPENAI_ENDPOINT;
    metaRequests = 0;
  });
  afterEach(() => {
    global.fetch = originalFetch;
    if (originalOpenAi === undefined) delete process.env.AZURE_OPENAI_ENDPOINT;
    else process.env.AZURE_OPENAI_ENDPOINT = originalOpenAi;
  });

  function stubShopify(products, meta) {
    global.fetch = async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/meta.json") {
        metaRequests += 1;
        if (meta === undefined) return { ok: false, status: 404, statusText: "Not Found", text: async () => "" };
        return { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify(meta) };
      }
      const body = JSON.stringify({ products: parsed.searchParams.get("page") === "1" ? products : [] });
      return { ok: true, status: 200, statusText: "OK", text: async () => body };
    };
  }

  const pull = (connector) => connector.pullProducts({ searchTerm: "", page: 1, pageSize: 10, maxRecords: 10 });
  const byId = (result) => Object.fromEntries(result.records.map((r) => [r.externalId, r.normalized]));

  it("ShopifyGenericConnector learns the currency from /meta.json", async () => {
    const { ShopifyGenericConnector } = require("../dist/lib/connectors/shopify-generic");
    stubShopify(fixture.products, { name: "Indie", currency: "CAD" });
    const result = await pull(new ShopifyGenericConnector("MooncatShopify", "https://indie.example.test"));
    const normalized = byId(result);
    assert.deepEqual([normalized["101"].price, normalized["101"].currency], ["14.00", "CAD"]);
    assert.deepEqual([normalized["102"].price, normalized["102"].currency], ["9.00", "CAD"]);
    assert.deepEqual([normalized["103"].price, normalized["103"].currency], [null, null]);
    assert.equal(normalized["101"].variants.length, 3, "per-variant prices are still stored");
    assert.equal(result.metadata.storeCurrency, "CAD");
    assert.equal(result.metadata.storeCurrencySource, "shop_meta");
    assert.equal(metaRequests, 1);
  });

  it("ShopifyGenericConnector leaves currency null when the store does not say (never guesses USD)", async () => {
    const { ShopifyGenericConnector } = require("../dist/lib/connectors/shopify-generic");
    stubShopify(fixture.products);
    const result = await pull(new ShopifyGenericConnector("MooncatShopify", "https://indie.example.test"));
    const normalized = byId(result);
    assert.deepEqual([normalized["101"].price, normalized["101"].currency], ["14.00", null]);
    assert.equal(result.metadata.storeCurrencySource, "unknown");
  });

  it("a configured data_source currency is used without asking the shop", async () => {
    const { ShopifyGenericConnector } = require("../dist/lib/connectors/shopify-generic");
    stubShopify(fixture.products, { currency: "CAD" });
    const result = await pull(new ShopifyGenericConnector("MooncatShopify", "https://indie.example.test", { currency: "gbp" }));
    assert.equal(byId(result)["101"].currency, "GBP");
    assert.equal(result.metadata.storeCurrencySource, "source_metadata");
    assert.equal(metaRequests, 0);
  });

  it("no /meta.json request when no product has a price", async () => {
    const { ShopifyGenericConnector } = require("../dist/lib/connectors/shopify-generic");
    stubShopify([fixture.products[2]], { currency: "CAD" });
    const result = await pull(new ShopifyGenericConnector("MooncatShopify", "https://indie.example.test"));
    assert.equal(byId(result)["103"].price, null);
    assert.equal(metaRequests, 0);
  });

  it("HoloTacoShopifyConnector", async () => {
    const { HoloTacoShopifyConnector } = require("../dist/lib/connectors/holo-taco-shopify");
    stubShopify(fixture.products.map((p) => ({ ...p, vendor: "Holo Taco" })), { currency: "USD" });
    const result = await pull(new HoloTacoShopifyConnector("https://holo.example.test"));
    const normalized = byId(result);
    assert.deepEqual([normalized["101"].price, normalized["101"].currency], ["14.00", "USD"]);
    assert.deepEqual([normalized["102"].price, normalized["102"].currency], ["9.00", "USD"]);
    assert.equal(result.metadata.storeCurrency, "USD");
  });

  it("MakeupApiConnector stores a normalized price and its currency", async () => {
    const { MakeupApiConnector } = require("../dist/lib/connectors/makeup-api");
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => [
        { id: 5, brand: "zoya", name: "Pixie Dust", product_type: "nail_polish", price: "10.0", price_sign: "$", currency: "CAD", product_colors: [] },
        { id: 6, brand: "zoya", name: "Ivanka", product_type: "nail_polish", price: "9.0", price_sign: "$", currency: null, product_colors: [] },
      ],
    });
    const result = await new MakeupApiConnector().pullProducts({ searchTerm: "", page: 1, pageSize: 10, maxRecords: 10 });
    const normalized = byId(result);
    assert.deepEqual([normalized["5"].price, normalized["5"].currency, normalized["5"].priceSign], ["10.00", "CAD", "$"]);
    assert.deepEqual([normalized["6"].price, normalized["6"].currency], ["9.00", null]);
  });
});

describe("backfill:product-price", () => {
  it("parses args (dry run by default, currency fetch on)", () => {
    const args = parseBackfillArgs([]);
    assert.equal(args.write, false);
    assert.equal(args.fetchCurrency, true);
    const custom = parseBackfillArgs(["--write", "--no-fetch-currency", "--source", "A,B", "--limit", "3"]);
    assert.deepEqual(
      { write: custom.write, fetch: custom.fetchCurrency, sources: custom.sources, limit: custom.limit },
      { write: true, fetch: false, sources: ["A", "B"], limit: 3 }
    );
    assert.throws(() => parseBackfillArgs(["--dry-run", "--write"]), /mutually exclusive/);
    assert.throws(() => parseBackfillArgs(["--nope"]), /Unknown option/);
  });

  it("plans a patch only when the stored price differs, and never clears a known currency", () => {
    const raw = fixture.products[0];
    assert.deepEqual(planProductPricePatch("MooncatShopify", raw, {}, "CAD"), { price: "14.00", currency: "CAD" });
    assert.equal(planProductPricePatch("MooncatShopify", raw, { price: "14.00", currency: "CAD" }, "CAD"), null);
    assert.equal(
      planProductPricePatch("MooncatShopify", raw, { price: "14.00", currency: "CAD" }, null),
      null,
      "an unknown store currency keeps the stored one"
    );
    assert.deepEqual(planProductPricePatch("MooncatShopify", raw, { price: "12.00", currency: "CAD" }, null), {
      price: "14.00",
      currency: "CAD",
    });
    assert.deepEqual(planProductPricePatch("MakeupAPI", { price: "10.0", currency: "CAD" }, { price: "10.0", currency: "CAD" }, null), {
      price: "10.00",
      currency: "CAD",
    });
    assert.equal(planProductPricePatch("OpenBeautyFacts", { code: "1" }, {}, null), null);
  });

  function fakeDb(products, sources) {
    const writes = [];
    const sourceQueries = [];
    const query = async (sql, params) => {
      if (sql.includes("FROM data_source ds\n     WHERE ds.name")) {
        sourceQueries.push(params[0]);
        return { rows: sources[params[0]] ? [sources[params[0]]] : [] };
      }
      if (sql.startsWith("UPDATE external_product")) {
        writes.push({ ids: params[0], patches: params[1].map((p) => JSON.parse(p)) });
        return { rows: [] };
      }
      const [cursor, , limit] = params;
      return { rows: products.filter((p) => Number(p.externalProductId) > Number(cursor)).slice(0, limit) };
    };
    return { query, writes, sourceQueries };
  }

  const products = [
    { externalProductId: "1", sourceName: "MooncatShopify", rawJson: fixture.products[0], normalizedJson: {} },
    { externalProductId: "2", sourceName: "MooncatShopify", rawJson: fixture.products[1], normalizedJson: { price: "9.00", currency: "CAD" } },
    { externalProductId: "3", sourceName: "MakeupAPI", rawJson: { price: "6.0", currency: null }, normalizedJson: { price: "6.0" } },
    { externalProductId: "4", sourceName: "OpenBeautyFacts", rawJson: { code: "9" }, normalizedJson: {} },
    { externalProductId: "5", sourceName: "LightsLacquerShopify", rawJson: fixture.products[0], normalizedJson: {} },
  ];
  const sources = {
    MooncatShopify: { name: "MooncatShopify", baseUrl: "https://mooncat.example", configuredCurrency: null, storedCurrency: "CAD" },
    LightsLacquerShopify: { name: "LightsLacquerShopify", baseUrl: "https://lights.example", configuredCurrency: null, storedCurrency: null },
  };

  it("dry run reports without writing, resolving each store currency once", async () => {
    const db = fakeDb(products, sources);
    const fetched = [];
    const summary = await runBackfill(parseBackfillArgs(["--batch-size", "2"]), {
      query: db.query,
      log: () => {},
      fetchCurrency: async (baseUrl) => {
        fetched.push(baseUrl);
        return "USD";
      },
    });
    assert.equal(summary.mode, "dry-run");
    assert.equal(summary.products.scanned, 5);
    assert.equal(summary.products.changed, 3, "rows 1, 3 and 5; row 2 already matches");
    assert.deepEqual(summary.products.bySource, { MooncatShopify: 1, MakeupAPI: 1, LightsLacquerShopify: 1 });
    assert.equal(summary.products.pricedWithCurrency, 3);
    assert.equal(summary.products.pricedWithoutCurrency, 1, "MakeupAPI row without a currency");
    assert.deepEqual(summary.currencies.MooncatShopify, { currency: "CAD", origin: "stored" });
    assert.deepEqual(summary.currencies.LightsLacquerShopify, { currency: "USD", origin: "shop_meta" });
    assert.deepEqual(fetched, ["https://lights.example"]);
    assert.deepEqual(db.sourceQueries.sort(), ["LightsLacquerShopify", "MooncatShopify"]);
    assert.equal(db.writes.length, 0);
  });

  it("--write merges the patches; --no-fetch-currency leaves unknown currencies null", async () => {
    const db = fakeDb(products, sources);
    const summary = await runBackfill(parseBackfillArgs(["--write", "--no-fetch-currency"]), {
      query: db.query,
      log: () => {},
      fetchCurrency: async () => {
        throw new Error("must not fetch");
      },
    });
    assert.equal(summary.products.written, 3);
    const patches = Object.fromEntries(db.writes.flatMap((w) => w.ids.map((id, i) => [id, w.patches[i]])));
    assert.deepEqual(patches, {
      1: { price: "14.00", currency: "CAD" },
      3: { price: "6.00", currency: null },
      5: { price: "14.00", currency: null },
    });
    assert.deepEqual(summary.currencies.LightsLacquerShopify, { currency: null, origin: "unknown" });
  });
});
