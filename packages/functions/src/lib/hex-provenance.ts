import type { HexDetectionResult } from "./ai-color-detection";

/**
 * Provenance recorded next to `shade.detected_hex` (migration 026): how sure the
 * detector was, which strategy / deployment / prompt produced the value, and when.
 *
 * `shade.hex_agreement` (OKLAB distance vendor_hex ↔ detected_hex) is NOT written
 * here: it is a Postgres STORED GENERATED column, so every UPDATE of either hex
 * refreshes it automatically. Read it back with `::float8`.
 */
export interface DetectedHexProvenance {
  /** 0–1, rounded to 3 decimals (NUMERIC(4,3)); null when the detector gave none. */
  confidence: number | null;
  /** e.g. `vision-direct`, `palette-pick`, `region-crop`, `ensemble`, `client-supplied`. */
  method: string | null;
  /** Azure OpenAI deployment name. */
  model: string | null;
  /** `PROMPT_VERSION` of the prompt used. */
  promptVersion: string | null;
}

/** Method recorded when a user API request supplied `detectedHex` directly. */
export const DETECTED_HEX_METHOD_CLIENT_SUPPLIED = "client-supplied";

export const EMPTY_DETECTED_HEX_PROVENANCE: DetectedHexProvenance = Object.freeze({
  confidence: null,
  method: null,
  model: null,
  promptVersion: null,
});

/** Clamp to 0–1 and round to the 3 decimals `detected_hex_confidence NUMERIC(4,3)` holds. */
export function normalizeDetectedHexConfidence(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const clamped = Math.max(0, Math.min(1, value));
  return Math.round(clamped * 1000) / 1000;
}

function trimOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Provenance columns for a detection result (sync, batch, and recalc-hex all go through this). */
export function provenanceFromDetection(
  detection: Pick<HexDetectionResult, "confidence" | "method" | "model" | "promptVersion"> | null | undefined
): DetectedHexProvenance {
  if (!detection) return { ...EMPTY_DETECTED_HEX_PROVENANCE };
  return {
    confidence: normalizeDetectedHexConfidence(detection.confidence),
    method: trimOrNull(detection.method),
    model: trimOrNull(detection.model),
    promptVersion: trimOrNull(detection.promptVersion),
  };
}

/** Positional parameter values matching `detectedHexProvenanceSetSql` order. */
export function provenanceParams(
  provenance: DetectedHexProvenance
): [number | null, string | null, string | null, string | null] {
  return [provenance.confidence, provenance.method, provenance.model, provenance.promptVersion];
}

/**
 * SQL `SET` assignments (no leading comma) that write the provenance columns only
 * when `appliedCondition` is true and otherwise keep the existing values.
 *
 * `appliedCondition` must evaluate, inside the UPDATE, to "detected_hex is being
 * (re)written by this statement" — e.g. for the overwrite/COALESCE pattern:
 *
 *   (($ow::boolean AND $hex::text IS NOT NULL) OR (detected_hex IS NULL AND $hex::text IS NOT NULL))
 *
 * Column references on the right-hand side of SET see the pre-update row, so
 * `detected_hex IS NULL` means "was null before", which is exactly the
 * non-overwrite rule: provenance is only filled when detected_hex was empty.
 *
 * `firstParam` is the 1-based index of the confidence parameter; method, model and
 * prompt version follow consecutively (see `provenanceParams`). `columnPrefix`
 * qualifies the existing-value references (e.g. `sh.`) when the UPDATE uses an alias.
 */
export function detectedHexProvenanceSetSql(
  appliedCondition: string,
  firstParam: number,
  columnPrefix = ""
): string {
  const cond = `(${appliedCondition})`;
  const p = (offset: number) => `$${firstParam + offset}`;
  const col = (name: string) => `${columnPrefix}${name}`;
  return [
    `detected_hex_confidence = CASE WHEN ${cond} THEN ${p(0)}::numeric ELSE ${col("detected_hex_confidence")} END`,
    `detected_hex_method = CASE WHEN ${cond} THEN ${p(1)}::text ELSE ${col("detected_hex_method")} END`,
    `detected_hex_model = CASE WHEN ${cond} THEN ${p(2)}::text ELSE ${col("detected_hex_model")} END`,
    `detected_hex_prompt_version = CASE WHEN ${cond} THEN ${p(3)}::text ELSE ${col("detected_hex_prompt_version")} END`,
    `detected_hex_at = CASE WHEN ${cond} THEN now() ELSE ${col("detected_hex_at")} END`,
  ].join(",\n         ");
}
