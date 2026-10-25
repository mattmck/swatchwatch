const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { isPahlishPolish } = require("../dist/lib/connectors/store-filters/pahlish");
const { isCirqueColorsPolish } = require("../dist/lib/connectors/store-filters/cirque-colors");
const { isStellaChromaPolish } = require("../dist/lib/connectors/store-filters/stella-chroma");
const { isLemmingLacquerPolish } = require("../dist/lib/connectors/store-filters/lemming-lacquer");
const { isSweetAndSourPolish } = require("../dist/lib/connectors/store-filters/sweet-and-sour");
const {
  SHOPIFY_STORE_PRODUCT_FILTERS,
  shopifyStoreProductVerdict,
} = require("../dist/lib/connectors/store-filters");
const { ShopifyGenericConnector, isBundle } = require("../dist/lib/connectors/shopify-generic");
const { classifyIngestedProduct } = require("../dist/lib/product-category");

// pahlish.com/products.json, fetched 2026-10-18 (all 36 products, one page), trimmed.
const PAHLISH = require("./fixtures/pahlish-products.json").products;
// cirquecolors.com/products.json, fetched 2026-10-19 (all 415 products, two pages), trimmed.
const CIRQUE = require("./fixtures/cirque-colors-products.json").products;
// stellachroma.com, lemminglacquer.com and sweetandsourlacquer.com /products.json, fetched
// 2026-10-22 (81, 30 and 169 products, one page each), trimmed (#273 batch 3).
const STELLA = require("./fixtures/stella-chroma-products.json").products;
const LEMMING = require("./fixtures/lemming-lacquer-products.json").products;
const SWEET = require("./fixtures/sweet-and-sour-products.json").products;

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

function cirque(title) {
  const product = CIRQUE.find((entry) => entry.title === title);
  assert.ok(product, `Cirque fixture has no product titled ${title}`);
  return product;
}

describe("store-filters/cirque-colors — isCirqueColorsPolish", () => {
  it("keeps 328 of the 415 fixture products", () => {
    assert.equal(CIRQUE.length, 415);
    assert.equal(CIRQUE.filter(isCirqueColorsPolish).length, 328);
  });

  it("keeps single shades whose product_type is a finish or line", () => {
    for (const title of ["Coffee Talk", "Puddle", "Phantom Glow", "Red Hook", "Hint Tint: Blush", "We Trippy"]) {
      assert.equal(isCirqueColorsPolish(cirque(title)), true, title);
    }
  });

  it("keeps a shade with an empty product_type when a tag names its finish", () => {
    assert.equal(isCirqueColorsPolish(cirque("Red Hot Jelly")), true);
  });

  it("keeps coats, strengtheners and cuticle oils (the June tag blocklist would drop them)", () => {
    for (const title of [
      "Looking Glass Top Coat",
      "Get Ready Base Coat",
      "Haze Glaze Matte Top Coat",
      "Recovery Ritual Nail Strengthener",
      "Nail & Cuticle Oil - Fig",
    ]) {
      assert.equal(isCirqueColorsPolish(cirque(title)), true, title);
    }
  });

  it("drops sets, duos, trios, bundles and collection sets, whatever their product_type", () => {
    for (const title of [
      "Chocolatte Set",
      "Delusion Collection Set",
      "Fatal Attraction Duo",
      "Dark Matter Trio",
      "Best Sellers Bundle",
      "Go-To Mani Quad - Fig",
      "Hocus Pocus Duo",
      "Fig Nail Art Set",
    ]) {
      assert.equal(isCirqueColorsPolish(cirque(title)), false, title);
    }
  });

  it("drops tools, charms, stickers, remover, wipes, the gift card and free gifts", () => {
    for (const title of [
      "Fatal Attraction Magnetic Wand",
      "Gold Coquille Charms",
      "Romance Me Ready-to-Wear Nail Art Stickers",
      "Au Revoir Nail Polish Remover",
      "Clean Sweep Lint Free Wipes",
      "Shape Up Emery Nail Files",
      "Cirque Colors Gift Card",
      "🎁 Superfreak (100% off)",
    ]) {
      assert.equal(isCirqueColorsPolish(cirque(title)), false, title);
    }
  });

  it("drops the creator profile pages (empty product_type, no finish tag)", () => {
    for (const title of ["Elizabeth", "Tyler", "Polish with Rae"]) {
      assert.equal(isCirqueColorsPolish(cirque(title)), false, title);
    }
  });

  it("does not drop a shade whose name only contains a filter word inside another word", () => {
    assert.equal(isCirqueColorsPolish({ title: "Sunset Park", product_type: "Retired Colors", tags: [] }), true);
    assert.equal(isCirqueColorsPolish({ title: "Profiled", product_type: "Jelly", tags: "Jelly, Reds" }), true);
  });
});

/** The connector's gate for one product of `source`: the store verdict, else the generic gate. */
function connectorKeeps(source, product) {
  const tags = Array.isArray(product.tags) ? product.tags : [];
  const verdict = shopifyStoreProductVerdict(source, product);
  const isPolish =
    verdict ?? classifyIngestedProduct({ title: product.title, productType: product.product_type || null, tags }).accept;
  return isPolish && !isBundle(tags);
}

function fixtureProduct(products, title) {
  const product = products.find((entry) => entry.title === title);
  assert.ok(product, `fixture has no product titled ${title}`);
  return product;
}

describe("store-filters/stella-chroma — isStellaChromaPolish (#273 batch 3)", () => {
  it("with the generic gate keeps 68 of the 81 fixture products", () => {
    assert.equal(STELLA.length, 81);
    assert.equal(STELLA.filter((product) => connectorKeeps("StellaChromaShopify", product)).length, 68);
  });

  it("drops the collection sets, the coat duo, the mystery grab bag and the subscription", () => {
    for (const title of [
      "Romeo + Juliet Complete set",
      "Starring Chicago Complete set",
      "Base Coat and Top Coat Duo",
      "Mysteries!",
      "Monthly Mystery Subscription",
    ]) {
      assert.equal(isStellaChromaPolish(fixtureProduct(STELLA, title)), false, title);
    }
  });

  it("keeps the cuticle oil the June tag blocklist would drop (tagged brush pen)", () => {
    const oil = fixtureProduct(STELLA, "Nourishing Cuticle Oil");
    assert.equal(isStellaChromaPolish(oil), true);
    assert.equal(connectorKeeps("StellaChromaShopify", oil), true);
  });

  it("defers single shades, coats, merch and services to the generic gate", () => {
    for (const title of ["Fluorite", "Supernova", "So Base-ic Garlic Base Coat", "STELLA CHROMA T-Shirt", "Magnets", "Gift Card", "Rush Processing"]) {
      assert.equal(isStellaChromaPolish(fixtureProduct(STELLA, title)), null, title);
    }
    for (const title of ["Fluorite", "Supernova", "So Base-ic Garlic Base Coat", "Dark Matte-r Matte Top Coat"]) {
      assert.equal(connectorKeeps("StellaChromaShopify", fixtureProduct(STELLA, title)), true, title);
    }
    for (const title of ["STELLA CHROMA T-Shirt", "Magnets", "Gift Card", "Rush Processing", "Shipping Protection"]) {
      assert.equal(connectorKeeps("StellaChromaShopify", fixtureProduct(STELLA, title)), false, title);
    }
  });

  it("does not drop a shade whose name only contains a filter word inside another word", () => {
    assert.equal(isStellaChromaPolish({ title: "Sunset Settlement", product_type: "Nail Polish", tags: [] }), null);
    assert.equal(isStellaChromaPolish({ title: "Duotone", product_type: "Nail Polish", tags: [] }), null);
  });
});

describe("store-filters/lemming-lacquer — isLemmingLacquerPolish (#273 batch 3)", () => {
  it("with the generic gate keeps 24 of the 30 fixture products", () => {
    assert.equal(LEMMING.length, 30);
    assert.equal(LEMMING.filter((product) => connectorKeeps("LemmingLacquerShopify", product)).length, 24);
  });

  it("keeps a shade whose product_type is its finish", () => {
    assert.equal(isLemmingLacquerPolish(fixtureProduct(LEMMING, "You Have No Power Over Me")), true);
    assert.equal(isLemmingLacquerPolish({ title: "Glass Slipper", product_type: "Flakes", tags: [] }), true);
  });

  it("drops the Polish Pickup mystery grab bag, whatever its product_type", () => {
    assert.equal(isLemmingLacquerPolish(fixtureProduct(LEMMING, "Polish Pickup Mysteries")), false);
  });

  it("defers Nail Polishes, collections, the gift card and the magnet to the generic gate", () => {
    for (const title of ["Howl", "The Scream Collection", "Lemming Lacquer Gift Card", "Neodymium Bar Magnet"]) {
      assert.equal(isLemmingLacquerPolish(fixtureProduct(LEMMING, title)), null, title);
    }
    assert.equal(connectorKeeps("LemmingLacquerShopify", fixtureProduct(LEMMING, "Howl")), true);
    for (const title of ["The Scream Collection", "The Clue Collection", "Lemming Lacquer Gift Card", "Neodymium Bar Magnet"]) {
      assert.equal(connectorKeeps("LemmingLacquerShopify", fixtureProduct(LEMMING, title)), false, title);
    }
  });
});

describe("store-filters/sweet-and-sour — isSweetAndSourPolish (#273 batch 3)", () => {
  it("keeps 155 of the 169 fixture products (the generic gate keeps 8)", () => {
    assert.equal(SWEET.length, 169);
    assert.equal(SWEET.filter(isSweetAndSourPolish).length, 155);
    assert.equal(SWEET.filter((product) => connectorKeeps("SweetAndSourLacquerShopify", product)).length, 155);
    assert.equal(SWEET.filter((product) => connectorKeeps("NotARealShopify", product)).length, 8);
  });

  it("keeps shades described by base, finish, opacity or the collection blurb", () => {
    for (const title of [
      "Leaves Are Turning", // "deep olive green with red/copper shimmer"
      "Kiss of Death", // "Base : clear Glitter : … Opacity : glitter topper"
      "Gotta Run!", // "mustard yellow creme Opacity: 2-3 coats"
      "Black Velvet", // "the perfect black polish"
      "Hey-Diddly-Ho!", // "Each polish is named after …"
      "A Pleasure for the Tips", // one shade of a trio, sold singly
    ]) {
      assert.equal(isSweetAndSourPolish(fixtureProduct(SWEET, title)), true, title);
    }
  });

  it("keeps shades listed with no description beyond the screen-colour disclaimer", () => {
    for (const title of ["Budget Babe", "My Wallet is Crying", "Sale? Say Less"]) {
      assert.equal(isSweetAndSourPolish(fixtureProduct(SWEET, title)), true, title);
    }
    assert.equal(isSweetAndSourPolish({ title: "Untitled", product_type: "", tags: [], body_html: "" }), true);
  });

  it("drops a listing whose only text says something else (a restock note)", () => {
    assert.equal(isSweetAndSourPolish(fixtureProduct(SWEET, "Supercluster")), false);
  });

  it("keeps base and top coats but not their refills", () => {
    for (const title of [
      "Smicky Sauce | 2-in-1 Base Coat",
      "Smoothing Sauce | Ridge-Filling Base Coat",
      "Sticky Sauce | Sticky Base Coat",
      "Gloss Sauce | Quick Dry Top Coat",
      "Blur Sauce Tinted Base Coat",
    ]) {
      assert.equal(isSweetAndSourPolish(fixtureProduct(SWEET, title)), true, title);
    }
    for (const title of [
      "Sticky Sauce Refill - 2oz",
      "Smicky Sauce Refill - 2oz | 2-in-1 Base Coat",
      "Gloss Sauce Refill - 4oz | Quick Dry Top Coat",
      "Gloss Sauce Refill - 2oz | Quick Dry Top Coat",
    ]) {
      assert.equal(isSweetAndSourPolish(fixtureProduct(SWEET, title)), false, title);
    }
  });

  it("drops multi-shade listings, the mystery overpour, merch, tools and the gift card", () => {
    for (const title of [
      "Birthday Trio",
      "Black Velvet and White Silk Duo",
      "Mystery Overpour",
      "Soda Can Tab Opener",
      "Coozies",
      "Neodymium Bar Magnet",
      "Holographic Sticker",
      "Sweet & Sour Lacquer Gift Card",
      "Saucy Marbles",
    ]) {
      assert.equal(isSweetAndSourPolish(fixtureProduct(SWEET, title)), false, title);
    }
  });

  it("drops merch even when its description borrows polish words", () => {
    assert.equal(
      isSweetAndSourPolish({ title: "Squad Tote Bag", product_type: "", tags: [], body_html: "holographic shimmer print" }),
      false
    );
    assert.equal(
      isSweetAndSourPolish({ title: "Can Cooler", product_type: "", tags: [], body_html: "12oz can cooler with straw. Handwash only." }),
      false
    );
  });

  it("does not drop a shade whose name only contains a filter word inside another word", () => {
    assert.equal(isSweetAndSourPolish({ title: "Sunset", product_type: "", tags: [], body_html: "coral creme" }), true);
    assert.equal(isSweetAndSourPolish({ title: "Marble Cake", product_type: "", tags: [], body_html: "white crelly with pink flakes" }), true);
    assert.equal(isSweetAndSourPolish({ title: "Setting Sun", product_type: "", tags: [], body_html: "orange jelly" }), true);
  });
});

describe("store-filters — shopifyStoreProductVerdict", () => {
  it("registers filters for Pahlish, Cirque Colors, Stella Chroma, Lemming Lacquer and Sweet & Sour only", () => {
    assert.deepEqual(Object.keys(SHOPIFY_STORE_PRODUCT_FILTERS).sort(), [
      "CirqueColorsShopify",
      "LemmingLacquerShopify",
      "PahlishShopify",
      "StellaChromaShopify",
      "SweetAndSourLacquerShopify",
    ]);
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

  it("CirqueColorsShopify keeps coats with their rule category, not the tag-blocklist accessory", async () => {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => null },
      text: async () =>
        JSON.stringify({
          products: ["Looking Glass Top Coat", "Get Ready Base Coat", "Organza", "Puddle", "Chocolatte Set"].map(cirque),
        }),
    });
    const result = await new ShopifyGenericConnector("CirqueColorsShopify").pullProducts(pull);
    // Cirque tags every coat "Top & Base Coat"; the title decides which coat it is.
    assert.deepEqual(
      result.records.map((record) => [record.normalized.name, record.normalized.productCategory]).sort(),
      [
        ["Get Ready Base Coat", "base_coat"],
        ["Looking Glass Top Coat", "top_coat"],
        ["Organza", "color"],
        ["Puddle", "color"],
      ]
    );
  });

  it("PahlishShopify ingests the 28 polishes from the fixture", async () => {
    const result = await new ShopifyGenericConnector("PahlishShopify").pullProducts(pull);
    const names = result.records.map((record) => record.normalized.name);
    assert.deepEqual(names.sort(), [...PAHLISH_POLISHES].sort());
    assert.equal(result.metadata.fetchedProductCount, 36);
    assert.ok(result.records.every((record) => record.normalized.brand === "Pahlish"));
  });

  it("the same products through a source without a store filter still get the generic filter (no color polish passes)", async () => {
    const result = await new ShopifyGenericConnector("NightOwlLacquerShopify").pullProducts(pull);
    // No fixture product has a polish signal, so no color polish gets through. Its two coats are
    // ingested with their category (D-E, #349): coats do not need a polish word.
    assert.deepEqual(
      result.records.map((record) => [record.normalized.name, record.normalized.productCategory]).sort(),
      [
        ["Beauty and the Base Smoothing Base Coat", "base_coat"],
        ["Magic Mirror Quick Dry Topcoat", "top_coat"],
      ]
    );
  });
});
