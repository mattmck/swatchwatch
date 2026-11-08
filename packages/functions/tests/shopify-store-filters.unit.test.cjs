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
const { ShopifyGenericConnector, isBundle, gateShopifyProduct } = require("../dist/lib/connectors/shopify-generic");
const { isHarlowAndCoPolish } = require("../dist/lib/connectors/store-filters/harlow-and-co");
const { isBeyondPolishPolish } = require("../dist/lib/connectors/store-filters/beyond-polish");
const { isHypnoticPolishPolish } = require("../dist/lib/connectors/store-filters/hypnotic-polish");
const { isLondontownPolish } = require("../dist/lib/connectors/store-filters/londontown");
const { isManucuristPolish } = require("../dist/lib/connectors/store-filters/manucurist");
const { isOliveAndJunePolish } = require("../dist/lib/connectors/store-filters/olive-and-june");
const { isPiggyPaintPolish } = require("../dist/lib/connectors/store-filters/piggy-paint");
const { isWetNWildPolish } = require("../dist/lib/connectors/store-filters/wet-n-wild");
const { isPenelopeLuzPolish } = require("../dist/lib/connectors/store-filters/penelope-luz");
const { isNoodlesPolish } = require("../dist/lib/connectors/store-filters/noodles");
const { isCndPolish } = require("../dist/lib/connectors/store-filters/cnd");
const { isBarryMPolish } = require("../dist/lib/connectors/store-filters/barry-m");
const { isPolishPickupPolish } = require("../dist/lib/connectors/store-filters/polish-pickup");
const { readSourceSettings } = require("../dist/lib/source-settings");
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
  it("registers filters for the retailers, the indie stores and the brand stores that need one, and no other source", () => {
    assert.deepEqual(Object.keys(SHOPIFY_STORE_PRODUCT_FILTERS).sort(), [
      "AlchemyLacquersShopify",
      "BarryMShopify",
      "BeyondPolishShopify",
      "CirqueColorsShopify",
      "CndShopify",
      "CoteShopify",
      "HarlowAndCoShopify",
      "HypnoticPolishShopify",
      "LemmingLacquerShopify",
      "LondontownShopify",
      "ManucuristShopify",
      "NoodlesNailPolishShopify",
      "OliveAndJuneShopify",
      "PahlishShopify",
      "PenelopeLuzShopify",
      "PiggyPaintShopify",
      "PolishPickupShopify",
      "StellaChromaShopify",
      "SweetAndSourLacquerShopify",
      "WetNWildShopify",
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

// harlowandco.org/products.json, fetched 2026-11-08 (1,537 products over 7 pages), trimmed to 102:
// the first 60 non-"Nail Polish" products, 40 polishes across the six polish vendors, and
// set-titled polishes (fixture _note). Harlow & Co is a multi-brand retailer (metadata.kind =
// "retailer"); its titles are bare shade names.
const HARLOW = require("./fixtures/harlow-and-co-products.json").products;

const HARLOW_ACCEPTED = [
  // ILNP
  "Save The Date", "Cherry", "Overcoat", "Building Blocks", "Overload", "Summer Stargazing",
  "Cream Pop", "Compass", "Black Orchid", "Woven", "Jet Setter", "Set Sail",
  // KBShimmer
  "Candy Cane Crush", "Shell We?", "Comet At Me Bro", "Give It A Whirl", "Grow With The Flow",
  "Race Against Slime", "Constellation Prize", "Ice and Easy",
  // Cirque
  "Enchanted", "Citron Jelly", "Socialite", "Trinket", "Showgirl", "Grape Jelly", "Pony Up",
  "Wishful Thinking", "Thunderbolt", "La Rougeanne",
  // Color Club
  "What's Your Sign?", "Blue Heaven", "Shattered", "Rock On", "Piece Out", "Angel Kiss",
  // Polished for Days
  "It's a Knife When...", "Truth or Dare", "Birds of a Feather", "Diva in Disguise",
  // Emily de Molly
  "Disarm", "The Romantics", "Places To Be", "Love Is The Law",
];

const harlow = (title) => {
  const product = HARLOW.find((p) => p.title === title);
  assert.ok(product, `Harlow fixture has no product titled ${title}`);
  return product;
};

describe("store-filters/harlow-and-co — isHarlowAndCoPolish", () => {
  it("defers every Nail Polish / Nail Polishes listing to the generic gate (null)", () => {
    for (const title of HARLOW_ACCEPTED) {
      assert.equal(isHarlowAndCoPolish(harlow(title)), null, title);
    }
  });

  it("drops the non-polish product types (stickers, scrubs, oils, magnets, lotion, stamping plates, apparel)", () => {
    const rejected = HARLOW.filter((p) => !/^Nail Polish(?:es)?$/.test(p.product_type));
    assert.equal(rejected.length, 58);
    for (const product of rejected) {
      assert.equal(isHarlowAndCoPolish(product), false, `${product.vendor} | ${product.title}`);
    }
    assert.equal(isHarlowAndCoPolish({ title: "Harlow Gift Card", product_type: "Gift Card", vendor: "Harlow & Co." }), false);
  });

  it("drops the non-polish vendors even under a polish product type", () => {
    for (const vendor of ["MILV", "Lina Nail Art Supplies", "Deco Beauty", "Walton Wood Farm", "Cutie Oils", "Simply Polished", "Harlow & Co."]) {
      assert.equal(isHarlowAndCoPolish({ title: "Mystery Item", product_type: "Nail Polish", vendor }), false, vendor);
    }
  });

  it("drops set, collection and bundle titles (the parser's set regex)", () => {
    for (const title of ["It's Fall Good Collection", "Cirque Holiday Duo", "Mini Trio", "Polish Bundle", "Mani Kit", "Winter Combo"]) {
      assert.equal(isHarlowAndCoPolish({ title, product_type: "Nail Polish", vendor: "Cirque" }), false, title);
    }
    // A set word counts only at the end of a segment, so the ILNP shade "Set Sail" stays.
    assert.equal(isHarlowAndCoPolish(harlow("Set Sail")), null);
  });

  it("does not drop a shade whose name only contains a set word inside another word", () => {
    assert.equal(isHarlowAndCoPolish({ title: "Settle Down", product_type: "Nail Polish", vendor: "ILNP" }), null);
    assert.equal(isHarlowAndCoPolish({ title: "Kitten Heels", product_type: "Nail Polish", vendor: "Cirque" }), null);
  });
});

describe("HarlowAndCoShopify retailer ingestion", () => {
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
      text: async () => JSON.stringify({ products: HARLOW }),
    });
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalEndpoint !== undefined) process.env.AZURE_OPENAI_ENDPOINT = originalEndpoint;
    else delete process.env.AZURE_OPENAI_ENDPOINT;
  });

  const settings = readSourceSettings({
    kind: "retailer",
    currency: "CAD",
    vendorAliases: { Cirque: "Cirque Colors", "piCture pOlish": "Picture Polish" },
  });

  it("accepts the 44 single-shade polishes from the fixture under their brands, and nothing else", async () => {
    const connector = new ShopifyGenericConnector("HarlowAndCoShopify", "https://www.harlowandco.org", {
      currency: "CAD",
      settings,
    });
    const result = await connector.pullProducts({ searchTerm: "", page: 1, pageSize: 200, maxRecords: 200 });
    assert.equal(result.metadata.fetchedProductCount, 102);
    assert.equal(result.records.length, 44);
    assert.deepEqual(result.records.map((r) => r.normalized.name).sort(), [...HARLOW_ACCEPTED].sort());
    const brands = new Set(result.records.map((r) => r.normalized.brand));
    assert.deepEqual([...brands].sort(), [
      "Cirque Colors",
      "Color Club",
      "Emily de Molly",
      "ILNP",
      "KBShimmer",
      "Polished for Days",
    ]);
    // The shared classifier reads two listings' descriptions as toppers; the rest are colors.
    assert.deepEqual(
      result.records.filter((r) => r.normalized.productCategory !== "color").map((r) => [r.normalized.name, r.normalized.productCategory]).sort(),
      [["Compass", "topper"], ["Ice and Easy", "topper"]]
    );
  });
});

// beyondpolish.com/products.json, fetched 2026-11-08 (17,508 products over 71 pages), trimmed to 247:
// 8 lacquer-typed products per lacquer vendor, every product_type at least twice, 12 "Gel &
// Lacquer Polish" combos, 12 "Gel Polish", Nail Set-tagged lacquers and Hair/Body products
// (fixture _note). Beyond Polish is a multi-brand retailer (metadata.kind = "retailer").
const BEYOND = require("./fixtures/beyond-polish-pull-products.json").products;
const BEYOND_LACQUER_TYPES = ["Nail Lacquer", "Lacquer & Dip", "Gel, Lacquer & Dip"];
const BEYOND_NO_GEL = { includeGel: false };
const BEYOND_GEL = { includeGel: true };

// Accepted lacquer-typed products per vendor in the fixture (the whole-store numbers are in the
// README). Each vendor has 8 single-shade lacquers; the extra Nail Set / combo listings of OPI,
// Orly, CND and Londontown in the fixture are rejected.
const BEYOND_ACCEPTED_BY_VENDOR = {
  OPI: 8, Zoya: 8, ORLY: 8, "Cirque Colors": 8, KBShimmer: 8, "Morgan Taylor": 8, CND: 8,
  "Ella+Mila": 8, Londontown: 8, Essie: 8, "China Glaze": 8, "Color Club": 8, "butter LONDON": 8,
  "Loud Lacquer": 8, "Sunday Studio": 8, "Cracked Polish": 8, Lippmann: 8, "Deborah Lippmann": 7,
  "Static Nails": 8, Peacci: 8,
};

const beyond = (title) => {
  const product = BEYOND.find((p) => p.title === title);
  assert.ok(product, `Beyond Polish fixture has no product titled ${title}`);
  return product;
};
const beyondListing = (title, product_type, extra = {}) => ({ title, product_type, vendor: "OPI", tags: [], ...extra });

describe("store-filters/beyond-polish — isBeyondPolishPolish", () => {
  it("accepts the lacquer lines named in the plan", () => {
    for (const [title, productType, vendor] of [
      ["OPI Nail Lacquer - No Room for the Blues 0.5 oz - #NLB83", "Nail Lacquer", "OPI"],
      ["Zoya - Fairleigh .5 oz. - #ZP1210", "Nail Lacquer", "Zoya"],
      ["Orly Nail Lacquer - Velvet Dreams - #2000478", "Nail Lacquer", "ORLY"],
      ["Londontown - Lakur Enhanced Colour - Dream State 0.4 oz", "Nail Lacquer", "Londontown"],
    ]) {
      assert.equal(isBeyondPolishPolish({ title, product_type: productType, vendor, tags: [] }, BEYOND_NO_GEL), true, title);
    }
    for (const type of BEYOND_LACQUER_TYPES) {
      assert.equal(isBeyondPolishPolish(beyondListing("OPI - Alpine Snow", type), BEYOND_NO_GEL), true, type);
    }
  });

  it("accepts the per-vendor counts of the fixture's lacquer-typed products", () => {
    const accepted = {};
    for (const product of BEYOND) {
      if (isBeyondPolishPolish(product, BEYOND_NO_GEL)) accepted[product.vendor] = (accepted[product.vendor] ?? 0) + 1;
    }
    assert.deepEqual(accepted, BEYOND_ACCEPTED_BY_VENDOR);
    assert.equal(BEYOND.filter((p) => isBeyondPolishPolish(p, BEYOND_NO_GEL)).length, 159);
  });

  it("accepts a lacquer-typed product only under a lacquer product type", () => {
    // Every accepted fixture product has a lacquer type; every other type is rejected, whatever
    // the title says.
    for (const product of BEYOND) {
      if (isBeyondPolishPolish(product, BEYOND_GEL)) {
        assert.ok(
          [...BEYOND_LACQUER_TYPES, "Gel Polish"].includes(product.product_type),
          `${product.vendor} | ${product.title} | ${product.product_type}`
        );
      }
    }
    assert.equal(isBeyondPolishPolish(beyondListing("OPI - Alpine Snow", "Hair"), BEYOND_GEL), false);
    assert.equal(isBeyondPolishPolish(beyondListing("OPI - Alpine Snow", ""), BEYOND_GEL), false);
    assert.equal(isBeyondPolishPolish(beyondListing("OPI - Alpine Snow", undefined), BEYOND_GEL), false);
  });

  it("rejects every Gel & Lacquer Polish product (all are combos), with or without includeGel", () => {
    const combos = BEYOND.filter((p) => p.product_type === "Gel & Lacquer Polish");
    assert.equal(combos.length, 12);
    for (const product of combos) {
      assert.equal(isBeyondPolishPolish(product, BEYOND_NO_GEL), false, product.title);
      assert.equal(isBeyondPolishPolish(product, BEYOND_GEL), false, product.title);
    }
  });

  it("rejects the combo and set titles of the plan", () => {
    for (const title of [
      "OPI - Gel & Lacquer Combo - Metallic Rewind",
      "OPI - Nail Lacquer Combo - Base, Top & Machu Peach-u 0.5 oz - #NLP36",
      "Zoya - Sonnet Fall Collection",
      "Lacquer Set - Ella+Mila Pretty In Pink",
    ]) {
      assert.equal(isBeyondPolishPolish(beyondListing(title, "Nail Lacquer"), BEYOND_GEL), false, title);
    }
  });

  it("rejects the set tags (Nail Set, TIER COMBO, Custom Bundle, Kit, Mystery Box) in any case, even under a lacquer type", () => {
    for (const tag of ["Nail Set", "TIER COMBO", "Custom Bundle", "Kit", "Mystery Box", "nail set", "kit", "tier combo"]) {
      assert.equal(isBeyondPolishPolish(beyondListing("OPI - Alpine Snow", "Nail Lacquer", { tags: ["Nail Polish", tag] }), BEYOND_NO_GEL), false, tag);
    }
    // Tags as Shopify's comma string, too.
    assert.equal(isBeyondPolishPolish(beyondListing("OPI - Alpine Snow", "Nail Lacquer", { tags: "OPI, Nail Set" }), BEYOND_NO_GEL), false);
    assert.equal(isBeyondPolishPolish(beyondListing("OPI - Alpine Snow", "Nail Lacquer", { tags: "OPI, Nail Polish" }), BEYOND_NO_GEL), true);
    const tagged = BEYOND.filter(
      (p) => BEYOND_LACQUER_TYPES.includes(p.product_type) && p.tags.some((t) => /^(?:nail set|tier combo|custom bundle|kit)$/i.test(t))
    );
    assert.ok(tagged.length >= 5);
    for (const product of tagged) assert.equal(isBeyondPolishPolish(product, BEYOND_GEL), false, product.title);
  });

  it("drops hair, body, jewellery and every other non-polish type", () => {
    const rejected = BEYOND.filter((p) => !BEYOND_LACQUER_TYPES.includes(p.product_type) && p.product_type !== "Gel Polish");
    assert.ok(rejected.length >= 60);
    for (const product of rejected) {
      assert.equal(isBeyondPolishPolish(product, BEYOND_GEL), false, `${product.vendor} | ${product.title} | ${product.product_type}`);
    }
  });

  it("accepts Gel Polish only with includeGel", () => {
    const gel = beyond("OPI GelColor - Black Cherry Chutney 0.5 oz - #GCI43");
    assert.equal(isBeyondPolishPolish(gel, BEYOND_NO_GEL), false);
    assert.equal(isBeyondPolishPolish(gel, BEYOND_GEL), true);
    const gelProducts = BEYOND.filter((p) => p.product_type === "Gel Polish");
    assert.equal(gelProducts.length, 12);
    assert.equal(gelProducts.filter((p) => isBeyondPolishPolish(p, BEYOND_NO_GEL)).length, 0);
    // The gel combos and sets stay out even with includeGel.
    assert.equal(gelProducts.filter((p) => isBeyondPolishPolish(p, BEYOND_GEL)).length, 5);
  });

  it("drops the store's own merchandise: a vendor named Beyond Polish is never a brand", () => {
    for (const vendor of ["Beyond Polish", "beyond polish", " BEYOND POLISH "]) {
      assert.equal(isBeyondPolishPolish(beyondListing("Beyond Polish Mystery Lacquer - Surprise", "Nail Lacquer", { vendor }), BEYOND_GEL), false, vendor);
    }
  });

  it("defaults to includeGel false when the registry passes no settings", () => {
    const gel = beyond("OPI GelColor - Black Cherry Chutney 0.5 oz - #GCI43");
    assert.equal(shopifyStoreProductVerdict("BeyondPolishShopify", gel), false);
    assert.equal(shopifyStoreProductVerdict("BeyondPolishShopify", gel, readSourceSettings({ kind: "retailer", includeGel: true })), true);
    assert.equal(shopifyStoreProductVerdict("BeyondPolishShopify", gel, readSourceSettings({ kind: "retailer" })), false);
  });
});

// hypnoticpolish.com/products.json, fetched 2026-11-08 (998 products over 4 pages), trimmed to 101
// (fixture _note). Hypnotic Polish is a multi-brand EU retailer (metadata.kind = "retailer"),
// registered disabled until the store's written OK.
const HYPNOTIC = require("./fixtures/hypnotic-polish-products.json").products;
const hypnotic = (title) => {
  const product = HYPNOTIC.find((p) => p.title === title);
  assert.ok(product, `Hypnotic Polish fixture has no product titled ${title}`);
  return product;
};
const hypnoticListing = (title, product_type, extra = {}) => ({ title, product_type, vendor: "ILNP", tags: [], ...extra });

describe("store-filters/hypnotic-polish — isHypnoticPolishPolish", () => {
  it("accepts polishes, including a *PRE-ORDER* listing", () => {
    for (const title of ["ILNP - Turquoise Water", "*PRE-ORDER* ILNP - Molten", "Cosmic Polish - Star Garnet (Magnetic)"]) {
      assert.strictEqual(isHypnoticPolishPolish(hypnoticListing(title, "Nail Polish")), null, title);
    }
    assert.equal(isHypnoticPolishPolish(hypnotic("*PRE-ORDER* ILNP - Molten")), null);
  });

  it("defers coats, toppers and treatments to the generic gate (null)", () => {
    for (const type of ["Top Coat", "Base Coat", "Topper", "Treatment", "Nail Polish"]) {
      assert.equal(isHypnoticPolishPolish(hypnoticListing("ILNP - Glass Candy", type)), null, type);
    }
  });

  it("rejects cuticle treatments and accessories, in any case", () => {
    for (const type of ["Cuticle Treatment", "Accessories", "cuticle treatment", " ACCESSORIES "]) {
      assert.equal(isHypnoticPolishPolish(hypnoticListing("KBShimmer - Barely There Matte Cuticle Cream", type)), false, type);
    }
    const rejected = HYPNOTIC.filter((p) => ["Cuticle Treatment", "Accessories"].includes(p.product_type));
    assert.equal(rejected.length, 12);
    for (const product of rejected) assert.equal(isHypnoticPolishPolish(product), false, product.title);
  });

  it("rejects grab bag and mystery titles, in any case, even under Nail Polish", () => {
    for (const title of [
      "ILNP - Grab Bag",
      "KBShimmer - GRAB BAG of 5",
      "Cirque Colors - Mystery Box",
      "Starrily - mystery polish",
    ]) {
      assert.equal(isHypnoticPolishPolish(hypnoticListing(title, "Nail Polish")), false, title);
    }
  });

  it("is registered for HypnoticPolishShopify", () => {
    assert.equal(shopifyStoreProductVerdict("HypnoticPolishShopify", hypnotic("*PRE-ORDER* ILNP - Molten")), null);
    assert.equal(
      shopifyStoreProductVerdict("HypnoticPolishShopify", hypnoticListing("KBShimmer - Magnetic Wand", "Accessories")),
      false
    );
  });
});

describe("HypnoticPolishShopify — connector over the fixture", () => {
  const SETTINGS_METADATA = {
    kind: "retailer",
    currency: "EUR",
    vendorAliases: { "Cuticula Nail Lacquer": "Cuticula" },
  };
  const pull = async () => {
    const settings = readSourceSettings(SETTINGS_METADATA, "HypnoticPolishShopify");
    return new ShopifyGenericConnector("HypnoticPolishShopify", "https://www.hypnoticpolish.com", {
      currency: "EUR",
      settings,
    }).pullProducts({
      searchTerm: "",
      page: 1,
      pageSize: 1000,
      maxRecords: 1000,
      catalogCache: { load: async () => HYPNOTIC, save: async () => {} },
    });
  };

  it("accepts 88 records (63 colors, 6 toppers, 19 coats), drops the 12 accessories and cuticle treatments and the Cadillacquer trio set", async () => {
    const result = await pull();
    assert.equal(result.metadata.fetchedProductCount, 101);
    assert.equal(result.records.length, 88);
    // "*PRE-ORDER* Cadillacquer - FB Trio - Spotted Glass Frog" ends a segment with a set word.
    assert.ok(!result.records.some((r) => /FB Trio/.test(r.normalized.listingTitle)));
    const categories = {};
    for (const r of result.records) categories[r.normalized.productCategory] = (categories[r.normalized.productCategory] ?? 0) + 1;
    assert.deepEqual(categories, { color: 63, base_coat: 11, top_coat: 8, topper: 6 });
  });

  it("reads brand and shade from a Brand - Shade title, with aliases and pipe markers handled", async () => {
    const records = (await pull()).records;
    const byName = (brand, name) => records.find((r) => r.normalized.brand === brand && r.normalized.name === name);
    const cosmic = byName("Cosmic Polish", "Star Garnet");
    assert.ok(cosmic, "Cosmic Polish - Star Garnet (Magnetic) -> Star Garnet");
    assert.equal(cosmic.normalized.listingTitle, "Cosmic Polish - Star Garnet (Magnetic)");
    assert.ok(byName("Cuticula", "Flames Of A Phoenix"), "*PRE-ORDER* prefix and vendor alias");
    // No alias: the vendor is the catalog brand (Bee's Knees Lacquer), and its full name is stripped.
    assert.ok(byName("Bee's Knees Lacquer", "The Pond Spirit"));
    const topCoat = byName("Starrily", "Eclipse");
    assert.equal(topCoat.normalized.productCategory, "top_coat");
    // product_type "Nail Polish" with both "|| Top Coat" and "|| Topper" tags: the tags decide,
    // and topper beats coat wording. (No fixture polish carries only the Top Coat tag.)
    const tagged = byName("KBShimmer", "In A Flurry");
    assert.ok(tagged, "KBShimmer - In A Flurry");
    assert.equal(tagged.normalized.productCategory, "topper");
    assert.ok(records.every((r) => !String(r.normalized.name).includes("PRE-ORDER")));
  });
});

// ---------------------------------------------------------------------------------------------
// Brand stores registered in Task 10 that need a store filter (brand sources plan, Task 11).
// Each fixture is the store's products.json first page fetched 2026-11-08, trimmed (fixture _note).

/** The fixture product with `title` (and `productType`, for stores that reuse a title across types). */
function storeProduct(products, title, productType) {
  const product = products.find(
    (entry) => entry.title === title && (productType === undefined || (entry.product_type || "").trim() === productType)
  );
  assert.ok(product, `fixture has no product titled ${title}${productType ? ` [${productType}]` : ""}`);
  return product;
}

/** The connector gate (store filter, then the generic gate and the set rule) over a whole fixture. */
function gateAccepts(products, source, metadata = {}) {
  const settings = readSourceSettings(metadata, source);
  return products.filter((product) => gateShopifyProduct(product, source, settings).accept);
}

/** Whether the connector gate accepts one product of `source`. */
function gateKeeps(source, product, metadata = {}) {
  return gateShopifyProduct(product, source, readSourceSettings(metadata, source)).accept;
}

// londontownusa.com/products.json, fetched 2026-11-08 (250 products on page 1), trimmed to 106.
const LONDONTOWN = require("./fixtures/londontown-products.json").products;

describe("store-filters/londontown — isLondontownPolish", () => {
  it("with the generic gate keeps 43 of the 106 fixture products (56 with includeGel)", () => {
    assert.equal(LONDONTOWN.length, 106);
    // Nail Color 24 (25 minus Pearl Mini), Nail Veils 5, Concealers 3, and the 11 Nail Care coats
    // and treatments.
    assert.equal(gateAccepts(LONDONTOWN, "LondontownShopify").length, 43);
    // + Gels 12 and the GelShift top coat.
    assert.equal(gateAccepts(LONDONTOWN, "LondontownShopify", { includeGel: true }).length, 56);
  });

  it("keeps Nail Color lacquers, including ones with no polish word in type or tags", () => {
    for (const title of ["Double Fudge", "Berry Punch", "Room Service", "Chasing Rainbows", "Milk Bath", "Truly Ruby"]) {
      const product = storeProduct(LONDONTOWN, title, "Nail Color");
      assert.equal(isLondontownPolish(product), true, title);
      assert.equal(gateKeeps("LondontownShopify", product), true, title);
    }
    assert.equal(isLondontownPolish(storeProduct(LONDONTOWN, "Perfecting Nail Veil #11")), true);
    assert.equal(isLondontownPolish(storeProduct(LONDONTOWN, "Bare Illuminating Nail Concealer")), true);
  });

  it("drops gels, sets, tools, lip and foot care, nail art and bundles", () => {
    for (const [title, type] of [
      ["Double Fudge", "Gels"], // gel twin of the Nail Color lacquer
      ["Cloud Nine", "Gels"], // gel twin
      ["GelShift Top Coat", "GelShift"], // gel system
      ["Candy Cane Cuties Holiday Set", "Sets"], // set
      ["Dream Glow Duo", "Sets"], // duo
      ["Cuticle Nippers - Pink", "Tools"], // tool
      ["Plush Shine Lip Gloss - Dainty", "Lip Care"], // cosmetics
      ["Mini Foot Balm", "Foot Care"], // foot care
      ["Care Bears Nail Decals", "Nail Art"], // nail art
      ["Care Bears Bundle", "PR Bundle"], // bundle
    ]) {
      const product = storeProduct(LONDONTOWN, title, type);
      assert.equal(isLondontownPolish(product), false, `${title} [${type}]`);
      assert.equal(gateKeeps("LondontownShopify", product), false, `${title} [${type}]`);
    }
  });

  it("drops a title ending in Mini, the mini size of a full-size shade", () => {
    const mini = storeProduct(LONDONTOWN, "Pearl Mini", "Nail Color");
    assert.equal(isLondontownPolish(mini), false);
    assert.equal(gateKeeps("LondontownShopify", mini), false);
    assert.equal(isLondontownPolish({ title: "Pearl", product_type: "Nail Color", tags: [] }), true);
    // Only a trailing Mini: a care product named "Mini ..." still defers to the generic gate.
    assert.equal(isLondontownPolish(storeProduct(LONDONTOWN, "Mini Nourishing Cuticle Oil", "Nail Care")), null);
  });

  it("drops a set, duo or kit title under any type", () => {
    for (const title of ["Berry Punch Duo", "Mini Lakur Set", "GelShift Kit", "Holiday Trio"]) {
      assert.equal(isLondontownPolish({ title, product_type: "Nail Color", tags: [] }), false, title);
    }
    assert.equal(isLondontownPolish({ title: "Sunset Boulevard", product_type: "Nail Color", tags: [] }), true);
  });

  it("defers Nail Care to the generic gate: coats and treatments stay, removers and creams go", () => {
    for (const title of ["Matte Top Coat", "High Gloss Top Coat", "Get Strong Nail Hardener", "Mini Nourishing Cuticle Oil"]) {
      const product = storeProduct(LONDONTOWN, title, "Nail Care");
      assert.equal(isLondontownPolish(product), null, title);
      assert.equal(gateKeeps("LondontownShopify", product), true, title);
    }
    for (const title of ["Lint-Free Remover Pads", "Mini Whipped Cloud Hand Cream", "Shimmering Nail Highlighter - Molten"]) {
      assert.equal(gateKeeps("LondontownShopify", storeProduct(LONDONTOWN, title, "Nail Care")), false, title);
    }
  });

  it("keeps gels only with includeGel", () => {
    const gel = storeProduct(LONDONTOWN, "Red Velvet", "Gels");
    assert.equal(isLondontownPolish(gel, readSourceSettings({ includeGel: true })), true);
    assert.equal(gateKeeps("LondontownShopify", gel, { includeGel: true }), true);
    assert.equal(gateKeeps("LondontownShopify", gel), false);
  });

  it("is registered for LondontownShopify", () => {
    assert.equal(SHOPIFY_STORE_PRODUCT_FILTERS.LondontownShopify, isLondontownPolish);
  });
});

// manucurist.com/products.json, fetched 2026-11-08 (250 products on page 1), trimmed to 104.
// product_type and titles are French; the same shade names come back as Green Flash gels.
const MANUCURIST = require("./fixtures/manucurist-products.json").products;
const LACQUER = "Vernis à ongles Green™";
const GREEN_FLASH = "Semi-permanent LED Green Flash™";

describe("store-filters/manucurist — isManucuristPolish", () => {
  it("with the generic gate keeps 28 of the 104 fixture products (36 with includeGel)", () => {
    assert.equal(MANUCURIST.length, 104);
    // 23 Green lacquers, 3 kids' polishes, the Green base coat and glitter top coat.
    const kept = gateAccepts(MANUCURIST, "ManucuristShopify");
    assert.equal(kept.length, 28);
    assert.ok(kept.every((product) => product.product_type !== GREEN_FLASH));
    // + 5 Green Flash gel shades and the 3 Green Flash coats.
    assert.equal(gateAccepts(MANUCURIST, "ManucuristShopify", { includeGel: true }).length, 36);
  });

  it("keeps the Green lacquers and the kids' polishes", () => {
    for (const title of ["Emerald", "Amour", "Milky Matcha", "Grenat", "Glacé Jelly", "Freckles", "Prune"]) {
      const product = storeProduct(MANUCURIST, title, LACQUER);
      assert.equal(isManucuristPolish(product), true, title);
      assert.equal(gateKeeps("ManucuristShopify", product), true, title);
    }
    assert.equal(isManucuristPolish(storeProduct(MANUCURIST, "Hector le Stégosaure")), true);
  });

  it("keeps the base and top coats whose remover tag the June blocklist rejects, with their category", () => {
    for (const [title, category] of [
      ["Base Coat Vitaminée Green™", "base_coat"],
      ["Top Coat Pailleté", "top_coat"],
    ]) {
      const product = storeProduct(MANUCURIST, title, LACQUER);
      assert.equal(isManucuristPolish(product), true, title);
      const gate = gateShopifyProduct(product, "ManucuristShopify", readSourceSettings({}, "ManucuristShopify"));
      assert.deepEqual([gate.accept, gate.category], [true, category], title);
    }
  });

  it("drops gels, kits, gift sets, after-sales and upsell listings, removers, accessories and nail art", () => {
    for (const [title, type] of [
      ["Emerald", GREEN_FLASH], // gel
      ["Top Coat Gel Xtrem Flash™", GREEN_FLASH], // gel coat
      ["Starter Kit Coffret Cadeau Green™", LACQUER], // kit / gift box
      ["Green™ Gift Set Holiday", LACQUER], // gift set
      ["(SAV) Dissolvant Doux Green™", LACQUER], // after-sales replacement
      ["Mini Active™ Duo", "Active"], // duo
      ["Routine Ultimate - Ongles Jaunes", "Soins"], // care routine set
      ["+ Sérum hydratant", "Soins"], // upsell add-on
      ["Brosse à Ongles", "Accessoires"], // tool
      ["Stickers Nail Art Halloween", "Nail art"], // nail art
      ["Sac Boutique GM", ""], // shop bag
    ]) {
      const product = storeProduct(MANUCURIST, title, type);
      assert.equal(isManucuristPolish(product), false, `${title} [${type}]`);
      assert.equal(gateKeeps("ManucuristShopify", product), false, `${title} [${type}]`);
    }
  });

  it("defers care products and untagged lacquer-typed listings to the generic gate, which drops them", () => {
    for (const [title, type] of [
      ["Dissolvant Doux", LACQUER], // remover
      ["Dégraissant Vitaminé", LACQUER], // prep
      ["Gouttes Séchantes", LACQUER], // drying drops
      ["Soin durcisseur", "Soins"],
      ["Active™ Shine Icy", "Active"],
    ]) {
      const product = storeProduct(MANUCURIST, title, type);
      assert.equal(isManucuristPolish(product), null, `${title} [${type}]`);
      assert.equal(gateKeeps("ManucuristShopify", product), false, `${title} [${type}]`);
    }
  });

  it("keeps Green Flash gels and gel coats only with includeGel", () => {
    const gel = storeProduct(MANUCURIST, "Sandstone", GREEN_FLASH);
    const settings = readSourceSettings({ includeGel: true });
    assert.equal(isManucuristPolish(gel, settings), true);
    assert.equal(isManucuristPolish(storeProduct(MANUCURIST, "Top Coat Gel Xtrem Flash™", GREEN_FLASH), settings), true);
    assert.equal(isManucuristPolish(storeProduct(MANUCURIST, "Lampe 18W", GREEN_FLASH), settings), null);
    assert.equal(gateKeeps("ManucuristShopify", storeProduct(MANUCURIST, "Lampe 18W", GREEN_FLASH), { includeGel: true }), false);
    assert.equal(gateKeeps("ManucuristShopify", gel), false);
  });

  it("is registered for ManucuristShopify", () => {
    assert.equal(SHOPIFY_STORE_PRODUCT_FILTERS.ManucuristShopify, isManucuristPolish);
  });
});

// oliveandjune.com/products.json, fetched 2026-11-08 (250 products on page 1), trimmed to 110.
const OLIVE_AND_JUNE = require("./fixtures/olive-and-june-products.json").products;

describe("store-filters/olive-and-june — isOliveAndJunePolish", () => {
  it("with the generic gate keeps 13 of the 110 fixture products (24 with includeGel)", () => {
    assert.equal(OLIVE_AND_JUNE.length, 110);
    // 7 single Nail Polish listings (tagged indiv-polish) and 6 Quick Dry polishes.
    assert.equal(gateAccepts(OLIVE_AND_JUNE, "OliveAndJuneShopify").length, 13);
    // + 11 single gels (tagged indiv-gel), two of them effect top coats.
    assert.equal(gateAccepts(OLIVE_AND_JUNE, "OliveAndJuneShopify", { includeGel: true }).length, 24);
  });

  it("keeps single polishes, including the glow topper whose KIT tag the June blocklist rejects", () => {
    for (const title of ["Late Morning Latte", "Shimmer Down", "Blackberry Jam", "Weekend Away", "Night Light", "Varietal", "Truffles"]) {
      const product = storeProduct(OLIVE_AND_JUNE, title, title === "Varietal" || title === "Truffles" ? "Quick Dry Polish" : "Nail Polish");
      assert.equal(isOliveAndJunePolish(product), true, title);
      assert.equal(gateKeeps("OliveAndJuneShopify", product), true, title);
    }
  });

  it("drops sets, minis, press-ons, gels, dip, systems, stickers, mystery boxes and merch", () => {
    for (const [title, type] of [
      ["Bittersweet Cherry", "Nail Polish"], // a look set (no indiv-polish tag)
      ["Holiday Party Set", "Nail Polish"], // set
      ["Mini Pink Sands", "Mini Polish"], // mini size
      ["Emerald Velvet - Press-on | Medium | Oval", "Press-On"], // press-on
      ["All the Bows - Pressies | Extra Short Short | Round", "Pressies"], // press-on
      ["Late Morning Latte - Gel", "Gel Polish"], // gel
      ["HD - Dip", "Dip Powder"], // dip powder
      ["The Mani System - Bonus Fall", "System"], // kit
      ["Candy Cane Sticker Set", "Nail Art Stickers"], // nail art
      ["Polish Mystery Box", "Misc"], // mystery box
      ["O&J To-Go Reusable Cup", "Merchandise"], // merch
    ]) {
      const product = storeProduct(OLIVE_AND_JUNE, title, type);
      assert.equal(isOliveAndJunePolish(product), false, `${title} [${type}]`);
      assert.equal(gateKeeps("OliveAndJuneShopify", product), false, `${title} [${type}]`);
    }
  });

  it("keeps single gels only with includeGel, never gel sets", () => {
    const settings = readSourceSettings({ includeGel: true });
    assert.equal(isOliveAndJunePolish(storeProduct(OLIVE_AND_JUNE, "Inkling - Gel"), settings), true);
    assert.equal(isOliveAndJunePolish(storeProduct(OLIVE_AND_JUNE, "Golden Effect Gel Top Coat"), settings), true);
    assert.equal(isOliveAndJunePolish(storeProduct(OLIVE_AND_JUNE, "Bonus Fall Gel Set"), settings), false);
    assert.equal(isOliveAndJunePolish(storeProduct(OLIVE_AND_JUNE, "Inkling - Gel")), false);
  });

  it("defers Care to the generic gate", () => {
    const care = { title: "Cuticle Serum", product_type: "Care", tags: ["care", "nail care"] };
    assert.equal(isOliveAndJunePolish(care), null);
  });

  it("is registered for OliveAndJuneShopify", () => {
    assert.equal(SHOPIFY_STORE_PRODUCT_FILTERS.OliveAndJuneShopify, isOliveAndJunePolish);
  });
});

// piggypaint.com/products.json, fetched 2026-11-08 (250 products on page 1), trimmed to 82 with
// body_html cut to 1,200 characters (the filter reads the descriptions).
// Piggy Paint is a kids' polish store that also sells toys, hair accessories and bath products;
// its SOPHi line's shade sets are typed Nail Polishes like the single shades.
const PIGGY_PAINT = require("./fixtures/piggy-paint-products.json").products;

describe("store-filters/piggy-paint — isPiggyPaintPolish", () => {
  it("with the filter keeps 10 of the 82 fixture products (the generic gate keeps 24, 16 of them sets)", () => {
    assert.equal(PIGGY_PAINT.length, 82);
    // 8 single Nail Polishes and the 2 polish pens (empty product_type).
    assert.equal(gateAccepts(PIGGY_PAINT, "PiggyPaintShopify").length, 10);
    assert.equal(gateAccepts(PIGGY_PAINT, "NotARealShopify").length, 24);
  });

  it("keeps single polishes and the polish pens", () => {
    for (const title of [
      "Bossy Blueberry - Scented Blue",
      "Bright Side Babe - Bright Fuchsia Pink",
      "Made Me Blush - Blush Pink",
      "Mint & Mingle - Pale Mint Green",
      "On Cloud 9 - Soft Light Blue",
      "Soft Launch - Soft Lavender with Pink",
      "Yippee Yellow Piggy Paint Pen - Kids Non-toxic Nail Polish",
    ]) {
      const product = storeProduct(PIGGY_PAINT, title);
      assert.equal(isPiggyPaintPolish(product), true, title);
      assert.equal(gateKeeps("PiggyPaintShopify", product), true, title);
    }
  });

  it("drops shade sets, gift sets, wholesale, press-ons, nail art kits, toys and hair accessories", () => {
    for (const title of [
      "Core Collection - SOPHi - Non-toxic Nail Polish", // shade set (description lists the shades)
      "So Peachy Pink - SOPHi - Non-toxic Nail Polish", // shade trio
      "Kiss of Color - SOPHi - Non-Toxic Nail Polish", // shade set, empty product_type
      "Sofia the First 4-Polish Box Set - Kids Non-toxic Nail Polish", // gift set
      "Santa's Pampered Piggies - Wholesale", // wholesale
      "Merry Mistletoe Press-on Nails", // press-ons (typed Nail Care)
      "Ready Set Rainbow! Bundle", // nail art kit bundle
      "Sweetheart 2-pack Piggy Pen Bundle", // pen bundle
      "Ivy Doll with Brown Hair - Tikiri Toys", // toy
      "Apple Gemstone Bow Clip - Hair Bows - Back To School", // hair accessory
    ]) {
      const product = storeProduct(PIGGY_PAINT, title);
      assert.equal(isPiggyPaintPolish(product), false, title);
      assert.equal(gateKeeps("PiggyPaintShopify", product), false, title);
    }
  });

  it("is registered for PiggyPaintShopify", () => {
    assert.equal(SHOPIFY_STORE_PRODUCT_FILTERS.PiggyPaintShopify, isPiggyPaintPolish);
  });
});

// wetnwildbeauty.com/products.json, fetched 2026-11-08 (250 products on page 1), trimmed to 62.
// wet n wild is a cosmetics store; its 6 polishes on page 1 are typed Nail Polishes.
const WET_N_WILD = require("./fixtures/wet-n-wild-products.json").products;

describe("store-filters/wet-n-wild — isWetNWildPolish", () => {
  it("with the filter keeps the 6 polishes of the 62 fixture products (the generic gate also keeps 4 primers and a lip treatment)", () => {
    assert.equal(WET_N_WILD.length, 62);
    const kept = gateAccepts(WET_N_WILD, "WetNWildShopify");
    assert.equal(kept.length, 6);
    assert.ok(kept.every((product) => product.product_type === "Nail Polishes"));
    assert.equal(gateAccepts(WET_N_WILD, "NotARealShopify").length, 10);
  });

  it("keeps nail color, nail polish and Wild Shine listings", () => {
    for (const title of [
      "Fast Dry AF Nail Color | Get Stoned",
      "Fast Dry AF Nail Color | Cotton Candy",
      "Fast Dry AF Nail Color | Red Light District",
      "Fast Dry AF Nail Color | Sorry, I'm Latte",
      "Fast Dry AF Nail Color | Southern Belle",
      "Fast Dry AF Nail Color | Out Of Pistachios",
    ]) {
      const product = storeProduct(WET_N_WILD, title);
      assert.equal(isWetNWildPolish(product), true, title);
      assert.equal(gateKeeps("WetNWildShopify", product), true, title);
    }
    assert.equal(isWetNWildPolish({ title: "Wild Shine Nail Color | Black Creme", product_type: "", tags: [] }), true);
    assert.equal(isWetNWildPolish({ title: "Wild Shine | Fierce", product_type: "", tags: [] }), true);
  });

  it("drops every cosmetic, including the primers and lip treatment the generic gate reads as coats", () => {
    for (const title of [
      "Photo Focus Matte Face Primer", // face primer (base_coat by the generic gate)
      "Photo Focus Matte Finish Setting Mist", // setting spray
      "Perfect Pout Lip Treatment", // lip treatment
      "TWIZZLERS Lip Gloss | Strawberry", // lip gloss
      "Chameleon Chrome Eyeshadow | Lunar Voltage", // eyeshadow
      "4-Piece Makeup Brush Set", // brush set
      "SLANTED TWEEZERS", // tool
      "Headband | Tigger", // accessory
    ]) {
      const product = storeProduct(WET_N_WILD, title);
      assert.equal(isWetNWildPolish(product), false, title);
      assert.equal(gateKeeps("WetNWildShopify", product), false, title);
    }
  });

  it("is registered for WetNWildShopify", () => {
    assert.equal(SHOPIFY_STORE_PRODUCT_FILTERS.WetNWildShopify, isWetNWildPolish);
  });
});

// penelopeluz.com/products.json, fetched 2026-11-08 (216 products, one page), trimmed to 78 with
// body_html cut to 1,200 characters (the filter reads the DESCRIPTION section after the store's
// boilerplate). Every product_type is empty and the page is all single shades except the cuticle oil.
const PENELOPE_LUZ = require("./fixtures/penelope-luz-products.json").products;

describe("store-filters/penelope-luz — isPenelopeLuzPolish", () => {
  it("keeps 77 of the 78 fixture products (the generic gate keeps none)", () => {
    assert.equal(PENELOPE_LUZ.length, 78);
    const kept = gateAccepts(PENELOPE_LUZ, "PenelopeLuzShopify");
    assert.equal(kept.length, 77);
    assert.ok(!kept.some((product) => product.title === "Oilplux"));
    assert.equal(gateAccepts(PENELOPE_LUZ, "NotARealShopify").length, 0);
  });

  it("keeps shades by their description, including ones whose names look like listings", () => {
    for (const title of [
      "Zarina", // magnetic
      "Tinker Bell",
      "Pixie Dust",
      "Here Comes the Vultures", // sparkle shimmer and glitter
      "Mystery", // a shade, not a mystery listing
      "Inebriating Coat", // a shade, not a coat
      "Deep Silent Complete", // no finish words: "The nail polish … is part of the Immortal Collection"
    ]) {
      const product = storeProduct(PENELOPE_LUZ, title);
      assert.equal(isPenelopeLuzPolish(product), true, title);
      assert.equal(gateKeeps("PenelopeLuzShopify", product), true, title);
    }
  });

  it("drops the cuticle oil, whose description names no polish, finish or effect", () => {
    assert.equal(isPenelopeLuzPolish(storeProduct(PENELOPE_LUZ, "Oilplux")), false);
  });

  it("drops sets, bundles, duos, trios, mystery boxes, gift cards and merch by title", () => {
    const shadeBody = storeProduct(PENELOPE_LUZ, "Zarina").body_html;
    for (const title of [
      "Fly to Your Heart Collection Set", // set
      "Immortal Bundle", // bundle
      "Holo Duo", // duo
      "Mermaid Trio", // trio
      "Mystery Box", // grab bag
      "Mystery Polish", // grab bag
      "Gift Card", // gift card
      "Penelope Luz Sticker", // merch
      "Magnet", // tool
    ]) {
      assert.equal(isPenelopeLuzPolish({ title, product_type: "", tags: [], body_html: shadeBody }), false, title);
    }
  });

  it("is registered for PenelopeLuzShopify", () => {
    assert.equal(SHOPIFY_STORE_PRODUCT_FILTERS.PenelopeLuzShopify, isPenelopeLuzPolish);
  });
});

// noodlesnailpolish.com/products.json, fetched 2026-11-08 (57 products, one page), all kept.
// Every product_type is empty; the page is 56 single shades and the gift card.
const NOODLES = require("./fixtures/noodles-products.json").products;

describe("store-filters/noodles — isNoodlesPolish", () => {
  it("keeps the 56 shades of the 57 fixture products (the generic gate keeps none)", () => {
    assert.equal(NOODLES.length, 57);
    const kept = gateAccepts(NOODLES, "NoodlesNailPolishShopify");
    assert.equal(kept.length, 56);
    assert.ok(!kept.some((product) => product.title === "Noodles Nail Polish Gift Card"));
    assert.equal(gateAccepts(NOODLES, "NotARealShopify").length, 0);
  });

  it("keeps shades and toppers by their description", () => {
    for (const title of [
      "Secret Garden", // crelly with metallic glitters
      "Witchful Thinking", // jelly with shifting flakies
      "Lover", // clear based topper
      "Polar Night", // creme with holo flakies
      "Moonlight Magic", // holo crelly
      "Misty Harbors", // description opens with a pigment-supply update
      "Berries & Cream",
    ]) {
      const product = storeProduct(NOODLES, title);
      assert.equal(isNoodlesPolish(product), true, title);
      assert.equal(gateKeeps("NoodlesNailPolishShopify", product), true, title);
    }
  });

  it("drops the gift card, sets, bundles, mystery listings and merch", () => {
    assert.equal(isNoodlesPolish(storeProduct(NOODLES, "Noodles Nail Polish Gift Card")), false);
    const shadeBody = storeProduct(NOODLES, "Secret Garden").body_html;
    for (const title of [
      "Holiday Collection Set", // set
      "Fall Bundle", // bundle
      "Topper Duo", // duo
      "Winter Trio", // trio
      "Mystery Polish", // grab bag
      "Noodles Sticker", // merch
      "Noodles T-Shirt", // apparel
    ]) {
      assert.equal(isNoodlesPolish({ title, product_type: "", tags: [], body_html: shadeBody }), false, title);
    }
  });

  it("drops a listing whose description names no polish, finish or effect", () => {
    assert.equal(isNoodlesPolish({ title: "Nail File", product_type: "", tags: [], body_html: "<p>A glass nail file.</p>" }), false);
  });

  it("is registered for NoodlesNailPolishShopify", () => {
    assert.equal(SHOPIFY_STORE_PRODUCT_FILTERS.NoodlesNailPolishShopify, isNoodlesPolish);
  });
});

// cnd.com/products.json, fetched 2026-11-08 (117 products, one page), all kept. CND lists its
// Shellac gel shades as variants of six family listings and its Vinylux shades are not on page 1
// one by one (only collections, the coats and the line listing).
const CND = require("./fixtures/cnd-products.json").products;

describe("store-filters/cnd — isCndPolish", () => {
  it("with the generic gate keeps 12 of the 117 fixture products (17 with includeGel)", () => {
    assert.equal(CND.length, 117);
    // The 2 Vinylux top coats and the 10 lacquer treatments (Solaroil, RidgeFx, Stickey, …).
    assert.equal(gateAccepts(CND, "CndShopify").length, 12);
    // + the 5 Shellac base and top coats.
    assert.equal(gateAccepts(CND, "CndShopify", { includeGel: true }).length, 17);
    // The generic gate alone also keeps the six Shellac family listings, Plexigel and Brisa coats.
    assert.equal(gateAccepts(CND, "NotARealShopify").length, 27);
  });

  it("keeps the Vinylux coats and defers the lacquer treatments to the generic gate", () => {
    for (const title of ["VINYLUX™ Gel-Like Effect Top Coat", "VINYLUX™ Long Wear Shine Top Coat"]) {
      const product = storeProduct(CND, title);
      assert.equal(isCndPolish(product), true, title);
      assert.equal(gateKeeps("CndShopify", product), true, title);
    }
    assert.equal(isCndPolish({ title: "CND™ VINYLUX™ Long Wear Polish - Rebellious Ruby", product_type: "", tags: [] }), true);
    for (const title of ["SOLAROIL™", "RidgeFx™", "Stickey™", "Super Shiney™", "StrengthenerRXx"]) {
      const product = storeProduct(CND, title);
      assert.equal(isCndPolish(product), null, title);
      assert.equal(gateKeeps("CndShopify", product), true, title);
    }
  });

  it("drops Shellac gel, collections, enhancements, tools, lamps and skincare", () => {
    for (const title of [
      "CND™ SHELLAC™ Gel Nail Polish - Reds", // gel, one listing for 33 shades
      "CND™ SHELLAC™ Original Top Coat", // gel coat
      "CND™ VINYLUX™ Party Ready Collection", // collection set
      "VINYLUX™ Long Wear Polish", // the line listing, not a shade
      "CND PLEXIGEL™ Color Builder Cool Berry", // builder gel
      "BRISA™ Base Coat", // sculpting gel system
      "Liquid Bond", // acrylic primer
      "Liquid & Powder System Kit", // kit
      "CND™ Liquid & Powder Sculpting Brush #12", // tool
      "CND™ LED Lamp", // lamp
      "Mango & Coconut Hand Wash", // skincare
      "CND™ Pro Skincare Intensive Hydration Treatment", // skincare
    ]) {
      const product = storeProduct(CND, title);
      assert.equal(isCndPolish(product), false, title);
      assert.equal(gateKeeps("CndShopify", product), false, title);
    }
  });

  it("keeps Shellac coats only with includeGel, never the multi-shade family listings", () => {
    const settings = readSourceSettings({ includeGel: true });
    assert.equal(isCndPolish(storeProduct(CND, "CND™ SHELLAC™ Base Coat"), settings), true);
    assert.equal(isCndPolish(storeProduct(CND, "CND™ SHELLAC™ XPRESS5™ Top Coat"), settings), true);
    assert.equal(isCndPolish(storeProduct(CND, "CND™ SHELLAC™ Gel Nail Polish - Pinks"), settings), false);
    assert.equal(gateKeeps("CndShopify", storeProduct(CND, "CND™ SHELLAC™ Base Coat")), false);
  });

  it("is registered for CndShopify", () => {
    assert.equal(SHOPIFY_STORE_PRODUCT_FILTERS.CndShopify, isCndPolish);
  });
});

// barrym.com/products.json, fetched 2026-11-08 (250 products on page 1), trimmed to 107. Barry M
// is a UK cosmetics brand; its polish is "Nail Paint", which the generic gate does not read as polish.
const BARRY_M = require("./fixtures/barry-m-products.json").products;

describe("store-filters/barry-m — isBarryMPolish", () => {
  it("with the filter keeps 58 of the 107 fixture products", () => {
    assert.equal(BARRY_M.length, 107);
    // Nail Paint 42, Nail 5, Topcoat 5, Basecoat 1, Nail Product 1 and the 4 Nail Care treatments.
    const kept = gateAccepts(BARRY_M, "BarryMShopify");
    assert.equal(kept.length, 58);
    assert.ok(kept.every((product) => /nail|coat/i.test(product.product_type)));
    // The generic gate alone drops 24 Nail Paint shades (no polish word) and keeps lip and face primers.
    assert.equal(gateAccepts(BARRY_M, "NotARealShopify").length, 48);
  });

  it("keeps Nail Paint shades, including ones without a polish word in type or tags, and the coats", () => {
    for (const title of [
      "Gelly Hi Shine Nail Paint | Black Cherry",
      "Rose Tinted Nail Paint | Eden Rose",
      "Glitter Effect Nail Paint | Party Pearl",
      "Sheer Strength Hardening Nail Paint | Sheer Luck",
      "Holochrome Holographic Effect Nail Paint  | Pistachio Prism",
      "Diamond Luxe Matte Nail Paint | Eternal", // typed Nail
      "Matte Topcoat", // typed Topcoat
      "All in One Nail Paint", // typed Basecoat
    ]) {
      const product = storeProduct(BARRY_M, title);
      assert.equal(isBarryMPolish(product), true, title);
      assert.equal(gateKeeps("BarryMShopify", product), true, title);
    }
    // Nail Care defers to the generic gate, which keeps the treatments.
    const treatment = storeProduct(BARRY_M, "Mani Hero Nail Treatment | Strengthen");
    assert.equal(isBarryMPolish(treatment), null);
    assert.equal(gateKeeps("BarryMShopify", treatment), true);
  });

  it("drops cosmetics, including the primers and lip treatments the generic gate reads as coats", () => {
    for (const title of [
      "In A Fix Grip Primer (30ml)", // face primer
      "Lid Lock Eyeshadow Primer | Clear", // eye primer
      "Lip Rehab Nourishing Lip Treatment | Pistachio Glaze", // lip treatment
      "Fine Glitter Dust | Gold Iridescent", // body glitter
      "Juicy Lip Duo Mango", // lip bundle
    ]) {
      const product = storeProduct(BARRY_M, title);
      assert.equal(isBarryMPolish(product), false, title);
      assert.equal(gateKeeps("BarryMShopify", product), false, title);
    }
    for (const product_type of ["Mascara", "Eyeliner", "Lip Liner", "Blusher"]) {
      const product = BARRY_M.find((entry) => entry.product_type === product_type);
      assert.ok(product, product_type);
      assert.equal(isBarryMPolish(product), false, product_type);
    }
  });

  it("drops nail art and nail tool types", () => {
    assert.equal(isBarryMPolish({ title: "Nail Art Pen | White", product_type: "Nail Art", tags: [] }), false);
    assert.equal(isBarryMPolish({ title: "Glass Nail File", product_type: "Nail Care Tools", tags: [] }), false);
  });

  it("is registered for BarryMShopify", () => {
    assert.equal(SHOPIFY_STORE_PRODUCT_FILTERS.BarryMShopify, isBarryMPolish);
  });
});

// ---------------------------------------------------------------------------------------------
// Phase C review follow-ups: vendor aliases on brand stores (C1), brand-store title parsers (I1),
// fixtures for the three filter-less enabled stores (I2).

const { readFileSync: readSeedFile } = require("node:fs");
const { resolve: resolveSeedPath } = require("node:path");
const { isCotePolish } = require("../dist/lib/connectors/store-filters/cote");
const { isAlchemyLacquersPolish } = require("../dist/lib/connectors/store-filters/alchemy-lacquers");
const {
  resolveBrandStoreVendor,
  resolveShopifyVendor,
} = require("../dist/lib/connectors/shopify-generic");
const { SHOPIFY_STORE_TITLE_PARSERS } = require("../dist/lib/connectors/shopify-title");
const {
  parseWetNWildTitle,
  parseBarryMTitle,
  parsePiggyPaintTitle,
  parseLineAndShadeTitle,
  parseCoteTitle,
  parseAlchemyLacquersTitle,
} = require("../dist/lib/connectors/store-filters/brand-store-titles");

const SEED_SQL = readSeedFile(resolveSeedPath(__dirname, "../../../docs/seed_data_sources.sql"), "utf8");

/** The seeded `data_source.metadata` of `name` (docs/seed_data_sources.sql). */
function seedMetadata(name) {
  const start = SEED_SQL.indexOf(`'${name}',`);
  assert.notEqual(start, -1, `${name} not seeded`);
  const tuple = SEED_SQL.slice(start, SEED_SQL.indexOf("::jsonb", start));
  const literal = tuple.slice(tuple.indexOf("'{"), tuple.lastIndexOf("}'") + 1);
  return JSON.parse(literal.slice(1).replace(/''/g, "'"));
}

/** Runs the connector over `products` with the source's seeded settings (offline: no AI, no fetch). */
async function pullFixture(source, products, metadata = seedMetadata(source)) {
  const originalFetch = globalThis.fetch;
  const originalEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
  delete process.env.AZURE_OPENAI_ENDPOINT;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: () => null },
    text: async () => JSON.stringify({ products }),
  });
  try {
    const settings = readSourceSettings(metadata, source);
    const connector = new ShopifyGenericConnector(source, null, { currency: settings.currency, settings });
    const result = await connector.pullProducts({ searchTerm: "", page: 1, pageSize: 500, maxRecords: 500 });
    return result.records;
  } finally {
    globalThis.fetch = originalFetch;
    if (originalEndpoint !== undefined) process.env.AZURE_OPENAI_ENDPOINT = originalEndpoint;
  }
}

/** The ingested record for the product titled `title` (by `rawTitle`). */
function recordFor(records, title) {
  const record = records.find((entry) => entry.normalized.rawTitle === title);
  assert.ok(record, `no record for ${title}`);
  return record;
}

describe("resolveBrandStoreVendor — brand stores consult vendorAliases first (C1)", () => {
  const aliases = readSourceSettings(seedMetadata("WetNWildShopify")).vendorAliases;

  it("maps an aliased vendor to the canonical brand, matching case- and whitespace-insensitively", () => {
    assert.equal(resolveBrandStoreVendor("Markwins WNW", aliases, "Wet N Wild"), "Wet n Wild");
    assert.equal(resolveBrandStoreVendor("  WET N WILD   beauty ", aliases, "Wet N Wild"), "Wet n Wild");
  });

  it("Barry M's seeded aliases fold its other vendor spellings into Barry M", () => {
    const barryM = readSourceSettings(seedMetadata("BarryMShopify")).vendorAliases;
    assert.equal(resolveBrandStoreVendor("barry m store", barryM, "Barry M"), "Barry M");
    assert.equal(resolveBrandStoreVendor("barrym-cosmetics", barryM, "Barry M"), "Barry M");
  });

  it("falls back to resolveShopifyVendor exactly without an alias match or without aliases", () => {
    for (const vendor of ["Other Brand", "vendor-unknown", "", null, "STELLA CHROMA", "LONDONTOWN"]) {
      for (const brand of ["Stella Chroma", "Londontown"]) {
        assert.equal(resolveBrandStoreVendor(vendor, aliases, brand), resolveShopifyVendor(vendor, brand));
        assert.equal(resolveBrandStoreVendor(vendor, {}, brand), resolveShopifyVendor(vendor, brand));
        assert.equal(resolveBrandStoreVendor(vendor, undefined, brand), resolveShopifyVendor(vendor, brand));
      }
    }
  });

  it("leaves a brand store without vendorAliases byte-for-byte unchanged", async () => {
    // Londontown's seed has no vendorAliases: its records are identical with and without settings.
    assert.equal(seedMetadata("LondontownShopify").vendorAliases, undefined);
    const withSettings = await pullFixture("LondontownShopify", LONDONTOWN);
    const withoutAliases = await pullFixture("LondontownShopify", LONDONTOWN, { currency: "USD" });
    assert.ok(withSettings.length > 0);
    assert.deepEqual(withSettings, withoutAliases);
    assert.ok(withSettings.every((record) => record.normalized.brand === resolveShopifyVendor("LONDONTOWN", "Londontown")));
  });
});

describe("brand-store title parsers (I1)", () => {
  it("registers wet n wild, Barry M and Piggy Paint", () => {
    assert.equal(SHOPIFY_STORE_TITLE_PARSERS.WetNWildShopify, parseWetNWildTitle);
    assert.equal(SHOPIFY_STORE_TITLE_PARSERS.BarryMShopify, parseBarryMTitle);
    assert.equal(SHOPIFY_STORE_TITLE_PARSERS.PiggyPaintShopify, parsePiggyPaintTitle);
    assert.equal(SHOPIFY_STORE_TITLE_PARSERS.CoteShopify, parseCoteTitle);
    assert.equal(SHOPIFY_STORE_TITLE_PARSERS.AlchemyLacquersShopify, parseAlchemyLacquersTitle);
  });

  it("Côte: strips a trailing Nail Polish / Nail Lacquer; keeps the phrase alone or a title without it", () => {
    const parse = (title) => parseCoteTitle({ title });
    assert.equal(parse("Pink Clouds Nail Polish"), "Pink Clouds");
    assert.equal(parse("Blush & Bashful nail polish"), "Blush & Bashful");
    assert.equal(parse("Sea Glass Nail Lacquer"), "Sea Glass");
    assert.equal(parse("Nail Polish"), null);
    assert.equal(parse("Quick Dry Top Coat"), null);
    assert.equal(parse("Growth with Garlic Nail Treatment"), null);
  });

  it("Alchemy Lacquers: strips one finish/topper/edition note, keeps any other parenthetical", () => {
    const parse = (title) => parseAlchemyLacquersTitle({ title });
    assert.equal(parse("Cauldron of Chaos (Magnetic)"), "Cauldron of Chaos");
    assert.equal(parse("Obsidian Kaleidoscope (Glitter Topper)"), "Obsidian Kaleidoscope");
    assert.equal(parse("Vanishing Act (Thermal)"), "Vanishing Act");
    assert.equal(parse("Pink Static (Limited Edition)"), "Pink Static");
    assert.equal(parse("Ultimate Question (Topper)"), "Ultimate Question");
    // Full 2026-11-08 page spellings: Solar, Solar & Thermal, Reflective.
    assert.equal(parse("Sunbeam (Solar & Thermal)"), "Sunbeam");
    assert.equal(parse("Sunbeam (Solar)"), "Sunbeam");
    assert.equal(parse("Mirrorball (Reflective)"), "Mirrorball");
    // Only one note is stripped.
    assert.equal(parse("Ghost (LE) (Magnetic)"), "Ghost (LE)");
    // Coat descriptions and anything else stay.
    assert.equal(parse("Quicksilver Top Coat (Quick Dry, Glossy, 5 Free)"), null);
    assert.equal(parse("Glitter Elixir (Smoothing Top Coat)"), null);
    assert.equal(parse("House Red (Lady is a Tramp)"), null);
    assert.equal(parse("Hammy"), null);
    assert.equal(parse("(Magnetic)"), null);
  });

  it("parseLineAndShadeTitle splits line and shade on the first pipe", () => {
    assert.deepEqual(parseLineAndShadeTitle("Fast Dry AF Nail Color | Get Stoned"), {
      name: "Get Stoned",
      productLine: "Fast Dry AF Nail Color",
    });
    assert.equal(parseLineAndShadeTitle("Photo Focus Matte Face Primer"), null);
    assert.equal(parseLineAndShadeTitle(" | Shade"), null);
  });

  it("wet n wild: <Line> | <Shade> gives the shade; a title without a pipe is kept", () => {
    const parse = (title) => parseWetNWildTitle({ title });
    assert.equal(parse("Fast Dry AF Nail Color | Get Stoned"), "Get Stoned");
    assert.equal(parse("Fast Dry AF Nail Color | Sorry, I'm Latte"), "Sorry, I'm Latte");
    assert.equal(parse("Wild Shine Nail Color | Black Creme"), "Black Creme");
    assert.equal(parse("Wild Shine Nail Color"), null);
    assert.equal(parse(""), null);
  });

  it("Barry M: <Line> | <Shade>, dropping a separated note and keeping an unseparated one", () => {
    const parse = (title) => parseBarryMTitle({ title });
    assert.equal(parse("Gelly Hi Shine Nail Paint | Black Cherry"), "Black Cherry");
    assert.equal(parse("Holochrome Holographic Effect Nail Paint  | Pistachio Prism"), "Pistachio Prism");
    assert.equal(parse("Barry M Colour Changing Sunlight Reactive Nail Paint | White to Pink C"), "White to Pink C");
    assert.equal(parse("Gelly Hi Shine Nail Paint | Black Cherry | Colour Change"), "Black Cherry");
    assert.equal(parse("Matte Topcoat"), null);
  });

  it("Barry M: never cuts a shade at ' - '", () => {
    const parse = (title) => parseBarryMTitle({ title });
    assert.equal(parse("Gelly Hi Shine Nail Paint | Black Cherry - 10ml"), "Black Cherry - 10ml");
    assert.equal(parse("Nail Paint | Rock - n - Roll"), "Rock - n - Roll");
  });

  it("Barry M: keeps the whole title when the line names a treatment or coat", () => {
    const parse = (title) => parseBarryMTitle({ title });
    for (const title of [
      "Mani Hero Nail Treatment | Strengthen",
      "Mani Hero Nail Treatment | Hydrate",
      "Super Size Base Coat | Clear",
      "Gelly Topcoat | Glossy",
      "Nail Care | Repair",
    ]) {
      assert.equal(parse(title), null, title);
    }
    // "Strength" is not "strengthen": the hardening nail paints are shades.
    assert.equal(parse("Sheer Strength Hardening Nail Paint | Sheer Luck"), "Sheer Luck");
  });

  it("Piggy Paint: strips a ' - <descriptor>' suffix after a plausible shade name, never without ' - '", () => {
    const parse = (title, vendor = "Piggy Paint") => parsePiggyPaintTitle({ title, vendor });
    assert.equal(parse("Bossy Blueberry - Scented Blue"), "Bossy Blueberry");
    assert.equal(parse("Yippee Yellow Piggy Paint Pen - Kids Non-toxic Nail Polish"), "Yippee Yellow Piggy Paint Pen");
    assert.equal(parse("Soft Launch - Soft Lavender with Pink", "SOPHi"), "Soft Launch");
    assert.equal(parse("Casually Cashmere", "SOPHi"), null);
    assert.equal(parse("Piggy Paint - Scented"), null); // the vendor, not a shade
    assert.equal(parse("9 - Nine"), null); // no letter
    assert.equal(parse("Mint-Green Dream"), null); // a hyphen is not the separator
  });
});

describe("wet n wild and Olive & June through the connector (C1, I1)", () => {
  it("wet n wild records carry the catalog brand Wet n Wild and the parsed shade name", async () => {
    const records = await pullFixture("WetNWildShopify", WET_N_WILD);
    assert.equal(records.length, 6);
    // The fixture's vendors are "Markwins WNW" and "wet n wild Beauty".
    assert.ok(records.every((record) => record.normalized.brand === "Wet n Wild"), records.map((r) => r.normalized.brand).join());
    assert.equal(recordFor(records, "Fast Dry AF Nail Color | Get Stoned").normalized.name, "Get Stoned");
    assert.equal(recordFor(records, "Fast Dry AF Nail Color | Out Of Pistachios").normalized.name, "Out Of Pistachios");
  });

  it("Olive & June records carry the canonical brand Olive & June", async () => {
    const records = await pullFixture("OliveAndJuneShopify", OLIVE_AND_JUNE);
    assert.equal(records.length, 13);
    // The accepted products are listed under "Olive and June", "Olive-and-June" and "Olive & June".
    assert.ok(records.every((record) => record.normalized.brand === "Olive & June"), records.map((r) => r.normalized.brand).join());
    const withGel = await pullFixture("OliveAndJuneShopify", OLIVE_AND_JUNE, { ...seedMetadata("OliveAndJuneShopify"), includeGel: true });
    assert.equal(withGel.length, 24);
    assert.ok(withGel.every((record) => record.normalized.brand === "Olive & June"));
  });

  it("Barry M records get the shade after the line", async () => {
    const records = await pullFixture("BarryMShopify", BARRY_M);
    assert.equal(recordFor(records, "Gelly Hi Shine Nail Paint | Black Cherry").normalized.name, "Black Cherry");
    assert.equal(recordFor(records, "Rose Tinted Nail Paint | Eden Rose").normalized.name, "Eden Rose");
    assert.equal(recordFor(records, "Matte Topcoat").normalized.name, "Matte Topcoat");
    assert.equal(
      recordFor(records, "Mani Hero Nail Treatment | Strengthen").normalized.name,
      "Mani Hero Nail Treatment | Strengthen"
    );
    // The seeded vendorAliases fold Barry M's other vendor spellings into the brand.
    assert.ok(records.every((record) => record.normalized.brand === "Barry M"), records.map((r) => r.normalized.brand).join());
  });

  it("Piggy Paint records drop the descriptor suffix; SOPHi stays its own brand", async () => {
    const records = await pullFixture("PiggyPaintShopify", PIGGY_PAINT);
    assert.equal(records.length, 10);
    assert.equal(recordFor(records, "Bossy Blueberry - Scented Blue").normalized.name, "Bossy Blueberry");
    assert.equal(
      recordFor(records, "Yippee Yellow Piggy Paint Pen - Kids Non-toxic Nail Polish").normalized.name,
      "Yippee Yellow Piggy Paint Pen"
    );
    assert.equal(recordFor(records, "Made Me Blush - Blush Pink").normalized.brand, "SOPHi");
    assert.equal(recordFor(records, "Bossy Blueberry - Scented Blue").normalized.brand, "Piggy Paint");
  });
});

// deborahlippmann.com/products.json, fetched 2026-11-08 (54 products, one page), kept whole with
// body_html cut to 1,200 characters. Every vendor is "LIPPMANN" (the catalog brand Deborah Lippmann
// has the alias 'lippmann', migration 005, so no vendorAliases entry is needed).
const DEBORAH_LIPPMANN = require("./fixtures/deborah-lippmann-products.json").products;

describe("DeborahLippmannShopify — the generic gate alone (I2)", () => {
  it("keeps 32 of the 54 fixture products: 25 lacquers, 2 coats and 5 treatments", () => {
    assert.equal(DEBORAH_LIPPMANN.length, 54);
    const kept = gateAccepts(DEBORAH_LIPPMANN, "DeborahLippmannShopify");
    assert.equal(kept.length, 32);
    assert.equal(gateAccepts(DEBORAH_LIPPMANN, "NotARealShopify").length, 32);
    const categories = kept.map((product) => gateShopifyProduct(product, "DeborahLippmannShopify").category);
    assert.equal(categories.filter((category) => category === "color").length, 25);
    assert.ok(kept.filter((p) => p.product_type === "Nail Polish").length === 25);
    assert.equal(SHOPIFY_STORE_PRODUCT_FILTERS.DeborahLippmannShopify, undefined);
  });

  it("drops the sets, bundles, tools and the pick-your-own lacquer listing", () => {
    for (const title of [
      "The Holiday Set",
      "Build Your Own Lacquer Bundle",
      "LIPPMANN Nail Lacquer",
      "The Nail Hydration Duo",
      "Cuticle Nipper",
    ]) {
      assert.equal(gateKeeps("DeborahLippmannShopify", storeProduct(DEBORAH_LIPPMANN, title)), false, title);
    }
  });
});

// coteshop.co/products.json, fetched 2026-11-08 (129 products, one page), trimmed (fixture _note)
// with body_html cut to 1,200 characters.
const COTE = require("./fixtures/cote-products.json").products;

describe("store-filters/cote — isCotePolish (I2)", () => {
  it("keeps 22 of the 65 fixture products; the generic gate also keeps the lip treatment", () => {
    assert.equal(COTE.length, 65);
    assert.equal(gateAccepts(COTE, "CoteShopify").length, 22);
    const generic = gateAccepts(COTE, "NotARealShopify");
    assert.equal(generic.length, 23);
    assert.deepEqual(
      generic.filter((product) => !gateKeeps("CoteShopify", product)).map((product) => product.title),
      ["The Ritual Peptide Enriched Lip Treatment"]
    );
  });

  it("drops lip-typed products and defers the rest to the generic gate", () => {
    assert.equal(isCotePolish(storeProduct(COTE, "The Ritual Peptide Enriched Lip Treatment")), false);
    assert.equal(isCotePolish({ title: "The Necessity Peptide Lip Shine, Stella", product_type: "lip shine" }), false);
    for (const title of ["Pink Clouds Nail Polish", "Quick Dry Top Coat", "Growth with Garlic Nail Treatment", "Smoothing Base Coat"]) {
      const product = storeProduct(COTE, title);
      assert.equal(isCotePolish(product), null, title);
      assert.equal(gateKeeps("CoteShopify", product), true, title);
    }
    assert.equal(isCotePolish({ title: "Slipper Pink", product_type: "Nail Polishes" }), null);
  });

  it("is registered for CoteShopify and its records carry the catalog brand Côte", async () => {
    assert.equal(SHOPIFY_STORE_PRODUCT_FILTERS.CoteShopify, isCotePolish);
    const records = await pullFixture("CoteShopify", COTE);
    assert.equal(records.length, 22);
    // Vendor "Côte Beauty" would otherwise create a second brand next to the seeded "Côte".
    assert.ok(records.every((record) => record.normalized.brand === "Côte"));
    assert.equal(recordFor(records, "Pink Clouds Nail Polish").normalized.name, "Pink Clouds");
    assert.equal(recordFor(records, "Sugar Côte Nail Polish").normalized.name, "Sugar Côte");
    assert.equal(recordFor(records, "Quick Dry Top Coat").normalized.name, "Quick Dry Top Coat");
  });
});

// alchemylacquers.com/products.json, fetched 2026-11-08 (228 products, one page), trimmed (fixture
// _note) with body_html cut to 1,200 characters.
const ALCHEMY = require("./fixtures/alchemy-lacquers-products.json").products;

describe("store-filters/alchemy-lacquers — isAlchemyLacquersPolish (I2)", () => {
  it("keeps 61 of the 75 fixture products; the generic gate also keeps Mystery Overpours", () => {
    assert.equal(ALCHEMY.length, 75);
    assert.equal(gateAccepts(ALCHEMY, "AlchemyLacquersShopify").length, 61);
    const generic = gateAccepts(ALCHEMY, "NotARealShopify");
    assert.equal(generic.length, 62);
    assert.deepEqual(
      generic.filter((product) => !gateKeeps("AlchemyLacquersShopify", product)).map((product) => product.title),
      ["Mystery Overpours"]
    );
  });

  it("drops mystery, grab bag, sample and pick-N listings and defers the rest", () => {
    for (const title of ["Mystery Overpours", "Holiday Grab Bag", "Sample Vial", "Pick 3 Polishes", "Pick Any 2"]) {
      assert.equal(isAlchemyLacquersPolish({ title, product_type: "Nail Lacquer" }), false, title);
    }
    for (const title of ["Hammy", "Lucky", "Cauldron of Chaos (Magnetic)", "Tria Prima Base Coat"]) {
      const product = storeProduct(ALCHEMY, title);
      assert.equal(isAlchemyLacquersPolish(product), null, title);
      assert.equal(gateKeeps("AlchemyLacquersShopify", product), true, title);
    }
  });

  it("is registered for AlchemyLacquersShopify and maps the My Store vendor to Alchemy Lacquers", async () => {
    assert.equal(SHOPIFY_STORE_PRODUCT_FILTERS.AlchemyLacquersShopify, isAlchemyLacquersPolish);
    const records = await pullFixture("AlchemyLacquersShopify", ALCHEMY);
    assert.equal(records.length, 61);
    assert.equal(recordFor(records, "Hammy").raw.vendor, "My Store");
    assert.ok(records.every((record) => record.normalized.brand === "Alchemy Lacquers"));
    assert.equal(recordFor(records, "Cauldron of Chaos (Magnetic)").normalized.name, "Cauldron of Chaos");
    assert.equal(recordFor(records, "Hologram (Glitter Topper)").normalized.name, "Hologram");
    assert.equal(
      recordFor(records, "Quicksilver Top Coat (Quick Dry, Glossy, 5 Free)").normalized.name,
      "Quicksilver Top Coat (Quick Dry, Glossy, 5 Free)"
    );
  });
});

// polishpickup.com/products.json, fetched 2026-11-08 (the November "Antiques & Oddities" round,
// 92 products on page 1), trimmed (fixture _note). Product types are shop sections, not finishes.
const POLISH_PICKUP = require("./fixtures/polish-pickup-products.json").products;

describe("store-filters/polish-pickup — isPolishPickupPolish on the November 2026 shop", () => {
  it("keeps the 70 PPU polishes and the usable IPU coats, drops the rest", () => {
    assert.equal(POLISH_PICKUP.length, 92);
    const kept = gateAccepts(POLISH_PICKUP, "PolishPickupShopify");
    const byType = {};
    for (const product of kept) byType[product.product_type.trim()] = (byType[product.product_type.trim()] || 0) + 1;
    assert.equal(byType.PPU, 70);
    assert.equal(byType.Merchandise, undefined);
    assert.equal(byType["Hand & Nail"], undefined);
    assert.equal(byType["Gift Cards"], undefined);
const ipu = kept.filter((product) => product.product_type.trim() === "IPU");
    assert.equal(kept.length, 75);
    assert.deepEqual(
      ipu.map((product) => [product.title, classifyIngestedProduct(product).category]),
      [
        ["Cuticle caviar by Sassy Sauce Polish | Vanilla Candy Rock Candy", "treatment"],
        ["Base Coat by Vibrant Scents | One of a Kind - Scented Double Bond Base Coat", "base_coat"],
        ["Top Coat by Vibrant Scents | One of a Kind - Scented Fast & Hard Quick Dry Top Coat", "top_coat"],
        ["Top Coat by Glisten & Glow", "top_coat"],
        ["Top Coat by Cuticula | Wild Strawberry Limitless Quick Dry Scented Top Coat", "top_coat"],
      ]
    );
    // Without the store filter the generic gate sees none of the PPU polishes (type PPU, no polish tag).
    assert.ok(gateAccepts(POLISH_PICKUP, "NotARealShopify").length < 10);
  });

  it("drops stamping plates, removers, scrubs, creams, tools, merchandise and the gift card", () => {
    for (const title of [
      "Stamping Plate by Hit the Bottle Polishes | Full Steam Ahead",
      "Acetone Antidote by Baroness X | Wicked Vanilla Woods",
      "Hand & Body Scrub by KBShimmer | Winter Lodge",
      "Unicorn Magic Skincare | Deluxe Coconut Milk Hand Creme scented in Nocturne No.5",
      "Nail File, Glass",
      "Neodymium Bar Magnet",
      "Gift Card - Electronic",
    ]) {
      assert.equal(gateKeeps("PolishPickupShopify", storeProduct(POLISH_PICKUP, title)), false, title);
    }
  });

  it("decides by product type: PPU true, shop sections false, IPU deferred", () => {
    assert.equal(isPolishPickupPolish(storeProduct(POLISH_PICKUP, "Nail File, Glass")), false);
    assert.equal(isPolishPickupPolish(storeProduct(POLISH_PICKUP, "Gift Card - Electronic")), false);
    assert.equal(isPolishPickupPolish(storeProduct(POLISH_PICKUP, "Top Coat by Glisten & Glow")), null);
    assert.equal(isPolishPickupPolish(POLISH_PICKUP.find((product) => product.product_type.trim() === "PPU")), true);
    assert.equal(SHOPIFY_STORE_PRODUCT_FILTERS.PolishPickupShopify, isPolishPickupPolish);
  });
});
