/**
 * Finish canonicalization + tag parsing.
 *
 * Source-of-truth split (runtime):
 * - WHICH finishes are valid: the DB `finish_type` table (admin-managed). A
 *   finish type created only through the admin UI is a valid finish.
 * - HOW messy input spellings map onto them: the DB `finish_normalization`
 *   table (admin-editable via `/api/reference-admin/finish-normalizations`).
 * - `CANONICAL_FINISHES` in `swatchwatch-shared` is only the set of BUILT-IN
 *   seeded defaults (kept equal to the migration seeds by a test). It types the
 *   known built-ins and is the fallback when the DB is unreachable or pure
 *   callers pass no catalog; `DEFAULT_FINISH_ALIASES` below mirrors the seeded
 *   alias rows for the same purpose.
 *
 * Both halves are loaded together by `loadFinishCatalog()` (one query, one
 * cache) and passed into the pure helpers as a `FinishCatalog`. Every value
 * returned by this module is a member of the catalog's `validNames`; alias rows
 * pointing at a name that is not a `finish_type` are ignored.
 */
import {
  CANONICAL_FINISHES,
  DUPE_FINISH_FAMILIES,
  buildFinishFamilyMap,
  type FinishFamilyMap,
  type FinishFamilySource,
  type PolishCreateRequest,
} from "swatchwatch-shared";
import { query } from "./db";

/**
 * Fallback alias map (source value → canonical finish). Mirrors the
 * `finish_normalization` rows seeded by migrations 018 and 023; the unit test
 * `finishes.unit.test.cjs` asserts they stay identical.
 */
export const DEFAULT_FINISH_ALIASES: Readonly<Record<string, string>> = Object.freeze({
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

/**
 * Everything needed to validate and normalize a finish string at runtime:
 * - `aliases`: lowercased source spelling → finish name (from `finish_normalization`)
 * - `validNames`: the finish names that exist (from `finish_type`)
 * - `families`: finish name → dupe-grading family (`finish_type.family`, #320) layered over the
 *   built-in `DUPE_FINISH_FAMILIES`; optional so hand-built catalogs keep working (callers fall
 *   back to the built-ins when it is missing)
 */
export interface FinishCatalog {
  aliases: FinishAliasMap;
  validNames: ReadonlySet<string>;
  families?: FinishFamilyMap;
}

/** Built-in seeded defaults: used when no DB catalog is available. */
export const DEFAULT_FINISH_CATALOG: FinishCatalog = Object.freeze({
  aliases: DEFAULT_FINISH_ALIAS_MAP,
  validNames: new Set<string>(CANONICAL_FINISHES),
  families: DUPE_FINISH_FAMILIES,
});

/** Tag prefix for explicit finish tags (`finish:holographic`). */
export const FINISH_TAG_PREFIX = "finish:";

const FINISH_TAG_PATTERN = /^finish\s*:\s*(.*)$/i;

/**
 * Lookup key for a finish string: trimmed, lowercased, whitespace runs collapsed. Finish values
 * stored in `shade.finishes` are always keys of this form. The admin rename SQL mirrors it.
 */
export function normalizeFinishKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Resolve one raw finish string to a valid finish name, or `null` when it is not a
 * known finish. Matching is case-insensitive and whitespace-tolerant; valid names
 * always resolve to themselves, other values go through `catalog.aliases`.
 * Defaults to the built-in finishes; pass `await loadFinishCatalog()` to honor
 * admin-managed finish types.
 */
export function canonicalizeFinish(value: unknown, catalog: FinishCatalog = DEFAULT_FINISH_CATALOG): string | null {
  if (typeof value !== "string") return null;
  const key = normalizeFinishKey(value);
  if (!key) return null;
  if (catalog.validNames.has(key)) return key;

  const candidates = [key, key.replace(/[-_]+/g, " "), key.replace(/[\s_]+/g, "-")];
  for (const candidate of candidates) {
    const mapped = catalog.aliases.get(candidate);
    if (!mapped) continue;
    const normalized = normalizeFinishKey(mapped);
    if (catalog.validNames.has(normalized)) return normalized;
  }
  return null;
}

/** Canonicalize a list of raw finish strings, dropping unknowns and de-duplicating (order preserved). */
export function canonicalizeFinishes(
  values: Iterable<unknown> | null | undefined,
  catalog: FinishCatalog = DEFAULT_FINISH_CATALOG
): string[] {
  const out: string[] = [];
  if (!values) return out;
  for (const value of values) {
    const canonical = canonicalizeFinish(value, catalog);
    if (canonical && !out.includes(canonical)) out.push(canonical);
  }
  return out;
}

/**
 * Extract valid finishes from product/import tags.
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
 * Pure: pass the DB-backed catalog from `loadFinishCatalog()` to honor
 * admin-managed `finish_type` and `finish_normalization` rows.
 */
export function parseFinishesFromTags(tags: unknown, catalog: FinishCatalog = DEFAULT_FINISH_CATALOG): string[] {
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

  return canonicalizeFinishes([...explicit, ...bare], catalog);
}

/** Merge finish lists, keeping the first list's order first and de-duplicating. */
export function mergeFinishLists(
  lists: ReadonlyArray<readonly string[] | null | undefined>,
  catalog: FinishCatalog = DEFAULT_FINISH_CATALOG
): string[] {
  return canonicalizeFinishes(
    lists.flatMap((list) => list ?? []),
    catalog
  );
}

// ---------------------------------------------------------------------------
// AI prompt finish list
// ---------------------------------------------------------------------------

/** Catch-all finish that is never offered to a model as an answer. */
const PROMPT_EXCLUDED_FINISHES: ReadonlySet<string> = new Set(["other"]);

/**
 * The finish names AI prompts (vision hex/finish detection, label OCR) offer the model, from
 * the runtime catalog so admin-added finish types (e.g. `chrome`) can be returned. Built-in
 * finishes come first in their seeded order, then admin-added names alphabetically, so the
 * list (and the prompt text) only changes when an admin edits `finish_type`, keeping the
 * prompt prefix cacheable. The `other` catch-all is left out. Defaults to the built-ins.
 */
export function finishNamesForPrompt(catalog: FinishCatalog = DEFAULT_FINISH_CATALOG): string[] {
  const builtIns = CANONICAL_FINISHES.filter((name) => catalog.validNames.has(name));
  const builtInSet = new Set<string>(CANONICAL_FINISHES);
  const added = [...catalog.validNames].filter((name) => !builtInSet.has(name)).sort();
  const names = [...builtIns, ...added].filter((name) => !PROMPT_EXCLUDED_FINISHES.has(name));
  return names.length ? names : CANONICAL_FINISHES.filter((name) => !PROMPT_EXCLUDED_FINISHES.has(name));
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
  catalog?: FinishCatalog
): ShadeFinishUpdate | undefined {
  const explicitList = Array.isArray(body.finishes) ? body.finishes : null;
  const explicit = explicitList ?? (body.finish ? [body.finish] : []);

  if (!explicitList && explicit.length === 0) {
    return undefined;
  }

  return {
    mode: explicitList ? "replace" : "merge",
    values: canonicalizeFinishes(explicit, catalog),
  };
}

// ---------------------------------------------------------------------------
// DB-backed finish catalog (finish_type + finish_normalization), cached in-process.
// ---------------------------------------------------------------------------

const FINISH_CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;

let catalogCache: { value: FinishCatalog; expiresAtMs: number } | null = null;
let pendingCatalogLoad: Promise<FinishCatalog> | null = null;
// Bumped by resetFinishAliasCache so a load that started before the reset cannot write its
// (stale) result back into the cache or clear a newer in-flight load.
let catalogGeneration = 0;

export interface LoadFinishCatalogOptions {
  /** Called when the DB lookup fails and the built-in fallback catalog is used. */
  onFallback?: (message: string, code?: string) => void;
}

interface FinishCatalogRow {
  kind: string;
  sourceValue: string;
  normalizedFinishName: string;
  /** `finish_type.family` on 'type' rows; always NULL on 'alias' rows. */
  family?: string | null;
}

/**
 * Load the finish catalog in ONE query: `finish_type` names (the valid finishes, plus
 * identity aliases) and `finish_normalization` rows (aliases, which win over identity
 * rows). An alias only resolves when its target is a `finish_type` name. The same query
 * reads `finish_type.family` into `families` (`buildFinishFamilyMap`). Cached for
 * 5 minutes (cleared on admin reference edits); falls back to
 * `DEFAULT_FINISH_CATALOG` (built-in finishes + `DEFAULT_FINISH_ALIAS_MAP`) if the
 * query fails.
 */
export async function loadFinishCatalog(options?: LoadFinishCatalogOptions): Promise<FinishCatalog> {
  const now = Date.now();
  if (catalogCache && catalogCache.expiresAtMs > now) {
    return catalogCache.value;
  }
  if (pendingCatalogLoad) {
    return pendingCatalogLoad;
  }

  const generation = catalogGeneration;
  const load: Promise<FinishCatalog> = (async () => {
    try {
      const result = await query<FinishCatalogRow>(
        `SELECT 'alias' AS kind,
                source_value AS "sourceValue",
                normalized_finish_name AS "normalizedFinishName",
                NULL::text AS family
         FROM finish_normalization
         UNION ALL
         SELECT 'type' AS kind,
                name AS "sourceValue",
                name AS "normalizedFinishName",
                family
         FROM finish_type`
      );

      const validNames = new Set<string>();
      const aliases = new Map<string, string>();
      const aliasRows: Array<[string, string]> = [];
      const familyRows: FinishFamilySource[] = [];
      for (const row of result.rows ?? []) {
        if (typeof row?.sourceValue !== "string" || typeof row?.normalizedFinishName !== "string") continue;
        const source = normalizeFinishKey(row.sourceValue);
        const normalized = normalizeFinishKey(row.normalizedFinishName);
        if (!source || !normalized) continue;
        if (row.kind === "type") {
          validNames.add(normalized);
          aliases.set(source, normalized);
          familyRows.push({ name: normalized, family: row.family ?? null });
        } else {
          aliasRows.push([source, normalized]);
        }
      }
      // An empty finish_type table is a misconfiguration, not "no finish is valid".
      if (validNames.size === 0) {
        for (const name of CANONICAL_FINISHES) {
          validNames.add(name);
        }
      }
      // Alias rows take priority over identity rows; only keep ones that resolve to a real finish.
      for (const [source, normalized] of aliasRows) {
        if (validNames.has(normalized)) aliases.set(source, normalized);
      }

      const value: FinishCatalog = { aliases, validNames, families: buildFinishFamilyMap(familyRows) };
      if (generation === catalogGeneration) {
        catalogCache = { value, expiresAtMs: now + FINISH_CATALOG_CACHE_TTL_MS };
      }
      return value;
    } catch (error: unknown) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code: unknown }).code)
          : undefined;
      const message = error instanceof Error ? error.message : String(error);
      options?.onFallback?.(message, code);
      return DEFAULT_FINISH_CATALOG;
    } finally {
      if (generation === catalogGeneration) {
        pendingCatalogLoad = null;
      }
    }
  })();
  pendingCatalogLoad = load;

  return load;
}

/** Clear the in-process catalog cache (tests, or after admin edits in the same process). */
export function resetFinishAliasCache(): void {
  catalogGeneration += 1;
  catalogCache = null;
  pendingCatalogLoad = null;
}
