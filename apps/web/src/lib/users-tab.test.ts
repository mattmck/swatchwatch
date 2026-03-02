import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AdminUserListItem, AdminUserMergeResponse } from "swatchwatch-shared";
import {
  filterUsersByQuery,
  handleMergeAction,
  loadUsersState,
} from "../app/(admin)/admin/reference-data/components/users-tab";

function buildUser(overrides: Partial<AdminUserListItem> = {}): AdminUserListItem {
  return {
    userId: 1,
    role: "user",
    linkedExternalIds: ["oid-1"],
    createdAt: "2026-01-01T00:00:00.000Z",
    inventoryCount: 0,
    submissionCount: 0,
    captureSessionCount: 0,
    ...overrides,
  };
}

describe("UsersTab helpers", () => {
  it("loadUsersState sets loading/error/users on success", async () => {
    const loadingStates: boolean[] = [];
    const errorStates: Array<string | null> = [];
    let users: AdminUserListItem[] = [];

    await loadUsersState({
      listUsers: async () => ({ users: [buildUser({ userId: 42, email: "a@test.dev" })], total: 1 }),
      isMounted: () => true,
      setIsLoading: (loading) => loadingStates.push(loading),
      setLoadError: (message) => errorStates.push(message),
      setUsers: (nextUsers) => {
        users = nextUsers;
      },
    });

    assert.deepEqual(loadingStates, [true, false]);
    assert.deepEqual(errorStates, [null]);
    assert.equal(users.length, 1);
    assert.equal(users[0].userId, 42);
  });

  it("loadUsersState sets loadError on failure", async () => {
    const loadingStates: boolean[] = [];
    const errorStates: Array<string | null> = [];

    await loadUsersState({
      listUsers: async () => {
        throw new Error("boom");
      },
      isMounted: () => true,
      setIsLoading: (loading) => loadingStates.push(loading),
      setLoadError: (message) => errorStates.push(message),
      setUsers: () => {},
    });

    assert.deepEqual(loadingStates, [true, false]);
    assert.deepEqual(errorStates, [null, "boom"]);
  });

  it("filterUsersByQuery returns all users when query is empty", () => {
    const users = [
      buildUser({ userId: 1, email: "one@test.dev" }),
      buildUser({ userId: 2, email: "two@test.dev" }),
    ];

    const result = filterUsersByQuery(users, "   ");
    assert.equal(result, users);
  });

  it("filterUsersByQuery matches by email/ids/linked identities", () => {
    const users = [
      buildUser({ userId: 1, email: "one@test.dev", linkedExternalIds: ["abc-def"] }),
      buildUser({ userId: 2, email: "two@test.dev", linkedExternalIds: ["xyz-ghi"] }),
    ];

    assert.deepEqual(filterUsersByQuery(users, "two@test.dev").map((u) => u.userId), [2]);
    assert.deepEqual(filterUsersByQuery(users, "abc-def").map((u) => u.userId), [1]);
    assert.deepEqual(filterUsersByQuery(users, "2").map((u) => u.userId), [2]);
  });

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
