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

/**
 * Best catalog brand for free text, or null when nothing is similar enough. `mode: "hint"` for
 * text the user typed as a batch hint (word similarity / prefix), `"read"` (default) for brand
 * text read off a bottle (plain trigram similarity).
 */
export async function resolveBrandFromText(
  text: string,
  db: QueryDb = { query },
  opts: { mode?: ResolveBrandMode } = {}
): Promise<ResolvedBrand | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const sql = opts.mode === "hint" ? RESOLVE_BRAND_HINT_SQL : RESOLVE_BRAND_SQL;
  const result = await db.query<{ brandId: string; name: string; score: number | string }>(sql, [trimmed]);
  const row = result.rows[0];
  if (!row) return null;

  const score = Number(row.score);
  const brandId = Number(row.brandId);
  if (!Number.isFinite(score) || score < BRAND_MATCH_MIN_SIMILARITY || !Number.isFinite(brandId)) return null;
  return { brandId, name: row.name, score };
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
