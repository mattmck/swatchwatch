/**
 * Built-in seeded default finishes (typing + offline fallback).
 *
 * At runtime the admin-managed `finish_type` table is the source of truth for which
 * finishes are valid (see `packages/functions/src/lib/finishes.ts`); finish types
 * added through the admin UI are valid even though they are not listed here. This list
 * is used to type the known built-ins (`PolishFinish`) and as the fallback when the
 * database or reference API is unavailable.
 *
 * Kept equal to the `finish_type` rows seeded by migrations
 * `005_seed_production_reference_data.sql` / `018_add_finish_normalizations.sql`
 * (ordered by `sort_order`). `packages/functions/tests/finishes.unit.test.cjs`
 * fails if the two drift apart.
 *
 * Alias spellings (e.g. "holo", "cream", "flakie") are NOT listed here: they
 * are resolved through the DB-backed `finish_normalization` table (with a
 * built-in fallback map in `packages/functions/src/lib/finishes.ts`).
 */
export const CANONICAL_FINISHES = [
  "creme",
  "sheer",
  "jelly",
  "shimmer",
  "metallic",
  "glitter",
  "holographic",
  "duochrome",
  "multichrome",
  "flake",
  "matte",
  "topper",
  "magnetic",
  "thermal",
  "crelly",
  "glow",
  "other",
] as const;

type CanonicalFinish = (typeof CANONICAL_FINISHES)[number];

const CANONICAL_FINISH_SET: ReadonlySet<string> = new Set(CANONICAL_FINISHES);

/**
 * True when `value` is exactly one of the BUILT-IN finish names (case-sensitive). This does
 * not know about finish types added at runtime; use the reference data / DB catalog for those.
 */
export function isCanonicalFinish(value: unknown): value is CanonicalFinish {
  return typeof value === "string" && CANONICAL_FINISH_SET.has(value);
}

/**
 * Finish families for dupe grading (#320, decision D10). Finishes in the same family read alike on
 * the nail (creme vs jelly); finishes in different families do not (holo vs creme), which drops a
 * dupe's grade one step (`finishCompatibility` in `color/dupes.ts`).
 *
 * Each `finish_type` row carries an optional `family` (admin-editable); the DB CHECK constraint
 * (migration `20261018175839000_finish-type-family.sql`) allows exactly these values, and
 * `packages/functions/tests/finish-family.unit.test.cjs` keeps the two equal. A finish with no
 * family is never penalized.
 */
export const FINISH_FAMILIES = ["solid", "shimmer", "holo", "glitter", "matte", "thermal", "glow"] as const;

export type FinishFamily = (typeof FINISH_FAMILIES)[number];

const FINISH_FAMILY_SET: ReadonlySet<string> = new Set(FINISH_FAMILIES);

/** True when `value` is exactly one of `FINISH_FAMILIES` (case-sensitive). */
export function isFinishFamily(value: unknown): value is FinishFamily {
  return typeof value === "string" && FINISH_FAMILY_SET.has(value);
}
