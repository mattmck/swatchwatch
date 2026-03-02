import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type {
  AdminUserListItem,
  AdminUserListResponse,
  AdminUserMergeRequest,
  AdminUserMergeResponse,
} from "swatchwatch-shared";
import { withAdmin } from "../lib/auth";
import { query, transaction } from "../lib/db";
import { withCors } from "../lib/http";

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
  context.log("POST /api/admin/users/merge");

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

  try {
    const result = await transaction<AdminUserMergeResponse>(async (client) => {
      const users = await client.query<{
        userId: number;
        role: string | null;
        email: string | null;
        externalId: string | null;
      }>(
        `SELECT
           user_id AS "userId",
           COALESCE(role, 'user') AS role,
           email,
           external_id AS "externalId"
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

      const sourceUser = users.rows.find((row) => row.userId === sourceUserId)!;
      const targetUser = users.rows.find((row) => row.userId === targetUserId)!;
      const mergedTargetRole = targetUser.role === "admin" || sourceUser.role === "admin"
        ? "admin"
        : (targetUser.role || "user");

      const mergeDuplicateInventory = await client.query(
        `UPDATE user_inventory_item target
         SET quantity = target.quantity + source.quantity
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

      await client.query(
        `UPDATE app_settings
         SET updated_by = NULL
         WHERE updated_by = $1`,
        [sourceUserId]
      );

      await client.query(
        `DELETE FROM app_user
         WHERE user_id = $1`,
        [sourceUserId]
      );

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

function parseListLimit(value: string | null): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return 100;
  return Math.max(1, Math.min(500, parsed));
}

async function listUsers(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  context.log("GET /api/admin/users");

  const limit = parseListLimit(new URL(request.url).searchParams.get("limit"));

  try {
    const countResult = await query<{ total: string }>(
      `SELECT COUNT(*)::text AS total
       FROM app_user`
    );

    const usersResult = await query<{
      userId: number;
      role: string | null;
      email: string | null;
      externalId: string | null;
      handle: string | null;
      createdAt: string;
      inventoryCount: string;
      submissionCount: string;
      captureSessionCount: string;
    }>(
      `SELECT
         u.user_id AS "userId",
         COALESCE(u.role, 'user') AS role,
         u.email,
         u.external_id AS "externalId",
         u.handle,
         u.created_at::text AS "createdAt",
         COUNT(DISTINCT ui.inventory_item_id)::text AS "inventoryCount",
         COUNT(DISTINCT us.submission_id)::text AS "submissionCount",
         COUNT(DISTINCT cs.capture_session_id)::text AS "captureSessionCount"
       FROM app_user u
       LEFT JOIN user_inventory_item ui ON ui.user_id = u.user_id
       LEFT JOIN user_submission us ON us.user_id = u.user_id
       LEFT JOIN capture_session cs ON cs.user_id = u.user_id
       GROUP BY u.user_id, u.role, u.email, u.external_id, u.handle, u.created_at
       ORDER BY u.user_id ASC
       LIMIT $1`,
      [limit]
    );

    const userIds = usersResult.rows.map((row) => row.userId);
    const identityMap = new Map<number, string[]>();

    if (userIds.length > 0) {
      try {
        const identitiesResult = await query<{
          userId: number;
          externalId: string;
        }>(
          `SELECT user_id AS "userId", external_id AS "externalId"
           FROM user_external_identities
           WHERE user_id = ANY($1::bigint[])
           ORDER BY user_id ASC, created_at ASC, user_external_identity_id ASC`,
          [userIds]
        );

        for (const row of identitiesResult.rows) {
          const existing = identityMap.get(row.userId) || [];
          existing.push(row.externalId);
          identityMap.set(row.userId, existing);
        }
      } catch (identityError: any) {
        if (identityError?.code !== "42P01") {
          throw identityError;
        }
      }
    }

    const users: AdminUserListItem[] = usersResult.rows.map((row) => {
      const linkedExternalIds = identityMap.get(row.userId) ?? [];
      if (linkedExternalIds.length === 0 && row.externalId) {
        linkedExternalIds.push(row.externalId);
      }

      return {
        userId: row.userId,
        role: row.role || "user",
        email: row.email || undefined,
        externalId: row.externalId || undefined,
        linkedExternalIds,
        handle: row.handle || undefined,
        createdAt: row.createdAt,
        inventoryCount: Number.parseInt(row.inventoryCount, 10) || 0,
        submissionCount: Number.parseInt(row.submissionCount, 10) || 0,
        captureSessionCount: Number.parseInt(row.captureSessionCount, 10) || 0,
      };
    });

    return {
      status: 200,
      jsonBody: {
        users,
        total: Number.parseInt(countResult.rows[0]?.total ?? "0", 10) || 0,
      } satisfies AdminUserListResponse,
    };
  } catch (error) {
    context.error("Error listing users:", error);
    return {
      status: 500,
      jsonBody: { error: "Failed to list users" },
    };
  }
}

app.http("admin-users-list", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "admin/users",
  handler: withCors(withAdmin(async (request, context) => listUsers(request, context))),
});

app.http("admin-users-merge", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "admin/users/merge",
  handler: withCors(withAdmin(mergeUsers)),
});
