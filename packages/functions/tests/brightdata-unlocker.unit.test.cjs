// Bright Data Web Unlocker transport (lib/brightdata-unlocker.ts): request shape, target status
// passthrough, configuration errors and the source settings that select it.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  createBrightDataUnlockerFetch,
  fetchForSource,
  readBrightDataUnlockerConfig,
  readFetchVia,
} = require("../dist/lib/brightdata-unlocker");
const { readSourceSettings } = require("../dist/lib/source-settings");

const ENV = { BRIGHTDATA_API_KEY: "test-key", BRIGHTDATA_UNLOCKER_ZONE: "test_zone" };

/** A fake global fetch answering every Bright Data call with `answer`, logging the calls. */
function stub(answer) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return new Response(answer.body ?? "", { status: answer.status ?? 200, headers: answer.headers ?? {} });
  };
  return { fetchImpl, calls };
}

describe("Bright Data Web Unlocker fetch", () => {
  it("POSTs the zone, the target URL and raw format with the bearer key, and returns the store's body and headers", async () => {
    const { fetchImpl, calls } = stub({
      body: "[]",
      headers: { "content-type": "application/json", "x-wp-totalpages": "4", "x-brd-status-code": "200" },
    });
    const unlockerFetch = createBrightDataUnlockerFetch({ env: ENV, fetchImpl });
    const response = await unlockerFetch("https://www.example.com/wp-json/wc/store/v1/products?page=2", {
      headers: { "User-Agent": "ignored" },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.brightdata.com/request");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers.Authorization, "Bearer test-key");
    assert.deepEqual(calls[0].body, {
      zone: "test_zone",
      url: "https://www.example.com/wp-json/wc/store/v1/products?page=2",
      format: "raw",
      method: "GET",
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-wp-totalpages"), "4");
    assert.equal(await response.text(), "[]");
  });

  it("reports the store's status from x-brd-status-code", async () => {
    const { fetchImpl } = stub({ body: "gone", headers: { "x-brd-status-code": "404" } });
    const response = await createBrightDataUnlockerFetch({ env: ENV, fetchImpl })("https://www.example.com/x");
    assert.equal(response.status, 404);
    assert.equal(response.ok, false);
  });

  it("keeps Bright Data's own status when it sends no target status (an unlocker error)", async () => {
    const { fetchImpl } = stub({ status: 502, body: "" });
    const response = await createBrightDataUnlockerFetch({ env: ENV, fetchImpl })("https://www.example.com/x");
    assert.equal(response.status, 502);
  });

  it("fails without the key or the zone instead of falling back to a direct request", async () => {
    const { fetchImpl, calls } = stub({});
    for (const env of [{}, { BRIGHTDATA_API_KEY: "k" }, { BRIGHTDATA_UNLOCKER_ZONE: "z" }]) {
      await assert.rejects(
        createBrightDataUnlockerFetch({ env, fetchImpl })("https://www.example.com/"),
        /needs BRIGHTDATA_API_KEY and BRIGHTDATA_UNLOCKER_ZONE/
      );
    }
    assert.equal(calls.length, 0);
    assert.equal(readBrightDataUnlockerConfig({}), null);
  });

  it("supports GET only", async () => {
    const { fetchImpl } = stub({});
    await assert.rejects(
      createBrightDataUnlockerFetch({ env: ENV, fetchImpl })("https://www.example.com/", { method: "POST" }),
      /GET only/
    );
  });
});

describe("fetchVia source setting", () => {
  it("reads only known transports", () => {
    assert.equal(readFetchVia("brightdata-unlocker"), "brightdata-unlocker");
    assert.equal(readFetchVia(" BrightData-Unlocker "), "brightdata-unlocker");
    assert.equal(readFetchVia("something-else"), null);
    assert.equal(readFetchVia(undefined), null);
  });

  it("readSourceSettings carries fetchVia and robotsOverride, null by default", () => {
    const defaults = readSourceSettings({}, "X");
    assert.equal(defaults.fetchVia, null);
    assert.equal(defaults.robotsOverride, null);
    const set = readSourceSettings({ fetchVia: "brightdata-unlocker", robotsOverride: " OK by email " }, "X");
    assert.equal(set.fetchVia, "brightdata-unlocker");
    assert.equal(set.robotsOverride, "OK by email");
  });

  it("fetchForSource is the global fetch for direct requests", () => {
    assert.equal(fetchForSource(null), globalThis.fetch);
    assert.notEqual(fetchForSource("brightdata-unlocker"), globalThis.fetch);
  });
});
