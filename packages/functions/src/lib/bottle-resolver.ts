import {
  CaptureBrandConflict,
  CaptureBrandRef,
  CaptureSuggestedShade,
  HIGH_CONFIDENCE_MAX_DISTANCE,
  MEDIUM_CONFIDENCE_MAX_DISTANCE,
  hexToOklab,
  parseBottleSurface,
} from "swatchwatch-shared";
import type { resolveBrandFromText } from "./brand-resolve";
import { toBrandRef } from "./brand-resolve";
import type {
  CaptureEvidence,
  CaptureFrameEvidenceRow,
  CaptureMatchCandidate,
  ResolverDecision,
} from "./capture-evidence";
import { surfaceReadsShadeName, toRecord } from "./capture-evidence";
import { buildBrandShadeQuestion, buildCandidateQuestion } from "./capture-questions";
import type { query } from "./db";
import { buildNearHexDistanceSql } from "./near-hex";

/**
 * Brand-first bottle resolver (Bottle Flow slice A, spec 5.3). The brand narrows the pool, the
 * shade name ranks it, and the lacquer color from the glass photo confirms or breaks ties but
 * never overrules a name read; color alone only ever produces a list to pick from.
 */
export const BOTTLE_RESOLVER_VERSION = "bottle-v1";

/** Every band and limit of the resolver lives here and nowhere else. */
export const BOTTLE_RESOLVER_THRESHOLDS = {
  /** Name score at or above which a bottle matches on its name. */
  match: 0.92,
  /** Name score at or above which the user is asked to pick (and color can confirm a match). */
  question: 0.75,
  /** Name score below which the closest shade is no plausible candidate and the create card shows. */
  createCard: 0.5,
  /** OKLAB distance within which color confirms a mid-band name. */
  colorHigh: HIGH_CONFIDENCE_MAX_DISTANCE,
  /** OKLAB distance beyond which color rejects an auto-match, and within which color lists candidates. */
  colorMedium: MEDIUM_CONFIDENCE_MAX_DISTANCE,
  /** Lowest confidence at which a brand read from a frame is used as the session brand. */
  brandRead: 0.6,
  /** Lowest confidence at which a read of another brand than the hint is reported as a conflict. */
  brandConflict: 0.8,
  maxCandidates: 5,
  poolLimit: 50,
} as const;

/** Piecewise linear OKLAB distance → 0–1 color score. */
export const COLOR_SCORE_BREAKPOINTS: readonly (readonly [number, number])[] = [
  [0, 1],
  [0.05, 0.75],
  [0.1, 0.25],
  [0.3, 0],
];

export function colorScoreForDistance(distance: number | null): number | null {
  if (distance === null || !Number.isFinite(distance)) return null;
  const first = COLOR_SCORE_BREAKPOINTS[0];
  const last = COLOR_SCORE_BREAKPOINTS[COLOR_SCORE_BREAKPOINTS.length - 1];
  if (distance <= first[0]) return first[1];
  if (distance >= last[0]) return last[1];
  for (let i = 1; i < COLOR_SCORE_BREAKPOINTS.length; i += 1) {
    const [x1, y1] = COLOR_SCORE_BREAKPOINTS[i];
    if (distance <= x1) {
      const [x0, y0] = COLOR_SCORE_BREAKPOINTS[i - 1];
      return Math.round((y0 + ((y1 - y0) * (distance - x0)) / (x1 - x0)) * 1e6) / 1e6;
    }
  }
  return last[1];
}

export interface BottleCandidateRow {
  shadeId: string;
  brandId: string;
  brand: string;
  shadeName: string;
  nameScore: number | null;
  colorDistance: number | null;
}

export interface ScoredBottleCandidate {
  shadeId: number;
  /** 0 when unknown (candidates from the brand-less global path). */
  brandId: number;
  display: string;
  nameScore: number | null;
  colorDistance: number | null;
  colorScore: number | null;
  score: number;
  fromConflictBrand: boolean;
}

function finiteOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function compareScored(a: ScoredBottleCandidate, b: ScoredBottleCandidate): number {
  const an = a.nameScore;
  const bn = b.nameScore;
  if (an !== bn) {
    if (an === null) return 1;
    if (bn === null) return -1;
    return bn - an;
  }
  const ad = a.colorDistance;
  const bd = b.colorDistance;
  if (ad !== bd) {
    if (ad === null) return 1;
    if (bd === null) return -1;
    return ad - bd;
  }
  return a.shadeId - b.shadeId;
}

function withColor(
  base: Omit<ScoredBottleCandidate, "colorScore" | "score">
): ScoredBottleCandidate {
  const colorScore = colorScoreForDistance(base.colorDistance);
  return { ...base, colorScore, score: base.nameScore ?? colorScore ?? 0 };
}

/**
 * nameScore = max(trigram, visionConfidence) for the row whose name equals `shadeNameListed`
 * (case-insensitive), the trigram alone for the others; score = nameScore ?? colorScore ?? 0;
 * sorted nameScore DESC NULLS LAST, colorDistance ASC NULLS LAST, shade id ASC.
 */
export function scoreBottleCandidates(
  rows: readonly BottleCandidateRow[],
  input: { shadeNameListed: string | null; visionConfidence: number | null; hintBrandId: number | null }
): ScoredBottleCandidate[] {
  const listed = input.shadeNameListed?.trim().toLowerCase() || null;
  const scored = rows.map((row) => {
    let nameScore = finiteOrNull(row.nameScore);
    const isListed = listed !== null && row.shadeName.trim().toLowerCase() === listed;
    if (isListed && input.visionConfidence !== null) {
      nameScore = nameScore === null ? input.visionConfidence : Math.max(nameScore, input.visionConfidence);
    }
    const brandId = Number(row.brandId);
    return withColor({
      shadeId: Number(row.shadeId),
      brandId,
      display: `${row.brand} — ${row.shadeName}`,
      nameScore,
      colorDistance: finiteOrNull(row.colorDistance),
      fromConflictBrand: input.hintBrandId !== null && brandId !== input.hintBrandId,
    });
  });
  return scored.sort(compareScored);
}

export type BottleDecision =
  | { kind: "matched"; candidate: ScoredBottleCandidate; confidence: number; method: "name" | "name+color" }
  | { kind: "candidates"; candidates: ScoredBottleCandidate[]; confidence: number; tie: boolean; method: "name" | "color" }
  | { kind: "create_card"; confidence: 0 }
  | { kind: "unmatched"; confidence: number };

/**
 * Spec 5.3 bands for the best-ranked candidate (`D` is its OKLAB distance to the glass color,
 * null without a glass hex). `scored` must be sorted as `scoreBottleCandidates` sorts.
 */
export function decideBottleResolution(
  scored: readonly ScoredBottleCandidate[],
  ctx: { nameRead: boolean; brandKnown: boolean }
): BottleDecision {
  const T = BOTTLE_RESOLVER_THRESHOLDS;
  const top = scored[0];
  if (!top) {
    return ctx.brandKnown ? { kind: "create_card", confidence: 0 } : { kind: "unmatched", confidence: 0 };
  }

  const cut = scored.slice(0, T.maxCandidates);
  const distance = top.colorDistance;
  const nameScore = top.nameScore;

  if (nameScore !== null && nameScore >= T.match) {
    if (distance === null || distance <= T.colorMedium) {
      return { kind: "matched", candidate: top, confidence: nameScore, method: "name" };
    }
    return { kind: "candidates", candidates: cut, confidence: nameScore, tie: false, method: "name" };
  }

  if (nameScore !== null && nameScore >= T.question) {
    if (distance !== null && distance <= T.colorHigh) {
      return { kind: "matched", candidate: top, confidence: T.match, method: "name+color" };
    }
    return { kind: "candidates", candidates: cut, confidence: nameScore, tie: false, method: "name" };
  }

  if (!ctx.nameRead) {
    if (distance !== null && distance <= T.colorMedium) {
      const second = scored[1]?.colorDistance ?? null;
      return {
        kind: "candidates",
        candidates: cut,
        confidence: top.colorScore ?? 0,
        tie: second !== null && second <= T.colorMedium,
        method: "color",
      };
    }
    return ctx.brandKnown ? { kind: "create_card", confidence: 0 } : { kind: "unmatched", confidence: top.score };
  }

  if (nameScore !== null && nameScore >= T.createCard) {
    return { kind: "candidates", candidates: cut, confidence: nameScore, tie: false, method: "name" };
  }
  return ctx.brandKnown ? { kind: "create_card", confidence: 0 } : { kind: "unmatched", confidence: top.score };
}

/** Prefill for the create card: what the session knows about a bottle the catalog could not match. */
export function buildSuggestedShade(evidence: CaptureEvidence, brand: CaptureBrandRef | null): CaptureSuggestedShade {
  return {
    brandId: brand?.brandId ?? null,
    brandName: brand?.name ?? null,
    brandSource: brand?.source ?? null,
    shadeName: evidence.shadeName ?? null,
    hex: evidence.glassHex ?? null,
    finish: evidence.finish ?? null,
    gtin: evidence.gtin ?? null,
  };
}

const CANDIDATE_COLOR_DISTANCE_SQL = buildNearHexDistanceSql(["#000000"], 4).sql;

/**
 * $1 brand_id[] (bigint[]), $2 user_id, $3 printed shade name text or null, $4–$6 glass OKLAB
 * L/a/b or null, $7 the closed-set pick `shadeNameListed` or null (its row sorts first, so a
 * confident pick is never cut by the pool limit). Shades of those brands only: live color shades, plus the caller's own private
 * `user_submitted` ones (never another user's). `nameScore` is NULL without a name, and
 * `colorDistance` is NULL without a glass color or a stored display color.
 */
export const BOTTLE_CANDIDATES_SQL = `SELECT s.shade_id::text AS "shadeId",
       s.brand_id::text AS "brandId",
       b.name_canonical AS brand,
       s.shade_name_canonical AS "shadeName",
       similarity(s.shade_name_canonical, $3::text) AS "nameScore",
       ${CANDIDATE_COLOR_DISTANCE_SQL} AS "colorDistance"
FROM shade s
JOIN brand b ON b.brand_id = s.brand_id
WHERE s.brand_id = ANY($1::bigint[])
  AND s.merged_into_shade_id IS NULL
  AND s.product_category = 'color'
  AND (s.status = 'active' OR (s.status = 'user_submitted' AND s.created_by_user_id = $2))
ORDER BY COALESCE(lower(s.shade_name_canonical) = lower($7::text), false) DESC,
         "nameScore" DESC NULLS LAST, "colorDistance" ASC NULLS LAST, s.shade_id ASC
LIMIT ${BOTTLE_RESOLVER_THRESHOLDS.poolLimit}`;

const HEX_PATTERN = /^#?[0-9a-f]{6}$/i;

/** OKLAB distance from the glass hex to each shade's stored display color (null = no display color). */
export async function loadColorDistances(
  shadeIds: number[],
  glassHex: string,
  userId: number,
  db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<{ shadeId: string; distance: unknown }> }> }
): Promise<Map<number, number | null>> {
  const distances = new Map<number, number | null>();
  if (shadeIds.length === 0 || !HEX_PATTERN.test(glassHex)) return distances;

  const distance = buildNearHexDistanceSql([glassHex], 2);
  const result = await db.query(
    `SELECT s.shade_id::text AS "shadeId", ${distance.sql} AS distance
     FROM shade s
     WHERE s.shade_id = ANY($1::bigint[])
       AND (s.status = 'active' OR (s.status = 'user_submitted' AND s.created_by_user_id = $5))`,
    [shadeIds, ...distance.params, userId]
  );
  for (const row of result.rows) distances.set(Number(row.shadeId), finiteOrNull(row.distance));
  return distances;
}

export interface ResolveBottleDeps {
  query: typeof query;
  resolveBrand: typeof resolveBrandFromText;
  globalCandidates: (evidence: CaptureEvidence) => Promise<CaptureMatchCandidate[]>;
  colorDistances: (shadeIds: number[], glassHex: string) => Promise<Map<number, number | null>>;
}

export interface ResolveBottleContext {
  userId: number;
  frameCount: number;
  /** The brand the user typed at session start (`metadata.bottle.brand`). */
  hintBrand: CaptureBrandRef | null;
  barcodeBrand: { brandId: number; name: string } | null;
  /** Model calls the session's frames spent (glass + sticker reads). */
  modelCalls: number;
  /** Confidence of the sticker read that picked `shadeNameListed`. */
  visionConfidence?: number | null;
}

/** The session's typed brand, without the raw text kept beside it. */
export function hintBrandFromMetadata(metadata: Record<string, unknown> | null | undefined): CaptureBrandRef | null {
  const brand = toRecord(toRecord(metadata?.bottle).brand);
  const name = typeof brand.name === "string" ? brand.name.trim() : "";
  if (!name) return null;
  return {
    brandId: typeof brand.brandId === "string" && brand.brandId.length > 0 ? brand.brandId : null,
    name,
    source: "hint",
  };
}

function aiBlock(frame: CaptureFrameEvidenceRow, key: "glass" | "sticker"): Record<string, unknown> {
  return toRecord(toRecord(toRecord(frame.quality).ai)[key]);
}

/** Model calls recorded on the frames (`quality.ai.glass/sticker.modelCalls`). */
export function sumFrameModelCalls(frames: readonly CaptureFrameEvidenceRow[]): number {
  let total = 0;
  for (const frame of frames) {
    for (const key of ["glass", "sticker"] as const) {
      const calls = aiBlock(frame, key).modelCalls;
      if (typeof calls === "number" && Number.isFinite(calls)) total += calls;
    }
  }
  return total;
}

/** Confidence of the newest name-bearing frame's sticker read that picked a listed shade name (never the front). */
export function visionConfidenceFromFrames(frames: readonly CaptureFrameEvidenceRow[]): number | null {
  for (const frame of frames) {
    if (!surfaceReadsShadeName(parseBottleSurface(toRecord(frame.quality).surface))) continue;
    const listed = toRecord(toRecord(frame.quality).extracted).shadeNameListed;
    if (typeof listed === "string" && listed.trim().length > 0) {
      return finiteOrNull(aiBlock(frame, "sticker").confidence);
    }
  }
  return null;
}

function numericBrandId(brand: CaptureBrandRef | null): number | null {
  if (!brand || brand.brandId === null) return null;
  const id = Number(brand.brandId);
  return Number.isSafeInteger(id) ? id : null;
}

interface BrandPlan {
  brand: CaptureBrandRef | null;
  poolIds: number[];
  brandConflict?: CaptureBrandConflict;
}

/**
 * Spec 5.3: brand = hint > barcode > typed text > a frame read. Typed means the user's hint or
 * answer, or a client-sent (`request_quality`) frame brand; a brand the pipeline read (OCR or the
 * model) is always `source: "read"`, so the create card asks to confirm it (spec 4.3: model text
 * alone never creates a shared brand row). A read is used when unscored (confidence 0) or at
 * >= `brandRead`, and only when it resolves to a catalog brand; a read of another brand than the
 * hint at >= `brandConflict` joins the pool.
 */
async function planBrand(evidence: CaptureEvidence, ctx: ResolveBottleContext, deps: ResolveBottleDeps): Promise<BrandPlan> {
  const T = BOTTLE_RESOLVER_THRESHOLDS;
  const read = evidence.brandRead;
  const pipelineRead = read && read.source === "pipeline" ? read : null;

  if (ctx.hintBrand) {
    const hintId = numericBrandId(ctx.hintBrand);
    if (hintId === null) return { brand: ctx.hintBrand, poolIds: [] };
    const plan: BrandPlan = { brand: ctx.hintBrand, poolIds: [hintId] };
    if (pipelineRead && pipelineRead.confidence >= T.brandConflict) {
      const resolved = await deps.resolveBrand(pipelineRead.text);
      if (resolved && resolved.brandId !== hintId) {
        plan.poolIds.push(resolved.brandId);
        plan.brandConflict = {
          hinted: ctx.hintBrand,
          read: { ...toBrandRef(resolved, pipelineRead.text, "read"), confidence: pipelineRead.confidence },
        };
      }
    }
    return plan;
  }

  if (ctx.barcodeBrand) {
    return {
      brand: { brandId: String(ctx.barcodeBrand.brandId), name: ctx.barcodeBrand.name, source: "barcode" },
      poolIds: [ctx.barcodeBrand.brandId],
    };
  }

  const typed =
    evidence.brandSource === "hint" ? evidence.brand : read && read.source === "request_quality" ? read.text : undefined;
  if (typed) {
    const resolved = await deps.resolveBrand(typed);
    return { brand: toBrandRef(resolved, typed, "hint"), poolIds: resolved ? [resolved.brandId] : [] };
  }

  if (pipelineRead && (pipelineRead.confidence === 0 || pipelineRead.confidence >= T.brandRead)) {
    const resolved = await deps.resolveBrand(pipelineRead.text);
    if (resolved) {
      const ref = toBrandRef(resolved, pipelineRead.text, "read");
      return {
        brand: pipelineRead.confidence > 0 ? { ...ref, confidence: pipelineRead.confidence } : ref,
        poolIds: [resolved.brandId],
      };
    }
  }
  return { brand: null, poolIds: [] };
}

function toMatchCandidate(candidate: ScoredBottleCandidate, confidence = candidate.score): CaptureMatchCandidate {
  return {
    entityType: "shade",
    entityId: candidate.shadeId,
    shadeId: candidate.shadeId,
    display: candidate.display,
    confidence: Math.max(0, Math.min(1, confidence)),
    ...(candidate.brandId > 0 ? { brandId: candidate.brandId } : {}),
    colorDistance: candidate.colorDistance,
  };
}

function scoreComponents(candidate: ScoredBottleCandidate) {
  return {
    shadeId: candidate.shadeId,
    brandId: candidate.brandId,
    display: candidate.display,
    nameScore: candidate.nameScore,
    colorDistance: candidate.colorDistance,
    colorScore: candidate.colorScore,
    score: candidate.score,
    fromConflictBrand: candidate.fromConflictBrand,
  };
}

/**
 * Spec 5.3 steps 2–7 (step 1, the barcode, stays in the capture handler). Pools the brand's
 * shades (plus the read brand's on a conflict) and ranks them by name, confirming with the glass
 * color; without a catalog brand it re-ranks the global trigram candidates by color instead.
 */
export async function resolveBottle(
  evidence: CaptureEvidence,
  ctx: ResolveBottleContext,
  deps: ResolveBottleDeps
): Promise<ResolverDecision> {
  const plan = await planBrand(evidence, ctx, deps);
  const brandKnown = plan.brand !== null;
  const glassHex = evidence.glassHex && HEX_PATTERN.test(evidence.glassHex) ? evidence.glassHex : null;

  let scored: ScoredBottleCandidate[];
  let nameRead: boolean;
  if (plan.poolIds.length > 0) {
    const oklab = glassHex ? hexToOklab(glassHex) : null;
    const result = await deps.query<BottleCandidateRow>(BOTTLE_CANDIDATES_SQL, [
      plan.poolIds,
      ctx.userId,
      evidence.shadeName ?? null,
      oklab ? oklab.L : null,
      oklab ? oklab.a : null,
      oklab ? oklab.b : null,
      evidence.shadeNameListed ?? null,
    ]);
    scored = scoreBottleCandidates(result.rows, {
      shadeNameListed: evidence.shadeNameListed ?? null,
      visionConfidence: ctx.visionConfidence ?? null,
      hintBrandId: numericBrandId(ctx.hintBrand),
    });
    nameRead = Boolean(evidence.shadeName || evidence.shadeNameListed);
  } else {
    const global = (await deps.globalCandidates(evidence)).filter(
      (candidate): candidate is CaptureMatchCandidate & { shadeId: number } => candidate.shadeId !== null
    );
    const distances = glassHex && global.length > 0
      ? await deps.colorDistances(global.map((candidate) => candidate.shadeId), glassHex)
      : new Map<number, number | null>();
    scored = global
      .map((candidate) =>
        withColor({
          shadeId: candidate.shadeId,
          brandId: 0,
          display: candidate.display,
          nameScore: candidate.confidence,
          colorDistance: distances.get(candidate.shadeId) ?? null,
          fromConflictBrand: false,
        })
      )
      .sort(compareScored);
    nameRead = Boolean(evidence.shadeName);
  }

  const decision = decideBottleResolution(scored, { nameRead, brandKnown });
  const suggestedShade = brandKnown && decision.kind !== "matched" ? buildSuggestedShade(evidence, plan.brand) : undefined;
  const audit = {
    version: BOTTLE_RESOLVER_VERSION,
    frameCount: ctx.frameCount,
    hasTextEvidence: Boolean(evidence.gtin || evidence.shadeName || evidence.brand),
    evidence: {
      gtin: evidence.gtin ?? null,
      brand: evidence.brand ?? null,
      brandSource: evidence.brandSource ?? null,
      brandRead: evidence.brandRead ?? null,
      shadeName: evidence.shadeName ?? null,
      shadeNameListed: evidence.shadeNameListed ?? null,
      finish: evidence.finish ?? null,
      glassHex: evidence.glassHex ?? null,
      glassHexConfidence: evidence.glassHexConfidence ?? null,
      surfaces: evidence.surfaces,
    },
    thresholds: BOTTLE_RESOLVER_THRESHOLDS,
  };
  const resolverBase = {
    version: BOTTLE_RESOLVER_VERSION,
    brand: plan.brand,
    candidateCount: scored.length,
    top5: scored.slice(0, BOTTLE_RESOLVER_THRESHOLDS.maxCandidates).map(scoreComponents),
    ...(suggestedShade ? { suggestedShade } : {}),
    ...(plan.brandConflict ? { brandConflict: plan.brandConflict } : {}),
    modelCalls: ctx.modelCalls,
    audit,
  };
  const bottle = (tie: boolean) => ({
    brand: plan.brand,
    ...(suggestedShade ? { suggestedShade } : {}),
    ...(plan.brandConflict ? { brandConflict: plan.brandConflict } : {}),
    tie,
    modelCalls: ctx.modelCalls,
  });
  const ranked = scored.slice(0, BOTTLE_RESOLVER_THRESHOLDS.maxCandidates);

  switch (decision.kind) {
    case "matched":
      return {
        status: "matched",
        confidence: decision.confidence,
        entityType: "shade",
        entityId: decision.candidate.shadeId,
        candidates: ranked.map((candidate, i) => toMatchCandidate(candidate, i === 0 ? decision.confidence : candidate.score)),
        metadataPatch: {
          resolver: {
            ...resolverBase,
            step: decision.method === "name" ? "matched_by_name" : "matched_by_name_and_color",
            method: decision.method,
            topCandidate: decision.candidate.display,
          },
        },
        bottle: bottle(false),
      };
    case "candidates": {
      const candidates = decision.candidates.map((candidate) => toMatchCandidate(candidate));
      return {
        status: "needs_question",
        confidence: decision.confidence,
        question: buildCandidateQuestion(candidates),
        candidates,
        metadataPatch: {
          resolver: {
            ...resolverBase,
            step: "needs_user_candidate_selection",
            method: decision.method,
            topCandidate: candidates[0]?.display ?? null,
          },
        },
        bottle: bottle(decision.tie),
      };
    }
    case "create_card":
      // No plausible candidate: none is sent, so the create card shows (the top five stay in the audit).
      return {
        status: "unmatched",
        confidence: 0,
        candidates: [],
        metadataPatch: { resolver: { ...resolverBase, step: "create_card", method: "create_card" } },
        bottle: bottle(false),
      };
    case "unmatched": {
      const candidates = ranked.map((candidate) => toMatchCandidate(candidate));
      if (!evidence.brand || !evidence.shadeName) {
        return {
          status: "needs_question",
          confidence: decision.confidence,
          question: buildBrandShadeQuestion(),
          candidates,
          metadataPatch: {
            resolver: {
              ...resolverBase,
              step: "needs_brand_and_shade",
              method: "unmatched",
              shadeName: evidence.shadeName ?? null,
            },
          },
          bottle: bottle(false),
        };
      }
      return {
        status: "unmatched",
        confidence: decision.confidence,
        candidates,
        metadataPatch: {
          resolver: {
            ...resolverBase,
            step: "unmatched_after_resolver",
            method: "unmatched",
            shadeName: evidence.shadeName,
          },
        },
        bottle: bottle(false),
      };
    }
  }
}
