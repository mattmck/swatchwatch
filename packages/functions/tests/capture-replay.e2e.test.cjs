/**
 * End-to-end capture test on recorded AI responses (record/replay harness, `src/lib/ai-replay.ts`).
 *
 * Runs against a live local Functions host (default http://localhost:7071/api) started with:
 *   AI_REPLAY_MODE=replay          (answers every Azure OpenAI / Document Intelligence call from
 *                                   eval/ai-replay; a missing fixture fails the call loudly)
 *   BOTTLE_CAPTURE_ENABLED=true    (guided bottle flow: brand hint, sticker read, glass color)
 *   AUTH_DEV_BYPASS=true           (`Bearer dev:1`)
 *   AZURE_OPENAI_ENDPOINT / _KEY / _DEPLOYMENT(_HEX) and AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT / _KEY
 *     set to any non-empty placeholder (the call sites need a config to run; in replay mode the
 *     host is not part of the key and nothing is sent). The deployment must be the recorded one
 *     (`gpt-4o-mini`), because it is part of the request path and so of the key.
 * and the dev seed catalog (migration 003: OPI's four seed shades are listed in the sticker-read
 * prompt, so a different OPI catalog changes the request and misses the fixture).
 *
 * Skipped (not failed) when the host is unreachable, or when `GET /api/config/flags` does not
 * report `flags.bottleCapture: true` and an `aiReplayMode` (`replay`, or `record`: the same
 * requests then go to Azure and (re)write the fixtures, which is how they were made).
 *
 * Fixtures (re-record with AI_REPLAY_MODE=record and real Azure settings, see packages/functions
 * README → AI record/replay): the two PNGs in tests/fixtures/capture-replay are sent as-is.
 *
 * Run: node --test tests/capture-replay.e2e.test.cjs (also part of npm run test:e2e).
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const BASE = (process.env.E2E_API_BASE || "http://localhost:7071/api").replace(/\/+$/, "");
const AUTH = { Authorization: `Bearer ${process.env.E2E_OWNER_TOKEN || "dev:1"}` };
const FIXTURES = path.join(__dirname, "fixtures", "capture-replay");

function dataUrl(file) {
  return `data:image/png;base64,${fs.readFileSync(path.join(FIXTURES, file)).toString("base64")}`;
}

async function api(route, { method = "GET", body, timeoutMs = 60000 } = {}) {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: { ...AUTH, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
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

/** Why the suite cannot run against this host, or null when it can. */
async function skipReason() {
  let flags;
  try {
    const res = await fetch(`${BASE}/config/flags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return `GET ${BASE}/config/flags answered HTTP ${res.status}`;
    flags = await res.json();
  } catch (error) {
    return `host unreachable at ${BASE} (${error instanceof Error ? error.message : String(error)})`;
  }
  if (flags.aiReplayMode !== "replay" && flags.aiReplayMode !== "record") {
    return "host is not running with AI_REPLAY_MODE=replay (or record)";
  }
  if (flags.flags?.bottleCapture !== true) return "host is not running with BOTTLE_CAPTURE_ENABLED=true";
  return null;
}

test("capture reads a bottle from recorded AI responses (replay mode)", async (t) => {
  const reason = await skipReason();
  if (reason) {
    t.skip(reason);
    return;
  }

  const start = await api("/capture/start", { method: "POST", body: { metadata: { brand: "OPI", source: "capture-replay-e2e" } } });
  assert.equal(start.status, 201, start.text);
  const captureId = start.json.captureId;
  assert.ok(start.json.brandHint?.brandId, `OPI must resolve to the seed brand: ${start.text}`);

  {
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
  }
  // Sessions are left open (read-only check, no finalize): nothing is added to the collection.
});
