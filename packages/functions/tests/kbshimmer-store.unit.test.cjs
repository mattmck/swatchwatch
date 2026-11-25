// KBShimmer store filter and title parser (store-filters/kbshimmer.ts), with titles from the
// 2026-11-11 Store API run, and their wiring into the WooCommerce connector.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { isKbshimmerPolish, parseKbshimmerTitle } = require("../dist/lib/connectors/store-filters/kbshimmer");
const { shopifyStoreProductVerdict } = require("../dist/lib/connectors/store-filters/index");
const { shopifyStoreShadeName } = require("../dist/lib/connectors/shopify-title");
const { gateWooStoreProduct } = require("../dist/lib/connectors/woocommerce-store");
const { readSourceSettings } = require("../dist/lib/source-settings");

const SOURCE = "KbshimmerWooCommerce";

describe("KBShimmer store filter", () => {
  for (const title of [
    "Polish & Beauty Expo Navy Rainbow 40 oz Stainless Steel Tumbler",
    "Polish & Beauty Expo Black Rainbow 40 oz Stainless Steel Tumber",
    "Matte White 24 Oz Tumbler",
    "2026 Exclusive Meet & Greet Polish with 24 Oz Color Change Cup – Dots",
    "2025 Heathered Gray Polish & Beauty Expo Sweatshirt",
    "Clearly On Top Quick Dry Top Coat 4 OZ Refill",
    "Hand & Body Scrub – Pink Sugar",
    "Cuticle Oil Pen – Barely There",
    "Roller Ball Cuticle Oil – Cherry Almond",
    "Matte Cuticle Cream – Pink Sugar",
    "Mani Shot – Raspberry Vanilla",
    "Mystery Nail Polish",
    "Restoration Drops Polish Thinner 4 oz – NEW Turret Dropper Top!",
    "Turret Dropper Top",
    "KBShimmer Holographic Sticker",
  ]) {
    it(`drops "${title}"`, () => assert.equal(isKbshimmerPolish({ title }), false));
  }

  for (const title of [
    "Tricked Out Reflective Nail Polish",
    "Comet At Me Bro Multichrome Magnetic Nail Polish",
    "Bundled Up Nail Polish",
    "Clearly On Top Quick Dry Top Coat",
    "pH Prep Nail Balancing Pre-Polish Nail Treatment",
  ]) {
    it(`defers "${title}" to the generic gate`, () => assert.equal(isKbshimmerPolish({ title }), null));
  }

  it("is registered for the WooCommerce source", () => {
    assert.equal(shopifyStoreProductVerdict(SOURCE, { title: "Neon Pink 24 Oz Tumbler" }), false);
    assert.equal(shopifyStoreProductVerdict(SOURCE, { title: "Tricked Out Nail Polish" }), null);
  });
});

describe("KBShimmer title parser", () => {
  const cases = [
    ["Tricked Out Reflective Nail Polish", "Tricked Out"],
    ["Comet At Me Bro Multichrome Magnetic Nail Polish", "Comet At Me Bro"],
    ["Splash Talking Crème Nail Polish", "Splash Talking"],
    ["Slay La Vie Tri-Thermal Nail Polish", "Slay La Vie"],
    ["Blanket Statement Reflective Flake Nail Polish", "Blanket Statement"],
    ["Sol Amazing Irdescent Flake Nail Polish Topper", "Sol Amazing"],
    ["A Real Gem Rainbow Reflective Nail Polish Topper", "A Real Gem"],
    ["Prism Break Glitter Polish Topper", "Prism Break"],
    ["Kringle All The Way Glitter Nail Polish Topper", "Kringle All The Way"],
    ["Anything Is Popsicle Flakie Nail Polish", "Anything Is Popsicle"],
    ["“D’oh!” Nail Polish – PBE 2026 Exclusive", "D’oh!"],
    ["Blockbuster Nail Polish – PPU January 2026", "Blockbuster"],
    ["Shade Shifter® Nail Polish", "Shade Shifter®"],
    // Only finish words: the name is kept rather than emptied.
    ["Glitter Nail Polish", "Glitter"],
  ];
  for (const [title, expected] of cases) {
    it(`"${title}" → "${expected}"`, () => assert.equal(parseKbshimmerTitle({ title }), expected));
  }

  for (const title of ["Clearly On Top Quick Dry Top Coat", "Basic Training Nail Polish Base Coat", "Rock On! Nail Strengthener"]) {
    it(`keeps "${title}" (no polish suffix)`, () => assert.equal(parseKbshimmerTitle({ title }), null));
  }

  it("is registered for the WooCommerce source", () => {
    assert.equal(shopifyStoreShadeName(SOURCE, { title: "Tricked Out Reflective Nail Polish" }), "Tricked Out");
  });
});

describe("WooCommerce connector with the KBShimmer parser", () => {
  const settings = readSourceSettings({ brand: "KBShimmer", currency: "USD" }, SOURCE);
  const product = (name, category = "Nail Polish") => ({
    id: 1,
    name,
    categories: [{ name: category }, { name: "Nail Polish (All Finishes)" }],
    tags: [],
  });

  it("names the shade from the parser and keeps the raw title", () => {
    const outcome = gateWooStoreProduct(product("Tricked Out Reflective Nail Polish"), SOURCE, settings);
    assert.equal(outcome.accept, true);
    assert.equal(outcome.gated.listing.shadeName, "Tricked Out");
    assert.equal(outcome.gated.title, "Tricked Out Reflective Nail Polish");
  });

  it("drops merch the generic gate would keep", () => {
    const outcome = gateWooStoreProduct(product("Pink Teal 24 Oz Tumbler", "Polish & Beauty Expo"), SOURCE, settings);
    assert.equal(outcome.accept, false);
  });
});
