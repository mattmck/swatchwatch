import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CANONICAL_FINISHES, type Polish } from "swatchwatch-shared";
import {
  MANUAL_ADD_PATHNAME,
  asWishlistRequest,
  buildCreateRequest,
  buildFinishOptions,
  clampQuantity,
  colorNameFor,
  dupesForNewShade,
  hasErrors,
  initialManualAddForm,
  manualAddPrefillFromParams,
  manualAddRoute,
  nextRating,
  toggleFinish,
  validateManualAdd,
  type ManualAddForm,
} from "./manual-add";

function form(overrides: Partial<ManualAddForm> = {}): ManualAddForm {
  return { ...initialManualAddForm({}), brand: "Holo Taco", name: "Scattered Holo Taco", ...overrides };
}

function owned(overrides: Partial<Polish>): Polish {
  return { id: "1", brand: "Brand", name: "Shade", status: "owned", quantity: 1, ...overrides } as Polish;
}

describe("manual add route params", () => {
  it("keeps a valid barcode with its format and trims names", () => {
    assert.deepEqual(
      manualAddPrefillFromParams({ barcode: "0123456789012", barcodeFormat: "ean_13", brand: " ILNP ", name: "Mega" }),
      { barcode: "0123456789012", barcodeFormat: "ean_13", brand: "ILNP", name: "Mega" },
    );
  });

  it("drops malformed barcodes, formats without a barcode and empty names", () => {
    assert.deepEqual(manualAddPrefillFromParams({ barcode: "12ab", barcodeFormat: "ean_13", brand: "  " }), {});
    assert.deepEqual(manualAddPrefillFromParams({ barcode: "12345678", barcodeFormat: "ean-13!" }), { barcode: "12345678" });
    assert.deepEqual(manualAddPrefillFromParams({ name: ["First", "Second"] }), { name: "First" });
  });

  it("caps long names at 200 characters", () => {
    assert.equal(manualAddPrefillFromParams({ brand: "x".repeat(300) }).brand?.length, 200);
  });

  it("builds a route carrying only what is known", () => {
    assert.deepEqual(manualAddRoute({ gtin: "036000291452", format: "upc_a", brand: "Essie", name: " " }), {
      pathname: MANUAL_ADD_PATHNAME,
      params: { barcode: "036000291452", barcodeFormat: "upc_a", brand: "Essie" },
    });
    assert.deepEqual(manualAddRoute({ format: "upc_a", name: "Ballet Slippers" }).params, { name: "Ballet Slippers" });
  });

  it("round-trips through the prefill reader", () => {
    const route = manualAddRoute({ gtin: "036000291452", format: "upc_a", brand: "Essie", name: "Bordeaux" });
    assert.deepEqual(manualAddPrefillFromParams(route.params), {
      barcode: "036000291452",
      barcodeFormat: "upc_a",
      brand: "Essie",
      name: "Bordeaux",
    });
  });
});

describe("manual add form helpers", () => {
  it("prefills brand and name, defaults to one owned bottle", () => {
    const initial = initialManualAddForm({ brand: "Essie", name: "Bordeaux", barcode: "036000291452" });
    assert.equal(initial.brand, "Essie");
    assert.equal(initial.name, "Bordeaux");
    assert.equal(initial.status, "owned");
    assert.equal(initial.quantity, 1);
  });

  it("toggles finishes in selection order, first stays primary", () => {
    let selected = toggleFinish([], "holo");
    selected = toggleFinish(selected, "creme");
    assert.deepEqual(selected, ["holo", "creme"]);
    assert.deepEqual(toggleFinish(selected, "holo"), ["creme"]);
  });

  it("clamps quantity and toggles rating", () => {
    assert.equal(clampQuantity(0), 1);
    assert.equal(clampQuantity(150), 99);
    assert.equal(clampQuantity(Number.NaN), 1);
    assert.equal(nextRating(3, 3), 0);
    assert.equal(nextRating(3, 5), 5);
  });
});

describe("validateManualAdd", () => {
  it("accepts a minimal form", () => {
    assert.equal(hasErrors(validateManualAdd(form())), false);
  });

  it("requires brand and name", () => {
    const errors = validateManualAdd(form({ brand: " ", name: "" }));
    assert.ok(errors.brand);
    assert.ok(errors.name);
  });

  it("rejects a malformed hex but allows an empty one", () => {
    assert.ok(validateManualAdd(form({ hex: "#12345" })).hex);
    assert.equal(validateManualAdd(form({ hex: "c0392b" })).hex, undefined);
    assert.equal(validateManualAdd(form({ hex: "" })).hex, undefined);
  });

  it("checks bottles only for owned polishes", () => {
    assert.ok(validateManualAdd(form({ quantity: 0 })).quantity);
    assert.equal(validateManualAdd(form({ status: "wishlist", quantity: 0 })).quantity, undefined);
  });

  it("limits rating and notes", () => {
    assert.ok(validateManualAdd(form({ rating: 6 })).rating);
    assert.ok(validateManualAdd(form({ notes: "x".repeat(2001) })).notes);
  });
});

describe("buildCreateRequest", () => {
  it("sends status explicitly with the bottle count, finishes primary first and the barcode", () => {
    const request = buildCreateRequest(
      form({ hex: "c0392b", finishes: ["holo", "creme"], quantity: 2, rating: 4, notes: "  two coats " }),
      { barcode: "036000291452", barcodeFormat: "upc_a" },
    );
    assert.deepEqual(request, {
      brand: "Holo Taco",
      name: "Scattered Holo Taco",
      color: "Red",
      status: "owned",
      vendorHex: "#C0392B",
      finish: "holo",
      finishes: ["holo", "creme"],
      quantity: 2,
      rating: 4,
      notes: "two coats",
      barcode: "036000291452",
      barcodeFormat: "upc_a",
    });
  });

  it("omits empty optional fields and never sends quantity for a wishlist polish", () => {
    assert.deepEqual(buildCreateRequest(form({ status: "wishlist", quantity: 3 }), {}), {
      brand: "Holo Taco",
      name: "Scattered Holo Taco",
      color: "",
      status: "wishlist",
    });
  });

  it("prefers a typed color name over the hex family", () => {
    assert.equal(colorNameFor({ colorName: " Oxblood ", hex: "#C0392B", finishes: [] }), "Oxblood");
    assert.equal(colorNameFor({ colorName: "", hex: "nope", finishes: [] }), "");
  });

  it("Wishlist instead keeps the polish and barcode, drops the bottle count", () => {
    const request = buildCreateRequest(form({ hex: "#C0392B" }), { barcode: "036000291452" });
    const wishlist = asWishlistRequest(request);
    assert.equal(wishlist.status, "wishlist");
    assert.equal(wishlist.quantity, undefined);
    assert.equal(wishlist.barcode, "036000291452");
    assert.equal(wishlist.vendorHex, "#C0392B");
  });
});

describe("buildFinishOptions", () => {
  it("uses reference rows (admin-created included), sorted by label", () => {
    const options = buildFinishOptions([
      { name: "jelly", displayName: "Jelly" },
      { name: "aurora", displayName: "" },
      { name: "Jelly", displayName: "Duplicate" },
    ]);
    assert.deepEqual(options, [
      { value: "aurora", label: "Aurora" },
      { value: "jelly", label: "Jelly" },
    ]);
  });

  it("falls back to the built-in finishes", () => {
    assert.equal(buildFinishOptions(null).length, CANONICAL_FINISHES.length);
  });
});

describe("dupesForNewShade", () => {
  const collection = [
    owned({ id: "10", brand: "Essie", name: "Red Hot", vendorHex: "#C1392C", finishes: ["creme"] }),
    owned({ id: "11", brand: "Essie", name: "Mint", vendorHex: "#98FF98", finishes: ["creme"] }),
    owned({ id: "12", brand: "Essie", name: "Wished", vendorHex: "#C0392B", status: "wishlist" }),
  ];

  it("finds owned near-dupes by hex (wishlist rows never count)", () => {
    const result = dupesForNewShade({ brand: "New", name: "Red", hex: "#C0392B", finishes: ["creme"] }, collection);
    assert.ok(result);
    assert.equal(result.dupeCount, 1);
    assert.equal(result.dupes[0].shadeId, "10");
    assert.equal(result.dupes[0].grade, "high");
  });

  it("returns null without a valid hex", () => {
    assert.equal(dupesForNewShade({ brand: "New", name: "Red", hex: "", finishes: [] }, collection), null);
  });

  it("returns null when the same brand + name is already owned", () => {
    assert.equal(dupesForNewShade({ brand: " essie ", name: "red  hot", hex: "#C0392B", finishes: [] }, collection), null);
  });

  it("reports no dupes when nothing is close", () => {
    const result = dupesForNewShade({ brand: "New", name: "Navy", hex: "#101060", finishes: [] }, collection);
    assert.equal(result?.dupeCount, 0);
  });
});
