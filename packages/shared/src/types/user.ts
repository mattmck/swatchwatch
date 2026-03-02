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

export interface AdminUserMergeRequest {
  sourceUserId: number;
  targetUserId: number;
}

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

export interface AdminUserListResponse {
  users: AdminUserListItem[];
  total: number;
}

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
