import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { AdminAuditAction, AdminAuditEvent, AdminSourceDetailResponse, AdminSourceListResponse } from "swatchwatch-shared";
import { withAdmin } from "../lib/auth";
import { query, transaction } from "../lib/db";
import { withCors } from "../lib/http";
import { internalServerError } from "../lib/errors";
import { trackEvent } from "../lib/telemetry";
import { recordAdminAuditEvent } from "../lib/admin-users";
import {
  SOURCES_ADMIN_LIST_SQL,
  parsePermissionRequest,
  planEnabledChange,
  planPermissionChange,
  sourcesAdminSql,
  toAdminSourceListItem,
  type PlanResult,
  type SourceAdminRow,
  type SourceState,
} from "../lib/sources-admin";

/**
 * Admin Sources tab (all routes `withAdmin`).
 *
 * GET /api/sources-admin                    — every data source with derived permission and counts
 * GET /api/sources-admin/{id}               — one source + notes + permission/on-off history
 * PUT /api/sources-admin/{id}/permission    — record asked / granted / declined / images (audited)
 * PUT /api/sources-admin/{id}/enabled       — turn on/off (audited; on without an OK needs override)
 */

const HISTORY_LIMIT = 50;

function parseSourceId(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function loadDetail(id: number): Promise<AdminSourceDetailResponse | null> {
  const result = await query<SourceAdminRow>(sourcesAdminSql(true), [id]);
  const row = result.rows[0];
  if (!row) return null;
  const audit = await query<{
    auditEventId: number | string;
    actorUserId: number | string;
    actorLabel: string | null;
    targetUserId: number | string | null;
    action: AdminAuditAction;
    changes: Record<string, unknown> | null;
    note: string | null;
    createdAt: string;
  }>(
    `SELECT e.admin_audit_event_id AS "auditEventId",
            e.actor_user_id AS "actorUserId",
            COALESCE(a.email, a.handle) AS "actorLabel",
            e.target_user_id AS "targetUserId",
            e.action,
            e.changes,
            e.note,
            e.created_at::text AS "createdAt"
     FROM admin_audit_event e
     LEFT JOIN app_user a ON a.user_id = e.actor_user_id
     WHERE e.action LIKE 'data_source.%'
       AND (e.changes->>'dataSourceId')::bigint = $1
     ORDER BY e.created_at DESC, e.admin_audit_event_id DESC
     LIMIT $2`,
    [id, HISTORY_LIMIT]
  );
  const notes = row.metadata && typeof row.metadata.notes === "string" ? row.metadata.notes : null;
  return {
    source: toAdminSourceListItem(row),
    notes,
    history: audit.rows.map(
      (event): AdminAuditEvent => ({
        auditEventId: Number(event.auditEventId),
        actorUserId: Number(event.actorUserId),
        actorLabel: event.actorLabel || undefined,
        targetUserId: event.targetUserId === null ? undefined : Number(event.targetUserId),
        action: event.action,
        changes: event.changes ?? {},
        note: event.note || undefined,
        createdAt: event.createdAt,
      })
    ),
  };
}

async function listSources(context: InvocationContext): Promise<HttpResponseInit> {
  context.log("GET /api/sources-admin");
  try {
    const result = await query<SourceAdminRow>(SOURCES_ADMIN_LIST_SQL, []);
    const body: AdminSourceListResponse = { sources: result.rows.map(toAdminSourceListItem) };
    return { status: 200, jsonBody: body };
  } catch (error) {
    return internalServerError(context, error, "Failed to list sources", "sources-admin.list");
  }
}

async function getSource(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const id = parseSourceId(request.params.id);
  if (!id) return { status: 400, jsonBody: { error: "Source id must be a positive integer" } };
  context.log(`GET /api/sources-admin/${id}`);
  try {
    const detail = await loadDetail(id);
    if (!detail) return { status: 404, jsonBody: { error: "Source not found" } };
    return { status: 200, jsonBody: detail };
  } catch (error) {
    return internalServerError(context, error, "Failed to load source", "sources-admin.get");
  }
}

class PlanRejected extends Error {
  constructor(readonly status: number, readonly payload: Record<string, unknown>) {
    super("plan rejected");
  }
}

async function writeSource(
  request: HttpRequest,
  context: InvocationContext,
  adminUserId: number,
  kind: "permission" | "enabled"
): Promise<HttpResponseInit> {
  const id = parseSourceId(request.params.id);
  if (!id) return { status: 400, jsonBody: { error: "Source id must be a positive integer" } };
  context.log(`PUT /api/sources-admin/${id}/${kind}`);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { status: 400, jsonBody: { error: "Request body must be valid JSON" } };
  }

  let plan: (state: SourceState) => PlanResult;
  if (kind === "permission") {
    const parsed = parsePermissionRequest(body);
    if (!parsed.ok) return { status: 400, jsonBody: { error: parsed.error } };
    const nowIso = new Date().toISOString();
    plan = (state) => planPermissionChange(state, parsed.value, adminUserId, nowIso);
  } else {
    const value = body as { enabled?: unknown; override?: unknown } | null;
    if (!value || typeof value !== "object" || typeof value.enabled !== "boolean") {
      return { status: 400, jsonBody: { error: "enabled must be a boolean" } };
    }
    if (value.override !== undefined && typeof value.override !== "boolean") {
      return { status: 400, jsonBody: { error: "override must be a boolean" } };
    }
    const req = { enabled: value.enabled, override: value.override as boolean | undefined };
    plan = (state) => planEnabledChange(state, req);
  }

  try {
    const action = await transaction(async (client) => {
      const current = await client.query<{ name: string; enabled: boolean; metadata: Record<string, unknown> | null }>(
        `SELECT name, enabled, metadata
         FROM data_source
         WHERE data_source_id = $1
         FOR UPDATE`,
        [id]
      );
      const row = current.rows[0];
      if (!row) return "not_found" as const;

      const planned = plan({ name: row.name, enabled: row.enabled, metadata: row.metadata ?? {} });
      if (!planned.ok) {
        throw new PlanRejected(planned.status, { error: planned.error, code: planned.code });
      }

      await client.query(
        `UPDATE data_source
         SET enabled = $2, metadata = $3::jsonb
         WHERE data_source_id = $1`,
        [id, planned.enabled, JSON.stringify(planned.metadata)]
      );
      await recordAdminAuditEvent(client, {
        actorUserId: adminUserId,
        targetUserId: null,
        action: planned.action,
        changes: { dataSourceId: id, ...planned.changes },
      });
      return planned.action;
    });

    if (action === "not_found") return { status: 404, jsonBody: { error: "Source not found" } };
    trackEvent("admin.source_permission", { action, dataSourceId: id, actorUserId: adminUserId });

    const detail = await loadDetail(id);
    if (!detail) return { status: 404, jsonBody: { error: "Source not found" } };
    return { status: 200, jsonBody: detail };
  } catch (error) {
    if (error instanceof PlanRejected) return { status: error.status, jsonBody: error.payload };
    return internalServerError(context, error, "Failed to update source", `sources-admin.${kind}`);
  }
}

app.http("sources-admin-list", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "sources-admin",
  handler: withCors(withAdmin(async (_request, context) => listSources(context))),
});

app.http("sources-admin-item", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "sources-admin/{id}",
  handler: withCors(withAdmin(async (request, context) => getSource(request, context))),
});

app.http("sources-admin-permission", {
  methods: ["PUT", "OPTIONS"],
  authLevel: "anonymous",
  route: "sources-admin/{id}/permission",
  handler: withCors(
    withAdmin(async (request, context, adminUserId) => writeSource(request, context, adminUserId, "permission"))
  ),
});

app.http("sources-admin-enabled", {
  methods: ["PUT", "OPTIONS"],
  authLevel: "anonymous",
  route: "sources-admin/{id}/enabled",
  handler: withCors(
    withAdmin(async (request, context, adminUserId) => writeSource(request, context, adminUserId, "enabled"))
  ),
});
