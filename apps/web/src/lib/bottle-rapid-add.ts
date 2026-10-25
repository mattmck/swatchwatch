/**
 * Pure helpers for Rapid Add's guided bottle sequence: which surface the camera asks for,
 * how a pick row and the verdicts after an Add or a create read. No DOM or network.
 */
import {
  BOTTLE_SURFACE_FRAME_TYPE,
  DEFAULT_SURFACE_PROMPTS,
  type BottleCameraView,
  type BottleSurface,
  type CaptureBrandConflict,
  type CaptureCheckCandidate,
  type CaptureBrandHintEcho,
  type CaptureCheckResponse,
  type CaptureReadField,
  type CaptureReadSummary,
  type CreateCardEdits,
  type CreateCardModel,
  type Polish,
  type StickyHints,
} from "swatchwatch-shared";
import {
  verdictFromCheck,
  type AddedVerdict,
  type CaptureEvidenceSummary,
  type CaptureVerdict,
  type CheckedVerdict,
  type NearDupeVerdict,
  type OwnedVerdict,
} from "./capture-verdict";

/** What the scan learned about an unmatched bottle, carried to the manual add form. */
export function bottleEvidence(check: CaptureCheckResponse, gtin?: string | null): CaptureEvidenceSummary {
  const evidence: CaptureEvidenceSummary = {};
  const code = gtin ?? check.suggestedShade?.gtin;
  if (code) evidence.gtin = code;
  if (check.suggestedShade?.brandName) evidence.brand = check.suggestedShade.brandName;
  if (check.suggestedShade?.shadeName) evidence.shadeName = check.suggestedShade.shadeName;
  return evidence;
}

/**
 * The view for a surface the user jumped to with a chip: the server's own view when it is the
 * same surface, else that surface's default prompt (the step counter stays where the sequence is).
 */
export function viewForSurface(surface: BottleSurface, base: BottleCameraView | null): BottleCameraView {
  if (base?.surface === surface) return base;
  return {
    surface,
    frameType: BOTTLE_SURFACE_FRAME_TYPE[surface],
    prompt: DEFAULT_SURFACE_PROMPTS[surface],
    hint: null,
    reason: null,
    optional: surface === "box",
    step: base?.step ?? 1,
    total: base?.total ?? 3,
  };
}

export type SurfaceChipStatus = "captured" | "skipped" | "open";

export function surfaceChipStatus(
  surface: BottleSurface,
  captured: readonly BottleSurface[],
  skipped: readonly BottleSurface[],
): SurfaceChipStatus {
  if (captured.includes(surface)) return "captured";
  if (skipped.includes(surface)) return "skipped";
  return "open";
}

export interface PickRowView {
  shadeId: string;
  display: string;
  hex?: string;
  /** "87% match". */
  confidenceLabel: string;
  /** "Δ color 0.04" when the glass photo gave a hex to compare. */
  colorDeltaLabel: string | null;
  ownershipLabel: string | null;
  /** Brand name, only while the typed and read brands disagree. */
  brandName: string | null;
}

function conflictBrandName(candidate: CaptureCheckCandidate, conflict: CaptureBrandConflict | null): string | null {
  if (!conflict || !candidate.brandId) return null;
  if (candidate.brandId === conflict.read.brandId) return conflict.read.name;
  if (candidate.brandId === conflict.hinted.brandId) return conflict.hinted.name;
  return null;
}

export function pickRowView(candidate: CaptureCheckCandidate, conflict: CaptureBrandConflict | null): PickRowView {
  const { relationship, quantity } = candidate.ownership;
  return {
    shadeId: candidate.shadeId ?? "",
    display: candidate.display,
    ...(candidate.hex ? { hex: candidate.hex } : {}),
    confidenceLabel: `${Math.round(candidate.confidence * 100)}% match`,
    colorDeltaLabel: typeof candidate.colorDistance === "number" ? `Δ color ${candidate.colorDistance.toFixed(2)}` : null,
    ownershipLabel:
      relationship === "owned"
        ? typeof quantity === "number" && quantity > 1
          ? `Owned × ${quantity}`
          : "Owned"
        : relationship === "wishlisted"
          ? "On wishlist"
          : null,
    brandName: conflictBrandName(candidate, conflict),
  };
}

/** The `checked` verdict for the candidate the user picked from the list. */
export function verdictFromPickedCandidate(
  check: CaptureCheckResponse,
  candidate: CaptureCheckCandidate,
): CaptureVerdict | null {
  return verdictFromCheck({ ...check, outcome: "matched", match: candidate }, null);
}

/** Quantity a bottle-flow Add writes: one more bottle on an owned shade, else one. */
export function bottleAddQuantity(verdict: CheckedVerdict | NearDupeVerdict): number {
  return verdict.kind === "checked" && verdict.relationship === "owned" ? (verdict.quantity ?? 0) + 1 : 1;
}

/**
 * The verdict after Add on a `checked` / near-dupe card (`updatePolish`, no finalize): an owned
 * shade becomes the "counted another bottle" verdict (with its undo), anything else is "added".
 */
export function verdictAfterBottleAdd(
  verdict: CheckedVerdict | NearDupeVerdict,
  inventoryItemId: string | undefined,
): OwnedVerdict | AddedVerdict {
  if (verdict.kind === "checked" && verdict.relationship === "owned" && inventoryItemId) {
    const previousQuantity = verdict.quantity ?? 0;
    return {
      kind: "owned",
      display: verdict.display,
      inventoryItemId,
      ...(verdict.shadeId ? { shadeId: verdict.shadeId } : {}),
      previousQuantity,
      quantity: previousQuantity + 1,
      ...(verdict.hex ? { hex: verdict.hex } : {}),
    };
  }
  const added: AddedVerdict = {
    kind: "added",
    display: verdict.display,
    priorOwnership: verdict.kind === "near_dupe" || verdict.relationship === "notOwned" ? "none" : "unknown",
  };
  if (inventoryItemId) added.inventoryItemId = inventoryItemId;
  if (verdict.shadeId) added.shadeId = verdict.shadeId;
  return added;
}

/** The verdict after the create card made a new polish: "added", or a wishlisted `checked` card. */
export function verdictAfterCreate(
  created: Pick<Polish, "id" | "inventoryItemId">,
  card: CreateCardModel,
  edits: CreateCardEdits,
  status: "owned" | "wishlist",
): CheckedVerdict | AddedVerdict {
  const display = `${edits.brand.trim()} — ${edits.shadeName.trim()}`;
  const shadeId = String(created.id);
  if (status === "wishlist") {
    return {
      kind: "checked",
      relationship: "wishlisted",
      display,
      shadeId,
      ...(edits.hex ? { hex: edits.hex } : {}),
      gtin: card.gtin ?? "",
      wishlistedNow: true,
    };
  }
  return {
    kind: "added",
    display,
    shadeId,
    ...(created.inventoryItemId ? { inventoryItemId: String(created.inventoryItemId) } : {}),
    priorOwnership: "none",
  };
}

/**
 * A start response's brand echo belongs to the batch only while it answers the brand the batch
 * still has (typed or canonical); an echo for a brand the user has since replaced is ignored.
 */
export function echoMatchesBatch(hints: StickyHints, echo: CaptureBrandHintEcho): boolean {
  const raw = echo.raw.trim().toLowerCase();
  return [hints.brand, hints.brandCanonical].some((brand) => brand?.trim().toLowerCase() === raw);
}

// ---------------------------------------------------------------------------
// "What we've read" panel
// ---------------------------------------------------------------------------

export interface ReadPanelRow {
  field: CaptureReadField;
  label: string;
  /** What was read; null shows "Not read yet". */
  value: string | null;
  /** A short note under the value (where it came from, or what to check). */
  detail?: string;
  /** The lacquer swatch for the color row. */
  hex?: string;
  /** The latest photo added this field. */
  isNew: boolean;
  /** The value came from the bottle and should be checked (a brand that matched no catalog brand). */
  needsCheck?: boolean;
}

/**
 * Rows for the panel under the camera prompt: barcode, brand, shade name, color, finish. A barcode
 * read on this device shows at once, before the server answers.
 */
export function readPanelRows(summary: CaptureReadSummary | null, liveBarcode: string | null): ReadPanelRow[] {
  const isNew = (field: CaptureReadField) => Boolean(summary?.newFields.includes(field));
  const gtin = summary?.gtin ?? liveBarcode ?? null;
  const brand = summary?.brand ?? null;
  const printed = summary?.shadeName ?? null;
  const listed = summary?.shadeNameListed ?? null;

  let brandDetail: string | undefined;
  if (brand) {
    brandDetail = brand.catalogMatch
      ? "Matched in the catalog"
      : brand.source === "hint"
        ? "Your brand (not in the catalog yet)"
        : "Read from the bottle — check it";
  }

  let nameDetail: string | undefined;
  if (listed && printed && listed.toLowerCase() !== printed.toLowerCase()) nameDetail = `Closest catalog name: ${listed}`;
  else if (listed) nameDetail = "Matched to the brand's catalog list";
  else if (printed) nameDetail = "As printed on the bottle";

  return [
    {
      field: "gtin",
      label: "Barcode",
      value: gtin,
      detail: gtin && !summary?.gtin ? "Scanned on this device" : undefined,
      isNew: isNew("gtin"),
    },
    {
      field: "brand",
      label: "Brand",
      value: brand?.name ?? null,
      detail: brandDetail,
      isNew: isNew("brand"),
      needsCheck: Boolean(brand && !brand.catalogMatch && brand.source === "read"),
    },
    { field: "shadeName", label: "Shade name", value: printed ?? listed, detail: nameDetail, isNew: isNew("shadeName") },
    {
      field: "hex",
      label: "Color",
      value: summary?.hex ?? null,
      detail: summary?.hex ? "Measured from the glass" : undefined,
      hex: summary?.hex ?? undefined,
      isNew: isNew("hex"),
    },
    { field: "finish", label: "Finish", value: summary?.finish ?? null, isNew: isNew("finish") },
  ];
}
