import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Polish } from "swatchwatch-shared";
import {
  applyEditPatch,
  buildEditPatch,
  currencyOptions,
  defaultCurrency,
  formatPurchaseLine,
  initialEditForm,
  isValidPurchaseDate,
  nextEditRating,
  parsePriceInput,
  priceToInput,
  validateEditForm,
} from "./polish-edit";

const polish = (extra: Partial<Polish> = {}): Polish =>
  ({ id: "7", brand: "Holo Taco", name: "Scattered", color: "Pink", status: "owned", quantity: 1, createdAt: "", updatedAt: "", ...extra }) as Polish;

const value = (text: string) => {
  const r = parsePriceInput(text);
  assert.ok(r.ok, `expected ${text} to parse`);
  return r.value;
};

describe("parsePriceInput", () => {
  it("parses dot and comma decimals", () => {
    assert.equal(value("12.50"), 12.5);
    assert.equal(value("12,50"), 12.5);
    assert.equal(value("12,5"), 12.5);
    assert.equal(value("$ 12"), 12);
    assert.equal(value("€12,99"), 12.99);
  });
  it("handles thousands separators in either style", () => {
    assert.equal(value("1,234.56"), 1234.56);
    assert.equal(value("1.234,56"), 1234.56);
    assert.equal(value("1 234,56"), 1234.56);
    assert.equal(value("1,234"), 1234);
    assert.equal(value("1,234,567"), 1234567);
  });
  it("does not read a leading zero as a thousands group", () => {
    assert.equal(parsePriceInput("0.125").ok, false);
    assert.equal(value("0,50"), 0.5);
    assert.equal(parsePriceInput("0,500").ok, false);
    assert.equal(parsePriceInput("0,500,000").ok, false);
    assert.equal(value("1,234.50"), 1234.5);
    assert.equal(value("0.12"), 0.12);
  });
  it("treats empty as no price", () => {
    assert.equal(value(""), null);
    assert.equal(value("  "), null);
  });
  it("rejects bad input", () => {
    for (const bad of ["abc", "-5", "12.3456", "1.2.3", "12,34,56", ".", "1234567890123"]) {
      assert.equal(parsePriceInput(bad).ok, false, bad);
    }
  });
  it("accepts a bare decimal", () => {
    assert.equal(value(".5"), 0.5);
  });
});

describe("dates", () => {
  it("validates real calendar dates", () => {
    assert.equal(isValidPurchaseDate("2026-03-04"), true);
    assert.equal(isValidPurchaseDate("2026-02-30"), false);
    assert.equal(isValidPurchaseDate("2026-3-4"), false);
    assert.equal(isValidPurchaseDate("2026-03-05", "2026-03-04"), false);
    assert.equal(isValidPurchaseDate("2026-03-04", "2026-03-04"), true);
  });
});

describe("currency", () => {
  it("prefers existing, then last used, then locale, then USD", () => {
    assert.equal(defaultCurrency({ existing: "eur", lastUsed: "GBP", locale: "en-US" }), "EUR");
    assert.equal(defaultCurrency({ lastUsed: "GBP", locale: "en-US" }), "GBP");
    assert.equal(defaultCurrency({ locale: "en-GB" }), "GBP");
    assert.equal(defaultCurrency({ locale: "de_DE" }), "EUR");
    assert.equal(defaultCurrency({ locale: "xx" }), "USD");
    assert.equal(defaultCurrency({ existing: "EU" }), "USD");
  });
  it("adds an unlisted saved currency first", () => {
    assert.equal(currencyOptions("TRY")[0], "TRY");
    assert.equal(currencyOptions("USD")[0], "USD");
    assert.equal(currencyOptions("USD").length, currencyOptions().length);
  });
});

describe("edit form", () => {
  it("seeds from the polish", () => {
    const form = initialEditForm(
      polish({ rating: 4, notes: "nice", quantity: 2, purchasePrice: 12, purchaseCurrency: "USD", purchaseDate: "2026-03-04T00:00:00Z" }),
      "USD",
    );
    assert.deepEqual(form, {
      rating: 4, notes: "nice", quantity: 2, price: "12.00", currency: "USD", purchaseDate: "2026-03-04",
      brand: "Holo Taco", name: "Scattered", colorName: "Pink", hex: "", finishes: [],
    });
    assert.equal(priceToInput(null), "");
  });

  it("clears a star by tapping it again", () => {
    assert.equal(nextEditRating(3, 3), 0);
    assert.equal(nextEditRating(3, 5), 5);
  });

  it("validates", () => {
    const base = polish();
    const ok = initialEditForm(base, "USD");
    assert.deepEqual(validateEditForm(ok, base, "2026-10-23"), {});
    assert.ok(validateEditForm({ ...ok, price: "x" }, base, "2026-10-23").price);
    assert.ok(validateEditForm({ ...ok, purchaseDate: "2027-01-01" }, base, "2026-10-23").purchaseDate);
    assert.ok(validateEditForm({ ...ok, notes: "x".repeat(2001) }, base, "2026-10-23").notes);
    assert.ok(validateEditForm({ ...ok, quantity: 0 }, base, "2026-10-23").quantity);
    // A saved rating and purchase date can be cleared.
    const saved = polish({ rating: 3, purchaseDate: "2026-01-01" });
    const cleared = { ...initialEditForm(saved, "USD"), rating: 0, purchaseDate: "" };
    assert.deepEqual(validateEditForm(cleared, saved, "2026-10-23"), {});
  });

  it("validates the catalog fields only for the caller's own private shade", () => {
    const shared = polish({ vendorHex: "#112233" });
    const blank = { ...initialEditForm(shared, "USD"), brand: "", name: "", hex: "zzz" };
    assert.deepEqual(validateEditForm(blank, shared, "2026-10-23"), {});
    const own = polish({ ownSubmitted: true, vendorHex: "#112233" });
    const errors = validateEditForm(blank, own, "2026-10-23");
    assert.ok(errors.brand && errors.name && errors.hex);
    assert.ok(validateEditForm({ ...initialEditForm(own, "USD"), hex: "" }, own, "2026-10-23").hex);
    assert.deepEqual(validateEditForm(initialEditForm(own, "USD"), own, "2026-10-23"), {});
  });

  it("ignores quantity for wishlist rows", () => {
    const wish = polish({ status: "wishlist", quantity: 0 });
    const form = initialEditForm(wish, "USD");
    assert.deepEqual(validateEditForm({ ...form, quantity: 0 }, wish, "2026-10-23"), {});
    assert.equal(buildEditPatch({ ...form, notes: "x" }, wish)?.quantity, undefined);
  });
});

describe("buildEditPatch", () => {
  it("is null when nothing changed", () => {
    const p = polish({ rating: 4, notes: "n", purchasePrice: 9.5, purchaseCurrency: "USD", purchaseDate: "2026-01-02" });
    assert.equal(buildEditPatch(initialEditForm(p, "USD"), p), null);
  });

  it("sends only changed fields, with the identity fields", () => {
    const p = polish();
    const form = { ...initialEditForm(p, "USD"), rating: 5, quantity: 3, price: "12,50", purchaseDate: "2026-03-04", notes: "  lovely " };
    assert.deepEqual(buildEditPatch(form, p), {
      brand: "Holo Taco",
      name: "Scattered",
      color: "Pink",
      rating: 5,
      notes: "lovely",
      quantity: 3,
      purchasePrice: 12.5,
      purchaseCurrency: "USD",
      purchaseDate: "2026-03-04",
    });
  });

  it("sends the currency with the price when only the currency changed", () => {
    const p = polish({ purchasePrice: 10, purchaseCurrency: "USD" });
    const patch = buildEditPatch({ ...initialEditForm(p, "USD"), currency: "EUR" }, p);
    assert.equal(patch?.purchasePrice, 10);
    assert.equal(patch?.purchaseCurrency, "EUR");
  });

  it("clears price and currency together, and notes with an empty string", () => {
    const p = polish({ notes: "old", purchasePrice: 10, purchaseCurrency: "USD" });
    const patch = buildEditPatch({ ...initialEditForm(p, "USD"), price: "", notes: "" }, p);
    assert.equal(patch?.purchasePrice, null);
    assert.equal(patch?.purchaseCurrency, null);
    assert.equal(patch?.notes, "");
  });

  it("clears a saved rating and purchase date with null, and keeps them when untouched", () => {
    const p = polish({ rating: 3, purchaseDate: "2026-01-01T00:00:00Z" });
    const base = initialEditForm(p, "USD");
    assert.equal(buildEditPatch(base, p), null);
    const patch = buildEditPatch({ ...base, rating: 0, purchaseDate: "" }, p);
    assert.equal(patch?.rating, null);
    assert.equal(patch?.purchaseDate, null);
    assert.ok("rating" in (patch ?? {}) && "purchaseDate" in (patch ?? {}));
    // Nothing saved, nothing to clear: the keys are omitted (undefined means unchanged).
    const none = polish();
    const notes = buildEditPatch({ ...initialEditForm(none, "USD"), notes: "x" }, none);
    assert.ok(notes && !("rating" in notes) && !("purchaseDate" in notes));
    const next = applyEditPatch(p, patch!);
    assert.equal(next.rating, undefined);
    assert.equal(next.purchaseDate, undefined);
  });

  it("never sends catalog fields for a shared shade", () => {
    const p = polish({ vendorHex: "#112233", finishes: ["creme"] });
    const form = { ...initialEditForm(p, "USD"), brand: "Other", name: "Renamed", hex: "#FF0000", finishes: ["shimmer" as const], notes: "n" };
    assert.deepEqual(buildEditPatch(form, p), { brand: "Holo Taco", name: "Scattered", color: "Pink", notes: "n" });
  });

  it("sends corrected brand, name, finishes and color for the caller's own private shade", () => {
    const p = polish({ ownSubmitted: true, vendorHex: "#112233", finishes: ["creme"], finish: "creme" });
    const base = initialEditForm(p, "USD");
    assert.deepEqual(base.finishes, ["creme"]);
    assert.equal(base.hex, "#112233");
    assert.equal(buildEditPatch(base, p), null);
    const patch = buildEditPatch(
      { ...base, brand: " Indie Co ", name: "Midnight", colorName: "Navy", hex: "#0a1b3c", finishes: ["shimmer", "holographic"] },
      p,
    );
    assert.deepEqual(patch, {
      brand: "Indie Co",
      name: "Midnight",
      color: "Navy",
      vendorHex: "#0A1B3C",
      finish: "shimmer",
      finishes: ["shimmer", "holographic"],
    });
    const next = applyEditPatch(p, patch!);
    assert.equal(next.brand, "Indie Co");
    assert.deepEqual(next.finishes, ["shimmer", "holographic"]);
    assert.equal(next.vendorHex, "#0A1B3C");
  });

  it("keeps the existing color name when only finishes change on an own shade", () => {
    const p = polish({ ownSubmitted: true, vendorHex: "#112233", finishes: ["creme"] });
    const patch = buildEditPatch({ ...initialEditForm(p, "USD"), finishes: [] }, p);
    assert.deepEqual(patch, { brand: "Holo Taco", name: "Scattered", color: "Pink", finishes: [] });
  });

  it("applies the patch optimistically", () => {
    const p = polish({ notes: "old" });
    const patch = buildEditPatch({ ...initialEditForm(p, "USD"), notes: "new", rating: 2 }, p);
    assert.ok(patch);
    const next = applyEditPatch(p, patch);
    assert.equal(next.notes, "new");
    assert.equal(next.rating, 2);
    assert.equal(p.notes, "old");
  });
});

describe("formatPurchaseLine", () => {
  it("formats price and date", () => {
    assert.equal(formatPurchaseLine({ purchasePrice: 12, purchaseCurrency: "USD", purchaseDate: "2026-03-04" }, "en-US"), "Paid $12.00 · 2026-03-04");
    assert.equal(formatPurchaseLine({ purchasePrice: 12 }, "en-US"), "Paid 12.00");
    assert.equal(formatPurchaseLine({ purchaseDate: "2026-03-04" }), "Bought 2026-03-04");
    assert.equal(formatPurchaseLine({}), null);
  });
});
