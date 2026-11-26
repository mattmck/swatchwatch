// Brand and shade-name fixes for five brand stores after their first ingestion runs (2026-11-10):
// China Glaze (vendor "CG", shouted titles), Le Mini Macaron (vendor "Le Mini Macaron Europe" /
// "Camelia Beauty", " - <line>" titles, gel and LED lines), Starrily ("<Shade> By Kelli Marissa"
// under vendor "Starrily Kelli Marissa", finish notes), Lights Lacquer (vendor "lightslacquer.com")
// and Cracked Polish ("Truly Outrageous Topper"). Hand-made fixtures shaped like the stored raw_json.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const { ShopifyGenericConnector } = require("../dist/lib/connectors/shopify-generic");
const { SHOPIFY_STORE_PRODUCT_FILTERS } = require("../dist/lib/connectors/store-filters");
const { SHOPIFY_STORE_TITLE_PARSERS } = require("../dist/lib/connectors/shopify-title");
const { readSourceSettings } = require("../dist/lib/source-settings");
const {
  isChinaGlazePolish,
  parseChinaGlazeTitle,
  titleCaseShoutedWords,
} = require("../dist/lib/connectors/store-filters/china-glaze");
const {
  isLeMiniMacaronPolish,
  parseLeMiniMacaronTitle,
  parseLeMiniMacaronTitleParts,
} = require("../dist/lib/connectors/store-filters/le-mini-macaron");
const { parseStarrilyTitle } = require("../dist/lib/connectors/store-filters/starrily");
const { parseCrackedPolishTitle } = require("../dist/lib/connectors/store-filters/cracked-polish");

const REPO_ROOT = resolve(__dirname, "../../..");
const SEED_SQL = readFileSync(resolve(REPO_ROOT, "docs/seed_data_sources.sql"), "utf8");
const MIGRATION_FILE = "20261110140000000_brand-store-vendor-aliases.sql";
const MIGRATION = readFileSync(resolve(__dirname, "../migrations", MIGRATION_FILE), "utf8");
const MIGRATION_ID = MIGRATION_FILE.split("_")[0];

/** The seeded `data_source.metadata` of `name`. */
function seedMetadata(name) {
  const start = SEED_SQL.indexOf(`'${name}',`);
  assert.notEqual(start, -1, `${name} not seeded`);
  const tuple = SEED_SQL.slice(start, SEED_SQL.indexOf("::jsonb", start));
  const literal = tuple.slice(tuple.indexOf("'{"), tuple.lastIndexOf("}'") + 1);
  return JSON.parse(literal.slice(1).replace(/''/g, "'"));
}

let nextId = 1;
function product(vendor, title, productType, tags = []) {
  const id = nextId++;
  return {
    id,
    title,
    vendor,
    product_type: productType,
    tags,
    handle: `p-${id}`,
    body_html: "",
    options: [{ name: "Title", values: ["Default Title"] }],
    variants: [{ id: id * 10, title: "Default Title", price: "10.00", available: true }],
    images: [],
  };
}

/** Runs the connector over `products` with the source's seeded settings (offline: no AI, no fetch). */
async function pull(source, products, metadata = seedMetadata(source)) {
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
    const connector = new ShopifyGenericConnector(source, null, { currency: "USD", settings });
    const result = await connector.pullProducts({ searchTerm: "", page: 1, pageSize: 500, maxRecords: 500 });
    return result.records;
  } finally {
    globalThis.fetch = originalFetch;
    if (originalEndpoint !== undefined) process.env.AZURE_OPENAI_ENDPOINT = originalEndpoint;
  }
}

const byRawTitle = (records) => Object.fromEntries(records.map((record) => [record.normalized.rawTitle, record.normalized]));

describe("China Glaze: vendor CG is China Glaze, shouted names are title-cased", () => {
  it("title-cases every all-caps word, keeping apostrophes and known acronyms", () => {
    const cases = {
      ALPENGLOW: "Alpenglow",
      "LEFT MY HEART IN HAVANA": "Left My Heart In Havana",
      "CRUSHIN' ON BLUE": "Crushin' On Blue",
      "GIVE ME S'MORE": "Give Me S'more",
      "TROPIC LIKE IT'S HOT": "Tropic Like It's Hot",
      "XOXO, YOU'RE IT": "XOXO, You're It",
      "DM FOR DRAMA": "DM For Drama",
      "IRL SPARKLE": "IRL Sparkle",
      "CHALK ME UP!": "Chalk Me Up!",
      "FLAME-BOYANT": "Flame-boyant",
      "SUN-SET THE MOOD": "Sun-set The Mood",
      "A WALTZ IN THE PARK": "A Waltz In The Park",
      "FAST FORWARD TOP COAT": "Fast Forward Top Coat",
    };
    for (const [title, expected] of Object.entries(cases)) {
      assert.equal(parseChinaGlazeTitle({ title, vendor: "CG" }), expected, title);
    }
  });

  it("leaves mixed-case words alone and keeps a title with nothing to change", () => {
    assert.equal(titleCaseShoutedWords("McLove BUG"), "McLove Bug");
    assert.equal(parseChinaGlazeTitle({ title: "Eco Glaze Nail Lacquer, Basecoat", vendor: "China Glaze" }), null);
    assert.equal(parseChinaGlazeTitle({ title: "", vendor: "CG" }), null);
  });

  it("keeps China Glaze's own vendors for the generic gate and drops other brands' products", () => {
    assert.equal(isChinaGlazePolish({ vendor: "CG", title: "ALPENGLOW", product_type: "Nail Lacquers" }), null);
    assert.equal(isChinaGlazePolish({ vendor: "China Glaze", title: "Eco Glaze Nail Lacquer, Basecoat" }), null);
    assert.equal(isChinaGlazePolish({ vendor: "Flowery", title: "Flowery Cuticle Butter" }), false);
    assert.equal(SHOPIFY_STORE_PRODUCT_FILTERS.ChinaGlazeShopify, isChinaGlazePolish);
    assert.equal(SHOPIFY_STORE_TITLE_PARSERS.ChinaGlazeShopify, parseChinaGlazeTitle);
  });

  it("ingests CG products as China Glaze with title-cased names", async () => {
    const records = byRawTitle(
      await pull("ChinaGlazeShopify", [
        product("CG", "ALPENGLOW", "Nail Lacquers", ["hazardous"]),
        product("CG", "LEFT MY HEART IN HAVANA", "Nail Lacquers"),
        product("CG", "STRONG ADHESION BASE COAT", "Nail Lacquers"),
        product("China Glaze", "Eco Glaze Nail Lacquer, Basecoat", "", ["LC"]),
        product("Flowery", "Flowery Lily Scented Cuticle Oil", ""),
      ])
    );
    assert.deepEqual(Object.keys(records).sort(), [
      "ALPENGLOW",
      "Eco Glaze Nail Lacquer, Basecoat",
      "LEFT MY HEART IN HAVANA",
      "STRONG ADHESION BASE COAT",
    ]);
    for (const record of Object.values(records)) assert.equal(record.brand, "China Glaze");
    assert.equal(records.ALPENGLOW.name, "Alpenglow");
    assert.equal(records["LEFT MY HEART IN HAVANA"].name, "Left My Heart In Havana");
    assert.equal(records["STRONG ADHESION BASE COAT"].productCategory, "base_coat");
  });
});

describe("Le Mini Macaron: one brand, shade name before the line, no gel or LED", () => {
  it("splits '<Shade> - <line>' for the polish lines only", () => {
    assert.deepEqual(parseLeMiniMacaronTitleParts({ title: "Fleur Bleue - Quick Dry Nail Polish" }), {
      name: "Fleur Bleue",
      productLine: "Quick Dry Nail Polish",
    });
    assert.deepEqual(parseLeMiniMacaronTitleParts({ title: "Pearlescence  - Quick Dry Nail Polish" }), {
      name: "Pearlescence",
      productLine: "Quick Dry Nail Polish",
    });
    assert.equal(parseLeMiniMacaronTitle({ title: "Lilac Blossom - LED Polish" }), "Lilac Blossom");
    assert.equal(parseLeMiniMacaronTitle({ title: "Lily Rose - Gel Polish" }), "Lily Rose");
    assert.equal(parseLeMiniMacaronTitle({ title: "Lavender Haze - Cat Eye Gel Polish" }), "Lavender Haze");
    // A coat or care product's dash is not a shade line.
    assert.equal(parseLeMiniMacaronTitle({ title: "Le Sweet - Matte Top Coat" }), null);
    assert.equal(parseLeMiniMacaronTitle({ title: "Le Sweet - Base Coat" }), null);
    assert.equal(parseLeMiniMacaronTitle({ title: "Rosé Kiss - Nail & Cuticle Oil" }), null);
    assert.equal(parseLeMiniMacaronTitle({ title: "Nail Strengthener" }), null);
    assert.equal(SHOPIFY_STORE_TITLE_PARSERS.LeMiniMacaronShopify, parseLeMiniMacaronTitle);
  });

  it("drops gel and LED product types unless the source sets includeGel; defers everything else", () => {
    for (const type of ["Individual Gel Polish", "Builder Gel", "Gel Top Coat", "Gel Base Coat", "LED Nail Polish", "LED Top Coat", "LED Base Coat"]) {
      assert.equal(isLeMiniMacaronPolish({ product_type: type, title: "X - Gel Polish" }), false, type);
      assert.equal(isLeMiniMacaronPolish({ product_type: type, title: "X - Gel Polish" }, { includeGel: true }), null, type);
    }
    for (const type of ["Nail Polish Color", "Nail Polish Top Coat", "Nail Polish Base Coat", "Nail & Hand Care", "Nail Prep"]) {
      assert.equal(isLeMiniMacaronPolish({ product_type: type, title: "Rescue Moi - After Gel Nail Recovery" }), null, type);
    }
    assert.equal(SHOPIFY_STORE_PRODUCT_FILTERS.LeMiniMacaronShopify, isLeMiniMacaronPolish);
  });

  it("ingests the lacquers as Le Mini Macaron with the line kept as productLine", async () => {
    const records = byRawTitle(
      await pull("LeMiniMacaronShopify", [
        product("Le Mini Macaron Europe", "Fleur Bleue - Quick Dry Nail Polish", "Nail Polish Color"),
        product("Le Mini Macaron Europe", "Latte - Quick Dry Nail Polish", "Nail Polish Color"),
        product("Le Mini Macaron Europe", "Le Sweet - Top Coat", "Nail Polish Top Coat"),
        product("Le Mini Macaron Europe", "Lily Rose - Gel Polish", "Individual Gel Polish"),
        product("Le Mini Macaron Europe", "Lilac Blossom - LED Polish", "LED Nail Polish"),
        product("Camelia Beauty", "Black Sesame - Gel Polish", "Individual Gel Polish"),
      ])
    );
    assert.deepEqual(Object.keys(records).sort(), [
      "Fleur Bleue - Quick Dry Nail Polish",
      "Latte - Quick Dry Nail Polish",
      "Le Sweet - Top Coat",
    ]);
    for (const record of Object.values(records)) assert.equal(record.brand, "Le Mini Macaron");
    assert.equal(records["Fleur Bleue - Quick Dry Nail Polish"].name, "Fleur Bleue");
    assert.equal(records["Fleur Bleue - Quick Dry Nail Polish"].productLine, "Quick Dry Nail Polish");
    assert.equal(records["Latte - Quick Dry Nail Polish"].name, "Latte");
    assert.equal(records["Le Sweet - Top Coat"].name, "Le Sweet - Top Coat");
    assert.equal("productLine" in records["Le Sweet - Top Coat"], false);
  });

  it("with includeGel the gel shades come through as Le Mini Macaron too", async () => {
    const metadata = { ...seedMetadata("LeMiniMacaronShopify"), includeGel: true };
    const records = byRawTitle(
      await pull("LeMiniMacaronShopify", [product("Camelia Beauty", "Black Sesame - Gel Polish", "Individual Gel Polish")], metadata)
    );
    assert.equal(records["Black Sesame - Gel Polish"].brand, "Le Mini Macaron");
    assert.equal(records["Black Sesame - Gel Polish"].name, "Black Sesame");
    assert.equal(records["Black Sesame - Gel Polish"].productLine, "Gel Polish");
  });
});

describe("Starrily: collaborations are Starrily shades, finish notes leave the name", () => {
  const km = (title) => ({ title, vendor: "Starrily Kelli Marissa" });
  const own = (title) => ({ title, vendor: "Starrily" });

  it("drops ' By <collaborator>' when the vendor names that collaborator", () => {
    assert.equal(parseStarrilyTitle(km("Callisto By Kelli Marissa")), "Callisto");
    assert.equal(parseStarrilyTitle(km("Diamond Rain by Kelli Marissa")), "Diamond Rain");
    assert.equal(parseStarrilyTitle(km("The Crab By Kelli Marissa")), "The Crab");
    // Not the vendor's collaborator: kept.
    assert.equal(parseStarrilyTitle(own("Stand By Me")), null);
  });

  it("drops trailing finish and edition notes, a ' | ' description and trademark signs", () => {
    const cases = {
      "Catnip - Shimmer": "Catnip",
      "Cat Eyes - Linear Holographic": "Cat Eyes",
      "Frozen - Limited Edition": "Frozen",
      "Earth - Galaxy Edition": "Earth",
      "King Midas - Holographic Glitter": "King Midas",
      "Love Affair - Color Shifting": "Love Affair",
      "Moon Beam - Holodescent™": "Moon Beam",
      "Raven - Multichrome": "Raven",
      "Pegasus - Purple Foil": "Pegasus",
      "Magma - Magnetic Top Coat": "Magma",
      "Stars - Limited Availability - Holographic Top Coat": "Stars",
      "Antimatter™ | All Purpose Gloss": "Antimatter",
      "Speed of Light: Flash | Quick Dry Top": "Speed of Light: Flash",
      "Death Wish™": "Death Wish",
      "Vantablack®": "Vantablack",
    };
    for (const [title, expected] of Object.entries(cases)) assert.equal(parseStarrilyTitle(own(title)), expected, title);
    for (const title of ["Hera", "Moonflower", "Dark Music", "Orion's Belt", "E=mc^2", "3.14K Gold"]) {
      assert.equal(parseStarrilyTitle(own(title)), null, title);
    }
    assert.equal(SHOPIFY_STORE_TITLE_PARSERS.StarrilyShopify, parseStarrilyTitle);
  });

  it("ingests the collaboration under Starrily", async () => {
    const records = byRawTitle(
      await pull("StarrilyShopify", [
        product("Starrily Kelli Marissa", "Callisto By Kelli Marissa", "Nail Polish", ["flakes", "topper"]),
        product("Starrily", "Hera", "Nail Polish"),
        product("Starrily", "Moonflower", "Nail Polish"),
        product("Starrily", "Dark Music", "Nail Polish"),
      ])
    );
    for (const record of Object.values(records)) assert.equal(record.brand, "Starrily");
    assert.equal(records["Callisto By Kelli Marissa"].name, "Callisto");
    assert.equal(records.Hera.name, "Hera");
    assert.equal(records.Moonflower.name, "Moonflower");
    assert.equal(records["Dark Music"].name, "Dark Music");
  });
});

describe("Lights Lacquer: vendor lightslacquer.com is Lights Lacquer", () => {
  it("ingests the product under Lights Lacquer", async () => {
    const records = byRawTitle(
      await pull("LightsLacquerShopify", [
        product("lightslacquer.com", "Mama Lights", "Nail Polishes"),
        product("Lights Lacquer", "Cara Mia", "Nail Polish"),
      ])
    );
    assert.equal(records["Mama Lights"].brand, "Lights Lacquer");
    assert.equal(records["Cara Mia"].brand, "Lights Lacquer");
  });
});

describe("Cracked Polish: the sticker name, without a type word or box code", () => {
  it("drops a trailing ' Topper', ' HHC' or ' LBOH'", () => {
    assert.equal(parseCrackedPolishTitle({ title: "Truly Outrageous Topper" }), "Truly Outrageous");
    assert.equal(parseCrackedPolishTitle({ title: "Guided Light HHC" }), "Guided Light");
    assert.equal(parseCrackedPolishTitle({ title: "Bug Splat LBOH" }), "Bug Splat");
    for (const title of ["Topper", "Ridge Filler", "Pinching Bronzed Pennies (old)", "MUSTAAARD!", "Thanks For The Mammaries BCA Box"]) {
      assert.equal(parseCrackedPolishTitle({ title }), null, title);
    }
    assert.equal(SHOPIFY_STORE_TITLE_PARSERS.CrackedPolishShopify, parseCrackedPolishTitle);
  });

  it("keeps the topper category from the raw title", async () => {
    const records = byRawTitle(
      await pull("CrackedPolishShopify", [product("Cracked Polish", "Truly Outrageous Topper", "Nail Polish", ["Glitter"])])
    );
    assert.equal(records["Truly Outrageous Topper"].name, "Truly Outrageous");
    assert.equal(records["Truly Outrageous Topper"].productCategory, "topper");
  });
});

describe(`migration ${MIGRATION_FILE} (vendor aliases)`, () => {
  const EXPECTED = {
    ChinaGlazeShopify: { CG: "China Glaze" },
    LeMiniMacaronShopify: { "Le Mini Macaron Europe": "Le Mini Macaron", "Camelia Beauty": "Le Mini Macaron" },
    StarrilyShopify: { "Starrily Kelli Marissa": "Starrily" },
    LightsLacquerShopify: { "lightslacquer.com": "Lights Lacquer" },
  };
  const at = MIGRATION.search(/^\s*--[\s-]*down\s+migration/im);
  const UP = MIGRATION.slice(0, at).replace(/^\s*--.*$/gm, "");
  const DOWN = MIGRATION.slice(at).replace(/^\s*--.*$/gm, "");
  const updates = (sql) => sql.match(/UPDATE data_source[\s\S]*?;$/gm) ?? [];

  it("runs after the last migration and has a Down section", () => {
    assert.ok(MIGRATION_ID > "20261110130000000");
    assert.ok(at > 0);
    assert.match(MIGRATION_FILE, /^\d{17}_[a-z0-9-]+\.sql$/);
  });

  for (const [name, aliases] of Object.entries(EXPECTED)) {
    it(`${name}: Up sets the aliases only on a row without any and stamps it; the seed matches`, () => {
      const statements = updates(UP).filter((statement) => statement.includes(`'${name}'`));
      assert.equal(statements.length, 1);
      const [statement] = statements;
      assert.match(statement, new RegExp(`'vendorAliasesByMigration', '${MIGRATION_ID}'`));
      assert.match(statement, /NOT \(COALESCE\(metadata, '\{\}'::jsonb\) \? 'vendorAliases'\)/);
      const literals = [...statement.matchAll(/'(\{(?:[^']|'')*\})'::jsonb/g)]
        .map((match) => JSON.parse(match[1].replace(/''/g, "'")))
        .filter((value) => Object.keys(value).length > 0);
      assert.equal(literals.length, 1, "one aliases literal");
      assert.deepEqual(literals[0], aliases);
      assert.deepEqual(seedMetadata(name).vendorAliases, aliases);
      assert.deepEqual(readSourceSettings(seedMetadata(name), name).vendorAliases, Object.fromEntries(
        Object.entries(aliases).map(([vendor, brand]) => [vendor.toLowerCase(), brand])
      ));
    });
  }

  it("Down removes the aliases and the stamp only where Up stamped them", () => {
    const statements = updates(DOWN);
    assert.equal(statements.length, 1);
    assert.match(statements[0], /- 'vendorAliases' - 'vendorAliasesByMigration'/);
    assert.match(statements[0], new RegExp(`metadata->>'vendorAliasesByMigration' = '${MIGRATION_ID}'`));
    assert.doesNotMatch(UP, /INSERT|DELETE|shade/i);
    assert.equal(updates(UP).length, Object.keys(EXPECTED).length);
  });
});
