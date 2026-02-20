import type { Polish } from "swatchwatch-shared";
import { undertone, type Undertone } from "./color-utils";

/** Inventory availability mode used by list filtering. */
export type InventoryAvailabilityFilter = "all" | "owned" | "wishlist";

/** Inputs used by `filterPolishesForList`. */
export interface ListFilterInput {
  /** Source polish rows to filter. */
  polishes: Polish[];
  /** Free-text query matched against name/brand/color/collection/notes. */
  search: string;
  /** When true, include owned + wishlist rows unless overridden by availabilityFilter. */
  includeAll: boolean;
  /** Undertone filter derived from vendor/detected/name hex values. */
  toneFilter: Undertone | "all";
  /** Brand filter value, or `"all"` to disable brand filtering. */
  brandFilter: string;
  /** Exact finish value, or `"all"` to disable finish filtering. */
  finishFilter: string;
  /** Explicit availability filter (takes precedence over includeAll when not `"all"`). */
  availabilityFilter: InventoryAvailabilityFilter;
}

/** Trim + lowercase a brand value so brand comparisons are case/whitespace insensitive. */
export function normalizeBrand(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Build sorted brand options from polish rows.
 * Deduplicates by normalized brand key while preserving first-seen original casing.
 */
export function buildBrandOptions(polishes: Array<Pick<Polish, "brand">>): string[] {
  const brandsByKey = new Map<string, string>();
  for (const polish of polishes) {
    const brand = polish.brand.trim();
    if (!brand) continue;
    const key = normalizeBrand(brand);
    if (!brandsByKey.has(key)) {
      brandsByKey.set(key, brand);
    }
  }
  return [...brandsByKey.values()].sort((a, b) => a.localeCompare(b));
}

/** Return true when a polish brand matches the active brand filter (case/whitespace insensitive). */
export function matchesBrandFilter(brand: string, brandFilter: string): boolean {
  return normalizeBrand(brand) === normalizeBrand(brandFilter);
}

/**
 * Filter polish rows in this order: search, owned-only (includeAll), undertone, brand, finish, availability.
 * When `availabilityFilter !== "all"`, availability filtering takes precedence and the includeAll-owned filter is skipped.
 */
export function filterPolishesForList(input: ListFilterInput): Polish[] {
  const {
    polishes,
    search,
    includeAll,
    toneFilter,
    brandFilter,
    finishFilter,
    availabilityFilter,
  } = input;

  const isOwned = (p: Polish) => (p.quantity ?? 0) > 0;

  let result = polishes;

  if (search) {
    const q = search.toLowerCase();
    result = result.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.brand.toLowerCase().includes(q) ||
        (p.color && p.color.toLowerCase().includes(q)) ||
        (p.collection && p.collection.toLowerCase().includes(q)) ||
        (p.notes && p.notes.toLowerCase().includes(q))
    );
  }

  if (availabilityFilter === "all" && !includeAll) {
    result = result.filter(isOwned);
  }

  if (toneFilter !== "all") {
    result = result.filter((p) => {
      const hex = p.vendorHex || p.detectedHex || p.nameHex || undefined;
      return hex && undertone(hex) === toneFilter;
    });
  }

  if (brandFilter !== "all") {
    result = result.filter((p) => matchesBrandFilter(p.brand, brandFilter));
  }

  if (finishFilter !== "all") {
    result = result.filter((p) => p.finish === finishFilter);
  }

  if (availabilityFilter !== "all") {
    result = result.filter((p) =>
      availabilityFilter === "owned" ? isOwned(p) : !isOwned(p)
    );
  }

  return result;
}
