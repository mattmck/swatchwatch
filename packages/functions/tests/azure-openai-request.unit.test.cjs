/**
 * Model-specific chat-completions fields (`src/lib/azure-openai-request.ts`): gpt-4o / gpt-4.1
 * deployments keep `max_tokens` + `temperature`; gpt-5 / o-series reasoning deployments get
 * `max_completion_tokens` (scaled for reasoning tokens), `reasoning_effort` and no temperature.
 * Synthetic requests only: fetch is replaced, no Azure call.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  isReasoningDeployment,
  parseReasoningDeploymentList,
  resolveReasoningEffort,
  reasoningMaxCompletionTokens,
  chatCompletionModelParams,
  applyChatCompletionModelParams,
  warnDroppedTemperatureOnce,
  reasoningEffortForDeployment,
  reasoningAliasModel,
  chatCompletionsApiVersion,
  REASONING_CHAT_API_VERSION,
  DEFAULT_REASONING_EFFORT,
} = require("../dist/lib/azure-openai-request");
const {
  buildHexDetectionRequestPayload,
  requestAzureOpenAIChatCompletion,
  detectHexWithAzureOpenAI,
} = require("../dist/lib/ai-color-detection");
const { submitVisionHexBatch } = require("../dist/lib/azure-openai-batch");
const { buildGlassPalettePayload } = require("../dist/lib/glass-color");

const ENV_KEYS = [
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_KEY",
  "AZURE_OPENAI_DEPLOYMENT",
  "AZURE_OPENAI_DEPLOYMENT_HEX",
  "AZURE_OPENAI_DEPLOYMENT_HEX_BATCH",
  "AZURE_OPENAI_REASONING_DEPLOYMENTS",
  "AZURE_OPENAI_REASONING_EFFORT",
];
let savedEnv;
let savedFetch;
let savedWarn;
let warnings;

function setupEnv() {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  savedFetch = global.fetch;
  savedWarn = console.warn;
  warnings = [];
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  process.env.AZURE_OPENAI_ENDPOINT = "https://unit.openai.azure.com/";
  process.env.AZURE_OPENAI_KEY = "unit-test-key";
}
/** Only the dropped-temperature lines (other modules may warn, e.g. the finish catalog fallback). */
function temperatureWarnings() {
  return warnings.filter((line) => line.includes("temperature") && line.includes("dropped"));
}
function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  global.fetch = savedFetch;
  console.warn = savedWarn;
}

/** Replace fetch with a chat-completions stub that records every request body. */
function stubChatFetch(content = '{"hex":"#AA3355","confidence":0.9,"finishes":["creme"]}') {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(
      JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  return calls;
}

describe("lib/azure-openai-request — reasoning deployment classification", () => {
  it("recognizes gpt-5 and o-series deployment names, any case", () => {
    for (const name of ["gpt-5-mini", "GPT-5", "gpt-5.1-nano", "o1", "o3-mini", "O4-mini", " o1-preview "]) {
      assert.equal(isReasoningDeployment(name, {}), true, name);
    }
  });

  it("keeps gpt-4o, gpt-4.1 and unrelated names non-reasoning", () => {
    for (const name of ["gpt-4o-mini", "gpt-4.1-mini", "gpt4o-deploy", "hex-detector", "prod-vision", "", null, undefined]) {
      assert.equal(isReasoningDeployment(name, {}), false, String(name));
    }
  });

  it("uses AZURE_OPENAI_REASONING_DEPLOYMENTS for names that do not reveal the model", () => {
    const env = { AZURE_OPENAI_REASONING_DEPLOYMENTS: " Prod-Vision , hex-new ,," };
    assert.deepEqual(parseReasoningDeploymentList(env.AZURE_OPENAI_REASONING_DEPLOYMENTS), ["prod-vision", "hex-new"]);
    assert.equal(isReasoningDeployment("prod-vision", env), true);
    assert.equal(isReasoningDeployment("HEX-NEW", env), true);
    assert.equal(isReasoningDeployment("hex-old", env), false);
    assert.deepEqual(parseReasoningDeploymentList(undefined), []);
  });

  it("lets `!name` entries force a prefix-matching deployment to non-reasoning", () => {
    const env = { AZURE_OPENAI_REASONING_DEPLOYMENTS: "!O3-Vision-4o, prod-vision" };
    assert.deepEqual(parseReasoningDeploymentList(env.AZURE_OPENAI_REASONING_DEPLOYMENTS), ["prod-vision"]);
    assert.equal(isReasoningDeployment("o3-vision-4o", env), false);
    assert.equal(isReasoningDeployment("o3-mini", env), true);
    assert.equal(isReasoningDeployment("prod-vision", env), true);
    assert.deepEqual(chatCompletionModelParams("o3-vision-4o", { maxTokens: 60, temperature: 0 }, env).fields, {
      temperature: 0,
      max_tokens: 60,
    });
    assert.equal(chatCompletionsApiVersion("o3-vision-4o", "2024-05-01-preview", env), "2024-05-01-preview");
  });
});

describe("lib/azure-openai-request — field selection", () => {
  it("defaults reasoning_effort to minimal and accepts the four documented values", () => {
    assert.equal(DEFAULT_REASONING_EFFORT, "minimal");
    assert.equal(resolveReasoningEffort({}), "minimal");
    assert.equal(resolveReasoningEffort({ AZURE_OPENAI_REASONING_EFFORT: " High " }), "high");
    assert.equal(resolveReasoningEffort({ AZURE_OPENAI_REASONING_EFFORT: "low" }), "low");
    assert.equal(resolveReasoningEffort({ AZURE_OPENAI_REASONING_EFFORT: "medium" }), "medium");
    assert.equal(resolveReasoningEffort({ AZURE_OPENAI_REASONING_EFFORT: "extreme" }), "minimal");
  });

  it("picks reasoning_effort per model family", () => {
    assert.equal(reasoningEffortForDeployment("gpt-5-mini", {}), "minimal");
    assert.equal(reasoningEffortForDeployment("o3-mini", {}), "low", "o-series reject minimal");
    assert.equal(reasoningEffortForDeployment("O4-mini", { AZURE_OPENAI_REASONING_EFFORT: "high" }), "high");
    assert.equal(reasoningEffortForDeployment("o1", {}), "low");
    assert.equal(reasoningEffortForDeployment("o1-preview", {}), null);
    assert.equal(reasoningEffortForDeployment("o1-mini", { AZURE_OPENAI_REASONING_EFFORT: "high" }), null);
    assert.equal(reasoningEffortForDeployment("vision-prod", {}), "minimal");
    assert.equal(reasoningEffortForDeployment("gpt-5.1", {}), "low", "gpt-5.1 rejects minimal");
    assert.equal(reasoningEffortForDeployment("GPT-5.2-mini", {}), "low");
    assert.equal(reasoningEffortForDeployment("gpt-5.1", { AZURE_OPENAI_REASONING_EFFORT: "medium" }), "medium");
  });

  it("applies the model family's effort rules to `alias=model` entries", () => {
    const env = { AZURE_OPENAI_REASONING_DEPLOYMENTS: "Vision-Prod = o3-mini, label-x=o1-mini, hex-new=gpt-5-mini, bare" };
    assert.deepEqual(parseReasoningDeploymentList(env.AZURE_OPENAI_REASONING_DEPLOYMENTS), ["vision-prod", "label-x", "hex-new", "bare"]);
    assert.equal(reasoningAliasModel("vision-prod", env), "o3-mini");
    assert.equal(reasoningAliasModel("bare", env), null);
    for (const name of ["vision-prod", "label-x", "hex-new", "bare"]) {
      assert.equal(isReasoningDeployment(name, env), true, name);
    }
    assert.equal(reasoningEffortForDeployment("vision-prod", env), "low", "o-series alias: minimal → low");
    assert.equal(reasoningEffortForDeployment("label-x", env), null, "o1-mini alias: no reasoning_effort");
    assert.equal(reasoningEffortForDeployment("hex-new", env), "minimal", "gpt-5 alias keeps the configured value");
    assert.equal(reasoningEffortForDeployment("hex-new", { ...env, AZURE_OPENAI_REASONING_EFFORT: "high" }), "high");
    assert.equal(reasoningEffortForDeployment("bare", env), "minimal");
    assert.deepEqual(chatCompletionModelParams("label-x", { maxTokens: 500 }, env).fields, { max_completion_tokens: 2000 });
    assert.deepEqual(chatCompletionModelParams("o1-mini", { maxTokens: 100 }, {}).fields, { max_completion_tokens: 1024 });
    assert.equal(chatCompletionModelParams("o3-mini", { maxTokens: 100 }, {}).fields.reasoning_effort, "low");
  });

  it("uses the newer api-version only for reasoning deployments", () => {
    assert.equal(REASONING_CHAT_API_VERSION, "2025-04-01-preview");
    assert.equal(chatCompletionsApiVersion("gpt-5-mini", "2024-05-01-preview", {}), "2025-04-01-preview");
    assert.equal(chatCompletionsApiVersion("x", "2024-06-01", { AZURE_OPENAI_REASONING_DEPLOYMENTS: "x" }), "2025-04-01-preview");
    assert.equal(chatCompletionsApiVersion("gpt-4o-mini", "2024-05-01-preview", {}), "2024-05-01-preview");
  });

  it("scales the cap to 4x with a 1024 floor", () => {
    assert.equal(reasoningMaxCompletionTokens(40), 1024);
    assert.equal(reasoningMaxCompletionTokens(120), 1024);
    assert.equal(reasoningMaxCompletionTokens(256), 1024);
    assert.equal(reasoningMaxCompletionTokens(500), 2000);
    assert.equal(reasoningMaxCompletionTokens(0), 1024);
    assert.equal(reasoningMaxCompletionTokens(Number.NaN), 1024);
  });

  it("sends max_tokens and temperature exactly as given to non-reasoning deployments", () => {
    assert.deepEqual(chatCompletionModelParams("gpt-4o-mini", { maxTokens: 120, temperature: 0 }, {}), {
      fields: { temperature: 0, max_tokens: 120 },
      reasoning: false,
      droppedTemperature: null,
    });
    assert.deepEqual(chatCompletionModelParams("gpt-4.1-mini", { maxTokens: 60, temperature: 0.3 }, {}).fields, {
      temperature: 0.3,
      max_tokens: 60,
    });
    assert.deepEqual(chatCompletionModelParams("gpt-4o", { maxTokens: 10 }, {}).fields, { max_tokens: 10 });
  });

  it("sends max_completion_tokens and reasoning_effort, never temperature, to reasoning deployments", () => {
    const params = chatCompletionModelParams("gpt-5-mini", { maxTokens: 120, temperature: 0 }, { AZURE_OPENAI_REASONING_EFFORT: "low" });
    assert.deepEqual(params, {
      fields: { max_completion_tokens: 1024, reasoning_effort: "low" },
      reasoning: true,
      droppedTemperature: null,
    });
  });

  it("reports a dropped non-zero temperature", () => {
    assert.equal(chatCompletionModelParams("o3-mini", { maxTokens: 100, temperature: 0.3 }, {}).droppedTemperature, 0.3);
    assert.equal(chatCompletionModelParams("o3-mini", { maxTokens: 100 }, {}).droppedTemperature, null);
  });

  it("rewrites a gpt-4o payload for a reasoning deployment and leaves others untouched", () => {
    const payload = { temperature: 0.3, max_tokens: 100, response_format: { type: "json_object" }, messages: [] };
    const same = applyChatCompletionModelParams(payload, "gpt-4o-mini", {});
    assert.equal(same.payload, payload);
    assert.equal(same.reasoning, false);

    const rewritten = applyChatCompletionModelParams(payload, "gpt-5-mini", {});
    assert.deepEqual(rewritten.payload, {
      max_completion_tokens: 1024,
      reasoning_effort: "minimal",
      response_format: { type: "json_object" },
      messages: [],
    });
    assert.equal(rewritten.droppedTemperature, 0.3);
    assert.equal(payload.max_tokens, 100, "the caller's payload is not mutated");
    assert.equal(applyChatCompletionModelParams(null, "gpt-5", {}).payload, null);
  });

  it("warns about a dropped temperature once per deployment and temperature", () => {
    const seen = [];
    const warn = (message) => seen.push(message);
    assert.equal(warnDroppedTemperatureOnce("gpt-5-once", 0.3, warn), true);
    assert.equal(warnDroppedTemperatureOnce("GPT-5-once", 0.3, warn), false);
    assert.equal(warnDroppedTemperatureOnce("gpt-5-once", 0.5, warn), true);
    assert.equal(seen.length, 2);
    assert.match(seen[0], /gpt-5-once.*reasoning model; temperature 0\.3 dropped/);
  });
});

describe("lib/ai-color-detection — sync request body per model kind", () => {
  beforeEach(setupEnv);
  afterEach(restoreEnv);

  it("keeps temperature 0 and max_tokens 120 on a gpt-4o-mini deployment", async () => {
    process.env.AZURE_OPENAI_DEPLOYMENT_HEX = "gpt-4o-mini";
    const calls = stubChatFetch();
    const result = await detectHexWithAzureOpenAI("https://img.example.com/a.jpg", { onLog: () => undefined });
    assert.equal(result.hex, "#AA3355");
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/deployments\/gpt-4o-mini\/chat\/completions\?api-version=2024-05-01-preview$/);
    assert.equal(calls[0].body.temperature, 0);
    assert.equal(calls[0].body.max_tokens, 120);
    assert.equal("max_completion_tokens" in calls[0].body, false);
    assert.equal("reasoning_effort" in calls[0].body, false);
    // Same body the pure builder produces.
    const expected = buildHexDetectionRequestPayload("https://img.example.com/a.jpg", {}, false);
    assert.deepEqual(Object.keys(calls[0].body), Object.keys(expected));
  });

  it("sends max_completion_tokens and reasoning_effort to a gpt-5-mini deployment", async () => {
    process.env.AZURE_OPENAI_DEPLOYMENT_HEX = "gpt-5-mini";
    process.env.AZURE_OPENAI_REASONING_EFFORT = "medium";
    const calls = stubChatFetch();
    const result = await detectHexWithAzureOpenAI("https://img.example.com/a.jpg", { onLog: () => undefined });
    assert.equal(result.hex, "#AA3355");
    const body = calls[0].body;
    assert.match(calls[0].url, /\/deployments\/gpt-5-mini\/chat\/completions\?api-version=2025-04-01-preview$/);
    assert.equal("max_tokens" in body, false);
    assert.equal("temperature" in body, false);
    assert.equal(body.max_completion_tokens, 1024);
    assert.equal(body.reasoning_effort, "medium");
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.ok(Array.isArray(body.messages));
    assert.equal(temperatureWarnings().length, 0, "temperature 0 is dropped without a warning");
  });

  it("treats a deployment in AZURE_OPENAI_REASONING_DEPLOYMENTS as reasoning", async () => {
    process.env.AZURE_OPENAI_DEPLOYMENT_HEX = "vision-prod";
    process.env.AZURE_OPENAI_REASONING_DEPLOYMENTS = "vision-prod";
    const calls = stubChatFetch();
    await detectHexWithAzureOpenAI("https://img.example.com/a.jpg", { onLog: () => undefined });
    assert.equal(calls[0].body.max_completion_tokens, 1024);
    assert.equal("max_tokens" in calls[0].body, false);
  });

  it("passes the ensemble temperature to gpt-4.1 and drops it with one warning on o3-mini", async () => {
    process.env.AZURE_OPENAI_DEPLOYMENT_HEX = "gpt-4.1-mini";
    const calls = stubChatFetch();
    await detectHexWithAzureOpenAI("https://img.example.com/a.jpg", { onLog: () => undefined, temperature: 0.3 });
    assert.equal(calls[0].body.temperature, 0.3);
    assert.equal(calls[0].body.max_tokens, 120);
    assert.equal(temperatureWarnings().length, 0);

    for (let i = 0; i < 3; i += 1) {
      await detectHexWithAzureOpenAI("https://img.example.com/a.jpg", {
        onLog: () => undefined,
        temperature: 0.3,
        deployment: "o3-mini-ensemble",
      });
    }
    for (const call of calls.slice(1)) {
      assert.equal("temperature" in call.body, false);
      assert.equal(call.body.max_completion_tokens, 1024);
      assert.equal(call.body.reasoning_effort, "low");
    }
    assert.equal(temperatureWarnings().filter((line) => line.includes("o3-mini-ensemble")).length, 1);
  });

  it("rewrites a palette-pick style payload (glass color) on a reasoning deployment", async () => {
    process.env.AZURE_OPENAI_DEPLOYMENT_HEX = "gpt-5-nano";
    const calls = stubChatFetch('{"choice":"A","confidence":0.8}');
    const payload = buildGlassPalettePayload("data:image/png;base64,AAAA", [{ label: "A", hex: "#112233" }], false, "low");
    assert.equal(payload.max_tokens, 100);
    await requestAzureOpenAIChatCompletion({ buildPayload: () => payload, logLabel: "glass" }, { onLog: () => undefined });
    assert.equal(calls[0].body.max_completion_tokens, 1024);
    assert.equal("max_tokens" in calls[0].body, false);
    assert.equal("temperature" in calls[0].body, false);
    assert.deepEqual(calls[0].body.messages, payload.messages);
  });
});

describe("lib/azure-openai-batch — JSONL request lines per model kind", () => {
  beforeEach(setupEnv);
  afterEach(restoreEnv);

  async function submitAndReadFirstLine() {
    let uploadedJsonl;
    global.fetch = async (url, init) => {
      if (url.includes("/openai/files")) {
        uploadedJsonl = await init.body.get("file").text();
        return { ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ id: "file-1" })) };
      }
      if (url.includes("/openai/batches")) {
        return { ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ id: "batch-1" })) };
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    };
    await submitVisionHexBatch([{ customId: "ext-1", imageUrlOrDataUri: "https://img.example.com/a.jpg" }]);
    return JSON.parse(uploadedJsonl.split("\n")[0]);
  }

  it("keeps max_tokens and temperature for a gpt-4o-mini batch deployment", async () => {
    process.env.AZURE_OPENAI_DEPLOYMENT_HEX_BATCH = "gpt-4o-mini";
    const line = await submitAndReadFirstLine();
    assert.equal(line.body.model, "gpt-4o-mini");
    assert.equal(line.body.max_tokens, 120);
    assert.equal(line.body.temperature, 0);
    assert.equal("max_completion_tokens" in line.body, false);
  });

  it("uses max_completion_tokens and reasoning_effort for a gpt-5-mini batch deployment", async () => {
    process.env.AZURE_OPENAI_DEPLOYMENT_HEX_BATCH = "gpt-5-mini";
    const line = await submitAndReadFirstLine();
    assert.equal(line.body.model, "gpt-5-mini");
    assert.equal(line.body.max_completion_tokens, 1024);
    assert.equal(line.body.reasoning_effort, "minimal");
    assert.equal("max_tokens" in line.body, false);
    assert.equal("temperature" in line.body, false);
    assert.ok(Array.isArray(line.body.messages));
  });

  it("sends reasoning_effort low (not minimal) on a gpt-5.1 batch deployment, and keeps an explicit value", async () => {
    process.env.AZURE_OPENAI_DEPLOYMENT_HEX_BATCH = "gpt-5.1-batch";
    let line = await submitAndReadFirstLine();
    assert.equal(line.body.reasoning_effort, "low");
    process.env.AZURE_OPENAI_REASONING_EFFORT = "high";
    line = await submitAndReadFirstLine();
    assert.equal(line.body.reasoning_effort, "high");
  });
});
