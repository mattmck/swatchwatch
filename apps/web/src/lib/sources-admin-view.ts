import {
  SOURCE_PERMISSION_STATUSES,
  type AdminBrandListItem,
  type AdminBrandProfileRequest,
  type AdminSourceListItem,
  type BrandIngestProfile,
  type BrandPlatform,
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

function permissionStatusOf(value: unknown): string {
  if (typeof value === "object" && value !== null && "status" in value) {
    const status = (value as { status?: unknown }).status;
    if (typeof status === "string") return status;
  }
  return "none";
}

/** History detail from an audit event's `changes`: the override and a permission status change. */
export function historyDetail(changes: Record<string, unknown>): string {
  const parts: string[] = [];
  if (changes.override === true) parts.push("turned on without an OK");
  const permission = changes.permission;
  if (typeof permission === "object" && permission !== null && "from" in permission && "to" in permission) {
    const { from, to } = permission as { from: unknown; to: unknown };
    const before = permissionStatusOf(from);
    const after = permissionStatusOf(to);
    if (before !== after) parts.push(`permission ${before} → ${after}`);
  }
  return parts.length > 0 ? `: ${parts.join(", ")}` : "";
}

/** The brand panel's form values: text as typed, `""` platform = not set, `"none"` own store = none. */
export interface BrandProfileForm {
  websiteUrl: string;
  platform: BrandPlatform | "";
  blocker: string;
  notes: string;
  ownDataSourceId: string;
}

export function brandProfileForm(profile: BrandIngestProfile | null): BrandProfileForm {
  return {
    websiteUrl: profile?.websiteUrl ?? "",
    platform: profile?.platform ?? "",
    blocker: profile?.blocker ?? "",
    notes: profile?.notes ?? "",
    ownDataSourceId: profile?.ownDataSourceId ? String(profile.ownDataSourceId) : "none",
  };
}

/**
 * The fields the admin changed, against `baseline`: the profile the form was last filled from
 * (on open, or from the last save response), never a newer profile a list refresh brought in,
 * so a field someone else changed meanwhile is not sent back with this form's older value.
 */
export function changedProfileFields(baseline: BrandIngestProfile | null, form: BrandProfileForm): AdminBrandProfileRequest {
  const next = {
    websiteUrl: form.websiteUrl.trim() || null,
    platform: form.platform || null,
    blocker: form.blocker.trim() || null,
    notes: form.notes.trim() || null,
    ownDataSourceId: form.ownDataSourceId === "none" ? null : Number(form.ownDataSourceId),
  };
  const changes: AdminBrandProfileRequest = {};
  if (next.websiteUrl !== (baseline?.websiteUrl ?? null)) changes.websiteUrl = next.websiteUrl;
  if (next.platform !== (baseline?.platform ?? null)) changes.platform = next.platform;
  if (next.blocker !== (baseline?.blocker ?? null)) changes.blocker = next.blocker;
  if (next.notes !== (baseline?.notes ?? null)) changes.notes = next.notes;
  if (next.ownDataSourceId !== (baseline?.ownDataSourceId ?? null)) changes.ownDataSourceId = next.ownDataSourceId;
  return changes;
}

/**
 * Drops reads that a write overtook. A write calls `invalidate()` when it starts and again when
 * it succeeds, so a read begun before the write, or while it was in flight, is no longer current.
 */
export function createReadGuard(): { beginRead: () => () => boolean; invalidate: () => void } {
  let generation = 0;
  return {
    beginRead: () => {
      const at = generation;
      return () => at === generation;
    },
    invalidate: () => {
      generation += 1;
    },
  };
}
