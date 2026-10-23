/**
 * Manual "Add a polish" form (#109, #21 remainder; web: `/polishes/new`): route params, form
 * validation, the `POST /api/polishes` body and the client-side add guard for a brand-new shade.
 * Pure (no React Native imports) so it is unit-tested directly.
 */
import {
  CANONICAL_FINISHES,
  COLOR_FAMILY_LABELS,
  DUPE_LIMITS,
  buildFinishFamilyMap,
  classifyColorFamily,
  findDupes,
  prepareDupeCandidates,
  prepareDupeShade,
  type DupeShade,
  type FinishFamilySource,
  type FinishName,
  type Polish,
  type PolishCreateRequest,
  type PolishDupesResponse,
} from "swatchwatch-shared";
import { normalizeHexParam } from "./color-search";
import { finishLabel } from "./finishes";

/** Route of the form. */
export const MANUAL_ADD_PATHNAME = "/polishes/new" as const;

/** Most bottles one add takes (the form's + stops here). */
export const MAX_QUANTITY = 99;
/** Longest notes the form accepts. */
export const MAX_NOTES_LENGTH = 2000;
const MAX_NAME_LENGTH = 200;

/** What the form prefills from its route params (web: `scanPrefillFromParams`). */
export interface ManualAddPrefill {
  barcode?: string;
  barcodeFormat?: string;
  brand?: string;
  name?: string;
}

type Param = string | string[] | undefined | null;

function firstParam(value: Param): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.trim() || undefined;
}

/** Read the form's route params, dropping anything malformed (same rules as the web). */
export function manualAddPrefillFromParams(params: {
  barcode?: Param;
  barcodeFormat?: Param;
  brand?: Param;
  name?: Param;
}): ManualAddPrefill {
  const prefill: ManualAddPrefill = {};
  const barcode = firstParam(params.barcode);
  if (barcode && /^\d{8,14}$/.test(barcode)) {
    prefill.barcode = barcode;
    const format = firstParam(params.barcodeFormat);
    if (format && /^[a-z0-9_]{1,16}$/i.test(format)) prefill.barcodeFormat = format;
  }
  const brand = firstParam(params.brand);
  if (brand) prefill.brand = brand.slice(0, MAX_NAME_LENGTH);
  const name = firstParam(params.name);
  if (name) prefill.name = name.slice(0, MAX_NAME_LENGTH);
  return prefill;
}

/**
 * Route to the form, carrying what is known (web: `manualAddHref`). The barcode is sent with
 * the new polish so the next scan of the bottle matches (remembered for this user only).
 */
export function manualAddRoute(evidence: { gtin?: string; format?: string; brand?: string; name?: string }): {
  pathname: typeof MANUAL_ADD_PATHNAME;
  params: Record<string, string>;
} {
  const params: Record<string, string> = {};
  if (evidence.gtin) params.barcode = evidence.gtin;
  if (evidence.gtin && evidence.format) params.barcodeFormat = evidence.format;
  const brand = evidence.brand?.trim();
  if (brand) params.brand = brand;
  const name = evidence.name?.trim();
  if (name) params.name = name;
  return { pathname: MANUAL_ADD_PATHNAME, params };
}

export type ManualAddStatus = "owned" | "wishlist";

export interface ManualAddForm {
  brand: string;
  name: string;
  /** Color name ("Red", "Teal"); optional, derived from the hex when empty. */
  colorName: string;
  /** Hex text as typed or picked; empty = no color. */
  hex: string;
  /** Selected finishes in selection order; the first is the primary finish. */
  finishes: FinishName[];
  status: ManualAddStatus;
  /** Bottles (owned only). */
  quantity: number;
  /** 0 = unrated, else 1–5. */
  rating: number;
  notes: string;
}

export function initialManualAddForm(prefill: ManualAddPrefill): ManualAddForm {
  return {
    brand: prefill.brand ?? "",
    name: prefill.name ?? "",
    colorName: "",
    hex: "",
    finishes: [],
    status: "owned",
    quantity: 1,
    rating: 0,
    notes: "",
  };
}

/** Toggle a finish chip, keeping selection order (the first selected stays primary). */
export function toggleFinish(selected: readonly FinishName[], finish: FinishName): FinishName[] {
  return selected.includes(finish) ? selected.filter((f) => f !== finish) : [...selected, finish];
}

/** Clamp the bottle count to 1…MAX_QUANTITY. */
export function clampQuantity(quantity: number): number {
  if (!Number.isFinite(quantity)) return 1;
  return Math.max(1, Math.min(MAX_QUANTITY, Math.round(quantity)));
}

/** Tapping the current star clears the rating (web form behaviour). */
export function nextRating(current: number, tapped: number): number {
  return current === tapped ? 0 : tapped;
}

export type ManualAddField = "brand" | "name" | "hex" | "quantity" | "rating" | "notes";
export type ManualAddErrors = Partial<Record<ManualAddField, string>>;

/** Field errors; empty when the form can be saved. */
export function validateManualAdd(form: ManualAddForm): ManualAddErrors {
  const errors: ManualAddErrors = {};
  if (!form.brand.trim()) errors.brand = "Enter the brand.";
  else if (form.brand.trim().length > MAX_NAME_LENGTH) errors.brand = "Brand is too long.";
  if (!form.name.trim()) errors.name = "Enter the shade name.";
  else if (form.name.trim().length > MAX_NAME_LENGTH) errors.name = "Shade name is too long.";
  if (form.hex.trim() && !normalizeHexParam(form.hex)) errors.hex = "Use a 6-digit hex such as #C0392B.";
  if (form.status === "owned" && (!Number.isInteger(form.quantity) || form.quantity < 1 || form.quantity > MAX_QUANTITY)) {
    errors.quantity = `Bottles must be 1–${MAX_QUANTITY}.`;
  }
  if (!Number.isInteger(form.rating) || form.rating < 0 || form.rating > 5) errors.rating = "Rating must be 0–5 stars.";
  if (form.notes.length > MAX_NOTES_LENGTH) errors.notes = `Notes are limited to ${MAX_NOTES_LENGTH} characters.`;
  return errors;
}

export function hasErrors(errors: ManualAddErrors): boolean {
  return Object.keys(errors).length > 0;
}

/**
 * The color name to send: what was typed, else the family label of the hex ("Pink"), else
 * empty (the API stores no color name).
 */
export function colorNameFor(form: Pick<ManualAddForm, "colorName" | "hex" | "finishes">): string {
  const typed = form.colorName.trim();
  if (typed) return typed;
  const hex = normalizeHexParam(form.hex);
  if (!hex) return "";
  const family = classifyColorFamily({ vendorHex: hex, finishes: form.finishes });
  return family ? COLOR_FAMILY_LABELS[family] : "";
}

/**
 * `POST /api/polishes` body for a valid form. `status` is always explicit (D5: ownership is
 * status, never quantity); wishlist rows send no quantity. The scanned barcode goes along so
 * the API learns it for this user (`user_shade_barcode`).
 */
export function buildCreateRequest(form: ManualAddForm, prefill: ManualAddPrefill): PolishCreateRequest {
  const hex = normalizeHexParam(form.hex);
  const notes = form.notes.trim();
  const request: PolishCreateRequest = {
    brand: form.brand.trim(),
    name: form.name.trim(),
    color: colorNameFor(form),
    status: form.status,
  };
  if (hex) request.vendorHex = hex;
  if (form.finishes.length > 0) {
    request.finish = form.finishes[0];
    request.finishes = [...form.finishes];
  }
  if (form.status === "owned") request.quantity = clampQuantity(form.quantity);
  if (form.rating > 0) request.rating = form.rating;
  if (notes) request.notes = notes;
  if (prefill.barcode) {
    request.barcode = prefill.barcode;
    if (prefill.barcodeFormat) request.barcodeFormat = prefill.barcodeFormat;
  }
  return request;
}

/** "Wishlist instead" from the add guard: the same polish, as a wishlist row. */
export function asWishlistRequest(request: PolishCreateRequest): PolishCreateRequest {
  const { quantity: _quantity, ...rest } = request;
  return { ...rest, status: "wishlist" };
}

/** A finish chip: value sent to the API, label shown. */
export interface FinishOption {
  value: FinishName;
  label: string;
}

/**
 * Finish chips from the reference `finish_type` rows (admin-created ones included), else the
 * built-in defaults; sorted by label (web: `buildFinishOptions`).
 */
export function buildFinishOptions(
  finishTypes: readonly { name: string; displayName?: string | null }[] | null | undefined,
): FinishOption[] {
  const options: FinishOption[] = [];
  const seen = new Set<string>();
  const add = (value: string, label: string) => {
    const key = value.trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    options.push({ value: value as FinishName, label });
  };
  if (finishTypes && finishTypes.length > 0) {
    for (const finish of finishTypes) add(finish.name, finish.displayName?.trim() || finishLabel(finish.name));
  } else {
    for (const name of CANONICAL_FINISHES) add(name, finishLabel(name));
  }
  return options.sort((a, b) => a.label.localeCompare(b.label));
}

function normalizeName(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Owned near-dupes of a shade that has no id yet (web: `dupesForNewShade` in
 * `lib/add-guard.ts`): the entered hex against the caller's owned polishes with the shared dupe
 * rule. Null when there is nothing to compare (no valid hex) or the caller already owns a polish
 * with the same brand and name (the API then adds to that row instead).
 */
export function dupesForNewShade(
  shade: { brand: string; name: string; hex: string; finishes: readonly string[] },
  owned: readonly Polish[],
  options: { limit?: number; finishTypes?: readonly FinishFamilySource[] | null } = {},
): PolishDupesResponse | null {
  const limit = options.limit ?? DUPE_LIMITS.defaultLimit;
  const brand = normalizeName(shade.brand);
  const name = normalizeName(shade.name);
  const ownedPool = owned.filter((polish) => polish.status === "owned");
  if (
    brand &&
    name &&
    ownedPool.some((polish) => normalizeName(polish.brand) === brand && normalizeName(polish.name) === name)
  ) {
    return null;
  }
  const hex = normalizeHexParam(shade.hex);
  if (!hex) return null;

  const target = prepareDupeShade({
    shadeId: "new",
    brand: shade.brand,
    name: shade.name,
    vendorHex: hex,
    finishes: [...shade.finishes],
  });
  if (!target) return null;

  const candidates = prepareDupeCandidates(
    ownedPool.map(
      (polish): DupeShade => ({
        shadeId: polish.id,
        brand: polish.brand,
        name: polish.name,
        vendorHex: polish.vendorHex,
        detectedHex: polish.detectedHex,
        nameHex: polish.nameHex,
        hexAgreement: polish.hexAgreement,
        finish: polish.finish,
        finishes: polish.finishes,
        // A new shade is a color polish: owned toppers and coats are never its dupes (#349).
        productCategory: polish.productCategory,
      }),
    ),
  );
  const { dupes, candidateCount } = findDupes(target, candidates, {
    finishFamilies: buildFinishFamilyMap(options.finishTypes),
  });
  return {
    target: {
      shadeId: target.shadeId,
      displayHex: target.displayHex,
      displayHexSource: target.displayHexSource,
      finishes: target.finishes,
    },
    dupes: dupes.slice(0, Math.max(1, limit)),
    dupeCount: dupes.length,
    highCount: dupes.filter((dupe) => dupe.grade === "high").length,
    candidateCount,
  };
}
