import type { CaptureCheckCandidate, CaptureCheckResponse } from "swatchwatch-shared";
import type { EvalSample, EvalSummary, Outcome, SampleResult } from "./types";

/** Every outcome, in report order. */
export const OUTCOMES: readonly Outcome[] = [
  "matched_correct",
  "matched_wrong",
  "asked_has_correct",
  "asked_no_correct",
  "unmatched",
  "rejected_correct",
  "skipped_no_frames",
  "error",
];

/** Outcomes that are not a resolver answer: left out of the rates and the median. */
const UNSCORED: ReadonlySet<Outcome> = new Set<Outcome>(["skipped_no_frames", "error"]);

/** Shade a check candidate resolves to (a SKU's shade; a shade entity's own id), or null. */
export function candidateShadeId(candidate: CaptureCheckCandidate | undefined | null): number | null {
  if (!candidate) return null;
  const raw = candidate.shadeId ?? (candidate.entityType === "shade" ? candidate.entityId : null);
  if (raw === null || raw === undefined) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Pure: score one check answer against the sample's label. Reads the resolver verdict
 * (`check.outcome`) and compares shades (`match.shadeId`, `candidates[].shadeId`), so a SKU of the
 * right shade counts as right. `check.status` is the stored session status, which `check` never
 * changes, so it is not read. Never returns `skipped_no_frames` or `error` (the CLI sets those).
 */
export function classifyOutcome(
  sample: Pick<EvalSample, "shadeId">,
  check: Pick<CaptureCheckResponse, "outcome" | "match" | "candidates">
): Outcome {
  if (sample.shadeId === null) {
    return check.outcome === "matched" ? "matched_wrong" : "rejected_correct";
  }
  switch (check.outcome) {
    case "matched":
      return candidateShadeId(check.match ?? check.candidates?.[0]) === sample.shadeId
        ? "matched_correct"
        : "matched_wrong";
    case "needs_question":
      return (check.candidates ?? []).some((candidate) => candidateShadeId(candidate) === sample.shadeId)
        ? "asked_has_correct"
        : "asked_no_correct";
    default:
      return "unmatched";
  }
}

function emptyCounts(): Record<Outcome, number> {
  return Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0])) as Record<Outcome, number>;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Pure: totals per outcome and per brand, plus the rates. Rates are over the scored catalog samples
 * (skipped and errored samples are counted per outcome but left out of the rates and the median).
 */
export function summarize(results: SampleResult[]): EvalSummary {
  const byOutcome = emptyCounts();
  const byBrand: Record<string, Record<Outcome, number>> = {};
  let catalogScored = 0;
  const scoredMs: number[] = [];

  for (const result of results) {
    byOutcome[result.outcome] += 1;
    const brandCounts = (byBrand[result.brand] ??= emptyCounts());
    brandCounts[result.outcome] += 1;
    if (UNSCORED.has(result.outcome)) continue;
    scoredMs.push(result.ms);
    if (result.inCatalog) catalogScored += 1;
  }

  const rate = (count: number) => (catalogScored === 0 ? 0 : count / catalogScored);
  return {
    samples: results.length,
    byOutcome,
    matchRate: rate(byOutcome.matched_correct),
    askRate: rate(byOutcome.asked_has_correct + byOutcome.asked_no_correct),
    falseConfident: byOutcome.matched_wrong,
    medianMs: median(scoredMs),
    byBrand,
  };
}
