import type { Polish } from "swatchwatch-shared";
import { undertone, type Undertone } from "./color-utils.ts";

export type InventoryAvailabilityFilter = "all" | "owned" | "wishlist";

interface ListFilterInput {
  polishes: Polish[];
  search: string;
  includeAll: boolean;
  toneFilter: Undertone | "all";
  brandFilter: string;
  finishFilter: string;
  availabilityFilter: InventoryAvailabilityFilter;
}

export function normalizeBrand(value: string): string {
  return value.trim().toLowerCase();
}

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

export function matchesBrandFilter(brand: string, brandFilter: string): boolean {
  return normalizeBrand(brand) === normalizeBrand(brandFilter);
}

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

  if (!includeAll) {
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
