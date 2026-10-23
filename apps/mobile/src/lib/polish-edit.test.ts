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
    assert.deepEqual(form, { rating: 4, notes: "nice", quantity: 2, price: "12.00", currency: "USD", purchaseDate: "2026-03-04" });
    assert.equal(priceToInput(null), "");
  });

  it("clears a star only when nothing was saved", () => {
    assert.equal(nextEditRating(3, 3, null), 0);
    assert.equal(nextEditRating(3, 3, 3), 3);
    assert.equal(nextEditRating(3, 5, 3), 5);
  });

  it("validates", () => {
    const base = polish();
    const ok = initialEditForm(base, "USD");
    assert.deepEqual(validateEditForm(ok, base, "2026-10-23"), {});
    assert.ok(validateEditForm({ ...ok, price: "x" }, base, "2026-10-23").price);
    assert.ok(validateEditForm({ ...ok, purchaseDate: "2027-01-01" }, base, "2026-10-23").purchaseDate);
    assert.ok(validateEditForm({ ...ok, notes: "x".repeat(2001) }, base, "2026-10-23").notes);
    assert.ok(validateEditForm({ ...ok, quantity: 0 }, base, "2026-10-23").quantity);
    const saved = polish({ rating: 3, purchaseDate: "2026-01-01" });
    const cleared = { ...initialEditForm(saved, "USD"), rating: 0, purchaseDate: "" };
    const errors = validateEditForm(cleared, saved, "2026-10-23");
    assert.ok(errors.rating && errors.purchaseDate);
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
