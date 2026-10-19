const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  planProductCategoryBackfill,
  runProductCategoryBackfill,
} = require("../dist/lib/product-category-backfill");
const { parseBackfillBody } = require("../dist/functions/admin-product-category");

let nextId = 1;
function row(name, productType, tags = [], overrides = {}) {
  return {
    shadeId: nextId++,
    brand: "Holo Taco",
    name,
    colorName: name,
    status: "active",
    finishes: [],
    detectedFinishes: null,
    productCategory: "color",
    productCategorySource: "rule",
    vendorHex: null,
    detectedHex: null,
    detectedHexConfidence: null,
    detectedHexMethod: null,
    detectedHexModel: null,
    detectedHexPromptVersion: null,
    detectedHexAt: null,
    detectedHexFamily: null,
    vendorVsDetected: null,
    holders: "0",
    products: [{ dataSource: "HoloTacoShopify", title: name, productType, tags }],
    ...overrides,
  };
}

const DRY = { dryRun: true, clearTopperDetectedHex: false };

describe("lib/product-category-backfill — planProductCategoryBackfill", () => {
  it("plans category changes from the rule and counts per category and source", () => {
    const rows = [
      row("Sticky Base", "Nail Polish", ["base-coat", "nail-polish"]),
      row("Blue Flakie Holo Taco", "Top Coat", ["top-coat", "toppers"], { finishes: ["flake"] }),
      row("Mermaid Lagoon", "Nail Polish", ["nail-polish"]),
    ];
    const { report, categoryChanges } = planProductCategoryBackfill(rows, DRY);
    assert.equal(report.scannedShades, 3);
    assert.deepEqual(
      categoryChanges.map((change) => [change.from, change.to]),
      [["color", "base_coat"], ["color", "topper"]]
    );
    assert.equal(report.byCategory.color.shades, 1);
    assert.equal(report.byCategory.base_coat.shades, 1);
    assert.equal(report.byCategory.topper.shades, 1);
    assert.deepEqual(
      report.byDataSource.map((bucket) => [bucket.dataSource, bucket.category, bucket.shades]).sort(),
      [["HoloTacoShopify", "base_coat", 1], ["HoloTacoShopify", "topper", 1]]
    );
    assert.deepEqual(report.topperByTagOnly.map((shade) => shade.name), ["Blue Flakie Holo Taco"]);
    assert.equal(report.applied.category, 0);
  });

  it("never changes an admin category, and reports the disagreement", () => {
    const rows = [row("Quick-Dry Base", "Base Coat", ["base-coat"], { productCategory: "color", productCategorySource: "admin" })];
    const { report, categoryChanges } = planProductCategoryBackfill(rows, DRY);
    assert.equal(categoryChanges.length, 0);
    assert.equal(report.adminDisagreements.length, 1);
    assert.equal(report.byCategory.color.shades, 1);
    assert.deepEqual(report.byCategorySource, [{ category: "color", source: "admin", shades: 1 }]);
  });

  it("excludes accessories nobody holds and lists held ones for review", () => {
    const rows = [
      row("Boundary Pusher", "Cuticle Pushers", ["nail-tool"]),
      row("Magnetic Wand", "Nail Tools", ["magnetic-wand"], { holders: "2" }),
      row("Velvet Effect Horseshoe Magnet", "Nail Tools", [], { status: "user_submitted" }),
    ];
    const { report, exclusions } = planProductCategoryBackfill(rows, DRY);
    assert.deepEqual(report.excluded.map((shade) => shade.name), ["Boundary Pusher"]);
    assert.equal(exclusions.length, 1);
    assert.deepEqual(report.heldAccessories.map((shade) => [shade.name, shade.holders]), [["Magnetic Wand", 2]]);
    assert.equal(report.byCategory.accessory.shades, 3);
    assert.equal(report.byCategory.accessory.active, 1, "only the held active accessory stays active");
    assert.equal(report.byCategory.accessory.held, 1);
  });

  it("lists suspicious topper hexes but plans clears only with the flag", () => {
    const rows = [
      // Far from the vendor hex.
      row("Freezer Burn", "Nail Polish", ["toppers"], { vendorHex: "#E8E8F0", detectedHex: "#2040C0", vendorVsDetected: "0.31", detectedHexMethod: "vision-direct", detectedHexFamily: "blue" }),
      // No vendor hex and a saturated detected hex.
      row("Halogen Glow", "Nail Polish", ["toppers"], { detectedHex: "#C02020", detectedHexFamily: "red" }),
      // Plausible: near white without a vendor hex.
      row("Aura", "Nail Polishes", [], { finishes: ["topper"], detectedHex: "#F4F2F0", detectedHexFamily: "white" }),
      // A color polish is never a candidate.
      row("Red Alert", "Nail Polish", [], { detectedHex: "#C02020", detectedHexFamily: "red" }),
    ];
    const dry = planProductCategoryBackfill(rows, DRY);
    assert.deepEqual(dry.report.topperHexCandidates.map((shade) => shade.name), ["Freezer Burn", "Halogen Glow"]);
    assert.equal(dry.hexClears.length, 0);

    const withFlag = planProductCategoryBackfill(rows, { dryRun: true, clearTopperDetectedHex: true });
    assert.equal(withFlag.hexClears.length, 2);
    assert.equal(withFlag.hexClears[0].before.detectedHex, "#2040C0");
    assert.equal(withFlag.hexClears[0].before.detectedHexMethod, "vision-direct");
  });
});

describe("lib/product-category-backfill — runProductCategoryBackfill", () => {
  function fakeDb(rows) {
    const writes = [];
    const client = {
      query: async (sql, params = []) => {
        writes.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
        return { rows: [], rowCount: 1 };
      },
    };
    return {
      writes,
      deps: {
        query: async () => ({ rows }),
        transaction: async (work) => work(client),
      },
    };
  }

  it("writes nothing on a dry run", async () => {
    const db = fakeDb([row("Sticky Base", "Nail Polish", ["base-coat"]), row("Boundary Pusher", "Cuticle Pushers")]);
    const report = await runProductCategoryBackfill(db.deps, { ...DRY, actorUserId: 7 });
    assert.equal(db.writes.length, 0);
    assert.equal(report.runId, null);
    assert.equal(report.categoryChanges.length, 2);
  });

  it("applies with guards and records every change under one run id", async () => {
    const db = fakeDb([
      row("Sticky Base", "Nail Polish", ["base-coat"]),
      row("Boundary Pusher", "Cuticle Pushers"),
      row("Freezer Burn", "Nail Polish", ["toppers"], { detectedHex: "#2040C0", detectedHexFamily: "blue" }),
    ]);
    const report = await runProductCategoryBackfill(db.deps, { dryRun: false, clearTopperDetectedHex: true, actorUserId: 7 });
    assert.match(report.runId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(report.applied, { category: 3, exclude: 1, clearDetectedHex: 1 });
    const updates = db.writes.filter((write) => write.sql.startsWith("UPDATE shade"));
    const categoryUpdates = updates.filter((write) => write.sql.includes("SET product_category"));
    assert.equal(categoryUpdates.length, 3);
    assert.ok(categoryUpdates.every((write) => write.sql.includes("product_category_source <> 'admin'")), "admin categories are re-checked");
    assert.ok(updates.some((write) => write.sql.includes("NOT EXISTS (SELECT 1 FROM user_inventory_item")), "exclusion re-checks holders");
    const logs = db.writes.filter((write) => write.sql.startsWith("INSERT INTO shade_category_change"));
    assert.equal(logs.length, 5);
    assert.ok(logs.every((write) => write.params.includes(report.runId)));
    const hexLog = logs.find((write) => write.sql.includes("'clear_detected_hex'"));
    assert.equal(JSON.parse(hexLog.params[1]).detectedHex, "#2040C0");
  });
});

describe("functions/admin-product-category — parseBackfillBody", () => {
  it("defaults to a dry run without hex clearing", () => {
    assert.deepEqual(parseBackfillBody({}), { dryRun: true, clearTopperDetectedHex: false });
  });
  it("rejects non-boolean flags", () => {
    assert.equal(typeof parseBackfillBody({ dryRun: "no" }), "string");
    assert.equal(typeof parseBackfillBody({ clearTopperDetectedHex: 1 }), "string");
  });
});
