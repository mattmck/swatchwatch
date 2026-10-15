/**
 * Capture image URL allowlist (issue #47, F7): `imageBlobUrl` may only be a base64 data URL or an
 * https URL on the configured storage account (plain blob URL in the allowed container). Remote
 * URLs are forwarded to Azure Document Intelligence / OpenAI vision, so anything else must be
 * rejected with 400 before any AI/OCR call.
 */
const { describe, it, before, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

for (const name of ["WEBSITE_INSTANCE_ID", "WEBSITE_SITE_NAME", "WEBSITE_HOSTNAME", "REDIS_URL", "REDIS_KEY"]) {
  delete process.env[name];
}
process.env.IMAGE_PROXY_SIGNING_KEY = "capture-image-url-unit-test-signing-key-0123456789";

const ACCOUNT = "swatchtest";
const HOST = `${ACCOUNT}.blob.core.windows.net`;
const CONNECTION = `DefaultEndpointsProtocol=https;AccountName=${ACCOUNT};AccountKey=${Buffer.from("k").toString("base64")};EndpointSuffix=core.windows.net`;
const GOOD_URL = `https://${HOST}/source-images/shopify/abc-123.jpg`;
// 1x1 PNG
const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const USER_ID = 1;
const CAPTURE_UUID = "11111111-1111-4111-8111-111111111111";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
const registeredRoutes = {};
const mockModules = {};
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  for (const key of Object.keys(mockModules)) {
    if (request === key || request.endsWith(key)) return key;
  }
  return originalResolve.call(this, request, parent, ...rest);
};
function registerMock(id, exports) {
  mockModules[id] = exports;
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

registerMock("@azure/functions", {
  app: { http: (name, opts) => (registeredRoutes[name] = opts), storageQueue: () => {}, timer: () => {} },
  output: { storageQueue: (opts) => ({ __type: "storageQueue", ...opts }) },
});
registerMock("jose", { createRemoteJWKSet: () => {}, jwtVerify: async () => { throw new Error("unused"); } });

const SESSION = {
  id: 4242,
  captureId: CAPTURE_UUID,
  status: "processing",
  topConfidence: null,
  acceptedEntityType: null,
  acceptedEntityId: null,
  metadata: {},
};
async function fakeQuery(sql) {
  const text = String(sql);
  if (/FROM\s+app_user/i.test(text)) {
    return { rows: [{ user_id: USER_ID, external_id: "e", email: "u@test.dev", role: "user" }], rowCount: 1 };
  }
  if (/FROM\s+capture_session/i.test(text)) return { rows: [SESSION], rowCount: 1 };
  if (/FROM\s+image_asset/i.test(text)) return { rows: [{ imageId: "777" }], rowCount: 1 };
  return { rows: [], rowCount: 0 };
}
const dbMock = {
  query: fakeQuery,
  transaction: async (cb) => cb({ query: fakeQuery }),
  getPool: () => ({}),
  closePool: async () => {},
};
registerMock(path.resolve(__dirname, "../dist/lib/db.js"), dbMock);
registerMock("../lib/db", dbMock);

const aiInputs = { ocr: [], parse: [] };
registerMock("../lib/ocr", {
  extractTextFromImage: async (input) => {
    aiInputs.ocr.push(input);
    return null;
  },
});
registerMock("../lib/ocr-parser", { parseLabelText: async (...args) => (aiInputs.parse.push(args), null) });
registerMock("../lib/ai-color-detection", { detectHexWithAzureOpenAI: async () => null });

// The real blob-storage module is used so the validator is exercised end to end.
const { checkStorageImageUrl, getConfiguredBlobHost } = require("../dist/lib/blob-storage.js");

function fakeRequest({ params = {}, body } = {}) {
  const headers = new Map([["authorization", `Bearer dev:${USER_ID}`]]);
  return {
    method: "POST",
    url: "http://localhost:7071/api/capture",
    headers: { get: (name) => headers.get(name.toLowerCase()) || null },
    params,
    query: new URL("http://localhost:7071/api/capture").searchParams,
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}
function fakeContext() {
  return {
    invocationId: "inv",
    log: () => {},
    warn: () => {},
    error: () => {},
    extraOutputs: { set: () => {}, get: () => undefined },
  };
}
async function postFrame(body) {
  const route = registeredRoutes["capture-frame"];
  assert.ok(route, "capture-frame should be registered");
  return route.handler(fakeRequest({ params: { captureId: CAPTURE_UUID }, body }), fakeContext());
}

const REJECTION = "imageBlobUrl must be a base64 data URL or an https URL on the configured storage account";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("checkStorageImageUrl (pure validator)", () => {
  beforeEach(() => {
    process.env.AZURE_STORAGE_CONNECTION = CONNECTION;
    delete process.env.SOURCE_IMAGE_CONTAINER;
  });
  afterEach(() => {
    delete process.env.AZURE_STORAGE_CONNECTION;
  });

  it("exposes the configured blob host", () => {
    assert.equal(getConfiguredBlobHost(), HOST);
  });

  it("accepts https on the configured account in the allowed container", () => {
    assert.equal(checkStorageImageUrl(GOOD_URL), null);
  });

  it("rejects http", () => {
    assert.notEqual(checkStorageImageUrl(`http://${HOST}/source-images/a.jpg`), null);
  });

  it("rejects other hosts", () => {
    assert.notEqual(checkStorageImageUrl("https://evil.com/source-images/a.jpg"), null);
    assert.notEqual(checkStorageImageUrl(`https://${HOST}.evil.com/source-images/a.jpg`), null);
    assert.notEqual(checkStorageImageUrl(`https://other.blob.core.windows.net/source-images/a.jpg`), null);
  });

  it("rejects userinfo tricks", () => {
    assert.notEqual(checkStorageImageUrl(`https://evil.com@${HOST}/source-images/a.jpg`), null);
    assert.notEqual(checkStorageImageUrl(`https://${HOST}@evil.com/source-images/a.jpg`), null);
    assert.notEqual(checkStorageImageUrl(`https://user:pass@${HOST}/source-images/a.jpg`), null);
  });

  it("rejects non-default ports", () => {
    assert.notEqual(checkStorageImageUrl(`https://${HOST}:8443/source-images/a.jpg`), null);
    assert.equal(checkStorageImageUrl(`https://${HOST}:443/source-images/a.jpg`), null); // default port normalizes away
  });

  it("rejects other containers, container listings, and query strings", () => {
    assert.notEqual(checkStorageImageUrl(`https://${HOST}/private-data/a.jpg`), null);
    assert.notEqual(checkStorageImageUrl(`https://${HOST}/source-images`), null);
    assert.notEqual(checkStorageImageUrl(`https://${HOST}/source-images/a.jpg?sig=abc`), null);
  });

  it("honors SOURCE_IMAGE_CONTAINER", () => {
    process.env.SOURCE_IMAGE_CONTAINER = "custom-images";
    assert.equal(checkStorageImageUrl(`https://${HOST}/custom-images/a.jpg`), null);
    assert.notEqual(checkStorageImageUrl(GOOD_URL), null);
  });

  it("fails closed without a storage connection", () => {
    delete process.env.AZURE_STORAGE_CONNECTION;
    assert.equal(getConfiguredBlobHost(), null);
    assert.notEqual(checkStorageImageUrl(GOOD_URL), null);
    process.env.AZURE_STORAGE_CONNECTION = "garbage";
    assert.notEqual(checkStorageImageUrl(GOOD_URL), null);
  });
});

describe("POST capture frame imageBlobUrl handling", () => {
  before(() => {
    require("../dist/functions/capture.js");
  });
  beforeEach(() => {
    process.env.AUTH_DEV_BYPASS = "true";
    process.env.AZURE_STORAGE_CONNECTION = CONNECTION;
    aiInputs.ocr.length = 0;
    aiInputs.parse.length = 0;
  });
  afterEach(() => {
    delete process.env.AUTH_DEV_BYPASS;
    delete process.env.AZURE_STORAGE_CONNECTION;
  });

  const rejected = [
    ["http URL", `http://${HOST}/source-images/a.jpg`],
    ["other host", "https://evil.com/a.jpg"],
    ["userinfo host confusion", `https://evil.com@${HOST}/source-images/a.jpg`],
    ["non-default port", `https://${HOST}:8443/source-images/a.jpg`],
    ["blob: URL", "blob:https://app.example/1234"],
  ];
  for (const [label, url] of rejected) {
    it(`rejects ${label} with 400 and never calls AI/OCR`, async () => {
      const response = await postFrame({ frameType: "label", imageBlobUrl: url });
      assert.equal(response.status, 400);
      assert.ok(String(response.jsonBody.error).length > 0);
      assert.equal(aiInputs.ocr.length, 0, "OCR must not be called");
      assert.equal(aiInputs.parse.length, 0, "LLM parse must not be called");
    });
  }

  it("rejects an unvalidated URL even when imageId is also supplied", async () => {
    const response = await postFrame({ frameType: "label", imageId: 777, imageBlobUrl: "https://evil.com/a.jpg" });
    assert.equal(response.status, 400);
    assert.equal(response.jsonBody.error, REJECTION);
    assert.equal(aiInputs.ocr.length, 0);
  });

  it("rejects any remote URL when no storage account is configured", async () => {
    delete process.env.AZURE_STORAGE_CONNECTION;
    const response = await postFrame({ frameType: "label", imageBlobUrl: GOOD_URL });
    assert.equal(response.status, 400);
    assert.equal(response.jsonBody.error, REJECTION);
    assert.equal(aiInputs.ocr.length, 0);
  });

  it("accepts a URL on the configured storage account and forwards it to OCR", async () => {
    const response = await postFrame({ frameType: "label", imageBlobUrl: GOOD_URL });
    assert.notEqual(response.status, 400);
    assert.deepEqual(aiInputs.ocr, [GOOD_URL]);
  });

  it("still accepts base64 data URLs", async () => {
    const response = await postFrame({ frameType: "label", imageBlobUrl: PNG_DATA_URL });
    assert.notEqual(response.status, 400);
    assert.equal(aiInputs.ocr.length, 1);
    assert.ok(aiInputs.ocr[0].startsWith("data:image/png;base64,"));
  });
});
