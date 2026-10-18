import type { DisplayHexSource } from "../color/hex-reconciliation";
import type { MatchConfidence } from "./color-match";

/**
 * Dupe finder (issue #265): "you own N close dupes of this shade".
 *
 * The grading rule (OKLAB distance → HIGH/MEDIUM with the match-image thresholds, then a
 * finish-compatibility adjustment) lives in `color/dupes.ts` and is documented there.
 */

/**
 * How the finishes of two shades relate:
 * - `same`: same primary finish (creme vs creme).
 * - `compatible`: same finish family (creme vs jelly, shimmer vs metallic) or the two shades
 *   share any finish (jelly+glitter vs glitter).
 * - `different`: both finishes are known and in different families (holographic vs creme).
 *   The dupe grade is downgraded one step.
 * - `unknown`: one side has no finish data (or only `other` / a finish type with no family),
 *   so finish cannot confirm or rule out a dupe. Admin-created finish types grade
 *   `compatible`/`different` once an admin gives them a `family` (#320).
 */
export type FinishCompatibility = "same" | "compatible" | "different" | "unknown";

/** Grades that count as a dupe. `low` (> MEDIUM) matches are never returned. */
export type DupeGrade = Exclude<MatchConfidence, "low">;

/** One owned shade that is a likely dupe of the target shade. */
export interface PolishDupe {
  /** Shade id of the owned dupe (use it for `/polishes/detail?id=`). */
  shadeId: string;
  brand: string;
  name: string;
  /** Canonical finishes, primary first (legacy single `finish` when `finishes` is empty). */
  finishes: string[];
  /** Uppercase `#RRGGBB` the distance was computed from (`resolveDisplayHexDetailed`). */
  displayHex: string;
  /** Which hex column `displayHex` came from (vendor > detected > name). */
  displayHexSource: DisplayHexSource;
  /** OKLAB Euclidean distance between the two display hexes, rounded to 4 decimals. */
  distance: number;
  /** Grade from color distance alone (`confidenceForDistance`). */
  colorGrade: MatchConfidence;
  /** Final grade after the finish rule (`different` finishes drop one step). */
  grade: DupeGrade;
  finishCompatibility: FinishCompatibility;
}

/** The shade the dupes were computed for. */
export interface PolishDupesTarget {
  shadeId: string;
  /** Null when the shade has no usable hex: no dupes can be computed. */
  displayHex: string | null;
  displayHexSource: DisplayHexSource;
  finishes: string[];
}

/** Response of `GET /api/polishes/{id}/dupes`. */
export interface PolishDupesResponse {
  target: PolishDupesTarget;
  /** Best dupes first (grade, then finish compatibility, then distance), capped by `limit`. */
  dupes: PolishDupe[];
  /** All HIGH + MEDIUM dupes among the caller's owned shades (before `limit`). */
  dupeCount: number;
  /** HIGH dupes among `dupeCount`. */
  highCount: number;
  /** Owned shades with a usable display hex that were compared (excluding the target). */
  candidateCount: number;
}

/** Body of `POST /api/polishes/dupes`. */
export interface PolishDupesBatchRequest {
  /** Shade ids to check, at most `DUPE_LIMITS.batchMaxShadeIds`. Duplicates are ignored. */
  shadeIds: Array<string | number>;
}

/** Compact per-shade dupe hint for list rows. */
export interface PolishDupeHint {
  shadeId: string;
  /** The single best owned dupe, or null when nothing grades HIGH/MEDIUM. */
  best: PolishDupe | null;
  dupeCount: number;
  highCount: number;
}

/** Response of `POST /api/polishes/dupes`. */
export interface PolishDupesBatchResponse {
  /**
   * Keyed by shade id. Ids that do not exist or are not visible to the caller are omitted
   * (so existence never leaks); visible shades with no dupes have `best: null`.
   */
  results: Record<string, PolishDupeHint>;
  /** Owned shades with a usable display hex (the candidate pool). */
  candidateCount: number;
}
