import type { CaptureBrandHintEcho, CaptureBrandRef } from "../types/capture";

/** Rapid Add's remembered "I'm going through this brand" hints. */
export interface StickyHints {
  /** Brand as typed. */
  brand: string | null;
  /** Catalog spelling of the brand once the server matched it. */
  brandCanonical: string | null;
  brandId: string | null;
  finish: string | null;
  collection: string | null;
}

export const EMPTY_STICKY_HINTS: StickyHints = {
  brand: null,
  brandCanonical: null,
  brandId: null,
  finish: null,
  collection: null,
};

export const STICKY_HINTS_STORAGE_PREFIX = "swatchwatch.rapid-add.hints";
export const STICKY_HINT_MAX_LENGTH = 200;

export function stickyHintsStorageKey(userId: string | null | undefined): string {
  return `${STICKY_HINTS_STORAGE_PREFIX}:${userId ?? "anon"}`;
}

function cleanHint(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= STICKY_HINT_MAX_LENGTH ? trimmed : null;
}

/** Parses stored hints (a JSON string or an object); trims, drops blanks and values over the max length; anything else gives the empty hints. */
export function parseStickyHints(raw: unknown): StickyHints {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return EMPTY_STICKY_HINTS;
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return EMPTY_STICKY_HINTS;
  const record = value as Record<string, unknown>;
  return {
    brand: cleanHint(record.brand),
    brandCanonical: cleanHint(record.brandCanonical),
    brandId: cleanHint(record.brandId),
    finish: cleanHint(record.finish),
    collection: cleanHint(record.collection),
  };
}

export function serializeStickyHints(hints: StickyHints): string {
  return JSON.stringify(hints);
}

/** Batch mode ("going through one brand") is on while a brand is set. */
export function isBatchMode(hints: StickyHints): boolean {
  return Boolean(hints.brand);
}

/** The `metadata` of `POST /api/capture/start`: the canonical brand when known, no undefined keys. */
export function hintsToStartMetadata(hints: StickyHints): { brand?: string; finish?: string; collection?: string } {
  const metadata: { brand?: string; finish?: string; collection?: string } = {};
  const brand = hints.brandCanonical ?? hints.brand;
  if (brand) metadata.brand = brand;
  if (hints.finish) metadata.finish = hints.finish;
  if (hints.collection) metadata.collection = hints.collection;
  return metadata;
}

/** Remembers the catalog brand the server matched for the typed hint. */
export function withBrandEcho(hints: StickyHints, echo: CaptureBrandHintEcho | null | undefined): StickyHints {
  if (!echo?.brandId) return hints;
  return { ...hints, brandCanonical: echo.name, brandId: echo.brandId };
}

/** Switches the batch to the brand read from a bottle. */
export function switchBrand(hints: StickyHints, read: CaptureBrandRef): StickyHints {
  return { ...hints, brand: read.name, brandCanonical: read.name, brandId: read.brandId };
}

/** "Going through: Loud Lacquer"; `null` when not in batch mode. */
export function batchHeaderLabel(hints: StickyHints): string | null {
  if (!isBatchMode(hints)) return null;
  return `Going through: ${hints.brandCanonical ?? hints.brand}`;
}
