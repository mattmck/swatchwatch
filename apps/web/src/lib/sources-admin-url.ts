import {
  SOURCE_PERMISSION_STATUSES,
  type AdminSourceKind,
  type BrandSupply,
  type SourcePermissionStatus,
} from "swatchwatch-shared";

/** URL state for the admin Sources tab (`/admin?tab=sources`). Unknown values fall back to defaults. */

export type SourcesAdminView = "sites" | "brands";
export type SiteSortKey = "site" | "kind" | "connector" | "enabled" | "permission" | "lastJob" | "listings" | "shades";
export type BrandSortKey = "brand" | "shades" | "ownStore" | "retailers" | "blocker" | "latestIngest";

export const SITE_SORT_KEYS: readonly SiteSortKey[] = ["site", "kind", "connector", "enabled", "permission", "lastJob", "listings", "shades"];
export const BRAND_SORT_KEYS: readonly BrandSortKey[] = ["brand", "shades", "ownStore", "retailers", "blocker", "latestIngest"];

const KINDS: readonly AdminSourceKind[] = ["brand", "retailer", "feed"];
const SUPPLIES: readonly BrandSupply[] = ["own", "retailer", "both", "none"];

export interface SourcesAdminState {
  view: SourcesAdminView;
  q: string;
  kind: AdminSourceKind | null;
  enabled: "on" | "off" | null;
  permission: SourcePermissionStatus[];
  supply: BrandSupply | null;
  sort: SiteSortKey | BrandSortKey;
  dir: "asc" | "desc";
  open: number | null;
}

export function defaultSortFor(view: SourcesAdminView): SiteSortKey | BrandSortKey {
  return view === "brands" ? "brand" : "site";
}

export const DEFAULT_SOURCES_ADMIN_STATE: SourcesAdminState = {
  view: "sites",
  q: "",
  kind: null,
  enabled: null,
  permission: [],
  supply: null,
  sort: "site",
  dir: "asc",
  open: null,
};

export function parseSourcesAdminState(params: Pick<URLSearchParams, "get">): SourcesAdminState {
  const view: SourcesAdminView = params.get("view") === "brands" ? "brands" : "sites";
  const kindRaw = params.get("kind");
  const kind = KINDS.find((k) => k === kindRaw) ?? null;
  const enabledRaw = params.get("enabled");
  const enabled = enabledRaw === "on" || enabledRaw === "off" ? enabledRaw : null;
  const wanted = new Set((params.get("permission") ?? "").split(",").map((s) => s.trim()));
  const permission = SOURCE_PERMISSION_STATUSES.filter((s) => wanted.has(s));
  const supplyRaw = params.get("supply");
  const supply = SUPPLIES.find((s) => s === supplyRaw) ?? null;
  const validKeys: readonly string[] = view === "brands" ? BRAND_SORT_KEYS : SITE_SORT_KEYS;
  const sortRaw = params.get("sort") ?? "";
  const sort = (validKeys.includes(sortRaw) ? sortRaw : defaultSortFor(view)) as SiteSortKey | BrandSortKey;
  const dir = params.get("dir") === "desc" ? "desc" : "asc";
  const openRaw = params.get("open") ?? "";
  const openNum = /^\d+$/.test(openRaw) ? Number(openRaw) : NaN;
  const open = Number.isSafeInteger(openNum) && openNum > 0 ? openNum : null;
  return { view, q: params.get("q") ?? "", kind, enabled, permission, supply, sort, dir, open };
}

/** Returns the `?…` search string for `state`, keeping `tab` and unknown params; writes only non-default values. */
export function buildSourcesAdminSearch(currentSearch: string, state: SourcesAdminState): string {
  const params = new URLSearchParams(currentSearch);
  for (const key of ["view", "kind", "enabled", "permission", "supply", "q", "sort", "dir", "open"]) {
    params.delete(key);
  }
  if (state.view !== "sites") params.set("view", state.view);
  if (state.kind) params.set("kind", state.kind);
  if (state.enabled) params.set("enabled", state.enabled);
  if (state.permission.length > 0) {
    const ordered = SOURCE_PERMISSION_STATUSES.filter((s) => state.permission.includes(s));
    params.set("permission", ordered.join(","));
  }
  if (state.supply) params.set("supply", state.supply);
  if (state.q) params.set("q", state.q);
  if (state.sort !== defaultSortFor(state.view)) params.set("sort", state.sort);
  if (state.dir !== "asc") params.set("dir", state.dir);
  if (state.open !== null) params.set("open", String(state.open));
  const out = params.toString();
  return out ? `?${out}` : "";
}
