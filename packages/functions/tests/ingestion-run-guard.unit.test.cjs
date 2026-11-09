const test = require("node:test");
const assert = require("node:assert/strict");
const {
  assertSourceEnabledForRun,
  refuseIfDisabled,
  partitionDisabledSources,
} = require("../dist/lib/ingestion-run-guard");

test("a disabled source answers 409 source_disabled", async () => {
  const res = await assertSourceEnabledForRun("PendingShopify", async () => ({ enabled: false }));
  assert.equal(res.status, 409);
  assert.equal(res.jsonBody.error, "source_disabled");
  assert.match(res.jsonBody.message, /PendingShopify is disabled/);
});

test("an enabled source passes", async () => {
  assert.equal(await assertSourceEnabledForRun("X", async () => ({ enabled: true })), null);
});

test("a missing row passes (auto-provisioned or fails later)", async () => {
  assert.equal(await assertSourceEnabledForRun("X", async () => null), null);
});

test("partitionDisabledSources lists only existing disabled rows", () => {
  assert.deepEqual(
    partitionDisabledSources([
      { name: "A", enabled: true },
      { name: "B", enabled: false },
      null,
      { name: "C" },
      { name: "D", enabled: false },
    ]),
    ["B", "D"]
  );
  assert.deepEqual(partitionDisabledSources([]), []);
});

test("a pending Shopify source provisioned disabled is refused after ensure", () => {
  const res = refuseIfDisabled("PendingShopify", { enabled: false });
  assert.equal(res.status, 409);
  assert.equal(res.jsonBody.error, "source_disabled");
});

test("an enabled ensured row (or no row) proceeds", () => {
  assert.equal(refuseIfDisabled("X", { enabled: true }), null);
  assert.equal(refuseIfDisabled("X", null), null);
});

test("a source whose metadata has blocked answers 409 source_blocked naming the reason, even when enabled", async () => {
  const { partitionBlockedSources } = require("../dist/lib/ingestion-run-guard");
  for (const enabled of [true, false]) {
    const res = await assertSourceEnabledForRun("IlnpWooCommerce", async () => ({ enabled, metadata: { blocked: "robots" } }));
    assert.equal(res.status, 409);
    assert.equal(res.jsonBody.error, "source_blocked");
    assert.match(res.jsonBody.message, /IlnpWooCommerce is known-blocked \(robots\)/);
  }
  assert.equal(refuseIfDisabled("X", { enabled: true, metadata: { blocked: true } }).jsonBody.error, "source_blocked");
  for (const blocked of [false, null, "", undefined]) {
    assert.equal(refuseIfDisabled("X", { enabled: true, metadata: { blocked } }), null, String(blocked));
  }
  assert.deepEqual(
    partitionBlockedSources([
      { name: "A", enabled: true, metadata: {} },
      { name: "B", enabled: false, metadata: { blocked: "cloudflare" } },
      null,
      { name: "C", enabled: true, metadata: { blocked: "robots" } },
    ]),
    ["B", "C"]
  );
});
