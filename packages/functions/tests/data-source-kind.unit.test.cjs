const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { sourceKindFromMetadata } = require("../dist/lib/data-source-kind");

describe("sourceKindFromMetadata", () => {
  it("is retailer only for the exact value", () => {
    assert.equal(sourceKindFromMetadata({ kind: "retailer" }), "retailer");
  });
  for (const [label, value] of [
    ["empty object", {}],
    ["null", null],
    ["undefined", undefined],
    ["upper case", { kind: "RETAILER" }],
    ["bare string", "retailer"],
    ["other kind", { kind: "brand" }],
  ]) {
    it(`is brand_store for ${label}`, () => {
      assert.equal(sourceKindFromMetadata(value), "brand_store");
    });
  }
});

const { planListingWrites } = require("../dist/lib/data-source-kind");

describe("planListingWrites", () => {
  const kinds = ["brand_store", "retailer"];
  const bools = [true, false];
  const ALL = { writeCategory: true, linkGallery: true, runDetection: true };

  for (const sourceKind of kinds)
    for (const shadeAuthority of kinds)
      for (const shadeHasBrandStoreImages of bools)
        for (const shadeHasDetectedHex of bools) {
          const base = { sourceKind, shadeAuthority, shadeHasBrandStoreImages, shadeHasDetectedHex };
          const label = JSON.stringify(base);

          it(`shade created by the listing: all writes, authority = source kind ${label}`, () => {
            assert.deepEqual(planListingWrites({ ...base, shadeCreated: true }), {
              ...ALL,
              takeOver: false,
              setAuthority: sourceKind,
            });
          });

          if (sourceKind === "brand_store" && shadeAuthority === "retailer") {
            it(`brand store on a retailer shade takes over ${label}`, () => {
              assert.deepEqual(planListingWrites({ ...base, shadeCreated: false }), {
                ...ALL,
                takeOver: true,
                setAuthority: "brand_store",
              });
            });
          } else if (sourceKind === "brand_store") {
            it(`brand store on a brand_store shade keeps today's behavior ${label}`, () => {
              assert.deepEqual(planListingWrites({ ...base, shadeCreated: false }), {
                ...ALL,
                takeOver: false,
                setAuthority: null,
              });
            });
          } else {
            it(`retailer on an existing shade only fills gaps ${label}`, () => {
              assert.deepEqual(planListingWrites({ ...base, shadeCreated: false }), {
                writeCategory: false,
                linkGallery: !shadeHasBrandStoreImages,
                runDetection: !shadeHasDetectedHex,
                takeOver: false,
                setAuthority: null,
              });
            });
          }
        }
});
