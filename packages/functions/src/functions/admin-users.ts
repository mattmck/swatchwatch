import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type {
  AdminUserDetailResponse,
  AdminUserListResponse,
  AdminUserMergeRequest,
  AdminUserMergeResponse,
} from "swatchwatch-shared";
import { withAdmin } from "../lib/auth";
import { query, transaction } from "../lib/db";
import { withCors } from "../lib/http";
import { internalServerError } from "../lib/errors";
import { trackEvent } from "../lib/telemetry";
import {
  ADMIN_USER_FROM,
  ADMIN_USER_SELECT,
  buildListFilter,
  buildListOrder,
  loadAdminUserDetail,
  parseListQuery,
  parseUserId,
  parseUserUpdate,
  planUserUpdate,
  recordAdminAuditEvent,
  toAdminUserListItem,
  type AdminUserRow,
  type CurrentUserState,
} from "../lib/admin-users";

/**
 * Admin user management (issues #45, account merge). All routes are admin-only (`withAdmin`).
 *
 * GET   /api/users-admin        — search / filter / sort / paginate users
 * GET   /api/users-admin/{id}   — one user + linked identities + recent audit events
 * PATCH /api/users-admin/{id}   — edit handle, suspend / reactivate (audited)
 * POST  /api/users-admin/merge  — merge a duplicate account into another (audited)
 */

function parsePositiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return null;
  }
  return value;
}

async function mergeUsers(
  request: HttpRequest,
  context: InvocationContext,
  adminUserId: number
): Promise<HttpResponseInit> {
  context.log("POST /api/users-admin/merge");

  let body: Partial<AdminUserMergeRequest>;
  try {
    body = (await request.json()) as Partial<AdminUserMergeRequest>;
  } catch {
    return { status: 400, jsonBody: { error: "Request body must be valid JSON" } };
  }

  const sourceUserId = parsePositiveInteger(body.sourceUserId);
  const targetUserId = parsePositiveInteger(body.targetUserId);
  if (!sourceUserId || !targetUserId) {
    return {
      status: 400,
      jsonBody: { error: "sourceUserId and targetUserId are required positive integers" },
    };
  }

  if (sourceUserId === targetUserId) {
    return {
      status: 400,
      jsonBody: { error: "sourceUserId and targetUserId must be different" },
    };
  }

  // The source account is deleted: an admin must not merge away (and lock out) their own account.
  if (sourceUserId === adminUserId) {
    return {
      status: 409,
      jsonBody: { error: "You cannot merge away your own account", code: "cannot_modify_self" },
    };
  }

  try {
    const result = await transaction<AdminUserMergeResponse>(async (client) => {
      const users = await client.query<{
        userId: number;
        role: string | null;
        email: string | null;
        externalId: string | null;
        suspendedAt: string | null;
        suspendedReason: string | null;
        suspendedByUserId: number | string | null;
      }>(
        `SELECT
           user_id AS "userId",
           COALESCE(role, 'user') AS role,
           email,
           external_id AS "externalId",
           suspended_at AS "suspendedAt",
           suspended_reason AS "suspendedReason",
           suspended_by_user_id AS "suspendedByUserId"
         FROM app_user
         WHERE user_id = ANY($1::bigint[])
         ORDER BY user_id ASC
         FOR UPDATE`,
        [[sourceUserId, targetUserId]]
      );

      if (users.rows.length !== 2) {
        return {
          merged: false,
          sourceUserId,
          targetUserId,
          mergedByUserId: adminUserId,
          mergedInventoryRows: 0,
          mergedIdentityRows: 0,
          mergedSubmissionRows: 0,
          mergedCaptureRows: 0,
          mergedCaptureAnswerRows: 0,
          mergedClickEventRows: 0,
          message: "One or both users do not exist",
        };
      }

      // user_id is BIGINT, which node-postgres returns as a string: compare numerically.
      const sourceUser = users.rows.find((row) => Number(row.userId) === sourceUserId)!;
      const targetUser = users.rows.find((row) => Number(row.userId) === targetUserId)!;
      const mergedTargetRole = targetUser.role === "admin" || sourceUser.role === "admin"
        ? "admin"
        : (targetUser.role || "user");

      const mergeDuplicateInventory = await client.query(
        `UPDATE user_inventory_item target
         SET quantity = target.quantity + source.quantity,
             -- Strongest status on either account wins: owned > destash (still has the
             -- bottle) > wishlist > archived.
             status = CASE
               WHEN 'owned' IN (source.status, target.status) THEN 'owned'
               WHEN 'destash' IN (source.status, target.status) THEN 'destash'
               WHEN 'wishlist' IN (source.status, target.status) THEN 'wishlist'
               ELSE target.status
             END,
             tried_at = LEAST(target.tried_at, source.tried_at),
             last_worn_at = GREATEST(target.last_worn_at, source.last_worn_at),
             wear_count = target.wear_count + source.wear_count
         FROM user_inventory_item source
         WHERE source.user_id = $1
           AND target.user_id = $2
           AND source.shade_id IS NOT NULL
           AND target.shade_id = source.shade_id
         RETURNING 1 AS "rowCount"`,
        [sourceUserId, targetUserId]
      );

      // Migrate inventory_event rows from source duplicate items to target items
      // before deleting the source rows, so cascade-delete does not erase history.
      await client.query(
        `UPDATE inventory_event ie
         SET inventory_item_id = target.inventory_item_id
         FROM user_inventory_item source
         JOIN user_inventory_item target
           ON target.user_id = $2
          AND target.shade_id IS NOT NULL
          AND target.shade_id = source.shade_id
         WHERE source.user_id = $1
           AND source.shade_id IS NOT NULL
           AND ie.inventory_item_id = source.inventory_item_id`,
        [sourceUserId, targetUserId]
      );

      await client.query(
        `DELETE FROM user_inventory_item source
         USING user_inventory_item target
         WHERE source.user_id = $1
           AND target.user_id = $2
           AND source.shade_id IS NOT NULL
           AND target.shade_id = source.shade_id`,
        [sourceUserId, targetUserId]
      );

      const movedInventory = await client.query(
        `UPDATE user_inventory_item
         SET user_id = $1
         WHERE user_id = $2`,
        [targetUserId, sourceUserId]
      );

      const movedSubmissions = await client.query(
        `UPDATE user_submission
         SET user_id = $1
         WHERE user_id = $2`,
        [targetUserId, sourceUserId]
      );

      const movedCaptureSessions = await client.query(
        `UPDATE capture_session
         SET user_id = $1
         WHERE user_id = $2`,
        [targetUserId, sourceUserId]
      );

      const movedCaptureAnswers = await client.query(
        `UPDATE capture_answer
         SET user_id = $1
         WHERE user_id = $2`,
        [targetUserId, sourceUserId]
      );

      const movedClickEvents = await client.query(
        `UPDATE click_event
         SET user_id = $1
         WHERE user_id = $2`,
        [targetUserId, sourceUserId]
      );

      // Mani log (#269): the merged wear stats above (summed wear_count, latest last_worn_at)
      // equal what the moved manicures derive, and their used-events were repointed with the
      // other inventory_event rows.
      const movedManicures = await client.query(
        `UPDATE manicure
         SET user_id = $1
         WHERE user_id = $2`,
        [targetUserId, sourceUserId]
      );

      // Wear history is keyed by user + shade (D8, #317), including events detached from a
      // deleted inventory row: move the owner with the rest.
      await client.query(
        `UPDATE inventory_event
         SET user_id = $1
         WHERE user_id = $2`,
        [targetUserId, sourceUserId]
      );
      // Events the source detached (polish deleted) re-attach to the target's row for the same
      // shade, if the target holds it; the rest stay detached.
      await client.query(
        `UPDATE inventory_event ie
         SET inventory_item_id = ui.inventory_item_id
         FROM user_inventory_item ui
         WHERE ie.user_id = $1
           AND ie.inventory_item_id IS NULL
           AND ie.shade_id IS NOT NULL
           AND ui.user_id = $1
           AND ui.shade_id = ie.shade_id`,
        [targetUserId]
      );

      const movedIdentities = await client.query(
        `INSERT INTO user_external_identities (user_id, external_id, email, last_seen_at)
         SELECT $1, external_id, email, last_seen_at
         FROM user_external_identities
         WHERE user_id = $2
         ON CONFLICT (external_id) DO UPDATE
         SET
           user_id = EXCLUDED.user_id,
           email = COALESCE(EXCLUDED.email, user_external_identities.email),
           last_seen_at = GREATEST(user_external_identities.last_seen_at, EXCLUDED.last_seen_at)`,
        [targetUserId, sourceUserId]
      );

      await client.query(
        `UPDATE app_user
         SET
           role = $2,
           email = COALESCE(email, $3),
           external_id = COALESCE(external_id, $4)
         WHERE user_id = $1`,
        [targetUserId, mergedTargetRole, sourceUser.email, sourceUser.externalId]
      );

      // The source's identities now sign in to the target, so a suspension on the source must
      // carry over (#45): otherwise merging a suspended duplicate would silently lift it.
      const carrySuspension = sourceUser.suspendedAt !== null && targetUser.suspendedAt === null;
      if (carrySuspension) {
        await client.query(
          `UPDATE app_user
           SET suspended_at = $2, suspended_reason = $3, suspended_by_user_id = $4
           WHERE user_id = $1`,
          [targetUserId, sourceUser.suspendedAt, sourceUser.suspendedReason, sourceUser.suspendedByUserId]
        );
      }

      await client.query(
        `UPDATE app_settings
         SET updated_by = NULL
         WHERE updated_by = $1`,
        [sourceUserId]
      );

      // Bottle eval samples are shared ground truth: deleting the source app_user would cascade
      // them away, so they move to the target. Their image_asset rows keep the old owner_id.
      const movedBottleEvalSamples = await client.query(
        `UPDATE bottle_eval_sample
         SET created_by_user_id = $1
         WHERE created_by_user_id = $2`,
        [targetUserId, sourceUserId]
      );

      await client.query(
        `DELETE FROM app_user
         WHERE user_id = $1`,
        [sourceUserId]
      );

      await recordAdminAuditEvent(client, {
        actorUserId: adminUserId,
        targetUserId,
        action: "user.merge",
        changes: {
          sourceUserId,
          sourceEmail: sourceUser.email,
          sourceExternalId: sourceUser.externalId,
          movedInventoryRows: movedInventory.rowCount || 0,
          mergedInventoryDuplicateRows: mergeDuplicateInventory.rowCount || 0,
          movedIdentityRows: movedIdentities.rowCount || 0,
          movedManicureRows: movedManicures.rowCount || 0,
          bottleEvalSamplesMoved: movedBottleEvalSamples.rowCount || 0,
          targetRole: { from: targetUser.role, to: mergedTargetRole },
          ...(carrySuspension
            ? {
                suspended: { from: false, to: true },
                suspendedReason: { from: null, to: sourceUser.suspendedReason },
              }
            : {}),
        },
      });

      return {
        merged: true,
        sourceUserId,
        targetUserId,
        mergedByUserId: adminUserId,
        mergedInventoryRows: movedInventory.rowCount || 0,
        mergedIdentityRows: movedIdentities.rowCount || 0,
        mergedSubmissionRows: movedSubmissions.rowCount || 0,
        mergedCaptureRows: movedCaptureSessions.rowCount || 0,
        mergedCaptureAnswerRows: movedCaptureAnswers.rowCount || 0,
        mergedClickEventRows: movedClickEvents.rowCount || 0,
        message: `Merged user ${sourceUserId} into ${targetUserId}`,
        mergedInventoryDuplicateRows: mergeDuplicateInventory.rowCount || 0,
        mergedManicureRows: movedManicures.rowCount || 0,
        targetRole: mergedTargetRole,
      };
    });

    if (!result.merged) {
      return { status: 404, jsonBody: result };
    }

    return {
      status: 200,
      jsonBody: result,
    };
  } catch (error: any) {
    if (error?.code === "42P01") {
      return {
        status: 503,
        jsonBody: { error: "Identity-link migrations are not applied yet" },
      };
    }
    context.error("Error merging users:", error);
    return {
      status: 500,
      jsonBody: { error: "Failed to merge users" },
    };
  }
}

async function listUsers(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  context.log("GET /api/users-admin");

  const parsed = parseListQuery(new URL(request.url).searchParams);
  if (!parsed.ok) {
    return { status: 400, jsonBody: { error: parsed.error } };
  }
  const listQuery = parsed.value;
  const { whereSql, params } = buildListFilter(listQuery);

  try {
    const [countResult, usersResult] = await Promise.all([
      query<{ total: string }>(
        `SELECT COUNT(*)::text AS total
         FROM app_user u
         ${whereSql}`,
        params
      ),
      query<AdminUserRow>(
        `SELECT *
         FROM (
           SELECT ${ADMIN_USER_SELECT}
           ${ADMIN_USER_FROM}
           ${whereSql}
         ) users
         ${buildListOrder(listQuery)}
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, listQuery.limit, listQuery.offset]
      ),
    ]);

    return {
      status: 200,
      jsonBody: {
        users: usersResult.rows.map(toAdminUserListItem),
        total: Number.parseInt(countResult.rows[0]?.total ?? "0", 10) || 0,
        limit: listQuery.limit,
        offset: listQuery.offset,
      } satisfies AdminUserListResponse,
    };
  } catch (error: any) {
    if (error?.code === "42P01" || error?.code === "42703") {
      return { status: 503, jsonBody: { error: "User-management migrations are not applied yet" } };
    }
    return internalServerError(context, error, "Failed to list users", "admin-users.list");
  }
}

async function getUser(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  const userId = parseUserId(request.params.id);
  if (!userId) {
    return { status: 400, jsonBody: { error: "User id must be a positive integer" } };
  }
  context.log(`GET /api/users-admin/${userId}`);

  try {
    const detail = await loadAdminUserDetail(query, userId);
    if (!detail) {
      return { status: 404, jsonBody: { error: "User not found" } };
    }
    return { status: 200, jsonBody: detail satisfies AdminUserDetailResponse };
  } catch (error: any) {
    if (error?.code === "42P01" || error?.code === "42703") {
      return { status: 503, jsonBody: { error: "User-management migrations are not applied yet" } };
    }
    return internalServerError(context, error, "Failed to load user", "admin-users.get");
  }
}

class UserUpdateConflict extends Error {
  constructor(
    readonly status: number,
    readonly payload: { error: string; code?: string }
  ) {
    super(payload.error);
  }
}

/**
 * `PATCH /api/users-admin/{id}`: edit the handle and suspension state. The row is locked, the
 * change applied and its audit event written in one transaction; a no-op writes nothing.
 */
async function updateUser(
  request: HttpRequest,
  context: InvocationContext,
  adminUserId: number
): Promise<HttpResponseInit> {
  const userId = parseUserId(request.params.id);
  if (!userId) {
    return { status: 400, jsonBody: { error: "User id must be a positive integer" } };
  }
  context.log(`PATCH /api/users-admin/${userId}`);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { status: 400, jsonBody: { error: "Request body must be valid JSON" } };
  }

  const parsed = parseUserUpdate(body, adminUserId, userId);
  if (!parsed.ok) {
    return {
      status: parsed.status ?? 400,
      jsonBody: { error: parsed.error, ...(parsed.code ? { code: parsed.code } : {}) },
    };
  }
  const update = parsed.value;

  try {
    const outcome = await transaction(async (client) => {
      const current = await client.query<CurrentUserState>(
        `SELECT handle,
                suspended_at::text AS "suspendedAt",
                suspended_reason AS "suspendedReason"
         FROM app_user
         WHERE user_id = $1
         FOR UPDATE`,
        [userId]
      );
      if (current.rows.length === 0) return "not_found" as const;

      const planned = planUserUpdate(current.rows[0], update, adminUserId);
      if (!planned.ok) throw new UserUpdateConflict(400, { error: planned.error });
      const plan = planned.value;
      if (!plan) return "unchanged" as const;

      try {
        // setSql holds fixed fragments from planUserUpdate; every value is a bound parameter.
        await client.query(
          `UPDATE app_user
           SET ${plan.setSql.join(", ")}
           WHERE user_id = $1`,
          [userId, ...plan.params]
        );
      } catch (error: any) {
        if (error?.code === "23505") {
          throw new UserUpdateConflict(409, { error: "That handle is already taken", code: "handle_taken" });
        }
        throw error;
      }

      await recordAdminAuditEvent(client, {
        actorUserId: adminUserId,
        targetUserId: userId,
        action: plan.action,
        changes: plan.changes,
        note: update.note,
      });
      return plan.action;
    });

    if (outcome === "not_found") {
      return { status: 404, jsonBody: { error: "User not found" } };
    }
    if (outcome !== "unchanged") {
      trackEvent("admin.user_updated", { action: outcome, targetUserId: userId, actorUserId: adminUserId });
    }

    const detail = await loadAdminUserDetail(query, userId);
    if (!detail) {
      return { status: 404, jsonBody: { error: "User not found" } };
    }
    return { status: 200, jsonBody: detail satisfies AdminUserDetailResponse };
  } catch (error: any) {
    if (error instanceof UserUpdateConflict) {
      return { status: error.status, jsonBody: error.payload };
    }
    if (error?.code === "42P01" || error?.code === "42703") {
      return { status: 503, jsonBody: { error: "User-management migrations are not applied yet" } };
    }
    return internalServerError(context, error, "Failed to update user", "admin-users.update");
  }
}

app.http("admin-users-list", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "users-admin",
  handler: withCors(withAdmin(async (request, context) => listUsers(request, context))),
});

// One function per route: the Functions host refuses two functions on the same route template.
app.http("admin-users-item", {
  methods: ["GET", "PATCH", "OPTIONS"],
  authLevel: "anonymous",
  route: "users-admin/{id}",
  handler: withCors(
    withAdmin(async (request, context, adminUserId) =>
      request.method === "PATCH" ? updateUser(request, context, adminUserId) : getUser(request, context)
    )
  ),
});

app.http("admin-users-merge", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "users-admin/merge",
  handler: withCors(withAdmin(mergeUsers)),
});
