import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import {
  colorDistance,
  resolveDisplayHexDetailed,
  resolveProductCategory,
  type ShadeReviewActionResponse,
  type ShadeReviewCandidatesResponse,
  type ShadeReviewHexes,
  type ShadeReviewItem,
  type ShadeReviewListResponse,
  type ShadeReviewMergeCandidate,
  type ShadeReviewMergeResponse,
  type ShadeReviewQueueState,
  type ShadeReviewStatus,
} from "swatchwatch-shared";
import { withAdmin } from "../lib/auth";
import { query, transaction } from "../lib/db";
import { withCors } from "../lib/http";
import { internalServerError } from "../lib/errors";
import { cacheDelete, cacheDeleteByPrefix } from "../lib/cache";
import { trackEvent } from "../lib/telemetry";
import { loadFinishCatalog } from "../lib/finishes";
import { toImageProxyUrl } from "../lib/image-proxy";
import { isCatalogStorageUrl } from "../lib/blob-storage";
import {
  approveShade,
  mergeShadeInto,
  parseApproveEdits,
  parseReviewNote,
  rejectShade,
  ShadeReviewError,
} from "../lib/shade-review";

/**
 * Admin review queue for `user_submitted` shades (#45). All routes are admin-only (`withAdmin`).
 *
 * GET  /api/shades-admin/review                    — paginated queue + fuzzy merge candidates
 * GET  /api/shades-admin/review/{id}/candidates    — re-rank / search merge candidates (`q`)
 * POST /api/shades-admin/review/{id}/approve       — promote to `active` (optional edits)
 * POST /api/shades-admin/review/{id}/merge         — fold into an active shade
 * POST /api/shades-admin/review/{id}/reject        — keep private to the submitter
 */

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const DEFAULT_LIST_CANDIDATES = 5;
const MAX_LIST_CANDIDATES = 10;
const DEFAULT_SEARCH_CANDIDATES = 10;
const MAX_SEARCH_CANDIDATES = 25;

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function parseShadeId(raw: unknown): number | null {
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  if (!/^\d{1,18}$/.test(text)) return null;
  const value = Number.parseInt(text, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

async function readJsonBody(request: HttpRequest): Promise<unknown> {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ShadeReviewError(400, "Request body must be valid JSON");
  }
}

function toIso(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

function toNumberOrNull(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

interface HexRow {
  vendorHex: string | null;
  detectedHex: string | null;
  nameHex: string | null;
  hexAgreement: number | null;
}

function hexes(row: HexRow): ShadeReviewHexes {
  const resolution = resolveDisplayHexDetailed({
    vendorHex: row.vendorHex ?? undefined,
    detectedHex: row.detectedHex ?? undefined,
    nameHex: row.nameHex ?? undefined,
    hexAgreement: row.hexAgreement,
  });
  return {
    vendorHex: row.vendorHex ?? null,
    detectedHex: row.detectedHex ?? null,
    nameHex: row.nameHex ?? null,
    displayHex: resolution.hex ?? null,
    displaySource: resolution.source,
  };
}

/** Catalog (public) swatch blobs get a signed proxy URL; anything else is omitted (fail closed). */
function catalogSwatchUrl(storageUrl: string | null, requestUrl: string): string | null {
  if (!storageUrl) return null;
  try {
    return isCatalogStorageUrl(storageUrl) ? toImageProxyUrl(requestUrl, storageUrl) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Merge candidates (pg_trgm, same operators as catalog search)
// ---------------------------------------------------------------------------

interface CandidateRow extends HexRow {
  sourceShadeId: string;
  shadeId: string;
  brand: string;
  name: string;
  finishes: string[] | null;
  collection: string | null;
  colorName: string | null;
  sameBrand: boolean;
  nameSimilarity: number;
  similarity: number;
  inventoryCount: number;
  swatchStorageUrl: string | null;
}

/**
 * Best active-shade matches for each source shade. The match text is the submission's own name
 * (or `$2` when the admin searches); trigram (`%`) candidates come from the shade-name and alias
 * GIN indexes, ranked by 0.7 × best name/alias similarity + 0.3 × brand-name similarity.
 */
const CANDIDATES_SQL = `
  SELECT c.*,
         (SELECT count(*) FROM user_inventory_item ui WHERE ui.shade_id = c."shadeId"::bigint)::int AS "inventoryCount",
         swatch_img.storage_url AS "swatchStorageUrl"
  FROM shade src
  JOIN brand src_brand ON src_brand.brand_id = src.brand_id
  CROSS JOIN LATERAL (
    SELECT src.shade_id::text                      AS "sourceShadeId",
           s.shade_id::text                        AS "shadeId",
           b.name_canonical                        AS brand,
           s.shade_name_canonical                  AS name,
           COALESCE(s.finishes, ARRAY[]::text[])   AS finishes,
           s.collection,
           s.color_name                            AS "colorName",
           s.vendor_hex                            AS "vendorHex",
           s.detected_hex                          AS "detectedHex",
           s.name_hex                              AS "nameHex",
           s.hex_agreement::float8                 AS "hexAgreement",
           (s.brand_id = src.brand_id)             AS "sameBrand",
           sim.name_sim::float8                    AS "nameSimilarity",
           (0.7 * sim.name_sim + 0.3 * similarity(b.name_canonical, src_brand.name_canonical))::float8 AS similarity
    FROM (
      SELECT s0.shade_id FROM shade s0
      WHERE s0.shade_name_canonical % COALESCE($2::text, src.shade_name_canonical)
      UNION
      SELECT sa0.shade_id FROM shade_alias sa0
      WHERE sa0.alias % COALESCE($2::text, src.shade_name_canonical)
    ) matched
    JOIN shade s ON s.shade_id = matched.shade_id
    JOIN brand b ON b.brand_id = s.brand_id
    CROSS JOIN LATERAL (
      SELECT GREATEST(
        similarity(s.shade_name_canonical, COALESCE($2::text, src.shade_name_canonical)),
        COALESCE((
          SELECT max(similarity(sa.alias, COALESCE($2::text, src.shade_name_canonical)))
          FROM shade_alias sa WHERE sa.shade_id = s.shade_id
        ), 0)
      ) AS name_sim
    ) sim
    WHERE s.status = 'active'
      AND s.merged_into_shade_id IS NULL
      AND s.shade_id <> src.shade_id
    ORDER BY similarity DESC, s.shade_id ASC
    LIMIT $3
  ) c
  LEFT JOIN LATERAL (
    SELECT ia.storage_url
    FROM swatch sw
    JOIN image_asset ia ON ia.image_id = sw.image_id_original
    WHERE sw.shade_id = c."shadeId"::bigint
      AND ia.owner_type = 'source'
    ORDER BY COALESCE(sw.swatch_type = 'source_product', false) DESC, sw.swatch_id DESC
    LIMIT 1
  ) AS swatch_img ON true
  WHERE src.shade_id = ANY($1::bigint[])
  ORDER BY src.shade_id, c.similarity DESC, c."shadeId"::bigint ASC`;

async function loadCandidates(
  sources: Array<{ shadeId: string; displayHex: string | null }>,
  searchText: string | null,
  limit: number,
  requestUrl: string
): Promise<Map<string, ShadeReviewMergeCandidate[]>> {
  const bySource = new Map<string, ShadeReviewMergeCandidate[]>();
  if (sources.length === 0) return bySource;

  const displayHexBySource = new Map(sources.map((source) => [source.shadeId, source.displayHex]));
  const result = await query<CandidateRow>(CANDIDATES_SQL, [
    sources.map((source) => source.shadeId),
    searchText,
    limit,
  ]);

  for (const row of result.rows) {
    const candidateHexes = hexes(row);
    const sourceHex = displayHexBySource.get(row.sourceShadeId) ?? null;
    const distance =
      sourceHex && candidateHexes.displayHex
        ? Math.round(colorDistance(sourceHex, candidateHexes.displayHex) * 10_000) / 10_000
        : null;
    const candidate: ShadeReviewMergeCandidate = {
      shadeId: row.shadeId,
      brand: row.brand,
      name: row.name,
      finishes: row.finishes ?? [],
      collection: row.collection ?? null,
      colorName: row.colorName ?? null,
      ...candidateHexes,
      similarity: Math.round(Number(row.similarity) * 1000) / 1000,
      nameSimilarity: Math.round(Number(row.nameSimilarity) * 1000) / 1000,
      sameBrand: Boolean(row.sameBrand),
      colorDistance: Number.isFinite(distance) ? distance : null,
      inventoryCount: Number(row.inventoryCount) || 0,
      swatchImageUrl: catalogSwatchUrl(row.swatchStorageUrl, requestUrl),
    };
    const list = bySource.get(row.sourceShadeId) ?? [];
    list.push(candidate);
    bySource.set(row.sourceShadeId, list);
  }
  return bySource;
}

// ---------------------------------------------------------------------------
// Queue listing
// ---------------------------------------------------------------------------

interface QueueRow extends HexRow {
  shadeId: string;
  brandId: string;
  brand: string;
  name: string;
  finish: string | null;
  finishes: string[] | null;
  collection: string | null;
  colorName: string | null;
  createdAt: string | Date;
  createdByUserId: string | null;
  submitterCount: number;
  reviewStatus: ShadeReviewStatus | null;
  reviewedAt: string | Date | null;
  reviewedByUserId: string | null;
  reviewNote: string | null;
  productCategory: string | null;
}

const QUEUE_STATE_SQL: Record<ShadeReviewQueueState, string> = {
  pending: "s.review_status IS NULL",
  rejected: "s.review_status = 'rejected'",
};

/**
 * GET /api/shades-admin/review
 *
 * Query: `state` (`pending` default | `rejected`), `page` (1), `pageSize` (25, max 100),
 * `q` (brand/name substring), `candidates` (merge candidates per item, 5, max 10; 0 disables).
 * Oldest submissions first.
 */
async function listReviewQueue(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log("GET /api/shades-admin/review");
  const url = new URL(request.url);
  const stateParam = (url.searchParams.get("state") || "pending").trim().toLowerCase();
  if (stateParam !== "pending" && stateParam !== "rejected") {
    return { status: 400, jsonBody: { error: "state must be 'pending' or 'rejected'" } };
  }
  const state: ShadeReviewQueueState = stateParam;
  const page = clampInt(url.searchParams.get("page"), 1, 1, 100_000);
  const pageSize = clampInt(url.searchParams.get("pageSize"), DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
  const candidateLimit = clampInt(url.searchParams.get("candidates"), DEFAULT_LIST_CANDIDATES, 0, MAX_LIST_CANDIDATES);
  const search = url.searchParams.get("q")?.trim() || "";

  const conditions = ["s.status = 'user_submitted'", QUEUE_STATE_SQL[state]];
  const params: Array<string | number> = [];
  if (search) {
    params.push(`%${search.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
    conditions.push(`(b.name_canonical ILIKE $${params.length} OR s.shade_name_canonical ILIKE $${params.length})`);
  }
  const where = conditions.join(" AND ");

  try {
    const countResult = await query<{ total: string }>(
      `SELECT count(*)::text AS total
       FROM shade s
       JOIN brand b ON b.brand_id = s.brand_id
       WHERE ${where}`,
      params
    );

    const rowsResult = await query<QueueRow>(
      `SELECT
         s.shade_id::text                        AS "shadeId",
         s.brand_id::text                        AS "brandId",
         b.name_canonical                        AS brand,
         s.shade_name_canonical                  AS name,
         NULLIF(s.finish, '')                    AS finish,
         COALESCE(s.finishes, ARRAY[]::text[])   AS finishes,
         s.collection,
         s.color_name                            AS "colorName",
         s.vendor_hex                            AS "vendorHex",
         s.detected_hex                          AS "detectedHex",
         s.name_hex                              AS "nameHex",
         s.hex_agreement::float8                 AS "hexAgreement",
         s.created_at                            AS "createdAt",
         s.created_by_user_id::text              AS "createdByUserId",
         (SELECT count(DISTINCT ui.user_id) FROM user_inventory_item ui WHERE ui.shade_id = s.shade_id)::int
                                                 AS "submitterCount",
         s.review_status                         AS "reviewStatus",
         s.reviewed_at                           AS "reviewedAt",
         s.reviewed_by_user_id::text             AS "reviewedByUserId",
         s.review_note                           AS "reviewNote",
         s.product_category                      AS "productCategory"
       FROM shade s
       JOIN brand b ON b.brand_id = s.brand_id
       WHERE ${where}
       ORDER BY s.created_at ASC, s.shade_id ASC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize]
    );

    const items: ShadeReviewItem[] = rowsResult.rows.map((row) => ({
      shadeId: row.shadeId,
      brandId: row.brandId,
      brand: row.brand,
      name: row.name,
      finish: row.finish ?? null,
      finishes: row.finishes ?? [],
      collection: row.collection ?? null,
      colorName: row.colorName ?? null,
      ...hexes(row),
      createdAt: toIso(row.createdAt) ?? "",
      createdByUserId: toNumberOrNull(row.createdByUserId),
      submitterCount: Number(row.submitterCount) || 0,
      reviewStatus: row.reviewStatus ?? null,
      reviewedAt: toIso(row.reviewedAt),
      reviewedByUserId: toNumberOrNull(row.reviewedByUserId),
      reviewNote: row.reviewNote ?? null,
      productCategory: resolveProductCategory(row.productCategory),
      candidates: [],
    }));

    if (candidateLimit > 0 && items.length > 0) {
      const candidates = await loadCandidates(items, null, candidateLimit, request.url);
      for (const item of items) item.candidates = candidates.get(item.shadeId) ?? [];
    }

    const body: ShadeReviewListResponse = {
      items,
      total: Number.parseInt(countResult.rows[0]?.total ?? "0", 10) || 0,
      page,
      pageSize,
      state,
    };
    return { status: 200, jsonBody: body };
  } catch (error) {
    return handleError(context, error, "Failed to list shade review queue", "shade-review.list");
  }
}

/**
 * GET /api/shades-admin/review/{id}/candidates?q=&limit=
 *
 * Merge candidates for one submission. Without `q` they are ranked against the submission's
 * own name; with `q` the admin can search other active shades by name/alias.
 */
async function getCandidates(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log("GET /api/shades-admin/review/{id}/candidates");
  const shadeId = parseShadeId(request.params.id);
  if (!shadeId) {
    return { status: 400, jsonBody: { error: "Shade id must be a positive integer" } };
  }
  const url = new URL(request.url);
  const searchText = url.searchParams.get("q")?.trim() || null;
  const limit = clampInt(url.searchParams.get("limit"), DEFAULT_SEARCH_CANDIDATES, 1, MAX_SEARCH_CANDIDATES);

  try {
    const source = await query<HexRow & { shadeId: string }>(
      `SELECT shade_id::text AS "shadeId",
              vendor_hex AS "vendorHex",
              detected_hex AS "detectedHex",
              name_hex AS "nameHex",
              hex_agreement::float8 AS "hexAgreement"
       FROM shade
       WHERE shade_id = $1 AND status = 'user_submitted'`,
      [shadeId]
    );
    if (source.rows.length === 0) {
      return { status: 404, jsonBody: { error: "Shade not found in the review queue" } };
    }
    const sourceRow = source.rows[0];
    const candidates = await loadCandidates(
      [{ shadeId: sourceRow.shadeId, displayHex: hexes(sourceRow).displayHex }],
      searchText,
      limit,
      request.url
    );
    const body: ShadeReviewCandidatesResponse = {
      shadeId: sourceRow.shadeId,
      query: searchText,
      candidates: candidates.get(sourceRow.shadeId) ?? [],
    };
    return { status: 200, jsonBody: body };
  } catch (error) {
    return handleError(context, error, "Failed to load merge candidates", "shade-review.candidates");
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Polish/catalog cache prefixes, same keys as functions/polishes.ts and functions/catalog.ts. */
async function invalidateCaches(options: { userIds?: number[]; allUsers?: boolean; shadeIds: number[] }): Promise<void> {
  const tasks: Array<Promise<void>> = [
    cacheDeleteByPrefix("catalog:search:"),
    ...options.shadeIds.map((shadeId) => cacheDelete(`catalog:shade:id:${shadeId}`)),
  ];
  if (options.allUsers) {
    tasks.push(cacheDeleteByPrefix("polishes:list:u:"), cacheDeleteByPrefix("polishes:detail:u:"));
  } else {
    for (const userId of new Set(options.userIds ?? [])) {
      tasks.push(
        cacheDeleteByPrefix(`polishes:list:u:${userId}:`),
        ...options.shadeIds.map((shadeId) => cacheDeleteByPrefix(`polishes:detail:u:${userId}:id:${shadeId}:`))
      );
    }
  }
  await Promise.all(tasks);
}

async function createdByUserId(shadeId: number): Promise<number | null> {
  const result = await query<{ userId: string | null }>(
    `SELECT created_by_user_id::text AS "userId" FROM shade WHERE shade_id = $1`,
    [shadeId]
  );
  return toNumberOrNull(result.rows[0]?.userId);
}

/** POST /api/shades-admin/review/{id}/approve — body: ShadeReviewApproveRequest (all optional). */
async function approve(request: HttpRequest, context: InvocationContext, adminUserId: number): Promise<HttpResponseInit> {
  context.log("POST /api/shades-admin/review/{id}/approve");
  const shadeId = parseShadeId(request.params.id);
  if (!shadeId) {
    return { status: 400, jsonBody: { error: "Shade id must be a positive integer" } };
  }
  try {
    const body = await readJsonBody(request);
    const edits = parseApproveEdits(body, await loadFinishCatalog());
    const outcome = await transaction((client) => approveShade(client, shadeId, edits, adminUserId));
    // Newly public: every user's catalog-scope polish list may now include it.
    await invalidateCaches({ allUsers: true, shadeIds: [shadeId] });
    const edited = Object.entries(edits).some(([key, value]) => key !== "note" && value !== undefined);
    trackEvent("shade-review.approve", { shadeId, adminUserId, edited });
    const response: ShadeReviewActionResponse = {
      shadeId: String(shadeId),
      status: "active",
      reviewStatus: "approved",
      reviewedAt: outcome.reviewedAt,
      reviewedByUserId: adminUserId,
      message: `Shade ${shadeId} approved`,
    };
    return { status: 200, jsonBody: response };
  } catch (error) {
    return handleError(context, error, "Failed to approve shade", "shade-review.approve");
  }
}

/** POST /api/shades-admin/review/{id}/merge — body: ShadeReviewMergeRequest. */
async function merge(request: HttpRequest, context: InvocationContext, adminUserId: number): Promise<HttpResponseInit> {
  context.log("POST /api/shades-admin/review/{id}/merge");
  const shadeId = parseShadeId(request.params.id);
  if (!shadeId) {
    return { status: 400, jsonBody: { error: "Shade id must be a positive integer" } };
  }
  try {
    const body = (await readJsonBody(request)) as Record<string, unknown> | null;
    const targetShadeId = parseShadeId(body?.targetShadeId);
    if (!targetShadeId) {
      return { status: 400, jsonBody: { error: "targetShadeId must be a positive integer" } };
    }
    if (body?.keepNameAsAlias !== undefined && typeof body.keepNameAsAlias !== "boolean") {
      return { status: 400, jsonBody: { error: "keepNameAsAlias must be a boolean" } };
    }
    const note = parseReviewNote(body?.note);
    const creatorId = await createdByUserId(shadeId);

    const outcome = await transaction((client) =>
      mergeShadeInto(client, {
        sourceShadeId: shadeId,
        targetShadeId,
        adminUserId,
        keepNameAsAlias: body?.keepNameAsAlias as boolean | undefined,
        note,
      })
    );

    await invalidateCaches({
      userIds: [...outcome.affectedUserIds, ...(creatorId ? [creatorId] : [])],
      shadeIds: [shadeId, targetShadeId],
    });
    trackEvent("shade-review.merge", {
      shadeId,
      targetShadeId,
      adminUserId,
      movedInventoryRows: outcome.movedInventoryRows,
      combinedInventoryRows: outcome.combinedInventoryRows,
    });
    const response: ShadeReviewMergeResponse = {
      shadeId: String(shadeId),
      status: "user_submitted",
      reviewStatus: "merged",
      reviewedAt: outcome.reviewedAt,
      reviewedByUserId: adminUserId,
      targetShadeId: String(targetShadeId),
      movedInventoryRows: outcome.movedInventoryRows,
      combinedInventoryRows: outcome.combinedInventoryRows,
      affectedUserCount: outcome.affectedUserIds.length,
      copiedAliasRows: outcome.copiedAliasRows,
      movedSkuRows: outcome.movedSkuRows,
      movedSwatchRows: outcome.movedSwatchRows,
      message: `Merged shade ${shadeId} into ${targetShadeId}`,
    };
    return { status: 200, jsonBody: response };
  } catch (error) {
    return handleError(context, error, "Failed to merge shade", "shade-review.merge");
  }
}

/** POST /api/shades-admin/review/{id}/reject — body: { note? }. The shade stays private. */
async function reject(request: HttpRequest, context: InvocationContext, adminUserId: number): Promise<HttpResponseInit> {
  context.log("POST /api/shades-admin/review/{id}/reject");
  const shadeId = parseShadeId(request.params.id);
  if (!shadeId) {
    return { status: 400, jsonBody: { error: "Shade id must be a positive integer" } };
  }
  try {
    const body = (await readJsonBody(request)) as Record<string, unknown> | null;
    const note = parseReviewNote(body?.note);
    const outcome = await transaction((client) => rejectShade(client, shadeId, adminUserId, note));
    trackEvent("shade-review.reject", { shadeId, adminUserId });
    const response: ShadeReviewActionResponse = {
      shadeId: String(shadeId),
      status: "user_submitted",
      reviewStatus: "rejected",
      reviewedAt: outcome.reviewedAt,
      reviewedByUserId: adminUserId,
      message: `Shade ${shadeId} rejected; it stays private to its submitter`,
    };
    return { status: 200, jsonBody: response };
  } catch (error) {
    return handleError(context, error, "Failed to reject shade", "shade-review.reject");
  }
}

function handleError(context: InvocationContext, error: unknown, message: string, handler: string): HttpResponseInit {
  if (error instanceof ShadeReviewError) {
    return { status: error.status, jsonBody: { error: error.message, ...(error.details ?? {}) } };
  }
  const code = (error as { code?: string } | null)?.code;
  if (code === "23505") {
    // A user added the target concurrently; the transaction rolled back and can be retried.
    return { status: 409, jsonBody: { error: "Inventory changed during the merge; please retry" } };
  }
  if (code === "42703" || code === "42P01") {
    return { status: 503, jsonBody: { error: "Shade review migration is not applied yet" } };
  }
  return internalServerError(context, error, message, handler);
}

app.http("admin-shade-review-list", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "shades-admin/review",
  handler: withCors(withAdmin(async (request, context) => listReviewQueue(request, context))),
});

app.http("admin-shade-review-candidates", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "shades-admin/review/{id}/candidates",
  handler: withCors(withAdmin(async (request, context) => getCandidates(request, context))),
});

app.http("admin-shade-review-approve", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "shades-admin/review/{id}/approve",
  handler: withCors(withAdmin(approve)),
});

app.http("admin-shade-review-merge", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "shades-admin/review/{id}/merge",
  handler: withCors(withAdmin(merge)),
});

app.http("admin-shade-review-reject", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "shades-admin/review/{id}/reject",
  handler: withCors(withAdmin(reject)),
});
