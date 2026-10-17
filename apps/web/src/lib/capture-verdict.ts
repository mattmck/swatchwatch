/**
 * Rapid Add verdicts: turn a finished capture session into the one answer the shopper
 * needs in the aisle ("you already own it" / "added" / "not found — add it").
 *
 * The capture API's finalize step adds a matched polish to the collection (or bumps the
 * quantity of an owned one), so "did I already own it?" can't be read from the result
 * alone. The page loads an ownership snapshot of the collection before finalizing and the
 * verdict compares the matched inventory row against it.
 *
 * Extension point: more verdict kinds come from other features — a near-dupe check (#265)
 * and the wishlist (#261). To add one:
 *   1. add its variant to `CaptureVerdict` below,
 *   2. write a `VerdictResolver` that upgrades a base verdict to it and register it in
 *      `DEFAULT_VERDICT_RESOLVERS` (or pass it to `resolveCaptureVerdict`),
 *   3. render it in `components/rapid-add/verdict-card.tsx` (its switch is exhaustive, so
 *      TypeScript points at the missing branch).
 */
import type { CaptureStatus, Polish } from "swatchwatch-shared";
import { resolveDisplayHex } from "swatchwatch-shared";

export interface OwnedPolishEntry {
  inventoryItemId: string;
  /** Unknown for rows recorded locally after a barcode (SKU) match. */
  shadeId?: string;
  brand: string;
  name: string;
  quantity: number;
  hex?: string;
}

/** Owned inventory rows keyed by inventory item id. `null` means "couldn't load". */
export type OwnershipSnapshot = ReadonlyMap<string, OwnedPolishEntry>;

export function buildOwnershipSnapshot(polishes: readonly Polish[]): OwnershipSnapshot {
  const snapshot = new Map<string, OwnedPolishEntry>();
  for (const polish of polishes) {
    if (!polish.inventoryItemId) continue;
    const quantity = typeof polish.quantity === "number" ? polish.quantity : 0;
    if (quantity <= 0) continue;
    snapshot.set(String(polish.inventoryItemId), {
      inventoryItemId: String(polish.inventoryItemId),
      shadeId: String(polish.id),
      brand: polish.brand,
      name: polish.name,
      quantity,
      hex: resolveDisplayHex(polish),
    });
  }
  return snapshot;
}

/** Return a copy of `snapshot` with `entry` set (used to keep it current between scans). */
export function withOwnedEntry(
  snapshot: OwnershipSnapshot,
  entry: OwnedPolishEntry,
): OwnershipSnapshot {
  const next = new Map(snapshot);
  if (entry.quantity > 0) {
    next.set(entry.inventoryItemId, entry);
  } else {
    next.delete(entry.inventoryItemId);
  }
  return next;
}

/** The subset of a capture status response the verdict needs. */
export interface CaptureOutcome {
  status: CaptureStatus;
  acceptedEntityType?: "shade" | "sku";
  acceptedEntityId?: string;
  metadata?: Record<string, unknown>;
}

export interface CaptureEvidenceSummary {
  gtin?: string;
  brand?: string;
  shadeName?: string;
}

/** Already in the collection before this scan; finalize counted one more bottle. */
export interface OwnedVerdict {
  kind: "owned";
  display: string;
  inventoryItemId: string;
  /** Shade id for the detail link and the quantity undo; unknown for some SKU matches. */
  shadeId?: string;
  previousQuantity: number;
  quantity: number;
  hex?: string;
}

/** Matched and new to the collection (or ownership unknown); finalize added it. */
export interface AddedVerdict {
  kind: "added";
  display: string;
  inventoryItemId?: string;
  /** Shade id for the detail page link; unknown for some barcode (SKU) matches. */
  shadeId?: string;
  /** "unknown" when the ownership snapshot couldn't be loaded. */
  priorOwnership: "none" | "unknown";
}

/** No catalog match: offer the manual add form, carrying what we learned. */
export interface AddVerdict {
  kind: "add";
  display?: string;
  evidence: CaptureEvidenceSummary;
}

// Extension point: NearDupeVerdict (#265) and WishlistVerdict (#261) join this union.
export type CaptureVerdict = OwnedVerdict | AddedVerdict | AddVerdict;
export type CaptureVerdictKind = CaptureVerdict["kind"];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

/** `metadata.inventoryItemId`, written by finalize/answer when a match is added. */
export function readInventoryItemId(metadata: Record<string, unknown> | undefined): string | undefined {
  return asNonEmptyString(asRecord(metadata).inventoryItemId);
}

/** The evidence the resolver used (audit trail), falling back to the session hints. */
export function readCaptureEvidence(
  metadata: Record<string, unknown> | undefined,
): CaptureEvidenceSummary {
  const record = asRecord(metadata);
  const resolver = asRecord(record.resolver);
  const audited = asRecord(asRecord(resolver.audit).evidence);
  return {
    gtin: asNonEmptyString(audited.gtin) ?? asNonEmptyString(record.gtin),
    brand: asNonEmptyString(audited.brand) ?? asNonEmptyString(resolver.brand) ?? asNonEmptyString(record.brand),
    shadeName:
      asNonEmptyString(audited.shadeName) ??
      asNonEmptyString(resolver.shadeName) ??
      asNonEmptyString(record.shadeName),
  };
}

/** Best human-readable name for what the resolver matched. */
export function readCaptureDisplay(metadata: Record<string, unknown> | undefined): string | undefined {
  const resolver = asRecord(asRecord(metadata).resolver);
  const direct = asNonEmptyString(resolver.display) ?? asNonEmptyString(resolver.topCandidate);
  if (direct) return direct;
  const evidence = readCaptureEvidence(metadata);
  const joined = [evidence.brand, evidence.shadeName].filter(Boolean).join(" — ");
  return joined || undefined;
}

/**
 * A candidate answer is sent as "123: Brand — Shade"; strip the id for display.
 */
export function candidateOptionLabel(option: string): string {
  const match = /^\s*\d+\s*:\s*(.+)$/.exec(option);
  return match ? match[1].trim() : option;
}

export interface DeriveVerdictOptions {
  /** Name to fall back on when metadata has none (e.g. the candidate the user picked). */
  displayHint?: string;
}

/**
 * The base verdict for a finished session, or null while it is still in progress
 * (processing / needs_question) or was cancelled.
 */
export function deriveCaptureVerdict(
  outcome: CaptureOutcome,
  snapshot: OwnershipSnapshot | null,
  options: DeriveVerdictOptions = {},
): CaptureVerdict | null {
  if (outcome.status === "unmatched") {
    return {
      kind: "add",
      display: readCaptureDisplay(outcome.metadata),
      evidence: readCaptureEvidence(outcome.metadata),
    };
  }
  if (outcome.status !== "matched") {
    return null;
  }

  const inventoryItemId = readInventoryItemId(outcome.metadata);
  const shadeFromEntity =
    outcome.acceptedEntityType === "shade" ? asNonEmptyString(outcome.acceptedEntityId) : undefined;
  const owned = inventoryItemId && snapshot ? snapshot.get(inventoryItemId) : undefined;

  if (owned) {
    return {
      kind: "owned",
      display: [owned.brand, owned.name].filter(Boolean).join(" — ") || owned.name,
      inventoryItemId: owned.inventoryItemId,
      shadeId: owned.shadeId,
      previousQuantity: owned.quantity,
      quantity: owned.quantity + 1,
      hex: owned.hex,
    };
  }

  return {
    kind: "added",
    display: readCaptureDisplay(outcome.metadata) ?? options.displayHint ?? "This polish",
    inventoryItemId,
    shadeId: shadeFromEntity,
    priorOwnership: snapshot ? "none" : "unknown",
  };
}

export interface VerdictContext {
  outcome: CaptureOutcome;
  snapshot: OwnershipSnapshot | null;
}

/**
 * Upgrades a base verdict (e.g. `added` → near-dupe). Return null to leave it unchanged.
 * Resolvers run in order and each sees the previous one's result.
 */
export type VerdictResolver = (
  verdict: CaptureVerdict,
  context: VerdictContext,
) => CaptureVerdict | null | Promise<CaptureVerdict | null>;

/** Registered resolvers. Empty until #265 (near-dupe) and #261 (wishlist) land. */
export const DEFAULT_VERDICT_RESOLVERS: readonly VerdictResolver[] = [];

export async function resolveCaptureVerdict(
  outcome: CaptureOutcome,
  snapshot: OwnershipSnapshot | null,
  options: DeriveVerdictOptions & { resolvers?: readonly VerdictResolver[] } = {},
): Promise<CaptureVerdict | null> {
  const base = deriveCaptureVerdict(outcome, snapshot, options);
  if (!base) return null;
  let verdict = base;
  for (const resolver of options.resolvers ?? DEFAULT_VERDICT_RESOLVERS) {
    try {
      verdict = (await resolver(verdict, { outcome, snapshot })) ?? verdict;
    } catch {
      // An enrichment failing must never hide the base answer.
    }
  }
  return verdict;
}

/** Snapshot entry to record after a verdict, so a re-scan of the same bottle says "owned". */
export function ownedEntryAfterVerdict(verdict: CaptureVerdict): OwnedPolishEntry | null {
  if (verdict.kind === "owned") {
    return {
      inventoryItemId: verdict.inventoryItemId,
      shadeId: verdict.shadeId,
      brand: "",
      name: verdict.display,
      quantity: verdict.quantity,
      hex: verdict.hex,
    };
  }
  if (verdict.kind === "added" && verdict.inventoryItemId) {
    return {
      inventoryItemId: verdict.inventoryItemId,
      shadeId: verdict.shadeId,
      brand: "",
      name: verdict.display,
      quantity: 1,
    };
  }
  return null;
}
