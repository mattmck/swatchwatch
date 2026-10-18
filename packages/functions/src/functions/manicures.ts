/**
 * Mani log API (issue #269): `/api/manicures` CRUD for the caller's manicure history.
 *
 * Every statement is scoped to the authenticated user (`withAuth`); polishes can only be
 * referenced from the caller's own inventory and the optional photo must be an `image_asset`
 * the caller owns. Each write runs in one transaction that also recomputes the wear stats of the
 * affected inventory rows and resyncs their `inventory_event(used)` rows (see `lib/manicure.ts`).
 */
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type {
  Manicure,
  ManicureDeleteResponse,
  ManicureListResponse,
  ManicureMutationResponse,
  ManicurePolish,
  ManicurePolishRole,
  ManicureWearStat,
} from "swatchwatch-shared";
import type { PoolClient } from "pg";
import { query, transaction } from "../lib/db";
import { withAuth } from "../lib/auth";
import { withCors } from "../lib/http";
import { internalServerError } from "../lib/errors";
import { toImageProxyUrl } from "../lib/image-proxy";
import { isCatalogStorageUrl, isUserMediaStorageUrl } from "../lib/blob-storage";
import { invalidatePolishCachesForUser } from "../lib/polish-cache";
import { releaseManicurePhoto } from "../lib/manicure-photo";
import { deleteNailPhotoBlobs } from "../lib/nail-photos";
import { trackEvent } from "../lib/telemetry";
import {
  ManicureRequestError,
  lockInventoryRows,
  parseManicureBody,
  parseManicureListQuery,
  parsePositiveId,
  recomputeWearStats,
  replaceManicurePolishes,
  resolveManicurePolishes,
  syncManicureEvents,
} from "../lib/manicure";

interface ManicureRow {
  id: string;
  wornOn: string;
  notes: string | null;
  photoImageId: string | null;
  photoStorageUrl: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  totalCount?: string | number;
}

interface ManicurePolishRow {
  manicureId: string;
  shadeId: string;
  inventoryItemId: string | null;
  role: ManicurePolishRole;
  position: number;
  brand: string;
  name: string;
  vendorHex: string | null;
  detectedHex: string | null;
  nameHex: string | null;
}

/** `$1` = caller id. The photo is joined only when the caller owns its image_asset row. */
const MANICURE_SELECT = `
  SELECT m.manicure_id::text                AS id,
         to_char(m.worn_on, 'YYYY-MM-DD')   AS "wornOn",
         m.notes,
         m.photo_image_id::text             AS "photoImageId",
         ia.storage_url                     AS "photoStorageUrl",
         m.created_at                       AS "createdAt",
         m.updated_at                       AS "updatedAt"`;

const MANICURE_FROM = `
  FROM manicure m
  LEFT JOIN image_asset ia
    ON ia.image_id = m.photo_image_id
   AND ia.owner_type = 'user'
   AND ia.owner_id = m.user_id`;

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * Owner-scoped (`v3`) proxy URL for the caller's own photo. Only blobs in the user-media (or
 * catalog) container can be served, so anything else — or a signing failure — yields null
 * rather than a dead or leaked URL.
 */
function photoUrlFor(storageUrl: string | null, requestUrl: string, userId: number): string | null {
  if (!storageUrl) return null;
  try {
    if (!isUserMediaStorageUrl(storageUrl) && !isCatalogStorageUrl(storageUrl)) return null;
    return toImageProxyUrl(requestUrl, storageUrl, { ownerUserId: userId });
  } catch {
    return null;
  }
}

async function loadPolishes(userId: number, manicureIds: string[]): Promise<Map<string, ManicurePolish[]>> {
  const byManicure = new Map<string, ManicurePolish[]>();
  if (manicureIds.length === 0) return byManicure;
  const result = await query<ManicurePolishRow>(
    `SELECT mp.manicure_id::text        AS "manicureId",
            mp.shade_id::text           AS "shadeId",
            ui.inventory_item_id::text  AS "inventoryItemId",
            mp.role,
            mp.position,
            b.name_canonical            AS brand,
            s.shade_name_canonical      AS name,
            s.vendor_hex                AS "vendorHex",
            s.detected_hex              AS "detectedHex",
            s.name_hex                  AS "nameHex"
     FROM manicure_polish mp
     JOIN manicure m ON m.manicure_id = mp.manicure_id AND m.user_id = $1
     JOIN shade s ON s.shade_id = mp.shade_id
     JOIN brand b ON b.brand_id = s.brand_id
     LEFT JOIN user_inventory_item ui ON ui.user_id = $1 AND ui.shade_id = mp.shade_id
     WHERE mp.manicure_id = ANY($2::bigint[])
     ORDER BY mp.manicure_id, mp.position, mp.manicure_polish_id`,
    [userId, manicureIds]
  );
  for (const row of result.rows) {
    const list = byManicure.get(row.manicureId) ?? [];
    list.push({
      shadeId: row.shadeId,
      inventoryItemId: row.inventoryItemId,
      role: row.role,
      position: Number(row.position),
      brand: row.brand,
      name: row.name,
      vendorHex: row.vendorHex,
      detectedHex: row.detectedHex,
      nameHex: row.nameHex,
    });
    byManicure.set(row.manicureId, list);
  }
  return byManicure;
}

async function toManicures(rows: ManicureRow[], userId: number, requestUrl: string): Promise<Manicure[]> {
  const polishes = await loadPolishes(
    userId,
    rows.map((row) => row.id)
  );
  return rows.map((row) => ({
    id: row.id,
    wornOn: row.wornOn,
    notes: row.notes,
    photoImageId: row.photoImageId,
    photoUrl: photoUrlFor(row.photoStorageUrl, requestUrl, userId),
    polishes: polishes.get(row.id) ?? [],
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  }));
}

async function getManicureForUser(manicureId: number, userId: number, requestUrl: string): Promise<Manicure | null> {
  const result = await query<ManicureRow>(
    `${MANICURE_SELECT}
     ${MANICURE_FROM}
     WHERE m.manicure_id = $2 AND m.user_id = $1`,
    [userId, manicureId]
  );
  if (result.rows.length === 0) return null;
  const [manicure] = await toManicures(result.rows, userId, requestUrl);
  return manicure;
}

/** 404 unless `imageId` is an image_asset the caller owns (`owner_type = 'user'`). */
async function assertOwnedPhoto(client: PoolClient, userId: number, imageId: number): Promise<void> {
  const owned = await client.query(
    `SELECT 1
     FROM image_asset
     WHERE image_id = $1
       AND owner_type = 'user'
       AND owner_id = $2`,
    [imageId, userId]
  );
  if (owned.rows.length === 0) {
    throw new ManicureRequestError(404, "Photo not found");
  }
}

/** Current `photo_image_id` of a manicure already locked by `lockOwnManicure`. */
async function currentPhotoImageId(client: PoolClient, userId: number, manicureId: number): Promise<string | null> {
  const result = await client.query<{ photoImageId: string | null }>(
    `SELECT photo_image_id::text AS "photoImageId" FROM manicure WHERE manicure_id = $1 AND user_id = $2`,
    [manicureId, userId]
  );
  return result.rows[0]?.photoImageId ?? null;
}

/** Lock the caller's manicure and return its current shade ids; 404 when it is not theirs. */
async function lockOwnManicure(client: PoolClient, userId: number, manicureId: number): Promise<number[]> {
  const found = await client.query(
    `SELECT manicure_id FROM manicure WHERE manicure_id = $1 AND user_id = $2 FOR UPDATE`,
    [manicureId, userId]
  );
  if (found.rows.length === 0) {
    throw new ManicureRequestError(404, "Manicure not found");
  }
  const shades = await client.query<{ shadeId: string }>(
    `SELECT DISTINCT shade_id::text AS "shadeId" FROM manicure_polish WHERE manicure_id = $1`,
    [manicureId]
  );
  return shades.rows.map((row) => Number(row.shadeId));
}

function requestErrorResponse(error: ManicureRequestError): HttpResponseInit {
  return { status: error.status, jsonBody: { error: error.message } };
}

async function readJsonBody(request: HttpRequest): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ManicureRequestError(400, "Request body must be valid JSON");
  }
}

function parseIdParam(request: HttpRequest): number {
  const id = request.params.id;
  if (!id) throw new ManicureRequestError(400, "Manicure id is required");
  return parsePositiveId(id, "Manicure id");
}

async function getManicures(request: HttpRequest, context: InvocationContext, userId: number): Promise<HttpResponseInit> {
  try {
    if (request.params.id) {
      const manicureId = parseIdParam(request);
      const manicure = await getManicureForUser(manicureId, userId, request.url);
      if (!manicure) return { status: 404, jsonBody: { error: "Manicure not found" } };
      return { status: 200, jsonBody: manicure };
    }

    const filters = parseManicureListQuery(new URL(request.url).searchParams);
    const params = [
      userId,
      filters.from,
      filters.to,
      filters.shadeId,
      filters.pageSize,
      (filters.page - 1) * filters.pageSize,
    ];
    const where = `
      WHERE m.user_id = $1
        AND ($2::date IS NULL OR m.worn_on >= $2::date)
        AND ($3::date IS NULL OR m.worn_on <= $3::date)
        AND ($4::bigint IS NULL OR EXISTS (
              SELECT 1 FROM manicure_polish mpf
              WHERE mpf.manicure_id = m.manicure_id AND mpf.shade_id = $4::bigint))`;
    const result = await query<ManicureRow>(
      `${MANICURE_SELECT},
              COUNT(*) OVER() AS "totalCount"
       ${MANICURE_FROM}
       ${where}
       ORDER BY m.worn_on DESC, m.manicure_id DESC
       LIMIT $5 OFFSET $6`,
      params
    );

    let total: number;
    if (result.rows.length > 0) {
      total = Number(result.rows[0].totalCount ?? result.rows.length);
    } else if (filters.page === 1) {
      total = 0;
    } else {
      // Page past the end: the window count is unavailable, count explicitly.
      const count = await query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM manicure m ${where}`,
        params.slice(0, 4)
      );
      total = Number(count.rows[0]?.total ?? 0);
    }

    const body: ManicureListResponse = {
      manicures: await toManicures(result.rows, userId, request.url),
      total,
      page: filters.page,
      pageSize: filters.pageSize,
    };
    return { status: 200, jsonBody: body };
  } catch (error) {
    if (error instanceof ManicureRequestError) return requestErrorResponse(error);
    return internalServerError(context, error, "Failed to fetch manicures", "manicures.get");
  }
}

async function finishWrite(
  userId: number,
  wearStats: ManicureWearStat[],
  affectedShadeIds: number[]
): Promise<void> {
  await invalidatePolishCachesForUser(
    userId,
    Array.from(new Set([...affectedShadeIds, ...wearStats.map((stat) => Number(stat.shadeId))]))
  );
}

async function createManicure(request: HttpRequest, context: InvocationContext, userId: number): Promise<HttpResponseInit> {
  try {
    const body = parseManicureBody(await readJsonBody(request), "create");
    const polishRefs = body.polishes!;

    const { manicureId, wearStats, shadeIds } = await transaction(async (client) => {
      if (body.photoImageId) await assertOwnedPhoto(client, userId, body.photoImageId);
      const resolved = await resolveManicurePolishes(client, userId, polishRefs);
      const shadeIds = Array.from(new Set(resolved.map((p) => p.shadeId)));
      await lockInventoryRows(client, userId, shadeIds);

      const inserted = await client.query<{ manicureId: string }>(
        `INSERT INTO manicure (user_id, worn_on, notes, photo_image_id)
         VALUES ($1, $2::date, $3, $4)
         RETURNING manicure_id::text AS "manicureId"`,
        [userId, body.wornOn, body.notes ?? null, body.photoImageId ?? null]
      );
      const manicureId = Number(inserted.rows[0].manicureId);
      await replaceManicurePolishes(client, manicureId, resolved, { deleteExisting: false });
      await syncManicureEvents(client, userId, manicureId);
      const wearStats = await recomputeWearStats(client, userId, shadeIds);
      return { manicureId, wearStats, shadeIds };
    });

    await finishWrite(userId, wearStats, shadeIds);
    trackEvent("manicure.logged", {
      userId,
      polishCount: polishRefs.length,
      hasPhoto: Boolean(body.photoImageId),
      hasNotes: Boolean(body.notes),
    });

    const manicure = await getManicureForUser(manicureId, userId, request.url);
    if (!manicure) return { status: 500, jsonBody: { error: "Created manicure not found" } };
    const responseBody: ManicureMutationResponse = { ...manicure, wearStats };
    return { status: 201, jsonBody: responseBody };
  } catch (error) {
    if (error instanceof ManicureRequestError) return requestErrorResponse(error);
    return internalServerError(context, error, "Failed to log manicure", "manicures.create");
  }
}

async function updateManicure(request: HttpRequest, context: InvocationContext, userId: number): Promise<HttpResponseInit> {
  try {
    const manicureId = parseIdParam(request);
    const body = parseManicureBody(await readJsonBody(request), "update");

    const { wearStats, affected, releasedPhotoUrl } = await transaction(async (client) => {
      const previousShadeIds = await lockOwnManicure(client, userId, manicureId);
      if (body.photoImageId) await assertOwnedPhoto(client, userId, body.photoImageId);
      const previousPhotoImageId =
        body.photoImageId !== undefined ? await currentPhotoImageId(client, userId, manicureId) : null;

      const resolved = body.polishes
        ? await resolveManicurePolishes(client, userId, body.polishes, new Set(previousShadeIds))
        : undefined;
      const affected = Array.from(
        new Set([...previousShadeIds, ...(resolved ?? []).map((p) => p.shadeId)])
      );
      await lockInventoryRows(client, userId, affected);

      const provided: string[] = [];
      if (body.notes !== undefined) provided.push("notes");
      if (body.photoImageId !== undefined) provided.push("photoImageId");
      await client.query(
        `UPDATE manicure
         SET worn_on        = COALESCE($3::date, worn_on),
             notes          = CASE WHEN 'notes' = ANY($6::text[]) THEN $4 ELSE notes END,
             photo_image_id = CASE WHEN 'photoImageId' = ANY($6::text[]) THEN $5::bigint ELSE photo_image_id END,
             updated_at     = now()
         WHERE manicure_id = $1 AND user_id = $2`,
        [manicureId, userId, body.wornOn ?? null, body.notes ?? null, body.photoImageId ?? null, provided]
      );
      if (resolved) {
        await replaceManicurePolishes(client, manicureId, resolved, { deleteExisting: true });
      }
      await syncManicureEvents(client, userId, manicureId);
      const wearStats = await recomputeWearStats(client, userId, affected);
      const releasedPhotoUrl =
        previousPhotoImageId && previousPhotoImageId !== String(body.photoImageId ?? "")
          ? await releaseManicurePhoto(client, userId, previousPhotoImageId)
          : null;
      return { wearStats, affected, releasedPhotoUrl };
    });

    if (releasedPhotoUrl) await deleteNailPhotoBlobs([releasedPhotoUrl], context);
    await finishWrite(userId, wearStats, affected);
    trackEvent("manicure.updated", { userId, polishesReplaced: Boolean(body.polishes) });

    const manicure = await getManicureForUser(manicureId, userId, request.url);
    if (!manicure) return { status: 404, jsonBody: { error: "Manicure not found" } };
    const responseBody: ManicureMutationResponse = { ...manicure, wearStats };
    return { status: 200, jsonBody: responseBody };
  } catch (error) {
    if (error instanceof ManicureRequestError) return requestErrorResponse(error);
    return internalServerError(context, error, "Failed to update manicure", "manicures.update");
  }
}

async function deleteManicure(request: HttpRequest, context: InvocationContext, userId: number): Promise<HttpResponseInit> {
  try {
    const manicureId = parseIdParam(request);

    const { wearStats, affected, releasedPhotoUrl } = await transaction(async (client) => {
      const affected = await lockOwnManicure(client, userId, manicureId);
      const photoImageId = await currentPhotoImageId(client, userId, manicureId);
      await lockInventoryRows(client, userId, affected);
      // Cascades to manicure_polish and to the manicure's inventory_event rows.
      await client.query(`DELETE FROM manicure WHERE manicure_id = $1 AND user_id = $2`, [manicureId, userId]);
      const wearStats = await recomputeWearStats(client, userId, affected);
      // A photo uploaded for this mani (#327) goes with it; shared photos are kept.
      const releasedPhotoUrl = await releaseManicurePhoto(client, userId, photoImageId);
      return { wearStats, affected, releasedPhotoUrl };
    });

    if (releasedPhotoUrl) await deleteNailPhotoBlobs([releasedPhotoUrl], context);
    await finishWrite(userId, wearStats, affected);
    trackEvent("manicure.deleted", { userId });

    const responseBody: ManicureDeleteResponse = {
      message: "Manicure deleted",
      id: String(manicureId),
      wearStats,
    };
    return { status: 200, jsonBody: responseBody };
  } catch (error) {
    if (error instanceof ManicureRequestError) return requestErrorResponse(error);
    return internalServerError(context, error, "Failed to delete manicure", "manicures.delete");
  }
}

app.http("manicures-list", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "manicures/{id?}",
  handler: withCors(withAuth(getManicures)),
});

app.http("manicures-create", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "manicures",
  handler: withCors(withAuth(createManicure)),
});

app.http("manicures-mutate", {
  methods: ["PUT", "PATCH", "DELETE", "OPTIONS"],
  authLevel: "anonymous",
  route: "manicures/{id}",
  handler: withCors(
    withAuth(async (request, context, userId) => {
      if (request.method?.toUpperCase() === "DELETE") {
        return deleteManicure(request, context, userId);
      }
      return updateManicure(request, context, userId);
    })
  ),
});
