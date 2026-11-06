import type { CaptureCheckResponse, CaptureStatusResponse } from "swatchwatch-shared";
import { BOTTLE_RESOLVER_THRESHOLDS, BOTTLE_RESOLVER_VERSION } from "../../lib/bottle-resolver";
import { candidateShadeId } from "./scoring";
import type { EvalSample, FailureStage, Outcome } from "./types";

export interface Attribution {
  stage: FailureStage;
  /** Short human-readable evidence for the stage (scores, read text); never used for scoring. */
  detail: string;
}

interface TraceCandidate {
  shadeId: number;
  nameScore: number | null;
  colorDistance: number | null;
}

/**
 * What the eval reads from the session's stored resolver audit (`metadata.resolver`, written by
 * the bottle flow after every frame from the same resolution `check` re-runs).
 */
export interface ResolverTrace {
  step: string | null;
  /** `bottle-v1` (brand-first resolver) when the audit carries its brand and top five. */
  brandFirst: boolean;
  brand: { brandId: string | null; name: string } | null;
  /** Catalog brand id of a conflicting read brand that joined the pool (`brandConflict.read`). */
  conflictBrand: { brandId: string | null; name: string } | null;
  top5: TraceCandidate[];
  brandText: string | null;
  shadeName: string | null;
  shadeNameListed: string | null;
  glassHex: string | null;
  thresholds: { match: number; question: number; colorHigh: number; colorMedium: number };
}

/** `value` as a plain object, else `{}`. */
function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** A non-empty trimmed string, else `null`. */
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** A finite number (numeric strings included), else `null`. */
function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** A stored `CaptureBrandRef` as `{ brandId, name }`, or `null` without a name. */
function brandRef(value: unknown): { brandId: string | null; name: string } | null {
  const ref = record(value);
  const name = text(ref.name);
  if (!name) return null;
  const id = ref.brandId;
  return { brandId: id === null || id === undefined || id === "" ? null : String(id), name };
}

/** Pure: the resolver trace from a status read; `null` when the session stored no resolver audit. */
export function resolverTraceFromStatus(status: Pick<CaptureStatusResponse, "metadata"> | null | undefined): ResolverTrace | null {
  const resolver = record(status?.metadata?.resolver);
  if (Object.keys(resolver).length === 0) return null;
  const audit = record(resolver.audit);
  const evidence = record(audit.evidence);
  const thresholds = record(audit.thresholds);
  const brandRead = record(evidence.brandRead);
  const top5 = Array.isArray(resolver.top5)
    ? resolver.top5.flatMap((raw) => {
        const row = record(raw);
        const shadeId = num(row.shadeId);
        return shadeId === null ? [] : [{ shadeId, nameScore: num(row.nameScore), colorDistance: num(row.colorDistance) }];
      })
    : [];
  return {
    step: text(resolver.step),
    brandFirst: resolver.version === BOTTLE_RESOLVER_VERSION,
    brand: brandRef(resolver.brand),
    conflictBrand: brandRef(record(resolver.brandConflict).read),
    top5,
    brandText: text(evidence.brand) ?? text(brandRead.text),
    shadeName: text(evidence.shadeName),
    shadeNameListed: text(evidence.shadeNameListed),
    glassHex: text(evidence.glassHex),
    thresholds: {
      match: num(thresholds.match) ?? BOTTLE_RESOLVER_THRESHOLDS.match,
      question: num(thresholds.question) ?? BOTTLE_RESOLVER_THRESHOLDS.question,
      colorHigh: num(thresholds.colorHigh) ?? BOTTLE_RESOLVER_THRESHOLDS.colorHigh,
      colorMedium: num(thresholds.colorMedium) ?? BOTTLE_RESOLVER_THRESHOLDS.colorMedium,
    },
  };
}

/** The check verdict a stored resolver step stands for (`null` = a step the eval does not know). */
function stepOutcome(step: string | null): CaptureCheckResponse["outcome"] | null {
  if (!step) return null;
  if (step.startsWith("matched_")) return "matched";
  if (step.startsWith("needs_")) return "needs_question";
  if (step === "create_card" || step === "unmatched_after_resolver") return "unmatched";
  return null;
}

/** A score for the detail text: two decimals, `-` when missing. */
function fmt(value: number | null): string {
  return value === null ? "-" : value.toFixed(2);
}

/** Case-insensitive equality of two non-empty names. */
function sameName(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());
}

/**
 * Pure: the earliest resolver stage that lost a sample, or `null` for `matched_correct`,
 * `skipped_no_frames` and `error` (nothing to attribute). Reads the check verdict, the session's
 * stored resolver audit (`resolverTraceFromStatus`) and the label. Stages in pipeline order:
 *
 * 1. barcode: the session matched by barcode to another shade → `barcode_wrong_shade`.
 * 2. brand: no brand → `brand_not_read` (no text at all) or `brand_not_in_catalog` (text that did
 *    not become a catalog brand); a catalog brand that is not the label's (nor the conflicting read
 *    brand's that joined the pool) → `brand_wrong`.
 * 3. pool: the labelled shade cannot be in its brand's pool (merged, not active, not a color
 *    shade) → `candidate_pool_missing_label`.
 * 4. name: no printed or listed name → `name_not_read`; the label outside the top five →
 *    `name_wrong`; outranked by name → `name_wrong` when another shade was matched, else
 *    `name_ambiguous`; ranked first but under the question band → `name_weak`.
 * 5. color: ranked first in the question band without a color distance → `color_no_hex`, with a
 *    distance outside the confirm band → `color_not_confirmed`; a match-band name the color vetoed
 *    → `color_vetoed`; tied on name and ordered by color → `color_tie_broke_wrong` (or
 *    `color_no_hex` when the label had no distance).
 *
 * Not-in-catalog labels: `rejected_correct` → `label_not_in_catalog_expected`, a match →
 * `false_match_not_in_catalog` (or `barcode_wrong_shade`). Anything else, a missing audit (flag
 * off) or an audit that disagrees with the check → `unknown`.
 */
export function attributeFailure(
  sample: Pick<EvalSample, "shadeId" | "brand"> & Partial<Pick<EvalSample, "brandId" | "labelPoolEligible">>,
  outcome: Outcome,
  check: Pick<CaptureCheckResponse, "outcome" | "match" | "candidates">,
  trace: ResolverTrace | null
): Attribution | null {
  if (outcome === "matched_correct" || outcome === "skipped_no_frames" || outcome === "error") return null;

  if (outcome === "rejected_correct") {
    return { stage: "label_not_in_catalog_expected", detail: "not in catalog, no match claimed" };
  }
  const barcode = trace?.step === "matched_by_barcode";
  if (sample.shadeId === null) {
    return barcode
      ? { stage: "barcode_wrong_shade", detail: "barcode matched a catalog shade for a bottle not in the catalog" }
      : { stage: "false_match_not_in_catalog", detail: `matched ${candidateShadeId(check.match ?? check.candidates?.[0]) ?? "-"}` };
  }
  if (!trace) return { stage: "unknown", detail: "no resolver audit in the session (bottle flow off?)" };
  if (stepOutcome(trace.step) !== check.outcome) {
    return { stage: "unknown", detail: `stored resolver step ${trace.step ?? "-"} disagrees with check ${check.outcome}` };
  }
  if (barcode) {
    return { stage: "barcode_wrong_shade", detail: `barcode → ${candidateShadeId(check.match ?? check.candidates?.[0]) ?? "-"}` };
  }
  if (!trace.brandFirst) return { stage: "unknown", detail: `resolver audit ${trace.step ?? "-"} is not ${BOTTLE_RESOLVER_VERSION}` };

  // Stage 2: brand.
  if (!trace.brand || trace.brand.brandId === null) {
    const read = trace.brand?.name ?? trace.brandText;
    return read
      ? { stage: "brand_not_in_catalog", detail: `brand text "${read}" did not resolve to a catalog brand` }
      : { stage: "brand_not_read", detail: "no brand from hint, barcode, OCR or the model" };
  }
  const labelBrandId = sample.brandId ?? null;
  const pooled = [trace.brand, trace.conflictBrand].filter((b): b is { brandId: string | null; name: string } => b !== null);
  const brandRight =
    labelBrandId !== null
      ? pooled.some((b) => b.brandId === String(labelBrandId))
      : pooled.some((b) => sameName(b.name, sample.brand));
  if (!brandRight) {
    return { stage: "brand_wrong", detail: `brand "${trace.brand.name}", label "${sample.brand}"` };
  }

  // Stage 3: pool.
  if (sample.labelPoolEligible === false) {
    return { stage: "candidate_pool_missing_label", detail: "label shade is merged, not active or not a color shade" };
  }

  // Stage 4: name.
  if (!trace.shadeName && !trace.shadeNameListed) {
    return { stage: "name_not_read", detail: trace.glassHex ? `no name; glass ${trace.glassHex}` : "no name, no glass hex" };
  }
  const readText = `read "${trace.shadeName ?? "-"}" listed "${trace.shadeNameListed ?? "-"}"`;
  const rank = trace.top5.findIndex((c) => c.shadeId === sample.shadeId);
  if (rank < 0) {
    return { stage: "name_wrong", detail: `${readText}; label not in top ${trace.top5.length}, top name ${fmt(trace.top5[0]?.nameScore ?? null)}` };
  }
  const T = trace.thresholds;
  const top = trace.top5[0];
  const label = trace.top5[rank];

  if (rank === 0) {
    const ns = label.nameScore;
    const d = label.colorDistance;
    const scores = `name ${fmt(ns)} color ${fmt(d)}`;
    if (ns !== null && ns >= T.match) {
      return d !== null && d > T.colorMedium
        ? { stage: "color_vetoed", detail: `${scores}: glass too far from the shade's color` }
        : { stage: "unknown", detail: `label ranked first with ${scores}` };
    }
    if (ns !== null && ns >= T.question) {
      return d === null
        ? { stage: "color_no_hex", detail: `${scores}: no color distance to confirm the name` }
        : { stage: "color_not_confirmed", detail: `${scores}: color outside the confirm band` };
    }
    return { stage: "name_weak", detail: `${readText}; ${scores}` };
  }

  // Stage 5 for a name tie, else stage 4: the label is in the top five but not first.
  const tied = top.nameScore !== null && label.nameScore !== null && Math.abs(top.nameScore - label.nameScore) < 1e-9;
  const versus = `label #${rank + 1} name ${fmt(label.nameScore)} color ${fmt(label.colorDistance)} vs top name ${fmt(top.nameScore)} color ${fmt(top.colorDistance)}`;
  if (tied || (top.nameScore === null && label.nameScore === null)) {
    return label.colorDistance === null
      ? { stage: "color_no_hex", detail: `${versus}: name tie, no color distance for the label` }
      : { stage: "color_tie_broke_wrong", detail: `${versus}: name tie broken by color` };
  }
  return check.outcome === "matched"
    ? { stage: "name_wrong", detail: `${readText}; ${versus}` }
    : { stage: "name_ambiguous", detail: `${readText}; ${versus}` };
}
