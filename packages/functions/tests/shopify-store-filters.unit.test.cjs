const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { isPahlishPolish } = require("../dist/lib/connectors/store-filters/pahlish");
const {
  SHOPIFY_STORE_PRODUCT_FILTERS,
  shopifyStoreProductVerdict,
} = require("../dist/lib/connectors/store-filters");
const { ShopifyGenericConnector } = require("../dist/lib/connectors/shopify-generic");

// pahlish.com/products.json, fetched 2026-10-18 (all 36 products, one page), trimmed.
const PAHLISH = require("./fixtures/pahlish-products.json").products;

// The 28 single-shade listings in the fixture; everything else is a set, a mystery
// listing, a base/top coat, empty boxes or a gift card.
const PAHLISH_POLISHES = [
  "Withered Bloom",
  "Memento Mori",
  "Dust and Shadow",
  "Danse Macabre",
  "Catacombs",
  "Blood Moon",
  "Vanitas Rouge",
  "Ballad of Lemons",
  "Nosferatu",
  "Godzilla",
  "Vampirella",
  "Hey Boo",
  "Poison Thorny Flowers",
  "Merlin",
  "Arthur",
  "Lancelot",
  "Morgan le Fay",
  "Excalibur",
  "Lady of the Lake",
  "Guinevere",
  "Red Wine Supernova",
  "Glittoris 2026",
  "Howl's Moving Castle",
  "Honey",
  "Father Figure",
  "Y2K",
  "Pink Pony Club",
  "Fancy",
];

const PAHLISH_REJECTED = [
  "Halloween Mysteries Round 2!",
  "Halloween Mysteries 2026",
  "Enjoy the Silence Collection",
  "Camelot Collection",
  "Beauty and the Base Smoothing Base Coat",
  "Magic Mirror Quick Dry Topcoat",
  "Empty Boxes",
  "Gift Cards",
];

function byTitle(title) {
  const product = PAHLISH.find((entry) => entry.title === title);
  assert.ok(product, `fixture has no product titled ${title}`);
  return product;
}

describe("store-filters/pahlish — isPahlishPolish", () => {
  it("fixture covers every product exactly once", () => {
    assert.equal(PAHLISH.length, 36);
    assert.equal(PAHLISH_POLISHES.length + PAHLISH_REJECTED.length, 36);
  });

  it("accepts the 28 single-shade polish listings", () => {
    const accepted = PAHLISH.filter(isPahlishPolish).map((product) => product.title);
    assert.deepEqual(accepted.sort(), [...PAHLISH_POLISHES].sort());
  });

  for (const title of PAHLISH_REJECTED) {
    it(`rejects ${title}`, () => {
      assert.equal(isPahlishPolish(byTitle(title)), false);
    });
  }

  it("rejects a gift card by product_type even under another title", () => {
    assert.equal(
      isPahlishPolish({ title: "Holiday eGift", product_type: "Gift Card", tags: [], body_html: "glitter shimmer" }),
      false
    );
  });

  it("rejects tools and merch that carry no polish description", () => {
    for (const title of ["Glass Nail File", "Pahlish Logo T-Shirt", "Sticker Sheet", "Enamel Pin"]) {
      assert.equal(
        isPahlishPolish({ title, product_type: "", tags: [], body_html: "Show your love for Pahlish! One size." }),
        false,
        title
      );
    }
  });

  it("rejects merch even when its description borrows polish words", () => {
    assert.equal(
      isPahlishPolish({ title: "Holo Tote Bag", product_type: "", tags: [], body_html: "holographic shimmer print tote" }),
      false
    );
  });

  it("does not reject shades whose names contain a merch or tool word", () => {
    for (const title of ["Pin Up", "Pandora's Box", "Tee Time", "Sunset Boulevard", "Filed Away"]) {
      assert.equal(
        isPahlishPolish({ title, product_type: "", tags: [], body_html: "coral creme with gold shimmer" }),
        true,
        title
      );
    }
  });

  it("rejects a listing with no description at all", () => {
    assert.equal(isPahlishPolish({ title: "Mystery Shade", product_type: "", tags: [], body_html: "" }), false);
    assert.equal(isPahlishPolish({ title: "Untitled", product_type: "", tags: [] }), false);
  });

  it("accepts a shade whose description names a finish, case-insensitively", () => {
    assert.equal(
      isPahlishPolish({ title: "Oil Slick", product_type: "", tags: "Halloween", body_html: "<p>Black JELLY with Holo flakes</p>" }),
      true
    );
  });
});

describe("store-filters — shopifyStoreProductVerdict", () => {
  it("registers a filter for PahlishShopify only", () => {
    assert.deepEqual(Object.keys(SHOPIFY_STORE_PRODUCT_FILTERS), ["PahlishShopify"]);
  });

  it("returns the store filter's verdict for a source that has one", () => {
    assert.equal(shopifyStoreProductVerdict("PahlishShopify", byTitle("Merlin")), true);
    assert.equal(shopifyStoreProductVerdict("PahlishShopify", byTitle("Gift Cards")), false);
  });

  it("returns null (use the generic filter) for a source without one", () => {
    assert.equal(shopifyStoreProductVerdict("NightOwlLacquerShopify", byTitle("Merlin")), null);
    assert.equal(shopifyStoreProductVerdict("NotARealShopify", byTitle("Merlin")), null);
  });
});

describe("ShopifyGenericConnector applies the store pre-filter", () => {
  let originalFetch;
  let originalEndpoint;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
    delete process.env.AZURE_OPENAI_ENDPOINT; // keep color-name detection offline
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => null },
      text: async () => JSON.stringify({ products: PAHLISH }),
    });
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalEndpoint !== undefined) process.env.AZURE_OPENAI_ENDPOINT = originalEndpoint;
  });

  const pull = { searchTerm: "", page: 1, pageSize: 100, maxRecords: 100 };

  it("PahlishShopify ingests the 28 polishes from the fixture", async () => {
    const result = await new ShopifyGenericConnector("PahlishShopify").pullProducts(pull);
    const names = result.records.map((record) => record.normalized.name);
    assert.deepEqual(names.sort(), [...PAHLISH_POLISHES].sort());
    assert.equal(result.metadata.fetchedProductCount, 36);
    assert.ok(result.records.every((record) => record.normalized.brand === "Pahlish"));
  });

  it("the same products through a source without a store filter still get the generic filter (0 pass)", async () => {
    const result = await new ShopifyGenericConnector("NightOwlLacquerShopify").pullProducts(pull);
    assert.equal(result.records.length, 0);
  });
});
