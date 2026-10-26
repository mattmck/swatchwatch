/**
 * "Buy from brand" outbound links (#267).
 *
 * A shade's buy link comes from the product URL its connector stored
 * (`external_product.normalized_json ->> 'productUrl'`), reached through the
 * `shade_source_product` link table that ingestion writes when it materializes a shade
 * (migration 20261017061344201_add-shade-source-product).
 *
 * Validation: only absolute `http:`/`https:` URLs with a host and no embedded
 * credentials ever reach a client; anything else (`javascript:`, `data:`, relative
 * paths, `https://user:pass@…`) is dropped.
 *
 * Selection when a shade has several source products (`selectBuyFromBrandUrl`):
 *   1. candidates whose URL fails validation are ignored, and so are products of a disabled
 *      `data_source` (a source is disabled when its links are dead or the store has not
 *      agreed, e.g. MakeupAPI's 2015 well.ca / dior.com URLs), so such a shade shows no link;
 *   2. then the most recently seen link (`shade_source_product.last_seen_at`);
 *   3. then the most recently fetched product (`external_product.fetched_at`);
 *   4. then the highest `external_product_id`, so ties are still deterministic.
 *
 * Price: the chosen product's vendor list price (`normalized_json` `price` + `currency`,
 * written by the connectors, see `product-price.ts`) travels with the URL as one `BuyLink`.
 * It always comes from the same product as the URL (no separate choice), only when both a
 * valid amount and an ISO 4217 currency are stored, with `priceSeenAt` = that product's
 * `external_product.fetched_at`.
 *
 * No affiliate parameters are added today; `applyAffiliateParams` is the single place
 * where they would be.
 */
import type { PoolClient } from "pg";
import { query as defaultQuery } from "./db";
import { normalizeCurrencyCode, normalizePriceAmount } from "./product-price";

/** Longest URL we pass through; longer values are treated as junk rather than truncated. */
export const MAX_BUY_URL_LENGTH = 2048;

/** One stored source product URL for a shade, as read from the database. */
export interface BuyLinkCandidate {
  shadeId: string;
  url: string | null | undefined;
  /** `data_source.enabled` of the product's source; `false` drops the candidate. */
  sourceEnabled: boolean | null | undefined;
  /** `shade_source_product.last_seen_at`. */
  lastSeenAt: Date | string | null | undefined;
  /** `external_product.fetched_at`. */
  fetchedAt?: Date | string | null | undefined;
  externalProductId: string | number | null | undefined;
  /** `normalized_json ->> 'price'` (decimal string, major units). */
  price?: string | number | null;
  /** `normalized_json ->> 'currency'` (ISO 4217). */
  currency?: string | null;
}

/** The selected buy link for a shade: URL plus the same product's list price, when known. */
export interface BuyLink {
  url: string;
  /** Major units, e.g. 12.5. Present only together with `currency`. */
  price?: number;
  currency?: string;
  /** ISO timestamp of the product fetch the price came from. */
  priceSeenAt?: string;
}

// C0 controls, DEL and whitespace: browsers strip or reinterpret these, so a URL
// containing one is rejected instead of being "cleaned".
// eslint-disable-next-line no-control-regex
const UNSAFE_URL_CHARS = /[\u0000- \u007f]/;

/**
 * Returns the normalized URL when `raw` is a safe outbound link, else null.
 * Safe = absolute `http://` or `https://` URL with a hostname, no username/password,
 * no control characters or whitespace, at most MAX_BUY_URL_LENGTH characters.
 */
export function sanitizeBuyUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || value.length > MAX_BUY_URL_LENGTH) return null;
  if (UNSAFE_URL_CHARS.test(value)) return null;
  // Require the explicit scheme + authority form; `new URL("https:example.com")` would
  // otherwise parse, and anything without a scheme is not an absolute URL.
  if (!/^https?:\/\//i.test(value)) return null;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!parsed.hostname) return null;
  if (parsed.username || parsed.password) return null;

  const normalized = parsed.href;
  return normalized.length > MAX_BUY_URL_LENGTH ? null : normalized;
}

/**
 * Hook for affiliate/tracking parameters on outbound buy links. Intentionally a no-op:
 * SwatchWatch adds no affiliate parameters today. When an affiliate program is added,
 * do it here (and only here) so every buy link in the API goes through one place.
 * The input is an already-sanitized URL and the result must stay one.
 */
export function applyAffiliateParams(url: string, _candidate?: BuyLinkCandidate): string {
  return url;
}

function toMillis(value: Date | string | null | undefined): number {
  if (value === null || value === undefined) return Number.NEGATIVE_INFINITY;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

function toIdNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return Number.NEGATIVE_INFINITY;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : Number.NEGATIVE_INFINITY;
}

/** Sort comparator implementing the selection rule (best candidate first). */
export function compareBuyLinkCandidates(a: BuyLinkCandidate, b: BuyLinkCandidate): number {
  const seenA = toMillis(a.lastSeenAt);
  const seenB = toMillis(b.lastSeenAt);
  if (seenA !== seenB) return seenB > seenA ? 1 : -1;

  const fetchedA = toMillis(a.fetchedAt);
  const fetchedB = toMillis(b.fetchedAt);
  if (fetchedA !== fetchedB) return fetchedB > fetchedA ? 1 : -1;

  const idA = toIdNumber(a.externalProductId);
  const idB = toIdNumber(b.externalProductId);
  if (idA !== idB) return idB > idA ? 1 : -1;

  // Last resort for identical metadata: stable lexical order on the URL.
  const urlA = typeof a.url === "string" ? a.url : "";
  const urlB = typeof b.url === "string" ? b.url : "";
  return urlA < urlB ? -1 : urlA > urlB ? 1 : 0;
}

function toIsoTimestamp(value: Date | string | null | undefined): string | undefined {
  const ms = toMillis(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/** The candidate's price fields, or `{}` unless both amount and currency are valid. */
function buyLinkPrice(candidate: BuyLinkCandidate): Omit<BuyLink, "url"> {
  const amount = normalizePriceAmount(candidate.price);
  const currency = normalizeCurrencyCode(candidate.currency);
  if (amount === null || currency === null) return {};
  const priceSeenAt = toIsoTimestamp(candidate.fetchedAt);
  return { price: Number(amount), currency, ...(priceSeenAt ? { priceSeenAt } : {}) };
}

/**
 * Picks one buy link from a shade's candidates (see the selection rule at the top of this
 * file), or null when none from an enabled source has a valid URL. Input order does not matter. The price, when
 * present, belongs to the chosen product; a better-priced runner-up is never mixed in.
 */
export function selectBuyFromBrandLink(candidates: readonly BuyLinkCandidate[]): BuyLink | null {
  const valid: Array<{ candidate: BuyLinkCandidate; url: string }> = [];
  for (const candidate of candidates) {
    if (candidate.sourceEnabled === false) continue;
    const url = sanitizeBuyUrl(candidate.url);
    if (url) valid.push({ candidate, url });
  }
  if (valid.length === 0) return null;
  valid.sort((a, b) => compareBuyLinkCandidates(a.candidate, b.candidate));
  const best = valid[0];
  // Re-validate after the hook so an affiliate change can never emit an unsafe URL.
  const url = sanitizeBuyUrl(applyAffiliateParams(best.url, best.candidate));
  return url ? { url, ...buyLinkPrice(best.candidate) } : null;
}

/** URL-only form of `selectBuyFromBrandLink`. */
export function selectBuyFromBrandUrl(candidates: readonly BuyLinkCandidate[]): string | null {
  return selectBuyFromBrandLink(candidates)?.url ?? null;
}

/** Groups candidates per shade and selects one link each. Shades without a valid URL are omitted. */
export function selectBuyLinksByShade(candidates: readonly BuyLinkCandidate[]): Map<string, BuyLink> {
  const byShade = new Map<string, BuyLinkCandidate[]>();
  for (const candidate of candidates) {
    if (candidate?.shadeId === undefined || candidate.shadeId === null) continue;
    const key = String(candidate.shadeId);
    const list = byShade.get(key);
    if (list) list.push(candidate);
    else byShade.set(key, [candidate]);
  }
  const result = new Map<string, BuyLink>();
  for (const [shadeId, list] of byShade) {
    const link = selectBuyFromBrandLink(list);
    if (link) result.set(shadeId, link);
  }
  return result;
}

/** URL-only form of `selectBuyLinksByShade`. */
export function selectBuyUrlsByShade(candidates: readonly BuyLinkCandidate[]): Map<string, string> {
  return new Map(Array.from(selectBuyLinksByShade(candidates), ([shadeId, link]) => [shadeId, link.url]));
}

/** Candidate rows for a set of shades; every linked product that carries a product URL. */
export const BUY_LINK_CANDIDATES_SQL = `SELECT
       ssp.shade_id::text                      AS "shadeId",
       ep.normalized_json ->> 'productUrl'     AS url,
       ds.enabled                              AS "sourceEnabled",
       ssp.last_seen_at                        AS "lastSeenAt",
       ep.fetched_at                           AS "fetchedAt",
       ep.external_product_id::text            AS "externalProductId",
       ep.normalized_json ->> 'price'          AS price,
       ep.normalized_json ->> 'currency'       AS currency
     FROM shade_source_product ssp
     JOIN external_product ep ON ep.external_product_id = ssp.external_product_id
     JOIN data_source ds ON ds.data_source_id = ep.data_source_id
     WHERE ssp.shade_id = ANY($1::bigint[])
       AND NULLIF(trim(ep.normalized_json ->> 'productUrl'), '') IS NOT NULL`;

type QueryFn = <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<{ rows: T[] }>;

function toShadeIdParam(value: unknown): string | null {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  return /^[1-9]\d{0,18}$/.test(text) ? text : null;
}

/**
 * Loads the selected buy link (URL + price) for each shade id. Never throws: buy links are
 * optional decoration, so a lookup failure (e.g. the migration has not run yet) logs a
 * warning and returns an empty map instead of failing the caller's request.
 */
export async function loadBuyLinksForShades(
  shadeIds: readonly unknown[],
  queryFn: QueryFn = defaultQuery as unknown as QueryFn
): Promise<Map<string, BuyLink>> {
  const ids = Array.from(new Set(shadeIds.map(toShadeIdParam).filter((id): id is string => id !== null)));
  if (ids.length === 0) return new Map();
  try {
    const result = await queryFn<BuyLinkCandidate>(BUY_LINK_CANDIDATES_SQL, [ids]);
    return selectBuyLinksByShade(Array.isArray(result?.rows) ? result.rows : []);
  } catch (error) {
    console.warn("[buy-link] Failed to load buy-from-brand links:", (error as Error)?.message ?? error);
    return new Map();
  }
}

/** URL-only form of `loadBuyLinksForShades`. */
export async function loadBuyUrlsForShades(
  shadeIds: readonly unknown[],
  queryFn?: QueryFn
): Promise<Map<string, string>> {
  const links = await loadBuyLinksForShades(shadeIds, queryFn);
  return new Map(Array.from(links, ([shadeId, link]) => [shadeId, link.url]));
}

/** API response fields for a buy link (`Polish.buyUrl`, `buyPrice`, `buyCurrency`, `buyPriceSeenAt`). */
export interface BuyLinkFields {
  buyUrl?: string;
  buyPrice?: number;
  buyCurrency?: string;
  buyPriceSeenAt?: string;
}

/** Response fields for a link; `{}` when there is none, so no keys appear. */
export function buyLinkFields(link: BuyLink | null | undefined): BuyLinkFields {
  if (!link) return {};
  const fields: BuyLinkFields = { buyUrl: link.url };
  if (link.price !== undefined && link.currency) {
    fields.buyPrice = link.price;
    fields.buyCurrency = link.currency;
    if (link.priceSeenAt) fields.buyPriceSeenAt = link.priceSeenAt;
  }
  return fields;
}

/**
 * Returns `rows` with `buyUrl` (and `buyPrice` / `buyCurrency` / `buyPriceSeenAt` when the
 * chosen product has a price) set on every row whose shade has a valid buy link. Rows
 * without one are returned unchanged (no `buyUrl` key), so clients render no link.
 */
export async function withBuyUrls<T extends object>(
  rows: readonly T[],
  getShadeId: (row: T) => unknown,
  queryFn?: QueryFn
): Promise<Array<T & BuyLinkFields>> {
  if (rows.length === 0) return [];
  const links = await loadBuyLinksForShades(rows.map(getShadeId), queryFn);
  return rows.map((row) => {
    const shadeId = toShadeIdParam(getShadeId(row));
    return { ...row, ...buyLinkFields(shadeId ? links.get(shadeId) : undefined) };
  });
}

/**
 * Records (or refreshes) the link between a materialized shade and the connector product
 * it came from. Called by ingestion inside its transaction, after `upsertExternalProducts`
 * has stored the product. No-op when the product row is missing.
 */
export async function recordShadeSourceProduct(
  client: Pick<PoolClient, "query">,
  shadeId: number,
  dataSourceId: number,
  externalId: string | null | undefined
): Promise<void> {
  const trimmed = externalId?.trim();
  if (!trimmed || !Number.isFinite(shadeId) || !Number.isFinite(dataSourceId)) return;
  await client.query(
    `INSERT INTO shade_source_product (shade_id, external_product_id)
     SELECT $1, ep.external_product_id
     FROM external_product ep
     WHERE ep.data_source_id = $2
       AND ep.external_id = $3
     ON CONFLICT (shade_id, external_product_id)
     DO UPDATE SET last_seen_at = now()`,
    [shadeId, dataSourceId, trimmed]
  );
}
