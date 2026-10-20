import type { PolishFilters, PolishStatus } from "swatchwatch-shared";
import type { Undertone } from "@/lib/color-utils";
import { parseColorFamilyParam } from "@/lib/color-family-filter";
import { parseProductCategoryParam } from "@/lib/product-category-filter";

/**
 * URL state for the `/polishes` table (issue #262).
 *
 * Ownership filters are unified into one `statuses` list (empty = everything, including
 * catalog rows you have no inventory row for) plus an `untried` flag. The old `scope`
 * (`all|collection`), `availability`/`avail` (`all|owned|wishlist`) and `all=0|1` params are
 * still read so old links and bookmarks keep working, but the page only ever writes `status`
 * and `untried`: `scope=collection` ≡ `status=owned`, `availability=wishlist` ≡ `status=wishlist`.
 * The color family chips (#103) live in the same state as `family` (canonical comma list), and
 * the product category chips (#349) as `category`.
 */

export const DEFAULT_PAGE_SIZE = 10;
export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

export type SortKey = "status" | "brand" | "name" | "finish" | "collection";
export type SortDirection = "asc" | "desc";
export const SORT_KEYS: readonly SortKey[] = ["status", "brand", "name", "finish", "collection"];

/** Status values in canonical order (mirrors `POLISH_STATUSES` in swatchwatch-shared). */
const STATUS_ORDER: readonly PolishStatus[] = ["owned", "wishlist", "destash", "archived"];

/** Anything with `get` (`URLSearchParams`, Next's `ReadonlyURLSearchParams`). */
export type ReadableParams = Pick<URLSearchParams, "get">;

/** The quick presets shown as a segmented control; `custom` = any other status combination. */
export type StatusPreset = "all" | "collection" | "wishlist" | "custom";

export interface PolishesListState {
  search: string;
  /** Inventory statuses to show (canonical order, no duplicates). Empty = no status filter. */
  statuses: PolishStatus[];
  /** Only owned polishes that were never tried. */
  untried: boolean;
  toneFilter: Undertone | "all";
  finishFilter: string;
  /** Canonical comma-separated color families (`red,pink`, #103), or "" for no family filter. */
  familyFilter: string;
  /** Canonical comma-separated product categories (`color,topper`, #349), or "" for all. */
  categoryFilter: string;
  sortKey: SortKey;
  sortDirection: SortDirection;
  page: number;
  pageSize: number;
}

export const DEFAULT_LIST_STATE: PolishesListState = {
  search: "",
  statuses: [],
  untried: false,
  toneFilter: "all",
  finishFilter: "all",
  familyFilter: "",
  categoryFilter: "",
  sortKey: "name",
  sortDirection: "asc",
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
};

function isStatus(value: string): value is PolishStatus {
  return (STATUS_ORDER as readonly string[]).includes(value);
}

/** Dedupe, drop unknown values and sort into canonical order. */
export function normalizeStatuses(values: Iterable<string>): PolishStatus[] {
  const set = new Set<PolishStatus>();
  for (const raw of values) {
    const value = raw.trim().toLowerCase();
    if (isStatus(value)) set.add(value);
  }
  return STATUS_ORDER.filter((status) => set.has(status));
}

export function parsePositiveInt(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBooleanFlag(value: string | null): boolean | null {
  if (value === null) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true") return true;
  if (normalized === "0" || normalized === "false") return false;
  return null;
}

function parseSortKey(value: string | null): SortKey {
  return SORT_KEYS.includes(value as SortKey) ? (value as SortKey) : "name";
}

function parseToneFilter(value: string | null): Undertone | "all" {
  return value === "warm" || value === "cool" || value === "neutral" ? value : "all";
}

function parsePageSize(value: string | null): number {
  const parsed = parsePositiveInt(value, DEFAULT_PAGE_SIZE);
  return (PAGE_SIZE_OPTIONS as readonly number[]).includes(parsed) ? parsed : DEFAULT_PAGE_SIZE;
}

/**
 * Status filter from the URL. `status` wins; otherwise the legacy params are mapped:
 * `availability`/`avail` = `owned|wishlist` → that status, then `scope=collection` or
 * `all=0|false` → `owned`.
 */
export function parseStatusesParam(params: ReadableParams): PolishStatus[] {
  const status = params.get("status");
  if (status !== null) return normalizeStatuses(status.split(","));

  const availability = (params.get("availability") ?? params.get("avail"))?.trim().toLowerCase();
  if (availability === "owned" || availability === "wishlist") return [availability];

  if (params.get("scope")?.trim().toLowerCase() === "collection") return ["owned"];
  if (parseBooleanFlag(params.get("all")) === false) return ["owned"];
  return [];
}

/** Parse the full list state from the page URL (unknown values fall back to defaults). */
export function parsePolishesListState(params: ReadableParams): PolishesListState {
  const finish = params.get("finish");
  return {
    search: params.get("q") ?? "",
    statuses: parseStatusesParam(params),
    untried: parseBooleanFlag(params.get("untried")) === true,
    toneFilter: parseToneFilter(params.get("tone")),
    finishFilter: !finish || finish === "all" ? "all" : finish,
    familyFilter: parseColorFamilyParam(params.get("family")).join(","),
    categoryFilter: parseProductCategoryParam(params.get("category")).join(","),
    sortKey: parseSortKey(params.get("sort")),
    sortDirection: params.get("dir") === "desc" ? "desc" : "asc",
    page: parsePositiveInt(params.get("page"), 1),
    pageSize: parsePageSize(params.get("pageSize")),
  };
}

/** Canonical query string for the state (defaults omitted; legacy params never written). */
export function buildPolishesListQueryString(state: PolishesListState): string {
  const params = new URLSearchParams();
  if (state.search) params.set("q", state.search);
  const statuses = normalizeStatuses(state.statuses);
  if (statuses.length > 0) params.set("status", statuses.join(","));
  if (state.untried) params.set("untried", "1");
  if (state.toneFilter !== "all") params.set("tone", state.toneFilter);
  if (state.finishFilter !== "all") params.set("finish", state.finishFilter);
  const families = parseColorFamilyParam(state.familyFilter);
  if (families.length > 0) params.set("family", families.join(","));
  const categories = parseProductCategoryParam(state.categoryFilter);
  if (categories.length > 0) params.set("category", categories.join(","));
  if (state.sortKey !== "name") params.set("sort", state.sortKey);
  if (state.sortDirection !== "asc") params.set("dir", state.sortDirection);
  if (state.page !== 1) params.set("page", String(state.page));
  if (state.pageSize !== DEFAULT_PAGE_SIZE) params.set("pageSize", String(state.pageSize));
  return params.toString();
}

/** True when two states would produce the same filtered result set (ignores page/pageSize). */
export function sameFilters(a: PolishesListState, b: PolishesListState): boolean {
  return (
    a.search === b.search &&
    a.statuses.join(",") === b.statuses.join(",") &&
    a.untried === b.untried &&
    a.toneFilter === b.toneFilter &&
    a.finishFilter === b.finishFilter &&
    a.familyFilter === b.familyFilter &&
    a.categoryFilter === b.categoryFilter &&
    a.sortKey === b.sortKey &&
    a.sortDirection === b.sortDirection
  );
}

/**
 * The page the table should move to after a load, or `null` to keep the current one (#348).
 *
 * Nothing is clamped before the first load has finished or while a fetch is in flight: on mount
 * `total` is still 0, and clamping then would rewrite a URL-restored `?page=5` to page 1 before
 * the data arrives (the regression of #87). Once a real total is known, a page past the end
 * moves to the last page, and an empty result goes back to page 1.
 */
export function clampPageAfterLoad(input: {
  page: number;
  total: number;
  pageSize: number;
  hasLoaded: boolean;
  loading: boolean;
}): number | null {
  if (!input.hasLoaded || input.loading) return null;
  const totalPages = input.pageSize > 0 ? Math.ceil(input.total / input.pageSize) : 0;
  if (totalPages === 0) return input.page !== 1 ? 1 : null;
  return input.page > totalPages ? totalPages : null;
}

/** Which preset (if any) the status list corresponds to. */
export function statusPresetFor(statuses: readonly PolishStatus[]): StatusPreset {
  if (statuses.length === 0) return "all";
  if (statuses.length === 1 && statuses[0] === "owned") return "collection";
  if (statuses.length === 1 && statuses[0] === "wishlist") return "wishlist";
  return "custom";
}

/** The status list a preset selects (`custom` is not selectable, it keeps `current`). */
export function statusesForPreset(
  preset: StatusPreset,
  current: readonly PolishStatus[] = []
): PolishStatus[] {
  switch (preset) {
    case "all":
      return [];
    case "collection":
      return ["owned"];
    case "wishlist":
      return ["wishlist"];
    default:
      return normalizeStatuses(current);
  }
}

/** Add or remove one status from the filter, keeping canonical order. */
export function toggleStatus(
  statuses: readonly PolishStatus[],
  status: PolishStatus,
  checked: boolean
): PolishStatus[] {
  const next = new Set(statuses);
  if (checked) next.add(status);
  else next.delete(status);
  return normalizeStatuses(next);
}

/** True when any filter (not sort or paging) differs from the defaults. */
export function hasActiveFilters(
  state: Pick<PolishesListState, "search" | "statuses" | "untried" | "toneFilter" | "finishFilter"> &
    Partial<Pick<PolishesListState, "familyFilter" | "categoryFilter">>
): boolean {
  return (
    state.search.trim().length > 0 ||
    state.statuses.length > 0 ||
    state.untried ||
    state.toneFilter !== "all" ||
    state.finishFilter !== "all" ||
    Boolean(state.familyFilter) ||
    Boolean(state.categoryFilter)
  );
}

/**
 * API filters for the state (without page/pageSize/tone, which the page applies itself).
 * Only `status` and `untried` are sent for ownership; the server ANDs them with the rest.
 */
export function toApiFilters(
  state: PolishesListState
): Omit<PolishFilters, "page" | "pageSize" | "tone"> {
  const statuses = normalizeStatuses(state.statuses);
  const families = parseColorFamilyParam(state.familyFilter);
  const categories = parseProductCategoryParam(state.categoryFilter);
  return {
    search: state.search.trim() || undefined,
    finish: state.finishFilter !== "all" ? (state.finishFilter as PolishFilters["finish"]) : undefined,
    status: statuses.length > 0 ? statuses : undefined,
    untried: state.untried || undefined,
    sortBy: state.sortKey,
    sortOrder: state.sortDirection,
    ...(families.length > 0 ? { families } : {}),
    ...(categories.length > 0 ? { categories } : {}),
  };
}

/** Short label for the status filter trigger, e.g. "Any status", "Owned", "Owned +1". */
export function statusFilterSummary(
  statuses: readonly PolishStatus[],
  labels: Record<PolishStatus, string>
): string {
  if (statuses.length === 0) return "Any status";
  const [first, ...rest] = statuses;
  return rest.length === 0 ? labels[first] : `${labels[first]} +${rest.length}`;
}
