/**
 * "Edit details" sheet on the polish detail screen (#109; web: the edit mode of
 * `/polishes/new`): the form state, locale-safe price parsing, validation, the
 * `PUT /api/polishes/{id}` patch (only fields that changed) and the optimistic merge.
 * Pure (no React Native imports) so it is unit-tested directly.
 *
 * Server limits this mirrors (`upsertInventoryItem`): a missing/null `rating`, `purchaseDate`
 * or `notes` means "unchanged", so a saved rating or purchase date can be changed but not
 * removed yet (notes clear with an empty string; price and currency clear with `null`).
 */
import type { Polish, PolishUpdateRequest } from "swatchwatch-shared";
import { MAX_NOTES_LENGTH, MAX_QUANTITY, clampQuantity } from "./manual-add";

export { MAX_NOTES_LENGTH, MAX_QUANTITY, clampQuantity };

/** Largest price `NUMERIC(10,2)` holds (matches `MAX_PURCHASE_PRICE` in the API). */
export const MAX_PURCHASE_PRICE = 99_999_999.99;

/** Currencies offered in the picker (ISO 4217); a saved currency outside the list is added. */
export const CURRENCY_CODES = [
  "USD", "EUR", "GBP", "CAD", "AUD", "NZD", "JPY", "KRW", "CNY", "HKD",
  "SGD", "CHF", "SEK", "NOK", "DKK", "MXN", "BRL", "INR", "ZAR", "PLN",
] as const;

/** Region (from a BCP 47 locale such as `en-GB`) → default currency, for the common cases. */
const REGION_CURRENCY: Record<string, string> = {
  US: "USD", CA: "CAD", GB: "GBP", AU: "AUD", NZ: "NZD", JP: "JPY", KR: "KRW", CN: "CNY", HK: "HKD", SG: "SGD",
  CH: "CHF", SE: "SEK", NO: "NOK", DK: "DKK", MX: "MXN", BR: "BRL", IN: "INR", ZA: "ZAR", PL: "PLN",
  DE: "EUR", FR: "EUR", ES: "EUR", IT: "EUR", NL: "EUR", BE: "EUR", AT: "EUR", IE: "EUR", PT: "EUR", FI: "EUR", GR: "EUR",
};

/** Default currency: the one on this polish, else the last one the user saved, else the device locale's, else USD. */
export function defaultCurrency(options: { existing?: string | null; lastUsed?: string | null; locale?: string | null }): string {
  for (const candidate of [options.existing, options.lastUsed]) {
    const code = candidate?.trim().toUpperCase();
    if (code && /^[A-Z]{3}$/.test(code)) return code;
  }
  const region = options.locale?.match(/[-_]([A-Za-z]{2})(?:$|[-_])/)?.[1]?.toUpperCase();
  return (region && REGION_CURRENCY[region]) || "USD";
}

/** The picker's currencies, with `extra` (a saved currency not in the list) first. */
export function currencyOptions(extra?: string | null): string[] {
  const code = extra?.trim().toUpperCase();
  return code && /^[A-Z]{3}$/.test(code) && !(CURRENCY_CODES as readonly string[]).includes(code) ? [code, ...CURRENCY_CODES] : [...CURRENCY_CODES];
}

export type PriceParse = { ok: true; value: number | null } | { ok: false; error: string };

const PRICE_FORMAT_ERROR = "Enter a price such as 12.50.";

/**
 * Parse a typed price without relying on the device locale: `12.50`, `12,50`, `$1,234.56`,
 * `1.234,56` and `1 234,56` all work. Empty = no price (`value: null`). With one kind of
 * separator, groups of exactly three digits after a leading 1–3 digit group are thousands
 * (`1,234` = 1234) and anything else is the decimal point (`12,5` = 12.5).
 */
export function parsePriceInput(text: string): PriceParse {
  const cleaned = text.replace(/[\s  '’]/g, "").replace(/\p{Sc}/gu, "");
  if (!cleaned) return { ok: true, value: null };
  if (cleaned.startsWith("-")) return { ok: false, error: "A price can't be negative." };
  if (!/^[\d.,]+$/.test(cleaned) || !/\d/.test(cleaned)) return { ok: false, error: PRICE_FORMAT_ERROR };

  const lastDot = cleaned.lastIndexOf(".");
  const lastComma = cleaned.lastIndexOf(",");
  let integerPart = cleaned;
  let fraction = "";
  if (lastDot >= 0 && lastComma >= 0) {
    const decimalAt = Math.max(lastDot, lastComma);
    const decimalChar = cleaned[decimalAt];
    const groupChar = decimalChar === "." ? "," : ".";
    const head = cleaned.slice(0, decimalAt);
    fraction = cleaned.slice(decimalAt + 1);
    if (head.includes(decimalChar)) return { ok: false, error: PRICE_FORMAT_ERROR };
    const groups = head.split(groupChar);
    if (groups[0].length === 0 || groups[0].length > 3 || groups.slice(1).some((g) => g.length !== 3)) {
      return { ok: false, error: PRICE_FORMAT_ERROR };
    }
    integerPart = groups.join("");
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? "." : ",";
    const parts = cleaned.split(sep);
    const last = parts[parts.length - 1];
    const thousands = parts.length > 2 || (parts.length === 2 && last.length === 3 && parts[0].length >= 1 && parts[0].length <= 3);
    if (thousands) {
      if (parts[0].length === 0 || parts[0].length > 3 || parts.slice(1).some((p) => p.length !== 3)) {
        return { ok: false, error: PRICE_FORMAT_ERROR };
      }
      integerPart = parts.join("");
    } else {
      integerPart = parts[0];
      fraction = last;
    }
  }
  if (integerPart === "" && fraction === "") return { ok: false, error: PRICE_FORMAT_ERROR };
  if (!/^\d*$/.test(integerPart) || !/^\d*$/.test(fraction)) return { ok: false, error: PRICE_FORMAT_ERROR };
  if (fraction.length > 2) return { ok: false, error: "Use at most 2 decimal places." };
  const value = Number(`${integerPart || "0"}.${fraction || "0"}`);
  if (!Number.isFinite(value)) return { ok: false, error: PRICE_FORMAT_ERROR };
  if (value > MAX_PURCHASE_PRICE) return { ok: false, error: "That price is too large." };
  return { ok: true, value: Math.round(value * 100) / 100 };
}

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date `YYYY-MM-DD` (no 2026-02-30), not later than `today` when given. */
export function isValidPurchaseDate(value: string, today?: string): boolean {
  const match = YMD_RE.exec(value);
  if (!match) return false;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return false;
  return !today || value <= today;
}

/** "12.50" for an input box from a saved price (always a dot, so it round-trips through `parsePriceInput`). */
export function priceToInput(price: number | null | undefined): string {
  return typeof price === "number" && Number.isFinite(price) ? price.toFixed(2) : "";
}

export interface PolishEditForm {
  /** 0 = unrated, else 1–5. */
  rating: number;
  notes: string;
  /** Bottles (owned only). */
  quantity: number;
  /** Price text as typed; empty = none. */
  price: string;
  currency: string;
  /** `YYYY-MM-DD` as typed; empty = none. */
  purchaseDate: string;
}

export function initialEditForm(polish: Polish, currency: string): PolishEditForm {
  return {
    rating: polish.rating && polish.rating >= 1 && polish.rating <= 5 ? Math.round(polish.rating) : 0,
    notes: polish.notes ?? "",
    quantity: clampQuantity(polish.quantity ?? 1),
    price: priceToInput(polish.purchasePrice),
    currency,
    purchaseDate: polish.purchaseDate ? polish.purchaseDate.slice(0, 10) : "",
  };
}

/** Tapping the current star clears the rating, unless a saved rating exists (the API can't remove one yet). */
export function nextEditRating(current: number, tapped: number, saved: number | null | undefined): number {
  if (current !== tapped) return tapped;
  return saved ? current : 0;
}

export type PolishEditField = "notes" | "price" | "purchaseDate" | "rating" | "quantity";
export type PolishEditErrors = Partial<Record<PolishEditField, string>>;

/** Field errors; empty when the form can be saved. `today` bounds the purchase date. */
export function validateEditForm(form: PolishEditForm, polish: Polish, today: string): PolishEditErrors {
  const errors: PolishEditErrors = {};
  if (form.notes.length > MAX_NOTES_LENGTH) errors.notes = `Notes are limited to ${MAX_NOTES_LENGTH} characters.`;
  const price = parsePriceInput(form.price);
  if (!price.ok) errors.price = price.error;
  const date = form.purchaseDate.trim();
  if (date) {
    if (!isValidPurchaseDate(date, today)) errors.purchaseDate = "Use a date like 2026-03-04, no later than today.";
  } else if (polish.purchaseDate) {
    errors.purchaseDate = "A saved purchase date can be changed but not removed yet.";
  }
  if (!Number.isInteger(form.rating) || form.rating < 0 || form.rating > 5) errors.rating = "Rating must be 0–5 stars.";
  else if (form.rating === 0 && polish.rating) errors.rating = "A saved rating can be changed but not removed yet.";
  if (polish.status === "owned" && (!Number.isInteger(form.quantity) || form.quantity < 1 || form.quantity > MAX_QUANTITY)) {
    errors.quantity = `Bottles must be 1–${MAX_QUANTITY}.`;
  }
  return errors;
}

export function hasEditErrors(errors: PolishEditErrors): boolean {
  return Object.keys(errors).length > 0;
}

/**
 * The `PUT /api/polishes/{id}` body for a valid form: only fields that differ from the polish.
 * `brand` / `name` / `color` are required by the type but an update by id ignores catalog
 * changes for a shared shade, so the current values go along (brand + name unchanged keeps the
 * edit on this shade). Returns null when nothing changed.
 */
export function buildEditPatch(form: PolishEditForm, polish: Polish): PolishUpdateRequest | null {
  const patch: PolishUpdateRequest = {};
  if (form.rating >= 1 && form.rating !== (polish.rating ?? 0)) patch.rating = form.rating;
  const notes = form.notes.trim();
  if (notes !== (polish.notes ?? "").trim()) patch.notes = notes;
  if (polish.status === "owned") {
    const quantity = clampQuantity(form.quantity);
    if (quantity !== (polish.quantity ?? 1)) patch.quantity = quantity;
  }
  const parsed = parsePriceInput(form.price);
  const price = parsed.ok ? parsed.value : null;
  const currency = form.currency.trim().toUpperCase();
  const savedPrice = polish.purchasePrice ?? null;
  const savedCurrency = polish.purchaseCurrency ?? null;
  if (price === null) {
    if (savedPrice !== null) {
      patch.purchasePrice = null;
      patch.purchaseCurrency = null;
    }
  } else if (price !== savedPrice || currency !== savedCurrency) {
    patch.purchasePrice = price;
    patch.purchaseCurrency = currency;
  }
  const date = form.purchaseDate.trim();
  if (date && date !== (polish.purchaseDate ?? "").slice(0, 10)) patch.purchaseDate = date;
  if (Object.keys(patch).length === 0) return null;
  return { brand: polish.brand, name: polish.name, color: polish.color, ...patch };
}

/** The polish as it will look once `patch` is saved (optimistic update). */
export function applyEditPatch(polish: Polish, patch: PolishUpdateRequest): Polish {
  const next: Polish = { ...polish };
  if (patch.rating !== undefined) next.rating = patch.rating;
  if (patch.notes !== undefined) next.notes = patch.notes;
  if (patch.quantity !== undefined) next.quantity = patch.quantity;
  if (patch.purchasePrice !== undefined) next.purchasePrice = patch.purchasePrice;
  if (patch.purchaseCurrency !== undefined) next.purchaseCurrency = patch.purchaseCurrency;
  if (patch.purchaseDate !== undefined) next.purchaseDate = patch.purchaseDate;
  return next;
}

/** "Paid $12.00 · 2026-03-04", or null when neither a price nor a date is saved. */
export function formatPurchaseLine(
  polish: Pick<Polish, "purchasePrice" | "purchaseCurrency" | "purchaseDate">,
  locale?: string,
): string | null {
  const parts: string[] = [];
  const price = polish.purchasePrice;
  if (typeof price === "number" && Number.isFinite(price) && price >= 0) {
    const currency = polish.purchaseCurrency;
    let text: string;
    if (currency && /^[A-Z]{3}$/.test(currency)) {
      try {
        text = new Intl.NumberFormat(locale, { style: "currency", currency }).format(price);
      } catch {
        text = `${price.toFixed(2)} ${currency}`;
      }
    } else {
      text = price.toFixed(2);
    }
    parts.push(`Paid ${text}`);
  }
  const date = polish.purchaseDate?.slice(0, 10);
  if (date && isValidPurchaseDate(date)) parts.push(parts.length ? date : `Bought ${date}`);
  return parts.length ? parts.join(" · ") : null;
}
