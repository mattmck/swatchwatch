"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AdminUserListItem,
  AdminUserListQuery,
  AdminUserListResponse,
  AdminUserMergeResponse,
  AdminUserSort,
  AdminUserState,
} from "swatchwatch-shared";
import { getCurrentUserId, listAdminUsers, mergeAdminUsers } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime, UserDetailDialog } from "./user-detail-dialog";

const NUMERIC_ID_PATTERN = /^\d+$/;
export const USERS_PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;

/** Filter/sort/page state of the user table; `"all"` means no filter. */
export interface UserTableFilters {
  q: string;
  role: "all" | "user" | "admin";
  state: "all" | AdminUserState;
  sort: AdminUserSort;
  dir: "asc" | "desc";
  page: number;
}

export const DEFAULT_USER_TABLE_FILTERS: UserTableFilters = {
  q: "",
  role: "all",
  state: "all",
  sort: "created",
  dir: "desc",
  page: 0,
};

/**
 * Map table filters to the `GET /api/users-admin` query (server-side search, issue #45).
 *
 * @param filters Current table filter state.
 * @returns The API query with `"all"` filters omitted and the page turned into an offset.
 */
export function buildUserListQuery(filters: UserTableFilters): AdminUserListQuery {
  const query: AdminUserListQuery = {
    sort: filters.sort,
    dir: filters.dir,
    limit: USERS_PAGE_SIZE,
    offset: filters.page * USERS_PAGE_SIZE,
  };
  const q = filters.q.trim();
  if (q) query.q = q;
  if (filters.role !== "all") query.role = filters.role;
  if (filters.state !== "all") query.state = filters.state;
  return query;
}

/**
 * Human-readable "41–60 of 75" range for the pager.
 *
 * @param page Zero-based page index.
 * @param shown Rows on the current page.
 * @param total Rows matching the filters.
 */
export function describePageRange(page: number, shown: number, total: number): string {
  if (total === 0 || shown === 0) return `0 of ${total}`;
  const start = page * USERS_PAGE_SIZE + 1;
  return `${start}–${start + shown - 1} of ${total}`;
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
 * Fetch one page of users and update the component state holders.
 *
 * @param params.listUsers API request function.
 * @param params.query Server-side search/filter/sort/page query.
 * @param params.isMounted Guard to avoid state updates after unmount.
 * @param params.setIsLoading Setter for loading state.
 * @param params.setLoadError Setter for load error message.
 * @param params.setResult Setter for the page of users and the filtered total.
 */
export async function loadUsersState(params: {
  listUsers: typeof listAdminUsers;
  query: AdminUserListQuery;
  isMounted: () => boolean;
  setIsLoading: (loading: boolean) => void;
  setLoadError: (message: string | null) => void;
  setResult: (result: AdminUserListResponse) => void;
}): Promise<void> {
  const { listUsers: listUsersFn, query, isMounted, setIsLoading, setLoadError, setResult } = params;

  try {
    if (isMounted()) {
      setIsLoading(true);
      setLoadError(null);
    }
    const response = await listUsersFn(query);
    if (isMounted()) {
      setResult(response);
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

function StateBadge({ user }: { user: AdminUserListItem }) {
  return user.state === "suspended" ? (
    <Badge variant="destructive">Suspended</Badge>
  ) : (
    <Badge variant="secondary">Active</Badge>
  );
}

/**
 * Admin UI for user management (issue #45): server-side searchable, filterable, sortable user
 * table, a per-user detail dialog (edit handle, suspend/reactivate, identities, audit history),
 * and duplicate-account merges.
 *
 * @returns The User Management tab panel.
 */
export function UsersTab() {
  const mountedRef = useRef(true);
  const [filters, setFilters] = useState<UserTableFilters>(DEFAULT_USER_TABLE_FILTERS);
  const [searchInput, setSearchInput] = useState("");
  const [result, setResult] = useState<AdminUserListResponse>({ users: [], total: 0 });
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null);
  const [currentUserId, setCurrentUserId] = useState<number | null>(null);
  const [sourceUserId, setSourceUserId] = useState("");
  const [targetUserId, setTargetUserId] = useState("");
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [mergePending, setMergePending] = useState(false);
  const [lastMergeResult, setLastMergeResult] = useState<AdminUserMergeResponse | null>(null);

  /**
   * Load the current page from the admin API and synchronize loading/error state.
   */
  const loadUsers = useCallback(async () => {
    await loadUsersState({
      listUsers: listAdminUsers,
      query: buildUserListQuery(filters),
      isMounted: () => mountedRef.current,
      setIsLoading,
      setLoadError,
      setResult,
    });
  }, [filters]);

  useEffect(() => {
    mountedRef.current = true;
    void loadUsers();
    return () => {
      mountedRef.current = false;
    };
  }, [loadUsers]);

  useEffect(() => {
    void getCurrentUserId({ admin: true })
      .then((id) => {
        if (mountedRef.current) setCurrentUserId(id);
      })
      .catch(() => undefined);
  }, []);

  // Debounce the search box into the server-side `q` filter (back to the first page).
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setFilters((current) => (current.q === searchInput ? current : { ...current, q: searchInput, page: 0 }));
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  function updateFilter<K extends keyof UserTableFilters>(key: K, value: UserTableFilters[K]) {
    setFilters((current) => ({ ...current, [key]: value, page: key === "page" ? (value as number) : 0 }));
  }

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

  const { users, total } = result;
  const hasNextPage = (filters.page + 1) * USERS_PAGE_SIZE < total;

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Badge variant="outline">{total} {total === 1 ? "user" : "users"}</Badge>
          <Button variant="outline" onClick={() => void loadUsers()} disabled={isLoading}>
            {isLoading ? "Refreshing…" : "Refresh"}
          </Button>
        </div>

        <div className="grid gap-2 md:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))_auto]">
          <Input
            type="search"
            aria-label="Search users"
            placeholder="Search by email, handle, user id, or external id"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
          />
          <Select value={filters.role} onValueChange={(value) => updateFilter("role", value as UserTableFilters["role"])}>
            <SelectTrigger aria-label="Filter by role">
              <SelectValue placeholder="All roles" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All roles</SelectItem>
              <SelectItem value="user">Users</SelectItem>
              <SelectItem value="admin">Admins</SelectItem>
            </SelectContent>
          </Select>
          <Select value={filters.state} onValueChange={(value) => updateFilter("state", value as UserTableFilters["state"])}>
            <SelectTrigger aria-label="Filter by state">
              <SelectValue placeholder="All states" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All states</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="suspended">Suspended</SelectItem>
            </SelectContent>
          </Select>
          <Select value={filters.sort} onValueChange={(value) => updateFilter("sort", value as AdminUserSort)}>
            <SelectTrigger aria-label="Sort by">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="created">Created</SelectItem>
              <SelectItem value="lastSeen">Last seen</SelectItem>
              <SelectItem value="email">Email</SelectItem>
              <SelectItem value="inventory">Inventory size</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            aria-label={filters.dir === "asc" ? "Sorted ascending" : "Sorted descending"}
            onClick={() => updateFilter("dir", filters.dir === "asc" ? "desc" : "asc")}
          >
            {filters.dir === "asc" ? "↑ Asc" : "↓ Desc"}
          </Button>
        </div>

        {loadError && <p className="text-sm text-destructive">{loadError}</p>}

        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Linked identities</TableHead>
                <TableHead className="text-right">Inventory</TableHead>
                <TableHead>Last seen</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="sr-only">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!isLoading && users.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="text-center text-muted-foreground">
                    No users found.
                  </TableCell>
                </TableRow>
              )}
              {isLoading && users.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="text-center text-muted-foreground">
                    Loading users…
                  </TableCell>
                </TableRow>
              )}
              {users.map((user) => (
                <TableRow
                  key={user.userId}
                  className="cursor-pointer"
                  onClick={() => setSelectedUserId(user.userId)}
                >
                  <TableCell>
                    <div className="font-medium">#{user.userId}</div>
                    {user.handle && <div className="text-xs text-muted-foreground">{user.handle}</div>}
                  </TableCell>
                  <TableCell>{user.email ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{user.role}</Badge>
                  </TableCell>
                  <TableCell>
                    <StateBadge user={user} />
                  </TableCell>
                  <TableCell className="max-w-[260px]">
                    <div className="truncate text-xs text-muted-foreground" title={user.linkedExternalIds.join(", ")}>
                      {user.linkedExternalIds.length > 0
                        ? `${user.linkedExternalIds.length} · ${user.linkedExternalIds.join(", ")}`
                        : "None"}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">{user.inventoryCount}</TableCell>
                  <TableCell>{formatDateTime(user.lastSeenAt)}</TableCell>
                  <TableCell>{formatDateTime(user.createdAt)}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelectedUserId(user.userId);
                      }}
                    >
                      Manage
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
          <span>{describePageRange(filters.page, users.length, total)}</span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={filters.page === 0 || isLoading}
              onClick={() => updateFilter("page", filters.page - 1)}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!hasNextPage || isLoading}
              onClick={() => updateFilter("page", filters.page + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      </section>

      <section className="space-y-3 rounded-md border p-4">
        <div>
          <h3 className="font-medium">Merge duplicate accounts</h3>
          <p className="text-sm text-muted-foreground">
            Moves inventory, identities, captures and the mani log from the source account to the target, then deletes the source.
          </p>
        </div>
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
      </section>

      <UserDetailDialog
        key={selectedUserId ?? "closed"}
        userId={selectedUserId}
        currentUserId={currentUserId}
        onClose={() => setSelectedUserId(null)}
        onUpdated={() => void loadUsers()}
      />
    </div>
  );
}
