/**
 * Finish canonicalization + tag parsing.
 *
 * Source-of-truth split:
 * - WHICH finishes are valid: the build-time `CANONICAL_FINISHES` list in
 *   `swatchwatch-shared` (kept in sync with the seeded `finish_type` rows).
 * - HOW messy input spellings map onto them: the DB-backed `finish_normalization`
 *   table (admin-editable via `/api/reference-admin/finish-normalizations`).
 *   `DEFAULT_FINISH_ALIASES` below mirrors the seeded rows and is only used as a
 *   fallback when the DB lookup fails, or by pure callers that have no DB map.
 *
 * Every value returned by this module is a member of `CANONICAL_FINISHES`, even if
 * an alias row points at a runtime-only `finish_type` name.
 */
import { isCanonicalFinish, type PolishCreateRequest, type PolishFinish } from "swatchwatch-shared";
import { query } from "./db";

/**
 * Fallback alias map (source value → canonical finish). Mirrors the
 * `finish_normalization` rows seeded by migrations 018 and 023; the unit test
 * `finishes.unit.test.cjs` asserts they stay identical.
 */
export const DEFAULT_FINISH_ALIASES: Readonly<Record<string, PolishFinish>> = Object.freeze({
  creme: "creme",
  cream: "creme",
  creamy: "creme",
  shimmer: "shimmer",
  glitter: "glitter",
  metallic: "metallic",
  matte: "matte",
  jelly: "jelly",
  holographic: "holographic",
  holo: "holographic",
  "holo finish": "holographic",
  "crushed holo": "holographic",
  "crushed-holo": "holographic",
  crushedholo: "holographic",
  "linear holo": "holographic",
  "linear-holo": "holographic",
  linearholo: "holographic",
  "scattered holo": "holographic",
  "scattered-holo": "holographic",
  scatteredholo: "holographic",
  "micro holo": "holographic",
  "micro-holo": "holographic",
  microholo: "holographic",
  "holo glitter": "holographic",
  "holo-glitter": "holographic",
  "holographic glitter": "holographic",
  "holo flake": "holographic",
  "holo-flake": "holographic",
  "holo flakes": "holographic",
  "holo-flakes": "holographic",
  duochrome: "duochrome",
  multichrome: "multichrome",
  flake: "flake",
  flakes: "flake",
  flakie: "flake",
  flakies: "flake",
  topper: "topper",
  toppers: "topper",
  sheer: "sheer",
  magnetic: "magnetic",
  thermal: "thermal",
  crelly: "crelly",
  glow: "glow",
  "glow in the dark": "glow",
  "glow-in-the-dark": "glow",
  gitd: "glow",
});

/** Lowercased source value → canonical-ish finish name. */
export type FinishAliasMap = ReadonlyMap<string, string>;

export const DEFAULT_FINISH_ALIAS_MAP: FinishAliasMap = new Map(Object.entries(DEFAULT_FINISH_ALIASES));

/** Tag prefix for explicit finish tags (`finish:holographic`). */
export const FINISH_TAG_PREFIX = "finish:";

const FINISH_TAG_PATTERN = /^finish\s*:\s*(.*)$/i;

function normalizeFinishKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Resolve one raw finish string to a canonical finish, or `null` when it is not a
 * known finish. Matching is case-insensitive and whitespace-tolerant; canonical
 * names always resolve to themselves, other values go through `aliases`.
 */
export function canonicalizeFinish(
  value: unknown,
  aliases: FinishAliasMap = DEFAULT_FINISH_ALIAS_MAP
): PolishFinish | null {
  if (typeof value !== "string") return null;
  const key = normalizeFinishKey(value);
  if (!key) return null;
  if (isCanonicalFinish(key)) return key;

  const candidates = [key, key.replace(/[-_]+/g, " "), key.replace(/[\s_]+/g, "-")];
  for (const candidate of candidates) {
    const mapped = aliases.get(candidate);
    if (!mapped) continue;
    const normalized = normalizeFinishKey(mapped);
    if (isCanonicalFinish(normalized)) return normalized;
  }
  return null;
}

/** Canonicalize a list of raw finish strings, dropping unknowns and de-duplicating (order preserved). */
export function canonicalizeFinishes(
  values: Iterable<unknown> | null | undefined,
  aliases: FinishAliasMap = DEFAULT_FINISH_ALIAS_MAP
): PolishFinish[] {
  const out: PolishFinish[] = [];
  if (!values) return out;
  for (const value of values) {
    const canonical = canonicalizeFinish(value, aliases);
    if (canonical && !out.includes(canonical)) out.push(canonical);
  }
  return out;
}

/**
 * Extract canonical finishes from product/import tags.
 *
 * - `finish:<value>` tags (prefix is case-insensitive, whitespace-tolerant) and
 *   bare `<value>` tags are both recognized; e.g. `holographic`,
 *   `finish:holographic`, and ` HOLO ` all resolve to `holographic`.
 * - Tags in other namespaces (`collection:holographic`, `color:blue`) are ignored.
 * - Unknown values are ignored; results are de-duplicated.
 * - Order: explicit `finish:` tags first (in tag order), then bare tags (in tag
 *   order). The first entry is treated as the primary finish by callers.
 *
 * Used by ingestion connectors only. User request `tags` on polish create/update are
 * deliberately NOT parsed into catalog finishes (see `resolveRequestedFinishes`).
 *
 * Pure: pass the DB-backed alias map from `loadFinishAliasMap()` to honor
 * admin-managed `finish_normalization` rows.
 */
export function parseFinishesFromTags(
  tags: unknown,
  aliases: FinishAliasMap = DEFAULT_FINISH_ALIAS_MAP
): PolishFinish[] {
  if (!Array.isArray(tags)) return [];

  const explicit: string[] = [];
  const bare: string[] = [];
  for (const tag of tags) {
    if (typeof tag !== "string") continue;
    const trimmed = tag.trim();
    if (!trimmed) continue;

    const prefixed = FINISH_TAG_PATTERN.exec(trimmed);
    if (prefixed) {
      explicit.push(prefixed[1]);
    } else if (!trimmed.includes(":")) {
      bare.push(trimmed);
    }
  }

  return canonicalizeFinishes([...explicit, ...bare], aliases);
}

/** Merge finish lists, keeping `primary` order first and de-duplicating. */
export function mergeFinishLists(
  primary: readonly string[] | null | undefined,
  ...rest: Array<readonly string[] | null | undefined>
): PolishFinish[] {
  return canonicalizeFinishes([...(primary ?? []), ...rest.flatMap((list) => list ?? [])]);
}

// ---------------------------------------------------------------------------
// API request helpers (polish create/update)
// ---------------------------------------------------------------------------

/**
 * How a create/update request changes `shade.finishes`:
 * - `replace`: an explicit `finishes` array was sent (it may be empty to clear).
 * - `merge`: only the legacy `finish` was sent; its value is appended.
 */
export interface ShadeFinishUpdate {
  mode: "replace" | "merge";
  values: string[];
}

/**
 * True when a create/update request asks to change shade finishes. Only the explicit
 * `finishes` array and the legacy `finish` count. Request `tags` never do: shades are
 * shared catalog rows, and a user's personal inventory tags must not rewrite them
 * (only ingestion connectors parse finishes from product tags).
 */
export function requestCarriesFinishData(body: Pick<PolishCreateRequest, "finish" | "finishes">): boolean {
  return Array.isArray(body.finishes) || Boolean(body.finish);
}

/**
 * Resolve the canonical finishes a request asks for from explicit `finishes` (replace
 * mode) or the legacy `finish` (merge mode). Request `tags` are ignored (see
 * `requestCarriesFinishData`). Returns `undefined` when the request carries no finish
 * information at all, meaning "leave `shade.finishes` untouched".
 */
export function resolveRequestedFinishes(
  body: Pick<PolishCreateRequest, "finish" | "finishes">,
  aliases?: FinishAliasMap
): ShadeFinishUpdate | undefined {
  const explicitList = Array.isArray(body.finishes) ? body.finishes : null;
  const explicit = explicitList ?? (body.finish ? [body.finish] : []);

  if (!explicitList && explicit.length === 0) {
    return undefined;
  }

  return {
    mode: explicitList ? "replace" : "merge",
    values: canonicalizeFinishes(explicit, aliases),
  };
}

// ---------------------------------------------------------------------------
// DB-backed alias map (finish_normalization ∪ finish_type), cached in-process.
// ---------------------------------------------------------------------------

const FINISH_ALIAS_CACHE_TTL_MS = 5 * 60 * 1000;

let aliasCache: { values: FinishAliasMap; expiresAtMs: number } | null = null;
let pendingAliasLoad: Promise<FinishAliasMap> | null = null;

export interface LoadFinishAliasMapOptions {
  /** Called when the DB lookup fails and the built-in fallback map is used. */
  onFallback?: (message: string, code?: string) => void;
}

/**
 * Load the alias map from `finish_normalization` (priority) plus identity rows
 * for every `finish_type.name`. Cached for 5 minutes; falls back to
 * `DEFAULT_FINISH_ALIAS_MAP` if the query fails.
 */
export async function loadFinishAliasMap(options?: LoadFinishAliasMapOptions): Promise<FinishAliasMap> {
  const now = Date.now();
  if (aliasCache && aliasCache.expiresAtMs > now) {
    return aliasCache.values;
  }
  if (pendingAliasLoad) {
    return pendingAliasLoad;
  }

  pendingAliasLoad = (async () => {
    try {
      const result = await query<{ sourceValue: string; normalizedFinishName: string }>(
        `SELECT DISTINCT ON ("sourceValue")
           "sourceValue",
           "normalizedFinishName"
         FROM (
           SELECT
             source_value AS "sourceValue",
             normalized_finish_name AS "normalizedFinishName",
             1 AS source_priority
           FROM finish_normalization
           UNION ALL
           SELECT
             name AS "sourceValue",
             name AS "normalizedFinishName",
             2 AS source_priority
           FROM finish_type
         ) x
         ORDER BY "sourceValue", source_priority`
      );

      const values = new Map<string, string>();
      for (const row of result.rows ?? []) {
        if (typeof row?.sourceValue !== "string" || typeof row?.normalizedFinishName !== "string") continue;
        const source = normalizeFinishKey(row.sourceValue);
        const normalized = normalizeFinishKey(row.normalizedFinishName);
        if (!source || !normalized) continue;
        values.set(source, normalized);
      }

      aliasCache = { values, expiresAtMs: now + FINISH_ALIAS_CACHE_TTL_MS };
      return values;
    } catch (error: unknown) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code: unknown }).code)
          : undefined;
      const message = error instanceof Error ? error.message : String(error);
      options?.onFallback?.(message, code);
      return DEFAULT_FINISH_ALIAS_MAP;
    } finally {
      pendingAliasLoad = null;
    }
  })();

  return pendingAliasLoad;
}

/** Clear the in-process alias cache (tests, or after admin edits in the same process). */
export function resetFinishAliasCache(): void {
  aliasCache = null;
  pendingAliasLoad = null;
}
