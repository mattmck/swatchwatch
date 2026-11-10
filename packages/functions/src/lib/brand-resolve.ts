import type { CaptureBrandHintEcho, CaptureBrandRef, CaptureBrandSource } from "swatchwatch-shared";
import { query } from "./db";

/** Lowest score (trigram similarity, or word similarity for a typed hint) at which brand text counts as a catalog brand. */
export const BRAND_MATCH_MIN_SIMILARITY = 0.6;
/** Most shade names of one brand handed to the model as a closed list. */
export const BRAND_SHADE_NAMES_CAP = 400;

export interface ResolvedBrand {
  brandId: number;
  name: string;
  score: number;
}

type QueryDb = Pick<typeof import("./db"), "query">;

/**
 * Mode `"read"` (model or OCR brand text). $1 text. A brand's score is the better of its
 * canonical name's similarity and its best alias's; `%` prefilters candidates (the GIN-friendly
 * operator), then the minimum applies. Ties break on the lower brand id so the same text always
 * resolves to the same brand.
 */
export const RESOLVE_BRAND_SQL = `SELECT r."brandId", r.name, r.score
FROM (
  SELECT b.brand_id::text AS "brandId",
         b.name_canonical AS name,
         GREATEST(
           similarity(b.name_canonical, $1),
           COALESCE((SELECT MAX(similarity(ba.alias, $1)) FROM brand_alias ba WHERE ba.brand_id = b.brand_id), 0)
         ) AS score,
         b.brand_id
  FROM brand b
  WHERE b.name_canonical % $1
     OR EXISTS (SELECT 1 FROM brand_alias ba WHERE ba.brand_id = b.brand_id AND ba.alias % $1)
) r
WHERE r.score >= ${BRAND_MATCH_MIN_SIMILARITY}
ORDER BY r.score DESC, r.brand_id
LIMIT 1`;

/**
 * Mode `"hint"` (the brand the user typed for a batch). $1 text. Typed hints are short ("Loud"
 * for Loud Lacquer: trigram similarity 5/12 ≈ 0.42), so the score is word similarity (the hint
 * against the best-matching part of the name or an alias), or 1 when the name starts with the
 * hint (`starts_with`, so `%` or `_` in the text are no wildcards). `<%` prefilters. Ties break
 * on the shorter name, then the lower brand id, so the same text always resolves the same way.
 */
export const RESOLVE_BRAND_HINT_SQL = `SELECT r."brandId", r.name, r.score
FROM (
  SELECT b.brand_id::text AS "brandId",
         b.name_canonical AS name,
         GREATEST(
           word_similarity($1::text, b.name_canonical),
           COALESCE((SELECT MAX(word_similarity($1::text, ba.alias)) FROM brand_alias ba WHERE ba.brand_id = b.brand_id), 0),
           CASE WHEN starts_with(lower(b.name_canonical), lower($1::text)) THEN 1 ELSE 0 END
         ) AS score,
         b.brand_id
  FROM brand b
  WHERE $1::text <% b.name_canonical
     OR EXISTS (SELECT 1 FROM brand_alias ba WHERE ba.brand_id = b.brand_id AND $1::text <% ba.alias)
     OR starts_with(lower(b.name_canonical), lower($1::text))
) r
WHERE r.score >= ${BRAND_MATCH_MIN_SIMILARITY}
ORDER BY r.score DESC, length(r.name) ASC, r.brand_id ASC
LIMIT 1`;

export type ResolveBrandMode = "hint" | "read";

/** Shortest read (letters and digits) the unique-prefix fallback considers. */
const BRAND_PREFIX_MIN_CHARS = 3;

/**
 * Read-mode fallback. $1 the read, lowercased, letters and digits only. Every brand name or
 * alias that, compared the same way, starts with it (`starts_with`, so no wildcards), with the
 * text that matched; the caller accepts only a single brand. A few rows are enough to see that.
 */
export const RESOLVE_BRAND_PREFIX_SQL = `SELECT b.brand_id::text AS "brandId", b.name_canonical AS name, m.matched
FROM brand b
CROSS JOIN LATERAL (
  SELECT b.name_canonical AS matched
  UNION ALL
  SELECT ba.alias FROM brand_alias ba WHERE ba.brand_id = b.brand_id
) m
WHERE starts_with(regexp_replace(lower(m.matched), '[^a-z0-9]', '', 'g'), $1::text)
ORDER BY b.brand_id
LIMIT 10`;

function compactKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * A short read off a bottle ("kbs" for KBShimmer) that trigram similarity cannot place: it
 * resolves when it is one token of at least 3 letters/digits, starts the name (or an alias) of
 * exactly one brand, and is not a whole word of it ("Holo" is a word of Holo Taco, so it could
 * be a finish word, not an abbreviation). Scored at the minimum similarity.
 */
async function resolveBrandByUniquePrefix(text: string, db: QueryDb): Promise<ResolvedBrand | null> {
  if (/\s/.test(text) || !/^[a-z0-9]+$/i.test(text)) return null;
  const key = compactKey(text);
  if (key.length < BRAND_PREFIX_MIN_CHARS) return null;

  const result = await db.query<{ brandId: string; name: string; matched?: string | null }>(RESOLVE_BRAND_PREFIX_SQL, [key]);
  const ids = new Set(result.rows.map((row) => String(row.brandId)));
  if (ids.size !== 1) return null;
  const isWholeWord = result.rows.some((row) =>
    (row.matched ?? row.name).toLowerCase().split(/[^a-z0-9]+/).includes(key)
  );
  if (isWholeWord) return null;
  const row = result.rows[0];
  const brandId = Number(row.brandId);
  return Number.isFinite(brandId) ? { brandId, name: row.name, score: BRAND_MATCH_MIN_SIMILARITY } : null;
}

/**
 * Best catalog brand for free text, or null when nothing is similar enough. `mode: "hint"` for
 * text the user typed as a batch hint (word similarity / prefix), `"read"` (default) for brand
 * text read off a bottle (plain trigram similarity, then the unique-prefix fallback).
 */
export async function resolveBrandFromText(
  text: string,
  db: QueryDb = { query },
  opts: { mode?: ResolveBrandMode } = {}
): Promise<ResolvedBrand | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const hint = opts.mode === "hint";
  const sql = hint ? RESOLVE_BRAND_HINT_SQL : RESOLVE_BRAND_SQL;
  const result = await db.query<{ brandId: string; name: string; score: number | string }>(sql, [trimmed]);
  const row = result.rows[0];
  if (row) {
    const score = Number(row.score);
    const brandId = Number(row.brandId);
    if (Number.isFinite(score) && score >= BRAND_MATCH_MIN_SIMILARITY && Number.isFinite(brandId)) {
      return { brandId, name: row.name, score };
    }
  }
  return hint ? null : resolveBrandByUniquePrefix(trimmed, db);
}

/** Most catalog brand names handed to the model as a closed list on a brand read. */
export const CATALOG_BRAND_NAMES_CAP = 300;

/**
 * Brands with at least one live shared color shade, for the closed-list brand read. Only
 * `active` shades count, so a brand that exists only through some user's private submission is
 * never named to another user. One row more than the cap is fetched so truncation is detectable.
 */
export const SELECT_CATALOG_BRAND_NAMES_SQL = `SELECT b.name_canonical AS name
FROM brand b
WHERE EXISTS (
  SELECT 1 FROM shade s
  WHERE s.brand_id = b.brand_id
    AND s.status = 'active'
    AND s.product_category = 'color'
    AND s.merged_into_shade_id IS NULL
)
ORDER BY b.name_canonical
LIMIT ${CATALOG_BRAND_NAMES_CAP + 1}`;

/** Catalog brand names for the closed-list brand read, capped; `truncated` when more exist. */
export async function listCatalogBrandNames(db: QueryDb = { query }): Promise<{ names: string[]; truncated: boolean }> {
  const result = await db.query<{ name: string }>(SELECT_CATALOG_BRAND_NAMES_SQL);
  const truncated = result.rows.length > CATALOG_BRAND_NAMES_CAP;
  return { names: result.rows.slice(0, CATALOG_BRAND_NAMES_CAP).map((row) => row.name), truncated };
}

/**
 * $1 brand_id, $2 user_id. Shared shades are the live color ones; the caller's own private
 * `user_submitted` shades are included, nobody else's. One row more than the cap is fetched
 * so truncation is detectable.
 */
export const SELECT_BRAND_SHADE_NAMES_SQL = `SELECT s.shade_name_canonical AS name
FROM shade s
WHERE s.brand_id = $1
  AND s.merged_into_shade_id IS NULL
  AND s.product_category = 'color'
  AND (s.status = 'active' OR (s.status = 'user_submitted' AND s.created_by_user_id = $2))
ORDER BY s.shade_name_canonical
LIMIT ${BRAND_SHADE_NAMES_CAP + 1}`;

/** Shade names of a brand for the closed-list prompt, capped; `truncated` when more exist. */
export async function listBrandShadeNames(
  brandId: number,
  userId: number,
  db: QueryDb = { query }
): Promise<{ names: string[]; truncated: boolean }> {
  const result = await db.query<{ name: string }>(SELECT_BRAND_SHADE_NAMES_SQL, [brandId, userId]);
  const truncated = result.rows.length > BRAND_SHADE_NAMES_CAP;
  return { names: result.rows.slice(0, BRAND_SHADE_NAMES_CAP).map((row) => row.name), truncated };
}

/** A resolved brand as a session brand; an unmatched one keeps the raw text. */
export function toBrandRef(resolved: ResolvedBrand | null, raw: string, source: CaptureBrandSource): CaptureBrandRef {
  if (!resolved) return { brandId: null, name: raw, source };
  return { brandId: String(resolved.brandId), name: resolved.name, source };
}

/** What the start response tells the client the typed brand hint was understood as. */
export function toBrandHintEcho(resolved: ResolvedBrand | null, raw: string): CaptureBrandHintEcho {
  return {
    raw,
    brandId: resolved ? String(resolved.brandId) : null,
    name: resolved ? resolved.name : raw,
  };
}
