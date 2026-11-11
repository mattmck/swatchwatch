import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BRAND_PLATFORMS,
  SOURCE_RUN_DEFAULTS,
  classifyBrandSupply,
  deriveSourcePermission,
  isPermissionOk,
  sourceDisplayName,
} from "../index";

const base = { enabled: false, fetchable: true };

describe("deriveSourcePermission", () => {
  it("uses a valid stored permission", () => {
    const r = deriveSourcePermission({
      ...base,
      metadata: { permission: { status: "asked", askedAt: "2026-11-08" } },
    });
    assert.deepEqual(r, { permission: { status: "asked", askedAt: "2026-11-08" }, stored: true });
  });

  it("copies only known keys with correct types", () => {
    const r = deriveSourcePermission({
      ...base,
      metadata: {
        permission: {
          status: "granted",
          decidedAt: 5,
          channel: "carrier pigeon",
          imagesGranted: "yes",
          recordedByUserId: 7,
          extra: true,
          summary: "ok",
        },
      },
    });
    assert.deepEqual(r.permission, { status: "granted", recordedByUserId: 7, summary: "ok" });
    assert.equal(r.stored, true);
  });

  it("falls back to derivation for a bogus stored status or a non-object", () => {
    for (const permission of [{ status: "bogus" }, "granted", ["granted"], null]) {
      const r = deriveSourcePermission({ ...base, enabled: true, metadata: { permission } });
      assert.deepEqual(r, { permission: { status: "not_asked" }, stored: false });
    }
  });

  it("derives granted from a written permission and imagesPermitted", () => {
    const r = deriveSourcePermission({
      ...base,
      metadata: { verification: { writtenPermission: "email 2026-10-22" }, imagesPermitted: false },
    });
    assert.deepEqual(r, {
      permission: { status: "granted", imagesGranted: false, summary: "email 2026-10-22" },
      stored: false,
    });
    const defaulted = deriveSourcePermission({
      ...base,
      metadata: { verification: { writtenPermission: "email 2026-10-22" } },
    });
    assert.equal(defaulted.permission.imagesGranted, true);
  });

  it("a derived grant's images default follows the source kind", () => {
    const metadata = { verification: { writtenPermission: "ok" } };
    assert.equal(deriveSourcePermission({ ...base, metadata }).permission.imagesGranted, true);
    assert.equal(deriveSourcePermission({ ...base, metadata, kind: "brand" }).permission.imagesGranted, true);
    assert.equal(deriveSourcePermission({ ...base, metadata, kind: "retailer" }).permission.imagesGranted, false);
    assert.equal(deriveSourcePermission({ ...base, metadata, kind: "feed" }).permission.imagesGranted, false);
    assert.equal(
      deriveSourcePermission({ ...base, metadata: { ...metadata, imagesPermitted: true }, kind: "retailer" }).permission
        .imagesGranted,
      true,
    );
  });

  it("derives not_needed when the terms have no scraping clause", () => {
    const r = deriveSourcePermission({
      ...base,
      metadata: { verification: { termsScrapingClause: false } },
    });
    assert.equal(r.permission.status, "not_needed");
  });

  it("derives not_asked for pending approval, enabled without verification, and null metadata", () => {
    assert.equal(
      deriveSourcePermission({
        ...base,
        metadata: { pendingApproval: true, verification: { termsScrapingClause: true } },
      }).permission.status,
      "not_asked",
    );
    assert.equal(deriveSourcePermission({ ...base, enabled: true, metadata: {} }).permission.status, "not_asked");
    assert.equal(deriveSourcePermission({ ...base, metadata: null }).permission.status, "not_asked");
  });

  it("is not_needed for a source that cannot be fetched, whatever the metadata says", () => {
    const r = deriveSourcePermission({
      enabled: true,
      fetchable: false,
      metadata: { permission: { status: "declined" }, pendingApproval: true },
    });
    assert.deepEqual(r, { permission: { status: "not_needed" }, stored: false });
  });
});

describe("isPermissionOk", () => {
  it("is true only for granted and not_needed", () => {
    assert.equal(isPermissionOk("granted"), true);
    assert.equal(isPermissionOk("not_needed"), true);
    for (const s of ["not_asked", "asked", "declined"] as const) assert.equal(isPermissionOk(s), false);
  });
});

describe("sourceDisplayName", () => {
  it("strips the connector suffix and spaces the words", () => {
    const cases: Record<string, string> = {
      HypnoticPolishShopify: "Hypnotic Polish",
      KbshimmerWooCommerce: "Kbshimmer",
      PaintedPolishBigCartel: "Painted Polish",
      OpiSitemap: "Opi",
      AcmeFeed: "Acme",
      OpenBeautyFacts: "Open Beauty Facts",
      Manual: "Manual",
      HoloTacoShopify: "Holo Taco",
      Shopify: "Shopify",
    };
    for (const [name, expected] of Object.entries(cases)) assert.equal(sourceDisplayName(name), expected);
  });
});

describe("classifyBrandSupply", () => {
  it("classifies own, retailer, both and none", () => {
    assert.equal(classifyBrandSupply(1, 0), "own");
    assert.equal(classifyBrandSupply(0, 2), "retailer");
    assert.equal(classifyBrandSupply(1, 1), "both");
    assert.equal(classifyBrandSupply(0, 0), "none");
  });
});

describe("constants", () => {
  it("lists the seven brand platforms", () => {
    assert.deepEqual(
      [...BRAND_PLATFORMS],
      ["shopify", "woocommerce", "bigcartel", "custom", "feed", "none", "unknown"],
    );
  });

  it("uses the full-catalog pull defaults for runs", () => {
    assert.deepEqual(SOURCE_RUN_DEFAULTS, {
      exhaustive: true,
      materializeToInventory: true,
      detectHexFromImage: true,
      overwriteDetectedHex: false,
      page: 1,
      pageSize: 100,
    });
  });
});
