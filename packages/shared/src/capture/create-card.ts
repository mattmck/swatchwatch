import { classifyHexColorFamily } from "../color/color-family";
import type { CaptureBrandSource, CaptureCheckResponse } from "../types/capture";
import type { PolishCreateRequest } from "../types/polish";

/** The "add it as new" card shown when the catalog could not match a bottle. */
export interface CreateCardModel {
  captureId: string;
  brand: string;
  brandSource: CaptureBrandSource | null;
  /** The brand was only read off the bottle, so the user confirms it before adding. */
  brandNeedsConfirm: boolean;
  shadeName: string;
  hex: string | null;
  finish: string | null;
  gtin: string | null;
}

/**
 * The card for an unmatched bottle. `null` when the check matched, when candidates are on
 * screen (only a `needs_question` check shows them) and the user has not said "None of these",
 * or when there is no suggestedShade. An `unmatched` check with a suggestedShade is a card
 * whatever its `candidates` hold.
 */
export function deriveCreateCard(
  check: Pick<CaptureCheckResponse, "captureId" | "outcome" | "candidates" | "suggestedShade">,
  opts: { afterNoneOfThese: boolean },
): CreateCardModel | null {
  if (check.outcome === "matched") return null;
  if (check.outcome === "needs_question" && check.candidates.length > 0 && !opts.afterNoneOfThese) return null;
  const suggestion = check.suggestedShade;
  if (!suggestion) return null;
  return {
    captureId: check.captureId,
    brand: suggestion.brandName ?? "",
    brandSource: suggestion.brandSource,
    brandNeedsConfirm: suggestion.brandSource === "read",
    shadeName: suggestion.shadeName ?? "",
    hex: suggestion.hex,
    finish: suggestion.finish,
    gtin: suggestion.gtin,
  };
}

export interface CreateCardEdits {
  brand: string;
  shadeName: string;
  hex: string | null;
  finish: string | null;
  brandConfirmed: boolean;
}

/** Brand and shade name are required; a brand only read off the bottle needs confirming or editing. */
export function canSubmitCreateCard(card: CreateCardModel, edits: CreateCardEdits): boolean {
  const brand = edits.brand.trim();
  if (!brand || !edits.shadeName.trim()) return false;
  return !card.brandNeedsConfirm || edits.brandConfirmed || brand !== card.brand;
}

export function createPolishRequestFromCard(
  card: CreateCardModel,
  edits: CreateCardEdits,
  status: "owned" | "wishlist",
): PolishCreateRequest {
  const request: PolishCreateRequest = {
    brand: edits.brand.trim(),
    name: edits.shadeName.trim(),
    color: (edits.hex && classifyHexColorFamily(edits.hex)) || "unknown",
    captureId: card.captureId,
    status,
    quantity: status === "owned" ? 1 : 0,
  };
  if (edits.hex) request.detectedHex = edits.hex;
  if (edits.finish) request.finishes = [edits.finish];
  if (card.gtin) request.barcode = card.gtin;
  return request;
}
