/**
 * CSV / spreadsheet import API (issue #263).
 *
 *   POST   /api/polish-imports               upload: parse + fuzzy-match → review session
 *   GET    /api/polish-imports/{id}          read the caller's session
 *   PATCH  /api/polish-imports/{id}          save review decisions
 *   DELETE /api/polish-imports/{id}          discard the session
 *   POST   /api/polish-imports/{id}/commit   apply (optional) decisions and upsert inventory
 *
 * Every route is `withAuth` and every `polish_import_session` statement filters on the
 * caller's user_id; another user's session is indistinguishable from a missing one (404).
 * Matching runs as a handful of batched pg_trgm queries for the whole sheet, never one per
 * row. Commit goes through the #261 inventory upsert (`upsertInventoryItem`), keyed on
 * (user_id, shade_id), so re-importing the same sheet updates rows instead of duplicating.
 */
import { randomUUID } from "node:crypto";
import { app, HttpRequest, HttpResponseInit, InvocationContext, Timer } from "@azure/functions";
import type { PoolClient } from "pg";
import {
  POLISH_IMPORT_MAX_BYTES,
  importMatchKey,
  resolveDisplayHex,
  type CsvDelimiter,
  type PolishImportColumnMapping,
  type PolishImportCommitResponse,
  type PolishImportCommitResult,
  type PolishImportCreateRequest,
  type PolishImportRow,
  type PolishImportSession,
  type PolishImportSessionStatus,
} from "swatchwatch-shared";
import { query, transaction } from "../lib/db";
import { withAuth } from "../lib/auth";
import { withCors } from "../lib/http";
import { internalServerError } from "../lib/errors";
import { trackEvent, trackException } from "../lib/telemetry";
import { loadFinishCatalog } from "../lib/finishes";
import {
  ImportRequestError,
  applyDecisions,
  buildImportRows,
  buildUpsertRequest,
  countRows,
  createKey,
  isExactHit,
  parseDecisions,
  scoreCandidate,
  withMatchResult,
  type CatalogHit,
  type ExistingInventory,
} from "../lib/polish-import";
import {
  findOrCreateShade,
  invalidateCatalogCaches,
  invalidatePolishCachesForUser,
  upsertInventoryItem,
} from "./polishes";

/** JSON escaping can roughly double the CSV size; leave headroom for the other fields. */
const MAX_REQUEST_BYTES = POLISH_IMPORT_MAX_BYTES * 2 + 64 * 1024;
const MAX_FILE_NAME_LENGTH = 255;
/** The caller keeps at most this many sessions; older ones are deleted on upload. */
const MAX_SESSIONS_PER_USER = 10;
/** Brand candidates per distinct sheet brand, and the similarity they need. */
const BRAND_CANDIDATES = 3;
const MIN_BRAND_SIMILARITY = 0.4;
const SHADE_HITS_PER_QUERY = 5;
/** Hourly, off the top of the hour. */
const CLEANUP_SCHEDULE = "0 23 * * * *";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Visibility of a shade to `$1` (same rule as POLISH_VISIBLE_SQL in polishes.ts). */
const SHADE_VISIBLE_SQL = `(s.status <> 'user_submitted' OR s.created_by_user_id = $1 OR ui.inventory_item_id IS NOT NULL)`;

interface StoredPayload {
  delimiter: CsvDelimiter;
  headers: string[];
  headerRowIndex: number;
  mapping: PolishImportColumnMapping;
  rows: PolishImportRow[];
}

interface SessionRow {
  id: string;
  fileName: string | null;
  status: PolishImportSessionStatus;
  payload: StoredPayload;
  result: PolishImportCommitResult | null;
  createdAt: Date | string;
  expiresAt: Date | string;
  committedAt: Date | string | null;
}

const SESSION_COLUMNS = `
  import_session_id::text AS id,
  file_name               AS "fileName",
  status,
  payload,
  result,
  created_at              AS "createdAt",
  expires_at              AS "expiresAt",
  committed_at            AS "committedAt"`;

const iso = (value: Date | string | null): string | null =>
  value === null ? null : value instanceof Date ? value.toISOString() : String(value);

function toSession(row: SessionRow): PolishImportSession {
  const payload = row.payload;
  return {
    id: row.id,
    fileName: row.fileName,
    status: row.status,
    delimiter: payload.delimiter,
    headers: payload.headers ?? [],
    headerRowIndex: payload.headerRowIndex,
    mapping: payload.mapping ?? {},
    rows: payload.rows ?? [],
    counts: countRows(payload.rows ?? []),
    createdAt: iso(row.createdAt) as string,
    expiresAt: iso(row.expiresAt) as string,
    committedAt: iso(row.committedAt),
    result: row.result ?? null,
  };
}

function sessionIdFrom(request: HttpRequest): string | null {
  const id = request.params.id;
  return id && UUID_RE.test(id) ? id.toLowerCase() : null;
}

async function readJsonBody(request: HttpRequest, maxBytes: number): Promise<unknown> {
  const contentLength = parseInt(request.headers.get("content-length") || "", 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new ImportRequestError("Request too large", 413);
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new ImportRequestError("Request body must be valid JSON");
  }
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new ImportRequestError("Request too large", 413);
  }
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new ImportRequestError("Request body must be valid JSON");
  }
}

function errorResponse(error: unknown): HttpResponseInit | null {
  if (error instanceof ImportRequestError) {
    return { status: error.status, jsonBody: { error: error.message } };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Matching (batched)
// ---------------------------------------------------------------------------

interface BrandCandidate {
  brandId: string;
  name: string;
  similarity: number;
}

interface ShadeHitRow {
  idx: number;
  shadeId: string;
  brandId: string;
  brand: string;
  name: string;
  finishes: string[] | null;
  vendorHex: string | null;
  detectedHex: string | null;
  nameHex: string | null;
  userSubmitted: boolean;
  inCollection: boolean;
  nameSimilarity: number;
}

const SHADE_HIT_COLUMNS = `
  s.shade_id::text AS "shadeId",
  s.brand_id::text AS "brandId",
  b.name_canonical AS brand,
  s.shade_name_canonical AS name,
  CASE WHEN cardinality(COALESCE(s.finishes, ARRAY[]::text[])) > 0 THEN s.finishes
       WHEN NULLIF(s.finish, '') IS NOT NULL THEN ARRAY[s.finish]
       ELSE ARRAY[]::text[] END AS finishes,
  s.vendor_hex AS "vendorHex",
  s.detected_hex AS "detectedHex",
  s.name_hex AS "nameHex",
  (s.status = 'user_submitted') AS "userSubmitted",
  (ui.inventory_item_id IS NOT NULL) AS "inCollection"`;

function shadeHitQuery(brandBound: boolean): string {
  const nameMatch = brandBound
    ? `(s.shade_name_canonical % i.q
          OR lower(s.shade_name_canonical) = lower(i.q)
          OR EXISTS (SELECT 1 FROM shade_alias sa
                     WHERE sa.shade_id = s.shade_id AND (sa.alias % i.q OR lower(sa.alias) = lower(i.q))))`
    : `s.shade_name_canonical % i.q`;
  const input = brandBound
    ? `unnest($2::int[], $3::bigint[], $4::text[]) AS i(idx, brand_id, q)`
    : `unnest($2::int[], $3::text[]) AS i(idx, q)`;
  return `
    SELECT i.idx::int AS idx, x.*
    FROM ${input}
    CROSS JOIN LATERAL (
      SELECT ${SHADE_HIT_COLUMNS},
             GREATEST(
               similarity(s.shade_name_canonical, i.q),
               COALESCE((SELECT MAX(similarity(sa.alias, i.q)) FROM shade_alias sa WHERE sa.shade_id = s.shade_id), 0)
             )::float8 AS "nameSimilarity"
      FROM shade s
      JOIN brand b ON b.brand_id = s.brand_id
      LEFT JOIN user_inventory_item ui ON ui.shade_id = s.shade_id AND ui.user_id = $1
      WHERE ${brandBound ? "s.brand_id = i.brand_id AND " : ""}${SHADE_VISIBLE_SQL}
        AND ${nameMatch}
      ORDER BY "nameSimilarity" DESC, s.shade_id
      LIMIT ${SHADE_HITS_PER_QUERY}
    ) x`;
}

function toHit(row: ShadeHitRow, brandSimilarity: number): CatalogHit {
  return {
    shadeId: row.shadeId,
    brand: row.brand,
    name: row.name,
    finishes: row.finishes ?? [],
    hex:
      resolveDisplayHex({
        vendorHex: row.vendorHex ?? undefined,
        detectedHex: row.detectedHex ?? undefined,
        nameHex: row.nameHex ?? undefined,
      }) ?? null,
    brandSimilarity,
    nameSimilarity: Number(row.nameSimilarity) || 0,
    inCollection: Boolean(row.inCollection),
    userSubmitted: Boolean(row.userSubmitted),
  };
}

/**
 * Fuzzy-match every valid row in at most three queries: candidate brands for each distinct
 * sheet brand, then shades of those brands (one lateral query over all rows × brands), then a
 * brand-less shade-name search for rows whose brand matched nothing.
 */
export async function matchImportRows(userId: number, rows: PolishImportRow[]): Promise<PolishImportRow[]> {
  const valid = rows.map((row, idx) => ({ row, idx })).filter(({ row }) => row.matchState !== "invalid");
  if (valid.length === 0) return rows;

  const brandInputs = [...new Set(valid.map(({ row }) => row.values.brand))];
  const brandResult = await query<{ ord: number; brandId: string; name: string; similarity: number }>(
    `SELECT i.ord::int AS ord, x."brandId", x.name, x.similarity
     FROM unnest($1::text[]) WITH ORDINALITY AS i(q, ord)
     CROSS JOIN LATERAL (
       SELECT b.brand_id::text AS "brandId",
              b.name_canonical AS name,
              GREATEST(
                similarity(b.name_canonical, i.q),
                COALESCE((SELECT MAX(similarity(ba.alias, i.q)) FROM brand_alias ba WHERE ba.brand_id = b.brand_id), 0),
                CASE WHEN lower(b.name_canonical) = lower(i.q) THEN 1 ELSE 0 END
              )::float8 AS similarity
       FROM brand b
       WHERE b.name_canonical % i.q
          OR lower(b.name_canonical) = lower(i.q)
          OR EXISTS (SELECT 1 FROM brand_alias ba
                     WHERE ba.brand_id = b.brand_id AND (ba.alias % i.q OR lower(ba.alias) = lower(i.q)))
       ORDER BY similarity DESC, b.brand_id
       LIMIT ${BRAND_CANDIDATES}
     ) x`,
    [brandInputs]
  );
  const brandsByInput = new Map<string, BrandCandidate[]>();
  for (const hit of brandResult.rows) {
    const input = brandInputs[Number(hit.ord) - 1];
    const similarity = importMatchKey(input) === importMatchKey(hit.name) ? 1 : Number(hit.similarity) || 0;
    if (similarity < MIN_BRAND_SIMILARITY) continue;
    const list = brandsByInput.get(input) ?? [];
    list.push({ brandId: String(hit.brandId), name: hit.name, similarity });
    brandsByInput.set(input, list);
  }

  const boundIdx: number[] = [];
  const boundBrand: string[] = [];
  const boundName: string[] = [];
  const looseIdx: number[] = [];
  const looseName: string[] = [];
  for (const { row, idx } of valid) {
    const brands = brandsByInput.get(row.values.brand) ?? [];
    if (brands.length === 0) {
      looseIdx.push(idx);
      looseName.push(row.values.name);
      continue;
    }
    for (const brand of brands) {
      boundIdx.push(idx);
      boundBrand.push(brand.brandId);
      boundName.push(row.values.name);
    }
  }

  const hitsByRow = new Map<number, CatalogHit[]>();
  const addHit = (idx: number, hit: CatalogHit) => {
    const list = hitsByRow.get(idx) ?? [];
    list.push(hit);
    hitsByRow.set(idx, list);
  };
  if (boundIdx.length > 0) {
    const bound = await query<ShadeHitRow>(shadeHitQuery(true), [userId, boundIdx, boundBrand, boundName]);
    for (const hit of bound.rows) {
      const brandSimilarity =
        brandsByInput.get(rows[hit.idx].values.brand)?.find((brand) => brand.brandId === String(hit.brandId))
          ?.similarity ?? 0;
      addHit(hit.idx, toHit(hit, brandSimilarity));
    }
  }
  if (looseIdx.length > 0) {
    const loose = await query<ShadeHitRow>(shadeHitQuery(false), [userId, looseIdx, looseName]);
    for (const hit of loose.rows) addHit(hit.idx, toHit(hit, 0));
  }

  return rows.map((row, idx) => withMatchResult(row, hitsByRow.get(idx) ?? []));
}

/**
 * Shades among `shadeIds` that the caller may use, with the candidate data the review table
 * shows and whether the caller already has an inventory row (and its tried_at) for each.
 */
async function loadVisibleShades(
  db: Pick<PoolClient, "query">,
  userId: number,
  shadeIds: string[]
): Promise<Map<string, CatalogHit & { triedAt: string | null }>> {
  const out = new Map<string, CatalogHit & { triedAt: string | null }>();
  if (shadeIds.length === 0) return out;
  const result = await db.query<ShadeHitRow & { triedAt: Date | string | null }>(
    `SELECT 0 AS idx, ${SHADE_HIT_COLUMNS}, 0::float8 AS "nameSimilarity", ui.tried_at AS "triedAt"
     FROM shade s
     JOIN brand b ON b.brand_id = s.brand_id
     LEFT JOIN user_inventory_item ui ON ui.shade_id = s.shade_id AND ui.user_id = $1
     WHERE s.shade_id = ANY($2::bigint[])
       AND ${SHADE_VISIBLE_SQL}`,
    [userId, shadeIds]
  );
  for (const row of result.rows) {
    out.set(String(row.shadeId), { ...toHit(row, 0), triedAt: iso(row.triedAt ?? null) });
  }
  return out;
}

/**
 * Apply review decisions to stored rows. A chosen shade that is not one of the row's
 * candidates (picked from catalog search) must be visible to the caller; it is appended to
 * the row's candidates so the review table can show it.
 */
async function applyReviewDecisions(
  db: Pick<PoolClient, "query">,
  userId: number,
  rows: PolishImportRow[],
  body: unknown
): Promise<PolishImportRow[]> {
  const decisions = parseDecisions(body);
  if (decisions.length === 0) return rows;
  const applied = applyDecisions(rows, decisions);
  if (applied.shadeIdsToVerify.length === 0) return applied.rows;

  const visible = await loadVisibleShades(db, userId, applied.shadeIdsToVerify);
  const missing = applied.shadeIdsToVerify.filter((id) => !visible.has(id));
  if (missing.length > 0) {
    throw new ImportRequestError(`Shade ${missing[0]} not found`, 404);
  }
  return applied.rows.map((row) => {
    if (row.action !== "match" || !row.shadeId) return row;
    if (row.candidates.some((candidate) => candidate.shadeId === row.shadeId)) return row;
    const hit = visible.get(row.shadeId);
    if (!hit) return row;
    return {
      ...row,
      candidates: [
        ...row.candidates,
        {
          shadeId: hit.shadeId,
          brand: hit.brand,
          name: hit.name,
          finishes: hit.finishes,
          hex: hit.hex,
          confidence: scoreCandidate(row.values, hit),
          inCollection: hit.inCollection,
          userSubmitted: hit.userSubmitted,
          exactMatch: isExactHit(row.values, hit),
        },
      ],
    };
  });
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function createImport(request: HttpRequest, context: InvocationContext, userId: number): Promise<HttpResponseInit> {
  context.log("POST /api/polish-imports");
  try {
    const startedAt = Date.now();
    const body = (await readJsonBody(request, MAX_REQUEST_BYTES)) as Partial<PolishImportCreateRequest> | undefined;
    if (!body || typeof body !== "object" || typeof body.csv !== "string") {
      return { status: 400, jsonBody: { error: "csv (the file's text) is required" } };
    }
    if (Buffer.byteLength(body.csv, "utf8") > POLISH_IMPORT_MAX_BYTES) {
      return { status: 413, jsonBody: { error: `File too large (max ${POLISH_IMPORT_MAX_BYTES / 1024} KB)` } };
    }
    if (body.fileName !== undefined && body.fileName !== null && typeof body.fileName !== "string") {
      return { status: 400, jsonBody: { error: "fileName must be a string" } };
    }
    if (body.mapping !== undefined && (typeof body.mapping !== "object" || body.mapping === null || Array.isArray(body.mapping))) {
      return { status: 400, jsonBody: { error: "mapping must be an object of field → column index" } };
    }
    if (body.headerRowIndex !== undefined && typeof body.headerRowIndex !== "number") {
      return { status: 400, jsonBody: { error: "headerRowIndex must be a number" } };
    }
    const fileName = body.fileName ? body.fileName.trim().slice(0, MAX_FILE_NAME_LENGTH) || null : null;

    const parsed = buildImportRows(body.csv, {
      mapping: body.mapping,
      headerRowIndex: body.headerRowIndex,
      finishCatalog: await loadFinishCatalog(),
    });
    const rows = await matchImportRows(userId, parsed.rows);
    const payload: StoredPayload = {
      delimiter: parsed.delimiter,
      headers: parsed.headers,
      headerRowIndex: parsed.headerRowIndex,
      mapping: parsed.mapping,
      rows,
    };

    // Keep the caller's session count bounded (their own rows only; the timer handles the rest).
    await query(
      `DELETE FROM polish_import_session
       WHERE user_id = $1
         AND (expires_at <= now()
              OR import_session_id IN (
                SELECT import_session_id FROM polish_import_session
                WHERE user_id = $1
                ORDER BY created_at DESC
                OFFSET $2))`,
      [userId, MAX_SESSIONS_PER_USER - 1]
    );
    const inserted = await query<SessionRow>(
      `INSERT INTO polish_import_session (import_session_id, user_id, file_name, row_count, payload)
       VALUES ($1::uuid, $2, $3, $4, $5::jsonb)
       RETURNING ${SESSION_COLUMNS}`,
      [randomUUID(), userId, fileName, rows.length, JSON.stringify(payload)]
    );
    const session = toSession(inserted.rows[0]);
    trackEvent("polish_import.parsed", {
      userId,
      rows: session.counts.total,
      matched: session.counts.matched,
      ambiguous: session.counts.ambiguous,
      unmatched: session.counts.unmatched,
      invalid: session.counts.invalid,
      detectedMapping: !body.mapping,
      durationMs: Date.now() - startedAt,
    });
    return { status: 201, jsonBody: session };
  } catch (error) {
    return errorResponse(error) ?? internalServerError(context, error, "Failed to import file", "polish-imports.create");
  }
}

async function getImport(request: HttpRequest, context: InvocationContext, userId: number): Promise<HttpResponseInit> {
  const id = sessionIdFrom(request);
  if (!id) return { status: 404, jsonBody: { error: "Import not found" } };
  try {
    const result = await query<SessionRow>(
      `SELECT ${SESSION_COLUMNS}
       FROM polish_import_session
       WHERE import_session_id = $1::uuid AND user_id = $2 AND expires_at > now()`,
      [id, userId]
    );
    if (result.rows.length === 0) return { status: 404, jsonBody: { error: "Import not found" } };
    return { status: 200, jsonBody: toSession(result.rows[0]) };
  } catch (error) {
    return internalServerError(context, error, "Failed to load import", "polish-imports.get");
  }
}

/** Lock the caller's live session inside a transaction. */
async function lockSession(client: PoolClient, id: string, userId: number): Promise<SessionRow | null> {
  const result = await client.query<SessionRow>(
    `SELECT ${SESSION_COLUMNS}
     FROM polish_import_session
     WHERE import_session_id = $1::uuid AND user_id = $2 AND expires_at > now()
     FOR UPDATE`,
    [id, userId]
  );
  return result.rows[0] ?? null;
}

async function patchImport(request: HttpRequest, context: InvocationContext, userId: number): Promise<HttpResponseInit> {
  const id = sessionIdFrom(request);
  if (!id) return { status: 404, jsonBody: { error: "Import not found" } };
  try {
    const body = await readJsonBody(request, MAX_REQUEST_BYTES);
    parseDecisions(body ?? { decisions: [] }); // shape errors → 400 before touching the DB
    const outcome = await transaction(async (client) => {
      const session = await lockSession(client, id, userId);
      if (!session) return { status: 404, jsonBody: { error: "Import not found" } } as HttpResponseInit;
      if (session.status !== "review") {
        return { status: 409, jsonBody: { error: "This import was already committed" } } as HttpResponseInit;
      }
      const rows = await applyReviewDecisions(client, userId, session.payload.rows, body);
      const payload: StoredPayload = { ...session.payload, rows };
      const updated = await client.query<SessionRow>(
        `UPDATE polish_import_session
         SET payload = $3::jsonb, updated_at = now()
         WHERE import_session_id = $1::uuid AND user_id = $2
         RETURNING ${SESSION_COLUMNS}`,
        [id, userId, JSON.stringify(payload)]
      );
      return { status: 200, jsonBody: toSession(updated.rows[0]) } as HttpResponseInit;
    });
    return outcome;
  } catch (error) {
    return errorResponse(error) ?? internalServerError(context, error, "Failed to save review", "polish-imports.patch");
  }
}

async function deleteImport(request: HttpRequest, context: InvocationContext, userId: number): Promise<HttpResponseInit> {
  const id = sessionIdFrom(request);
  if (!id) return { status: 404, jsonBody: { error: "Import not found" } };
  try {
    const result = await query(
      `DELETE FROM polish_import_session WHERE import_session_id = $1::uuid AND user_id = $2 RETURNING import_session_id`,
      [id, userId]
    );
    if (result.rows.length === 0) return { status: 404, jsonBody: { error: "Import not found" } };
    return { status: 200, jsonBody: { message: "Import discarded", id } };
  } catch (error) {
    return internalServerError(context, error, "Failed to discard import", "polish-imports.delete");
  }
}

interface CommitOutcome {
  response: HttpResponseInit;
  touchedShadeIds: number[];
}

/**
 * Commit the reviewed rows: one transaction, a savepoint per row (a failing row is reported
 * as `failed` and the rest still commit). Rows are applied in sheet order; a second row that
 * resolves to the same shade is skipped as a duplicate rather than overwriting the first.
 */
async function commitRows(
  client: PoolClient,
  userId: number,
  rows: PolishImportRow[],
  context: InvocationContext
): Promise<{ rows: PolishImportRow[]; result: PolishImportCommitResult; touchedShadeIds: number[] }> {
  const result: PolishImportCommitResult = { created: 0, updated: 0, skipped: 0, failed: 0, shadesCreated: 0 };
  const matchIds = [...new Set(rows.filter((row) => row.action === "match" && row.shadeId).map((row) => row.shadeId!))];
  const visible = await loadVisibleShades(client, userId, matchIds);
  const handledShades = new Map<string, number>(); // shade id → row number that wrote it
  const createdKeys = new Map<string, number>();
  const touched = new Set<number>();
  const now = new Date();

  const finish = (row: PolishImportRow, outcome: PolishImportRow["outcome"], message?: string): PolishImportRow => {
    if (outcome === "created" || outcome === "updated" || outcome === "skipped" || outcome === "failed") {
      result[outcome] += 1;
    }
    return { ...row, outcome, outcomeMessage: message };
  };

  const out: PolishImportRow[] = [];
  for (const row of rows) {
    if (row.matchState === "invalid") {
      out.push(finish(row, "skipped", row.errors.join("; ") || "Invalid row"));
      continue;
    }
    if (row.action === "pending") {
      out.push(finish(row, "skipped", "Not reviewed"));
      continue;
    }
    if (row.action === "skip") {
      out.push(finish(row, "skipped", "Skipped"));
      continue;
    }

    let shadeId: string | null = null;
    let existing: ExistingInventory = { inCollection: false, triedAt: null };
    if (row.action === "match") {
      const shade = row.shadeId ? visible.get(row.shadeId) : undefined;
      if (!shade) {
        out.push(finish(row, "failed", "Shade not found"));
        continue;
      }
      const earlier = handledShades.get(shade.shadeId);
      if (earlier !== undefined) {
        out.push(finish(row, "skipped", `Same polish as row ${earlier}`));
        continue;
      }
      shadeId = shade.shadeId;
      existing = { inCollection: shade.inCollection, triedAt: shade.triedAt };
    } else {
      const key = createKey(row.values);
      const earlier = createdKeys.get(key);
      if (earlier !== undefined) {
        out.push(finish(row, "skipped", `Same polish as row ${earlier}`));
        continue;
      }
      createdKeys.set(key, row.rowNumber);
    }

    await client.query("SAVEPOINT polish_import_row");
    try {
      let shadeCreated = false;
      if (row.action === "create") {
        // Reuse the catalog spelling of the brand when a candidate has the same brand.
        const brandKey = importMatchKey(row.values.brand);
        const brand = row.candidates.find((candidate) => importMatchKey(candidate.brand) === brandKey)?.brand ?? row.values.brand;
        const finishes = row.values.finishes;
        const created = await findOrCreateShade(
          client,
          userId,
          brand,
          row.values.name,
          finishes[0],
          undefined,
          undefined,
          finishes.length > 0 ? { mode: "replace", values: finishes } : undefined
        );
        shadeId = String(created);
        const earlier = handledShades.get(shadeId);
        if (earlier !== undefined) {
          await client.query("ROLLBACK TO SAVEPOINT polish_import_row");
          await client.query("RELEASE SAVEPOINT polish_import_row");
          out.push(finish(row, "skipped", `Same polish as row ${earlier}`));
          continue;
        }
        // A shade inserted by this transaction has created_at = now() (the transaction start).
        const state = await client.query<{ shadeCreated: boolean; inCollection: boolean; triedAt: Date | string | null }>(
          `SELECT (s.created_at = now() AND s.created_by_user_id = $1) AS "shadeCreated",
                  (ui.inventory_item_id IS NOT NULL) AS "inCollection",
                  ui.tried_at AS "triedAt"
           FROM shade s
           LEFT JOIN user_inventory_item ui ON ui.shade_id = s.shade_id AND ui.user_id = $1
           WHERE s.shade_id = $2`,
          [userId, shadeId]
        );
        const info = state.rows[0];
        shadeCreated = Boolean(info?.shadeCreated);
        existing = { inCollection: Boolean(info?.inCollection), triedAt: iso(info?.triedAt ?? null) };
      }

      const { body, fields } = buildUpsertRequest(row.values, existing, now);
      const inventoryItemId = await upsertInventoryItem(client, userId, Number(shadeId), body, fields);
      if (!inventoryItemId) throw new Error("Inventory upsert returned no row");
      await client.query("RELEASE SAVEPOINT polish_import_row");

      if (shadeCreated) result.shadesCreated += 1;
      handledShades.set(shadeId!, row.rowNumber);
      touched.add(Number(shadeId));
      out.push({
        ...finish(row, existing.inCollection ? "updated" : "created", shadeCreated ? "New private shade" : undefined),
        shadeId,
      });
    } catch (error) {
      await client.query("ROLLBACK TO SAVEPOINT polish_import_row");
      await client.query("RELEASE SAVEPOINT polish_import_row");
      context.warn(`polish import row ${row.rowNumber} failed`, error);
      trackException(error, { handler: "polish-imports.commit", rowNumber: row.rowNumber });
      out.push(finish(row, "failed", "Could not save this row"));
    }
  }
  return { rows: out, result, touchedShadeIds: [...touched] };
}

async function commitImport(request: HttpRequest, context: InvocationContext, userId: number): Promise<HttpResponseInit> {
  const id = sessionIdFrom(request);
  if (!id) return { status: 404, jsonBody: { error: "Import not found" } };
  try {
    const startedAt = Date.now();
    const body = await readJsonBody(request, MAX_REQUEST_BYTES);
    parseDecisions(body ?? { decisions: [] });
    const outcome = await transaction<CommitOutcome>(async (client) => {
      const session = await lockSession(client, id, userId);
      if (!session) return { response: { status: 404, jsonBody: { error: "Import not found" } }, touchedShadeIds: [] };
      if (session.status === "committed") {
        // Idempotent: a double-submitted commit returns the stored result instead of re-running.
        const stored = toSession(session);
        const response: PolishImportCommitResponse = {
          session: stored,
          result: stored.result ?? { created: 0, updated: 0, skipped: 0, failed: 0, shadesCreated: 0 },
          alreadyCommitted: true,
        };
        return { response: { status: 200, jsonBody: response }, touchedShadeIds: [] };
      }

      const reviewed = await applyReviewDecisions(client, userId, session.payload.rows, body);
      const committed = await commitRows(client, userId, reviewed, context);
      const payload: StoredPayload = { ...session.payload, rows: committed.rows };
      const updated = await client.query<SessionRow>(
        `UPDATE polish_import_session
         SET payload = $3::jsonb, result = $4::jsonb, status = 'committed',
             committed_at = now(), updated_at = now()
         WHERE import_session_id = $1::uuid AND user_id = $2
         RETURNING ${SESSION_COLUMNS}`,
        [id, userId, JSON.stringify(payload), JSON.stringify(committed.result)]
      );
      const response: PolishImportCommitResponse = {
        session: toSession(updated.rows[0]),
        result: committed.result,
        alreadyCommitted: false,
      };
      return { response: { status: 200, jsonBody: response }, touchedShadeIds: committed.touchedShadeIds };
    });

    if (outcome.touchedShadeIds.length > 0) {
      await Promise.all([
        invalidatePolishCachesForUser(userId, outcome.touchedShadeIds),
        invalidateCatalogCaches(outcome.touchedShadeIds),
      ]);
      const result = (outcome.response.jsonBody as PolishImportCommitResponse).result;
      trackEvent("polish_import.committed", { userId, ...result, durationMs: Date.now() - startedAt });
    }
    return outcome.response;
  } catch (error) {
    return errorResponse(error) ?? internalServerError(context, error, "Failed to commit import", "polish-imports.commit");
  }
}

/** Timer: delete expired sessions (all users; the API already hides them). */
export async function cleanupExpiredImportSessions(_timer: Timer, context: InvocationContext): Promise<void> {
  try {
    const result = await query(`DELETE FROM polish_import_session WHERE expires_at <= now()`);
    if (result.rowCount) context.log(`Deleted ${result.rowCount} expired polish import sessions`);
  } catch (error) {
    context.error("polish import session cleanup failed", error);
    trackException(error, { handler: "polish-imports.cleanup" });
  }
}

app.http("polish-imports-create", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "polish-imports",
  handler: withCors(withAuth(createImport)),
});

app.http("polish-imports-session", {
  methods: ["GET", "PATCH", "DELETE", "OPTIONS"],
  authLevel: "anonymous",
  route: "polish-imports/{id}",
  handler: withCors(
    withAuth(async (request, context, userId) => {
      const method = request.method?.toUpperCase();
      if (method === "GET") return getImport(request, context, userId);
      if (method === "PATCH") return patchImport(request, context, userId);
      if (method === "DELETE") return deleteImport(request, context, userId);
      return { status: 405, jsonBody: { error: "Method not allowed" } };
    })
  ),
});

app.http("polish-imports-commit", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "polish-imports/{id}/commit",
  handler: withCors(withAuth(commitImport)),
});

app.timer("polish-import-session-cleanup", {
  schedule: CLEANUP_SCHEDULE,
  runOnStartup: false,
  handler: cleanupExpiredImportSessions,
});
