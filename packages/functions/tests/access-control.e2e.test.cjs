/**
 * End-to-end access-control test (issue #53): a user cannot access or modify
 * another user's inventory, capture sessions, or media.
 *
 * Runs against a live local Functions host (default http://localhost:7071/api)
 * started with AUTH_DEV_BYPASS=true and the dev seed data (migrations 003/009):
 *   - user 1 (`Bearer dev:1`) — regular user, the data OWNER
 *   - user 2 (`Bearer dev:2`) — the ATTACKER (seeded as an admin, which also proves the
 *     user-scoped routes do not grant admins access to other users' inventory)
 *
 * The whole suite is skipped (not failed) when the host is unreachable or not in
 * dev-bypass mode, so it is safe to include in any test run.
 *
 * Override with env vars: E2E_API_BASE, E2E_OWNER_TOKEN, E2E_ATTACKER_TOKEN, and E2E_OWNER_ID
 * (the owner's numeric app_user id; required for the userId-spoofing cases when E2E_OWNER_TOKEN is
 * not a `dev:<id>` token — without it those cases are skipped rather than spoofing a guessed id).
 * E2E_PRIVATE_IMAGE_URL: a server-minted owner-scoped (`v3`) /api/images/ URL for the owner's
 * private media (#227); the owner-scoped image case is skipped when unset (the dev seed has no
 * private media yet).
 *
 * Run: npm run test:e2e --workspace=swatchwatch-functions
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const BASE = (process.env.E2E_API_BASE || "http://localhost:7071/api").replace(/\/+$/, "");
const OWNER = { Authorization: `Bearer ${process.env.E2E_OWNER_TOKEN || "dev:1"}` };
const ATTACKER = { Authorization: `Bearer ${process.env.E2E_ATTACKER_TOKEN || "dev:2"}` };
/**
 * Owner's numeric app_user id — the value an attacker tries to spoof in bodies/query params.
 * Taken from E2E_OWNER_ID, else parsed from a `dev:<id>` token; null for other tokens (e.g. B2C
 * JWTs), in which case the id-dependent spoofing cases are skipped instead of testing a guess.
 */
function resolveOwnerId() {
  const explicit = process.env.E2E_OWNER_ID?.trim();
  if (explicit) {
    const id = Number(explicit);
    if (!Number.isInteger(id) || id <= 0) throw new Error(`E2E_OWNER_ID must be a positive integer, got "${explicit}"`);
    return id;
  }
  const match = (process.env.E2E_OWNER_TOKEN || "dev:1").match(/^dev:(\d+)$/);
  return match ? Number(match[1]) : null;
}
const OWNER_ID = resolveOwnerId();
const SKIP_OWNER_ID_SPOOF =
  OWNER_ID === null ? "set E2E_OWNER_ID to the owner's app_user id to run userId-spoofing cases" : false;

const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
// Distinct from api.test.cjs's "__TEST__" brand so parallel cleanups never collide.
const TEST_BRAND = "__TEST__ACL__";
const SHADE_NAME = `ACL Shade ${RUN_ID}`;
const OWNER_NOTES = `owner-private-notes-${RUN_ID}`;
const OWNER_TAG = `acl-secret-${RUN_ID}`;

// 1x1 transparent PNG
const TINY_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

async function api(path, { method = "GET", headers = {}, body, timeoutMs = 15000 } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, body: json, text };
}

function assertRejected(res, label) {
  assert.ok(
    res.status === 403 || res.status === 404,
    `${label}: expected 403/404, got ${res.status} ${res.text.slice(0, 200)}`
  );
}

function assertNoOwnerData(payload, label) {
  const serialized = JSON.stringify(payload ?? null);
  assert.ok(!serialized.includes(OWNER_NOTES), `${label}: leaked owner's notes`);
  assert.ok(!serialized.includes(OWNER_TAG), `${label}: leaked owner's tags`);
}

/**
 * A forged/tampered image id must be refused *before* storage is consulted: any 4xx except
 * 404 (a 404 means the id was accepted and the blob lookup simply missed).
 */
function assertImageIdRejected(res, label) {
  assert.ok(
    res.status >= 400 && res.status < 500 && res.status !== 404,
    `${label} → ${res.status} ${res.text.slice(0, 120)} (expected 400/401/403: rejected before blob lookup)`
  );
}

function b64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/**
 * Owner-scoped `v3.<payload>.<exp>.<uid base36>.<MAC>` envelope with a random owner and a MAC from
 * the attacker's own key (same message layout the server signs).
 */
function forgeV3Id(storageUrl, expBase36 = Math.floor(Date.now() / 1000 + 3600).toString(36)) {
  const ownerUserId = crypto.randomInt(1, 1_000_000);
  const expiresAt = Number.parseInt(expBase36, 36);
  const mac = crypto
    .createHmac("sha256", "attacker-key")
    .update(`swatchwatch:image-proxy:v3:${expiresAt}:${ownerUserId}:${storageUrl}`)
    .digest();
  return `v3.${b64url(storageUrl)}.${expBase36}.${ownerUserId.toString(36)}.${b64url(mac)}`;
}

function fromB64url(input) {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized + "=".repeat((4 - (normalized.length % 4)) % 4), "base64").toString("utf8");
}

/** Probe the host; returns a skip reason, or null when the suite can run. */
async function probeHost() {
  let ownerProbe;
  try {
    ownerProbe = await api("/polishes?pageSize=1", { headers: OWNER, timeoutMs: 3000 });
  } catch (error) {
    return (
      `Functions host not reachable at ${BASE} (${error.cause?.code || error.name}). ` +
      "Start it with `npm run dev:infra && npm run dev:functions` (AUTH_DEV_BYPASS=true) to run this suite."
    );
  }
  if (ownerProbe.status === 401) {
    return `Host at ${BASE} rejected the owner dev token — enable AUTH_DEV_BYPASS=true and run migrations (seed users 1 and 2).`;
  }
  if (ownerProbe.status !== 200) {
    return `Host at ${BASE} is not healthy (GET /polishes → ${ownerProbe.status}).`;
  }
  const attackerProbe = await api("/polishes?pageSize=1", { headers: ATTACKER, timeoutMs: 3000 });
  if (attackerProbe.status !== 200) {
    return `Attacker dev user is not available (GET /polishes → ${attackerProbe.status}); run migrations to seed user 2.`;
  }
  return null;
}

async function deleteTestPolishes(headers) {
  const res = await api(`/polishes?search=${encodeURIComponent(TEST_BRAND)}&scope=collection&pageSize=250`, {
    headers,
  }).catch(() => null);
  if (!res || res.status !== 200 || !Array.isArray(res.body?.polishes)) return;
  for (const p of res.body.polishes) {
    if (p.brand === TEST_BRAND) {
      await api(`/polishes/${p.id}`, { method: "DELETE", headers }).catch(() => {});
    }
  }
}

test("access control e2e: users cannot access or modify each other's data", async (t) => {
  const skipReason = await probeHost();
  if (skipReason) {
    t.skip(skipReason);
    return;
  }

  let shadeId = null;
  let captureId = null;

  t.after(async () => {
    if (shadeId) {
      await api(`/polishes/${shadeId}`, { method: "DELETE", headers: OWNER }).catch(() => {});
      // The attacker's PUT may have created an inventory row of its own for the shade.
      await api(`/polishes/${shadeId}`, { method: "DELETE", headers: ATTACKER }).catch(() => {});
    }
    await deleteTestPolishes(OWNER);
    await deleteTestPolishes(ATTACKER);
    // Note: there is no API to delete capture sessions; the owner's test session is left
    // in place (status unchanged) and is harmless dev data.
  });

  async function ownerView() {
    const res = await api(`/polishes/${shadeId}`, { headers: OWNER });
    assert.equal(res.status, 200, `owner GET detail → ${res.status}`);
    return res.body;
  }

  function assertOwnerRowUnchanged(view, label) {
    assert.ok(view.inventoryItemId, `${label}: owner's inventory row must still exist`);
    assert.equal(view.quantity, 3, `${label}: owner's quantity changed`);
    assert.equal(view.notes, OWNER_NOTES, `${label}: owner's notes changed`);
    assert.equal(view.rating, 4, `${label}: owner's rating changed`);
  }

  // ── Setup ────────────────────────────────────────────────────────────────
  await t.test("setup: owner creates a polish in their inventory", async () => {
    await deleteTestPolishes(OWNER);
    const res = await api("/polishes", {
      method: "POST",
      headers: OWNER,
      body: {
        brand: TEST_BRAND,
        name: SHADE_NAME,
        finish: "creme",
        quantity: 3,
        rating: 4,
        notes: OWNER_NOTES,
        tags: [OWNER_TAG],
      },
    });
    assert.equal(res.status, 201, `create → ${res.status} ${res.text}`);
    shadeId = res.body.id;
    assert.ok(shadeId, "created polish has an id");
    assertOwnerRowUnchanged(await ownerView(), "after create");
  });

  if (!shadeId) return;

  // ── Authentication ──────────────────────────────────────────────────────
  await t.test("unauthenticated requests are rejected with 401", async () => {
    for (const [method, path] of [
      ["GET", "/polishes"],
      ["GET", `/polishes/${shadeId}`],
      ["PUT", `/polishes/${shadeId}`],
      ["DELETE", `/polishes/${shadeId}`],
      ["POST", "/capture/start"],
      ["GET", "/polishes/export?format=csv"],
      ["GET", "/polishes/export?format=json"],
    ]) {
      const res = await api(path, { method, body: method === "GET" || method === "DELETE" ? undefined : {} });
      assert.equal(res.status, 401, `${method} ${path} without auth → ${res.status}`);
    }
    assertOwnerRowUnchanged(await ownerView(), "after unauthenticated attempts");
  });

  // ── Inventory reads ─────────────────────────────────────────────────────
  await t.test("attacker GET detail does not expose the owner's inventory", async () => {
    // Shades are a shared catalog, so the shade itself may be returned (200) — but never the
    // owner's private inventory overlay (quantity, notes, rating, tags, inventoryItemId).
    const res = await api(`/polishes/${shadeId}`, { headers: ATTACKER });
    assert.ok([200, 403, 404].includes(res.status), `unexpected status ${res.status}`);
    assertNoOwnerData(res.body, "attacker detail");
    if (res.status === 200) {
      assert.ok(res.body.inventoryItemId == null, "attacker sees no inventoryItemId");
      assert.ok(res.body.quantity == null, "attacker sees no quantity");
      assert.ok(res.body.notes == null, "attacker sees no notes");
      assert.ok(res.body.rating == null, "attacker sees no rating");
      assert.ok(res.body.status == null, "attacker sees no inventory status");
      assert.ok(res.body.purchasePrice == null && res.body.triedAt == null, "attacker sees no purchase/tried data");
      assert.equal(res.body.isUntried, false, "catalog-only row is never untried");
    }
  });

  await t.test("attacker GET list does not include the owner's inventory", async () => {
    const collection = await api(
      `/polishes?search=${encodeURIComponent(SHADE_NAME)}&scope=collection&pageSize=250`,
      { headers: ATTACKER }
    );
    assert.equal(collection.status, 200);
    assert.ok(
      !collection.body.polishes.some((p) => p.id === shadeId),
      "owner's polish must not appear in the attacker's collection"
    );
    assertNoOwnerData(collection.body, "attacker collection list");

    const all = await api(`/polishes?search=${encodeURIComponent(SHADE_NAME)}&pageSize=250`, {
      headers: ATTACKER,
    });
    assert.equal(all.status, 200);
    assertNoOwnerData(all.body, "attacker catalog list");
    for (const p of all.body.polishes.filter((x) => x.id === shadeId)) {
      assert.ok(p.inventoryItemId == null && p.quantity == null, "catalog row carries no owner inventory");
      assert.ok(p.status == null && p.purchasePrice == null, "catalog row carries no owner status/price");
    }

    const ownerCollection = await api(
      `/polishes?search=${encodeURIComponent(SHADE_NAME)}&scope=collection&pageSize=250`,
      { headers: OWNER }
    );
    assert.ok(
      ownerCollection.body.polishes.some((p) => p.id === shadeId),
      "positive control: owner sees their polish in their collection"
    );
  });

  // ── Collection export (#264) ───────────────────────────────────────────
  await t.test("owner export contains the owner's row; attacker export never does", async () => {
    const ownerCsv = await api("/polishes/export?format=csv", { headers: OWNER });
    assert.equal(ownerCsv.status, 200, `owner CSV export → ${ownerCsv.status}`);
    assert.ok(ownerCsv.text.includes(SHADE_NAME), "owner CSV export includes the owner's polish");
    assert.ok(ownerCsv.text.includes(OWNER_NOTES), "owner CSV export includes the owner's notes");

    for (const format of ["csv", "json"]) {
      const res = await api(`/polishes/export?format=${format}`, { headers: ATTACKER });
      assert.equal(res.status, 200, `attacker ${format} export → ${res.status}`);
      assert.ok(!res.text.includes(OWNER_NOTES), `attacker ${format} export leaked the owner's notes`);
      assert.ok(!res.text.includes(OWNER_TAG), `attacker ${format} export leaked the owner's tag`);
      assert.ok(!res.text.includes(SHADE_NAME), `attacker ${format} export includes the owner's row`);
    }
  });

  await t.test("attacker search by the owner's private notes text does not match", async () => {
    // List search also matches ui.notes / ui.tags — those must only be the caller's own.
    for (const term of [OWNER_NOTES, OWNER_TAG]) {
      const res = await api(`/polishes?search=${encodeURIComponent(term)}&pageSize=250`, { headers: ATTACKER });
      assert.equal(res.status, 200, `attacker search "${term}" → ${res.status}`);
      assert.ok(
        !res.body.polishes.some((p) => p.id === shadeId),
        `searching "${term}" must not surface the owner's polish`
      );
      assertNoOwnerData(res.body, `attacker search "${term}"`);
    }

    const ownerSearch = await api(`/polishes?search=${encodeURIComponent(OWNER_NOTES)}&pageSize=250`, {
      headers: OWNER,
    });
    assert.ok(
      ownerSearch.body.polishes.some((p) => p.id === shadeId),
      "positive control: owner can search by their own notes"
    );
  });

  await t.test("attacker cannot spoof ownership via userId query params", { skip: SKIP_OWNER_ID_SPOOF }, async () => {
    const res = await api(
      `/polishes?search=${encodeURIComponent(SHADE_NAME)}&scope=collection&userId=${OWNER_ID}&user_id=${OWNER_ID}&pageSize=250`,
      { headers: ATTACKER }
    );
    assert.equal(res.status, 200);
    assert.ok(!res.body.polishes.some((p) => p.id === shadeId), "query userId must be ignored");
    assertNoOwnerData(res.body, "attacker spoofed-query list");
  });

  // ── Inventory writes ────────────────────────────────────────────────────
  // DELETE runs before PUT: PUT upserts a row into the *attacker's own* inventory, after which an
  // attacker DELETE would legitimately remove that row.
  await t.test("attacker DELETE is rejected and the owner's row survives", async () => {
    const res = await api(`/polishes/${shadeId}`, { method: "DELETE", headers: ATTACKER });
    assertRejected(res, "attacker DELETE");
    assertOwnerRowUnchanged(await ownerView(), "after attacker DELETE");
  });

  await t.test("attacker PUT cannot modify the owner's row", async () => {
    // PUT /polishes/{id} upserts into the caller's own inventory, so it may return 200 — the
    // requirement is that the owner's row is untouched.
    const res = await api(`/polishes/${shadeId}`, {
      method: "PUT",
      headers: ATTACKER,
      // userId/user_id in the body (when the owner id is known) must be ignored in favor of the
      // authenticated caller.
      body: {
        quantity: 0,
        notes: "pwned",
        rating: 1,
        tags: ["pwned"],
        ...(OWNER_ID !== null ? { userId: OWNER_ID, user_id: OWNER_ID } : {}),
      },
    });
    assert.ok(res.status < 500, `attacker PUT → ${res.status} ${res.text.slice(0, 200)}`);
    assertNoOwnerData(res.body, "attacker PUT response");
    assertOwnerRowUnchanged(await ownerView(), "after attacker PUT");
  });

  await t.test("attacker POST with a spoofed userId lands in the attacker's inventory", { skip: SKIP_OWNER_ID_SPOOF }, async () => {
    const spoofName = `ACL Spoof ${RUN_ID}`;
    const spoofNotes = `attacker-notes-${RUN_ID}`;
    const res = await api("/polishes", {
      method: "POST",
      headers: ATTACKER,
      body: { brand: TEST_BRAND, name: spoofName, finish: "creme", quantity: 1, notes: spoofNotes, userId: OWNER_ID, user_id: OWNER_ID },
    });
    assert.equal(res.status, 201, `attacker POST → ${res.status} ${res.text.slice(0, 200)}`);
    const spoofId = res.body.id;

    const asAttacker = await api(`/polishes/${spoofId}`, { headers: ATTACKER });
    assert.equal(asAttacker.status, 200);
    assert.equal(asAttacker.body.notes, spoofNotes, "item belongs to the attacker");

    const asOwner = await api(`/polishes/${spoofId}`, { headers: OWNER });
    assert.ok([200, 404].includes(asOwner.status), `owner GET → ${asOwner.status}`);
    if (asOwner.status === 200) {
      assert.ok(asOwner.body.inventoryItemId == null, "spoofed POST must not create an owner inventory row");
    }
    const ownerCollection = await api(
      `/polishes?search=${encodeURIComponent(spoofName)}&scope=collection&pageSize=250`,
      { headers: OWNER }
    );
    assert.ok(!ownerCollection.body.polishes.some((p) => p.id === spoofId), "not in owner's collection");
    // Cleaned up by deleteTestPolishes(ATTACKER) in t.after.
  });

  // ── Capture sessions ────────────────────────────────────────────────────
  await t.test("setup: owner starts a capture session", async () => {
    const res = await api("/capture/start", {
      method: "POST",
      headers: OWNER,
      body: { metadata: { source: `acl-e2e-${RUN_ID}` } },
    });
    assert.equal(res.status, 201, `capture start → ${res.status} ${res.text}`);
    captureId = res.body.captureId;
    assert.ok(captureId);
  });

  if (captureId) {
    await t.test("attacker cannot read or drive the owner's capture session", async () => {
      const before = await api(`/capture/${captureId}/status`, { headers: OWNER });
      assert.equal(before.status, 200);

      assertRejected(await api(`/capture/${captureId}/status`, { headers: ATTACKER }), "attacker status");
      assertRejected(
        await api(`/capture/${captureId}/frame`, {
          method: "POST",
          headers: ATTACKER,
          body: { frameType: "other", imageBlobUrl: TINY_PNG_DATA_URL },
        }),
        "attacker frame"
      );
      assertRejected(
        await api(`/capture/${captureId}/finalize`, { method: "POST", headers: ATTACKER, body: {} }),
        "attacker finalize"
      );
      assertRejected(
        await api(`/capture/${captureId}/answer`, { method: "POST", headers: ATTACKER, body: { answer: "skip" } }),
        "attacker answer"
      );

      for (const path of [`/capture/${captureId}/status`, `/capture/${captureId}/finalize`]) {
        const res = await api(path, { method: path.endsWith("status") ? "GET" : "POST", body: path.endsWith("status") ? undefined : {} });
        assert.equal(res.status, 401, `${path} without auth → ${res.status}`);
      }

      const after = await api(`/capture/${captureId}/status`, { headers: OWNER });
      assert.equal(after.status, 200);
      assert.equal(after.body.status, before.body.status, "owner's capture status changed");
      assert.equal(
        after.body.metadata?.pipeline?.ingest?.framesReceived ?? 0,
        before.body.metadata?.pipeline?.ingest?.framesReceived ?? 0,
        "attacker managed to add a frame to the owner's session"
      );
    });
  }

  // ── Admin routes ────────────────────────────────────────────────────────
  await t.test("regular user is rejected from admin routes", async () => {
    for (const [method, path] of [
      ["GET", "/ingestion/jobs"],
      ["GET", "/users-admin"],
      ["GET", "/reference-admin/jobs"],
      ["POST", `/polishes/${shadeId}/recalc-hex`],
    ]) {
      const res = await api(path, { method, headers: OWNER, body: method === "POST" ? {} : undefined });
      assert.equal(res.status, 403, `${method} ${path} as regular user → ${res.status}`);
    }
  });

  // ── Media ───────────────────────────────────────────────────────────────
  await t.test("image proxy rejects forged and tampered ids", async (st) => {
    // Find a server-minted /api/images/ URL in the owner's view of the catalog.
    let imageUrl = null;
    const list = await api("/polishes?pageSize=250", { headers: OWNER });
    for (const p of list.body?.polishes || []) {
      const candidates = [p.swatchImageUrl, ...(p.sourceImageUrls || [])].filter(Boolean);
      imageUrl = candidates.find((u) => u.includes("/api/images/")) || null;
      if (imageUrl) break;
    }

    if (!imageUrl) {
      // Still check that hand-crafted ids for plausible blob URLs are refused.
      const forged = b64url("http://127.0.0.1:10000/devstoreaccount1/source-images/forged/acl.png");
      assertImageIdRejected(await api(`/images/${forged}`), "forged unsigned id");
      const forgedV3 = forgeV3Id("http://127.0.0.1:10000/devstoreaccount1/nail-photos/forged/acl.png");
      assertImageIdRejected(await api(`/images/${encodeURIComponent(forgedV3)}`), "forged v3 owner-scoped id");
      st.diagnostic("No proxied image URLs in the dev data; only the forged-id checks ran.");
      return;
    }

    const legitId = decodeURIComponent(new URL(imageUrl).pathname.split("/").pop());
    const legit = await api(`/images/${encodeURIComponent(legitId)}`, { timeoutMs: 30000 });
    assert.ok(legit.status === 200 || legit.status === 404, `server-minted id → ${legit.status}`);

    // Minted ids are `v2.<payload>.<exp>.<signature>`. Each forgery keeps that envelope and changes
    // only the part under test, so it exercises signature / URL binding, not format parsing.
    const [version, payload, exp, signature] = legitId.split(".");
    assert.equal(version, "v2", `unexpected image id format: ${legitId}`);
    const storageUrl = fromB64url(payload);
    // Flip the FIRST character: the last base64url char of a 32-byte MAC carries unused bits,
    // so changing it can decode to the same signature.
    const flipped = (signature[0] === "A" ? "B" : "A") + signature.slice(1);
    const otherBlob = storageUrl.replace(/[^/]+$/, `forged-${RUN_ID}.png`);

    const attempts = {
      "unsigned id (plain base64url of the real storage URL)": b64url(storageUrl),
      "empty signature": `${version}.${payload}.${exp}.`,
      "garbage signature": `${version}.${payload}.${exp}.${b64url("not-a-real-mac")}`,
      "flipped signature character": `${version}.${payload}.${exp}.${flipped}`,
      "valid signature transplanted onto another blob": `${version}.${b64url(otherBlob)}.${exp}.${signature}`,
      // Owner-scoped envelope (#227) for the same blob, signed with the attacker's key. Rejected
      // on the signature, before any auth lookup or blob read, with or without a token.
      "forged v3 owner-scoped envelope": forgeV3Id(storageUrl, exp),
      "forged v3 owner-scoped envelope for a private container":
        forgeV3Id(storageUrl.replace(/\/source-images\//, "/nail-photos/"), exp),
    };
    for (const [label, id] of Object.entries(attempts)) {
      assertImageIdRejected(await api(`/images/${encodeURIComponent(id)}`), label);
    }
    assertImageIdRejected(
      await api(`/images/${encodeURIComponent(attempts["forged v3 owner-scoped envelope"])}`, { headers: ATTACKER }),
      "forged v3 owner-scoped envelope with the attacker's token"
    );
  });

  await t.test("owner-scoped (v3) image ids require the owner's token (#227)", async (st) => {
    const privateImageUrl = process.env.E2E_PRIVATE_IMAGE_URL?.trim();
    if (!privateImageUrl) {
      st.diagnostic("E2E_PRIVATE_IMAGE_URL is not set (dev seed has no private media); owner-scoped image case skipped.");
      st.skip("set E2E_PRIVATE_IMAGE_URL to a server-minted v3 /api/images/ URL owned by the E2E owner");
      return;
    }
    const id = decodeURIComponent(new URL(privateImageUrl, `${BASE}/`).pathname.split("/").pop());
    assert.match(id, /^v3\./, `E2E_PRIVATE_IMAGE_URL must carry a v3 id, got ${id}`);
    const path = `/images/${encodeURIComponent(id)}`;

    const owner = await fetch(`${BASE}${path}`, { headers: OWNER, signal: AbortSignal.timeout(30000) });
    await owner.arrayBuffer();
    assert.equal(owner.status, 200, `owner → ${owner.status}`);
    assert.match(owner.headers.get("cache-control") || "", /^private,/);
    assert.doesNotMatch(owner.headers.get("cache-control") || "", /public/);
    assert.ok(
      (owner.headers.get("vary") || "").toLowerCase().split(",").map((v) => v.trim()).includes("authorization"),
      `Vary must include Authorization, got ${owner.headers.get("vary")}`
    );

    const attacker = await api(path, { headers: ATTACKER });
    assert.equal(attacker.status, 403, `attacker → ${attacker.status}`);
    const anonymous = await api(path);
    assert.equal(anonymous.status, 401, `no token → ${anonymous.status}`);
  });
});
