const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  CANONICAL_FINISHES,
  isCanonicalFinish,
  resolvePolishFinishes,
  polishHasFinish,
} = require("swatchwatch-shared");
const {
  DEFAULT_FINISH_ALIASES,
  canonicalizeFinish,
  canonicalizeFinishes,
  parseFinishesFromTags,
  mergeFinishLists,
  resolveRequestedFinishes,
  requestCarriesFinishData,
} = require("../dist/lib/finishes");

const MIGRATIONS_DIR = path.resolve(__dirname, "../migrations");

function readMigration(name) {
  return fs.readFileSync(path.join(MIGRATIONS_DIR, name), "utf8");
}

/** Up-migration section only (before `-- Down Migration`). */
function upSection(sql) {
  const idx = sql.indexOf("-- Down Migration");
  return idx === -1 ? sql : sql.slice(0, idx);
}

/** Parse `INSERT INTO <table> (...) VALUES (...), (...) ON CONFLICT` tuples from SQL. */
function parseInsertTuples(sql, table) {
  const pattern = new RegExp(`INSERT INTO ${table} \\([^)]*\\) VALUES([\\s\\S]*?)ON CONFLICT`, "g");
  const tuples = [];
  let match;
  while ((match = pattern.exec(sql)) !== null) {
    const body = match[1];
    const tuplePattern = /\(\s*'((?:[^']|'')*)'\s*,\s*'((?:[^']|'')*)'(?:\s*,\s*'((?:[^']|'')*)'\s*,\s*(\d+))?\s*\)/g;
    let tuple;
    while ((tuple = tuplePattern.exec(body)) !== null) {
      tuples.push({
        first: tuple[1],
        second: tuple[2],
        sortOrder: tuple[4] ? Number(tuple[4]) : null,
      });
    }
  }
  return tuples;
}

// ═══════════════════════════════════════════════════════════════════════════
// Canonical list ↔ DB seed sync
// ═══════════════════════════════════════════════════════════════════════════

describe("canonical finish list — sync with finish_type seed", () => {
  it("matches the finish_type rows seeded by migration 005 (same names, sort_order order)", () => {
    const rows = parseInsertTuples(upSection(readMigration("005_seed_production_reference_data.sql")), "finish_type");
    assert.ok(rows.length > 0, "expected finish_type seed rows in 005");
    const seeded = rows
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((row) => row.first);
    assert.deepEqual([...CANONICAL_FINISHES], seeded);
  });

  it("covers every finish_type row backfilled by migration 018", () => {
    const rows = parseInsertTuples(upSection(readMigration("018_add_finish_normalizations.sql")), "finish_type");
    assert.ok(rows.length > 0, "expected finish_type rows in 018");
    for (const row of rows) {
      assert.ok(CANONICAL_FINISHES.includes(row.first), `${row.first} should be canonical`);
    }
  });

  it("matches the canonical VALUES list used by the 023 backfill", () => {
    const sql = upSection(readMigration("023_add_shade_finishes.sql"));
    const block = sql.slice(sql.indexOf("WITH canonical(name) AS"), sql.indexOf("legacy AS"));
    const names = [...block.matchAll(/\('([a-z]+)'\)/g)].map((m) => m[1]);
    assert.deepEqual(names, [...CANONICAL_FINISHES]);
  });

  it("DEFAULT_FINISH_ALIASES mirrors the finish_normalization seed rows (018 + 023)", () => {
    const seeded = [
      ...parseInsertTuples(upSection(readMigration("018_add_finish_normalizations.sql")), "finish_normalization"),
      ...parseInsertTuples(upSection(readMigration("023_add_shade_finishes.sql")), "finish_normalization"),
    ];
    const seededMap = Object.fromEntries(seeded.map((row) => [row.first, row.second]));
    assert.deepEqual({ ...DEFAULT_FINISH_ALIASES }, seededMap);
  });

  it("every alias target is a canonical finish", () => {
    for (const [source, target] of Object.entries(DEFAULT_FINISH_ALIASES)) {
      assert.ok(isCanonicalFinish(target), `${source} → ${target} should be canonical`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// canonicalizeFinish
// ═══════════════════════════════════════════════════════════════════════════

describe("lib/finishes — canonicalizeFinish", () => {
  it("returns canonical names unchanged and is case/whitespace-insensitive", () => {
    assert.equal(canonicalizeFinish("holographic"), "holographic");
    assert.equal(canonicalizeFinish("  Shimmer "), "shimmer");
    assert.equal(canonicalizeFinish("CREME"), "creme");
  });

  it("normalizes known aliases", () => {
    assert.equal(canonicalizeFinish("holo"), "holographic");
    assert.equal(canonicalizeFinish("HOLO "), "holographic");
    assert.equal(canonicalizeFinish("cream"), "creme");
    assert.equal(canonicalizeFinish("Crushed  Holo"), "holographic");
    assert.equal(canonicalizeFinish("linear_holo"), "holographic");
    assert.equal(canonicalizeFinish("Glow In The Dark"), "glow");
    assert.equal(canonicalizeFinish("flakie"), "flake");
  });

  it("returns null for unknown or non-string values", () => {
    assert.equal(canonicalizeFinish("iridescent"), null);
    assert.equal(canonicalizeFinish("velvet"), null);
    assert.equal(canonicalizeFinish(""), null);
    assert.equal(canonicalizeFinish("   "), null);
    assert.equal(canonicalizeFinish(null), null);
    assert.equal(canonicalizeFinish(42), null);
  });

  it("uses a caller-supplied (DB-backed) alias map", () => {
    const aliases = new Map([["iridescent", "duochrome"]]);
    assert.equal(canonicalizeFinish("Iridescent", aliases), "duochrome");
    // Canonical names still resolve without an alias row.
    assert.equal(canonicalizeFinish("matte", aliases), "matte");
    // Default aliases are not consulted when a custom map is supplied.
    assert.equal(canonicalizeFinish("holo", aliases), null);
  });

  it("ignores alias rows that point at a non-canonical finish_type", () => {
    const aliases = new Map([["suede", "velvet"]]);
    assert.equal(canonicalizeFinish("suede", aliases), null);
  });

  it("canonicalizeFinishes de-duplicates while preserving order", () => {
    assert.deepEqual(
      canonicalizeFinishes(["Shimmer", "holo", "holographic", "nope", "shimmer"]),
      ["shimmer", "holographic"]
    );
    assert.deepEqual(canonicalizeFinishes(null), []);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// parseFinishesFromTags
// ═══════════════════════════════════════════════════════════════════════════

describe("lib/finishes — parseFinishesFromTags", () => {
  it("resolves bare and finish:-prefixed tags identically", () => {
    assert.deepEqual(parseFinishesFromTags(["holographic"]), ["holographic"]);
    assert.deepEqual(parseFinishesFromTags(["finish:holographic"]), ["holographic"]);
    assert.deepEqual(parseFinishesFromTags(["shimmer"]), ["shimmer"]);
    assert.deepEqual(parseFinishesFromTags(["finish:shimmer"]), ["shimmer"]);
  });

  it("is case-insensitive and trims whitespace (prefix and value)", () => {
    assert.deepEqual(parseFinishesFromTags(["HOLO "]), ["holographic"]);
    assert.deepEqual(parseFinishesFromTags(["  Finish : Holographic  "]), ["holographic"]);
    assert.deepEqual(parseFinishesFromTags(["FINISH:SHIMMER"]), ["shimmer"]);
  });

  it("de-duplicates across formats and aliases", () => {
    assert.deepEqual(
      parseFinishesFromTags(["holographic", "finish:holographic", "HOLO ", "finish:holo", "holo"]),
      ["holographic"]
    );
  });

  it("supports multiple finishes per shade", () => {
    assert.deepEqual(parseFinishesFromTags(["finish:shimmer", "finish:holographic"]), [
      "shimmer",
      "holographic",
    ]);
  });

  it("ignores unknown values and tags in other namespaces", () => {
    assert.deepEqual(
      parseFinishesFromTags([
        "finish:iridescent",
        "polish",
        "nail-polish",
        "collection:holographic",
        "color:blue",
        "blue",
        "finish:",
        "",
      ]),
      []
    );
  });

  it("lists explicit finish: tags before bare tags", () => {
    assert.deepEqual(parseFinishesFromTags(["glitter", "finish:jelly", "creme"]), [
      "jelly",
      "glitter",
      "creme",
    ]);
  });

  it("handles non-array input and non-string entries", () => {
    assert.deepEqual(parseFinishesFromTags(undefined), []);
    assert.deepEqual(parseFinishesFromTags("holographic"), []);
    assert.deepEqual(parseFinishesFromTags([null, 3, { a: 1 }, "matte"]), ["matte"]);
  });

  it("honors a DB-backed alias map", () => {
    const aliases = new Map([["iridescent", "duochrome"]]);
    assert.deepEqual(parseFinishesFromTags(["finish:iridescent", "glitter"], aliases), [
      "duochrome",
      "glitter",
    ]);
  });

  it("parses real Holo Taco tag sets", () => {
    const tags = [
      "all-products",
      "collection:holographic",
      "collection:shimmer",
      "color:blue",
      "finish:holographic",
      "finish:shimmer",
      "flakes",
      "holographic",
      "nail-polish",
      "polish",
      "toppers",
    ];
    assert.deepEqual(parseFinishesFromTags(tags), ["holographic", "shimmer", "flake", "topper"]);
  });
});

describe("lib/finishes — mergeFinishLists", () => {
  it("keeps the existing order first and appends new canonical values", () => {
    assert.deepEqual(mergeFinishLists(["creme"], ["shimmer", "creme"], ["holo"]), [
      "creme",
      "shimmer",
      "holographic",
    ]);
    assert.deepEqual(mergeFinishLists(null, undefined), []);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// API request helpers + backward compatibility of `finish`
// ═══════════════════════════════════════════════════════════════════════════

describe("lib/finishes — resolveRequestedFinishes", () => {
  it("returns undefined when the request carries no finish information", () => {
    assert.equal(resolveRequestedFinishes({}), undefined);
    assert.equal(resolveRequestedFinishes({ tags: ["favorite"] }), undefined);
    assert.equal(requestCarriesFinishData({ quantity: 1 }), false);
    assert.equal(requestCarriesFinishData({ tags: ["x"] }), true);
  });

  it("treats a legacy single finish as a merge of [finish]", () => {
    assert.deepEqual(resolveRequestedFinishes({ finish: "creme" }), { mode: "merge", values: ["creme"] });
    assert.deepEqual(resolveRequestedFinishes({ finish: "cream" }), { mode: "merge", values: ["creme"] });
  });

  it("treats an explicit finishes array as a replace (empty array clears)", () => {
    assert.deepEqual(resolveRequestedFinishes({ finishes: ["shimmer", "holo", "bogus"] }), {
      mode: "replace",
      values: ["shimmer", "holographic"],
    });
    assert.deepEqual(resolveRequestedFinishes({ finishes: [] }), { mode: "replace", values: [] });
  });

  it("appends finishes parsed from tags after explicit values", () => {
    assert.deepEqual(
      resolveRequestedFinishes({ finish: "jelly", tags: ["finish:glitter", "favorite", "jelly"] }),
      { mode: "merge", values: ["jelly", "glitter"] }
    );
    assert.deepEqual(resolveRequestedFinishes({ tags: ["finish:holographic"] }), {
      mode: "merge",
      values: ["holographic"],
    });
  });
});

describe("shared — resolvePolishFinishes / polishHasFinish (backward compat)", () => {
  it("prefers the finishes array", () => {
    assert.deepEqual(resolvePolishFinishes({ finish: "creme", finishes: ["shimmer", "holographic"] }), [
      "shimmer",
      "holographic",
    ]);
  });

  it("falls back to the legacy single finish when finishes is missing or empty", () => {
    assert.deepEqual(resolvePolishFinishes({ finish: "creme" }), ["creme"]);
    assert.deepEqual(resolvePolishFinishes({ finish: "creme", finishes: [] }), ["creme"]);
    assert.deepEqual(resolvePolishFinishes({ finish: "" }), []);
    assert.deepEqual(resolvePolishFinishes({}), []);
  });

  it("polishHasFinish matches any of the finishes, case-insensitively", () => {
    const polish = { finish: "shimmer", finishes: ["shimmer", "holographic"] };
    assert.equal(polishHasFinish(polish, "holographic"), true);
    assert.equal(polishHasFinish(polish, "Shimmer"), true);
    assert.equal(polishHasFinish(polish, "creme"), false);
    assert.equal(polishHasFinish({ finish: "creme" }, "creme"), true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Connector extraction → canonical shade finishes
// ═══════════════════════════════════════════════════════════════════════════

describe("connectors — finish extraction from Shopify tags", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function stubShopifyFetch(products) {
    global.fetch = async (url) => {
      const page = new URL(url).searchParams.get("page");
      const body = JSON.stringify({ products: page === "1" ? products : [] });
      return { ok: true, status: 200, statusText: "OK", text: async () => body };
    };
  }

  it("HoloTacoShopify keeps raw finish: values as the legacy key and resolves canonical finishes from tags", async () => {
    const { HoloTacoShopifyConnector } = require("../dist/lib/connectors/holo-taco-shopify");
    const { resolveIngestedShadeFinishes } = require("../dist/lib/ingestion-repo");

    stubShopifyFetch([
      {
        id: 101,
        title: "Rainbow Road",
        handle: "rainbow-road",
        vendor: "Holo Taco",
        product_type: "Nail Polish",
        tags: ["nail-polish", "finish:Iridescent", "finish:holographic", "Shimmer", "collection:holographic"],
        images: [],
        variants: [],
      },
    ]);

    const connector = new HoloTacoShopifyConnector("https://example.test");
    const result = await connector.pullProducts({ searchTerm: "", page: 1, pageSize: 10, maxRecords: 10 });
    assert.equal(result.records.length, 1);
    const normalized = result.records[0].normalized;

    // Legacy identity key unchanged (raw first finish: value).
    assert.deepEqual(normalized.finishes, ["Iridescent", "holographic"]);
    // Canonical multi-finish list: unknown "Iridescent" dropped, bare "Shimmer" included.
    assert.deepEqual(resolveIngestedShadeFinishes(normalized), ["holographic", "shimmer"]);
  });

  it("ShopifyGeneric resolves canonical finishes from finish: and bare tags only", async () => {
    const { ShopifyGenericConnector } = require("../dist/lib/connectors/shopify-generic");
    const { resolveIngestedShadeFinishes } = require("../dist/lib/ingestion-repo");

    stubShopifyFetch([
      {
        id: 202,
        title: "Lagoon",
        handle: "lagoon",
        vendor: "Indie Brand",
        product_type: "Nail Polish",
        tags: ["nail-polish", "type:matte", "collection:summer", "FINISH:Holo", "jelly"],
        images: [],
        variants: [],
      },
    ]);

    const connector = new ShopifyGenericConnector("MooncatShopify", "https://indie.example.test");
    const result = await connector.pullProducts({ searchTerm: "", page: 1, pageSize: 10, maxRecords: 10 });
    assert.equal(result.records.length, 1);
    assert.deepEqual(resolveIngestedShadeFinishes(result.records[0].normalized), ["holographic", "jelly"]);
  });

  it("resolveIngestedShadeFinishes handles missing normalized data", () => {
    const { resolveIngestedShadeFinishes } = require("../dist/lib/ingestion-repo");
    assert.deepEqual(resolveIngestedShadeFinishes(null), []);
    assert.deepEqual(resolveIngestedShadeFinishes({}), []);
  });
});
