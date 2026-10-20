/**
 * Saved looks (`docs/looks-experience-plan.md` §6 Phase 2): `GET/POST/DELETE /api/looks` for the
 * caller's `user_look` rows.
 *
 * A saved look is an opaque display snapshot (template, vibe, steps with labels/hexes and optional
 * shade id/brand/name) validated by `validateSavedLookInput` from swatchwatch-shared and returned to
 * its owner as-is. It is never joined to `shade`, so saving a look that names someone else's
 * private shade id reveals nothing. Every statement is scoped to the authenticated user; each user
 * keeps at most `MAX_SAVED_LOOKS` (the oldest fall off on save).
 */
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { SavedLook, SavedLookListResponse } from "swatchwatch-shared";
import { MAX_SAVED_LOOKS, validateSavedLookInput } from "swatchwatch-shared";
import { query, transaction } from "../lib/db";
import { withAuth } from "../lib/auth";
import { withCors } from "../lib/http";
import { internalServerError } from "../lib/errors";
import { trackEvent } from "../lib/telemetry";

/** Largest accepted request body; a valid look is well under 4 KB. */
const MAX_BODY_BYTES = 8_000;
const MAX_KEY_LENGTH = 160;

interface UserLookRow {
  id: string;
  templateId: string;
  name: string;
  vibe: SavedLook["vibe"];
  steps: SavedLook["steps"];
  savedAt: Date | string;
}

const LOOK_COLUMNS = `
  look_key     AS id,
  template_id  AS "templateId",
  name,
  vibe,
  steps,
  saved_at     AS "savedAt"`;

function toSavedLook(row: UserLookRow): SavedLook {
  const savedAt = row.savedAt instanceof Date ? row.savedAt : new Date(row.savedAt);
  return {
    id: row.id,
    templateId: row.templateId,
    name: row.name,
    vibe: row.vibe,
    steps: row.steps,
    savedAt: savedAt.toISOString(),
  };
}

async function listLooks(userId: number): Promise<HttpResponseInit> {
  const result = await query<UserLookRow>(
    `SELECT ${LOOK_COLUMNS}
     FROM user_look
     WHERE user_id = $1
     ORDER BY saved_at DESC, user_look_id DESC
     LIMIT $2`,
    [userId, MAX_SAVED_LOOKS]
  );
  const body: SavedLookListResponse = { looks: result.rows.map(toSavedLook) };
  return { status: 200, jsonBody: body };
}

async function saveLook(request: HttpRequest, userId: number): Promise<HttpResponseInit> {
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
    return { status: 413, jsonBody: { error: "Look is too large" } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: 400, jsonBody: { error: "Body must be valid JSON" } };
  }
  const validation = validateSavedLookInput(parsed);
  if (!validation.ok) return { status: 400, jsonBody: { error: validation.error } };
  const look = validation.look;

  const saved = await transaction(async (client) => {
    const inserted = await client.query<UserLookRow>(
      `INSERT INTO user_look (user_id, look_key, template_id, name, vibe, steps)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
       ON CONFLICT (user_id, look_key) DO UPDATE
         SET template_id = EXCLUDED.template_id,
             name        = EXCLUDED.name,
             vibe        = EXCLUDED.vibe,
             steps       = EXCLUDED.steps,
             saved_at    = now()
       RETURNING ${LOOK_COLUMNS}`,
      [userId, look.id, look.templateId, look.name, JSON.stringify(look.vibe), JSON.stringify(look.steps)]
    );
    // Keep the newest MAX_SAVED_LOOKS for this user.
    await client.query(
      `DELETE FROM user_look
       WHERE user_id = $1
         AND user_look_id NOT IN (
           SELECT user_look_id FROM user_look
           WHERE user_id = $1
           ORDER BY saved_at DESC, user_look_id DESC
           LIMIT $2
         )`,
      [userId, MAX_SAVED_LOOKS]
    );
    return inserted.rows[0];
  });

  trackEvent("looks.saved", { userId, template: look.templateId, steps: look.steps.length });
  return { status: 201, jsonBody: toSavedLook(saved) };
}

async function deleteLook(request: HttpRequest, userId: number): Promise<HttpResponseInit> {
  const key = request.query.get("key")?.trim() ?? "";
  if (!key || key.length > MAX_KEY_LENGTH) {
    return { status: 400, jsonBody: { error: "key is required" } };
  }
  const result = await query(`DELETE FROM user_look WHERE user_id = $1 AND look_key = $2`, [userId, key]);
  if (!result.rowCount) return { status: 404, jsonBody: { error: "Look not found" } };
  return { status: 204 };
}

export async function handleLooks(
  request: HttpRequest,
  context: InvocationContext,
  userId: number
): Promise<HttpResponseInit> {
  const method = request.method?.toUpperCase();
  try {
    if (method === "POST") return await saveLook(request, userId);
    if (method === "DELETE") return await deleteLook(request, userId);
    return await listLooks(userId);
  } catch (error) {
    return internalServerError(context, error, "Failed to handle saved looks", `looks.${(method ?? "get").toLowerCase()}`);
  }
}

app.http("looks", {
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  authLevel: "anonymous",
  route: "looks",
  handler: withCors(withAuth(handleLooks)),
});
