const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const BASE = "http://localhost:7071/api";
const TEST_BRAND = "__TEST__";

/** IDs of polishes created during tests, for cleanup. */
const createdIds = [];

/**
 * Helper: POST JSON to an endpoint.
 */
async function postJson(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// ---------------------------------------------------------------------------
// Catalog search — fuzzy matching via pg_trgm
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
    const res = await fetch(`${BASE}/polishes?search=${TEST_BRAND}&pageSize=100`);
    if (!res.ok) return;
    const data = await res.json();
    for (const p of data.polishes) {
      if (p.brand === TEST_BRAND) {
        await fetch(`${BASE}/polishes/${p.id}`, { method: "DELETE" });
      }
    }
  }

  before(async () => {
    await cleanupTestPolishes();
  });

  after(async () => {
    // Delete everything we created
    for (const id of createdIds) {
      await fetch(`${BASE}/polishes/${id}`, { method: "DELETE" });
    }
    // Belt-and-suspenders: also clean up by brand search
    await cleanupTestPolishes();
  });

  it("GET /api/polishes returns correct list shape", async () => {
    const res = await fetch(`${BASE}/polishes`);
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
      finish: "cream",
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
      `${BASE}/polishes?search=${TEST_BRAND}&pageSize=${PAGE_SIZE}&page=1`
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
      `${BASE}/polishes?search=${TEST_BRAND}&pageSize=${PAGE_SIZE}&page=2`
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
    });
    assert.equal(delRes.status, 200);

    // Verify it's gone
    const getRes = await fetch(`${BASE}/polishes/${created.id}`);
    assert.equal(getRes.status, 404);
  });
});
