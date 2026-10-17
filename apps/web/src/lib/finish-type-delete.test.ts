import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FinishTypeInUseResponse } from "swatchwatch-shared";
import { ApiError, deleteFinishType } from "./api";
import { runReferenceDelete } from "../app/(admin)/admin/reference-data/components/config-tab";

const IN_USE_BODY: FinishTypeInUseResponse = {
  error:
    'Cannot delete finish "Chrome": it is still used by 12 shades and 1 finish normalization. ' +
    "Remove it from those shades and delete or repoint its normalizations first.",
  code: "FINISH_TYPE_IN_USE",
  finishTypeId: 7,
  name: "chrome",
  shadeCount: 12,
  normalizationCount: 1,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function recorder() {
  const pending: boolean[] = [];
  const errors: Array<string | null> = [];
  let successes = 0;
  return {
    pending,
    errors,
    get successes() {
      return successes;
    },
    hooks: {
      setPending: (value: boolean) => pending.push(value),
      setError: (value: string | null) => errors.push(value),
      onSuccess: () => {
        successes += 1;
      },
    },
  };
}

describe("finish type delete (in-use 409)", () => {
  it("deleteFinishType rejects with the server's usage message and the structured body", async (t) => {
    const fetchMock = t.mock.method(globalThis, "fetch", async () => jsonResponse(409, IN_USE_BODY));

    await assert.rejects(deleteFinishType(7), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 409);
      assert.equal(error.message, IN_USE_BODY.error);
      assert.equal((error.body as FinishTypeInUseResponse).shadeCount, 12);
      return true;
    });
    assert.equal(fetchMock.mock.callCount(), 1);
    assert.match(String(fetchMock.mock.calls[0].arguments[0]), /\/reference-admin\/finishes\/7$/);
  });

  it("the delete dialog shows the usage message and stays open on 409", async (t) => {
    t.mock.method(globalThis, "fetch", async () => jsonResponse(409, IN_USE_BODY));
    const rec = recorder();
    let reloads = 0;

    await runReferenceDelete({
      id: 7,
      singularLabel: "finish type",
      onDelete: async (id) => {
        await deleteFinishType(id);
        reloads += 1;
      },
      ...rec.hooks,
    });

    assert.deepEqual(rec.pending, [true, false]);
    assert.deepEqual(rec.errors, [null, IN_USE_BODY.error]);
    assert.match(rec.errors.at(-1) ?? "", /12 shades/);
    assert.equal(rec.successes, 0, "the dialog must stay open");
    assert.equal(reloads, 0);
  });

  it("closes the dialog and clears the error when the delete succeeds", async () => {
    const rec = recorder();
    const deleted: number[] = [];

    await runReferenceDelete({
      id: 3,
      singularLabel: "finish type",
      onDelete: async (id) => {
        deleted.push(id);
      },
      ...rec.hooks,
    });

    assert.deepEqual(deleted, [3]);
    assert.equal(rec.successes, 1);
    assert.deepEqual(rec.errors, [null, null]);
    assert.deepEqual(rec.pending, [true, false]);
  });

  it("falls back to a generic message for non-Error failures", async () => {
    const rec = recorder();
    await runReferenceDelete({
      id: 3,
      singularLabel: "finish type",
      onDelete: async () => {
        throw "boom";
      },
      ...rec.hooks,
    });
    assert.equal(rec.errors.at(-1), "Failed to delete finish type");
  });
});
