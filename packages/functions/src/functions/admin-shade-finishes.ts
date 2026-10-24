import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { SHADE_FINISHES_MAX, type ShadeFinishesUpdateResponse } from "swatchwatch-shared";
import { withAdmin } from "../lib/auth";
import { transaction } from "../lib/db";
import { internalServerError } from "../lib/errors";
import { canonicalizeFinish, loadFinishCatalog, type FinishCatalog } from "../lib/finishes";
import { withCors } from "../lib/http";
import { invalidateCatalogWideCaches } from "../lib/polish-cache";
import { trackEvent } from "../lib/telemetry";

/**
 * PUT /api/shades-admin/{id}/finishes (admin-only, `withAdmin`) — set a catalog shade's whole
 * finish list from the Hex Labeling tool.
 *
 * The list replaces `shade.finishes` and becomes sticky (`finishes_source = 'admin'`, migration
 * 20261024053633287_shade-finishes-source): ingestion merges vendor tag finishes in and never
 * removes one, so without it a finish the admin took off would come back on the next ingest.
 * The legacy `shade.finish` is never rewritten (it is the raw vendor dedup key). Every change is
 * logged in `shade_category_change` (`action = 'finishes'`, before/after). Private
 * `user_submitted` shades answer 404 (their owner edits them), like the labeler's shade read.
 */

const ID_PATTERN = /^\d{1,18}$/;

function parseShadeId(raw: unknown): number | null {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!ID_PATTERN.test(text)) return null;
  const value = Number.parseInt(text, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export type ShadeFinishesParseResult = { ok: true; finishes: string[] } | { ok: false; error: string };

/**
 * Validate a `PUT …/finishes` body against the finish catalog: every entry must be a known finish
 * or alias, stored as its canonical name, duplicates dropped, order (primary first) kept. Pure.
 */
export function parseShadeFinishesRequest(body: unknown, catalog: FinishCatalog): ShadeFinishesParseResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Request body must be a JSON object" };
  }
  const raw = (body as Record<string, unknown>).finishes;
  if (!Array.isArray(raw)) return { ok: false, error: "finishes must be an array of finish names" };

  const finishes: string[] = [];
  const unknown: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") return { ok: false, error: "finishes must be an array of finish names" };
    const canonical = canonicalizeFinish(value, catalog);
    if (!canonical) {
      unknown.push(value.trim().slice(0, 60));
      continue;
    }
    if (!finishes.includes(canonical)) finishes.push(canonical);
  }
  if (unknown.length > 0) return { ok: false, error: `Unknown finishes: ${unknown.join(", ")}` };
  if (finishes.length > SHADE_FINISHES_MAX) {
    return { ok: false, error: `A shade can have at most ${SHADE_FINISHES_MAX} finishes` };
  }
  return { ok: true, finishes };
}

async function readJson(request: HttpRequest): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    const text = await request.text();
    return { ok: true, body: text.trim() ? JSON.parse(text) : {} };
  } catch {
    return { ok: false };
  }
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export async function setShadeFinishes(
  request: HttpRequest,
  context: InvocationContext,
  adminUserId: number
): Promise<HttpResponseInit> {
  const shadeId = parseShadeId(request.params.id);
  if (!shadeId) return { status: 400, jsonBody: { error: "Invalid shade id" } };
  const json = await readJson(request);
  if (!json.ok) return { status: 400, jsonBody: { error: "Invalid JSON body" } };

  try {
    const catalog = await loadFinishCatalog();
    const parsed = parseShadeFinishesRequest(json.body, catalog);
    if (!parsed.ok) return { status: 400, jsonBody: { error: parsed.error } };
    const finishes = parsed.finishes;

    const outcome = await transaction(async (client) => {
      const current = await client.query<{ finishes: string[] | null; finishesSource: string }>(
        `SELECT finishes, finishes_source AS "finishesSource"
         FROM shade
         WHERE shade_id = $1
           AND merged_into_shade_id IS NULL
           AND status <> 'user_submitted'
         FOR UPDATE`,
        [shadeId]
      );
      const before = current.rows[0];
      if (!before) return null;
      const beforeFinishes = before.finishes ?? [];
      if (before.finishesSource === "admin" && sameList(beforeFinishes, finishes)) return { changed: false };

      await client.query(
        `UPDATE shade
         SET finishes = $2::text[], finishes_source = 'admin', updated_at = now()
         WHERE shade_id = $1`,
        [shadeId, finishes]
      );
      await client.query(
        `INSERT INTO shade_category_change (shade_id, action, before, after, source, actor_user_id)
         VALUES ($1, 'finishes', $2::jsonb, $3::jsonb, 'admin', $4)`,
        [
          shadeId,
          JSON.stringify({ finishes: beforeFinishes, finishesSource: before.finishesSource }),
          JSON.stringify({ finishes, finishesSource: "admin" }),
          adminUserId,
        ]
      );
      return { changed: true };
    });
    if (!outcome) return { status: 404, jsonBody: { error: "Shade not found" } };

    if (outcome.changed) {
      await invalidateCatalogWideCaches([shadeId]);
      trackEvent("shade_finishes.admin_set", { shadeId: String(shadeId), adminUserId, count: finishes.length });
    }
    const response: ShadeFinishesUpdateResponse = {
      shadeId: String(shadeId),
      finishes,
      finishesSource: "admin",
      changed: outcome.changed,
    };
    return { status: 200, jsonBody: response };
  } catch (error) {
    return internalServerError(context, error, "Failed to set the shade finishes", "shades-admin.finishes-set");
  }
}

app.http("admin-shade-finishes-set", {
  methods: ["PUT", "OPTIONS"],
  authLevel: "anonymous",
  route: "shades-admin/{id}/finishes",
  handler: withCors(withAdmin(setShadeFinishes)),
});
