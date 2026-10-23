const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  classifyProductCategory,
  classifyIngestedProduct,
  hasPolishSignal,
} = require("../dist/lib/product-category");
const { PRODUCT_CATEGORIES } = require("swatchwatch-shared");

/** One linked source product, as the audit query reads it (title, product type, tags). */
const shade = (shadeName, productType, tags = [], finishes = [], extra = {}) => ({
  shadeName,
  colorName: shadeName,
  finishes,
  products: [{ title: shadeName, productType, tags }],
  ...extra,
});

describe("lib/product-category — classifyProductCategory (audit section 6 samples)", () => {
  // Reviewed samples from docs/queries/catalog-hygiene-audit.sql run on the local dev seed
  // (2026-10-18), with each shade's real title, product type and tags.
  const SAMPLES = [
    ["accessory", shade("Shapeshifter", "Nail Tools", ["all-products", "bundle:nail-file", "collection:nail-tool", "nail-file", "nail-tool", "type:accessories", "type:nail-tool"])],
    ["accessory", shade("Magnetic Wand", "Nail Tools", ["collection:nail-tool", "google:excluded", "magnetic-wand", "nail-tool", "type:nail-tool"], ["magnetic"])],
    ["accessory", shade("Boundary Pusher", "Cuticle Pushers", ["all-products", "collection:nail-tool", "nail-tool", "type:nail-tool"])],
    ["accessory", shade("Velvet Effect Horseshoe Magnet", "Nail Tools", ["collection:everything", "collection:nail-tool", "restrict:magnet"], ["magnetic"])],
    ["base_coat", shade("Quick-Dry Base", "Base Coat", ["all-products", "base-coat", "byob-base", "color:clear", "finish:essentials", "nail-polish", "polish", "top-and-base-coats"])],
    ["base_coat", shade("Sticky Base", "Nail Polish", ["all-products", "base-coat", "byob-base", "color:clear", "finish:essentials", "nail-polish", "polish", "top-and-base-coats"])],
    ["topper", shade("Aura", "Nail Polishes", ["nail-polish", "type:nail-polish"], ["topper", "shimmer"])],
    ["topper", shade("Blue Flakie Holo Taco", "Top Coat", ["all-products", "finish:flakie", "flakes", "nail-polish", "top-coat", "toppers"], ["flake"])],
    ["topper", shade("Purple Flakie Holo Taco", "Nail Polish", ["finish:flakie", "flakes", "nail-polish", "top-coat", "toppers"], ["flake"])],
    ["topper", shade("Freezer Burn", "Nail Polish", ["byob-topper", "color:blue", "finish:iridescent", "nail-polish", "toppers"], ["topper"])],
    // Holo Taco tags its magnetic polishes "magnetic-wand"; tags never make an accessory.
    ["topper", shade("Holo Magnetic Taco", "Nail Polish", ["finish:holographic", "finish:magnetic", "magnetic-polish", "magnetic-wand", "nail-polish", "toppers"], ["holographic"])],
    ["color", shade("Apparition", "nail polish", ["magnetic", "magnetic-polish", "nail-polish", "type:nail-polish"], ["magnetic"])],
    ["color", shade("Illusionist", "Nail Polishes", ["finish:magnetic", "magnetic", "magnetic-polish"], ["magnetic"])],
    ["color", shade("Neptune's Sand", "Nail Polishes", ["google:excluded", "status:no-restock"], ["magnetic", "holographic"])],
  ];

  for (const [expected, input] of SAMPLES) {
    it(`${input.shadeName} → ${expected}`, () => {
      assert.equal(classifyProductCategory(input).category, expected);
    });
  }
});

describe("lib/product-category — #347 false positives", () => {
  const accessories = [
    ["a stamping plate", shade("Witchy Vibes Stamping Plate", "Stamping Plates", ["nail-art"])],
    ["a stamper", shade("Clear Jelly Stamper", "Nail Art", ["stamping"])],
    ["a buffer", shade("4-Way Buffer", "Nail Care", [])],
    ["a nail file", shade("Glass Nail File", "Nail Care", ["nail-polish"])],
    ["charms", shade("Nail Charm Set", "Nail Art", ["nail-polish"])],
    ["a magnet", shade("Cat Eye Magnet", "Nail Polish", ["nail-polish"])],
    ["a cuticle pusher", shade("Cuticle Pusher", "Nail Care", [])],
    ["a remover (plural product type)", shade("Acetone-Free Remover", "Nail Polish Removers", [])],
    ["a gift card", shade("Digital Gift Card", "Gift Card", [])],
    ["a tool tagged as a type (Mooncat Nail Elixir)", shade("Nail Elixir", "Nail Polishes", ["collection:nail-tool", "nail-tool", "type:nail-polish", "type:nail-tool"])],
  ];
  for (const [label, input] of accessories) {
    it(`classifies ${label} as an accessory`, () => {
      assert.equal(classifyProductCategory(input).category, "accessory");
    });
  }

  it("never makes an accessory from a free-form tag", () => {
    assert.equal(classifyProductCategory(shade("Midnight Plum", "Nail Polish", ["magnetic-wand", "brush-on", "kit-exclusive"])).category, "color");
  });

  it("keeps Holo Taco 'Top Coat'-typed flakie toppers as toppers (topper beats coat wording)", () => {
    const result = classifyProductCategory(shade("Gold Flakie Holo Taco", "Top Coat", ["finish:flakie", "nail-polish", "top-coat", "toppers"], ["flake"]));
    assert.equal(result.category, "topper");
    assert.equal(result.evidence, "tag");
  });

  it("classifies Holo Taco 'Quick-Dry Base' and 'Sticky Base' as base coats", () => {
    assert.equal(classifyProductCategory(shade("Quick-Dry Base", "Base Coat", ["base-coat"])).category, "base_coat");
    assert.equal(classifyProductCategory(shade("Sticky Base", "Nail Polish", ["base-coat", "nail-polish"])).category, "base_coat");
  });
});

describe("lib/product-category — ambiguous accessory words (CodeRabbit, #347)", () => {
  it("keeps polishes named like accessories as color polishes when the product type names a polish", () => {
    for (const name of ["Crown Jewels", "Foil Finish", "Stud Muffin", "Tape Deck Teal", "Magic Wand", "Rhinestone Cowboy"]) {
      assert.equal(classifyProductCategory(shade(name, "Nail Polish", ["nail-polish"])).category, "color", name);
      assert.equal(classifyIngestedProduct({ title: name, productType: "Nail Polishes", tags: [] }).accept, true, name);
    }
  });

  it("keeps a shade with no product type or no source product a color polish", () => {
    assert.equal(classifyProductCategory({ shadeName: "Crown Jewels" }).category, "color");
    assert.equal(classifyProductCategory(shade("Crown Jewels", null)).category, "color");
    assert.equal(classifyIngestedProduct({ title: "Crown Jewels", tags: [] }).accept, false, "no polish signal at all");
  });

  it("still treats them as accessories under a non-polish product type", () => {
    assert.equal(classifyProductCategory(shade("Crown Jewels", "Nail Art")).category, "accessory");
    assert.equal(classifyProductCategory(shade("Rhinestone Pack", "Nail Art")).category, "accessory");
    assert.equal(classifyProductCategory(shade("Foil Sheets", "Nail Care")).category, "accessory");
    assert.equal(classifyProductCategory(shade("Magnetic Wand", "Nail Tools")).category, "accessory");
  });

  it("keeps clear accessory words authoritative even under a polish product type", () => {
    assert.equal(classifyProductCategory(shade("Nail Charm Set", "Nail Polish")).category, "accessory");
    assert.equal(classifyProductCategory(shade("Cat Eye Magnet", "Nail Polish")).category, "accessory");
  });
});

describe("lib/product-category — sets, bundles and more accessories (#347 follow-up)", () => {
  // Real titles, product types and tags from the connected stores' products.json (2026-10-23).
  const SETS = [
    shade("Heroes Bundle", "Nail Polish", ["Collection", "Nail Polish"]),
    shade("Laris' Trio", "Nail Lacquer Bundle", ["Beauty Pro Pricing"]),
    shade("2025 Nail Lacquer Countdown Box Overpours", "Nail Polish"),
    shade("Black And White Duo", "Nail Polish", ["Collection", "Nail Polish"]),
    shade("Curated Chaos quad", "Nail Polishes"),
    shade("Lacquer Set", "Nail Polishes"),
    shade("Romeo + Juliet Complete set", "Nail Polishes"),
    shade("Declassified Tacos Set [003]", "Nail Polish"),
    shade("Cottagecore Collection", "Nail Polish", ["all-products", "bundles-sets", "nail-polish"]),
    shade("Babbs Holo Collection", null, ["all", "babbslacquer", "curated"]),
    shade("Pluviophile (Full Collection)", "Polish"),
    shade("Love Spell Gift Set", "Nail Polish"),
    shade("Enchanted Forest Advent Calendar 2026 - PREORDER", null, ["nail polish"]),
    shade("Mystery Packs, 10 bottles of nail polish", "Nail Polishes"),
    shade("Danse Macabre", "Nail Polishes", ["collection-set"]),
    shade("New Year Thermal Duo - Limited Edition", "Polish"),
    // Hyphenated set and pack forms (CodeRabbit, #452).
    shade("Nail Polish 3-Pack", "Nail Polish"),
    shade("Holiday Gift-Set", "Nail Polish"),
    shade("Fall Favorites 4-Piece", "Nail Polish"),
    shade("Neon 2-Piece", "Nail Polish"),
  ];
  for (const input of SETS) {
    it(`${input.shadeName} is a set (accessory, evidence set)`, () => {
      assert.deepEqual(classifyProductCategory(input), { category: "accessory", evidence: "set" });
      assert.equal(classifyIngestedProduct({ title: input.shadeName, productType: input.products[0].productType, tags: input.products[0].tags }).accept, false);
    });
  }

  it("keeps single polishes whose names only look like sets", () => {
    const singles = [
      shade("Set On Fire", "Nail Lacquers"),
      shade("Jet Set", "Nail Polish"),
      shade("SUN-SET THE MOOD", "Nail Lacquers"),
      shade("Box Office Bomb", "Nail Polish"),
      shade("Bundle of Joy", "Nail Polish"),
      shade("Duo Chrome Dream", "Nail Polish"),
      shade("Brat Pack", "Nail Polish"),
      shade("Gift Receipt", "Nail Polish", ["finish:metallic", "color:silver"]),
      shade("Mystery Crackle - Jan 2024", "Polish"),
      shade("Mystery Polish - Gel - 1 Pc (may value up to $21)", "Gel Polish"),
      // Dam names single shades after the release they belong to.
      shade("Citrine - Yellow Orange Holographic Polish - Gemstone Collection Pt. 4", "Holographic"),
      shade("Ox - Brown Shimmer Nail Polish - Chinese Zodiac Collection", "Nail Polishes"),
      shade("Cheers to 10 Years - Blue Shimmer Nail Polish - 10th Anniversary Trio", "Nail Polish"),
      shade("A Grave Mistake - Purple Shimmer Indie Nail Polish - Halloween Quad 2024", "Nail Polish"),
      shade("Citrine - Yellow Orange Holographic Polish - Anniversary Trio", "Holographic"),
      // "2-in-1" is not a piece count.
      shade("2-in-1 Glow", "Nail Polish"),
    ];
    for (const input of singles) {
      assert.equal(classifyProductCategory(input).category, "color", input.shadeName);
    }
  });

  it("gives set evidence to a set that also names an accessory, so the connector always skips it", () => {
    assert.deepEqual(classifyProductCategory(shade("Nail Polish Sticker Gift Set", "Nail Polish")), { category: "accessory", evidence: "set" });
  });

  it("classifies the dev catalog examples", () => {
    assert.equal(classifyProductCategory(shade("$2 Mystery 3D Nail Art", "Nail Art", ["spring cleaning"])).category, "accessory");
    assert.equal(classifyProductCategory(shade("4-Sided Nail Care Buffer, 3 Pack", "Nail Art Accessory")).category, "accessory");
    assert.deepEqual(classifyProductCategory(shade("2025 Nail Lacquer Countdown Box Overpours", null)), { category: "accessory", evidence: "set" });
  });

  it("recognizes nippers, accessory and merch product types, nail tattoos and nail-art types", () => {
    // "Cuticle Nipper" is a tool, not a cuticle treatment.
    assert.equal(classifyProductCategory(shade("Le Nipper - Cuticle Nipper", "Accessories")).category, "accessory");
    assert.equal(classifyProductCategory(shade("Cuticle Nippers, Oil Slick", "Nail Art Accessory", ["kit", "tools"])).category, "accessory");
    assert.equal(classifyProductCategory(shade("Fairy-corn (Pin/Sticker)", "Nail Polish", ["merch", "pin"])).category, "accessory");
    assert.equal(classifyProductCategory(shade("Cracked Polish Tee", "Merch")).category, "accessory");
    assert.equal(classifyProductCategory(shade("Fa La La Nail Tattoos", "Nail Art")).category, "accessory");
    assert.equal(classifyProductCategory(shade("Legend Has It Aurora Powder", "Nail Art")).category, "accessory");
    // ...but "nail art" in a top coat's name under a care type is still a top coat.
    assert.equal(classifyProductCategory(shade("Nail Art No Smudge Top Coat", "Nail Care")).category, "top_coat");
  });
});

describe("lib/product-category — rules and precedence", () => {
  it("accessory wins over everything", () => {
    assert.equal(classifyProductCategory(shade("Topper Brush Kit", "Nail Tools", ["toppers"], ["topper"])).category, "accessory");
  });

  it("a topper finish or detected finish makes a topper", () => {
    assert.deepEqual(classifyProductCategory({ shadeName: "Stardust", finishes: ["glitter", "topper"] }), { category: "topper", evidence: "finish" });
    assert.equal(classifyProductCategory({ shadeName: "Stardust", detectedFinishes: ["topper"] }).category, "topper");
  });

  it("the word topper in the name is text evidence, in tags only tag evidence", () => {
    assert.equal(classifyProductCategory(shade("Confetti Topper", "Nail Polish")).evidence, "text");
    assert.equal(classifyProductCategory(shade("Confetti", "Nail Polish", ["toppers"])).evidence, "tag");
  });

  it("base coat beats top coat for 2-in-1 wording ('top and base coats')", () => {
    assert.equal(classifyProductCategory(shade("Two Step", "Nail Polish", ["top-and-base-coats"])).category, "base_coat");
  });

  it("coat wording in the name, title or type beats coat wording in the tags", () => {
    // Cirque tags every coat "Top & Base Coat".
    assert.deepEqual(classifyProductCategory(shade("Looking Glass Top Coat", "Nail Care", ["Top & Base Coat"])), {
      category: "top_coat",
      evidence: "text",
    });
    assert.equal(classifyProductCategory(shade("Get Ready Base Coat", "Base Coat", ["Top & Base Coat"])).category, "base_coat");
    assert.equal(classifyProductCategory(shade("Recovery Ritual Nail Strengthener", "Nail Care", ["Top & Base Coat"])).category, "treatment");
    assert.equal(classifyProductCategory(shade("Clear", "Nail Polish", ["Top & Base Coat"])).category, "base_coat");
  });

  it("recognizes top coats, base coats and treatments", () => {
    assert.equal(classifyProductCategory(shade("Glossy Top Coat", "Top Coat")).category, "top_coat");
    assert.equal(classifyProductCategory(shade("Seal the Deal", "Nail Polish", ["topcoat"])).category, "top_coat");
    assert.equal(classifyProductCategory(shade("Quick Dry Top", "Nail Polish")).category, "top_coat");
    assert.equal(classifyProductCategory(shade("Ridge Filler", "Nail Polish")).category, "base_coat");
    assert.equal(classifyProductCategory(shade("Bond Primer", "Nail Care")).category, "base_coat");
    assert.equal(classifyProductCategory(shade("Nail Strengthener", "Nail Care")).category, "treatment");
    assert.equal(classifyProductCategory(shade("Lavender Cuticle Oil", "Nail Care")).category, "treatment");
    assert.equal(classifyProductCategory(shade("Keratin Treatment", "Nail Care")).category, "treatment");
  });

  it("matches whole words only", () => {
    assert.equal(classifyProductCategory(shade("Profiles in Courage", "Nail Polish")).category, "color");
    assert.equal(classifyProductCategory(shade("Toolbelt Teal", "Nail Polish")).category, "color");
    assert.equal(classifyProductCategory(shade("Baseline Beige", "Nail Polish")).category, "color");
    assert.equal(classifyProductCategory(shade("Kitten Heels", "Nail Polish")).category, "color");
  });

  it("is case-insensitive and treats tag hyphens/underscores as spaces", () => {
    assert.equal(classifyProductCategory(shade("X", "NAIL POLISH", ["Base_Coat"])).category, "base_coat");
    assert.equal(classifyProductCategory(shade("X", "Nail Polish", ["TOP-COAT"])).category, "top_coat");
  });

  it("reads every linked source product", () => {
    const result = classifyProductCategory({
      shadeName: "Clear",
      products: [
        { title: "Clear", productType: "Nail Polish", tags: [] },
        { title: "Clear", productType: "Top Coat", tags: [] },
      ],
    });
    assert.equal(result.category, "top_coat");
  });

  it("defaults to color with no text at all", () => {
    assert.deepEqual(classifyProductCategory({}), { category: "color", evidence: null });
  });
});

describe("lib/product-category — classifyIngestedProduct (connector gate)", () => {
  const gate = (title, productType, tags = [], finishes = []) => classifyIngestedProduct({ title, productType, tags, finishes });

  it("accepts color polishes with a polish signal", () => {
    assert.deepEqual(gate("Litterbox", "Nail Polishes", ["finish:glitter"]), { accept: true, category: "color", evidence: null });
  });

  it("rejects products with no polish signal and no category evidence", () => {
    assert.equal(gate("Baggu Bag", "Baggu Bag").accept, false);
    assert.equal(gate("Mystery", null, ["nail"]).accept, false);
  });

  it("rejects accessories even with a polish signal", () => {
    assert.equal(gate("Nail Charm Set", "Nail Art", ["nail-polish"]).accept, false);
    assert.equal(gate("Witchy Stamping Plate", "Stamping Plates", ["polishes"]).accept, false);
    assert.equal(gate("Remover", "Nail Polish Removers").accept, false);
  });

  it("accepts coats and treatments without a polish signal (D-E)", () => {
    assert.deepEqual(gate("Quick-Dry Base", "Base Coat", ["base-coat"]), { accept: true, category: "base_coat", evidence: "text" });
    assert.equal(gate("Cuticle Oil", "Nail Care", ["cuticle-oil"]).category, "treatment");
    assert.equal(gate("Cuticle Oil", "Nail Care", ["cuticle-oil"]).accept, true);
    assert.equal(gate("Glossy", "Top Coat").accept, true);
  });

  it("keeps the June (#184) tag blocklist as a reject-only gate rule", () => {
    // A stamping-plate tag + a polish tag was rejected before; it still is. (Under a "Nail Art"
    // product type the nail-art type rule now decides first.)
    assert.equal(gate("Witchy Vibes", "Nail Art", ["stamping-plate", "nail-polish"]).accept, false);
    const result = gate("Witchy Vibes", "Nail Care", ["stamping-plate", "nail-polish"]);
    assert.equal(result.accept, false);
    assert.equal(result.category, "accessory");
    assert.equal(result.evidence, "legacy-tag");
    assert.equal(gate("Fun Set", "Nail Care", ["nail-kit", "nail-polish"]).accept, false);
    // ...but not for coat/treatment words, which are ingested now (D-E).
    assert.equal(gate("Bond Base", "Nail Polish", ["bond", "primer"]).accept, true);
    // ...and Holo Taco's magnetic-wand tag is not on it.
    assert.equal(gate("Holo Magnetic Taco", "Nail Polish", ["magnetic-wand", "nail-polish", "toppers"]).accept, true);
  });

  it("hasPolishSignal matches the legacy polish words in product type and tags only", () => {
    assert.equal(hasPolishSignal("Nail Lacquers", []), true);
    assert.equal(hasPolishSignal(null, ["nailpolish"]), true);
    assert.equal(hasPolishSignal("Polished Accessories", []), false);
    assert.equal(hasPolishSignal("Polishers", []), false);
  });
});

describe("lib/product-category — migration CHECK list", () => {
  it("matches PRODUCT_CATEGORIES in packages/shared", () => {
    const sql = fs.readFileSync(
      path.join(__dirname, "..", "migrations", "20261022190729000_shade-product-category.sql"),
      "utf8"
    );
    const match = sql.match(/CHECK \(product_category IN \(([^)]*)\)\)/);
    assert.ok(match, "CHECK constraint not found");
    const values = match[1].split(",").map((value) => value.trim().replace(/'/g, ""));
    assert.deepEqual(values, [...PRODUCT_CATEGORIES]);
  });
});
