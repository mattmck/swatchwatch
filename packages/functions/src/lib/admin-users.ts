import type { PoolClient, QueryResultRow } from "pg";
import {
  ADMIN_USER_SORTS,
  ADMIN_USER_STATES,
  type AdminAuditAction,
  type AdminAuditEvent,
  type AdminUserDetailResponse,
  type AdminUserIdentity,
  type AdminUserListItem,
  type AdminUserSort,
  type AdminUserState,
  type AdminUserUpdateRequest,
} from "swatchwatch-shared";

/**
 * Admin user management (issue #45): list query parsing + SQL, PATCH validation and planning,
 * and the `admin_audit_event` writer. Handlers live in `functions/admin-users.ts`.
 *
 * Role is deliberately not editable: `getOrCreateUser` (lib/auth.ts) rewrites `app_user.role`
 * from the Entra `roles` claim on every sign-in, so Entra app-role assignment is authoritative.
 */

export const DEFAULT_LIST_LIMIT = 100;
export const MAX_LIST_LIMIT = 500;
export const MAX_QUERY_LENGTH = 200;
export const MAX_HANDLE_LENGTH = 64;
export const MAX_TEXT_LENGTH = 500;
export const AUDIT_EVENTS_IN_DETAIL = 20;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export interface ParsedListQuery {
  q?: string;
  role?: "user" | "admin";
  state?: AdminUserState;
  sort: AdminUserSort;
  dir: "asc" | "desc";
  limit: number;
  offset: number;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string; code?: string; status?: number };

/** Parse `GET /api/users-admin` query parameters. Unknown values are a 400, not silently ignored. */
export function parseListQuery(params: URLSearchParams): ParseResult<ParsedListQuery> {
  const q = params.get("q")?.trim() || undefined;
  if (q && q.length > MAX_QUERY_LENGTH) {
    return { ok: false, error: `q must be at most ${MAX_QUERY_LENGTH} characters` };
  }

  const roleRaw = params.get("role")?.trim() || undefined;
  if (roleRaw && roleRaw !== "user" && roleRaw !== "admin") {
    return { ok: false, error: "role must be 'user' or 'admin'" };
  }

  const stateRaw = params.get("state")?.trim() || undefined;
  if (stateRaw && !(ADMIN_USER_STATES as readonly string[]).includes(stateRaw)) {
    return { ok: false, error: `state must be one of: ${ADMIN_USER_STATES.join(", ")}` };
  }

  const sortRaw = params.get("sort")?.trim() || "created";
  if (!(ADMIN_USER_SORTS as readonly string[]).includes(sortRaw)) {
    return { ok: false, error: `sort must be one of: ${ADMIN_USER_SORTS.join(", ")}` };
  }

  const dirRaw = params.get("dir")?.trim().toLowerCase() || "desc";
  if (dirRaw !== "asc" && dirRaw !== "desc") {
    return { ok: false, error: "dir must be 'asc' or 'desc'" };
  }

  return {
    ok: true,
    value: {
      q,
      role: roleRaw as ParsedListQuery["role"],
      state: stateRaw as AdminUserState | undefined,
      sort: sortRaw as AdminUserSort,
      dir: dirRaw,
      limit: clampInt(params.get("limit"), DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT),
      offset: clampInt(params.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER),
    },
  };
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const text = raw?.trim() ?? "";
  if (!/^\d{1,15}$/.test(text)) return fallback;
  return Math.max(min, Math.min(max, Number(text)));
}

/** Escape `%`, `_` and `\` so user input is matched literally by `ILIKE ... ESCAPE '\'`. */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * WHERE clause (over `app_user u`) and bound params for the list filters. Every value is a bound
 * parameter; only fixed SQL fragments are concatenated.
 */
export function buildListFilter(parsed: Pick<ParsedListQuery, "q" | "role" | "state">): {
  whereSql: string;
  params: unknown[];
} {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (parsed.q) {
    params.push(`%${escapeLikePattern(parsed.q)}%`);
    const p = `$${params.length}`;
    const matches = [
      `u.email ILIKE ${p} ESCAPE '\\'`,
      `u.handle ILIKE ${p} ESCAPE '\\'`,
      `u.external_id ILIKE ${p} ESCAPE '\\'`,
      `EXISTS (SELECT 1 FROM user_external_identities uei
               WHERE uei.user_id = u.user_id
                 AND (uei.external_id ILIKE ${p} ESCAPE '\\' OR uei.email ILIKE ${p} ESCAPE '\\'))`,
    ];
    if (/^\d{1,15}$/.test(parsed.q)) {
      params.push(Number(parsed.q));
      matches.push(`u.user_id = $${params.length}`);
    }
    clauses.push(`(${matches.join(" OR ")})`);
  }

  if (parsed.role) {
    params.push(parsed.role);
    clauses.push(`COALESCE(u.role, 'user') = $${params.length}`);
  }

  if (parsed.state === "suspended") clauses.push("u.suspended_at IS NOT NULL");
  if (parsed.state === "active") clauses.push("u.suspended_at IS NULL");

  return { whereSql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

const SORT_SQL: Record<AdminUserSort, string> = {
  created: `"createdAtTs"`,
  lastSeen: `"lastSeenAtTs"`,
  email: `lower(COALESCE("email", "handle", ''))`,
  inventory: `"inventoryCountNum"`,
};

/**
 * ORDER BY over the output columns of `ADMIN_USER_SELECT` (apply it to a subquery selecting those
 * columns); user id breaks ties in the same direction.
 */
export function buildListOrder(parsed: Pick<ParsedListQuery, "sort" | "dir">): string {
  const dir = parsed.dir === "asc" ? "ASC" : "DESC";
  return `ORDER BY ${SORT_SQL[parsed.sort]} ${dir} NULLS LAST, "userId" ${dir}`;
}

/** Columns of one admin user row, over `app_user u`. Counts use correlated subqueries (no fan-out). */
export const ADMIN_USER_SELECT = `
  u.user_id AS "userId",
  COALESCE(u.role, 'user') AS role,
  u.email,
  u.external_id AS "externalId",
  u.handle,
  u.created_at AS "createdAtTs",
  u.created_at::text AS "createdAt",
  u.suspended_at::text AS "suspendedAt",
  u.suspended_reason AS "suspendedReason",
  u.suspended_by_user_id AS "suspendedByUserId",
  ls.last_seen_at AS "lastSeenAtTs",
  ls.last_seen_at::text AS "lastSeenAt",
  (SELECT COUNT(*) FROM user_inventory_item ui WHERE ui.user_id = u.user_id) AS "inventoryCountNum",
  (SELECT COUNT(*)::text FROM user_inventory_item ui WHERE ui.user_id = u.user_id) AS "inventoryCount",
  (SELECT COUNT(*)::text FROM user_submission us WHERE us.user_id = u.user_id) AS "submissionCount",
  (SELECT COUNT(*)::text FROM capture_session cs WHERE cs.user_id = u.user_id) AS "captureSessionCount",
  COALESCE(
    (SELECT array_agg(uei.external_id ORDER BY uei.created_at, uei.user_external_identity_id)
     FROM user_external_identities uei
     WHERE uei.user_id = u.user_id),
    ARRAY[]::text[]
  ) AS "linkedExternalIds"`;

/** FROM clause for `ADMIN_USER_SELECT`: last seen = latest sign-in on any linked identity. */
export const ADMIN_USER_FROM = `
  FROM app_user u
  LEFT JOIN LATERAL (
    SELECT MAX(uei.last_seen_at) AS last_seen_at
    FROM user_external_identities uei
    WHERE uei.user_id = u.user_id
  ) ls ON true`;

export interface AdminUserRow {
  userId: number | string;
  role: string | null;
  email: string | null;
  externalId: string | null;
  handle: string | null;
  createdAt: string;
  suspendedAt: string | null;
  suspendedReason: string | null;
  suspendedByUserId: number | string | null;
  lastSeenAt: string | null;
  inventoryCount: string;
  submissionCount: string;
  captureSessionCount: string;
  linkedExternalIds: string[] | null;
}

export function toAdminUserListItem(row: AdminUserRow): AdminUserListItem {
  const linkedExternalIds = [...(row.linkedExternalIds ?? [])];
  if (linkedExternalIds.length === 0 && row.externalId) {
    linkedExternalIds.push(row.externalId);
  }
  return {
    userId: Number(row.userId),
    role: row.role || "user",
    email: row.email || undefined,
    externalId: row.externalId || undefined,
    linkedExternalIds,
    handle: row.handle || undefined,
    createdAt: row.createdAt,
    inventoryCount: Number.parseInt(row.inventoryCount, 10) || 0,
    submissionCount: Number.parseInt(row.submissionCount, 10) || 0,
    captureSessionCount: Number.parseInt(row.captureSessionCount, 10) || 0,
    state: row.suspendedAt ? "suspended" : "active",
    suspendedAt: row.suspendedAt || undefined,
    lastSeenAt: row.lastSeenAt || undefined,
  };
}

/** Parse a `{id}` route segment: digits only, safe positive integer. */
export function parseUserId(raw: unknown): number | null {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!/^\d{1,15}$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export interface ParsedUserUpdate {
  handle?: string;
  suspended?: boolean;
  /** `null` clears the reason; `undefined` leaves it. */
  suspendedReason?: string | null;
  note?: string;
}

const UPDATE_FIELDS = new Set<keyof AdminUserUpdateRequest>(["handle", "suspended", "suspendedReason", "note"]);

function parseOptionalText(value: unknown, field: string): ParseResult<string | undefined> {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value !== "string") return { ok: false, error: `${field} must be a string` };
  const trimmed = value.trim();
  if (trimmed.length > MAX_TEXT_LENGTH) {
    return { ok: false, error: `${field} must be at most ${MAX_TEXT_LENGTH} characters` };
  }
  return { ok: true, value: trimmed.length > 0 ? trimmed : undefined };
}

/**
 * Validate a `PATCH /api/users-admin/{id}` body. `actorUserId === targetUserId` with
 * `suspended: true` is refused (409 `cannot_modify_self`): an admin must not lock themselves out.
 */
export function parseUserUpdate(
  body: unknown,
  actorUserId: number,
  targetUserId: number
): ParseResult<ParsedUserUpdate> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Request body must be a JSON object" };
  }
  const input = body as Record<string, unknown>;

  if ("role" in input) {
    return {
      ok: false,
      code: "role_managed_in_entra",
      error: "role is assigned in Entra (app role 'admin') and re-synced on every sign-in; it cannot be edited here",
    };
  }
  const unknown = Object.keys(input).filter((key) => !UPDATE_FIELDS.has(key as keyof AdminUserUpdateRequest));
  if (unknown.length > 0) {
    return { ok: false, error: `Unknown field(s): ${unknown.join(", ")}` };
  }

  const update: ParsedUserUpdate = {};

  if (input.handle !== undefined) {
    if (typeof input.handle !== "string") return { ok: false, error: "handle must be a string" };
    const handle = input.handle.trim();
    if (handle.length === 0 || handle.length > MAX_HANDLE_LENGTH) {
      return { ok: false, error: `handle must be 1–${MAX_HANDLE_LENGTH} characters` };
    }
    if (CONTROL_CHARS.test(handle)) return { ok: false, error: "handle must not contain control characters" };
    update.handle = handle;
  }

  if (input.suspended !== undefined) {
    if (typeof input.suspended !== "boolean") return { ok: false, error: "suspended must be a boolean" };
    update.suspended = input.suspended;
  }

  if (input.suspendedReason !== undefined) {
    const reason = parseOptionalText(input.suspendedReason, "suspendedReason");
    if (!reason.ok) return reason;
    if (update.suspended === false) {
      return { ok: false, error: "suspendedReason cannot be set when reactivating an account" };
    }
    update.suspendedReason = reason.value ?? null;
  }

  const note = parseOptionalText(input.note, "note");
  if (!note.ok) return note;
  if (note.value) update.note = note.value;

  if (update.handle === undefined && update.suspended === undefined && update.suspendedReason === undefined) {
    return { ok: false, error: "Nothing to update: send handle, suspended or suspendedReason" };
  }

  if (update.suspended === true && actorUserId === targetUserId) {
    return { ok: false, status: 409, code: "cannot_modify_self", error: "You cannot suspend your own account" };
  }

  return { ok: true, value: update };
}

export interface CurrentUserState {
  handle: string | null;
  suspendedAt: string | null;
  suspendedReason: string | null;
}

export interface UserUpdatePlan {
  /** SET fragments over app_user; their placeholders start at `$2` (`$1` is the user id). */
  setSql: string[];
  params: unknown[];
  action: AdminAuditAction;
  changes: Record<string, { from: unknown; to: unknown }>;
}

/**
 * Turn a validated update into SQL SET fragments and the audit diff. Returns `null` when nothing
 * would change (a no-op PATCH writes neither the row nor an audit event). `$1` is reserved for
 * the target user id; `params` bind `$2…` in order (only values a fragment uses, since Postgres
 * cannot type an unreferenced parameter).
 */
export function planUserUpdate(
  current: CurrentUserState,
  update: ParsedUserUpdate,
  actorUserId: number
): ParseResult<UserUpdatePlan | null> {
  const setSql: string[] = [];
  const params: unknown[] = [];
  const changes: UserUpdatePlan["changes"] = {};
  const isSuspended = current.suspendedAt !== null;
  let action: AdminAuditAction = "user.update";
  const bind = (value: unknown) => {
    params.push(value);
    return `$${params.length + 1}`;
  };

  if (update.handle !== undefined && update.handle !== current.handle) {
    setSql.push(`handle = ${bind(update.handle)}`);
    changes.handle = { from: current.handle, to: update.handle };
  }

  if (update.suspended === true && !isSuspended) {
    const reason = update.suspendedReason ?? null;
    setSql.push("suspended_at = now()", `suspended_reason = ${bind(reason)}`, `suspended_by_user_id = ${bind(actorUserId)}`);
    changes.suspended = { from: false, to: true };
    if (reason !== null) changes.suspendedReason = { from: current.suspendedReason, to: reason };
    action = "user.suspend";
  } else if (update.suspended === false && isSuspended) {
    setSql.push("suspended_at = NULL", "suspended_reason = NULL", "suspended_by_user_id = NULL");
    changes.suspended = { from: true, to: false };
    if (current.suspendedReason !== null) changes.suspendedReason = { from: current.suspendedReason, to: null };
    action = "user.unsuspend";
  } else if (update.suspendedReason !== undefined) {
    if (!isSuspended) {
      return { ok: false, error: "suspendedReason can only be set on a suspended account" };
    }
    if (update.suspendedReason !== current.suspendedReason) {
      setSql.push(`suspended_reason = ${bind(update.suspendedReason)}`);
      changes.suspendedReason = { from: current.suspendedReason, to: update.suspendedReason };
    }
  }

  if (setSql.length === 0) return { ok: true, value: null };
  return { ok: true, value: { setSql, params, action, changes } };
}

export interface AuditEventInput {
  actorUserId: number;
  targetUserId: number | null;
  action: AdminAuditAction;
  changes: Record<string, unknown>;
  note?: string | null;
}

/** Insert one `admin_audit_event` row inside the caller's transaction. */
export async function recordAdminAuditEvent(client: Pick<PoolClient, "query">, event: AuditEventInput): Promise<void> {
  await client.query(
    `INSERT INTO admin_audit_event (actor_user_id, target_user_id, action, changes, note)
     VALUES ($1, $2, $3, $4::jsonb, $5)`,
    [event.actorUserId, event.targetUserId, event.action, JSON.stringify(event.changes), event.note ?? null]
  );
}

type QueryFn = <T extends QueryResultRow>(sql: string, params: unknown[]) => Promise<{ rows: T[] }>;

/** Load the full detail payload for one user, or `null` when the user does not exist. */
export async function loadAdminUserDetail(run: QueryFn, userId: number): Promise<AdminUserDetailResponse | null> {
  const userResult = await run<AdminUserRow>(
    `SELECT ${ADMIN_USER_SELECT}
     ${ADMIN_USER_FROM}
     WHERE u.user_id = $1`,
    [userId]
  );
  const row = userResult.rows[0];
  if (!row) return null;

  const [identities, audit] = await Promise.all([
    run<{ externalId: string; email: string | null; createdAt: string; lastSeenAt: string }>(
      `SELECT external_id AS "externalId", email, created_at::text AS "createdAt", last_seen_at::text AS "lastSeenAt"
       FROM user_external_identities
       WHERE user_id = $1
       ORDER BY created_at ASC, user_external_identity_id ASC`,
      [userId]
    ),
    run<{
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
       WHERE e.target_user_id = $1
       ORDER BY e.created_at DESC, e.admin_audit_event_id DESC
       LIMIT $2`,
      [userId, AUDIT_EVENTS_IN_DETAIL]
    ),
  ]);

  return {
    user: toAdminUserListItem(row),
    identities: identities.rows.map(
      (identity): AdminUserIdentity => ({
        externalId: identity.externalId,
        email: identity.email || undefined,
        createdAt: identity.createdAt,
        lastSeenAt: identity.lastSeenAt,
      })
    ),
    suspendedReason: row.suspendedReason || undefined,
    suspendedByUserId: row.suspendedByUserId === null ? undefined : Number(row.suspendedByUserId),
    auditEvents: audit.rows.map(
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
