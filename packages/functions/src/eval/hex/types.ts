import type { MatchConfidence } from "swatchwatch-shared";

/**
 * Ground-truth evaluation fixtures for vendor-image hex detection.
 *
 * A fixture is a JSON document (`{ "version": 1, "cases": [...] }`) checked in
 * under `packages/functions/eval/hex/fixtures/` or exported from
 * `color_training_sample` by `npm run eval:hex:populate`. Each case pairs one
 * product image (what a detection strategy sees) with the hex we trust for
 * that shade (what the strategy is scored against).
 */

/** Where a case's ground-truth hex came from. Mirrors `color_training_sample.source_type`. */
export type GroundTruthSource =
  | "vendor_option" // hex published by the vendor in a Shopify variant option
  | "swatch_measured" // measured from the vendor's own painted-nail swatch photo
  | "manual" // hand-curated
  | "ai_detected"; // previously AI-detected and human-approved

export interface EvalCase {
  /** Stable unique id, e.g. `mooncat:noseboop`. */
  id: string;
  brand: string;
  shadeName: string;
  /** Canonical finishes, primary first. The first entry is the "primary finish" breakdown key. */
  finishes: string[];
  /** Trusted hex (`#RRGGBB`). */
  groundTruthHex: string;
  groundTruthSource: GroundTruthSource;
  /** Ingestion source name (`data_source.name`), e.g. `HoloTacoShopify`. */
  source: string;
  /** Public image URL the strategy is run against. Exactly one of imageUrl / imagePath is required. */
  imageUrl?: string;
  /** Image path relative to the fixture file's directory. */
  imagePath?: string;
  /**
   * Optional: every product image with its Shopify alt text / position, for
   * strategies that choose which photo to analyze (e.g. `image-select`).
   * `imageUrl`/`imagePath` stays the primary image that single-image strategies see.
   */
  images?: EvalCaseImageRef[];
  /** Optional vendor context forwarded to the production prompt (strategy `azure-current`). */
  description?: string | null;
  tags?: string[];
  externalId?: string | null;
  /** Free-form provenance note (e.g. which photo the ground truth was measured from). */
  notes?: string | null;
}

/** One candidate product image on a case. */
export interface EvalCaseImageRef {
  /** Public http(s) URL. */
  url: string;
  /** Shopify image alt text, when the vendor set one. */
  alt?: string;
  /** Shopify image position (1-based), when known. */
  position?: number;
}

export interface EvalFixture {
  version: 1;
  /** Optional human description of the set. */
  description?: string;
  cases: EvalCase[];
}

/** Image bytes handed to a strategy, loaded from `imageUrl`/`imagePath`. */
export interface CaseImage {
  bytes: Buffer;
  /** e.g. `image/jpeg`; derived from the decoded format. */
  contentType: string;
  /** `data:<contentType>;base64,...` for callers that need an inline image. */
  dataUri: string;
  /** Public URL when the case came from `imageUrl`. */
  sourceUrl: string | null;
}

/** A case's candidate image, loaded on demand (downloads go through the image cache). */
export interface StrategyCaseImage {
  /** Index in `evalCase.images`. */
  index: number;
  url: string;
  alt: string | null;
  position: number | null;
  load(): Promise<CaseImage>;
}

export interface StrategyInput {
  evalCase: EvalCase;
  /** The case's primary image (`imageUrl` / `imagePath`). */
  image: CaseImage;
  /**
   * Present only when the case has an `images` list. Lazy, so strategies that
   * only read `image` never trigger extra downloads.
   */
  images?: StrategyCaseImage[];
}

export interface StrategyOutput {
  /** Predicted hex (`#RRGGBB`) or null when the strategy produced nothing. */
  hex: string | null;
  /** Model-reported confidence (0–1) when available. */
  confidence?: number | null;
  /** Detected finishes when the strategy returns them. */
  finishes?: string[] | null;
  /** Anything else worth keeping in the results JSON (token usage, palette, ...). */
  meta?: Record<string, unknown>;
}

export interface HexDetectionStrategy {
  name: string;
  description: string;
  /** True when the strategy calls Azure OpenAI; the runner skips it when config is missing. */
  requiresAzureOpenAI: boolean;
  run(input: StrategyInput): Promise<StrategyOutput>;
}

/** One scored case. */
export interface CaseScore {
  caseId: string;
  brand: string;
  shadeName: string;
  primaryFinish: string;
  groundTruthHex: string;
  predictedHex: string | null;
  /** OKLAB Euclidean distance, or null when there was no prediction. */
  distance: number | null;
  /** Confidence bucket for `distance`; `none` when there was no prediction. */
  bucket: MatchConfidence | "none";
  confidence?: number | null;
  finishes?: string[] | null;
  /** Set when the strategy threw or the image could not be loaded. */
  error?: string | null;
  meta?: Record<string, unknown>;
}

/** Aggregate stats for a group of cases (overall, per brand, per finish). */
export interface ScoreSummary {
  /** Cases in the group. */
  count: number;
  /** Cases with a prediction (distance != null). */
  scored: number;
  /** Cases without a prediction (error or null hex). */
  missing: number;
  /** Median distance over scored cases, or null when none were scored. */
  medianDistance: number | null;
  /** 90th percentile (nearest-rank) distance over scored cases, or null. */
  p90Distance: number | null;
  /** Share of ALL cases within the HIGH threshold (missing predictions count as outside). */
  withinHigh: number;
  /** Share of ALL cases within the MEDIUM threshold (missing predictions count as outside). */
  withinMedium: number;
}

export interface EvalReport {
  strategy: string;
  fixture: string;
  generatedAt: string;
  thresholds: { high: number; medium: number };
  overall: ScoreSummary;
  byBrand: Record<string, ScoreSummary>;
  byFinish: Record<string, ScoreSummary>;
  cases: CaseScore[];
}
