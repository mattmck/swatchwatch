const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  parsePolishPickupTitle,
  stripRetailerExclusiveSuffix,
  parseEditionCap,
  shopifyStoreShadeName,
  SHOPIFY_TITLE_PARSER_SOURCES,
} = require("../dist/lib/connectors/shopify-title");
const { isPolishPickupPolish } = require("../dist/lib/connectors/store-filters/polish-pickup");
const { shopifyStoreProductVerdict } = require("../dist/lib/connectors/store-filters");

// Trimmed copies of three polishpickup.com products (2026-11-06).
const PPU_PRODUCTS = [
  { title: "Psyche Minerals | Grandma's Pitcher", vendor: "Psyche Minerals", product_type: "PPU", tags: ["Nov", "PPU"] },
  { title: "Royla Lee | Beloved by Betty", vendor: "Royla Lee", product_type: "PPU", tags: ["Nov", "PPU"] },
  { title: "Seal Glaze by DRK Nails", vendor: "DRK Nails", product_type: "IPU", tags: ["Nov", "IPU"] },
];

const parse = (title, vendor) => parsePolishPickupTitle({ title, vendor });

describe("parsePolishPickupTitle", () => {
  it("takes the shade after the pipe", () => {
    assert.equal(parse(PPU_PRODUCTS[0].title, PPU_PRODUCTS[0].vendor), "Grandma's Pitcher");
    assert.equal(parse(PPU_PRODUCTS[1].title, PPU_PRODUCTS[1].vendor), "Beloved by Betty");
  });
  it("keeps a long coat name after a Type by Vendor prefix", () => {
    assert.equal(
      parse("Top Coat by Cuticula | Wild Strawberry Limitless Quick Dry Scented Top Coat", "Cuticula"),
      "Wild Strawberry Limitless Quick Dry Scented Top Coat"
    );
  });
  it("uses the type when the shade repeats the vendor", () => {
    assert.equal(parse("Top Coat by Glisten & Glow | Glisten & Glow", "Glisten & Glow"), "Top Coat");
  });
  it("takes the type from a pipe-less Type by Vendor title", () => {
    assert.equal(parse(PPU_PRODUCTS[2].title, PPU_PRODUCTS[2].vendor), "Seal Glaze");
  });
  it("declines titles it cannot read", () => {
    assert.equal(parse("Gift Card - Electronic", "PPickup"), null);
    assert.equal(parse("", "X"), null);
  });
});

describe("shopifyStoreShadeName", () => {
  it("only runs for Polish Pickup", () => {
    assert.ok(SHOPIFY_TITLE_PARSER_SOURCES.includes("PolishPickupShopify"));
    assert.equal(shopifyStoreShadeName("PolishPickupShopify", PPU_PRODUCTS[0]), "Grandma's Pitcher");
    assert.equal(shopifyStoreShadeName("PahlishShopify", PPU_PRODUCTS[0]), null);
  });
});

describe("stripRetailerExclusiveSuffix", () => {
  it("removes a trailing PPU token", () => {
    assert.equal(stripRetailerExclusiveSuffix("Sniff Test PPU"), "Sniff Test");
    assert.equal(stripRetailerExclusiveSuffix("Mall Goth (PPU)"), "Mall Goth");
  });
  it("leaves other names alone", () => {
    assert.equal(stripRetailerExclusiveSuffix("PPUrple"), "PPUrple");
    assert.equal(stripRetailerExclusiveSuffix("PPU Exclusive Topper"), "PPU Exclusive Topper");
    assert.equal(stripRetailerExclusiveSuffix("PPU"), "PPU");
  });
});

describe("parseEditionCap", () => {
  it("reads the cap", () => {
    assert.equal(parseEditionCap("Darkened teal jelly. Cap: 300 Size: 15ml"), 300);
  });
  it("returns null without one", () => {
    assert.equal(parseEditionCap("$10 no cap"), null);
    assert.equal(parseEditionCap(null), null);
  });
});

describe("isPolishPickupPolish", () => {
  const verdict = (product_type) => isPolishPickupPolish({ product_type });
  it("maps product types", () => {
    assert.equal(verdict("PPU"), true);
    assert.equal(verdict("IPU"), null);
    assert.equal(verdict("Merchandise"), false);
    assert.equal(verdict("Hand & Nail"), false);
    assert.equal(verdict("Gift Cards"), false);
    assert.equal(verdict("Something else"), null);
    assert.equal(verdict(undefined), null);
  });
  it("is registered for PolishPickupShopify", () => {
    assert.equal(shopifyStoreProductVerdict("PolishPickupShopify", PPU_PRODUCTS[0]), true);
    assert.equal(shopifyStoreProductVerdict("PolishPickupShopify", PPU_PRODUCTS[2]), null);
  });
});
