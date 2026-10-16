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
