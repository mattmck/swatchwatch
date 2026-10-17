import type { MatchConfidence } from "../types/color-match";
import type {
  DupeGrade,
  FinishCompatibility,
  PolishDupe,
  PolishDupeHint,
} from "../types/dupes";
import { resolvePolishFinishes } from "../types/polish";
import { normalizeHexColor, resolveDisplayHexDetailed, type DisplayHexSource } from "./hex-reconciliation";
import { hexToOklab, oklabDistance, type OKLab } from "./oklab";
import { confidenceForDistance } from "./thresholds";

/**
 * Dupe finder (issue #265) — pure, dependency-free, shared by the API
 * (`GET /api/polishes/{id}/dupes`, `POST /api/polishes/dupes`) and the web app.
 *
 * ## The rule
 *
 * 1. Each shade's color is its display hex (`resolveDisplayHexDetailed`: vendor > detected >
 *    name). Shades without a usable 6-digit hex are skipped.
 * 2. `distance` = OKLAB Euclidean distance between the target and the owned shade.
 *    `colorGrade` = `confidenceForDistance(distance)`: HIGH ≤ 0.05, MEDIUM ≤ 0.10, else LOW —
 *    the same thresholds as photo matching (`POST /api/polishes/match-image`).
 * 3. Finish compatibility (`finishCompatibility`) compares the primary finishes and their
 *    families (`DUPE_FINISH_FAMILIES`):
 *    - `same` (same primary finish) and `compatible` (same family, or any shared finish) keep
 *      the color grade;
 *    - `unknown` (either side lacks finish data) keeps the color grade — missing data should
 *      not hide a likely dupe;
 *    - `different` (known finishes in different families, e.g. holo vs creme) drops the grade
 *      one step: HIGH → MEDIUM, MEDIUM → LOW.
 * 4. Only final grades HIGH and MEDIUM are dupes. They are ordered by grade, then finish
 *    compatibility (same < compatible < unknown < different), then distance, then brand/name,
 *    so a same-finish dupe ranks above an equally graded one with a different finish.
 *
 * ## Complexity
 *
 * `prepareDupeCandidates` converts every owned shade's hex to OKLAB once (O(N)); each target
 * is then a linear scan (O(N)), so a batch of K targets is O(K·N) with no extra queries.
 * Collections are at most a few thousand shades, so a capped batch (K ≤ 100) is well under
 * a million distance evaluations.
 */

/** Limits for the dupe endpoints. */
export const DUPE_LIMITS = {
  /** Default number of dupes returned by `GET /api/polishes/{id}/dupes`. */
  defaultLimit: 5,
  /** Max `limit` accepted by `GET /api/polishes/{id}/dupes`. */
  maxLimit: 20,
  /** Max shade ids per `POST /api/polishes/dupes` request. */
  batchMaxShadeIds: 100,
} as const;

/**
 * Finish families used for compatibility. Finishes in the same family read alike on the nail;
 * finishes in different families do not. Keys are built-in canonical finish names
 * (`CANONICAL_FINISHES`). `other` and admin-created finishes outside this map have no family,
 * so they can only ever be `same` (identical name), `compatible` (shared finish) or `unknown`.
 */
export const DUPE_FINISH_FAMILIES: Readonly<Record<string, string>> = {
  // Opaque or translucent solid color.
  creme: "solid",
  crelly: "solid",
  jelly: "solid",
  sheer: "solid",
  // Fine reflective particles / foil, including color-shifting shimmers.
  shimmer: "shimmer",
  metallic: "shimmer",
  magnetic: "shimmer",
  duochrome: "shimmer",
  multichrome: "shimmer",
  // Linear/scattered rainbow effect.
  holographic: "holo",
  // Visible particles.
  glitter: "glitter",
  flake: "glitter",
  topper: "glitter",
  // Flat texture.
  matte: "matte",
  // Special effects.
  thermal: "thermal",
  glow: "glow",
};

/** Small alias map so legacy spellings in older rows still find their family. */
const FINISH_ALIASES: Readonly<Record<string, string>> = {
  cream: "creme",
  holo: "holographic",
  flakie: "flake",
  flakies: "flake",
};

const FINISH_COMPATIBILITY_RANK: Record<FinishCompatibility, number> = {
  same: 0,
  compatible: 1,
  unknown: 2,
  different: 3,
};

const GRADE_RANK: Record<MatchConfidence, number> = { high: 0, medium: 1, low: 2 };

function normalizeFinishList(finishes: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of finishes) {
    const lower = raw.trim().toLowerCase();
    if (!lower) continue;
    const finish = FINISH_ALIASES[lower] ?? lower;
    // `other` carries no information about how the shade looks.
    if (finish === "other" || out.includes(finish)) continue;
    out.push(finish);
  }
  return out;
}

/** Family of a finish name, or undefined for `other` / admin-defined finishes. */
export function finishFamily(finish: string): string | undefined {
  const lower = finish.trim().toLowerCase();
  return DUPE_FINISH_FAMILIES[FINISH_ALIASES[lower] ?? lower];
}

/**
 * Compare two finish lists (primary first). See `FinishCompatibility` for the buckets.
 */
export function finishCompatibility(
  targetFinishes: readonly string[],
  candidateFinishes: readonly string[]
): FinishCompatibility {
  const a = normalizeFinishList(targetFinishes);
  const b = normalizeFinishList(candidateFinishes);
  if (a.length === 0 || b.length === 0) return "unknown";
  if (a[0] === b[0]) return "same";

  const familyA = DUPE_FINISH_FAMILIES[a[0]];
  const familyB = DUPE_FINISH_FAMILIES[b[0]];
  if (familyA && familyA === familyB) return "compatible";
  if (a.some((finish) => b.includes(finish))) return "compatible";
  if (familyA && familyB) return "different";
  return "unknown";
}

/** One grade step down: HIGH → MEDIUM → LOW. */
function downgrade(grade: MatchConfidence): MatchConfidence {
  return grade === "high" ? "medium" : "low";
}

/**
 * Grade a pair from its OKLAB distance and finish compatibility. `grade` is null when the
 * pair is not a dupe (final grade LOW).
 */
export function gradeDupe(
  distance: number,
  compatibility: FinishCompatibility
): { colorGrade: MatchConfidence; grade: DupeGrade | null } {
  const colorGrade = confidenceForDistance(distance);
  const finalGrade = compatibility === "different" ? downgrade(colorGrade) : colorGrade;
  return { colorGrade, grade: finalGrade === "low" ? null : finalGrade };
}

/** Sort comparator for dupes: grade, finish compatibility, distance, brand, name. */
export function compareDupes(a: PolishDupe, b: PolishDupe): number {
  return (
    GRADE_RANK[a.grade] - GRADE_RANK[b.grade] ||
    FINISH_COMPATIBILITY_RANK[a.finishCompatibility] - FINISH_COMPATIBILITY_RANK[b.finishCompatibility] ||
    a.distance - b.distance ||
    a.brand.localeCompare(b.brand) ||
    a.name.localeCompare(b.name) ||
    a.shadeId.localeCompare(b.shadeId)
  );
}

/**
 * The fields the dupe finder needs from a shade. A `Polish` row satisfies it, and so does a raw
 * database row (whose missing hexes are `null`).
 */
export interface DupeShade {
  shadeId: string | number;
  brand?: string | null;
  name?: string | null;
  vendorHex?: string | null;
  detectedHex?: string | null;
  nameHex?: string | null;
  hexAgreement?: number | null;
  finish?: string | null;
  finishes?: readonly string[] | null;
}

/** A shade with its display hex resolved and converted to OKLAB once. */
export interface PreparedDupeShade {
  shadeId: string;
  brand: string;
  name: string;
  finishes: string[];
  displayHex: string;
  displayHexSource: DisplayHexSource;
  lab: OKLab;
}

/** Resolve a shade's display hex/source and finishes; null when it has no usable hex. */
export function prepareDupeShade(shade: DupeShade): PreparedDupeShade | null {
  const resolution = resolveDisplayHexDetailed({
    vendorHex: shade.vendorHex ?? undefined,
    detectedHex: shade.detectedHex ?? undefined,
    nameHex: shade.nameHex ?? undefined,
    hexAgreement: shade.hexAgreement,
  });
  const displayHex = normalizeHexColor(resolution.hex);
  if (!displayHex) return null;
  return {
    shadeId: String(shade.shadeId),
    brand: shade.brand ?? "",
    name: shade.name ?? "",
    finishes: resolvePolishFinishes(shade),
    displayHex,
    displayHexSource: resolution.source,
    lab: hexToOklab(displayHex),
  };
}

/** Prepare a candidate pool once (O(N)); shades without a usable hex are dropped. */
export function prepareDupeCandidates(shades: readonly DupeShade[]): PreparedDupeShade[] {
  const out: PreparedDupeShade[] = [];
  for (const shade of shades) {
    const prepared = prepareDupeShade(shade);
    if (prepared) out.push(prepared);
  }
  return out;
}

export interface FindDupesResult {
  /** All HIGH/MEDIUM dupes, best first (not limited). */
  dupes: PolishDupe[];
  /** Candidates compared (the pool minus the target itself). */
  candidateCount: number;
}

/**
 * All dupes of `target` among `candidates`, best first. The target's own shade id is always
 * excluded. O(N) per target. Pure — callers are responsible for passing only owned shades.
 */
export function findDupes(
  target: PreparedDupeShade,
  candidates: readonly PreparedDupeShade[]
): FindDupesResult {
  const dupes: PolishDupe[] = [];
  let candidateCount = 0;
  for (const candidate of candidates) {
    if (candidate.shadeId === target.shadeId) continue;
    candidateCount += 1;
    const distance = oklabDistance(target.lab, candidate.lab);
    const compatibility = finishCompatibility(target.finishes, candidate.finishes);
    const { colorGrade, grade } = gradeDupe(distance, compatibility);
    if (!grade) continue;
    dupes.push({
      shadeId: candidate.shadeId,
      brand: candidate.brand,
      name: candidate.name,
      finishes: candidate.finishes,
      displayHex: candidate.displayHex,
      displayHexSource: candidate.displayHexSource,
      distance: Math.round(distance * 10_000) / 10_000,
      colorGrade,
      grade,
      finishCompatibility: compatibility,
    });
  }
  dupes.sort(compareDupes);
  return { dupes, candidateCount };
}

/** Summarize a dupe list into a compact list-row hint. */
export function summarizeDupes(shadeId: string, dupes: readonly PolishDupe[]): PolishDupeHint {
  return {
    shadeId,
    best: dupes[0] ?? null,
    dupeCount: dupes.length,
    highCount: dupes.filter((dupe) => dupe.grade === "high").length,
  };
}
