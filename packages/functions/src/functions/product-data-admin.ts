import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { withAdmin } from "../lib/auth";
import { query } from "../lib/db";
import { internalServerError } from "../lib/errors";
import { loadFinishCatalog } from "../lib/finishes";
import { withCors } from "../lib/http";
import { invalidateCatalogWideCaches } from "../lib/polish-cache";
import { createStoreCurrencyResolver, runProductPriceBatch, type CurrencyOrigin } from "../lib/product-price-backfill";
import {
  readFinishCoverage,
  runFinishFillBatch,
  runProductTextBatch,
  type BackfillQueryFn,
  type FinishCoverage,
} from "../lib/product-text-backfill";
import { trackEvent } from "../lib/telemetry";

/**
 * Connector product data backfills, one keyset page per request so the admin console can drive
 * them (`npm run backfill:product-text` / `backfill:product-price` run the same steps from a
 * shell, straight against Postgres). Admin-only, dry run unless the body says `"dryRun": false`.
 *
 * POST /api/products-admin/text/backfill   — `descriptionText` / `descriptors` from `raw_json` (#352)
 * POST /api/shades-admin/finishes/backfill — fill empty `shade.finishes` from the linked product (#352)
 * POST /api/products-admin/price/backfill  — `price` / `currency` from `raw_json` (buy link list price)
 *
 * Body: `{ after…Id?: number = 0, limit?: 1–1000 = 500, dryRun?: boolean = true, sources?: string[] }`;
 * the caller repeats with the response's `nextAfter…Id` until it is null.
 */

const DEFAULT_BATCH_SIZE = 500;
const MAX_BATCH_SIZE = 1000;
const MAX_SOURCES = 100;

export interface ProductDataBatchOptions {
  after: number;
  limit: number;
  dryRun: boolean;
  sources: string[] | null;
}

export function parseProductDataBatchBody(raw: unknown, cursorKey: string): ProductDataBatchOptions | string {
  const body = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const after = body[cursorKey] ?? 0;
  const limit = body.limit ?? DEFAULT_BATCH_SIZE;
  const dryRun = body.dryRun ?? true;
  if (typeof after !== "number" || !Number.isSafeInteger(after) || after < 0) {
    return `${cursorKey} must be a non-negative integer`;
  }
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_BATCH_SIZE) {
    return `limit must be an integer between 1 and ${MAX_BATCH_SIZE}`;
  }
  if (typeof dryRun !== "boolean") return "dryRun must be a boolean";
  let sources: string[] | null = null;
  if (body.sources !== undefined && body.sources !== null) {
    if (
      !Array.isArray(body.sources) ||
      body.sources.length > MAX_SOURCES ||
      !body.sources.every((name) => typeof name === "string" && name.trim().length > 0)
    ) {
      return `sources must be up to ${MAX_SOURCES} data_source names`;
    }
    sources = body.sources.length > 0 ? (body.sources as string[]).map((name) => name.trim()) : null;
  }
  return { after, limit, dryRun, sources };
}

async function readBody(request: HttpRequest): Promise<unknown | undefined> {
  try {
    const text = await request.text();
    return text.trim() ? JSON.parse(text) : {};
  } catch {
    return undefined;
  }
}

function toCursor(value: string | null): number | null {
  return value === null ? null : Number(value);
}

const db = query as unknown as BackfillQueryFn;

export interface ProductTextBackfillResponse {
  dryRun: boolean;
  scanned: number;
  /** Products whose stored text differs (dry run: would be rewritten). */
  changed: number;
  written: number;
  bySource: Record<string, number>;
  nextAfterExternalProductId: number | null;
}

export async function backfillProductText(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const raw = await readBody(request);
  if (raw === undefined) return { status: 400, jsonBody: { error: "Request body must be valid JSON" } };
  const parsed = parseProductDataBatchBody(raw, "afterExternalProductId");
  if (typeof parsed === "string") return { status: 400, jsonBody: { error: parsed } };

  try {
    const batch = await runProductTextBatch(db, {
      afterExternalProductId: parsed.after,
      limit: parsed.limit,
      sources: parsed.sources,
      write: !parsed.dryRun,
    });
    const response: ProductTextBackfillResponse = {
      dryRun: parsed.dryRun,
      scanned: batch.scanned,
      changed: batch.changed,
      written: batch.written,
      bySource: batch.bySource,
      nextAfterExternalProductId: toCursor(batch.nextAfterExternalProductId),
    };
    context.log(
      `[product-data-admin] text after=${parsed.after} dryRun=${parsed.dryRun} scanned=${batch.scanned} changed=${batch.changed} written=${batch.written}`
    );
    trackEvent("product_text_backfill.batch", {
      dryRun: String(parsed.dryRun),
      scanned: String(batch.scanned),
      changed: String(batch.changed),
      written: String(batch.written),
    });
    return { status: 200, jsonBody: response };
  } catch (error) {
    return internalServerError(context, error, "Product text backfill batch failed", "products-admin.text-backfill");
  }
}

export interface FinishFillBackfillResponse {
  dryRun: boolean;
  /** Empty-finish shades with a linked product read in this batch. */
  scanned: number;
  fillable: number;
  filled: number;
  /** Where the fillable finishes come from: tags, descriptors or description. */
  fillableBySource: Record<string, number>;
  /** Catalog-wide counts before this run; only on the first batch (`afterShadeId` 0). */
  coverage?: FinishCoverage;
  nextAfterShadeId: number | null;
}

export async function backfillShadeFinishes(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const raw = await readBody(request);
  if (raw === undefined) return { status: 400, jsonBody: { error: "Request body must be valid JSON" } };
  const parsed = parseProductDataBatchBody(raw, "afterShadeId");
  if (typeof parsed === "string") return { status: 400, jsonBody: { error: parsed } };

  try {
    const coverage = parsed.after === 0 ? await readFinishCoverage(db) : undefined;
    const batch = await runFinishFillBatch(db, await loadFinishCatalog(), {
      afterShadeId: parsed.after,
      limit: parsed.limit,
      sources: parsed.sources,
      write: !parsed.dryRun,
    });
    if (batch.filled > 0) {
      await invalidateCatalogWideCaches(batch.filledShadeIds.map(Number));
    }
    const response: FinishFillBackfillResponse = {
      dryRun: parsed.dryRun,
      scanned: batch.scanned,
      fillable: batch.fillable,
      filled: batch.filled,
      fillableBySource: batch.fillableBySource,
      ...(coverage ? { coverage } : {}),
      nextAfterShadeId: toCursor(batch.nextAfterShadeId),
    };
    context.log(
      `[product-data-admin] finishes after=${parsed.after} dryRun=${parsed.dryRun} scanned=${batch.scanned} fillable=${batch.fillable} filled=${batch.filled}`
    );
    trackEvent("finish_fill_backfill.batch", {
      dryRun: String(parsed.dryRun),
      scanned: String(batch.scanned),
      fillable: String(batch.fillable),
      filled: String(batch.filled),
    });
    return { status: 200, jsonBody: response };
  } catch (error) {
    return internalServerError(context, error, "Finish fill backfill batch failed", "shades-admin.finishes-backfill");
  }
}

export interface ProductPriceBackfillResponse {
  dryRun: boolean;
  scanned: number;
  changed: number;
  written: number;
  /** Rows that end up with both a price and a currency (the API shows those). */
  pricedWithCurrency: number;
  /** Rows that end up with a price but no known currency (not shown). */
  pricedWithoutCurrency: number;
  bySource: Record<string, number>;
  /** Store currency of each source seen in this batch, with where it came from. */
  currencies: Record<string, { currency: string | null; origin: CurrencyOrigin }>;
  nextAfterExternalProductId: number | null;
}

export async function backfillProductPrice(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const raw = await readBody(request);
  if (raw === undefined) return { status: 400, jsonBody: { error: "Request body must be valid JSON" } };
  const parsed = parseProductDataBatchBody(raw, "afterExternalProductId");
  if (typeof parsed === "string") return { status: 400, jsonBody: { error: parsed } };
  const fetchCurrency = (raw as Record<string, unknown>).fetchCurrency ?? true;
  if (typeof fetchCurrency !== "boolean") return { status: 400, jsonBody: { error: "fetchCurrency must be a boolean" } };

  try {
    const resolver = createStoreCurrencyResolver(db, { fetchCurrency });
    const batch = await runProductPriceBatch(db, resolver, {
      afterExternalProductId: parsed.after,
      limit: parsed.limit,
      sources: parsed.sources,
      write: !parsed.dryRun,
    });
    if (batch.written > 0) {
      // Buy prices ride on polish list/detail and catalog responses.
      await invalidateCatalogWideCaches();
    }
    const response: ProductPriceBackfillResponse = {
      dryRun: parsed.dryRun,
      scanned: batch.scanned,
      changed: batch.changed,
      written: batch.written,
      pricedWithCurrency: batch.pricedWithCurrency,
      pricedWithoutCurrency: batch.pricedWithoutCurrency,
      bySource: batch.bySource,
      currencies: resolver.currencies,
      nextAfterExternalProductId: toCursor(batch.nextAfterExternalProductId),
    };
    context.log(
      `[product-data-admin] price after=${parsed.after} dryRun=${parsed.dryRun} scanned=${batch.scanned} changed=${batch.changed} written=${batch.written}`
    );
    trackEvent("product_price_backfill.batch", {
      dryRun: String(parsed.dryRun),
      scanned: String(batch.scanned),
      changed: String(batch.changed),
      written: String(batch.written),
    });
    return { status: 200, jsonBody: response };
  } catch (error) {
    return internalServerError(context, error, "Product price backfill batch failed", "products-admin.price-backfill");
  }
}

app.http("admin-product-text-backfill", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "products-admin/text/backfill",
  handler: withCors(withAdmin(async (request, context) => backfillProductText(request, context))),
});

app.http("admin-finish-fill-backfill", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "shades-admin/finishes/backfill",
  handler: withCors(withAdmin(async (request, context) => backfillShadeFinishes(request, context))),
});

app.http("admin-product-price-backfill", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "products-admin/price/backfill",
  handler: withCors(withAdmin(async (request, context) => backfillProductPrice(request, context))),
});
