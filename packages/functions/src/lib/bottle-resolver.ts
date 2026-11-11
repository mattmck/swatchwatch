import {
  CaptureBrandConflict,
  CaptureBrandRef,
  CaptureSuggestedShade,
  HIGH_CONFIDENCE_MAX_DISTANCE,
  MEDIUM_CONFIDENCE_MAX_DISTANCE,
  buildVendorCodeIndex,
  decideName,
  findVendorCodeShades,
  hexToOklab,
  isVendorCodeAlias,
  normalizeMatchText,
  parseBottleSurface,
  rankNames,
} from "swatchwatch-shared";
import type { MatchListEntry, NameDecision } from "swatchwatch-shared";
import type { resolveBrandFromText } from "./brand-resolve";
import { BOTTLE_POOL_CATEGORY_SQL, toBrandRef } from "./brand-resolve";
import type {
  CaptureEvidence,
  CaptureFrameEvidenceRow,
  CaptureMatchCandidate,
  ResolverDecision,
} from "./capture-evidence";
import { surfaceReadsShadeName, toRecord } from "./capture-evidence";
import { buildBrandShadeQuestion, buildCandidateQuestion } from "./capture-questions";
import type { query } from "./db";
import { buildMeasuredHexDistanceSql } from "./near-hex";

/**
 * Brand-first bottle resolver (Bottle Flow slice A, spec 5.3). The brand narrows the pool, the
 * shade name ranks it, and the lacquer color from the glass photo confirms or breaks ties but
 * never overrules a name read; color alone only ever produces a list to pick from.
 */
export const BOTTLE_RESOLVER_VERSION = "bottle-v2";

/** Resolver versions whose stored audit has the brand-first shape (`top5`, `brand`, `audit.evidence`). */
export const BRAND_FIRST_RESOLVER_VERSIONS: readonly string[] = ["bottle-v1", BOTTLE_RESOLVER_VERSION];

/** Every band and limit of the resolver lives here and nowhere else. */
export const BOTTLE_RESOLVER_THRESHOLDS = {
  /** Name score at or above which a bottle matches on its name. */
  match: 0.92,
  /** Name score at or above which the user is asked to pick (and color can confirm a match). */
  question: 0.75,
  /** Name score below which the closest shade is no plausible candidate and the create card shows. */
  createCard: 0.5,
  /**
   * Name score given to a row only a weak read names (a closed-set pick the printed name did not
   * verify, or a name read off the front): inside the ask band and below `question`, so neither
   * it nor color can ever turn it into a match.
   */
  candidateOnly: 0.6,
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
  /**
   * Without a catalog brand pool (no brand, or one not in the catalog) a name matches across all
   * brands only when the printed name has at least this many words and `brandlessMinChars`
   * letters/digits: a single word is too often other text (bottle eval 2026-11-10: "AUSTIN", the
   * maker's city on a box, matched Zoya "Austin" for a brand not in the catalog).
   */
  brandlessMinWords: 2,
  brandlessMinChars: 8,
  /**
   * Name rules inside a brand pool: a complete printed name of at least this many letters/digits
   * (normalised, `normalizeMatchText`) is ranked by edit similarity against every name and
   * non-code alias of the pool. Shorter names stay with the trigram score. Equal to exactly one
   * shade's name (`exact`) it matches on its own; otherwise it is at most a weak signal.
   */
  editMinChars: 5,
  /** Weak signal `edit_lead`: the closest name has at least this edit similarity (one wrong letter in 5+)... */
  editMinSimilarity: 0.8,
  /** ...and leads the best other shade by at least this. */
  editMinLead: 0.25,
  /** Weak signal `front_exact`: the front's read must have at least this many normalised characters. */
  frontMinChars: 5,
  /**
   * Name score a single weak signal (`edit_lead`, `front_exact`, `code`) lifts its shade to: the
   * question band, so a measured glass color within `colorHigh` confirms it (`name+color`) and
   * otherwise the user is asked with that shade first. A lead cannot tell a misread from a real
   * shade the catalog lacks (leave-one-out 2026-11-11: 63 same-brand near-twins such as Zoya
   * Polly/Lolly), a front read can be the collection or finish word, and codes are dense (a
   * misread code is a sibling's code). Two different weak signals naming the same shade lift it
   * to `match`.
   */
  weakSignal: 0.75,
  /**
   * Without a brand pool (`brandless_edit`, R3): edit similarity the printed name needs to one
   * catalog shade name (a misread letter in a long name, a trailing mark)...
   */
  brandlessEditMinSimilarity: 0.93,
  /** ...and its lead over the next distinct catalog name (any brand). */
  brandlessEditMinLead: 0.2,
  /**
   * Global candidates read without a brand pool (trigram order). The `brandless_edit` rule and
   * the shared-name veto only see these, so near-identical names of other brands must fit.
   */
  globalLimit: 10,
} as const;

/**
 * Which evidence put a candidate's name score in the match band (`nameRule` in the audit):
 * `trigram` / `listed` as in v1, `exact` / `alias` a printed name equal to one shade's name or
 * non-code alias, `two_signals` two different weak signals, `brandless_edit` the brand-less rule.
 */
export type BottleNameRule = "trigram" | "listed" | "exact" | "alias" | "two_signals" | "brandless_edit";

/** Evidence that names one shade but is not enough on its own (see `weakSignal`). */
export type BottleWeakSignal = "edit_lead" | "front_exact" | "code";

/** A name rule's lift of one shade's name score. */
export interface BottleNameLift {
  /** The rule when the lift reaches `match`; null for a single weak signal (question band). */
  rule: BottleNameRule | null;
  /** The name score the shade is lifted to (at least this). */
  to: number;
  /** The weak signals that named this shade. */
  signals: BottleWeakSignal[];
  /** Edit similarity of the printed read to the shade's best name (exact, edit_lead, brandless_edit). */
  editSimilarity?: number;
  /** Lead of that similarity over the best other shade. */
  editLead?: number;
}

/** How a match was reached (`matchBasis` in the audit). */
export type BottleMatchBasis = BottleNameRule | "signal_and_color" | "name_and_color";

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
  /** Similarity of the shade name to the name read off the front (`$8`); null without one. */
  frontScore?: number | null;
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
  /** True when the name read off the front spells this shade (`frontScore` >= `match`, or R2). */
  frontNamed?: boolean;
  /** The rule that put the name score in the match band; null when it is not there. */
  nameRule?: BottleNameRule | null;
  /** The weak signals that named this shade (`edit_lead`, `front_exact`, `code`). */
  signals?: BottleWeakSignal[];
  editSimilarity?: number | null;
  editLead?: number | null;
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
 * nameScore = max(trigram, visionConfidence) for the row whose name equals the verified pick
 * `shadeNameListed` (case-insensitive); max(trigram, `candidateOnly`) for the row equal to an
 * unverified pick `shadeNamePick` and for rows the front's name spells (`frontScore` >= `match`,
 * marked `frontNamed`); the trigram alone for the others; score = nameScore ?? colorScore ?? 0;
 * sorted nameScore DESC NULLS LAST, colorDistance ASC NULLS LAST, shade id ASC.
 */
export function scoreBottleCandidates(
  rows: readonly BottleCandidateRow[],
  input: {
    shadeNameListed: string | null;
    shadeNamePick?: string | null;
    visionConfidence: number | null;
    hintBrandId: number | null;
    /** Name-rule lifts by shade id; a lift to `match` or above sets `nameRule`. */
    lifts?: ReadonlyMap<number, BottleNameLift>;
    /** Shades named exactly by the front read (R2): marked `frontNamed` like a trigram front hit. */
    frontNamedIds?: ReadonlySet<number>;
  }
): ScoredBottleCandidate[] {
  const T = BOTTLE_RESOLVER_THRESHOLDS;
  const listed = input.shadeNameListed?.trim().toLowerCase() || null;
  const pick = input.shadeNamePick?.trim().toLowerCase() || null;
  const lift = (score: number | null, to: number) => (score === null ? to : Math.max(score, to));
  const scored = rows.map((row) => {
    const shadeId = Number(row.shadeId);
    let nameScore = finiteOrNull(row.nameScore);
    let nameRule: BottleNameRule | null = nameScore !== null && nameScore >= T.match ? "trigram" : null;
    const name = row.shadeName.trim().toLowerCase();
    const isListed = listed !== null && name === listed;
    if (isListed && input.visionConfidence !== null) {
      nameScore = lift(nameScore, input.visionConfidence);
      if (nameRule === null && nameScore >= T.match) nameRule = "listed";
    }
    if (!isListed && pick !== null && name === pick) nameScore = lift(nameScore, T.candidateOnly);
    const frontNamed = (finiteOrNull(row.frontScore) ?? 0) >= T.match || (input.frontNamedIds?.has(shadeId) ?? false);
    if (frontNamed) nameScore = lift(nameScore, T.candidateOnly);
    const ruleLift = input.lifts?.get(shadeId);
    if (ruleLift) {
      nameScore = lift(nameScore, ruleLift.to);
      if (nameRule === null && nameScore >= T.match && ruleLift.rule !== null) nameRule = ruleLift.rule;
    }
    const brandId = Number(row.brandId);
    return withColor({
      shadeId,
      brandId,
      display: `${row.brand} — ${row.shadeName}`,
      nameScore,
      colorDistance: finiteOrNull(row.colorDistance),
      fromConflictBrand: input.hintBrandId !== null && brandId !== input.hintBrandId,
      frontNamed,
      nameRule,
      signals: ruleLift?.signals ?? [],
      editSimilarity: ruleLift?.editSimilarity ?? null,
      editLead: ruleLift?.editLead ?? null,
    });
  });
  return scored.sort(compareScored);
}

export type BottleDecision =
  | { kind: "matched"; candidate: ScoredBottleCandidate; confidence: number; method: "name" | "name+color" }
  | { kind: "candidates"; candidates: ScoredBottleCandidate[]; confidence: number; tie: boolean; method: "name" | "color" }
  | { kind: "create_card"; confidence: 0 }
  | { kind: "unmatched"; confidence: number };

export interface BottleDecisionContext {
  nameRead: boolean;
  brandKnown: boolean;
  /** The printed name was read only in part (cut off or covered): it can rank, never match. */
  nameIncomplete?: boolean;
  /**
   * Set when no catalog brand pooled the candidates (the global path): the printed name, which
   * must be distinctive (`brandlessMinWords`, `brandlessMinChars`) for a match.
   */
  brandlessName?: string | null;
  /**
   * Without a brand pool: true when the top candidate's name is not unique among the global
   * candidates (another shade has the same normalised name, or a match-band score too). A
   * name-only match is then a question: a name that two brands share does not say which.
   */
  brandlessShared?: boolean;
  /**
   * Without a brand pool: true when the pipeline read brand text (any confidence, unscored
   * included) that did not resolve to a catalog brand. The bottle may come from a brand the
   * catalog lacks, so a shade of another brand matches only when the measured glass color
   * confirms it within `colorHigh`; otherwise it is a candidate (bottle eval 2026-11-11: such
   * reads are mostly not-in-catalog makers; once a collection name read as the brand).
   */
  brandlessReadConflict?: boolean;
  /**
   * The one pool shade a vendor code printed on the bottle names (R4). A match on another shade
   * contradicts it: the user is asked, with both among the candidates.
   */
  codeShadeId?: number | null;
}

/** Whether a printed name is distinctive enough to match without a brand (see `brandlessMinWords`). */
export function isDistinctiveBrandlessName(name: string | null | undefined): boolean {
  if (!name) return false;
  const words = name.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{Nd}]+/u).filter((word) => word.length > 0);
  const chars = words.join("").length;
  return words.length >= BOTTLE_RESOLVER_THRESHOLDS.brandlessMinWords && chars >= BOTTLE_RESOLVER_THRESHOLDS.brandlessMinChars;
}

/**
 * Spec 5.3 bands, then three vetoes on a match: an incomplete name never matches, neither
 * does a top candidate when the front's name spells another shade (the user is asked, with the
 * front-named shade among the candidates), and without a brand pool neither does a name-only
 * match (method `name`, no confirming color) on a printed name that is not
 * `isDistinctiveBrandlessName`.
 */
export function decideBottleResolution(
  scored: readonly ScoredBottleCandidate[],
  ctx: BottleDecisionContext
): BottleDecision {
  const decision = decideBands(scored, ctx);
  if (decision.kind !== "matched") return decision;
  const top = decision.candidate;
  const frontOther = scored.find((candidate) => candidate.frontNamed && candidate.shadeId !== top.shadeId);
  const codeOther =
    ctx.codeShadeId !== undefined && ctx.codeShadeId !== null && ctx.codeShadeId !== top.shadeId
      ? scored.find((candidate) => candidate.shadeId === ctx.codeShadeId)
      : undefined;
  // A measured glass color within `colorHigh` is independent evidence (`name+color`); a name alone is not.
  const brandlessVeto =
    ctx.brandlessName !== undefined &&
    decision.method === "name" &&
    (!isDistinctiveBrandlessName(ctx.brandlessName) || ctx.brandlessShared === true);
  const colorConfirmed = top.colorDistance !== null && top.colorDistance <= BOTTLE_RESOLVER_THRESHOLDS.colorHigh;
  const readConflictVeto = ctx.brandlessName !== undefined && ctx.brandlessReadConflict === true && !colorConfirmed;
  if (!ctx.nameIncomplete && !brandlessVeto && !readConflictVeto && (!frontOther || top.frontNamed) && !codeOther) {
    return decision;
  }
  const T = BOTTLE_RESOLVER_THRESHOLDS;
  const first = scored.slice(0, T.maxCandidates);
  const extras = [codeOther, frontOther].filter(
    (other, i, all): other is ScoredBottleCandidate => other !== undefined && !first.includes(other) && all.indexOf(other) === i
  );
  const cut = [...first.slice(0, T.maxCandidates - extras.length), ...extras];
  return { kind: "candidates", candidates: cut, confidence: top.nameScore ?? decision.confidence, tie: false, method: "name" };
}

/**
 * Spec 5.3 bands for the best-ranked candidate (`D` is its OKLAB distance to the glass color,
 * null without a glass hex). `scored` must be sorted as `scoreBottleCandidates` sorts.
 */
function decideBands(scored: readonly ScoredBottleCandidate[], ctx: BottleDecisionContext): BottleDecision {
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

const MEASURED_DISTANCE_SQL = buildMeasuredHexDistanceSql(["#000000"], 4).sql;
/** Color distance for color shades only: a topper's or coat's stored hex says nothing about the glass. */
const CANDIDATE_COLOR_DISTANCE_SQL = `CASE WHEN s.product_category <> 'color' THEN NULL ${MEASURED_DISTANCE_SQL.replace(/^CASE /, "")}`;

/**
 * $1 brand_id[] (bigint[]), $2 user_id, $3 printed shade name text or null, $4–$6 glass OKLAB
 * L/a/b or null, $7 the closed-set pick (`shadeNameListed`, else the unverified `shadeNamePick`)
 * or null (its row sorts first, so a pick is never cut by the pool limit), $8 the name read off
 * the front or null (`frontScore`; a row it spells, similarity >= `match`, sorts right after the
 * pick row, so the front-named shade, and with it the front/bottom contradiction veto, is never
 * cut by the pool limit either; a missing front name spells none), $9 shade ids a name rule
 * decided (R1–R4, `planPoolNameLifts`) or null: they sort first, so a shade the edit rule found
 * outside the trigram top 50 is still scored with its color distance. Shades of those brands only: live shades of every bottle
 * category (`BOTTLE_POOL_CATEGORY_SQL`: colors, toppers, coats, treatments; never accessories),
 * plus the caller's own private `user_submitted` ones (never another user's). `nameScore` is NULL
 * without a name, and `colorDistance` is NULL without a glass color, for a shade that is not a
 * color, without a stored display color, or when that display color is only the guess from the
 * shade name (`name_hex`): a guessed color is not evidence, so it can neither confirm a name nor
 * turn a name match into a question.
 */
export const BOTTLE_CANDIDATES_SQL = `SELECT s.shade_id::text AS "shadeId",
       s.brand_id::text AS "brandId",
       b.name_canonical AS brand,
       s.shade_name_canonical AS "shadeName",
       similarity(s.shade_name_canonical, $3::text) AS "nameScore",
       ${CANDIDATE_COLOR_DISTANCE_SQL} AS "colorDistance",
       similarity(s.shade_name_canonical, $8::text) AS "frontScore"
FROM shade s
JOIN brand b ON b.brand_id = s.brand_id
WHERE s.brand_id = ANY($1::bigint[])
  AND s.merged_into_shade_id IS NULL
  AND ${BOTTLE_POOL_CATEGORY_SQL}
  AND (s.status = 'active' OR (s.status = 'user_submitted' AND s.created_by_user_id = $2))
ORDER BY COALESCE(s.shade_id = ANY($9::bigint[]), false) DESC,
         COALESCE(lower(s.shade_name_canonical) = lower($7::text), false) DESC,
         COALESCE(similarity(s.shade_name_canonical, $8::text) >= ${BOTTLE_RESOLVER_THRESHOLDS.match}, false) DESC,
         "nameScore" DESC NULLS LAST, "colorDistance" ASC NULLS LAST, s.shade_id ASC
LIMIT ${BOTTLE_RESOLVER_THRESHOLDS.poolLimit}`;

/**
 * Every name, alias and collection of the pool for the name rules: $1 brand_id[], $2 user_id.
 * Same visibility as `BOTTLE_CANDIDATES_SQL` (unmerged, bottle-pool categories, `active` or the
 * caller's own `user_submitted`), so an alias never reaches another user's private shade or a
 * merged or excluded one. No pool limit: the edit rule must see every competitor.
 */
export const BOTTLE_POOL_NAMES_SQL = `SELECT s.shade_id::text AS "shadeId",
       s.shade_name_canonical AS "shadeName",
       s.collection AS collection,
       COALESCE(array_agg(a.alias ORDER BY a.alias) FILTER (WHERE a.alias IS NOT NULL), ARRAY[]::text[]) AS aliases
FROM shade s
LEFT JOIN shade_alias a ON a.shade_id = s.shade_id
WHERE s.brand_id = ANY($1::bigint[])
  AND s.merged_into_shade_id IS NULL
  AND ${BOTTLE_POOL_CATEGORY_SQL}
  AND (s.status = 'active' OR (s.status = 'user_submitted' AND s.created_by_user_id = $2))
GROUP BY s.shade_id, s.shade_name_canonical, s.collection
ORDER BY s.shade_id ASC`;

export interface BottlePoolNameRow {
  shadeId: string;
  shadeName: string;
  collection?: string | null;
  aliases?: string[] | null;
}

/**
 * Global candidates for the brand-less path: $1 printed shade name, $2 user_id, $3 a typed brand
 * text that did not resolve to a catalog brand, or null. A brand the pipeline read but could not
 * resolve is not a filter (bottle eval 2026-11-11: a read of "(logo)" or of the collection name
 * "The Foxglove King" hid exact names of the right shade). Same visibility as the pool.
 */
export const BOTTLE_GLOBAL_CANDIDATES_SQL = `SELECT s.shade_id::text AS "shadeId",
       s.brand_id::text AS "brandId",
       b.name_canonical AS brand,
       s.shade_name_canonical AS "shadeName",
       similarity(s.shade_name_canonical, $1::text) AS score
FROM shade s
JOIN brand b ON b.brand_id = s.brand_id
WHERE s.merged_into_shade_id IS NULL
  AND ${BOTTLE_POOL_CATEGORY_SQL}
  AND (s.status = 'active' OR (s.status = 'user_submitted' AND s.created_by_user_id = $2))
  AND ($3::text IS NULL OR b.name_canonical ILIKE $3::text)
  AND (s.shade_name_canonical % $1::text OR similarity(s.shade_name_canonical, $1::text) >= 0.2)
ORDER BY score DESC, s.shade_id ASC
LIMIT ${BOTTLE_RESOLVER_THRESHOLDS.globalLimit}`;

/** A global candidate with the shade name the brand-less edit rule compares. */
export type BottleGlobalCandidate = CaptureMatchCandidate & { shadeName?: string };

/** The brand-less candidates (`BOTTLE_GLOBAL_CANDIDATES_SQL`); none without a printed name. */
export async function loadBottleGlobalCandidates(
  evidence: CaptureEvidence,
  userId: number,
  db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> }
): Promise<BottleGlobalCandidate[]> {
  if (!evidence.shadeName) return [];
  const result = await db.query(BOTTLE_GLOBAL_CANDIDATES_SQL, [evidence.shadeName, userId, evidence.brand ?? null]);
  return result.rows.map((row) => {
    const shadeId = Number(row.shadeId);
    const shadeName = String(row.shadeName ?? "");
    return {
      entityType: "shade" as const,
      entityId: shadeId,
      shadeId,
      display: `${String(row.brand ?? "")} — ${shadeName}`,
      confidence: Math.max(0, Math.min(1, finiteOrNull(row.score) ?? 0)),
      shadeName,
    };
  });
}

/** The pool's match list (`MatchListEntry`) from `BOTTLE_POOL_NAMES_SQL` rows. */
export function toMatchListEntries(rows: readonly BottlePoolNameRow[]): MatchListEntry[] {
  return rows
    .map((row) => ({
      shadeId: Number(row.shadeId),
      name: String(row.shadeName ?? ""),
      aliases: Array.isArray(row.aliases) ? row.aliases.filter((alias): alias is string => typeof alias === "string") : [],
    }))
    .filter((entry) => Number.isSafeInteger(entry.shadeId) && entry.name.length > 0);
}

/** Tokens of the read text a vendor code could be: each text whole and split on spaces and punctuation. */
export function vendorCodeTokens(texts: readonly (string | null | undefined)[]): string[] {
  const tokens = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const token of [text, ...text.split(/[\s,;:/|()[\]]+/)]) {
      const trimmed = token.trim();
      if (trimmed && isVendorCodeAlias(trimmed)) tokens.add(trimmed);
    }
  }
  return [...tokens];
}

/** Normalised words a front read can show that are not a shade name: the pool's collections and the finish catalog. */
export function frontNonNameWords(
  rows: readonly BottlePoolNameRow[],
  finishWords: Iterable<string> = []
): Set<string> {
  const words = new Set<string>();
  const add = (text: string | null | undefined) => {
    const key = text ? normalizeMatchText(text) : "";
    if (key.length > 0) words.add(key);
  };
  for (const row of rows) add(row.collection);
  for (const word of finishWords) add(word);
  return words;
}

export interface PoolNamePlan {
  lifts: Map<number, BottleNameLift>;
  /** Shades the front read names exactly and validly (R2), marked `frontNamed` (the front/bottom veto). */
  frontNamedIds: Set<number>;
  /** The one shade a printed vendor code names; null for none or several. */
  codeShadeId: number | null;
  audit: {
    printed: (NameDecision & { shadeIds: number[] }) | null;
    front: { shadeId: number; name: string; contradictedBy: number | null; blocked: "collection_or_finish" | null } | null;
    codes: { tokens: string[]; shadeIds: number[] };
    signals: { shadeId: number; signals: BottleWeakSignal[] }[];
  };
}

/**
 * The name rules over the whole pool (pure; every lift is a proposal that `resolveBottle` may
 * drop when another shade's own name evidence contradicts it, and the bands, the color check
 * and the vetoes still decide).
 *
 * - `exact` / `alias`: the complete printed (bottom/box) name, 5+ characters, equal after
 *   normalisation to a name or non-code alias owned by exactly one pool shade: `match`.
 * - Weak signals (each names one shade): `edit_lead` (the printed name's closest name by edit
 *   similarity and lead), `front_exact` (the front's read equal to one shade's name, not a
 *   collection or finish word, unless the bottom's best name is another shade), `code` (a
 *   printed vendor code naming exactly one pool shade). One lifts to `weakSignal` (the question
 *   band); two different ones naming the same shade lift it to `match` (`two_signals`).
 *
 * A read phrase that is generic label text is not ranked (`rankNames`), and a name two shades
 * carry decides nothing (`decideName`).
 */
export function planPoolNameLifts(
  evidence: CaptureEvidence,
  entries: readonly MatchListEntry[],
  nonNameFrontWords: ReadonlySet<string> = new Set()
): PoolNamePlan {
  const T = BOTTLE_RESOLVER_THRESHOLDS;
  const signals = new Map<number, Set<BottleWeakSignal>>();
  const addSignal = (shadeId: number, signal: BottleWeakSignal) => {
    const set = signals.get(shadeId);
    if (set) set.add(signal);
    else signals.set(shadeId, new Set([signal]));
  };
  const frontNamedIds = new Set<number>();
  const audit: PoolNamePlan["audit"] = { printed: null, front: null, codes: { tokens: [], shadeIds: [] }, signals: [] };
  const isOwnName = (shadeId: number, name: string) => {
    const entry = entries.find((candidate) => candidate.shadeId === shadeId);
    return entry !== undefined && normalizeMatchText(entry.name) === normalizeMatchText(name);
  };

  // The printed (bottom/box) name, complete and 5+ characters: exact on its own, else a lead signal.
  const printed = evidence.shadeName?.trim() || null;
  let exact: { shadeId: number; rule: "exact" | "alias"; similarity: number; lead: number } | null = null;
  let leadDecision: NameDecision | null = null;
  const printedRanked = printed ? rankNames([printed], entries) : [];
  if (printed && !evidence.shadeNameIncomplete && normalizeMatchText(printed).length >= T.editMinChars) {
    const decision = decideName(printedRanked, { minSimilarity: T.editMinSimilarity, minLead: T.editMinLead });
    if (decision) {
      const top = printedRanked.find((row) => row.shadeId === decision.shadeId && row.name === decision.name);
      audit.printed = { ...decision, shadeIds: top?.shadeIds ?? [decision.shadeId] };
      if (decision.rule === "exact") {
        exact = {
          shadeId: decision.shadeId,
          rule: isOwnName(decision.shadeId, decision.name) ? "exact" : "alias",
          similarity: decision.similarity,
          lead: decision.lead,
        };
      } else {
        leadDecision = decision;
        addSignal(decision.shadeId, "edit_lead");
      }
    }
  }

  // The front's name equal (normalised) to exactly one shade's name.
  const front = evidence.frontShadeName?.trim() || null;
  const frontKey = front ? normalizeMatchText(front) : "";
  if (front && frontKey.length >= T.frontMinChars) {
    const decision = decideName(rankNames([front], entries), { minSimilarity: 1, minLead: 1 });
    if (decision && decision.rule === "exact") {
      const blocked = nonNameFrontWords.has(frontKey) ? ("collection_or_finish" as const) : null;
      let contradictedBy: number | null = null;
      const bottomTop = printedRanked[0];
      if (bottomTop && bottomTop.similarity >= T.editMinSimilarity && !bottomTop.shadeIds.includes(decision.shadeId)) {
        contradictedBy = bottomTop.shadeId;
      }
      audit.front = { shadeId: decision.shadeId, name: decision.name, contradictedBy, blocked };
      // A collection or finish word on the front is no shade name: no lift and no contradiction (v1's trigram still applies).
      if (blocked === null) {
        frontNamedIds.add(decision.shadeId);
        if (contradictedBy === null) addSignal(decision.shadeId, "front_exact");
      }
    }
  }

  // A printed vendor code that names one pool shade (any length: a misread code is a sibling's code).
  const tokens = vendorCodeTokens([evidence.shadeName, evidence.frontShadeName]);
  const codeIds = tokens.length > 0 ? findVendorCodeShades(tokens, buildVendorCodeIndex(entries)) : [];
  audit.codes = { tokens, shadeIds: codeIds };
  const codeShadeId = codeIds.length === 1 ? codeIds[0] : null;
  if (codeShadeId !== null) addSignal(codeShadeId, "code");

  const lifts = new Map<number, BottleNameLift>();
  if (codeIds.length > 1) {
    for (const id of codeIds) lifts.set(id, { rule: null, to: T.candidateOnly, signals: [] });
  }
  for (const [shadeId, kinds] of signals) {
    const list = [...kinds].sort();
    const edit = leadDecision && leadDecision.shadeId === shadeId ? leadDecision : null;
    lifts.set(shadeId, {
      rule: list.length >= 2 ? "two_signals" : null,
      to: list.length >= 2 ? T.match : T.weakSignal,
      signals: list,
      ...(edit ? { editSimilarity: edit.similarity, editLead: edit.lead } : {}),
    });
  }
  if (exact) {
    const existing = lifts.get(exact.shadeId);
    lifts.set(exact.shadeId, {
      rule: exact.rule,
      to: T.match,
      signals: existing?.signals ?? [],
      editSimilarity: exact.similarity,
      editLead: exact.lead,
    });
  }
  audit.signals = [...signals].map(([shadeId, kinds]) => ({ shadeId, signals: [...kinds].sort() }));
  return { lifts, frontNamedIds, codeShadeId, audit };
}

/**
 * Drops a lift into the question band or above when another shade already has name evidence of
 * its own in the question band (`question`) or above: the name rules decide only when exactly
 * one shade is close, so they never outvote a trigram or verified-pick name of another shade.
 */
export function dropContradictedLifts(
  base: readonly ScoredBottleCandidate[],
  lifts: ReadonlyMap<number, BottleNameLift>
): Map<number, BottleNameLift> {
  const T = BOTTLE_RESOLVER_THRESHOLDS;
  const kept = new Map<number, BottleNameLift>();
  for (const [shadeId, lift] of lifts) {
    const contradicted =
      lift.to >= T.question &&
      base.some((candidate) => candidate.shadeId !== shadeId && (candidate.nameScore ?? 0) >= T.question);
    if (!contradicted) kept.set(shadeId, lift);
  }
  return kept;
}

/**
 * R3: without a brand pool, a complete, distinctive printed name (`isDistinctiveBrandlessName`)
 * whose edit similarity to exactly one distinct catalog name among the global candidates is at
 * least `brandlessEditMinSimilarity`, leading the next name by `brandlessEditMinLead`. A name two
 * shades carry (two brands) is no decision.
 */
export function planBrandlessLift(
  evidence: CaptureEvidence,
  candidates: readonly { shadeId: number; shadeName: string }[]
): { shadeId: number; lift: BottleNameLift } | null {
  const T = BOTTLE_RESOLVER_THRESHOLDS;
  const printed = evidence.shadeName?.trim() || null;
  if (!printed || evidence.shadeNameIncomplete || !isDistinctiveBrandlessName(printed)) return null;
  const entries = candidates.map((candidate) => ({ shadeId: candidate.shadeId, name: candidate.shadeName }));
  const ranked = rankNames([printed], entries);
  const top = ranked[0];
  if (!top || top.similarity < T.brandlessEditMinSimilarity) return null;
  if (top.shadeIds.length !== 1) return null;
  const lead = top.similarity - (ranked[1]?.similarity ?? 0);
  if (lead < T.brandlessEditMinLead) return null;
  return {
    shadeId: top.shadeId,
    lift: { rule: "brandless_edit", to: T.match, signals: [], editSimilarity: top.similarity, editLead: lead },
  };
}

/** Shade name of a global candidate (`Brand — Name` display when the loader gave none). */
function globalShadeName(candidate: BottleGlobalCandidate): string {
  if (candidate.shadeName) return candidate.shadeName;
  const parts = candidate.display.split(" — ");
  return parts.length > 1 ? parts.slice(1).join(" — ") : candidate.display;
}

const HEX_PATTERN = /^#?[0-9a-f]{6}$/i;

/** OKLAB distance from the glass hex to each shade's measured display color (null = none, or only a name guess). */
export async function loadColorDistances(
  shadeIds: number[],
  glassHex: string,
  userId: number,
  db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<{ shadeId: string; distance: unknown }> }> }
): Promise<Map<number, number | null>> {
  const distances = new Map<number, number | null>();
  if (shadeIds.length === 0 || !HEX_PATTERN.test(glassHex)) return distances;

  const distance = buildMeasuredHexDistanceSql([glassHex], 2);
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
  /**
   * Brand-less candidates (`loadBottleGlobalCandidates`). Called with the evidence's brand only
   * when it was typed (a hint or answer); a brand read off the bottle that did not resolve is dropped.
   */
  globalCandidates: (evidence: CaptureEvidence) => Promise<BottleGlobalCandidate[]>;
  colorDistances: (shadeIds: number[], glassHex: string) => Promise<Map<number, number | null>>;
  /**
   * Finish names and aliases (the cached finish catalog, `loadFinishCatalog`): a front read that
   * equals one is not a shade name. Optional; without it only the pool's collections are checked.
   */
  finishWords?: () => Promise<Iterable<string>>;
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

/** How a match was reached, for the audit. */
function matchBasis(decision: Extract<BottleDecision, { kind: "matched" }>): BottleMatchBasis {
  const top = decision.candidate;
  if (decision.method === "name+color") return (top.signals?.length ?? 0) > 0 ? "signal_and_color" : "name_and_color";
  return top.nameRule ?? "trigram";
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
    frontNamed: candidate.frontNamed ?? false,
    nameRule: candidate.nameRule ?? null,
    signals: candidate.signals ?? [],
    editSimilarity: candidate.editSimilarity ?? null,
    editLead: candidate.editLead ?? null,
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

  const T = BOTTLE_RESOLVER_THRESHOLDS;
  let scored: ScoredBottleCandidate[];
  let nameRead: boolean;
  let codeShadeId: number | null = null;
  let brandlessShared: boolean | undefined;
  let nameRules: Record<string, unknown> = {};
  if (plan.poolIds.length > 0) {
    const names = await deps.query<BottlePoolNameRow>(BOTTLE_POOL_NAMES_SQL, [plan.poolIds, ctx.userId]);
    let finishWords: Iterable<string> = [];
    if (evidence.frontShadeName && deps.finishWords) {
      try {
        finishWords = await deps.finishWords();
      } catch {
        finishWords = [];
      }
    }
    const namePlan = planPoolNameLifts(evidence, toMatchListEntries(names.rows), frontNonNameWords(names.rows, finishWords));
    codeShadeId = namePlan.codeShadeId;
    const forcedIds = [
      ...new Set([...namePlan.lifts.keys(), ...namePlan.frontNamedIds, ...(codeShadeId !== null ? [codeShadeId] : [])]),
    ];
    const oklab = glassHex ? hexToOklab(glassHex) : null;
    const result = await deps.query<BottleCandidateRow>(BOTTLE_CANDIDATES_SQL, [
      plan.poolIds,
      ctx.userId,
      evidence.shadeName ?? null,
      oklab ? oklab.L : null,
      oklab ? oklab.a : null,
      oklab ? oklab.b : null,
      evidence.shadeNameListed ?? evidence.shadeNamePick ?? null,
      evidence.frontShadeName ?? null,
      forcedIds.length > 0 ? forcedIds : null,
    ]);
    const scoreInput = {
      shadeNameListed: evidence.shadeNameListed ?? null,
      shadeNamePick: evidence.shadeNamePick ?? null,
      visionConfidence: ctx.visionConfidence ?? null,
      hintBrandId: numericBrandId(ctx.hintBrand),
      frontNamedIds: namePlan.frontNamedIds,
    };
    const lifts = dropContradictedLifts(scoreBottleCandidates(result.rows, scoreInput), namePlan.lifts);
    scored = scoreBottleCandidates(result.rows, { ...scoreInput, lifts });
    nameRead = Boolean(evidence.shadeName || evidence.shadeNameListed || evidence.shadeNamePick)
      || scored.some((candidate) => candidate.frontNamed);
    nameRules = {
      ...namePlan.audit,
      lifted: [...lifts].map(([shadeId, lift]) => ({ shadeId, ...lift })),
      dropped: [...namePlan.lifts.keys()].filter((shadeId) => !lifts.has(shadeId)),
    };
  } else {
    // Only a typed brand (hint, answer) filters the global candidates; an unresolved read is no evidence.
    const typedBrand = plan.brand?.source === "hint";
    const global = (await deps.globalCandidates(typedBrand ? evidence : { ...evidence, brand: undefined })).filter(
      (candidate): candidate is BottleGlobalCandidate & { shadeId: number } => candidate.shadeId !== null
    );
    const distances = glassHex && global.length > 0
      ? await deps.colorDistances(global.map((candidate) => candidate.shadeId), glassHex)
      : new Map<number, number | null>();
    const brandless = planBrandlessLift(
      evidence,
      global.map((candidate) => ({ shadeId: candidate.shadeId, shadeName: globalShadeName(candidate) }))
    );
    scored = global
      .map((candidate) => {
        const trigram = candidate.confidence;
        const lift = brandless && brandless.shadeId === candidate.shadeId ? brandless.lift : null;
        const nameScore = lift ? Math.max(trigram, lift.to) : trigram;
        const nameRule: BottleNameRule | null =
          trigram >= T.match ? "trigram" : lift && nameScore >= T.match ? lift.rule : null;
        return withColor({
          shadeId: candidate.shadeId,
          brandId: 0,
          display: candidate.display,
          nameScore,
          colorDistance: distances.get(candidate.shadeId) ?? null,
          fromConflictBrand: false,
          nameRule,
          editSimilarity: lift?.editSimilarity ?? null,
          editLead: lift?.editLead ?? null,
        });
      })
      .sort(compareScored);
    nameRead = Boolean(evidence.shadeName);
    const top = scored[0];
    if (top) {
      const nameOf = (shadeId: number) => {
        const candidate = global.find((row) => row.shadeId === shadeId);
        return candidate ? normalizeMatchText(globalShadeName(candidate)) : "";
      };
      const topKey = nameOf(top.shadeId);
      brandlessShared = scored.some(
        (candidate) =>
          candidate.shadeId !== top.shadeId &&
          ((topKey !== "" && nameOf(candidate.shadeId) === topKey) || (candidate.nameScore ?? 0) >= T.match)
      );
    }
    nameRules = {
      brandless: brandless ? { shadeId: brandless.shadeId, ...brandless.lift } : null,
      brandlessShared: brandlessShared ?? false,
    };
  }

  const decision = decideBottleResolution(scored, {
    nameRead,
    brandKnown,
    nameIncomplete: Boolean(evidence.shadeNameIncomplete && !evidence.shadeNameListed),
    ...(plan.poolIds.length === 0
      ? {
          brandlessName: evidence.shadeName ?? null,
          brandlessShared,
          brandlessReadConflict:
            plan.brand === null && evidence.brandRead?.source === "pipeline" && evidence.brandRead.text.trim().length > 0,
        }
      : {}),
    codeShadeId,
  });
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
      shadeNamePick: evidence.shadeNamePick ?? null,
      shadeNameIncomplete: evidence.shadeNameIncomplete ?? false,
      frontShadeName: evidence.frontShadeName ?? null,
      finish: evidence.finish ?? null,
      glassHex: evidence.glassHex ?? null,
      glassHexConfidence: evidence.glassHexConfidence ?? null,
      surfaces: evidence.surfaces,
    },
    thresholds: BOTTLE_RESOLVER_THRESHOLDS,
    nameRules,
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
            nameRule: decision.candidate.nameRule ?? null,
            matchBasis: matchBasis(decision),
            signals: decision.candidate.signals ?? [],
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
