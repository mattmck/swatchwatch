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
}

/**
 * Response shape for listing users in admin user management.
 * `users` contains the current page of rows and `total` is the full user count.
 */
export interface AdminUserListResponse {
  users: AdminUserListItem[];
  total: number;
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
  targetRole?: string;
}
