import {
  COLOR_FAMILIES,
  PRODUCT_CATEGORIES,
  isColorFamily,
  isProductCategory,
  type ColorFamily,
  type PolishFilters,
  type PolishStatus,
  type ProductCategory,
} from "swatchwatch-shared";
import { COLLECTION_PRESETS, type CollectionPreset } from "./status";

/**
 * Collection tab view state (web: `/polishes` list state, `apps/web/src/lib/polish-list-url.ts`).
 * Param names for deep links (`/?family=red&untried=1`) match the web URL: `status`, `untried`,
 * `family`, `category`, `sort`, `dir`.
 */

/** Status presets without the combined "Untried" chip: untried is its own flag (D5, derived). */
export type StatusPresetKey = Exclude<CollectionPreset["key"], "untried">;

export type CollectionSortKey = "recent" | "brand" | "name" | "finish" | "rating";

export interface CollectionSortOption {
  key: CollectionSortKey;
  label: string;
  sortBy: NonNullable<PolishFilters["sortBy"]>;
  sortOrder: "asc" | "desc";
}

/** What `GET /api/polishes` can order by (last worn / wear count are not server sorts). */
export const COLLECTION_SORTS: readonly CollectionSortOption[] = [
  { key: "recent", label: "Recently added", sortBy: "createdAt", sortOrder: "desc" },
  { key: "brand", label: "Brand", sortBy: "brand", sortOrder: "asc" },
  { key: "name", label: "Name", sortBy: "name", sortOrder: "asc" },
  { key: "finish", label: "Finish", sortBy: "finish", sortOrder: "asc" },
  { key: "rating", label: "Rating", sortBy: "rating", sortOrder: "desc" },
];

export interface CollectionView {
  preset: StatusPresetKey;
  /** Only owned rows that were never tried; meaningful for the `owned` preset only. */
  untried: boolean;
  families: ColorFamily[];
  categories: ProductCategory[];
  sort: CollectionSortKey;
}

export const DEFAULT_COLLECTION_VIEW: CollectionView = {
  preset: "owned",
  untried: false,
  families: [],
  categories: [],
  sort: "recent",
};

const STATUS_PRESETS = COLLECTION_PRESETS.filter((p) => p.key !== "untried");

function presetFor(statuses: PolishStatus[]): StatusPresetKey | null {
  const key = [...statuses].sort().join(",");
  const match = STATUS_PRESETS.find((p) => [...(p.filters.status ?? [])].sort().join(",") === key);
  return match ? (match.key as StatusPresetKey) : null;
}

/** Families in canonical order; unknown values dropped, `gray` read as `grey` (web parity). */
export function parseFamilies(value: string | null | undefined): ColorFamily[] {
  if (!value) return [];
  const wanted = new Set(
    value
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .map((part) => (part === "gray" ? "grey" : part))
      .filter(isColorFamily),
  );
  return COLOR_FAMILIES.filter((f) => wanted.has(f));
}

/** Categories in canonical order; `top-coat` / `top coat` spellings accepted like the API. */
export function parseCategories(value: string | null | undefined): ProductCategory[] {
  if (!value) return [];
  const wanted = new Set(
    value
      .split(",")
      .map((part) => part.trim().toLowerCase().replace(/[\s-]+/g, "_"))
      .map((part) => (part === "topcoat" ? "top_coat" : part === "basecoat" ? "base_coat" : part === "toppers" ? "topper" : part))
      .filter(isProductCategory),
  );
  return PRODUCT_CATEGORIES.filter((c) => wanted.has(c));
}

function flag(value: string | null | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return v === "1" || v === "true";
}

/** Deep-link params (all optional, unknown values ignored) → view. */
export function parseCollectionParams(params: {
  status?: string | string[];
  untried?: string | string[];
  family?: string | string[];
  category?: string | string[];
  sort?: string | string[];
}): CollectionView {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const statuses = (one(params.status) ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is PolishStatus => ["owned", "wishlist", "destash", "archived"].includes(s));
  const preset = statuses.length > 0 ? (presetFor(statuses) ?? DEFAULT_COLLECTION_VIEW.preset) : DEFAULT_COLLECTION_VIEW.preset;
  const sort = one(params.sort);
  return {
    preset,
    // Untried implies owned (a bare `?untried=1` is the owned preset).
    untried: flag(one(params.untried)) && preset === "owned",
    families: parseFamilies(one(params.family)),
    categories: parseCategories(one(params.category)),
    sort: COLLECTION_SORTS.some((s) => s.key === sort) ? (sort as CollectionSortKey) : DEFAULT_COLLECTION_VIEW.sort,
  };
}

/** Stable string for a view, used to notice a changed deep link. */
export function collectionViewKey(view: CollectionView): string {
  return [view.preset, view.untried ? 1 : 0, view.families.join(","), view.categories.join(","), view.sort].join("|");
}

export function toggleInList<T>(list: readonly T[], value: T, order: readonly T[]): T[] {
  const next = new Set(list);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return order.filter((item) => next.has(item));
}

/** Switching away from owned clears the untried flag (untried = owned and never tried). */
export function setPreset(view: CollectionView, preset: StatusPresetKey): CollectionView {
  return { ...view, preset, untried: preset === "owned" ? view.untried : false };
}

/** Number of filters beyond the default view (status preset excluded), for the badge. */
export function activeFilterCount(view: CollectionView): number {
  return (
    (view.untried ? 1 : 0) +
    view.families.length +
    view.categories.length +
    (view.sort !== DEFAULT_COLLECTION_VIEW.sort ? 1 : 0)
  );
}

/** Clear everything the filter bar owns; the status preset stays. */
export function clearBarFilters(view: CollectionView): CollectionView {
  return { ...view, untried: false, families: [], categories: [], sort: DEFAULT_COLLECTION_VIEW.sort };
}

/** View + search text → `GET /api/polishes` filters. */
export function toPolishFilters(view: CollectionView, search?: string): PolishFilters {
  const preset = STATUS_PRESETS.find((p) => p.key === view.preset) ?? STATUS_PRESETS[0];
  const sort = COLLECTION_SORTS.find((s) => s.key === view.sort) ?? COLLECTION_SORTS[0];
  return {
    status: preset.filters.status,
    ...(view.untried && view.preset === "owned" ? { untried: true } : {}),
    ...(view.families.length > 0 ? { families: view.families } : {}),
    ...(view.categories.length > 0 ? { categories: view.categories } : {}),
    search: search || undefined,
    sortBy: sort.sortBy,
    sortOrder: sort.sortOrder,
  };
}

/**
 * Cache key for a filter set: defined, non-empty values only, keys sorted, so equal filter sets
 * always share a key (and never mix with another set's cached first page).
 */
export function polishFiltersKey(filters: PolishFilters): string {
  const entries = Object.entries(filters)
    .filter(([, v]) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0))
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(Object.fromEntries(entries));
}
