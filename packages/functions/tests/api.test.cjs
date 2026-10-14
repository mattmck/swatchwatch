const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const BASE = "http://localhost:7071/api";
const TEST_BRAND = "__TEST__";
const AUTH_HEADERS = { Authorization: "Bearer dev:1" };

/** IDs of polishes created during tests, for cleanup. */
const createdIds = [];

/**
 * Helper: POST JSON to an endpoint.
 */
async function postJson(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/**
 * Helper: PUT JSON to an endpoint.
 */
async function putJson(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// ---------------------------------------------------------------------------
// Catalog search — fuzzy matching via pg_trgm (public, no auth needed)
// ---------------------------------------------------------------------------

describe("GET /api/catalog/search", () => {
  it("returns exact brand matches with similarity 1.0", async () => {
    const res = await fetch(`${BASE}/catalog/search?q=OPI`);
    assert.equal(res.status, 200);

    const data = await res.json();
    assert.ok(Array.isArray(data.results), "results is an array");
    assert.ok(data.results.length > 0, "at least one result for OPI");
    assert.equal(data.query, "OPI");
    assert.equal(typeof data.total, "number");

    // Every result should be OPI brand with similarity 1
    for (const r of data.results) {
      assert.equal(r.brand, "OPI");
      assert.equal(r.similarity, 1);
      assert.ok(r.shadeId, "has shadeId");
      assert.ok(r.name, "has name");
    }
  });

  it("returns fuzzy matches for misspelled queries", async () => {
    const res = await fetch(`${BASE}/catalog/search?q=ballt+sliprs`);
    assert.equal(res.status, 200);

    const data = await res.json();
    assert.ok(data.results.length > 0, "fuzzy search returned results");

    const match = data.results.find((r) => r.name === "Ballet Slippers");
    assert.ok(match, 'found "Ballet Slippers" via fuzzy match');
    assert.ok(match.similarity > 0, "similarity is positive");
    assert.ok(match.similarity < 1, "similarity is less than 1 (fuzzy, not exact)");
  });

  it("returns 400 when q parameter is missing", async () => {
    const res = await fetch(`${BASE}/catalog/search`);
    assert.equal(res.status, 400);

    const data = await res.json();
    assert.ok(data.error, "error message present");
  });
});

// ---------------------------------------------------------------------------
// Polishes CRUD — pagination and quantity controls
// ---------------------------------------------------------------------------

describe("Polishes API — pagination and quantity controls", () => {
  /** Clean up any __TEST__ polishes left from prior runs + this run. */
  async function cleanupTestPolishes() {
    const res = await fetch(`${BASE}/polishes?search=${TEST_BRAND}&pageSize=100`, {
      headers: AUTH_HEADERS,
    });
    if (!res.ok) return;
    const data = await res.json();
    for (const p of data.polishes) {
      if (p.brand === TEST_BRAND) {
        await fetch(`${BASE}/polishes/${p.id}`, {
          method: "DELETE",
          headers: AUTH_HEADERS,
        });
      }
    }
  }

  before(async () => {
    await cleanupTestPolishes();
  });

  after(async () => {
    // Delete everything we created
    for (const id of createdIds) {
      await fetch(`${BASE}/polishes/${id}`, {
        method: "DELETE",
        headers: AUTH_HEADERS,
      });
    }
    // Belt-and-suspenders: also clean up by brand search
    await cleanupTestPolishes();
  });

  it("returns 401 without auth header", async () => {
    const res = await fetch(`${BASE}/polishes`);
    assert.equal(res.status, 401);
  });

  it("GET /api/polishes returns correct list shape", async () => {
    const res = await fetch(`${BASE}/polishes`, { headers: AUTH_HEADERS });
    assert.equal(res.status, 200);

    const data = await res.json();
    assert.ok(Array.isArray(data.polishes), "polishes is an array");
    assert.equal(typeof data.total, "number");
    assert.equal(typeof data.page, "number");
    assert.equal(typeof data.pageSize, "number");
  });

  it("POST /api/polishes creates a polish and returns it", async () => {
    const { status, body } = await postJson("/polishes", {
      brand: TEST_BRAND,
      name: "Test Shade Alpha",
      color: "Red",
      colorHex: "#FF0000",
      finish: "creme",
      quantity: 2,
      rating: 4,
    });

    assert.equal(status, 201);
    assert.ok(body.id, "created polish has an id");
    assert.equal(body.brand, TEST_BRAND);
    assert.equal(body.quantity, 2);
    assert.equal(body.rating, 4);

    createdIds.push(body.id);
  });

  it("PUT /api/polishes/:id updates quantity (simulates +/- controls)", async () => {
    // Create a polish to update
    const { body: created } = await postJson("/polishes", {
      brand: TEST_BRAND,
      name: "Test Shade Quantity",
      color: "Blue",
      colorHex: "#0000FF",
      finish: "shimmer",
      quantity: 1,
    });
    createdIds.push(created.id);

    // Increment quantity (+ button)
    const { status: s1, body: after1 } = await putJson(
      `/polishes/${created.id}`,
      { quantity: 2 }
    );
    assert.equal(s1, 200);
    assert.equal(after1.quantity, 2, "quantity incremented to 2");

    // Decrement quantity (- button)
    const { status: s2, body: after2 } = await putJson(
      `/polishes/${created.id}`,
      { quantity: 1 }
    );
    assert.equal(s2, 200);
    assert.equal(after2.quantity, 1, "quantity decremented back to 1");
  });

  it("GET /api/polishes paginates when items exceed page size", async () => {
    // Seed enough polishes to guarantee pagination with pageSize=5
    const PAGE_SIZE = 5;
    for (let i = 0; i < PAGE_SIZE + 2; i++) {
      const { body } = await postJson("/polishes", {
        brand: TEST_BRAND,
        name: `Pagination Shade ${i}`,
        color: "Green",
        colorHex: "#00FF00",
        finish: "glitter",
        quantity: 1,
      });
      createdIds.push(body.id);
    }

    // Request page 1 with small page size
    const res = await fetch(
      `${BASE}/polishes?search=${TEST_BRAND}&pageSize=${PAGE_SIZE}&page=1`,
      { headers: AUTH_HEADERS }
    );
    assert.equal(res.status, 200);

    const data = await res.json();
    assert.ok(
      data.total >= PAGE_SIZE + 2,
      `total (${data.total}) should be >= ${PAGE_SIZE + 2}`
    );
    assert.ok(
      data.polishes.length <= PAGE_SIZE,
      `page 1 returns at most ${PAGE_SIZE} items (got ${data.polishes.length})`
    );

    // Request page 2 — should have the overflow
    const res2 = await fetch(
      `${BASE}/polishes?search=${TEST_BRAND}&pageSize=${PAGE_SIZE}&page=2`,
      { headers: AUTH_HEADERS }
    );
    const data2 = await res2.json();
    assert.ok(data2.polishes.length > 0, "page 2 has items");
    assert.equal(data2.page, 2);
  });

  it("DELETE /api/polishes/:id removes a polish", async () => {
    const { body: created } = await postJson("/polishes", {
      brand: TEST_BRAND,
      name: "Test Shade Delete Me",
      color: "Black",
      colorHex: "#000000",
      finish: "matte",
      quantity: 1,
    });

    const delRes = await fetch(`${BASE}/polishes/${created.id}`, {
      method: "DELETE",
      headers: AUTH_HEADERS,
    });
    assert.equal(delRes.status, 200);

    // Verify it's gone
    const getRes = await fetch(`${BASE}/polishes/${created.id}`, {
      headers: AUTH_HEADERS,
    });
    assert.equal(getRes.status, 404);
  });
});

// ---------------------------------------------------------------------------
// Cross-user data isolation (#53)
//
// Two distinct seeded dev users (dev bypass requires the user to exist in
// app_user): A = 1 (demo-user), B = 2 (seeded admin; the polish/capture
// handlers do not grant admins cross-user access).
//
// Media isolation (`/api/images/{id}` is anonymous with no ownership check) is
// a known gap covered by a pinned known-gap unit test and a follow-up issue,
// so it is intentionally not asserted here.
// ---------------------------------------------------------------------------

describe("Cross-user data isolation (#53)", () => {
  const USER_A = { Authorization: "Bearer dev:1" };
  const USER_B = { Authorization: "Bearer dev:2" };

  /** Shade ids touched by each user, for cleanup. */
  const aShadeIds = [];
  const bShadeIds = [];
  const captureIds = [];

  async function call(method, path, headers, body) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      // empty body (e.g. 204)
    }
    return { status: res.status, body: json };
  }

  async function createAsA(name, extra = {}) {
    const { status, body } = await call("POST", "/polishes", USER_A, {
      brand: TEST_BRAND,
      name,
      color: "Red",
      colorHex: "#FF0000",
      finish: "creme",
      quantity: 3,
      notes: "A-private-notes",
      ...extra,
    });
    assert.equal(status, 201, `A create failed: ${JSON.stringify(body)}`);
    aShadeIds.push(body.id);
    return body;
  }

  async function purgeTestPolishes(headers) {
    const res = await fetch(`${BASE}/polishes?search=${TEST_BRAND}&pageSize=100`, { headers });
    if (!res.ok) return;
    const data = await res.json();
    for (const p of data.polishes) {
      if (p.brand === TEST_BRAND) {
        await fetch(`${BASE}/polishes/${p.id}`, { method: "DELETE", headers });
      }
    }
  }

  before(async () => {
    await purgeTestPolishes(USER_A);
    await purgeTestPolishes(USER_B);
  });

  after(async () => {
    for (const id of aShadeIds) {
      await fetch(`${BASE}/polishes/${id}`, { method: "DELETE", headers: USER_A });
    }
    for (const id of bShadeIds) {
      await fetch(`${BASE}/polishes/${id}`, { method: "DELETE", headers: USER_B });
    }
    await purgeTestPolishes(USER_A);
    await purgeTestPolishes(USER_B);
    for (const captureId of captureIds) {
      // No delete endpoint for capture sessions; cancel-style cleanup not available.
      void captureId;
    }
  });

  it("user B cannot GET user A's polish by id and does not see it in their list", async () => {
    const created = await createAsA("Isolation Read Shade");

    const asA = await call("GET", `/polishes/${created.id}`, USER_A);
    assert.equal(asA.status, 200);
    assert.equal(asA.body.name, "Isolation Read Shade");

    const asB = await call("GET", `/polishes/${created.id}`, USER_B);
    assert.equal(asB.status, 404);

    const list = await call("GET", `/polishes?search=${TEST_BRAND}&pageSize=100`, USER_B);
    assert.equal(list.status, 200);
    assert.ok(
      !list.body.polishes.some((p) => String(p.id) === String(created.id)),
      "A's polish must not appear in B's list"
    );
  });

  it("user B PUT on A's shade id does not change A's inventory", async () => {
    const created = await createAsA("Isolation Update Shade");
    bShadeIds.push(created.id); // B's PUT may upsert a row for B; clean it up

    const put = await call("PUT", `/polishes/${created.id}`, USER_B, {
      quantity: 99,
      notes: "B-tampered",
    });
    // Acceptable outcomes: rejected, or an upsert into B's own inventory.
    assert.ok([200, 403, 404].includes(put.status), `unexpected status ${put.status}`);

    const asA = await call("GET", `/polishes/${created.id}`, USER_A);
    assert.equal(asA.status, 200);
    assert.equal(asA.body.quantity, 3, "A's quantity unchanged");
    assert.equal(asA.body.notes, "A-private-notes", "A's notes unchanged");
  });

  it("user B DELETE on A's shade id is not-found and A's polish survives", async () => {
    const created = await createAsA("Isolation Delete Shade");

    const del = await call("DELETE", `/polishes/${created.id}`, USER_B);
    assert.equal(del.status, 404);

    const asA = await call("GET", `/polishes/${created.id}`, USER_A);
    assert.equal(asA.status, 200);
    assert.equal(asA.body.name, "Isolation Delete Shade");
  });

  it("POST as user B with a spoofed userId lands in B's inventory, not A's", async () => {
    const { status, body } = await call("POST", "/polishes", USER_B, {
      brand: TEST_BRAND,
      name: "Isolation Spoof Shade",
      color: "Blue",
      colorHex: "#0000FF",
      finish: "creme",
      quantity: 1,
      userId: 1,
      user_id: 1,
    });
    assert.equal(status, 201, JSON.stringify(body));
    bShadeIds.push(body.id);

    const asB = await call("GET", `/polishes/${body.id}`, USER_B);
    assert.equal(asB.status, 200);

    const asA = await call("GET", `/polishes/${body.id}`, USER_A);
    assert.equal(asA.status, 404, "spoofed userId must not place the item in A's inventory");

    const listA = await call("GET", `/polishes?search=${TEST_BRAND}&pageSize=100`, USER_A);
    assert.ok(!listA.body.polishes.some((p) => String(p.id) === String(body.id)));
  });

  it("user B cannot read, answer or finalize user A's capture session", async () => {
    const start = await call("POST", "/capture/start", USER_A, {});
    assert.equal(start.status, 201, JSON.stringify(start.body));
    const captureId = start.body.captureId;
    captureIds.push(captureId);

    const statusA = await call("GET", `/capture/${captureId}/status`, USER_A);
    assert.equal(statusA.status, 200);
    const before = statusA.body.status;

    const statusB = await call("GET", `/capture/${captureId}/status`, USER_B);
    assert.ok([403, 404].includes(statusB.status), `B status got ${statusB.status}`);

    const answerB = await call("POST", `/capture/${captureId}/answer`, USER_B, { answer: "hijack" });
    assert.ok([403, 404].includes(answerB.status), `B answer got ${answerB.status}`);

    const finalizeB = await call("POST", `/capture/${captureId}/finalize`, USER_B, {});
    assert.ok([403, 404].includes(finalizeB.status), `B finalize got ${finalizeB.status}`);

    const statusAfter = await call("GET", `/capture/${captureId}/status`, USER_A);
    assert.equal(statusAfter.status, 200);
    assert.equal(statusAfter.body.status, before, "A's session status unchanged");
  });

  it("requests without an Authorization header are rejected with 401", async () => {
    const res = await fetch(`${BASE}/polishes`);
    assert.equal(res.status, 401);
  });
});
