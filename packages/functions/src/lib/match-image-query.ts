import type { ColorFamily, MatchScope } from "swatchwatch-shared";

/**
 * Candidate filter for `POST /api/polishes/match-image` (#105): which shades the photo is
 * matched against. Pure SQL building so the scope rules are unit-tested without a database.
 *
 * The clauses use the aliases of the polishes queries: `s` = shade, `b` = brand and `ui` = the
 * caller's inventory row, LEFT JOINed on `ui.user_id = $1`. Every scope therefore only ever
 * sees the caller's own inventory, and `visibleSql` (the polishes list `POLISH_VISIBLE_SQL`)
 * hides other users' private submissions and merged shades in every scope.
 */
export interface MatchCandidateFilters {
  scope: MatchScope;
  /** Canonical finish names to match against `shade.finishes` (empty = no finish filter). */
  canonicalFinishes: string[];
  /** Values matched against the legacy `shade.finish` for shades with no `finishes` array. */
  legacyFinishes: string[];
  families: ColorFamily[];
}

export interface MatchCandidateWhere {
  /** SQL for the WHERE clause (no `WHERE` keyword); `$1` is the caller id. */
  where: string;
  /** Parameters for `$2…`, in order (prepend the caller id). */
  params: unknown[];
}

/** Inventory condition per scope. `catalog` has none: every visible shade is a candidate. */
export const MATCH_SCOPE_SQL: Record<MatchScope, string | null> = {
  owned: `ui.inventory_item_id IS NOT NULL AND ui.status = 'owned'`,
  wishlist: `ui.inventory_item_id IS NOT NULL AND ui.status = 'wishlist'`,
  catalog: null,
};

/** A shade with no hex at all can never be scored; skip it in SQL (the ranker re-checks validity). */
export const MATCH_HAS_HEX_SQL = `COALESCE(NULLIF(s.vendor_hex, ''), NULLIF(s.detected_hex, ''), NULLIF(s.name_hex, '')) IS NOT NULL`;

export const MATCH_COLOR_ONLY_SQL = `s.product_category = 'color'`;

export function buildMatchCandidateWhere(filters: MatchCandidateFilters, visibleSql: string): MatchCandidateWhere {
  const conditions: string[] = [visibleSql, MATCH_HAS_HEX_SQL];
  const params: unknown[] = [];
  const next = () => `$${params.length + 2}`;

  const scopeSql = MATCH_SCOPE_SQL[filters.scope];
  if (scopeSql) conditions.push(scopeSql);

  // Photo match compares colors: color polishes only (#349 D-C; toppers and coats have no
  // meaningful single hex).
  conditions.push(MATCH_COLOR_ONLY_SQL);

  if (filters.canonicalFinishes.length > 0 || filters.legacyFinishes.length > 0) {
    // Same rule as the polishes list: the multi-finish array is authoritative when populated;
    // the legacy single finish only counts for shades that have no array yet.
    const canonicalParam = next();
    params.push(filters.canonicalFinishes);
    const legacyParam = next();
    params.push(filters.legacyFinishes);
    conditions.push(
      `(COALESCE(s.finishes, ARRAY[]::text[]) && ${canonicalParam}::text[] OR (cardinality(COALESCE(s.finishes, ARRAY[]::text[])) = 0 AND LOWER(s.finish) = ANY(${legacyParam}::text[])))`
    );
  }

  if (filters.families.length > 0) {
    const familyParam = next();
    params.push(filters.families);
    conditions.push(`s.color_family = ANY(${familyParam}::text[])`);
  }

  return { where: conditions.join(" AND "), params };
}
