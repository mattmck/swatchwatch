/**
 * AI prompts list the RUNTIME finish catalog (#224, item 3): vision hex/finish detection (sync +
 * batch) and label OCR offer admin-added finish types such as `chrome`, falling back to the
 * built-in CANONICAL_FINISHES when the catalog cannot be loaded. Prompt construction only; no
 * Azure call is made (fetch is stubbed and requests are captured).
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// ---------------------------------------------------------------------------
// Fake ../lib/db: the finish catalog query returns the built-ins plus admin-added `chrome`,
// or throws when `failCatalog` is set.
// ---------------------------------------------------------------------------
const { CANONICAL_FINISHES } = require("swatchwatch-shared");

let failCatalog = false;
let catalogQueries = 0;
const dbPath = path.resolve(__dirname, "../dist/lib/db.js");
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    query: async (sql) => {
      if (/FROM\s+finish_type/i.test(String(sql))) {
        catalogQueries++;
        if (failCatalog) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
        return {
          rows: [...CANONICAL_FINISHES, "chrome", "aurora"].map((name) => ({
            kind: "type",
            sourceValue: name,
            normalizedFinishName: name,
          })),
        };
      }
      return { rows: [] };
    },
    transaction: async () => {
      throw new Error("not used");
    },
  },
};

const {
  DEFAULT_FINISH_CATALOG,
  finishNamesForPrompt,
  loadFinishCatalog,
  resetFinishAliasCache,
} = require("../dist/lib/finishes");
const {
  buildHexDetectionRequestPayload,
  detectHexWithAzureOpenAI,
  PROMPT_VERSION,
} = require("../dist/lib/ai-color-detection");
const { submitVisionHexBatch } = require("../dist/lib/azure-openai-batch");
const { buildLabelSystemPrompt, parseLabelText } = require("../dist/lib/ocr-parser");

const BUILT_IN_PROMPT_LIST = CANONICAL_FINISHES.filter((name) => name !== "other");

function promptText(payload) {
  return payload.messages
    .flatMap((m) => (typeof m.content === "string" ? [m.content] : m.content.map((part) => part.text || "")))
    .join("\n");
}

const ENV_KEYS = [
  "AZURE_OPENAI_USE_GATEWAY",
  "AZURE_OPENAI_GATEWAY_ENDPOINT",
  "AZURE_OPENAI_GATEWAY_SUBSCRIPTION_KEY",
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_KEY",
  "AZURE_OPENAI_DEPLOYMENT_HEX",
  "AZURE_OPENAI_DEPLOYMENT_HEX_BATCH",
  "AZURE_OPENAI_DEPLOYMENT_LABEL",
  "AZURE_OPENAI_DEPLOYMENT",
];
let savedEnv;
let savedFetch;

beforeEach(() => {
  failCatalog = false;
  catalogQueries = 0;
  resetFinishAliasCache();
  savedEnv = {};
  savedFetch = global.fetch;
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.AZURE_OPENAI_ENDPOINT = "https://test.openai.azure.com/";
  process.env.AZURE_OPENAI_KEY = "test-key";
  process.env.AZURE_OPENAI_DEPLOYMENT_HEX = "hex-deploy";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  global.fetch = savedFetch;
});

describe("finishNamesForPrompt", () => {
  it("defaults to the built-in finishes in seeded order, without the `other` catch-all", () => {
    assert.deepEqual(finishNamesForPrompt(), BUILT_IN_PROMPT_LIST);
    assert.deepEqual(finishNamesForPrompt(DEFAULT_FINISH_CATALOG), BUILT_IN_PROMPT_LIST);
  });

  it("appends admin-added finish types alphabetically after the built-ins (stable, cacheable order)", async () => {
    const catalog = await loadFinishCatalog();
    assert.deepEqual(finishNamesForPrompt(catalog), [...BUILT_IN_PROMPT_LIST, "aurora", "chrome"]);
  });

  it("drops built-ins an admin deleted", () => {
    const catalog = { aliases: new Map(), validNames: new Set(["creme", "chrome"]) };
    assert.deepEqual(finishNamesForPrompt(catalog), ["creme", "chrome"]);
  });
});

describe("vision hex/finish prompt — buildHexDetectionRequestPayload", () => {
  it("lists an admin-added finish when given the runtime catalog (normal and safe prompts)", async () => {
    const finishCatalog = await loadFinishCatalog();
    for (const safePrompt of [false, true]) {
      const text = promptText(buildHexDetectionRequestPayload("https://img.example/a.jpg", { finishCatalog }, safePrompt));
      assert.match(text, /using only these finish names: creme, sheer, .*, glow, aurora, chrome\./);
      assert.doesNotMatch(text, /velvet/, "no hard-coded finish that is not in the catalog");
    }
  });

  it("falls back to the built-in finishes without a catalog", () => {
    const text = promptText(buildHexDetectionRequestPayload("https://img.example/a.jpg"));
    assert.ok(text.includes(`using only these finish names: ${BUILT_IN_PROMPT_LIST.join(", ")}.`));
    assert.doesNotMatch(text, /\bchrome\b/);
  });

  it("is deterministic for the same catalog (prompt prefix stays cacheable)", async () => {
    const finishCatalog = await loadFinishCatalog();
    const a = buildHexDetectionRequestPayload("https://img.example/a.jpg", { finishCatalog });
    const b = buildHexDetectionRequestPayload("https://img.example/a.jpg", { finishCatalog });
    assert.deepEqual(a, b);
  });

  it("uses a bumped prompt version", () => {
    assert.equal(PROMPT_VERSION, "vision-direct/2026-10-v2");
  });
});

describe("vision hex/finish prompt — sync path (detectHexWithAzureOpenAI)", () => {
  function captureFetch(content) {
    const bodies = [];
    global.fetch = async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    };
    return bodies;
  }

  it("sends the runtime catalog and accepts the admin-added finish in the reply", async () => {
    const bodies = captureFetch('{"hex":"#112233","confidence":0.9,"finishes":["chrome","shimmer"]}');
    const result = await detectHexWithAzureOpenAI("https://img.example/a.jpg", { onLog: () => {} });
    assert.equal(bodies.length, 1);
    assert.match(promptText(bodies[0]), /finish names: [^.]*\bchrome\b/);
    assert.deepEqual(result.finishes, ["chrome", "shimmer"]);
    assert.equal(result.promptVersion, PROMPT_VERSION);
    assert.equal(catalogQueries, 1, "one catalog load serves both the prompt and the parse");
  });

  it("falls back to the built-in list when the catalog cannot be loaded", async () => {
    failCatalog = true;
    const logs = [];
    const bodies = captureFetch('{"hex":"#112233","confidence":0.9,"finishes":["chrome"]}');
    const result = await detectHexWithAzureOpenAI("https://img.example/a.jpg", {
      onLog: (level, message) => logs.push({ level, message }),
    });
    const text = promptText(bodies[0]);
    assert.ok(text.includes(`finish names: ${BUILT_IN_PROMPT_LIST.join(", ")}.`));
    assert.doesNotMatch(text, /\bchrome\b/);
    assert.equal(result.finishes, null, "chrome is not a built-in, so it is dropped under the fallback");
    assert.ok(logs.some((l) => l.level === "warn" && /Falling back to built-in finish catalog/.test(l.message)));
  });
});

describe("vision hex/finish prompt — batch path (submitVisionHexBatch)", () => {
  it("every JSONL request lists the runtime catalog, loaded once per batch", async () => {
    let uploadedJsonl;
    global.fetch = async (url, init) => {
      if (url.includes("/openai/files")) {
        uploadedJsonl = await init.body.get("file").text();
        return { ok: true, status: 200, text: async () => JSON.stringify({ id: "file-1" }) };
      }
      if (url.includes("/openai/batches")) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ id: "batch-1" }) };
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    };

    const result = await submitVisionHexBatch([
      { customId: "a", imageUrlOrDataUri: "https://img.example/a.jpg" },
      { customId: "b", imageUrlOrDataUri: "https://img.example/b.jpg" },
    ]);
    assert.equal(result.promptVersion, PROMPT_VERSION);
    const lines = uploadedJsonl.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines.length, 2);
    for (const line of lines) {
      assert.match(promptText(line.body), /finish names: [^.]*\bchrome\b/);
    }
    assert.equal(catalogQueries, 1);
  });
});

describe("label OCR prompt", () => {
  it("buildLabelSystemPrompt lists the runtime catalog, defaulting to the built-ins", async () => {
    assert.ok(buildLabelSystemPrompt().includes(`finish (one of: ${BUILT_IN_PROMPT_LIST.join(", ")})`));
    const catalog = await loadFinishCatalog();
    assert.match(buildLabelSystemPrompt(catalog), /finish \(one of: [^)]*\bchrome\b[^)]*\)/);
  });

  it("parseLabelText sends the runtime catalog in the system prompt", async () => {
    const bodies = [];
    global.fetch = async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"brand":"X","finish":"chrome","confidence":0.8}' } }] }),
        { status: 200 }
      );
    };
    const parsed = await parseLabelText("X CHROME 15ml");
    assert.equal(parsed.finish, "chrome");
    assert.match(bodies[0].messages[0].content, /finish \(one of: [^)]*\bchrome\b[^)]*\)/);
  });
});
