import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FinishTypeNameTakenResponse, FinishTypeUpdateResponse } from "swatchwatch-shared";
import { ApiError, updateFinishType } from "./api";
import {
  finishTypeRenameNotice,
  runReferenceUpdate,
} from "../app/(admin)/admin/reference-data/components/config-tab";

const RENAMED: FinishTypeUpdateResponse = {
  finishTypeId: 7,
  name: "mirror",
  displayName: "Mirror",
  sortOrder: 20,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-10-17T00:00:00Z",
  rename: { previousName: "Chrome", shadeCount: 12, normalizationCount: 1, aliasCreated: true },
};

const NAME_TAKEN: FinishTypeNameTakenResponse = {
  error: 'Cannot rename finish "Chrome" to "Glitter": finish type "glitter" already exists.',
  code: "FINISH_TYPE_NAME_TAKEN",
  finishTypeId: 7,
  name: "Chrome",
  requestedName: "Glitter",
  conflictingFinishTypeId: 3,
  conflictingName: "glitter",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function recorder() {
  const pending: boolean[] = [];
  const errors: Array<string | null> = [];
  const notices: Array<string | null> = [];
  let closes = 0;
  return {
    pending,
    errors,
    notices,
    get closes() {
      return closes;
    },
    hooks: {
      setPending: (value: boolean) => pending.push(value),
      setError: (value: string | null) => errors.push(value),
      setNotice: (value: string | null) => notices.push(value),
      onClose: () => {
        closes += 1;
      },
    },
  };
}

describe("finishTypeRenameNotice", () => {
  it("summarizes a rename with shade, normalization and alias counts", () => {
    assert.equal(
      finishTypeRenameNotice(RENAMED),
      'Renamed "Chrome" to "mirror"; 12 shades updated, 1 finish normalization repointed. "chrome" is kept as an alias.'
    );
  });

  it("uses singular forms and leaves out what did not change", () => {
    assert.equal(
      finishTypeRenameNotice({
        ...RENAMED,
        name: "chrome",
        rename: { previousName: "Chrome", shadeCount: 1, normalizationCount: 0, aliasCreated: false },
      }),
      'Renamed "Chrome" to "chrome"; 1 shade updated.'
    );
  });

  it("returns null when the name did not change", () => {
    assert.equal(finishTypeRenameNotice({ ...RENAMED, rename: undefined }), null);
  });
});

describe("finish type edit dialog", () => {
  it("updateFinishType resolves with the rename counts", async (t) => {
    const fetchMock = t.mock.method(globalThis, "fetch", async () => jsonResponse(200, RENAMED));
    const updated = await updateFinishType(7, { name: "mirror" });
    assert.equal(updated.rename?.shadeCount, 12);
    assert.equal(fetchMock.mock.calls[0].arguments[1]?.method, "PUT");
    assert.match(String(fetchMock.mock.calls[0].arguments[0]), /\/reference-admin\/finishes\/7$/);
  });

  it("shows the rename result and stays open", async (t) => {
    t.mock.method(globalThis, "fetch", async () => jsonResponse(200, RENAMED));
    const rec = recorder();

    await runReferenceUpdate({
      id: 7,
      payload: { name: "mirror" },
      singularLabel: "finish type",
      onUpdate: async (id, payload) => finishTypeRenameNotice(await updateFinishType(id, payload)) ?? undefined,
      ...rec.hooks,
    });

    assert.equal(rec.closes, 0, "the dialog stays open to show the result");
    assert.match(rec.notices.at(-1) ?? "", /^Renamed "Chrome" to "mirror"; 12 shades updated/);
    assert.deepEqual(rec.errors, [null]);
    assert.deepEqual(rec.pending, [true, false]);
  });

  it("shows the server's 409 message when the new name is taken", async (t) => {
    t.mock.method(globalThis, "fetch", async () => jsonResponse(409, NAME_TAKEN));
    const rec = recorder();

    await assert.rejects(updateFinishType(7, { name: "Glitter" }), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 409);
      assert.equal((error.body as FinishTypeNameTakenResponse).code, "FINISH_TYPE_NAME_TAKEN");
      return true;
    });

    await runReferenceUpdate({
      id: 7,
      payload: { name: "Glitter" },
      singularLabel: "finish type",
      onUpdate: async (id, payload) => finishTypeRenameNotice(await updateFinishType(id, payload)) ?? undefined,
      ...rec.hooks,
    });

    assert.equal(rec.errors.at(-1), NAME_TAKEN.error);
    assert.deepEqual(rec.notices, [null]);
    assert.equal(rec.closes, 0, "the dialog stays open");
  });

  it("closes the dialog when an update has nothing to report", async () => {
    const rec = recorder();
    await runReferenceUpdate({
      id: 3,
      payload: { sortOrder: 4 },
      singularLabel: "harmony type",
      onUpdate: async () => undefined,
      ...rec.hooks,
    });
    assert.equal(rec.closes, 1);
    assert.deepEqual(rec.notices, [null]);
    assert.deepEqual(rec.errors, [null]);
  });

  it("falls back to a generic message for non-Error failures", async () => {
    const rec = recorder();
    await runReferenceUpdate({
      id: 3,
      payload: {},
      singularLabel: "finish type",
      onUpdate: async () => {
        throw "boom";
      },
      ...rec.hooks,
    });
    assert.equal(rec.errors.at(-1), "Failed to save finish type");
    assert.equal(rec.closes, 0);
  });
});
