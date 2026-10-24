import type { PoolClient } from "pg";
import { normalizeGtin, type NormalizedGtin } from "./barcodes";

/**
 * Capture-session state changes made outside the capture endpoints. Today: one-tap create from the
 * bottle flow, where `POST /api/polishes` carries the session's `captureId` so the server marks the
 * session matched with the new shade (and the caller's scanned GTIN is learned for next time).
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** No session with this id for this caller (unknown, or another user's: indistinguishable). */
export class CaptureSessionNotFoundError extends Error {
  constructor() {
    super("Capture session not found");
    this.name = "CaptureSessionNotFoundError";
  }
}

/** The caller cancelled the session; a cancelled session cannot be matched. */
export class CaptureSessionStateError extends Error {
  constructor() {
    super("Capture session is cancelled");
    this.name = "CaptureSessionStateError";
  }
}

/** $1 capture_uuid, $2 user_id. Locks the caller's session row for the surrounding transaction. */
export const LOCK_CAPTURE_SESSION_SQL = `SELECT capture_session_id AS id, status, metadata
FROM capture_session
WHERE capture_uuid = $1::uuid
  AND user_id = $2
FOR UPDATE`;

/** $1 session id: the newest frame's decoded GTIN (`quality_json.extracted.gtin`). */
export const SELECT_SESSION_FRAME_GTIN_SQL = `SELECT quality_json->'extracted'->>'gtin' AS gtin,
       COALESCE(quality_json->'extracted'->>'gtinFormat', quality_json->'extracted'->>'barcodeFormat') AS format
FROM capture_frame
WHERE capture_session_id = $1
  AND NULLIF(btrim(quality_json->'extracted'->>'gtin'), '') IS NOT NULL
ORDER BY created_at DESC, capture_frame_id DESC
LIMIT 1`;

/** $1 session id, $2 shade id, $3 user id. */
export const MARK_SESSION_CREATED_SHADE_SQL = `UPDATE capture_session
SET status = 'matched',
    top_confidence = 1,
    accepted_entity_type = 'shade',
    accepted_entity_id = $2,
    metadata = COALESCE(metadata, '{}'::jsonb)
      || jsonb_build_object('resolver', jsonb_build_object('step', 'created_from_capture', 'createdShadeId', $2::bigint)),
    updated_at = now()
WHERE capture_session_id = $1
  AND user_id = $3`;

/** $1 session id. */
export const EXPIRE_OPEN_QUESTIONS_SQL = `UPDATE capture_question
SET status = 'expired'
WHERE capture_session_id = $1
  AND status = 'open'`;

interface LockedSessionRow {
  id: number | string;
  status: string;
  metadata: Record<string, unknown> | null;
}

function metadataString(metadata: Record<string, unknown> | null, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = metadata?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * Inside the caller's transaction: lock the caller's session and mark it matched with the shade
 * just created. Whatever its state (processing, needs_question, unmatched, or already matched by a
 * legacy finalize) it is re-marked; only a cancelled or missing session is refused. Returns the
 * session's scanned GTIN (`metadata.gtin`, else the newest frame's), normalized, or null.
 */
export async function markCaptureSessionCreatedShade(
  client: Pick<PoolClient, "query">,
  input: { userId: number; captureId: string; shadeId: number }
): Promise<{ sessionId: number; gtin: NormalizedGtin | null }> {
  const locked = await client.query<LockedSessionRow>(LOCK_CAPTURE_SESSION_SQL, [input.captureId, input.userId]);
  const session = locked.rows[0];
  if (!session) throw new CaptureSessionNotFoundError();
  if (session.status === "cancelled") throw new CaptureSessionStateError();

  const sessionId = Number(session.id);
  let gtin = normalizeGtin(
    metadataString(session.metadata, "gtin"),
    metadataString(session.metadata, "barcodeFormat", "gtinFormat")
  );
  if (!gtin) {
    const frame = (
      await client.query<{ gtin: string | null; format: string | null }>(SELECT_SESSION_FRAME_GTIN_SQL, [sessionId])
    ).rows[0];
    if (frame?.gtin) gtin = normalizeGtin(frame.gtin, frame.format ?? undefined);
  }

  await client.query(MARK_SESSION_CREATED_SHADE_SQL, [sessionId, input.shadeId, input.userId]);
  await client.query(EXPIRE_OPEN_QUESTIONS_SQL, [sessionId]);
  return { sessionId, gtin };
}
