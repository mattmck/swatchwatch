import type { HexLabelPromoteResponse, HexLabelQueueItem } from "swatchwatch-shared";

/**
 * "Promote to vendor hex" (#321, decision D12): what the admin labeler offers for a shade.
 *
 * - `none`: no saved label, or it is flagged unreliable / has no hex. Nothing to promote.
 * - `available`: a saved, approved label that is not promoted.
 * - `promoted`: `vendor_hex` is this label's hex.
 * - `stale`: this label is promoted, but it was re-saved with another hex since (promote again
 *   to update `vendor_hex`).
 * - `orphaned`: `vendor_hex` is a promoted manual label whose label row was deleted (or another
 *   label); only Undo is offered.
 */
export type VendorHexPromotionState =
  | { kind: "none" }
  | { kind: "available"; labelId: string; hex: string }
  | { kind: "promoted"; labelId: string; hex: string; previous: string | null }
  | { kind: "stale"; labelId: string; hex: string; promotedHex: string | null; previous: string | null }
  | { kind: "orphaned"; promotedHex: string | null; previous: string | null };

export function vendorHexPromotionState(item: HexLabelQueueItem): VendorHexPromotionState {
  const label = item.label;
  const promotable = label && !label.unreliable && label.hex ? { labelId: label.trainingSampleId, hex: label.hex } : null;

  if (item.vendorHexSource === "manual_label") {
    const previous = item.vendorHexPrevious;
    if (label && item.promotedLabelId === label.trainingSampleId) {
      if (promotable && promotable.hex === item.vendorHex) return { kind: "promoted", ...promotable, previous };
      if (promotable) return { kind: "stale", ...promotable, promotedHex: item.vendorHex, previous };
    }
    return { kind: "orphaned", promotedHex: item.vendorHex, previous };
  }
  return promotable ? { kind: "available", ...promotable } : { kind: "none" };
}

/** Apply a promote/undo response to the loaded queue item. Pure. */
export function applyPromotionResponse(item: HexLabelQueueItem, response: HexLabelPromoteResponse): HexLabelQueueItem {
  if (item.shadeId !== response.shadeId) return item;
  return {
    ...item,
    vendorHex: response.vendorHex,
    vendorHexSource: response.vendorHexSource,
    promotedLabelId: response.promotedLabelId,
    vendorHexPrevious: response.vendorHexPrevious,
    // hex_agreement is recomputed by Postgres; the next load brings the new value.
    hexAgreement: response.changed ? null : item.hexAgreement,
    flagged: response.changed ? false : item.flagged,
  };
}
