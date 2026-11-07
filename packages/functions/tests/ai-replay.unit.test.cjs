const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const {
  aiReplayFetch,
  aiReplayKey,
  canonicalizeAiRequest,
  fixturePath,
  isAiReplayMissError,
  resetAiReplayStateForTests,
  resolveAiReplayMode,
  resolveAiReplayDir,
  DEFAULT_AI_REPLAY_DIR,
  AI_REPLAY_POLL_ORIGIN,
} = require("../dist/lib/ai-replay");

const PNG_BYTES = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const PNG_DATA_URL = `data:image/png;base64,${PNG_BYTES.toString("base64")}`;
const PNG_SHA = `sha256:${crypto.createHash("sha256").update(PNG_BYTES).digest("hex")}`;

const SECRET = "super-secret-key-value-123";
const CHAT_URL = "https://res.cognitiveservices.azure.com/openai/deployments/gpt-4o-mini/chat/completions?api-version=2024-10-21";

function chatInit(imageUrl = PNG_DATA_URL, extraHeaders = {}) {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": SECRET, ...extraHeaders },
    body: JSON.stringify({
      temperature: 0,
      messages: [
        { role: "system", content: "read the sticker" },
        { role: "user", content: [{ type: "image_url", image_url: { url: imageUrl, detail: "low" } }] },
      ],
    }),
  };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ai-replay-test-"));
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** A fake real fetch that counts calls and answers from `respond(url, init)`. */
function fakeFetch(respond) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return respond(url, init, calls.length);
  };
  return { impl, calls };
}

beforeEach(() => resetAiReplayStateForTests());

describe("resolveAiReplayMode", () => {
  it("defaults to off and accepts record / replay in any case", () => {
    assert.equal(resolveAiReplayMode({}), "off");
    assert.equal(resolveAiReplayMode({ AI_REPLAY_MODE: "" }), "off");
    assert.equal(resolveAiReplayMode({ AI_REPLAY_MODE: "yes" }), "off");
    assert.equal(resolveAiReplayMode({ AI_REPLAY_MODE: " Replay " }), "replay");
    assert.equal(resolveAiReplayMode({ AI_REPLAY_MODE: "RECORD" }), "record");
  });

  it("is forced off on a hosted Azure instance, with one warning", (t) => {
    const warn = t.mock.method(console, "warn", () => undefined);
    assert.equal(resolveAiReplayMode({ AI_REPLAY_MODE: "replay", WEBSITE_INSTANCE_ID: "abc" }), "off");
    assert.equal(resolveAiReplayMode({ AI_REPLAY_MODE: "record", WEBSITE_HOSTNAME: "app.azurewebsites.net" }), "off");
    assert.equal(warn.mock.callCount(), 1);
    // Core Tools sets WEBSITE_HOSTNAME=localhost:7071 locally: still allowed.
    assert.equal(resolveAiReplayMode({ AI_REPLAY_MODE: "replay", WEBSITE_HOSTNAME: "localhost:7071" }), "replay");
  });

  it("stores fixtures under packages/functions/eval/ai-replay by default", () => {
    assert.equal(DEFAULT_AI_REPLAY_DIR, path.resolve(__dirname, "..", "eval", "ai-replay"));
    assert.equal(resolveAiReplayDir({}), DEFAULT_AI_REPLAY_DIR);
    assert.equal(resolveAiReplayDir({ AI_REPLAY_DIR: "/tmp/x" }), path.resolve("/tmp/x"));
  });
});

describe("canonicalizeAiRequest", () => {
  it("replaces data-URL images with the sha256 of their bytes", () => {
    const canonical = canonicalizeAiRequest(CHAT_URL, chatInit());
    const serialized = JSON.stringify(canonical);
    assert.ok(serialized.includes(PNG_SHA), serialized);
    assert.ok(!serialized.includes(PNG_BYTES.toString("base64")), "image bytes must not be in the canonical request");
  });

  it("hashes a bare base64 payload (Document Intelligence base64Source)", () => {
    const big = crypto.randomBytes(600);
    const canonical = canonicalizeAiRequest(
      "https://di.cognitiveservices.azure.com/documentintelligence/documentModels/prebuilt-read:analyze?api-version=2024-11-30",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ base64Source: big.toString("base64") }) }
    );
    assert.equal(canonical.body.base64Source, `sha256:${crypto.createHash("sha256").update(big).digest("hex")}`);
  });

  it("never carries credential headers or query parameters", () => {
    const canonical = canonicalizeAiRequest(`${CHAT_URL}&api-key=${SECRET}&code=${SECRET}`, chatInit(PNG_DATA_URL, {
      Authorization: `Bearer ${SECRET}`,
      "Ocp-Apim-Subscription-Key": SECRET,
    }));
    assert.ok(!JSON.stringify(canonical).includes(SECRET));
    assert.deepEqual(Object.keys(canonical.headers), ["content-type"]);
    assert.deepEqual(canonical.query, [["api-version", "2024-10-21"]]);
  });

  it("gives the same key regardless of host, query order, JSON key order and credentials", () => {
    const a = aiReplayKey(canonicalizeAiRequest(`${CHAT_URL}&b=2&a=1`, chatInit()));
    const otherHost = CHAT_URL.replace("res.cognitiveservices.azure.com", "other.openai.azure.com");
    const reordered = otherHost.replace("?api-version=2024-10-21", "?a=1&api-version=2024-10-21&b=2");
    const init = chatInit(PNG_DATA_URL, { "api-key": "another-key" });
    init.body = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(init.body)).reverse()));
    assert.equal(aiReplayKey(canonicalizeAiRequest(reordered, init)), a);
  });

  it("changes the key when the deployment, prompt or image changes", () => {
    const base = aiReplayKey(canonicalizeAiRequest(CHAT_URL, chatInit()));
    assert.notEqual(aiReplayKey(canonicalizeAiRequest(CHAT_URL.replace("gpt-4o-mini", "gpt-5-mini"), chatInit())), base);
    const otherImage = `data:image/png;base64,${crypto.randomBytes(40).toString("base64")}`;
    assert.notEqual(aiReplayKey(canonicalizeAiRequest(CHAT_URL, chatInit(otherImage))), base);
    const init = chatInit();
    init.body = init.body.replace("read the sticker", "read the label");
    assert.notEqual(aiReplayKey(canonicalizeAiRequest(CHAT_URL, init)), base);
  });
});

describe("aiReplayFetch", () => {
  it("off mode is a plain pass-through and writes nothing", async () => {
    const dir = tempDir();
    const real = fakeFetch(() => jsonResponse({ ok: true }));
    const response = await aiReplayFetch(CHAT_URL, chatInit(), { env: { AI_REPLAY_DIR: dir }, fetchImpl: real.impl });
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(real.calls.length, 1);
    assert.equal(real.calls[0].url, CHAT_URL);
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  it("records a response without secrets or image bytes, then replays it with no network", async () => {
    const dir = tempDir();
    const body = { model: "gpt-4o-mini-2024-07-18", choices: [{ message: { content: '{"brand":"Holo Taco"}' } }] };
    const real = fakeFetch(() => jsonResponse(body, 200, { "x-request-id": "r1", "set-cookie": "s=1" }));
    const recorded = await aiReplayFetch(CHAT_URL, chatInit(), { env: { AI_REPLAY_MODE: "record", AI_REPLAY_DIR: dir }, fetchImpl: real.impl });
    assert.deepEqual(await recorded.json(), body);

    const key = aiReplayKey(canonicalizeAiRequest(CHAT_URL, chatInit()));
    const file = fixturePath(dir, "azure-openai", key);
    const raw = fs.readFileSync(file, "utf8");
    assert.ok(!raw.includes(SECRET), "secret leaked into the fixture");
    assert.ok(!raw.includes(PNG_BYTES.toString("base64")), "image bytes leaked into the fixture");
    const fixture = JSON.parse(raw);
    assert.equal(fixture.deployment, "gpt-4o-mini");
    assert.equal(fixture.model, "gpt-4o-mini-2024-07-18");
    assert.deepEqual(Object.keys(fixture.response.headers), ["content-type"]);

    const offline = fakeFetch(() => {
      throw new Error("network must not be used in replay mode");
    });
    const replayed = await aiReplayFetch(CHAT_URL.replace("res.", "elsewhere."), chatInit(), {
      env: { AI_REPLAY_MODE: "replay", AI_REPLAY_DIR: dir },
      fetchImpl: offline.impl,
    });
    assert.equal(replayed.status, 200);
    assert.deepEqual(await replayed.json(), body);
    assert.equal(offline.calls.length, 0);
  });

  it("a replay miss throws with the key and a request summary, never calling out", async (t) => {
    t.mock.method(console, "error", () => undefined);
    const dir = tempDir();
    const offline = fakeFetch(() => jsonResponse({}));
    await assert.rejects(
      aiReplayFetch(CHAT_URL, chatInit(), { env: { AI_REPLAY_MODE: "replay", AI_REPLAY_DIR: dir }, fetchImpl: offline.impl }),
      (error) => {
        assert.ok(isAiReplayMissError(error));
        assert.match(error.message, /POST \/openai\/deployments\/gpt-4o-mini\/chat\/completions/);
        assert.ok(error.message.includes(error.key));
        assert.ok(!error.message.includes(SECRET));
        return true;
      }
    );
    assert.equal(offline.calls.length, 0);
  });

  it("record overwrites a hit; AI_REPLAY_RECORD_MISSING_ONLY reuses it", async () => {
    const dir = tempDir();
    let n = 0;
    const real = fakeFetch(() => jsonResponse({ n: ++n }));
    const env = { AI_REPLAY_MODE: "record", AI_REPLAY_DIR: dir };
    await aiReplayFetch(CHAT_URL, chatInit(), { env, fetchImpl: real.impl });
    const second = await aiReplayFetch(CHAT_URL, chatInit(), { env, fetchImpl: real.impl });
    assert.deepEqual(await second.json(), { n: 2 });
    assert.equal(real.calls.length, 2);

    const reused = await aiReplayFetch(CHAT_URL, chatInit(), {
      env: { ...env, AI_REPLAY_RECORD_MISSING_ONLY: "true" },
      fetchImpl: real.impl,
    });
    assert.deepEqual(await reused.json(), { n: 2 });
    assert.equal(real.calls.length, 2);
  });

  it("is forced off on a hosted instance even with replay requested", async (t) => {
    t.mock.method(console, "warn", () => undefined);
    const dir = tempDir();
    const real = fakeFetch(() => jsonResponse({ live: true }));
    const response = await aiReplayFetch(CHAT_URL, chatInit(), {
      env: { AI_REPLAY_MODE: "replay", AI_REPLAY_DIR: dir, WEBSITE_INSTANCE_ID: "i-1" },
      fetchImpl: real.impl,
    });
    assert.deepEqual(await response.json(), { live: true });
    assert.equal(real.calls.length, 1);
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  it("records and replays the Document Intelligence submit + poll through a synthetic poll URL", async () => {
    const dir = tempDir();
    const analyzeUrl = "https://di.cognitiveservices.azure.com/documentintelligence/documentModels/prebuilt-read:analyze?api-version=2024-11-30";
    const realPoll = "https://di.cognitiveservices.azure.com/documentintelligence/documentModels/prebuilt-read/analyzeResults/RANDOM-123?api-version=2024-11-30";
    const submitInit = {
      method: "POST",
      headers: { "Ocp-Apim-Subscription-Key": SECRET, "Content-Type": "application/json" },
      body: JSON.stringify({ base64Source: PNG_BYTES.toString("base64") }),
    };
    const pollInit = { method: "GET", headers: { "Ocp-Apim-Subscription-Key": SECRET } };
    const final = { status: "succeeded", analyzeResult: { content: "HOLO TACO\nPink Poodle" } };
    const real = fakeFetch((url, _init, count) => {
      if (url === analyzeUrl) return new Response(null, { status: 202, headers: { "Operation-Location": realPoll } });
      assert.equal(url, realPoll);
      return jsonResponse(count === 2 ? { status: "running" } : final);
    });
    const env = { AI_REPLAY_MODE: "record", AI_REPLAY_DIR: dir };

    const submit = await aiReplayFetch(analyzeUrl, submitInit, { env, fetchImpl: real.impl });
    assert.equal(submit.status, 202);
    const pollUrl = submit.headers.get("operation-location");
    assert.ok(pollUrl.startsWith(`${AI_REPLAY_POLL_ORIGIN}/ai-replay/poll/`), pollUrl);
    assert.equal(((await (await aiReplayFetch(pollUrl, pollInit, { env, fetchImpl: real.impl })).json())).status, "running");
    assert.equal(((await (await aiReplayFetch(pollUrl, pollInit, { env, fetchImpl: real.impl })).json())).status, "succeeded");

    const files = fs.readdirSync(path.join(dir, "document-intelligence"));
    assert.equal(files.length, 2, "submit + final poll only (the running poll is not stored)");
    for (const file of files) {
      const raw = fs.readFileSync(path.join(dir, "document-intelligence", file), "utf8");
      assert.ok(!raw.includes(SECRET));
      assert.ok(!raw.includes("RANDOM-123"), "the real Operation-Location must not be stored");
    }

    const offline = fakeFetch(() => {
      throw new Error("no network in replay");
    });
    const replayEnv = { AI_REPLAY_MODE: "replay", AI_REPLAY_DIR: dir };
    const replaySubmit = await aiReplayFetch(analyzeUrl, submitInit, { env: replayEnv, fetchImpl: offline.impl });
    assert.equal(replaySubmit.status, 202);
    const replayPoll = await aiReplayFetch(replaySubmit.headers.get("operation-location"), pollInit, {
      env: replayEnv,
      fetchImpl: offline.impl,
    });
    assert.deepEqual(await replayPoll.json(), final);
    assert.equal(offline.calls.length, 0);
  });
});

describe("AI call sites go through aiReplayFetch", () => {
  const LIB = path.resolve(__dirname, "../src/lib");
  // ai-color-detection.ts carries every chat completion (sticker read, glass pick, hex detection,
  // palette pick); ocr-parser.ts the label parse; ocr.ts Document Intelligence.
  for (const file of ["ai-color-detection.ts", "ocr-parser.ts", "ocr.ts"]) {
    it(`${file} uses aiReplayFetch and never the global fetch`, () => {
      const source = fs.readFileSync(path.join(LIB, file), "utf8");
      assert.match(source, /import \{[^}]*\baiReplayFetch\b[^}]*\} from "\.\/ai-replay"/);
      const bareFetch = source.match(/(?<![\w.])fetch\(/g) ?? [];
      assert.deepEqual(bareFetch, [], `${file} calls the global fetch()`);
    });
  }

  for (const file of ["sticker-read.ts", "glass-color.ts"]) {
    it(`${file} calls Azure OpenAI only through requestAzureOpenAIChatCompletion`, () => {
      const source = fs.readFileSync(path.join(LIB, file), "utf8");
      assert.match(source, /requestAzureOpenAIChatCompletion\(/);
      assert.deepEqual(source.match(/(?<![\w.])fetch\(/g) ?? [], [], `${file} calls the global fetch()`);
    });
  }
});
