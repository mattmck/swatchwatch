/**
 * Brand-store shade correction (lib/brand-store-correction.ts): a brand store's re-run moves,
 * renames or merges the shade an earlier run filed under a vendor spelling or raw title.
 * Pure planner tests, then the materializer end to end on a fake `pg` client keyed on SQL text
 * (as in ingestion-repo-adopt-existing.unit.test.cjs), with `mergeShadeInto` replaced by a fake
 * that moves holders and listings the way the real one does.
 */
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

delete process.env.AZURE_STORAGE_CONNECTION;

function mockDistModule(relativePath, exports) {
  const resolved = path.resolve(__dirname, "../dist/lib", relativePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// mergeShadeInto is replaced before any module that imports lib/shade-review loads.
let mergeImpl = async () => {
  throw new Error("mergeShadeInto not expected");
};
mockDistModule("shade-review.js", { mergeShadeInto: (...args) => mergeImpl(...args) });

// ---------------------------------------------------------------------------
// Pure planner
// ---------------------------------------------------------------------------

const {
  planBrandStoreCorrection,
  correctionAliases,
  correctionNameKey,
} = require("../dist/lib/brand-store-correction");

function shadeState(extra = {}) {
  return {
    shadeId: 1,
    brandId: 167,
    brand: "CG",
    name: "ALPENGLOW",
    status: "active",
    mergedIntoShadeId: null,
    productLineId: null,
    productCategory: "color",
    userShade: false,
    adminEdit: false,
    otherBrandListing: false,
    ...extra,
  };
}
const CHINA_GLAZE = { brandId: 7, brand: "China Glaze", name: "Alpenglow", finish: null, collection: null };
function candidate(shadeId, extra = {}) {
  return {
    shadeId,
    name: "Alpenglow",
    status: "active",
    finish: null,
    collection: null,
    catalogAuthority: "retailer",
    productCategory: "color",
    brandListed: false,
    otherBrandListing: false,
    finishesFit: true,
    ...extra,
  };
}

describe("planBrandStoreCorrection", () => {
  it("does nothing when brand and name already match", () => {
    assert.deepEqual(
      planBrandStoreCorrection(shadeState({ brandId: 7, name: "Alpenglow" }), CHINA_GLAZE, []),
      { action: "none" }
    );
  });

  it("moves to the record's brand and renames when the brand has no same-name shade", () => {
    assert.deepEqual(planBrandStoreCorrection(shadeState(), CHINA_GLAZE, []), {
      action: "move",
      brandChanged: true,
      renamed: true,
    });
  });

  it("renames in place when the names differ only in case", () => {
    assert.deepEqual(planBrandStoreCorrection(shadeState({ brandId: 7 }), CHINA_GLAZE, [candidate(9)]), {
      action: "move",
      brandChanged: false,
      renamed: true,
    });
  });

  it("merges into the one exact identity match, else the one adoptable retailer shade", () => {
    assert.deepEqual(planBrandStoreCorrection(shadeState(), CHINA_GLAZE, [candidate(9)]), {
      action: "merge",
      targetShadeId: 9,
      targetName: "Alpenglow",
      via: "identity",
    });
    const record = { ...CHINA_GLAZE, finish: "creme" };
    assert.deepEqual(planBrandStoreCorrection(shadeState(), record, [candidate(9)]), {
      action: "merge",
      targetShadeId: 9,
      targetName: "Alpenglow",
      via: "retailer",
    });
  });

  it("skips several matches, a seeded same-name shade of another identity, and an excluded or foreign target", () => {
    assert.equal(planBrandStoreCorrection(shadeState(), CHINA_GLAZE, [candidate(9), candidate(10)]).reason, "ambiguous_target");
    const seed = candidate(11, { catalogAuthority: "brand_store", finish: "glitter", collection: "Holiday Joy" });
    assert.deepEqual(planBrandStoreCorrection(shadeState(), CHINA_GLAZE, [seed]), {
      action: "skip",
      reason: "same_name_not_identity",
      candidateShadeIds: [11],
    });
    assert.equal(planBrandStoreCorrection(shadeState(), CHINA_GLAZE, [candidate(9, { status: "excluded" })]).reason, "target_not_active");
    assert.equal(
      planBrandStoreCorrection(shadeState(), CHINA_GLAZE, [candidate(9, { otherBrandListing: true })]).reason,
      "target_other_brand_source"
    );
    assert.equal(
      planBrandStoreCorrection(shadeState(), CHINA_GLAZE, [candidate(9, { catalogAuthority: "brand_store", productCategory: "topper" })]).reason,
      "category_mismatch"
    );
    // A retailer shade with unfit finishes or a brand listing is no adoption candidate.
    const record = { ...CHINA_GLAZE, finish: "creme" };
    assert.equal(planBrandStoreCorrection(shadeState(), record, [candidate(9, { finishesFit: false })]).reason, "same_name_not_identity");
    assert.equal(planBrandStoreCorrection(shadeState(), record, [candidate(9, { brandListed: true })]).reason, "same_name_not_identity");
  });

  it("never touches a user, approved, admin-edited or merged shade, nor one another brand store lists", () => {
    for (const extra of [{ userShade: true }, { adminEdit: true }, { mergedIntoShadeId: 4 }, { status: "user_submitted" }, { productLineId: 3 }]) {
      assert.deepEqual(planBrandStoreCorrection(shadeState(extra), CHINA_GLAZE, []), {
        action: "skip",
        reason: "protected",
        candidateShadeIds: [],
      });
    }
    assert.equal(planBrandStoreCorrection(shadeState({ otherBrandListing: true }), CHINA_GLAZE, []).reason, "other_brand_source");
  });

  it("keeps the old name and raw title as aliases unless only the case differs", () => {
    assert.deepEqual(correctionAliases("Alpenglow", ["ALPENGLOW", "ALPENGLOW"]), []);
    assert.deepEqual(correctionAliases("Fleur Bleue", ["Fleur Bleue - Quick Dry Nail Polish", "Fleur Bleue - Quick Dry Nail Polish"]), [
      "Fleur Bleue - Quick Dry Nail Polish",
    ]);
    assert.equal(correctionNameKey("  Crushin'  On Blue "), "crushin' on blue");
  });
});

// ---------------------------------------------------------------------------
// Materializer end to end
// ---------------------------------------------------------------------------

let calls;
let brands; // lower-cased name → id
let brandNames; // id → name
let shades; // { shadeId, brandId, name, finish, collection, finishes, status, mergedInto, authority, category, userShade, adminEdit, holders: Set<userId> }
let listings; // { shadeId, dataSourceId, externalId, brandKind }
let audits;
let merges;
let invalidated;

const SOURCE_ID = 32;

function sqlOf(text) {
  return text.replace(/\s+/g, " ").trim();
}
const shade = (id) => shades.find((s) => s.shadeId === Number(id));
const key = (name) => String(name).replace(/\s+/g, " ").trim().toLowerCase();
const brandListedBy = (shadeId, exceptSource) =>
  listings.some((l) => l.shadeId === shadeId && l.brandKind && (exceptSource === undefined || l.dataSourceId !== exceptSource));

const client = {
  async query(text, params = []) {
    const sql = sqlOf(text);
    calls.push({ sql, params });

    if (sql.startsWith("SELECT DISTINCT ssp.shade_id")) {
      return {
        rows: listings
          .filter((l) => l.dataSourceId === params[0] && l.externalId === params[1])
          .filter((l) => !shade(l.shadeId)?.mergedInto)
          .map((l) => ({ shadeId: l.shadeId })),
      };
    }
    if (sql.includes("FROM brand")) {
      const id = brands[String(params[0]).toLowerCase()];
      return { rows: id ? [{ brandId: id }] : [] };
    }
    if (sql.startsWith("INSERT INTO brand")) {
      const id = 900 + Object.keys(brands).length;
      brands[String(params[0]).toLowerCase()] = id;
      brandNames[id] = params[0];
      return { rows: [{ brandId: id }] };
    }
    if (sql.includes("FROM shade s JOIN brand b") && sql.includes("FOR UPDATE OF s")) {
      const s = shade(params[0]);
      if (!s) return { rows: [] };
      return {
        rows: [
          {
            shadeId: String(s.shadeId),
            brandId: String(s.brandId),
            brand: brandNames[s.brandId],
            name: s.name,
            status: s.status ?? "active",
            mergedIntoShadeId: s.mergedInto ?? null,
            productLineId: null,
            productCategory: s.category ?? "color",
            userShade: s.userShade === true,
            adminEdit: s.adminEdit === true,
            otherBrandListing: brandListedBy(s.shadeId, params[1]),
          },
        ],
      };
    }
    if (sql.includes("FROM shade t WHERE t.brand_id = $1")) {
      return {
        rows: shades
          .filter((s) => s.brandId === params[0] && s.shadeId !== params[2] && !s.mergedInto)
          .filter((s) => ["active", "excluded"].includes(s.status ?? "active") && key(s.name) === key(params[1]))
          .map((s) => ({
            shadeId: s.shadeId,
            name: s.name,
            status: s.status ?? "active",
            finish: s.finish ?? null,
            collection: s.collection ?? null,
            finishes: s.finishes ?? [],
            catalogAuthority: s.authority ?? "brand_store",
            productCategory: s.category ?? "color",
            brandListed: brandListedBy(s.shadeId),
            otherBrandListing: brandListedBy(s.shadeId, params[3]),
          })),
      };
    }
    if (sql.startsWith("UPDATE shade SET brand_id = $2, shade_name_canonical = $3")) {
      const s = shade(params[0]);
      s.brandId = params[1];
      s.name = params[2];
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("FROM shade") && sql.includes("coalesce(finish, '') = coalesce($3, '')")) {
      const found = shades.find(
        (s) =>
          s.brandId === params[0] &&
          !s.mergedInto &&
          s.name.toLowerCase() === String(params[1]).toLowerCase() &&
          (s.finish ?? "") === (params[2] ?? "") &&
          (s.collection ?? "") === (params[3] ?? "")
      );
      return { rows: found ? [{ shadeId: found.shadeId }] : [] };
    }
    if (sql.startsWith("INSERT INTO shade ")) {
      const id = 5000 + shades.length;
      shades.push({ shadeId: id, brandId: params[0], name: params[1], finish: params[2], collection: params[3], holders: new Set() });
      return { rows: [{ shadeId: id }] };
    }
    if (sql.startsWith("INSERT INTO shade_source_product")) {
      const [shadeId, dataSourceId, externalId] = params;
      if (!listings.some((l) => l.shadeId === shadeId && l.dataSourceId === dataSourceId && l.externalId === externalId)) {
        listings.push({ shadeId, dataSourceId, externalId, brandKind: true });
      }
      return { rows: [] };
    }
    if (sql.startsWith("INSERT INTO admin_audit_event")) {
      audits.push({ actor: params[0], action: params[1], changes: JSON.parse(params[2]) });
      return { rows: [] };
    }
    if (sql.includes("FROM shade WHERE shade_id = $1 FOR UPDATE")) {
      const s = shade(params[0]);
      return {
        rows: [
          {
            finishes: s?.finishes ?? [],
            finishesSource: null,
            vendorHex: null,
            vendorHexSource: null,
            vendorHexPrevious: null,
            detectedHex: null,
            detectedFinishes: null,
            catalogAuthority: s?.authority ?? "brand_store",
          },
        ],
      };
    }
    if (sql.startsWith("UPDATE shade SET color_name")) {
      const s = shade(params[0]);
      if (s && params[15]) s.authority = params[15];
      return { rows: [] };
    }
    return { rows: [] };
  },
};

mockDistModule("db.js", {
  query: async (text, params) => {
    if (sqlOf(text).includes("FROM finish_type")) return { rows: [] };
    return client.query(text, params);
  },
  transaction: async (callback) => callback(client),
});
mockDistModule("blob-storage.js", { ensureContainer: async () => {}, uploadSourceImageToBlob: async () => null });
mockDistModule("ai-color-detection.js", { detectHexWithAzureOpenAI: async () => null });
mockDistModule("azure-openai-batch.js", { submitVisionHexBatch: async () => null });
mockDistModule("polish-cache.js", {
  invalidatePolishCachesForUser: async (userId, shadeIds) => invalidated.push({ userId, shadeIds }),
  invalidateAllCollectionStats: async () => {},
  invalidateCatalogWideCaches: async () => {},
});
// mergeShadeInto: same contract as lib/shade-review.ts (holders and listings follow the target).
mergeImpl = async (_client, options) => {
    merges.push(options);
    const source = shade(options.sourceShadeId);
    const target = shade(options.targetShadeId);
    assert.equal(options.sourceKind, "catalog");
    assert.equal(target.status ?? "active", "active");
    const combined = [...source.holders].filter((userId) => target.holders.has(userId));
    const moved = [...source.holders].filter((userId) => !target.holders.has(userId));
    for (const userId of source.holders) target.holders.add(userId);
    source.holders = new Set();
    for (const listing of listings) if (listing.shadeId === source.shadeId) listing.shadeId = target.shadeId;
    source.mergedInto = target.shadeId;
    source.status = "excluded";
    return {
      sourceShadeId: source.shadeId,
      targetShadeId: target.shadeId,
      movedInventoryRows: moved.length,
      combinedInventoryRows: combined.length,
      affectedUserIds: [...combined, ...moved].sort((a, b) => a - b),
      copiedAliasRows: 0,
      movedSkuRows: 0,
      movedSwatchRows: 0,
      movedSourceProductRows: 1,
      reviewedAt: "now",
    };
};

const { materializeHoloTacoRecords } = require("../dist/lib/ingestion-repo");

function record(externalId, name, rawTitle, brand = "China Glaze") {
  return {
    externalId,
    raw: {},
    normalized: { brand, name, rawTitle, imageUrls: [], tags: [], collections: [], finishes: [] },
  };
}
function logger() {
  const lines = { info: [], warn: [], error: [] };
  return {
    lines,
    info: (message, data) => lines.info.push({ message, data }),
    warn: (message, data) => lines.warn.push({ message, data }),
    error: (message, data) => lines.error.push({ message, data }),
  };
}
function run(records, log = logger()) {
  return materializeHoloTacoRecords(
    SOURCE_ID,
    records,
    { detectHexFromImage: false, storeImages: false, sourceKind: "brand", sourceName: "ChinaGlazeShopify", actorUserId: 2, progressLogger: log },
    "[Test]"
  );
}
const shadeInserts = () => calls.filter((c) => c.sql.startsWith("INSERT INTO shade "));

beforeEach(() => {
  calls = [];
  brands = { cg: 167, "china glaze": 7, "le mini macaron": 169, "le mini macaron europe": 162 };
  brandNames = { 167: "CG", 7: "China Glaze", 169: "Le Mini Macaron", 162: "Le Mini Macaron Europe" };
  shades = [];
  listings = [];
  audits = [];
  merges = [];
  invalidated = [];
});

function cgShade(shadeId, name, extra = {}) {
  shades.push({ shadeId, brandId: 167, name, finish: null, collection: null, finishes: [], holders: new Set(), ...extra });
  listings.push({ shadeId, dataSourceId: SOURCE_ID, externalId: `p${shadeId}`, brandKind: true });
}

describe("materializeHoloTacoRecords — brand store corrects its own shade", () => {
  it("moves a shade filed under the vendor spelling to the brand, renamed, with an audit row and a log line", async () => {
    cgShade(3877, "ALPENGLOW");
    const log = logger();
    const metrics = await run([record("p3877", "Alpenglow", "ALPENGLOW")], log);

    assert.equal(shade(3877).brandId, 7);
    assert.equal(shade(3877).name, "Alpenglow");
    assert.equal(shadeInserts().length, 0, "no second shade");
    assert.equal(metrics.brandStoreShadesMoved, 1);
    assert.equal(metrics.brandStoreShadesRenamed, 1);
    assert.equal(metrics.brandStoreShadesMerged, 0);
    assert.ok(calls.some((c) => c.sql.startsWith("UPDATE sku SET brand_id = $2")), "SKUs follow the brand");
    assert.equal(calls.filter((c) => c.sql.startsWith("INSERT INTO shade_alias")).length, 0, "case-only: no alias");
    assert.deepEqual(audits.map((a) => [a.actor, a.action, a.changes.shadeId]), [[2, "shade.catalog_correct", 3877]]);
    assert.deepEqual(audits[0].changes.brand, { from: { id: 167, name: "CG" }, to: { id: 7, name: "China Glaze" } });
    assert.ok(log.lines.info.some((l) => /Corrected shade 3877 of p3877: brand CG → China Glaze, name "ALPENGLOW" → "Alpenglow"/.test(l.message)));
    assert.match(log.lines.info.at(-1).message, /shades corrected: 1 moved to the brand, 1 renamed/);
  });

  it("renames in place when only the case differs, and keeps a raw title alias when the title differs", async () => {
    shades.push({ shadeId: 20, brandId: 7, name: "LOFI-AURA", finishes: [], holders: new Set() });
    listings.push({ shadeId: 20, dataSourceId: SOURCE_ID, externalId: "p20", brandKind: true });
    shades.push({ shadeId: 21, brandId: 169, name: "Fleur Bleue - Quick Dry Nail Polish", finishes: [], holders: new Set() });
    listings.push({ shadeId: 21, dataSourceId: SOURCE_ID, externalId: "p21", brandKind: true });

    const metrics = await run([
      record("p20", "Lofi-aura", "LOFI-AURA"),
      record("p21", "Fleur Bleue", "Fleur Bleue - Quick Dry Nail Polish", "Le Mini Macaron"),
    ]);

    assert.equal(shade(20).name, "Lofi-aura");
    assert.equal(shade(21).name, "Fleur Bleue");
    assert.equal(metrics.brandStoreShadesRenamed, 2);
    assert.equal(metrics.brandStoreShadesMoved, 0);
    const aliases = calls.filter((c) => c.sql.startsWith("INSERT INTO shade_alias")).map((c) => c.params);
    assert.deepEqual(aliases, [[21, "Fleur Bleue - Quick Dry Nail Polish"]]);
  });

  it("merges into the brand's retailer-created shade with a holder on each side, then takes it over", async () => {
    cgShade(3907, "FAIRY DUST", { holders: new Set([11]) });
    shades.push({ shadeId: 5257, brandId: 7, name: "Fairy Dust", finishes: ["holographic"], authority: "retailer", holders: new Set([12, 11]) });
    listings.push({ shadeId: 5257, dataSourceId: 40, externalId: "bp-1", brandKind: false }); // Beyond Polish (retailer)
    const log = logger();

    const metrics = await run([record("p3907", "Fairy Dust", "FAIRY DUST")], log);

    assert.equal(merges.length, 1);
    assert.deepEqual([merges[0].sourceShadeId, merges[0].targetShadeId, merges[0].adminUserId], [3907, 5257, 2]);
    assert.equal(shade(3907).mergedInto, 5257);
    assert.deepEqual([...shade(5257).holders].sort(), [11, 12]);
    assert.equal(shade(3907).brandId, 167, "the retired copy stays where it was");
    assert.equal(metrics.brandStoreShadesMerged, 1);
    assert.equal(shadeInserts().length, 0);
    // The record then writes onto the survivor: the brand store takes the retailer shade over.
    const write = calls.find((c) => c.sql.startsWith("UPDATE shade SET color_name"));
    assert.equal(write.params[0], 5257);
    assert.equal(shade(5257).authority, "brand_store");
    assert.deepEqual(audits.map((a) => [a.action, a.changes.sourceShadeId, a.changes.targetShadeId]), [["shade.catalog_merge", 3907, 5257]]);
    assert.deepEqual(invalidated.map((i) => i.userId), [11]);
    assert.ok(log.lines.info.some((l) => /Merged shade 3907 \(CG "FAIRY DUST"\) of p3907 into China Glaze shade 5257 "Fairy Dust"/.test(l.message)));
  });

  it("leaves a user's or admin-edited shade alone and logs it", async () => {
    cgShade(1, "ALPENGLOW", { adminEdit: true });
    cgShade(2, "SUNSET EDIT", { userShade: true });
    const log = logger();
    const metrics = await run([record("p1", "Alpenglow", "ALPENGLOW"), record("p2", "Sunset Edit", "SUNSET EDIT")], log);

    assert.equal(shade(1).brandId, 167);
    assert.equal(shade(1).name, "ALPENGLOW");
    assert.equal(shade(2).name, "SUNSET EDIT");
    assert.equal(metrics.brandStoreCorrectionsSkipped, 2);
    assert.equal(audits.length, 0);
    assert.equal(log.lines.warn.filter((l) => /as it is \(protected\)/.test(l.message)).length, 2);
  });

  it("leaves a shade another brand store also lists alone and logs it", async () => {
    cgShade(3, "ALPENGLOW");
    listings.push({ shadeId: 3, dataSourceId: 99, externalId: "other", brandKind: true });
    const log = logger();
    const metrics = await run([record("p3", "Alpenglow", "ALPENGLOW")], log);

    assert.equal(shade(3).brandId, 167);
    assert.equal(metrics.brandStoreCorrectionsSkipped, 1);
    assert.ok(log.lines.warn.some((l) => /Left shade 3 \(CG "ALPENGLOW"\) of p3 as it is \(other_brand_source\); the store files it as China Glaze "Alpenglow"/.test(l.message)));
  });

  it("skips (never guesses) when two same-name shades fit, or a same-name shade is no identity match", async () => {
    cgShade(3931, "POOL PARTY");
    shades.push({ shadeId: 5168, brandId: 7, name: "Pool Party", authority: "retailer", finishes: ["creme"], holders: new Set() });
    shades.push({ shadeId: 5117, brandId: 7, name: "Pool Party", authority: "retailer", finishes: ["matte"], holders: new Set() });
    cgShade(3927, "RUBY PUMPS");
    shades.push({ shadeId: 11, brandId: 7, name: "Ruby Pumps", finish: "glitter", collection: "Holiday Joy", finishes: ["glitter"], holders: new Set() });
    const log = logger();

    const metrics = await run([record("p3931", "Pool Party", "POOL PARTY"), record("p3927", "Ruby Pumps", "RUBY PUMPS")], log);

    assert.equal(merges.length, 0);
    assert.equal(shade(3931).brandId, 167);
    assert.equal(shade(3927).brandId, 167);
    assert.equal(metrics.brandStoreCorrectionsSkipped, 2);
    assert.ok(log.lines.warn.some((l) => /ambiguous_target/.test(l.message)));
    assert.ok(log.lines.warn.some((l) => /same_name_not_identity/.test(l.message)));
  });

  it("changes nothing on a second run", async () => {
    cgShade(3877, "ALPENGLOW");
    cgShade(3907, "FAIRY DUST");
    shades.push({ shadeId: 5257, brandId: 7, name: "Fairy Dust", authority: "retailer", finishes: [], holders: new Set() });
    const records = [record("p3877", "Alpenglow", "ALPENGLOW"), record("p3907", "Fairy Dust", "FAIRY DUST")];
    await run(records);
    assert.equal(merges.length, 1);
    assert.equal(audits.length, 2);

    calls = [];
    audits = [];
    merges = [];
    const metrics = await run(records);
    assert.equal(merges.length, 0);
    assert.equal(audits.length, 0);
    assert.equal(metrics.brandStoreShadesMoved + metrics.brandStoreShadesRenamed + metrics.brandStoreShadesMerged + metrics.brandStoreCorrectionsSkipped, 0);
    assert.equal(calls.filter((c) => c.sql.startsWith("UPDATE shade SET brand_id")).length, 0);
    assert.equal(shadeInserts().length, 0);
    // The survivor got the listing and is written in place.
    assert.ok(calls.some((c) => c.sql.startsWith("UPDATE shade SET color_name") && c.params[0] === 5257));
  });

  it("does not correct for a retailer source, nor for a shade found by name rather than by listing", async () => {
    cgShade(3877, "ALPENGLOW");
    await materializeHoloTacoRecords(
      SOURCE_ID,
      [record("p3877", "Alpenglow", "ALPENGLOW")],
      { detectHexFromImage: false, storeImages: false, sourceKind: "retailer", sourceName: "BeyondPolishShopify", actorUserId: 2 },
      "[Test]"
    );
    assert.equal(shade(3877).brandId, 167);
    assert.equal(calls.filter((c) => c.sql.includes("FOR UPDATE OF s")).length, 0);
  });
});
