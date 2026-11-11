import {
  SOURCE_PERMISSION_STATUSES,
  type AdminBrandListItem,
  type AdminSourceListItem,
} from "swatchwatch-shared";
import type { BrandSortKey, SiteSortKey, SourcesAdminState } from "./sources-admin-url";

type Dir = "asc" | "desc";

function includesText(haystack: Array<string | null>, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return haystack.some((h) => h?.toLowerCase().includes(needle));
}

export function filterSites(items: AdminSourceListItem[], s: SourcesAdminState): AdminSourceListItem[] {
  return items.filter((it) => {
    if (s.kind && it.kind !== s.kind) return false;
    if (s.enabled && it.enabled !== (s.enabled === "on")) return false;
    if (s.permission.length > 0 && !s.permission.includes(it.permission.status)) return false;
    return includesText([it.displayName, it.name, it.baseUrl], s.q);
  });
}

export function filterBrands(items: AdminBrandListItem[], s: SourcesAdminState): AdminBrandListItem[] {
  return items.filter((it) => {
    if (s.supply) {
      if (s.supply === "own" ? it.supply !== "own" && it.supply !== "both" : it.supply !== s.supply) return false;
    }
    return includesText([it.name], s.q);
  });
}

type Key = number | string | null;

/** Compares keys with nulls last in both directions; ties break on the name. */
function sortByKey<T>(items: T[], dir: Dir, key: (it: T) => Key, name: (it: T) => string): T[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...items].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka === null && kb !== null) return 1;
    if (kb === null && ka !== null) return -1;
    if (ka !== null && kb !== null && ka !== kb) {
      const c = typeof ka === "number" && typeof kb === "number" ? ka - kb : String(ka).localeCompare(String(kb));
      if (c !== 0) return c * sign;
    }
    return name(a).localeCompare(name(b));
  });
}

function time(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

export function sortSites(items: AdminSourceListItem[], sort: SiteSortKey, dir: Dir): AdminSourceListItem[] {
  const key = (it: AdminSourceListItem): Key => {
    switch (sort) {
      case "site": return it.displayName.toLowerCase();
      case "kind": return it.kind;
      case "connector": return it.connector;
      case "enabled": return it.enabled ? 0 : 1;
      case "permission": return SOURCE_PERMISSION_STATUSES.indexOf(it.permission.status);
      case "lastJob": return time(it.lastJob?.startedAt);
      case "listings": return it.liveListings;
      case "shades": return it.shades;
    }
  };
  return sortByKey(items, dir, key, (it) => it.displayName.toLowerCase());
}

export function sortBrands(items: AdminBrandListItem[], sort: BrandSortKey, dir: Dir): AdminBrandListItem[] {
  const key = (it: AdminBrandListItem): Key => {
    switch (sort) {
      case "brand": return it.name.toLowerCase();
      case "shades": return it.colorShades + it.otherShades;
      case "ownStore": return it.ownStores.length;
      case "retailers": return it.retailers.length;
      case "blocker": return it.profile?.blocker?.toLowerCase() ?? null;
      case "latestIngest": return time(it.latestIngestAt);
    }
  };
  if (sort !== "ownStore") return sortByKey(items, dir, key, (it) => it.name.toLowerCase());
  // ownStore: store count, then the first store's display name.
  const sign = dir === "asc" ? 1 : -1;
  return [...items].sort((a, b) => {
    const c = a.ownStores.length - b.ownStores.length;
    if (c !== 0) return c * sign;
    const n = (a.ownStores[0]?.displayName ?? "").localeCompare(b.ownStores[0]?.displayName ?? "");
    if (n !== 0) return n * sign;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
}
