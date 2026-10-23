import type { HttpRequest } from "@azure/functions";
import { randomUUID } from "node:crypto";
import {
  BOTTLE_SURFACES,
  parseBottleSurface,
  type BottleEvalSample,
  type BottleSurface,
  type CaptureFrameType,
} from "swatchwatch-shared";
import { isUserMediaStorageUrl, storageUrlBlobName } from "./blob-storage";
import { NailPhotoInputError } from "./nail-photo-image";
import { readPhotoUploadBody } from "./nail-photo-upload";

/**
 * Admin bottle eval samples (`/api/bottle-eval-admin/*`, routes in functions/bottle-eval-admin.ts):
 * pure helpers and SQL text. A sample labels one bottle (a catalog shade, or brand + shade text);
 * its frames are private `image_asset` rows (owner_type 'user', owner = the admin who shot them)
 * in USER_MEDIA_CONTAINER under `{adminUserId}/bottle-eval/{sampleId}/`, linked through
 * `bottle_eval_frame` (the FK keeps the orphan-media sweep away). Never read by the live resolver.
 */

/** Default list page size (`?limit=`, clamped to 1–100). */
export const BOTTLE_EVAL_PAGE_SIZE = 25;
export const BOTTLE_EVAL_MAX_PAGE_SIZE = 100;

/** Positive integer id that fits a JS safe integer (so also a Postgres bigint), else null. */
export function parseBottleEvalId(value: unknown): number | null {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^\d{1,18}$/.test(text)) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Blob name for a new frame: `${adminUserId}/bottle-eval/${sampleId}/${uuid}.jpg` (never reused). */
export function bottleEvalBlobName(adminUserId: number, sampleId: number): string {
  return `${adminUserId}/bottle-eval/${sampleId}/${randomUUID()}.jpg`;
}

/** True when `storageUrl` is in the user-media container under `${adminUserId}/bottle-eval/`. */
export function isBottleEvalStorageUrl(storageUrl: string, adminUserId: number): boolean {
  if (!Number.isSafeInteger(adminUserId) || adminUserId <= 0) return false;
  try {
    return (
      isUserMediaStorageUrl(storageUrl) &&
      storageUrlBlobName(storageUrl).startsWith(`${adminUserId}/bottle-eval/`)
    );
  } catch {
    return false; // ImageProxyConfigError: misconfigured containers never qualify
  }
}

export interface ParsedFrameBody {
  surface: BottleSurface;
  image: string;
}

/**
 * Read a `POST …/frames` body `{ surface, image }`. Same Content-Length (411), size (413) and JSON
 * (400) rules as `readPhotoUploadBody`; an unknown `surface` or a non-string `image` is a 400
 * `NailPhotoInputError`. The image itself is validated later by `parseNailPhotoDataUrl`.
 */
export async function readBottleEvalFrameBody(request: HttpRequest): Promise<ParsedFrameBody> {
  const body = (await readPhotoUploadBody(request)) as unknown as Record<string, unknown>;
  const surface = parseBottleSurface(body.surface);
  if (!surface) {
    throw new NailPhotoInputError(`surface must be one of: ${BOTTLE_SURFACES.join(", ")}`);
  }
  if (typeof body.image !== "string" || body.image.length === 0) {
    throw new NailPhotoInputError("image must be a base64 data URL (data:image/jpeg;base64,...)");
  }
  return { surface, image: body.image };
}

/** A bad list query (`?after=`); the message is safe to return as a 400. */
export class BottleEvalQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BottleEvalQueryError";
  }
}

/** `?after=<sampleId>&limit=`: `after` must be a valid id when present; `limit` is clamped 1–100. */
export function parseListQuery(url: URL): { after: number | null; limit: number } {
  const rawAfter = url.searchParams.get("after");
  let after: number | null = null;
  if (rawAfter !== null && rawAfter.trim() !== "") {
    after = parseBottleEvalId(rawAfter);
    if (after === null) throw new BottleEvalQueryError("after must be a sample id");
  }
  const rawLimit = url.searchParams.get("limit");
  const parsedLimit = rawLimit !== null && /^-?\d+$/.test(rawLimit.trim()) ? Number(rawLimit.trim()) : NaN;
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(BOTTLE_EVAL_MAX_PAGE_SIZE, Math.max(1, parsedLimit))
    : BOTTLE_EVAL_PAGE_SIZE;
  return { after, limit };
}

export interface SampleRow {
  sampleId: string;
  shadeId: string | null;
  brand: string;
  shadeName: string;
  notes: string | null;
  createdByUserId: string;
  createdAt: string | Date;
}

export interface FrameRow {
  frameId: string;
  sampleId: string;
  surface: BottleSurface;
  frameType: CaptureFrameType;
  storageUrl: string;
  ownerId: string;
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
  createdAt: string | Date;
}

function toIso(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function toNullableInt(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/**
 * Rows → `BottleEvalSample[]` in the order of `rows`, each with its frames in the order of `frames`
 * (grouped by `sampleId`). `mint(storageUrl, ownerId)` returns the frame's image URL, or null for
 * frames the caller does not own.
 */
export function toBottleEvalSamples(
  rows: SampleRow[],
  frames: FrameRow[],
  mint: (storageUrl: string, ownerId: number) => string | null
): BottleEvalSample[] {
  const framesBySample = new Map<string, BottleEvalSample["frames"]>();
  for (const frame of frames) {
    const list = framesBySample.get(frame.sampleId) ?? [];
    list.push({
      frameId: frame.frameId,
      surface: frame.surface,
      frameType: frame.frameType,
      imageUrl: mint(frame.storageUrl, Number(frame.ownerId)),
      width: toNullableInt(frame.width),
      height: toNullableInt(frame.height),
      sizeBytes: toNullableInt(frame.sizeBytes),
      createdAt: toIso(frame.createdAt),
    });
    framesBySample.set(frame.sampleId, list);
  }
  return rows.map((row) => ({
    sampleId: row.sampleId,
    shadeId: row.shadeId ?? null,
    brand: row.brand,
    shadeName: row.shadeName,
    inCatalog: row.shadeId !== null && row.shadeId !== undefined,
    notes: row.notes ?? null,
    frames: framesBySample.get(row.sampleId) ?? [],
    createdByUserId: row.createdByUserId,
    createdAt: toIso(row.createdAt),
  }));
}

// ---------------------------------------------------------------------------
// SQL (every id bound as a bigint parameter)
// ---------------------------------------------------------------------------

/** Catalog shade for a new sample: names for the snapshot, and whether it was merged away. */
export const SELECT_SHADE_FOR_SAMPLE_SQL = `
  SELECT sh.shade_id::text AS "shadeId",
         b.name_canonical AS brand,
         sh.shade_name_canonical AS "shadeName",
         COALESCE(sh.review_status = 'merged' OR sh.merged_into_shade_id IS NOT NULL, false) AS merged
  FROM shade sh
  JOIN brand b ON b.brand_id = sh.brand_id
  WHERE sh.shade_id = $1::bigint`;

export const INSERT_SAMPLE_SQL = `
  INSERT INTO bottle_eval_sample (shade_id, brand_text, shade_text, notes, created_by_user_id)
  VALUES ($1::bigint, $2, $3, $4, $5::bigint)
  RETURNING sample_id::text AS "sampleId", created_at AS "createdAt"`;

/**
 * Catalog names win for catalog samples (the text columns are a snapshot); typed text otherwise.
 * Also read by the eval runner (`eval/bottle/samples.ts`).
 */
export const SAMPLE_COLUMNS_SQL = `
  SELECT s.sample_id::text AS "sampleId",
         s.shade_id::text AS "shadeId",
         COALESCE(b.name_canonical, s.brand_text, '') AS brand,
         COALESCE(sh.shade_name_canonical, s.shade_text, '') AS "shadeName",
         s.notes,
         s.created_by_user_id::text AS "createdByUserId",
         s.created_at AS "createdAt"
  FROM bottle_eval_sample s
  LEFT JOIN shade sh ON sh.shade_id = s.shade_id
  LEFT JOIN brand b ON b.brand_id = sh.brand_id`;

/** Newest first, keyset on sample_id: `$1` = after (or NULL), `$2` = page size + 1. */
export const LIST_SAMPLES_SQL = `${SAMPLE_COLUMNS_SQL}
  WHERE ($1::bigint IS NULL OR s.sample_id < $1::bigint)
  ORDER BY s.sample_id DESC
  LIMIT $2`;

export const SELECT_SAMPLE_SQL = `${SAMPLE_COLUMNS_SQL}
  WHERE s.sample_id = $1::bigint`;

export const COUNT_SAMPLES_SQL = `SELECT COUNT(*)::int AS total FROM bottle_eval_sample`;

/** Frames of the samples in `$1` (bigint[]), in shooting order. */
export const SELECT_FRAMES_SQL = `
  SELECT f.frame_id::text AS "frameId",
         f.sample_id::text AS "sampleId",
         f.surface,
         f.frame_type AS "frameType",
         ia.storage_url AS "storageUrl",
         ia.owner_id::text AS "ownerId",
         f.width,
         f.height,
         f.size_bytes AS "sizeBytes",
         f.created_at AS "createdAt"
  FROM bottle_eval_frame f
  JOIN image_asset ia ON ia.image_id = f.image_id
  WHERE f.sample_id = ANY($1::bigint[])
  ORDER BY f.sample_id, f.position, f.frame_id`;

/** Unlocked pre-check before reading an upload: does the sample exist, and how many frames. */
export const SELECT_SAMPLE_FRAME_COUNT_SQL = `
  SELECT s.sample_id::text AS "sampleId",
         (SELECT COUNT(*) FROM bottle_eval_frame f WHERE f.sample_id = s.sample_id)::int AS "frameCount"
  FROM bottle_eval_sample s
  WHERE s.sample_id = $1::bigint`;

export const LOCK_SAMPLE_SQL = `
  SELECT sample_id::text AS "sampleId"
  FROM bottle_eval_sample
  WHERE sample_id = $1::bigint
  FOR UPDATE`;

export const SELECT_FRAME_POSITION_SQL = `
  SELECT COUNT(*)::int AS "frameCount",
         COALESCE(MAX(position), 0)::int AS "maxPosition"
  FROM bottle_eval_frame
  WHERE sample_id = $1::bigint`;

/** `$1` owner (the uploading admin), `$2` storage URL, `$3` checksum. */
export const INSERT_FRAME_IMAGE_SQL = `
  INSERT INTO image_asset (owner_type, owner_id, storage_url, checksum_sha256, copyright_status, captured_at)
  VALUES ('user', $1::bigint, $2, $3, 'user_uploaded', now())
  RETURNING image_id::text AS "imageId"`;

export const INSERT_FRAME_SQL = `
  INSERT INTO bottle_eval_frame (sample_id, image_id, surface, frame_type, position, content_type, width, height, size_bytes)
  VALUES ($1::bigint, $2::bigint, $3, $4, $5, $6, $7, $8, $9)
  RETURNING frame_id::text AS "frameId"`;

export const DELETE_SAMPLE_FRAMES_SQL = `
  DELETE FROM bottle_eval_frame
  WHERE sample_id = $1::bigint
  RETURNING image_id::text AS "imageId"`;

export const DELETE_FRAME_SQL = `
  DELETE FROM bottle_eval_frame
  WHERE sample_id = $1::bigint
    AND frame_id = $2::bigint
  RETURNING image_id::text AS "imageId"`;

/** The frames' private image rows (`$1` bigint[]); returns what the blob cleanup needs. */
export const DELETE_FRAME_IMAGES_SQL = `
  DELETE FROM image_asset
  WHERE image_id = ANY($1::bigint[])
    AND owner_type = 'user'
  RETURNING storage_url AS "storageUrl", owner_id::text AS "ownerId"`;

export const DELETE_SAMPLE_SQL = `
  DELETE FROM bottle_eval_sample
  WHERE sample_id = $1::bigint`;
