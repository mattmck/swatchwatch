import type { Polish, PolishFilters, PolishStatus } from "swatchwatch-shared";

/** Display labels for inventory statuses (web: `POLISH_STATUS_LABELS`). */
export const POLISH_STATUS_LABELS: Record<PolishStatus, string> = {
  owned: "Owned",
  wishlist: "Wishlist",
  destash: "Destash",
  archived: "Archived",
};

/** Ownership is `status === "owned"`, never `quantity` (CLAUDE.md, decision D5). */
export function isOwnedPolish(polish: Pick<Polish, "status">): boolean {
  return polish.status === "owned";
}

export interface CollectionPreset {
  key: "owned" | "untried" | "wishlist" | "destash" | "archived" | "all";
  label: string;
  filters: Pick<PolishFilters, "status" | "untried" | "scope">;
}

/** Collection tab presets: the web `/polishes` status chips as one-tap filters. */
export const COLLECTION_PRESETS: readonly CollectionPreset[] = [
  { key: "owned", label: "Owned", filters: { status: ["owned"] } },
  { key: "untried", label: "Untried", filters: { status: ["owned"], untried: true } },
  { key: "wishlist", label: "Wishlist", filters: { status: ["wishlist"] } },
  { key: "destash", label: "Destash", filters: { status: ["destash"] } },
  { key: "archived", label: "Archived", filters: { status: ["archived"] } },
  { key: "all", label: "All mine", filters: { status: ["owned", "wishlist", "destash", "archived"] } },
];

/** Today's date in the device time zone as `YYYY-MM-DD`. */
export function localIsoDate(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * The PUT body for a status quick action (web: `statusChangePatch`): owned / destash keep at
 * least one bottle; wishlist / archived leave quantity alone.
 */
export function statusChangePatch(
  polish: Pick<Polish, "quantity">,
  status: PolishStatus,
): { status: PolishStatus; quantity?: number } {
  if (status === "owned" || status === "destash") {
    return { status, quantity: Math.max(1, polish.quantity ?? 0) };
  }
  return { status };
}

/**
 * Status actions offered for a polish. Archived → wishlist only through an explicit Rebuy
 * (D5); taking a wishlist row off the wishlist deletes the row (`remove`).
 */
export type StatusAction =
  | { kind: "status"; status: PolishStatus; label: string }
  | { kind: "remove"; label: string };

export function statusActionsFor(status: PolishStatus | null | undefined): StatusAction[] {
  switch (status) {
    case "owned":
      return [
        { kind: "status", status: "destash", label: "Destash" },
        { kind: "status", status: "archived", label: "Archive (used up)" },
      ];
    case "wishlist":
      return [
        { kind: "status", status: "owned", label: "I own it" },
        { kind: "remove", label: "Remove from wishlist" },
      ];
    case "destash":
      return [
        { kind: "status", status: "owned", label: "Keep (owned)" },
        { kind: "status", status: "archived", label: "Archive (gone)" },
      ];
    case "archived":
      return [
        { kind: "status", status: "owned", label: "Own it again" },
        { kind: "status", status: "wishlist", label: "Rebuy (wishlist)" },
      ];
    default:
      return [
        { kind: "status", status: "owned", label: "Add to collection" },
        { kind: "status", status: "wishlist", label: "Add to wishlist" },
      ];
  }
}
