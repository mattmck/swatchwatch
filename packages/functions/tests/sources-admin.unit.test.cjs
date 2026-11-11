const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  planPermissionChange,
  planEnabledChange,
  parsePermissionRequest,
  grantNoteSentence,
  isFetchableSource,
} = require("../dist/lib/sources-admin");

const NOW = "2026-11-11T10:00:00.000Z";
const SHOPIFY = "HypnoticPolishShopify";

function state(overrides = {}) {
  return { name: SHOPIFY, enabled: false, metadata: {}, ...overrides };
}

const grant = {
  action: "granted",
  decidedAt: "2026-11-10",
  grantedBy: "Jo",
  channel: "email",
  summary: "OK to read the catalog",
  imagesGranted: false,
};

describe("planPermissionChange", () => {
  it("records asked without touching enabled", () => {
    const input = state({ enabled: true });
    const plan = planPermissionChange(input, { action: "asked", askedAt: "2026-11-09" }, 7, NOW);
    assert.equal(plan.ok, true);
    assert.equal(plan.action, "data_source.permission");
    assert.equal(plan.enabled, true);
    assert.deepEqual(plan.metadata.permission, {
      status: "asked",
      askedAt: "2026-11-09",
      recordedByUserId: 7,
      recordedAt: NOW,
    });
    assert.equal(plan.changes.enabled, undefined);
    assert.deepEqual(input.metadata, {});
  });

  it("grant on a pending store enables it and appends the notes sentence", () => {
    const plan = planPermissionChange(
      state({ metadata: { pendingApproval: true, notes: "x" } }),
      grant,
      7,
      NOW,
    );
    assert.equal(plan.ok, true);
    assert.equal(plan.enabled, true);
    assert.equal("pendingApproval" in plan.metadata, false);
    assert.equal(plan.metadata.imagesPermitted, false);
    assert.equal(plan.metadata.permission.imagesGranted, false);
    assert.equal(plan.metadata.permission.recordedByUserId, 7);
    const sentence = grantNoteSentence({
      grantedBy: "Jo",
      displayName: "Hypnotic Polish",
      decidedAt: "2026-11-10",
      channel: "email",
      summary: "OK to read the catalog",
    });
    assert.equal(plan.metadata.notes, `x ${sentence}`);
    assert.deepEqual(plan.changes.enabled, { from: false, to: true });
    assert.deepEqual(plan.changes.pendingApproval, { from: true, to: null });
  });

  it("grant with no existing notes writes just the sentence, images granted syncs imagesPermitted", () => {
    const plan = planPermissionChange(state(), { ...grant, imagesGranted: true }, 7, NOW);
    assert.match(plan.metadata.notes, /^Acceptable use confirmed by Jo at Hypnotic Polish on 2026-11-10 via email: /);
    assert.equal(plan.metadata.imagesPermitted, true);
  });

  it("grant on an already granted source edits fields but leaves enabled, notes and askedAt alone", () => {
    const existing = state({
      enabled: false,
      metadata: {
        notes: "old note",
        permission: { status: "granted", askedAt: "2026-11-01", grantedBy: "Jp" },
      },
    });
    const plan = planPermissionChange(existing, grant, 7, NOW);
    assert.equal(plan.ok, true);
    assert.equal(plan.enabled, false);
    assert.equal(plan.metadata.notes, "old note");
    assert.equal(plan.metadata.permission.grantedBy, "Jo");
    assert.equal(plan.metadata.permission.askedAt, "2026-11-01");
    assert.equal(plan.changes.enabled, undefined);
    assert.equal(plan.changes.notes, undefined);
  });

  it("declined switches the source off", () => {
    const plan = planPermissionChange(
      state({ enabled: true }),
      { action: "declined", decidedAt: "2026-11-10", channel: "dm" },
      7,
      NOW,
    );
    assert.equal(plan.ok, true);
    assert.equal(plan.enabled, false);
    assert.equal(plan.metadata.permission.status, "declined");
    assert.deepEqual(plan.changes.enabled, { from: true, to: false });
  });

  it("images toggle on a granted source sets both flags", () => {
    const plan = planPermissionChange(
      state({ enabled: true, metadata: { permission: { status: "granted", imagesGranted: false }, imagesPermitted: false } }),
      { action: "images", imagesGranted: true },
      7,
      NOW,
    );
    assert.equal(plan.ok, true);
    assert.equal(plan.action, "data_source.images");
    assert.equal(plan.metadata.imagesPermitted, true);
    assert.equal(plan.metadata.permission.imagesGranted, true);
    assert.equal(plan.metadata.permission.status, "granted");
  });

  it("images toggle on a non-granted source is 409 not_granted", () => {
    const plan = planPermissionChange(
      state({ metadata: { permission: { status: "asked" } } }),
      { action: "images", imagesGranted: true },
      7,
      NOW,
    );
    assert.equal(plan.ok, false);
    assert.equal(plan.status, 409);
    assert.equal(plan.code, "not_granted");
  });

  it("rejects a non-fetchable source", () => {
    const plan = planPermissionChange(state({ name: "Manual" }), { action: "asked", askedAt: "2026-11-09" }, 7, NOW);
    assert.equal(plan.ok, false);
    assert.equal(plan.status, 409);
    assert.equal(plan.code, "not_fetchable");
    assert.equal(isFetchableSource("Manual"), false);
    assert.equal(isFetchableSource(SHOPIFY), true);
  });
});

describe("planEnabledChange", () => {
  for (const status of ["not_asked", "asked", "declined"]) {
    it(`turn on with permission ${status} needs override`, () => {
      const metadata = status === "not_asked" ? {} : { permission: { status } };
      const plan = planEnabledChange(state({ metadata }), { enabled: true });
      assert.equal(plan.ok, false);
      assert.equal(plan.status, 409);
      assert.equal(plan.code, "permission_required");
    });
  }

  it("override turns on, records override and status, keeps permission", () => {
    const permission = { status: "asked", askedAt: "2026-11-09" };
    const plan = planEnabledChange(
      state({ metadata: { pendingApproval: true, permission } }),
      { enabled: true, override: true },
    );
    assert.equal(plan.ok, true);
    assert.equal(plan.action, "data_source.enable");
    assert.equal(plan.enabled, true);
    assert.equal(plan.changes.override, true);
    assert.equal(plan.changes.permissionStatus, "asked");
    assert.equal("pendingApproval" in plan.metadata, false);
    assert.deepEqual(plan.metadata.permission, permission);
  });

  it("granted turns on without override and without an override key in changes", () => {
    const plan = planEnabledChange(
      state({ metadata: { permission: { status: "granted" } } }),
      { enabled: true },
    );
    assert.equal(plan.ok, true);
    assert.equal("override" in plan.changes, false);
    assert.deepEqual(plan.changes.enabled, { from: false, to: true });
  });

  it("not_needed turns on without override", () => {
    const plan = planEnabledChange(
      state({ metadata: { verification: { termsScrapingClause: false } } }),
      { enabled: true },
    );
    assert.equal(plan.ok, true);
    assert.equal("override" in plan.changes, false);
  });

  it("turning off works on any status", () => {
    const plan = planEnabledChange(state({ enabled: true, metadata: { permission: { status: "declined" } } }), {
      enabled: false,
    });
    assert.equal(plan.ok, true);
    assert.equal(plan.action, "data_source.disable");
    assert.equal(plan.enabled, false);
  });

  it("rejects a non-fetchable source", () => {
    const plan = planEnabledChange(state({ name: "Manual" }), { enabled: false });
    assert.equal(plan.ok, false);
    assert.equal(plan.code, "not_fetchable");
  });
});

describe("parsePermissionRequest", () => {
  it("accepts valid bodies", () => {
    assert.equal(parsePermissionRequest({ action: "asked", askedAt: "2026-11-09" }).ok, true);
    const g = parsePermissionRequest({ ...grant, grantedBy: "  Jo  " });
    assert.equal(g.ok, true);
    assert.equal(g.value.grantedBy, "Jo");
    assert.equal(parsePermissionRequest({ action: "images", imagesGranted: true }).ok, true);
  });

  it("rejects bad input", () => {
    assert.equal(parsePermissionRequest({ action: "asked", askedAt: "2026-1-5" }).ok, false);
    assert.equal(parsePermissionRequest({ action: "nope" }).ok, false);
    assert.equal(parsePermissionRequest({ ...grant, channel: "carrier-pigeon" }).ok, false);
    assert.equal(parsePermissionRequest({ ...grant, grantedBy: "   " }).ok, false);
    assert.equal(parsePermissionRequest({ ...grant, summary: "x".repeat(501) }).ok, false);
    assert.equal(parsePermissionRequest(null).ok, false);
  });
});
