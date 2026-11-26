/**
 * Retiring the shades a brand store's gate no longer accepts (lib/brand-store-rejected.ts):
 * the listing verdict on stored Shopify payloads, the pure plan, body parsing, and one batch on a
 * fake database (retire unheld, keep held, idempotent).
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  judgeListing,
  parseBrandStoreRejectedBody,
  planBrandStoreRejected,
  runBrandStoreRejectedBatch,
} = require("../dist/lib/brand-store-rejected");

const LMM_META = { vendorAliases: { "Le Mini Macaron Europe": "Le Mini Macaron", "Camelia Beauty": "Le Mini Macaron" } };
const CG_META = { vendorAliases: { CG: "China Glaze" } };

function product(title, productType, vendor, extra = {}) {
  return { id: 1, title, product_type: productType, vendor, tags: [], variants: [], ...extra };
}
function listing(dataSource, metadata, raw, externalId = "x1") {
  return { externalProductId: Number(String(externalId).replace(/\D/g, "")) || 1, externalId, dataSource, metadata, raw };
}
function shadeRow(shadeId, listings, extra = {}) {
  return { shadeId, brandId: 162, brand: "Le Mini Macaron Europe", name: `Shade ${shadeId}`, userShade: false, adminEdit: false, holders: 0, listings, ...extra };
}

const gel = () => listing("LeMiniMacaronShopify", LMM_META, product("Lily Rose - Gel Polish", "Individual Gel Polish", "Camelia Beauty"));
const lacquer = () =>
  listing("LeMiniMacaronShopify", LMM_META, product("Fleur Bleue - Quick Dry Nail Polish", "Nail Polish Color", "Le Mini Macaron Europe", { tags: ["nail polish"] }));

describe("judgeListing", () => {
  it("re-runs the brand store's current gate on the stored product", () => {
    assert.equal(judgeListing(gel()), "rejected");
    assert.equal(judgeListing(lacquer()), "accepted");
    // includeGel on: the store filter defers and the gel product passes the generic gate again.
    assert.equal(judgeListing(listing("LeMiniMacaronShopify", { ...LMM_META, includeGel: true }, gel().raw)), "accepted");
    // Another vendor's item on the China Glaze store.
    assert.equal(judgeListing(listing("ChinaGlazeShopify", CG_META, product("Cuticle Oil", "Nail Care", "Flowery"))), "rejected");
    assert.equal(
      judgeListing(listing("ChinaGlazeShopify", CG_META, product("ALPENGLOW", "Nail Lacquers", "CG", { tags: ["nail polish"] }))),
      "accepted"
    );
  });

  it("never judges a retailer listing, another protocol or a missing payload", () => {
    assert.equal(judgeListing(listing("BeyondPolishShopify", { kind: "retailer" }, gel().raw)), "not_brand_source");
    assert.equal(judgeListing(listing("PicturePolishWooCommerce", {}, gel().raw)), "unsupported");
    assert.equal(judgeListing(listing("LeMiniMacaronShopify", LMM_META, null)), "unsupported");
  });
});

describe("planBrandStoreRejected", () => {
  it("retires an unheld shade whose every listing is rejected, keeps a held one", () => {
    const plan = planBrandStoreRejected([shadeRow(1, [gel()]), shadeRow(2, [gel()], { holders: 2 }), shadeRow(3, [lacquer()])]);
    assert.deepEqual(plan.retire.map((s) => s.shadeId), [1]);
    assert.deepEqual(plan.retire[0].products, [{ dataSource: "LeMiniMacaronShopify", externalId: "x1", externalProductId: 1 }]);
    assert.deepEqual(plan.held.map((s) => [s.shadeId, s.holders]), [[2, 2]]);
    assert.equal(plan.partial.length, 0);
  });

  it("keeps a shade a retailer or another accepted product still lists, and one it cannot re-check", () => {
    const retailer = listing("BeyondPolishShopify", { kind: "retailer" }, gel().raw, "bp9");
    const woo = listing("PicturePolishWooCommerce", {}, {}, "pp9");
    const plan = planBrandStoreRejected([
      shadeRow(1, [gel(), retailer]),
      shadeRow(2, [gel(), lacquer()]),
      shadeRow(3, [gel(), woo]),
    ]);
    assert.deepEqual(plan.retire, []);
    assert.deepEqual(plan.partial.map((s) => [s.shadeId, s.keptBy]), [
      [1, ["BeyondPolishShopify"]],
      [2, ["LeMiniMacaronShopify"]],
    ]);
    assert.deepEqual(plan.unsupported.map((s) => [s.shadeId, s.sources]), [[3, ["PicturePolishWooCommerce"]]]);
  });

  it("keeps user, approved and admin-edited shades", () => {
    const plan = planBrandStoreRejected([shadeRow(1, [gel()], { userShade: true }), shadeRow(2, [gel()], { adminEdit: true })]);
    assert.deepEqual(plan.retire, []);
    assert.deepEqual(plan.protectedShades.map((s) => [s.shadeId, s.reasons]), [
      [1, ["user or approved shade"]],
      [2, ["admin edit"]],
    ]);
  });
});

describe("parseBrandStoreRejectedBody", () => {
  it("defaults to a dry run of 200 shades and validates the fields", () => {
    assert.deepEqual(parseBrandStoreRejectedBody({}), { afterShadeId: 0, limit: 200, dryRun: true, sources: null });
    assert.deepEqual(parseBrandStoreRejectedBody({ afterShadeId: 5, limit: 10, dryRun: false, sources: [" A ", "A", "B"] }), {
      afterShadeId: 5,
      limit: 10,
      dryRun: false,
      sources: ["A", "B"],
    });
    assert.match(parseBrandStoreRejectedBody({ limit: 0 }), /limit/);
    assert.match(parseBrandStoreRejectedBody({ afterShadeId: -1 }), /afterShadeId/);
    assert.match(parseBrandStoreRejectedBody({ dryRun: "no" }), /dryRun/);
    assert.match(parseBrandStoreRejectedBody({ sources: [""] }), /sources/);
  });
});

// ---------------------------------------------------------------------------
// One batch on a fake database
// ---------------------------------------------------------------------------

function fakeDb(state) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const text = sql.replace(/\s+/g, " ").trim();
      calls.push({ text, params });
      if (text.includes("AS listings FROM shade s")) {
        const rows = state.shades
          .filter((s) => s.shadeId > params[0] && s.status === "active")
          .slice(0, params[1])
          .map((s) => ({
            shadeId: String(s.shadeId),
            brandId: String(s.brandId),
            brand: s.brand,
            name: s.name,
            userShade: false,
            adminEdit: false,
            holders: String(s.holders),
            listings: s.listings,
          }));
        return { rows };
      }
      if (text.startsWith("UPDATE shade s SET status = 'excluded'")) {
        const s = state.shades.find((row) => row.shadeId === params[0]);
        if (!s || s.status !== "active" || s.holders > 0) return { rows: [], rowCount: 0 };
        s.status = "excluded";
        return { rows: [], rowCount: 1 };
      }
      if (text.startsWith("INSERT INTO shade_category_change")) {
        state.log.push({ shadeId: params[0], after: JSON.parse(params[1]), actor: params[2], runId: params[3] });
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("FROM brand b LEFT JOIN shade s")) {
        const rows = params[0].map((brandId) => {
          const of = state.shades.filter((s) => s.brandId === brandId);
          return { brandId: String(brandId), brand: of[0]?.brand ?? "?", active: String(of.filter((s) => s.status === "active").length), shades: String(of.length) };
        });
        return { rows };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return { calls, db: { query: client.query, transaction: async (callback) => callback(client) } };
}

describe("runBrandStoreRejectedBatch", () => {
  function state() {
    return {
      log: [],
      shades: [
        { shadeId: 10, brandId: 163, brand: "Camelia Beauty", name: "Lily Rose - Gel Polish", status: "active", holders: 0, listings: [gel()] },
        { shadeId: 11, brandId: 163, brand: "Camelia Beauty", name: "Rosy - Gel Polish", status: "active", holders: 1, listings: [gel()] },
        { shadeId: 12, brandId: 162, brand: "Le Mini Macaron Europe", name: "Fleur Bleue", status: "active", holders: 0, listings: [lacquer()] },
      ],
    };
  }

  it("dry run plans without writing and names the brands left without an active shade", async () => {
    const s = state();
    s.shades[1].holders = 0;
    const { db, calls } = fakeDb(s);
    const report = await runBrandStoreRejectedBatch(db, { afterShadeId: 0, limit: 200, dryRun: true, sources: null, adminUserId: 2 });
    assert.equal(report.retired, 2);
    assert.equal(report.scannedShades, 3);
    assert.equal(report.nextAfterShadeId, null);
    assert.deepEqual(report.brandsWithoutActiveShades, [{ brandId: 163, brand: "Camelia Beauty", shades: 2 }]);
    assert.equal(calls.filter((c) => c.text.startsWith("UPDATE") || c.text.startsWith("INSERT")).length, 0);
    assert.deepEqual(report.changedShadeIds, []);
  });

  it("retires the unheld shade with a logged exclusion, keeps the held one, and a re-run changes nothing", async () => {
    const s = state();
    const { db } = fakeDb(s);
    const report = await runBrandStoreRejectedBatch(db, { afterShadeId: 0, limit: 200, dryRun: false, sources: null, adminUserId: 2 });
    assert.equal(report.retired, 1);
    assert.deepEqual(report.changedShadeIds, [10]);
    assert.deepEqual(report.held.map((h) => h.shadeId), [11]);
    assert.equal(s.shades[0].status, "excluded");
    assert.equal(s.shades[1].status, "active");
    assert.equal(s.log.length, 1);
    assert.equal(s.log[0].shadeId, 10);
    assert.equal(s.log[0].actor, 2);
    assert.equal(s.log[0].after.reason, "brand_store_rejected");
    assert.ok(report.runId);
    assert.deepEqual(report.brandsWithoutActiveShades, [], "the held shade keeps Camelia Beauty active");

    const again = await runBrandStoreRejectedBatch(db, { afterShadeId: 0, limit: 200, dryRun: false, sources: null, adminUserId: 2 });
    assert.equal(again.retired, 0);
    assert.equal(s.log.length, 1);
  });

  it("rechecks the protection flags in the retire UPDATE (an edit can land after the batch read)", async () => {
    const { db, calls } = fakeDb(state());
    await runBrandStoreRejectedBatch(db, { afterShadeId: 0, limit: 200, dryRun: false, sources: null, adminUserId: 2 });
    const update = calls.map((c) => c.text.replace(/\s+/g, " ")).find((t) => t.startsWith("UPDATE shade s SET status = 'excluded'"));
    assert.ok(update, "retire UPDATE ran");
    for (const guard of [
      "s.created_by_user_id IS NULL",
      "s.review_status IS DISTINCT FROM 'approved'",
      "s.product_category_source IS DISTINCT FROM 'admin'",
      "s.finishes_source IS DISTINCT FROM 'admin'",
      "s.vendor_hex_source IS DISTINCT FROM 'manual_label'",
    ]) {
      assert.ok(update.includes(guard), guard);
    }
  });

  it("pages by shade id", async () => {
    const { db } = fakeDb(state());
    const report = await runBrandStoreRejectedBatch(db, { afterShadeId: 0, limit: 2, dryRun: true, sources: null, adminUserId: 2 });
    assert.equal(report.nextAfterShadeId, 11);
  });
});
