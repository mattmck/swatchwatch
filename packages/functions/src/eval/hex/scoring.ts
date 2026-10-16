import { hexToOklab, oklabDistance } from "swatchwatch-shared";
import {
  confidenceForDistance,
  HIGH_CONFIDENCE_MAX_DISTANCE,
  MEDIUM_CONFIDENCE_MAX_DISTANCE,
  normalizeHex,
} from "../../lib/color-match";
import type { CaseScore, EvalCase, EvalReport, ScoreSummary, StrategyOutput } from "./types";

export const UNKNOWN_FINISH = "unknown";

/** Primary finish used as the per-finish breakdown key (first canonical finish, or `unknown`). */
export function primaryFinishOf(evalCase: Pick<EvalCase, "finishes">): string {
  const first = evalCase.finishes?.find((finish) => typeof finish === "string" && finish.trim());
  return first ? first.trim().toLowerCase() : UNKNOWN_FINISH;
}

/** Score one strategy output against its case's ground truth. Pure. */
export function scoreCase(evalCase: EvalCase, output: StrategyOutput | null, error?: string | null): CaseScore {
  const groundTruthHex = normalizeHex(evalCase.groundTruthHex);
  if (!groundTruthHex) {
    throw new Error(`Case ${evalCase.id} has an invalid groundTruthHex: ${evalCase.groundTruthHex}`);
  }

  const predictedHex = output ? normalizeHex(output.hex) : null;
  const distance = predictedHex
    ? roundTo(oklabDistance(hexToOklab(groundTruthHex), hexToOklab(predictedHex)), 4)
    : null;

  return {
    caseId: evalCase.id,
    brand: evalCase.brand,
    shadeName: evalCase.shadeName,
    primaryFinish: primaryFinishOf(evalCase),
    groundTruthHex,
    predictedHex,
    distance,
    bucket: distance === null ? "none" : confidenceForDistance(distance),
    confidence: output?.confidence ?? null,
    finishes: output?.finishes ?? null,
    error: error ?? null,
    ...(output?.meta ? { meta: output.meta } : {}),
  };
}

/** Nearest-rank percentile (p in 0–1) of a non-empty, unsorted list. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const clamped = Math.min(1, Math.max(0, p));
  const rank = Math.max(1, Math.ceil(clamped * sorted.length));
  return sorted[rank - 1];
}

/** Median (average of the two middle values for even counts). */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function summarize(scores: CaseScore[]): ScoreSummary {
  const distances = scores
    .map((score) => score.distance)
    .filter((distance): distance is number => typeof distance === "number");
  const count = scores.length;
  const withinHigh = distances.filter((d) => d <= HIGH_CONFIDENCE_MAX_DISTANCE).length;
  const withinMedium = distances.filter((d) => d <= MEDIUM_CONFIDENCE_MAX_DISTANCE).length;

  return {
    count,
    scored: distances.length,
    missing: count - distances.length,
    medianDistance: roundOrNull(median(distances)),
    p90Distance: roundOrNull(percentile(distances, 0.9)),
    withinHigh: count === 0 ? 0 : roundTo(withinHigh / count, 4),
    withinMedium: count === 0 ? 0 : roundTo(withinMedium / count, 4),
  };
}

function groupBy(scores: CaseScore[], key: (score: CaseScore) => string): Record<string, ScoreSummary> {
  const groups = new Map<string, CaseScore[]>();
  for (const score of scores) {
    const k = key(score);
    const list = groups.get(k);
    if (list) list.push(score);
    else groups.set(k, [score]);
  }
  const out: Record<string, ScoreSummary> = {};
  for (const k of [...groups.keys()].sort()) {
    out[k] = summarize(groups.get(k)!);
  }
  return out;
}

export interface BuildReportOptions {
  strategy: string;
  fixture: string;
  generatedAt?: Date;
}

/** Assemble the full report (overall + per brand + per primary finish). Pure. */
export function buildReport(scores: CaseScore[], options: BuildReportOptions): EvalReport {
  return {
    strategy: options.strategy,
    fixture: options.fixture,
    generatedAt: (options.generatedAt ?? new Date()).toISOString(),
    thresholds: { high: HIGH_CONFIDENCE_MAX_DISTANCE, medium: MEDIUM_CONFIDENCE_MAX_DISTANCE },
    overall: summarize(scores),
    byBrand: groupBy(scores, (score) => score.brand),
    byFinish: groupBy(scores, (score) => score.primaryFinish),
    cases: scores,
  };
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function roundOrNull(value: number | null): number | null {
  return value === null ? null : roundTo(value, 4);
}
