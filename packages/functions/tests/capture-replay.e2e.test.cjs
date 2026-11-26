/**
 * End-to-end capture tests: what a first Rapid Add user does, plus a bottle read on recorded AI
 * responses (record/replay harness, `src/lib/ai-replay.ts`).
 *
 * Runs against a live local Functions host (default http://localhost:7071/api) started with:
 *   AI_REPLAY_MODE=replay          (answers every Azure OpenAI / Document Intelligence call from
 *                                   eval/ai-replay; a missing fixture fails the call loudly)
 *   BOTTLE_CAPTURE_ENABLED=true    (guided bottle flow: brand hint, sticker read, glass color)
 *   AUTH_DEV_BYPASS=true           (`Bearer dev:1`, `Bearer dev:2`)
 *   AZURE_OPENAI_ENDPOINT / _KEY / _DEPLOYMENT(_HEX) and AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT / _KEY
 *     set to any non-empty placeholder (the call sites need a config to run; in replay mode the
 *     host is not part of the key and nothing is sent). The deployment must be the recorded one
 *     (`gpt-4o-mini`), because it is part of the request path and so of the key.
 * and the dev seed catalog (migration 003: OPI's four seed shades are listed in the sticker-read
 * prompt, so a different OPI catalog changes the request and misses the fixture).
 *
 * Cases:
 * - Rapid Add, barcode → add: a catalog GTIN on a seed shade (Butter London — Teddy Girl) is
 *   scanned by user 2 (`dev:2`, who holds no seed inventory), the `barcode` frame's `check` says
 *   "not owned", the app's Add (`PUT /api/polishes/{shadeId}` owned) makes it owned, the owned
 *   list has it, and a second scan says "owned". There is no API that writes a catalog `barcode`
 *   row (only ingestion and the backfill, from connector products), so the test links the GTIN
 *   itself through the production `upsertShadeBarcodes` (dist/lib/barcodes.js) on a direct
 *   Postgres connection: PG* from the environment, else from local.settings.json.
 * - Rapid Add, create card: user 1 scans an unknown GTIN, skips every photo the bottle flow asks
 *   for ("Can't see it"), the check is `unmatched` with a create card, `POST /api/polishes` with
 *   `captureId` creates the shade, the session is `matched` with it, and the learned GTIN finds
 *   it (owned) on the next scan. Needs `BOTTLE_CAPTURE_ENABLED=true`.
 * - Bottle read on recorded AI responses (needs `AI_REPLAY_MODE=replay` or `record`).
 *
 * Every case skips (not fails) when its host requirements are missing, unless
 * E2E_REQUIRE_HOST=true (CI's "API E2E" job), where a missing requirement fails instead.
 * Re-runs are idempotent: the scanned inventory row is marked with a note and removed afterwards,
 * the create-card case uses a fresh GTIN and shade name per run, and the catalog GTIN is a GS1
 * restricted-circulation code (prefix 200) no real product carries.
 *
 * Fixtures for the replay case (re-record with AI_REPLAY_MODE=record and real Azure settings, see
 * packages/functions README → AI record/replay): the two PNGs in tests/fixtures/capture-replay.
 *
 * Run: node --test tests/capture-replay.e2e.test.cjs (also part of npm run test:e2e).
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const BASE = (process.env.E2E_API_BASE || "http://localhost:7071/api").replace(/\/+$/, "");
const OWNER = { Authorization: `Bearer ${process.env.E2E_OWNER_TOKEN || "dev:1"}` };
// Rapid Add's "first scan" user: holds no seed inventory, so a seed shade starts as not owned.
const SCANNER = { Authorization: `Bearer ${process.env.E2E_SCANNER_TOKEN || "dev:2"}` };
const REQUIRE_HOST = process.env.E2E_REQUIRE_HOST === "true";
const FIXTURES = path.join(__dirname, "fixtures", "capture-replay");
const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// 1x1 transparent PNG: the barcode frame's image (a decoded `quality.gtin` skips OCR).
const TINY_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

// Seed shade the barcode case scans, and the note that marks the inventory row the test adds.
const SCAN_BRAND = "Butter London";
const SCAN_SHADE = "Teddy Girl";
const SCAN_NOTE = "e2e:capture-replay:rapid-add";
// Distinct from api.test.cjs / access-control.e2e.test.cjs test brands so cleanups never collide.
const CREATE_BRAND = "__TEST__RAPID__";

function dataUrl(file) {
  return `data:image/png;base64,${fs.readFileSync(path.join(FIXTURES, file)).toString("base64")}`;
}

/** GS1 check digit for the first 12 digits of an EAN-13. */
function ean13(first12) {
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += Number(first12[i]) * (i % 2 === 0 ? 1 : 3);
  return `${first12}${(10 - (sum % 10)) % 10}`;
}

// Restricted-circulation prefix 200: never a real retail product.
const CATALOG_GTIN = ean13("200000052600");

async function api(route, { method = "GET", headers = OWNER, body, timeoutMs = 60000 } = {}) {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
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
  return { status: res.status, json, text };
}

/** Skip the case with `reason`, or fail it when CI requires a fully configured host. */
function skipOrFail(t, reason) {
  if (REQUIRE_HOST) assert.fail(`E2E_REQUIRE_HOST=true, but ${reason}`);
  t.skip(reason);
}

/** The host's `GET /config/flags` body, or a string saying why it could not be read. */
async function readFlags() {
  try {
    const res = await fetch(`${BASE}/config/flags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return `GET ${BASE}/config/flags answered HTTP ${res.status}`;
    return await res.json();
  } catch (error) {
    return `host unreachable at ${BASE} (${error instanceof Error ? error.message : String(error)})`;
  }
}

/** Why the bottle-flow cases cannot run against this host, or null when they can. */
async function bottleFlowSkipReason({ needsReplay }) {
  const flags = await readFlags();
  if (typeof flags === "string") return flags;
  if (needsReplay && flags.aiReplayMode !== "replay" && flags.aiReplayMode !== "record") {
    return "host is not running with AI_REPLAY_MODE=replay (or record)";
  }
  if (flags.flags?.bottleCapture !== true) return "host is not running with BOTTLE_CAPTURE_ENABLED=true";
  return null;
}

/**
 * Postgres connection settings for the barcode seed: PG* / DATABASE_URL from the environment,
 * missing PG* values filled from local.settings.json (what the local host itself reads).
 */
function pgConfig() {
  if (process.env.DATABASE_URL) return { connectionString: process.env.DATABASE_URL };
  let values = {};
  try {
    values = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "local.settings.json"), "utf8")).Values ?? {};
  } catch {
    values = {};
  }
  const pick = (key) => process.env[key] || values[key] || undefined;
  return {
    host: pick("PGHOST"),
    port: pick("PGPORT") ? Number(pick("PGPORT")) : undefined,
    database: pick("PGDATABASE"),
    user: pick("PGUSER"),
    password: pick("PGPASSWORD"),
    connectionTimeoutMillis: 5000,
  };
}

/** Links CATALOG_GTIN to the shade as a catalog `barcode` row (idempotent), or throws. */
async function linkCatalogBarcode(client, shadeId) {
  const { upsertShadeBarcodes, normalizeGtin } = require("../dist/lib/barcodes");
  const gtin = normalizeGtin(CATALOG_GTIN, "ean_13");
  const result = await upsertShadeBarcodes(client, { shadeId, gtins: [gtin], source: "admin" });
  assert.deepEqual(
    result.conflicts,
    [],
    `GTIN ${CATALOG_GTIN} already belongs to another shade: ${JSON.stringify(result.conflicts)}`
  );
}

/** A barcode frame as the app sends it after decoding the code on the device. */
async function scanBarcode(captureId, gtin, headers) {
  const frame = await api(`/capture/${captureId}/frame`, {
    method: "POST",
    headers,
    body: { frameType: "barcode", imageBlobUrl: TINY_PNG_DATA_URL, quality: { gtin, barcodeFormat: "ean_13" } },
  });
  assert.equal(frame.status, 201, frame.text);
  assert.ok(frame.json.check, `a decoded barcode frame answers with the check verdict: ${frame.text}`);
  return frame.json.check;
}

async function startCapture(headers, metadata = { source: "capture-replay-e2e" }) {
  const start = await api("/capture/start", { method: "POST", headers, body: { metadata } });
  assert.equal(start.status, 201, start.text);
  return start.json;
}

test("Rapid Add: scanning a catalog barcode, then Add, puts the shade in the collection", async (t) => {
  const flags = await readFlags();
  if (typeof flags === "string") {
    skipOrFail(t, flags);
    return;
  }

  const search = await api(`/catalog/search?q=${encodeURIComponent(SCAN_SHADE)}`);
  assert.equal(search.status, 200, search.text);
  const seed = search.json.results.find((r) => r.brand === SCAN_BRAND && r.name === SCAN_SHADE);
  assert.ok(seed, `dev seed shade ${SCAN_BRAND} — ${SCAN_SHADE} (migration 003) not found: ${search.text}`);
  const shadeId = String(seed.shadeId);

  let Client;
  try {
    ({ Client } = require("pg"));
  } catch (error) {
    skipOrFail(t, `the pg module is not available (${error.message})`);
    return;
  }
  const db = new Client(pgConfig());
  try {
    await db.connect();
  } catch (error) {
    skipOrFail(t, `cannot reach the host's Postgres to link a catalog barcode (${error.message}); set PG* or DATABASE_URL`);
    return;
  }
  try {
    await linkCatalogBarcode(db, Number(shadeId));
  } finally {
    await db.end().catch(() => {});
  }

  // A row this test added on an earlier, interrupted run is removed; anything else is the
  // scanner's own data, which the test must not clobber.
  const before = await api(`/polishes/${shadeId}`, { headers: SCANNER });
  assert.equal(before.status, 200, before.text);
  if (before.json.inventoryItemId) {
    assert.equal(
      before.json.notes,
      SCAN_NOTE,
      `the scanner already holds ${SCAN_BRAND} — ${SCAN_SHADE} outside this test; use another E2E_SCANNER_TOKEN`
    );
    const removed = await api(`/polishes/${shadeId}`, { method: "DELETE", headers: SCANNER });
    assert.equal(removed.status, 200, removed.text);
  }
  t.after(async () => {
    await api(`/polishes/${shadeId}`, { method: "DELETE", headers: SCANNER }).catch(() => {});
  });

  // 1. Scan: the frame response carries the read-only verdict for the catalog shade.
  const first = await startCapture(SCANNER);
  const check = await scanBarcode(first.captureId, CATALOG_GTIN, SCANNER);
  assert.equal(check.outcome, "matched", JSON.stringify(check));
  assert.equal(String(check.match?.shadeId), shadeId, JSON.stringify(check));
  assert.equal(check.match.display, `${SCAN_BRAND} — ${SCAN_SHADE}`, JSON.stringify(check));
  assert.equal(check.match.ownership?.relationship, "notOwned", JSON.stringify(check));

  // 2. Add: what the app's Add button sends for a matched shade.
  const added = await api(`/polishes/${shadeId}`, {
    method: "PUT",
    headers: SCANNER,
    body: { status: "owned", quantity: 1, notes: SCAN_NOTE },
  });
  assert.equal(added.status, 200, added.text);
  assert.equal(added.json.status, "owned", added.text);

  // 3. The collection has it.
  const owned = await api(`/polishes?status=owned&search=${encodeURIComponent(SCAN_SHADE)}&pageSize=100`, {
    headers: SCANNER,
  });
  assert.equal(owned.status, 200, owned.text);
  const row = owned.json.polishes.find((p) => String(p.shadeId ?? p.id) === shadeId);
  assert.ok(row, `GET /polishes?status=owned lacks the added shade: ${owned.text}`);
  assert.equal(row.status, "owned", JSON.stringify(row));

  // 4. Scanning the same bottle again says it is already owned.
  const second = await startCapture(SCANNER);
  const again = await scanBarcode(second.captureId, CATALOG_GTIN, SCANNER);
  assert.equal(String(again.match?.shadeId), shadeId, JSON.stringify(again));
  assert.equal(again.match.ownership?.relationship, "owned", JSON.stringify(again));
  assert.equal(again.match.ownership.quantity, 1, JSON.stringify(again));
});

test("Rapid Add: an unmatched bottle is created from the create card and the session is matched", async (t) => {
  const reason = await bottleFlowSkipReason({ needsReplay: false });
  if (reason) {
    skipOrFail(t, reason);
    return;
  }

  // A fresh GTIN per run: the learned barcode of an earlier run would otherwise match it.
  const gtin = ean13(`200${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`);
  const shadeName = `Rapid Create ${RUN_ID}`;
  let createdId = null;
  t.after(async () => {
    if (createdId) await api(`/polishes/${createdId}`, { method: "DELETE", headers: OWNER }).catch(() => {});
  });

  // 1. Scan an unknown barcode with a typed brand: nothing in the catalog.
  const start = await startCapture(OWNER, { brand: CREATE_BRAND, source: "capture-replay-e2e" });
  const captureId = start.captureId;
  const scanned = await scanBarcode(captureId, gtin, OWNER);
  assert.equal(scanned.outcome, "unmatched", JSON.stringify(scanned));

  // 2. "Can't see it" for every photo the flow asks for, until it asks for nothing more.
  let nextFrame = scanned.nextFrame;
  for (let i = 0; nextFrame && i < 8; i += 1) {
    const skipped = await api(`/capture/${captureId}/answer`, {
      method: "POST",
      body: { skipSurface: nextFrame.surface },
    });
    assert.equal(skipped.status, 200, skipped.text);
    nextFrame = skipped.json.nextFrame;
  }
  assert.equal(nextFrame, null, "the bottle flow keeps asking for photos after every surface was skipped");

  // 3. The check ends unmatched with a create card carrying the typed brand and the scanned code.
  const check = await api(`/capture/${captureId}/check`, { method: "POST", body: {} });
  assert.equal(check.status, 200, check.text);
  assert.equal(check.json.outcome, "unmatched", check.text);
  assert.deepEqual(check.json.candidates, [], check.text);
  assert.equal(check.json.suggestedShade?.brandName, CREATE_BRAND, check.text);
  assert.equal(check.json.suggestedShade?.gtin, gtin, check.text);

  // 4. The create card's one tap: the new shade, owned, tied to the session.
  const created = await api("/polishes", {
    method: "POST",
    body: { brand: check.json.suggestedShade.brandName, name: shadeName, status: "owned", quantity: 1, captureId },
  });
  assert.equal(created.status, 201, created.text);
  createdId = created.json.id;
  const createdShadeId = String(created.json.shadeId ?? created.json.id);

  // 5. The session is matched with the new shade.
  const status = await api(`/capture/${captureId}/status`);
  assert.equal(status.status, 200, status.text);
  assert.equal(status.json.status, "matched", status.text);
  assert.equal(status.json.acceptedEntityType, "shade", status.text);
  assert.equal(String(status.json.acceptedEntityId), createdShadeId, status.text);

  // 6. The scanned code was learned for this user: the next scan finds the new shade, owned.
  const rescan = await startCapture(OWNER);
  const again = await scanBarcode(rescan.captureId, gtin, OWNER);
  assert.equal(again.outcome, "matched", JSON.stringify(again));
  assert.equal(String(again.match?.shadeId), createdShadeId, JSON.stringify(again));
  assert.equal(again.match.ownership?.relationship, "owned", JSON.stringify(again));
});

// TODO(#526): the committed eval/ai-replay fixtures no longer match the requests the host sends
// (the sticker read was reworked in #508 after they were recorded on 2026-11-07, and the label
// parse prompt lists the finish catalog of the database it runs on), so on a freshly migrated
// database every Azure OpenAI call misses and the read comes back empty. Re-record against a
// freshly migrated dev seed (AI_REPLAY_MODE=record, see the README) and drop `todo`. Until then
// the case still runs and reports, but does not fail the suite.
test(
  "capture reads a bottle from recorded AI responses (replay mode)",
  { todo: "eval/ai-replay fixtures are stale (re-record them, see the TODO above)" },
  async (t) => {
    const reason = await bottleFlowSkipReason({ needsReplay: true });
    if (reason) {
      skipOrFail(t, reason);
      return;
    }

    const start = await api("/capture/start", { method: "POST", body: { metadata: { brand: "OPI", source: "capture-replay-e2e" } } });
    assert.equal(start.status, 201, start.text);
    const captureId = start.json.captureId;
    assert.ok(start.json.brandHint?.brandId, `OPI must resolve to the seed brand: ${start.text}`);

    // Label (bottom sticker): Document Intelligence OCR → label parse → closed-set sticker read.
    const label = await api(`/capture/${captureId}/frame`, {
      method: "POST",
      body: { frameType: "label", imageBlobUrl: dataUrl("label-opi-big-apple-red.png"), quality: { surface: "bottom" } },
    });
    assert.equal(label.status, 201, label.text);
    const afterLabel = label.json.readSoFar;
    assert.ok(afterLabel, `label frame response has no readSoFar: ${label.text}`);
    assert.equal(afterLabel.shadeName, "Big Apple Red", label.text);
    assert.equal(afterLabel.brand?.name, "OPI", label.text);

    // Glass: palette chips measured on the server, one recorded palette pick.
    const glass = await api(`/capture/${captureId}/frame`, {
      method: "POST",
      body: { frameType: "color", imageBlobUrl: dataUrl("glass-red-bottle.png"), quality: { surface: "glass" } },
    });
    assert.equal(glass.status, 201, glass.text);
    const hex = glass.json.readSoFar?.hex;
    assert.match(hex ?? "", /^#[0-9A-F]{6}$/i, glass.text);
    assert.deepEqual(glass.json.readSoFar.newFields, ["hex"], glass.text);

    // The read-only check resolves the seed shade from the replayed reads.
    const check = await api(`/capture/${captureId}/check`, { method: "POST", body: {} });
    assert.equal(check.status, 200, check.text);
    assert.equal(check.json.outcome, "matched", check.text);
    assert.equal(check.json.match?.display, "OPI — Big Apple Red", check.text);

    // Same inputs, same answers: a second session reads exactly the same hex.
    const again = await api("/capture/start", { method: "POST", body: { metadata: { brand: "OPI" } } });
    assert.equal(again.status, 201, again.text);
    const glassAgain = await api(`/capture/${again.json.captureId}/frame`, {
      method: "POST",
      body: { frameType: "color", imageBlobUrl: dataUrl("glass-red-bottle.png"), quality: { surface: "glass" } },
    });
    assert.equal(glassAgain.json?.readSoFar?.hex, hex, glassAgain.text);
    // Sessions are left open (read-only check, no finalize): nothing is added to the collection.
  }
);
