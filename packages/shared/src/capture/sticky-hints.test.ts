import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  batchHeaderLabel,
  EMPTY_STICKY_HINTS,
  hintsToStartMetadata,
  isBatchMode,
  parseStickyHints,
  serializeStickyHints,
  stickyHintsStorageKey,
  STICKY_HINT_MAX_LENGTH,
  switchBrand,
  withBrandEcho,
} from "./sticky-hints";

describe("parseStickyHints", () => {
  it("trims values from a JSON string and nulls the rest", () => {
    assert.deepEqual(parseStickyHints('{"brand":" Loud "}'), { ...EMPTY_STICKY_HINTS, brand: "Loud" });
  });

  it("accepts an object", () => {
    assert.deepEqual(parseStickyHints({ brand: "Zoya", finish: "creme", collection: "Spring" }), {
      ...EMPTY_STICKY_HINTS,
      brand: "Zoya",
      finish: "creme",
      collection: "Spring",
    });
  });

  it("drops values over the max length", () => {
    const long = "x".repeat(STICKY_HINT_MAX_LENGTH + 1);
    assert.deepEqual(parseStickyHints({ brand: long }), EMPTY_STICKY_HINTS);
    assert.equal(parseStickyHints({ brand: "x".repeat(STICKY_HINT_MAX_LENGTH) }).brand?.length, STICKY_HINT_MAX_LENGTH);
  });

  it("returns empty for non-objects and bad JSON", () => {
    assert.deepEqual(parseStickyHints(42), EMPTY_STICKY_HINTS);
    assert.deepEqual(parseStickyHints(null), EMPTY_STICKY_HINTS);
    assert.deepEqual(parseStickyHints("not json"), EMPTY_STICKY_HINTS);
    assert.deepEqual(parseStickyHints("[1,2]"), EMPTY_STICKY_HINTS);
  });

  it("treats blank and non-string fields as null", () => {
    assert.deepEqual(parseStickyHints({ brand: "   ", finish: 5, brandId: "" }), EMPTY_STICKY_HINTS);
  });
});

describe("serializeStickyHints", () => {
  it("round-trips", () => {
    const hints = { brand: "Loud", brandCanonical: "Loud Lacquer", brandId: "9", finish: "glitter", collection: null };
    assert.deepEqual(parseStickyHints(serializeStickyHints(hints)), hints);
  });
});

describe("storage key", () => {
  it("is per user with an anon fallback", () => {
    assert.equal(stickyHintsStorageKey(null), "swatchwatch.rapid-add.hints:anon");
    assert.equal(stickyHintsStorageKey(undefined), "swatchwatch.rapid-add.hints:anon");
    assert.equal(stickyHintsStorageKey("12"), "swatchwatch.rapid-add.hints:12");
  });
});

describe("batch mode", () => {
  it("is on only with a non-empty brand", () => {
    assert.equal(isBatchMode(EMPTY_STICKY_HINTS), false);
    assert.equal(isBatchMode({ ...EMPTY_STICKY_HINTS, finish: "creme" }), false);
    assert.equal(isBatchMode({ ...EMPTY_STICKY_HINTS, brand: "Loud" }), true);
  });

  it("labels the batch header, preferring the canonical name", () => {
    assert.equal(batchHeaderLabel(EMPTY_STICKY_HINTS), null);
    assert.equal(batchHeaderLabel({ ...EMPTY_STICKY_HINTS, brand: "loud" }), "Going through: loud");
    assert.equal(
      batchHeaderLabel({ ...EMPTY_STICKY_HINTS, brand: "loud", brandCanonical: "Loud Lacquer" }),
      "Going through: Loud Lacquer",
    );
  });
});

describe("hintsToStartMetadata", () => {
  it("prefers the canonical brand and omits unset keys", () => {
    const meta = hintsToStartMetadata({ ...EMPTY_STICKY_HINTS, brand: "loud", brandCanonical: "Loud Lacquer" });
    assert.deepEqual(meta, { brand: "Loud Lacquer" });
    assert.equal(Object.keys(meta).length, 1);
  });

  it("includes finish and collection when set", () => {
    assert.deepEqual(hintsToStartMetadata({ ...EMPTY_STICKY_HINTS, finish: "creme", collection: "Spring" }), {
      finish: "creme",
      collection: "Spring",
    });
  });

  it("is empty for empty hints", () => {
    assert.deepEqual(hintsToStartMetadata(EMPTY_STICKY_HINTS), {});
  });
});

describe("withBrandEcho", () => {
  const hints = { ...EMPTY_STICKY_HINTS, brand: "loud" };

  it("fills the canonical name and id when the echo matched a catalog brand", () => {
    assert.deepEqual(withBrandEcho(hints, { raw: "loud", brandId: "9", name: "Loud Lacquer" }), {
      ...hints,
      brandCanonical: "Loud Lacquer",
      brandId: "9",
    });
  });

  it("leaves hints alone when the echo has no brand id or is missing", () => {
    assert.deepEqual(withBrandEcho(hints, { raw: "loud", brandId: null, name: "loud" }), hints);
    assert.deepEqual(withBrandEcho(hints, null), hints);
    assert.deepEqual(withBrandEcho(hints, undefined), hints);
  });
});

describe("switchBrand", () => {
  it("sets all three brand fields and keeps the rest", () => {
    const next = switchBrand(
      { ...EMPTY_STICKY_HINTS, brand: "loud", finish: "creme" },
      { brandId: "3", name: "Zoya", source: "read" },
    );
    assert.deepEqual(next, { brand: "Zoya", brandCanonical: "Zoya", brandId: "3", finish: "creme", collection: null });
  });

  it("accepts a brand that is not in the catalog", () => {
    const next = switchBrand(EMPTY_STICKY_HINTS, { brandId: null, name: "Tiny Indie", source: "read" });
    assert.equal(next.brandId, null);
    assert.equal(next.brand, "Tiny Indie");
  });
});
