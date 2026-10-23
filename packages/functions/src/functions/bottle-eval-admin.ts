import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { PoolClient } from "pg";
import {
  BOTTLE_EVAL_MAX_FRAMES,
  BOTTLE_SURFACE_FRAME_TYPE,
  BottleEvalValidationError,
  validateBottleEvalSampleInput,
  type BottleEvalFrameAddResponse,
  type BottleEvalSample,
  type BottleEvalSampleInput,
  type BottleEvalSampleListResponse,
  type BottleEvalSampleResponse,
} from "swatchwatch-shared";
import { query, transaction } from "../lib/db";
import { withAdmin } from "../lib/auth";
import { withCors } from "../lib/http";
import { internalServerError } from "../lib/errors";
import { deleteBlobFromStorageUrl, uploadBytesToBlob, userMediaContainer } from "../lib/blob-storage";
import { toImageProxyUrl } from "../lib/image-proxy";
import { NailPhotoInputError, normalizeNailPhoto, parseNailPhotoDataUrl } from "../lib/nail-photo-image";
import {
  BottleEvalQueryError,
  bottleEvalBlobName,
  COUNT_SAMPLES_SQL,
  DELETE_FRAME_IMAGES_SQL,
  DELETE_FRAME_SQL,
  DELETE_SAMPLE_FRAMES_SQL,
  DELETE_SAMPLE_SQL,
  INSERT_FRAME_IMAGE_SQL,
  INSERT_FRAME_SQL,
  INSERT_SAMPLE_SQL,
  isBottleEvalStorageUrl,
  LIST_SAMPLES_SQL,
  LOCK_SAMPLE_SQL,
  parseBottleEvalId,
  parseListQuery,
  readBottleEvalFrameBody,
  SELECT_FRAME_POSITION_SQL,
  SELECT_FRAMES_SQL,
  SELECT_SAMPLE_FRAME_COUNT_SQL,
  SELECT_SAMPLE_SQL,
  SELECT_SHADE_FOR_SAMPLE_SQL,
  toBottleEvalSamples,
  type FrameRow,
  type SampleRow,
} from "../lib/bottle-eval";
import { trackEvent, trackException } from "../lib/telemetry";

/**
 * Admin bottle eval samples (Slice 0 of bottle recognition, spec
 * docs/superpowers/specs/2026-10-23-bottle-recognition-design.md §8):
 *
 *   GET    /api/bottle-eval-admin/samples?after=&limit=           → BottleEvalSampleListResponse
 *   POST   /api/bottle-eval-admin/samples                         → 201 { sample }
 *   DELETE /api/bottle-eval-admin/samples/{id}                    → 204 (idempotent)
 *   POST   /api/bottle-eval-admin/samples/{id}/frames             → 201 { sample, frameId }
 *   DELETE /api/bottle-eval-admin/samples/{id}/frames/{frameId}   → 204 (idempotent)
 *
 * All admin-only (`withAdmin`). Samples are shared ground truth: any admin may list, create and
 * delete any sample. Frames are re-encoded by the nail-photo sanitizer (EXIF/GPS removed), stored
 * in USER_MEDIA_CONTAINER under `{adminUserId}/bottle-eval/{sampleId}/` as private `image_asset`
 * rows owned by the uploading admin, and only that admin gets a (`v3`, owner-scoped) image URL;
 * everyone else sees `imageUrl: null`. Responses are `Cache-Control: private, no-store`.
 */

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" };

class SampleNotFoundError extends Error {
  constructor() {
    super("Sample not found");
    this.name = "SampleNotFoundError";
  }
}

class FrameCapError extends Error {
  constructor() {
    super(`A sample holds at most ${BOTTLE_EVAL_MAX_FRAMES} frames`);
    this.name = "FrameCapError";
  }
}

type Runner = Pick<PoolClient, "query">;
type Mint = (storageUrl: string, ownerId: number) => string | null;

function badRequest(error: string): HttpResponseInit {
  return { status: 400, headers: NO_STORE_HEADERS, jsonBody: { error } };
}

function sampleNotFound(): HttpResponseInit {
  return { status: 404, headers: NO_STORE_HEADERS, jsonBody: { error: "Sample not found" } };
}

function frameCapReached(): HttpResponseInit {
  return { status: 409, headers: NO_STORE_HEADERS, jsonBody: { error: new FrameCapError().message } };
}

function sampleResponse(status: number, sample: BottleEvalSample): HttpResponseInit {
  const body: BottleEvalSampleResponse = { sample };
  return { status, headers: NO_STORE_HEADERS, jsonBody: body };
}

/**
 * Image URL minting for the caller: an owner-scoped `v3` id for frames the caller uploaded and
 * that live under its bottle-eval prefix in the user-media container; null for anything else
 * (another admin's frame, an unexpected location, or a signing failure).
 */
function frameUrlMinter(requestUrl: string, callerId: number, context: InvocationContext): Mint {
  return (storageUrl, ownerId) => {
    if (ownerId !== callerId) return null;
    if (!isBottleEvalStorageUrl(storageUrl, ownerId)) {
      context.warn("[bottle-eval-admin] Frame is outside the caller's bottle-eval prefix; omitting its URL");
      return null;
    }
    try {
      return toImageProxyUrl(requestUrl, storageUrl, { ownerUserId: ownerId });
    } catch (error) {
      context.error(
        `[bottle-eval-admin] Omitting frame URL: failed to build signed image proxy URL (${
          error instanceof Error ? error.message : String(error)
        })`
      );
      return null;
    }
  };
}

async function loadSample(runner: Runner, sampleId: number, mint: Mint): Promise<BottleEvalSample | null> {
  const rows = await runner.query<SampleRow>(SELECT_SAMPLE_SQL, [sampleId]);
  if (rows.rows.length === 0) return null;
  const frames = await runner.query<FrameRow>(SELECT_FRAMES_SQL, [[String(sampleId)]]);
  return toBottleEvalSamples(rows.rows, frames.rows, mint)[0] ?? null;
}

/**
 * Best-effort delete of frame blobs once their rows are gone (or were never written). Only blobs
 * under the owner's bottle-eval prefix in the user-media container are targeted; failures are
 * logged and reported, never thrown (the rows are gone, so no URL can be minted for them).
 */
async function deleteFrameBlobs(
  blobs: ReadonlyArray<{ storageUrl: string; ownerId: number }>,
  context: InvocationContext
): Promise<void> {
  for (const { storageUrl, ownerId } of blobs) {
    if (!isBottleEvalStorageUrl(storageUrl, ownerId)) {
      context.warn("[bottle-eval-admin] Not deleting a frame blob outside its owner's bottle-eval prefix");
      continue;
    }
    try {
      await deleteBlobFromStorageUrl(storageUrl, { allowedContainers: [userMediaContainer()] });
    } catch (error) {
      context.warn(
        `[bottle-eval-admin] Failed to delete frame blob: ${error instanceof Error ? error.message : String(error)}`
      );
      trackEvent("bottle_eval.blob_delete_failed");
      trackException(error, { area: "bottle-eval-admin", stage: "blob_delete" });
    }
  }
}

function toBlobRefs(rows: Array<{ storageUrl: string; ownerId: string }>): Array<{ storageUrl: string; ownerId: number }> {
  return rows
    .filter((row) => typeof row.storageUrl === "string" && row.storageUrl.length > 0)
    .map((row) => ({ storageUrl: row.storageUrl, ownerId: Number(row.ownerId) }));
}

async function listBottleEvalSamples(
  request: HttpRequest,
  context: InvocationContext,
  adminUserId: number
): Promise<HttpResponseInit> {
  let after: number | null;
  let limit: number;
  try {
    ({ after, limit } = parseListQuery(new URL(request.url)));
  } catch (error) {
    if (error instanceof BottleEvalQueryError) return badRequest(error.message);
    throw error;
  }

  try {
    const listed = await query<SampleRow>(LIST_SAMPLES_SQL, [after, limit + 1]);
    const page = listed.rows.slice(0, limit);
    const total = await query<{ total: number }>(COUNT_SAMPLES_SQL);
    const frames =
      page.length > 0
        ? (await query<FrameRow>(SELECT_FRAMES_SQL, [page.map((row) => row.sampleId)])).rows
        : [];
    const body: BottleEvalSampleListResponse = {
      samples: toBottleEvalSamples(page, frames, frameUrlMinter(request.url, adminUserId, context)),
      total: Number(total.rows[0]?.total ?? 0),
      nextCursor: listed.rows.length > limit && page.length > 0 ? page[page.length - 1].sampleId : null,
    };
    return { status: 200, headers: NO_STORE_HEADERS, jsonBody: body };
  } catch (error) {
    return internalServerError(context, error, "Failed to list bottle eval samples", "bottle-eval-admin.list");
  }
}

async function createBottleEvalSample(
  request: HttpRequest,
  context: InvocationContext,
  adminUserId: number
): Promise<HttpResponseInit> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return badRequest("Request body must be JSON");
  }
  let input: BottleEvalSampleInput;
  try {
    input = validateBottleEvalSampleInput(raw);
  } catch (error) {
    if (error instanceof BottleEvalValidationError) return badRequest(error.message);
    throw error;
  }

  try {
    let shadeId: number | null = null;
    let brand: string;
    let shadeName: string;
    if (input.kind === "catalog") {
      shadeId = parseBottleEvalId(input.shadeId);
      if (shadeId === null) return badRequest("shadeId must be a positive integer id");
      const shade = await query<{ shadeId: string; brand: string; shadeName: string; merged: boolean }>(
        SELECT_SHADE_FOR_SAMPLE_SQL,
        [shadeId]
      );
      const row = shade.rows[0];
      if (!row || row.merged === true) {
        return { status: 404, headers: NO_STORE_HEADERS, jsonBody: { error: "Shade not found" } };
      }
      brand = row.brand;
      shadeName = row.shadeName;
    } else {
      brand = input.brandText;
      shadeName = input.shadeText;
    }

    // Catalog samples keep the names as a snapshot too, so a later rename or shade delete keeps the label.
    const inserted = await query<{ sampleId: string; createdAt: string | Date }>(INSERT_SAMPLE_SQL, [
      shadeId,
      brand,
      shadeName,
      input.notes,
      adminUserId,
    ]);
    const created = inserted.rows[0];
    const [sample] = toBottleEvalSamples(
      [
        {
          sampleId: created.sampleId,
          shadeId: shadeId === null ? null : String(shadeId),
          brand,
          shadeName,
          notes: input.notes,
          createdByUserId: String(adminUserId),
          createdAt: created.createdAt,
        },
      ],
      [],
      () => null
    );
    trackEvent("bottle_eval.sample_created", { inCatalog: sample.inCatalog });
    return sampleResponse(201, sample);
  } catch (error) {
    return internalServerError(context, error, "Failed to create bottle eval sample", "bottle-eval-admin.create");
  }
}

async function deleteBottleEvalSample(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  const sampleId = parseBottleEvalId(request.params.id);
  if (sampleId === null) return badRequest("Invalid sample id");

  try {
    const removed = await transaction(async (client) => {
      const locked = await client.query(LOCK_SAMPLE_SQL, [sampleId]);
      if (locked.rows.length === 0) return null;
      const frames = await client.query<{ imageId: string }>(DELETE_SAMPLE_FRAMES_SQL, [sampleId]);
      const imageIds = frames.rows.map((row) => row.imageId);
      const images =
        imageIds.length > 0
          ? await client.query<{ storageUrl: string; ownerId: string }>(DELETE_FRAME_IMAGES_SQL, [imageIds])
          : { rows: [] as Array<{ storageUrl: string; ownerId: string }> };
      await client.query(DELETE_SAMPLE_SQL, [sampleId]);
      return images.rows;
    });

    if (removed) {
      await deleteFrameBlobs(toBlobRefs(removed), context);
      trackEvent("bottle_eval.sample_deleted", { frames: removed.length });
    }
    return { status: 204, headers: NO_STORE_HEADERS };
  } catch (error) {
    return internalServerError(context, error, "Failed to delete bottle eval sample", "bottle-eval-admin.delete");
  }
}

async function addBottleEvalFrame(
  request: HttpRequest,
  context: InvocationContext,
  adminUserId: number
): Promise<HttpResponseInit> {
  const sampleId = parseBottleEvalId(request.params.id);
  if (sampleId === null) return badRequest("Invalid sample id");

  const connectionString = process.env.AZURE_STORAGE_CONNECTION?.trim();
  if (!connectionString) {
    context.error("[bottle-eval-admin] AZURE_STORAGE_CONNECTION is not configured; cannot store frames");
    return { status: 503, headers: NO_STORE_HEADERS, jsonBody: { error: "Photo storage is not configured" } };
  }

  let uploadedStorageUrl: string | null = null;
  try {
    // Cheap checks first, so an unknown or full sample never reaches body parsing or decoding.
    const state = await query<{ sampleId: string; frameCount: number }>(SELECT_SAMPLE_FRAME_COUNT_SQL, [sampleId]);
    const current = state.rows[0];
    if (!current) return sampleNotFound();
    if (Number(current.frameCount) >= BOTTLE_EVAL_MAX_FRAMES) return frameCapReached();

    const body = await readBottleEvalFrameBody(request);
    const { bytes } = parseNailPhotoDataUrl(body.image);
    const photo = await normalizeNailPhoto(bytes);

    uploadedStorageUrl = await uploadBytesToBlob({
      connectionString,
      containerName: userMediaContainer(),
      blobName: bottleEvalBlobName(adminUserId, sampleId),
      bytes: photo.bytes,
      contentType: photo.contentType,
    });
    const storageUrl = uploadedStorageUrl;
    const frameType = BOTTLE_SURFACE_FRAME_TYPE[body.surface];

    const added = await transaction(async (client) => {
      // Lock the sample: concurrent uploads get distinct positions and the cap holds.
      const locked = await client.query(LOCK_SAMPLE_SQL, [sampleId]);
      if (locked.rows.length === 0) throw new SampleNotFoundError();
      const stats = await client.query<{ frameCount: number; maxPosition: number }>(SELECT_FRAME_POSITION_SQL, [
        sampleId,
      ]);
      const frameCount = Number(stats.rows[0]?.frameCount ?? 0);
      if (frameCount >= BOTTLE_EVAL_MAX_FRAMES) throw new FrameCapError();
      const position = Number(stats.rows[0]?.maxPosition ?? 0) + 1;

      const asset = await client.query<{ imageId: string }>(INSERT_FRAME_IMAGE_SQL, [
        adminUserId,
        storageUrl,
        photo.checksumSha256,
      ]);
      const inserted = await client.query<{ frameId: string }>(INSERT_FRAME_SQL, [
        sampleId,
        asset.rows[0].imageId,
        body.surface,
        frameType,
        position,
        photo.contentType,
        photo.width,
        photo.height,
        photo.bytes.length,
      ]);
      const loaded = await loadSample(client, sampleId, frameUrlMinter(request.url, adminUserId, context));
      return loaded ? { sample: loaded, frameId: inserted.rows[0].frameId } : null;
    });
    uploadedStorageUrl = null; // committed: the blob is now referenced
    if (!added) return sampleNotFound();

    trackEvent("bottle_eval.frame_added", {
      surface: body.surface,
      frameType,
      sizeBytes: photo.bytes.length,
      width: photo.width,
      height: photo.height,
    });
    const responseBody: BottleEvalFrameAddResponse = added;
    return { status: 201, headers: NO_STORE_HEADERS, jsonBody: responseBody };
  } catch (error) {
    if (uploadedStorageUrl) {
      // Not linked to anything: remove it so a failed upload leaves no private media behind.
      await deleteFrameBlobs([{ storageUrl: uploadedStorageUrl, ownerId: adminUserId }], context);
    }
    if (error instanceof SampleNotFoundError) return sampleNotFound();
    if (error instanceof FrameCapError) return frameCapReached();
    if (error instanceof NailPhotoInputError) {
      return { status: error.status, headers: NO_STORE_HEADERS, jsonBody: { error: error.message } };
    }
    return internalServerError(context, error, "Failed to save bottle eval frame", "bottle-eval-admin.add-frame");
  }
}

async function deleteBottleEvalFrame(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  const sampleId = parseBottleEvalId(request.params.id);
  const frameId = parseBottleEvalId(request.params.frameId);
  if (sampleId === null || frameId === null) return badRequest("Invalid sample or frame id");

  try {
    const removed = await transaction(async (client) => {
      const locked = await client.query(LOCK_SAMPLE_SQL, [sampleId]);
      if (locked.rows.length === 0) return [];
      const frame = await client.query<{ imageId: string }>(DELETE_FRAME_SQL, [sampleId, frameId]);
      if (frame.rows.length === 0) return [];
      const images = await client.query<{ storageUrl: string; ownerId: string }>(DELETE_FRAME_IMAGES_SQL, [
        frame.rows.map((row) => row.imageId),
      ]);
      return images.rows;
    });

    await deleteFrameBlobs(toBlobRefs(removed), context);
    return { status: 204, headers: NO_STORE_HEADERS };
  } catch (error) {
    return internalServerError(context, error, "Failed to delete bottle eval frame", "bottle-eval-admin.delete-frame");
  }
}

const methodNotAllowed: HttpResponseInit = { status: 405, jsonBody: { error: "Method not allowed" } };

app.http("bottle-eval-admin-samples", {
  methods: ["GET", "POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "bottle-eval-admin/samples",
  handler: withCors(
    withAdmin(async (request, context, adminUserId) => {
      switch (request.method?.toUpperCase()) {
        case "GET":
          return listBottleEvalSamples(request, context, adminUserId);
        case "POST":
          return createBottleEvalSample(request, context, adminUserId);
        default:
          return methodNotAllowed;
      }
    })
  ),
});

app.http("bottle-eval-admin-sample", {
  methods: ["DELETE", "OPTIONS"],
  authLevel: "anonymous",
  route: "bottle-eval-admin/samples/{id}",
  handler: withCors(withAdmin((request, context) => deleteBottleEvalSample(request, context))),
});

app.http("bottle-eval-admin-frames", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "bottle-eval-admin/samples/{id}/frames",
  handler: withCors(withAdmin(addBottleEvalFrame)),
});

app.http("bottle-eval-admin-frame", {
  methods: ["DELETE", "OPTIONS"],
  authLevel: "anonymous",
  route: "bottle-eval-admin/samples/{id}/frames/{frameId}",
  handler: withCors(withAdmin((request, context) => deleteBottleEvalFrame(request, context))),
});
