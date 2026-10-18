export interface User {
  id: string;
  externalId?: string;
  email?: string;
  displayName: string;
  avatarUrl?: string;
  authProvider: AuthProvider;
  createdAt: string;
  updatedAt: string;
}

export type AuthProvider = "apple" | "facebook" | "google" | "email";

export interface AuthConfig {
  authority: string;
  clientId: string;
  knownAuthorities: string[];
  redirectUri: string;
  scopes: string[];
}

/**
 * Admin request payload to merge a duplicate account into a primary account.
 * `sourceUserId` is deleted after transfer; `targetUserId` is retained.
 */
export interface AdminUserMergeRequest {
  sourceUserId: number;
  targetUserId: number;
}

/**
 * Admin-facing user row used by the user-management table.
 * Includes identity metadata and quick activity counts used to evaluate merge targets.
 */
export interface AdminUserListItem {
  userId: number;
  role: string;
  email?: string;
  externalId?: string;
  linkedExternalIds: string[];
  handle?: string;
  createdAt: string;
  inventoryCount: number;
  submissionCount: number;
  captureSessionCount: number;
  /** Account state (issue #45): `suspended` when an admin suspended it, else `active`. */
  state: AdminUserState;
  /** When the account was suspended (ISO timestamp), only while suspended. */
  suspendedAt?: string;
  /** Latest sign-in seen on any linked identity (ISO timestamp); absent when never seen. */
  lastSeenAt?: string;
}

/** Account state shown and filtered in admin user management (issue #45). */
export type AdminUserState = "active" | "suspended";

export const ADMIN_USER_STATES: readonly AdminUserState[] = ["active", "suspended"];

/** Sort keys accepted by `GET /api/users-admin?sort=` (issue #45). */
export type AdminUserSort = "created" | "lastSeen" | "email" | "inventory";

export const ADMIN_USER_SORTS: readonly AdminUserSort[] = ["created", "lastSeen", "email", "inventory"];

/**
 * Query for `GET /api/users-admin` (issue #45). All fields optional; `q` matches email, handle,
 * external ids (case-insensitive substring) or an exact numeric user id.
 */
export interface AdminUserListQuery {
  q?: string;
  role?: "user" | "admin";
  state?: AdminUserState;
  sort?: AdminUserSort;
  dir?: "asc" | "desc";
  /** Page size, 1–500 (default 100). */
  limit?: number;
  offset?: number;
}

/**
 * Response shape for listing users in admin user management.
 * `users` contains the current page of rows and `total` counts every row matching the filters.
 */
export interface AdminUserListResponse {
  users: AdminUserListItem[];
  total: number;
  limit?: number;
  offset?: number;
}

/** One external sign-in identity linked to an account (`user_external_identities`). */
export interface AdminUserIdentity {
  externalId: string;
  email?: string;
  createdAt: string;
  lastSeenAt: string;
}

/** Actions recorded in `admin_audit_event` (issue #45). */
export type AdminAuditAction = "user.update" | "user.suspend" | "user.unsuspend" | "user.merge";

/** One audit row: who (`actorUserId`) did what to which user, and when. */
export interface AdminAuditEvent {
  auditEventId: number;
  actorUserId: number;
  /** Actor's email or handle when the account still exists. */
  actorLabel?: string;
  targetUserId?: number;
  action: AdminAuditAction;
  /** `{ field: { from, to } }` for updates; merge counters for `user.merge`. */
  changes: Record<string, unknown>;
  note?: string;
  createdAt: string;
}

/** Response of `GET /api/users-admin/{id}` and `PATCH /api/users-admin/{id}` (issue #45). */
export interface AdminUserDetailResponse {
  user: AdminUserListItem;
  identities: AdminUserIdentity[];
  suspendedReason?: string;
  suspendedByUserId?: number;
  /** Newest first, at most 20. */
  auditEvents: AdminAuditEvent[];
}

/**
 * Body of `PATCH /api/users-admin/{id}` (issue #45). Send only the fields to change.
 * - `handle`: display handle, 1–64 characters, unique (409 when taken).
 * - `suspended`: suspend / reactivate. An admin cannot suspend their own account (409).
 * - `suspendedReason`: optional reason stored with a suspension (≤ 500 characters).
 * - `note`: optional audit note (≤ 500 characters).
 * `role` is not editable: it is assigned in Entra (app role `admin`) and re-synced from the token
 * on every sign-in, so the API rejects it with 400.
 */
export interface AdminUserUpdateRequest {
  handle?: string;
  suspended?: boolean;
  suspendedReason?: string | null;
  note?: string;
}

/**
 * Response payload for admin duplicate-account merge operations.
 * `merged` indicates success/failure and `message` is user-facing status text.
 * Count fields describe rows transferred by domain; `mergedInventoryDuplicateRows`
 * reports inventory rows consolidated due to same-user/same-shade collisions.
 * `targetRole` is optional and reflects the resulting role on the kept account.
 */
export interface AdminUserMergeResponse {
  merged: boolean;
  sourceUserId: number;
  targetUserId: number;
  mergedByUserId: number;
  mergedInventoryRows: number;
  mergedIdentityRows: number;
  mergedSubmissionRows: number;
  mergedCaptureRows: number;
  mergedCaptureAnswerRows: number;
  mergedClickEventRows: number;
  message: string;
  mergedInventoryDuplicateRows?: number;
  /** Mani-log manicures moved from the source account (issue #269). */
  mergedManicureRows?: number;
  targetRole?: string;
}
