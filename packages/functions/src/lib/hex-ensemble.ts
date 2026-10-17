import { hexToOklab, oklabDistance } from "swatchwatch-shared";
import { MEDIUM_CONFIDENCE_MAX_DISTANCE, normalizeHex } from "./color-match";

/**
 * Pure aggregation math for ensemble hex detection: several independent
 * detections (repeated samples at a small temperature, possibly across more
 * than one deployment) are reduced to one hex plus a measure of how much the
 * samples agreed. No I/O; the eval strategy in `src/eval/hex/strategies/ensemble.ts`
 * collects the samples and calls `aggregateHexSamples`.
 *
 * - **hex**: the medoid of the valid samples in OKLAB (the sample with the
 *   smallest summed distance to all the others), so the answer is always one
 *   of the model's own outputs, never an average that no model proposed.
 * - **spread**: mean OKLAB distance from the other valid samples to the medoid.
 *   0 = every sample agreed exactly.
 * - **confidence**: agreement derived from the spread (0 at spread ≥ the MEDIUM
 *   match threshold, 1 at spread 0) blended 50/50 with the samples' own mean
 *   reported confidence when any sample reported one.
 * - **finishes**: union of reported finishes, kept when at least half the valid
 *   samples reported them; `votes` carries the full tally.
 */

export interface HexSample {
  hex: string | null;
  confidence?: number | null;
  finishes?: string[] | null;
}

export interface HexEnsembleResult {
  /** Medoid hex (`#RRGGBB`), or null when no sample produced a valid hex. */
  hex: string | null;
  /** Index into the input `samples` of the medoid, or null when there is none. */
  medoidIndex: number | null;
  /** Mean OKLAB distance of the other valid samples to the medoid; null with fewer than two valid samples. */
  spread: number | null;
  /** 0–1 agreement derived from `spread`; null with fewer than two valid samples. */
  agreement: number | null;
  /** Combined confidence (agreement blended with reported confidences), or null when nothing can be said. */
  confidence: number | null;
  /** Finishes reported by at least half the valid samples, most-voted first; null when none qualify. */
  finishes: string[] | null;
  /** Vote count per finish across valid samples (every finish seen, not just the kept ones). */
  votes: Record<string, number>;
  /** Per-sample OKLAB distance to the medoid (0 for the medoid itself; null for samples without a valid hex). */
  distances: Array<number | null>;
  /** Number of samples with a valid hex. */
  validCount: number;
}

/** Spread at which agreement reaches 0: the MEDIUM match threshold (samples that far apart are different colors). */
export const ENSEMBLE_SPREAD_ZERO_AGREEMENT = MEDIUM_CONFIDENCE_MAX_DISTANCE;

const ROUND_DECIMALS = 4;

function roundTo(value: number, decimals = ROUND_DECIMALS): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Linear map of spread to agreement: 1 at spread 0, 0 at spread ≥ ENSEMBLE_SPREAD_ZERO_AGREEMENT. */
export function agreementForSpread(spread: number): number {
  if (!Number.isFinite(spread) || spread <= 0) return 1;
  return Math.max(0, 1 - spread / ENSEMBLE_SPREAD_ZERO_AGREEMENT);
}

function reportedConfidence(sample: HexSample): number | null {
  const value = sample.confidence;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, value));
}

function normalizeFinish(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed || null;
}

/** Count finish votes over the given samples (each sample votes once per distinct finish). */
export function tallyFinishVotes(samples: readonly HexSample[]): Record<string, number> {
  const votes: Record<string, number> = {};
  for (const sample of samples) {
    if (!Array.isArray(sample.finishes)) continue;
    const seen = new Set<string>();
    for (const raw of sample.finishes) {
      const finish = normalizeFinish(raw);
      if (!finish || seen.has(finish)) continue;
      seen.add(finish);
      votes[finish] = (votes[finish] ?? 0) + 1;
    }
  }
  return votes;
}

/** Finishes with at least `ceil(voterCount / 2)` votes, most-voted first (ties keep insertion order). */
export function majorityFinishes(votes: Record<string, number>, voterCount: number): string[] | null {
  if (voterCount <= 0) return null;
  const needed = Math.ceil(voterCount / 2);
  const kept = Object.entries(votes)
    .filter(([, count]) => count >= needed)
    .sort((a, b) => b[1] - a[1])
    .map(([finish]) => finish);
  return kept.length ? kept : null;
}

export function aggregateHexSamples(samples: readonly HexSample[]): HexEnsembleResult {
  const valid: Array<{ index: number; hex: string; lab: ReturnType<typeof hexToOklab> }> = [];
  samples.forEach((sample, index) => {
    const hex = normalizeHex(sample.hex);
    if (hex) valid.push({ index, hex, lab: hexToOklab(hex) });
  });

  const empty: HexEnsembleResult = {
    hex: null,
    medoidIndex: null,
    spread: null,
    agreement: null,
    confidence: null,
    finishes: null,
    votes: {},
    distances: samples.map(() => null),
    validCount: 0,
  };
  if (valid.length === 0) return empty;

  const validSamples = valid.map(({ index }) => samples[index]);
  const votes = tallyFinishVotes(validSamples);
  const finishes = majorityFinishes(votes, valid.length);
  const reported = validSamples.map(reportedConfidence).filter((c): c is number => c !== null);
  const meanReported = reported.length ? reported.reduce((sum, c) => sum + c, 0) / reported.length : null;

  if (valid.length === 1) {
    const [only] = valid;
    const distances = samples.map((_, index) => (index === only.index ? 0 : null));
    return {
      hex: only.hex,
      medoidIndex: only.index,
      spread: null,
      agreement: null,
      confidence: meanReported === null ? null : roundTo(meanReported),
      finishes,
      votes,
      distances,
      validCount: 1,
    };
  }

  // Pairwise OKLAB distances; the medoid minimizes the summed distance to the others (ties → lowest index).
  const n = valid.length;
  const pairwise: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = oklabDistance(valid[i].lab, valid[j].lab);
      pairwise[i][j] = d;
      pairwise[j][i] = d;
    }
  }
  let medoid = 0;
  let bestSum = Number.POSITIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    const sum = pairwise[i].reduce((acc, d) => acc + d, 0);
    if (sum < bestSum) {
      bestSum = sum;
      medoid = i;
    }
  }

  const spread = roundTo(bestSum / (n - 1));
  const agreement = roundTo(agreementForSpread(spread));
  const confidence = roundTo(meanReported === null ? agreement : 0.5 * agreement + 0.5 * meanReported);

  const distances: Array<number | null> = samples.map(() => null);
  valid.forEach((entry, i) => {
    distances[entry.index] = roundTo(pairwise[medoid][i]);
  });

  return {
    hex: valid[medoid].hex,
    medoidIndex: valid[medoid].index,
    spread,
    agreement,
    confidence,
    finishes,
    votes,
    distances,
    validCount: n,
  };
}
