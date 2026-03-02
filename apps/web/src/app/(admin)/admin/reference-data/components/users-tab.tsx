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

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

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

  const loadUsers = useCallback(async () => {
    try {
      if (mountedRef.current) {
        setIsLoading(true);
        setLoadError(null);
      }
      const response = await listAdminUsers({ limit: 500 });
      if (mountedRef.current) {
        setUsers(response.users);
      }
    } catch (error) {
      if (mountedRef.current) {
        setLoadError(error instanceof Error ? error.message : "Failed to load users");
      }
    } finally {
      if (mountedRef.current) {
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void loadUsers();
    return () => {
      mountedRef.current = false;
    };
  }, [loadUsers]);

  const filteredUsers = useMemo(() => {
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
  }, [query, users]);

  async function handleMerge() {
    const source = Number.parseInt(sourceUserId, 10);
    const target = Number.parseInt(targetUserId, 10);
    if (!Number.isFinite(source) || !Number.isFinite(target) || source <= 0 || target <= 0) {
      setMergeError("Source and target user IDs must be positive numbers.");
      return;
    }

    try {
      setMergePending(true);
      setMergeError(null);
      const response = await mergeAdminUsers({ sourceUserId: source, targetUserId: target });
      setLastMergeResult(response);
      setSourceUserId("");
      setTargetUserId("");
      await loadUsers();
    } catch (error) {
      setMergeError(error instanceof Error ? error.message : "Failed to merge users");
    } finally {
      setMergePending(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Badge variant="outline">{filteredUsers.length} users</Badge>
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
            {!isLoading && filteredUsers.length === 0 && (
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
            {filteredUsers.map((user) => (
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
