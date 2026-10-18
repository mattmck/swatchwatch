import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  AdminAuditEvent,
  AdminUserDetailResponse,
  AdminUserListItem,
  AdminUserListQuery,
  AdminUserListResponse,
  AdminUserMergeResponse,
} from "swatchwatch-shared";
import {
  buildUserListQuery,
  DEFAULT_USER_TABLE_FILTERS,
  describePageRange,
  handleMergeAction,
  loadUsersState,
  USERS_PAGE_SIZE,
} from "../app/(admin)/admin/reference-data/components/users-tab";
import {
  buildUserUpdateRequest,
  describeAuditChanges,
  toUserEditForm,
} from "../app/(admin)/admin/reference-data/components/user-detail-dialog";

function buildUser(overrides: Partial<AdminUserListItem> = {}): AdminUserListItem {
  return {
    userId: 1,
    role: "user",
    linkedExternalIds: ["oid-1"],
    createdAt: "2026-01-01T00:00:00.000Z",
    inventoryCount: 0,
    submissionCount: 0,
    captureSessionCount: 0,
    state: "active",
    ...overrides,
  };
}

function buildDetail(overrides: Partial<AdminUserDetailResponse> = {}): AdminUserDetailResponse {
  return {
    user: buildUser({ userId: 7, handle: "polishfan" }),
    identities: [],
    auditEvents: [],
    ...overrides,
  };
}

describe("UsersTab helpers", () => {
  it("loadUsersState passes the server query and sets loading/error/result on success", async () => {
    const loadingStates: boolean[] = [];
    const errorStates: Array<string | null> = [];
    let result: AdminUserListResponse | null = null;
    let seenQuery: AdminUserListQuery | undefined;

    await loadUsersState({
      listUsers: async (query) => {
        seenQuery = query;
        return { users: [buildUser({ userId: 42, email: "a@test.dev" })], total: 1 };
      },
      query: { q: "a@test", limit: 50, offset: 0 },
      isMounted: () => true,
      setIsLoading: (loading) => loadingStates.push(loading),
      setLoadError: (message) => errorStates.push(message),
      setResult: (next) => {
        result = next;
      },
    });

    assert.deepEqual(loadingStates, [true, false]);
    assert.deepEqual(errorStates, [null]);
    assert.deepEqual(seenQuery, { q: "a@test", limit: 50, offset: 0 });
    assert.equal(result!.users[0].userId, 42);
  });

  it("loadUsersState sets loadError on failure", async () => {
    const loadingStates: boolean[] = [];
    const errorStates: Array<string | null> = [];

    await loadUsersState({
      listUsers: async () => {
        throw new Error("boom");
      },
      query: {},
      isMounted: () => true,
      setIsLoading: (loading) => loadingStates.push(loading),
      setLoadError: (message) => errorStates.push(message),
      setResult: () => {},
    });

    assert.deepEqual(loadingStates, [true, false]);
    assert.deepEqual(errorStates, [null, "boom"]);
  });

  it("buildUserListQuery omits 'all' filters and turns the page into an offset", () => {
    assert.deepEqual(buildUserListQuery(DEFAULT_USER_TABLE_FILTERS), {
      sort: "created",
      dir: "desc",
      limit: USERS_PAGE_SIZE,
      offset: 0,
    });
    assert.deepEqual(
      buildUserListQuery({ q: "  ana ", role: "admin", state: "suspended", sort: "email", dir: "asc", page: 2 }),
      { q: "ana", role: "admin", state: "suspended", sort: "email", dir: "asc", limit: USERS_PAGE_SIZE, offset: 2 * USERS_PAGE_SIZE }
    );
  });

  it("describePageRange", () => {
    assert.equal(describePageRange(0, 0, 0), "0 of 0");
    assert.equal(describePageRange(0, 50, 75), "1–50 of 75");
    assert.equal(describePageRange(1, 25, 75), "51–75 of 75");
  });
});

describe("UserDetailDialog helpers", () => {
  it("buildUserUpdateRequest sends only changed fields", () => {
    const detail = buildDetail();
    const form = toUserEditForm(detail);
    assert.equal(buildUserUpdateRequest(detail, form), null);
    assert.equal(buildUserUpdateRequest(detail, { ...form, note: "only a note" }), null);
    assert.deepEqual(buildUserUpdateRequest(detail, { ...form, handle: " renamed " }), { handle: "renamed" });
    assert.deepEqual(
      buildUserUpdateRequest(detail, { ...form, suspended: true, suspendedReason: " spam ", note: " ticket 4 " }),
      { suspended: true, suspendedReason: "spam", note: "ticket 4" }
    );
  });

  it("buildUserUpdateRequest reactivates and edits the reason of a suspended user", () => {
    const detail = buildDetail({
      user: buildUser({ userId: 7, handle: "polishfan", state: "suspended", suspendedAt: "2026-10-01" }),
      suspendedReason: "spam",
    });
    const form = toUserEditForm(detail);
    assert.equal(form.suspended, true);
    assert.deepEqual(buildUserUpdateRequest(detail, { ...form, suspended: false }), { suspended: false });
    assert.deepEqual(buildUserUpdateRequest(detail, { ...form, suspendedReason: "abuse" }), { suspendedReason: "abuse" });
    assert.deepEqual(buildUserUpdateRequest(detail, { ...form, suspendedReason: "" }), { suspendedReason: null });
  });

  it("describeAuditChanges renders before → after and merges", () => {
    const base: AdminAuditEvent = {
      auditEventId: 1,
      actorUserId: 2,
      action: "user.suspend",
      changes: { suspended: { from: false, to: true }, suspendedReason: { from: null, to: "spam" } },
      createdAt: "2026-10-01",
    };
    assert.equal(describeAuditChanges(base), "suspended: no → yes; suspendedReason: — → spam");
    assert.equal(
      describeAuditChanges({ ...base, action: "user.merge", changes: { sourceUserId: 9, sourceEmail: "dup@test.dev" } }),
      "from user #9 (dup@test.dev)"
    );
  });
});

describe("UsersTab merge", () => {
  it("handleMergeAction rejects non-numeric IDs", async () => {
    let mergeError: string | null = null;
    let mergeCalled = false;

    await handleMergeAction({
      sourceUserId: "12abc",
      targetUserId: "99",
      confirm: () => true,
      mergeUsers: async () => {
        mergeCalled = true;
        throw new Error("should not run");
      },
      refreshUsers: async () => {},
      setMergeError: (message) => {
        mergeError = message;
      },
      setMergePending: () => {},
      setLastMergeResult: () => {},
      setSourceUserId: () => {},
      setTargetUserId: () => {},
    });

    assert.equal(mergeError, "Source and target user IDs must be numeric values.");
    assert.equal(mergeCalled, false);
  });

  it("handleMergeAction rejects non-positive and identical IDs", async () => {
    const errors: string[] = [];

    await handleMergeAction({
      sourceUserId: "0",
      targetUserId: "4",
      confirm: () => true,
      mergeUsers: async () => {
        throw new Error("should not run");
      },
      refreshUsers: async () => {},
      setMergeError: (message) => {
        if (message) errors.push(message);
      },
      setMergePending: () => {},
      setLastMergeResult: () => {},
      setSourceUserId: () => {},
      setTargetUserId: () => {},
    });

    await handleMergeAction({
      sourceUserId: "4",
      targetUserId: "4",
      confirm: () => true,
      mergeUsers: async () => {
        throw new Error("should not run");
      },
      refreshUsers: async () => {},
      setMergeError: (message) => {
        if (message) errors.push(message);
      },
      setMergePending: () => {},
      setLastMergeResult: () => {},
      setSourceUserId: () => {},
      setTargetUserId: () => {},
    });

    assert.deepEqual(errors, [
      "Source and target user IDs must be positive numbers.",
      "Source and target user IDs must be different.",
    ]);
  });

  it("handleMergeAction success clears inputs, sets result, and refreshes users", async () => {
    const pendingStates: boolean[] = [];
    const clearedSources: string[] = [];
    const clearedTargets: string[] = [];
    const responses: AdminUserMergeResponse[] = [];
    let refreshCount = 0;

    await handleMergeAction({
      sourceUserId: "5",
      targetUserId: "9",
      confirm: () => true,
      mergeUsers: async ({ sourceUserId, targetUserId }) => ({
        merged: true,
        sourceUserId,
        targetUserId,
        mergedByUserId: 2,
        mergedInventoryRows: 1,
        mergedIdentityRows: 2,
        mergedSubmissionRows: 0,
        mergedCaptureRows: 0,
        mergedCaptureAnswerRows: 0,
        mergedClickEventRows: 0,
        message: "Merged user 5 into 9",
      }),
      refreshUsers: async () => {
        refreshCount += 1;
      },
      setMergeError: () => {},
      setMergePending: (pending) => pendingStates.push(pending),
      setLastMergeResult: (result) => {
        if (result) responses.push(result);
      },
      setSourceUserId: (value) => clearedSources.push(value),
      setTargetUserId: (value) => clearedTargets.push(value),
    });

    assert.deepEqual(pendingStates, [true, false]);
    assert.equal(refreshCount, 1);
    assert.equal(responses.length, 1);
    assert.equal(responses[0].sourceUserId, 5);
    assert.equal(responses[0].targetUserId, 9);
    assert.deepEqual(clearedSources, [""]);
    assert.deepEqual(clearedTargets, [""]);
  });

  it("handleMergeAction stops when confirmation is cancelled", async () => {
    let mergeCalled = false;
    const pendingStates: boolean[] = [];

    await handleMergeAction({
      sourceUserId: "5",
      targetUserId: "9",
      confirm: () => false,
      mergeUsers: async () => {
        mergeCalled = true;
        throw new Error("should not run");
      },
      refreshUsers: async () => {},
      setMergeError: () => {},
      setMergePending: (pending) => pendingStates.push(pending),
      setLastMergeResult: () => {},
      setSourceUserId: () => {},
      setTargetUserId: () => {},
    });

    assert.equal(mergeCalled, false);
    assert.deepEqual(pendingStates, []);
  });

  it("handleMergeAction sets mergeError on merge failure and keeps inputs", async () => {
    const pendingStates: boolean[] = [];
    const errors: Array<string | null> = [];
    let sourceSetCount = 0;
    let targetSetCount = 0;

    await handleMergeAction({
      sourceUserId: "5",
      targetUserId: "9",
      confirm: () => true,
      mergeUsers: async () => {
        throw new Error("merge failed");
      },
      refreshUsers: async () => {},
      setMergeError: (message) => errors.push(message),
      setMergePending: (pending) => pendingStates.push(pending),
      setLastMergeResult: () => {},
      setSourceUserId: () => {
        sourceSetCount += 1;
      },
      setTargetUserId: () => {
        targetSetCount += 1;
      },
    });

    assert.deepEqual(pendingStates, [true, false]);
    assert.deepEqual(errors, [null, "merge failed"]);
    assert.equal(sourceSetCount, 0);
    assert.equal(targetSetCount, 0);
  });
});
