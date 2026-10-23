/**
 * Mobile glue for Looks (web: `lib/looks-saved.ts`, the page's catalog-gap queries). The
 * recommender itself is `recommendLooks` in `swatchwatch-shared`; this file builds what the screen
 * sends to the API (gap queries, saved-look snapshots) and what it hands to the mani sheet.
 */
import {
  MAX_SAVED_LOOKS,
  SKIN_DEPTHS,
  SKIN_UNDERTONES,
  TOPPER_FINISHES,
  applyStepSwap,
  catalogQueriesForLooks,
  maniRoleForStep,
  savedLookKey,
  skinToneFrom,
  type ColorFamily,
  type Look,
  type LookCatalogQueries,
  type LookStepRole,
  type Polish,
  type ShoppingItem,
  type PolishFilters,
  type SavedLook,
  type SavedLookStep,
  type SkinDepth,
  type SkinTone,
  type SkinUndertone,
  type Vibe,
} from "swatchwatch-shared";
import { formatBuyPriceLine } from "./buy-price";
import { entryFromPolish, type ManiEntry } from "./mani";

/**
 * `api-cache` key for the remembered skin tone (scope = user id; same rule as the web's
 * `lib/looks-skin-tone.ts`). The screen rewrites it on every open, so it only lapses after
 * `MAX_AGE_MS` of not opening Looks, and it is wiped on sign-out with the rest of the cache.
 */
export const SKIN_TONE_CACHE_KEY = "looks-skin-tone";

/** Validate a cached value; anything unusable is "no skin tone". */
export function parseCachedSkinTone(value: unknown): SkinTone | null {
  if (typeof value !== "object" || value === null) return null;
  const { undertone, depth } = value as Record<string, unknown>;
  return skinToneFrom(
    (SKIN_UNDERTONES as readonly unknown[]).includes(undertone) ? (undertone as SkinUndertone) : null,
    (SKIN_DEPTHS as readonly unknown[]).includes(depth) ? (depth as SkinDepth) : null,
  );
}

/** Catalog rows fetched per gap query (one color family, or toppers). */
export const CATALOG_PAGE_SIZE = 60;
/** The API's `?nearHex=` cap: more gap targets in one family than this only rank on the first ones. */
export const MAX_NEAR_HEX_TARGETS = 24;
/** Most color-family queries per render, so a fully-empty collection doesn't fan out too far. */
export const MAX_CATALOG_FAMILY_QUERIES = 6;
export const TOPPER_QUERY_KEY = "toppers";

/** A catalog gap query: a stable key (cache + dedupe) and the list filters it sends. */
export interface CatalogGapQuery {
  key: string;
  filters: PolishFilters;
}

/** Query key for one color family's gaps: `family:<family>|<target hexes>`. */
function familyQueryKey(queries: LookCatalogQueries, family: ColorFamily): string {
  const targets = (queries.targetsByFamily[family] ?? []).slice(0, MAX_NEAR_HEX_TARGETS);
  return `family:${family}|${targets.join(",")}`;
}

/**
 * The catalog fetches that fill the gaps of these looks (the web page's `catalogKeys`); with
 * `includeOwned`, the ones that offer substitutes for every step (the Swap and Details sheets).
 */
export function catalogGapQueries(looks: readonly Pick<Look, "steps">[], options: { includeOwned?: boolean } = {}): CatalogGapQuery[] {
  const queries = catalogQueriesForLooks(looks, options);
  const out: CatalogGapQuery[] = queries.families.slice(0, MAX_CATALOG_FAMILY_QUERIES).map((family) => {
    const targets = (queries.targetsByFamily[family] ?? []).slice(0, MAX_NEAR_HEX_TARGETS);
    return {
      key: familyQueryKey(queries, family),
      filters: { families: [family], nearHex: targets.length ? targets : undefined, pageSize: CATALOG_PAGE_SIZE },
    };
  });
  if (queries.toppers) {
    out.push({ key: TOPPER_QUERY_KEY, filters: { finishes: [...TOPPER_FINISHES], pageSize: CATALOG_PAGE_SIZE } });
  }
  return out;
}

/** The snapshot `POST /api/looks` stores (web: `toSavedLook`); `id` is the look key. */
export function toSavedLook(look: Look, vibe: Vibe, now: Date): SavedLook {
  const steps: SavedLookStep[] = look.steps.map((step) => ({
    role: step.role,
    label: step.label,
    hex: step.hex,
    source: step.source,
    ...(step.polish ? { shadeId: step.polish.id, brand: step.polish.brand, name: step.polish.name } : {}),
  }));
  return {
    id: savedLookKey(look.templateId, steps),
    templateId: look.templateId,
    name: look.name,
    savedAt: now.toISOString(),
    vibe,
    steps,
  };
}

/** Newest first, deduped by id, capped at `MAX_SAVED_LOOKS`. */
export function addSavedLook(list: readonly SavedLook[], look: SavedLook): SavedLook[] {
  return [look, ...list.filter((l) => l.id !== look.id)].slice(0, MAX_SAVED_LOOKS);
}

/** Owned steps of a look as mani-sheet entries ("Wear this"); steps still to add are skipped. */
export function maniEntriesFromLook(look: Pick<Look, "steps">): ManiEntry[] {
  return look.steps.flatMap((step) =>
    step.source === "owned" && step.polish ? [entryFromPolish(step.polish, maniRoleForStep(step.role))] : [],
  );
}

/** Owned steps of a saved look (shade ids, no polish rows) as mani-sheet entries. */
export function maniEntriesFromSavedLook(look: Pick<SavedLook, "steps">): ManiEntry[] {
  return look.steps.flatMap((step) =>
    step.source === "owned" && step.shadeId
      ? [{ shadeId: step.shadeId, role: maniRoleForStep(step.role), brand: step.brand ?? "", name: step.name ?? step.label, hex: step.hex }]
      : [],
  );
}

/** Next Shuffle seed: always a different positive integer than the current one. */
export function nextSeed(current: number, random: () => number = Math.random): number {
  const next = 1 + Math.floor(random() * 1_000_000);
  return next === current ? next + 1 : next;
}

/**
 * Swapped looks by template id, valid only for the recommendation they were swapped in (`key`:
 * vibe, seed, toppers, catalog readiness, owned count). A Shuffle or vibe change drops them, as
 * on the web page.
 */
export interface SwapOverrides {
  key: string;
  looks: Readonly<Record<string, Look>>;
}

export const NO_SWAPS: SwapOverrides = { key: "", looks: {} };

/** Swap `polish` (one of the step's owned alternatives) into `look`'s `role` step. */
export function withSwap(overrides: SwapOverrides, key: string, look: Look, role: LookStepRole, polish: Polish): SwapOverrides {
  return {
    key,
    looks: { ...(overrides.key === key ? overrides.looks : {}), [look.templateId]: applyStepSwap(look, role, polish) },
  };
}

/** The recommended looks with this recommendation's swaps applied. */
export function applySwaps(looks: readonly Look[], overrides: SwapOverrides, key: string): Look[] {
  const swapped = overrides.key === key ? overrides.looks : {};
  return looks.map((look) => swapped[look.templateId] ?? look);
}

/** Price line for a shopping item ("$14.00 · as of Oct 21, 2026"); null without a safe link and a price. */
export function shoppingItemPriceLine(item: Pick<ShoppingItem, "price" | "priceSeenAt">, locale?: string): string | null {
  if (!item.price) return null;
  return formatBuyPriceLine({ buyPrice: item.price.amount, buyCurrency: item.price.currency, buyPriceSeenAt: item.priceSeenAt ?? undefined }, locale);
}
