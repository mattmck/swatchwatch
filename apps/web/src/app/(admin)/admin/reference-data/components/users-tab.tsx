"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AdminUserListItem, AdminUserMergeResponse } from "swatchwatch-shared";
import { listAdminUsers, mergeAdminUsers } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const NUMERIC_ID_PATTERN = /^\d+$/;

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

/**
 * Filter admin users by free-text query across key identity fields.
 *
 * @param users Full user list returned from the admin API.
 * @param query Free-text query entered in the search input.
 * @returns Filtered subset preserving original order.
 */
export function filterUsersByQuery(users: AdminUserListItem[], query: string): AdminUserListItem[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return users;
  return users.filter((user) => {
    const haystack = [
      String(user.userId),
      user.email ?? "",
      user.handle ?? "",
      user.role,
      user.externalId ?? "",
      user.linkedExternalIds.join(" "),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(normalized);
  });
}

/**
 * Parse and validate source/target user IDs for account merges.
 *
 * @param sourceRaw Raw source ID input value.
 * @param targetRaw Raw target ID input value.
 * @returns Parsed IDs or a user-facing validation error message.
 */
function parseMergeIds(
  sourceRaw: string,
  targetRaw: string
): { source: number; target: number } | { error: string } {
  const sourceValue = sourceRaw.trim();
  const targetValue = targetRaw.trim();

  if (!NUMERIC_ID_PATTERN.test(sourceValue) || !NUMERIC_ID_PATTERN.test(targetValue)) {
    return { error: "Source and target user IDs must be numeric values." };
  }

  const source = Number.parseInt(sourceValue, 10);
  const target = Number.parseInt(targetValue, 10);

  if (source <= 0 || target <= 0) {
    return { error: "Source and target user IDs must be positive numbers." };
  }

  if (source === target) {
    return { error: "Source and target user IDs must be different." };
  }

  return { source, target };
}

/**
 * Fetch users and update the component state holders.
 *
 * @param params.listUsers API request function.
 * @param params.isMounted Guard to avoid state updates after unmount.
 * @param params.setIsLoading Setter for loading state.
 * @param params.setLoadError Setter for load error message.
 * @param params.setUsers Setter for users collection.
 */
export async function loadUsersState(params: {
  listUsers: typeof listAdminUsers;
  isMounted: () => boolean;
  setIsLoading: (loading: boolean) => void;
  setLoadError: (message: string | null) => void;
  setUsers: (users: AdminUserListItem[]) => void;
}): Promise<void> {
  const { listUsers: listUsersFn, isMounted, setIsLoading, setLoadError, setUsers } = params;

  try {
    if (isMounted()) {
      setIsLoading(true);
      setLoadError(null);
    }
    const response = await listUsersFn({ limit: 500 });
    if (isMounted()) {
      setUsers(response.users);
    }
  } catch (error) {
    if (isMounted()) {
      setLoadError(error instanceof Error ? error.message : "Failed to load users");
    }
  } finally {
    if (isMounted()) {
      setIsLoading(false);
    }
  }
}

/**
 * Validate, confirm, and execute an admin merge operation.
 *
 * @param params.sourceUserId Raw source ID input.
 * @param params.targetUserId Raw target ID input.
 * @param params.confirm Confirmation gate callback (e.g. window.confirm).
 * @param params.mergeUsers API call to execute merge.
 * @param params.refreshUsers Callback to refresh the users table.
 * @param params.setMergeError Setter for merge error state.
 * @param params.setMergePending Setter for in-flight merge state.
 * @param params.setLastMergeResult Setter for latest merge result.
 * @param params.setSourceUserId Setter for source input field.
 * @param params.setTargetUserId Setter for target input field.
 */
export async function handleMergeAction(params: {
  sourceUserId: string;
  targetUserId: string;
  confirm: () => boolean;
  mergeUsers: typeof mergeAdminUsers;
  refreshUsers: () => Promise<void>;
  setMergeError: (message: string | null) => void;
  setMergePending: (pending: boolean) => void;
  setLastMergeResult: (result: AdminUserMergeResponse | null) => void;
  setSourceUserId: (value: string) => void;
  setTargetUserId: (value: string) => void;
}): Promise<void> {
  const parsed = parseMergeIds(params.sourceUserId, params.targetUserId);
  if ("error" in parsed) {
    params.setMergeError(parsed.error);
    return;
  }

  if (!params.confirm()) {
    return;
  }

  try {
    params.setMergePending(true);
    params.setMergeError(null);
    const response = await params.mergeUsers({
      sourceUserId: parsed.source,
      targetUserId: parsed.target,
    });
    params.setLastMergeResult(response);
    params.setSourceUserId("");
    params.setTargetUserId("");
    await params.refreshUsers();
  } catch (error) {
    params.setMergeError(error instanceof Error ? error.message : "Failed to merge users");
  } finally {
    params.setMergePending(false);
  }
}

/**
 * Admin UI for user account management and duplicate-account merges.
 *
 * @returns A tab panel with user search, merge controls, and merge status feedback.
 */
export function UsersTab() {
  const mountedRef = useRef(true);
  const [users, setUsers] = useState<AdminUserListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sourceUserId, setSourceUserId] = useState("");
  const [targetUserId, setTargetUserId] = useState("");
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [mergePending, setMergePending] = useState(false);
  const [lastMergeResult, setLastMergeResult] = useState<AdminUserMergeResponse | null>(null);

  /**
   * Load users from the admin API and synchronize loading/error state.
   */
  const loadUsers = useCallback(async () => {
    await loadUsersState({
      listUsers: listAdminUsers,
      isMounted: () => mountedRef.current,
      setIsLoading,
      setLoadError,
      setUsers,
    });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void loadUsers();
    return () => {
      mountedRef.current = false;
    };
  }, [loadUsers]);

  /**
   * Memoized filtered users derived from the active query.
   */
  const filteredUsersMemo = useMemo(() => filterUsersByQuery(users, query), [query, users]);

  /**
   * Validate and run a user merge after explicit admin confirmation.
   */
  async function handleMerge() {
    await handleMergeAction({
      sourceUserId,
      targetUserId,
      confirm: () => window.confirm(
        `Merge user ${sourceUserId.trim() || "?"} into ${targetUserId.trim() || "?"}? This cannot be undone.`
      ),
      mergeUsers: mergeAdminUsers,
      refreshUsers: loadUsers,
      setMergeError,
      setMergePending,
      setLastMergeResult,
      setSourceUserId,
      setTargetUserId,
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Badge variant="outline">{filteredUsersMemo.length} users</Badge>
        <Button variant="outline" onClick={() => void loadUsers()} disabled={isLoading}>
          {isLoading ? "Refreshing…" : "Refresh"}
        </Button>
      </div>

      <Input
        placeholder="Search users by id, email, handle, role, or external id"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />

      <div className="grid gap-2 md:grid-cols-3">
        <Input
          placeholder="Source user ID (to delete)"
          value={sourceUserId}
          onChange={(event) => setSourceUserId(event.target.value)}
        />
        <Input
          placeholder="Target user ID (to keep)"
          value={targetUserId}
          onChange={(event) => setTargetUserId(event.target.value)}
        />
        <Button onClick={() => void handleMerge()} disabled={mergePending}>
          {mergePending ? "Merging…" : "Merge Users"}
        </Button>
      </div>

      {loadError && <p className="text-sm text-destructive">{loadError}</p>}
      {mergeError && <p className="text-sm text-destructive">{mergeError}</p>}

      {lastMergeResult && (
        <div className="rounded-md border bg-muted/20 p-3 text-sm">
          <p className="font-medium">{lastMergeResult.message}</p>
          <p className="text-muted-foreground">
            Inventory moved: {lastMergeResult.mergedInventoryRows} (duplicates consolidated: {lastMergeResult.mergedInventoryDuplicateRows ?? 0})
            {" • "}Identities moved: {lastMergeResult.mergedIdentityRows}
            {" • "}Submissions moved: {lastMergeResult.mergedSubmissionRows}
            {" • "}Capture sessions moved: {lastMergeResult.mergedCaptureRows}
          </p>
        </div>
      )}

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Linked identities</TableHead>
              <TableHead className="text-right">Inventory</TableHead>
              <TableHead className="text-right">Submissions</TableHead>
              <TableHead className="text-right">Capture</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!isLoading && filteredUsersMemo.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-muted-foreground">
                  No users found.
                </TableCell>
              </TableRow>
            )}
            {isLoading && (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-muted-foreground">
                  Loading users…
                </TableCell>
              </TableRow>
            )}
            {filteredUsersMemo.map((user) => (
              <TableRow key={user.userId}>
                <TableCell>
                  <div className="font-medium">#{user.userId}</div>
                  {user.handle && <div className="text-xs text-muted-foreground">{user.handle}</div>}
                </TableCell>
                <TableCell>{user.email ?? "—"}</TableCell>
                <TableCell>
                  <Badge variant="outline">{user.role}</Badge>
                </TableCell>
                <TableCell className="max-w-[320px]">
                  <div className="truncate text-xs text-muted-foreground" title={user.linkedExternalIds.join(", ")}>
                    {user.linkedExternalIds.length > 0 ? user.linkedExternalIds.join(", ") : "—"}
                  </div>
                </TableCell>
                <TableCell className="text-right">{user.inventoryCount}</TableCell>
                <TableCell className="text-right">{user.submissionCount}</TableCell>
                <TableCell className="text-right">{user.captureSessionCount}</TableCell>
                <TableCell>{formatDateTime(user.createdAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
