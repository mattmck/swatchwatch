const { describe, it, beforeEach, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

const cacheModulePath = path.resolve(__dirname, "../dist/lib/cache.js");

const originalResolve = Module._resolveFilename;
const originalRedisUrl = process.env.REDIS_URL;
const originalRedisKey = process.env.REDIS_KEY;

const mockModules = {};

function registerMock(id, exports) {
  mockModules[id] = exports;
  require.cache[id] = {
    id,
    filename: id,
    loaded: true,
    exports,
  };
}

Module._resolveFilename = function (request, parent, ...rest) {
  for (const key of Object.keys(mockModules)) {
    if (request === key || request.endsWith(key)) {
      return key;
    }
  }
  return originalResolve.call(this, request, parent, ...rest);
};

function makeDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function buildRedisClient(overrides = {}) {
  const state = {
    isOpen: false,
    connectCalls: 0,
    getCalls: [],
    setCalls: [],
    delCalls: [],
    scanCalls: [],
    handlers: {},
  };

  const client = {
    get isOpen() {
      return state.isOpen;
    },
    on(event, handler) {
      state.handlers[event] = handler;
    },
    async connect() {
      state.connectCalls += 1;
      if (overrides.connect) {
        return overrides.connect(state);
      }
      state.isOpen = true;
      return undefined;
    },
    async get(key) {
      state.getCalls.push(key);
      if (overrides.get) {
        return overrides.get(key, state);
      }
      return null;
    },
    async set(...args) {
      state.setCalls.push(args);
      if (overrides.set) {
        return overrides.set(...args, state);
      }
      return undefined;
    },
    async del(key) {
      state.delCalls.push(key);
      if (overrides.del) {
        return overrides.del(key, state);
      }
      return 1;
    },
    scanIterator(options) {
      state.scanCalls.push(options);
      if (overrides.scanIterator) {
        return overrides.scanIterator(options, state);
      }
      return (async function* emptyIterator() {})();
    },
  };

  return { client, state };
}

function loadCacheWithMocks({
  createClientImpl,
  telemetry,
  redisUrl = "redis://cache.local:6379",
  redisKey = "test-key",
}) {
  if (typeof redisUrl === "string") {
    process.env.REDIS_URL = redisUrl;
  } else {
    delete process.env.REDIS_URL;
  }

  if (typeof redisKey === "string") {
    process.env.REDIS_KEY = redisKey;
  } else {
    delete process.env.REDIS_KEY;
  }

  registerMock("redis", { createClient: createClientImpl });
  registerMock("./telemetry", telemetry);

  delete require.cache[cacheModulePath];
  return require(cacheModulePath);
}

beforeEach(() => {
  delete require.cache[cacheModulePath];
});

afterEach(() => {
  delete require.cache[cacheModulePath];

  if (typeof originalRedisUrl === "undefined") {
    delete process.env.REDIS_URL;
  } else {
    process.env.REDIS_URL = originalRedisUrl;
  }

  if (typeof originalRedisKey === "undefined") {
    delete process.env.REDIS_KEY;
  } else {
    process.env.REDIS_KEY = originalRedisKey;
  }
});

after(() => {
  Module._resolveFilename = originalResolve;
  for (const id of Object.keys(mockModules)) {
    delete require.cache[id];
  }
  delete require.cache[cacheModulePath];
});

describe("lib/cache", () => {
  it("connects once, records telemetry, and reuses the open client", async () => {
    const events = [];
    const exceptions = [];
    const createClientCalls = [];

    const { client, state } = buildRedisClient({
      get: async () => JSON.stringify({ ok: true }),
    });

    const cache = loadCacheWithMocks({
      createClientImpl: (options) => {
        createClientCalls.push(options);
        return client;
      },
      telemetry: {
        trackEvent: (name, props) => events.push({ name, props }),
        trackException: (error, props) => exceptions.push({ error, props }),
      },
    });

    const first = await cache.cacheGetJson("catalog:search:h:1");
    const second = await cache.cacheGetJson("catalog:search:h:2");

    assert.deepEqual(first, { ok: true });
    assert.deepEqual(second, { ok: true });
    assert.equal(createClientCalls.length, 1);
    assert.equal(state.connectCalls, 1);
    assert.deepEqual(events.map((e) => e.name), ["cache.redis.connected"]);
    assert.equal(exceptions.length, 0);
    assert.equal(createClientCalls[0].socket.connectTimeout, 5000);
    assert.equal(typeof createClientCalls[0].socket.reconnectStrategy, "function");
  });

  it("returns null and tracks exception when Redis connect fails", async () => {
    const events = [];
    const exceptions = [];
    const expected = new Error("connect failed");

    const { client, state } = buildRedisClient({
      connect: async () => {
        throw expected;
      },
    });

    const cache = loadCacheWithMocks({
      createClientImpl: () => client,
      telemetry: {
        trackEvent: (name, props) => events.push({ name, props }),
        trackException: (error, props) => exceptions.push({ error, props }),
      },
    });

    const value = await cache.cacheGetJson("catalog:search:h:2");

    assert.equal(value, null);
    assert.equal(state.connectCalls, 1);
    assert.equal(events.length, 0);
    assert.equal(exceptions.length, 1);
    assert.equal(exceptions[0].error, expected);
    assert.deepEqual(exceptions[0].props, {
      component: "redis",
      operation: "connect",
    });
  });

  it("skips Redis operations when cache environment variables are missing", async () => {
    let createClientCalled = false;
    const cache = loadCacheWithMocks({
      createClientImpl: () => {
        createClientCalled = true;
        return buildRedisClient().client;
      },
      telemetry: {
        trackEvent: () => {},
        trackException: () => {},
      },
      redisUrl: null,
      redisKey: null,
    });

    const result = await cache.cacheGetJson("catalog:search:h:no-config");
    await cache.cacheSetJson("catalog:search:h:no-config", { ok: true }, 10);
    await cache.cacheDelete("catalog:search:h:no-config");

    assert.equal(result, null);
    assert.equal(createClientCalled, false);
  });

  it("shares an in-flight connect promise across concurrent requests", async () => {
    const deferred = makeDeferred();
    const createClientCalls = [];

    const { client, state } = buildRedisClient({
      connect: async (s) => {
        await deferred.promise;
        s.isOpen = true;
      },
      get: async () => null,
    });

    const cache = loadCacheWithMocks({
      createClientImpl: (options) => {
        createClientCalls.push(options);
        return client;
      },
      telemetry: {
        trackEvent: () => {},
        trackException: () => {},
      },
    });

    const pendingA = cache.cacheGetJson("polishes:list:u:1:h:a");
    const pendingB = cache.cacheGetJson("polishes:list:u:1:h:b");

    await Promise.resolve();
    assert.equal(createClientCalls.length, 1);
    assert.equal(state.connectCalls, 1);

    deferred.resolve();
    const [resultA, resultB] = await Promise.all([pendingA, pendingB]);

    assert.equal(resultA, null);
    assert.equal(resultB, null);
    assert.equal(state.getCalls.length, 2);
  });

  it("cacheGetJson returns null when key is missing", async () => {
    const { client } = buildRedisClient({
      get: async () => null,
    });

    const cache = loadCacheWithMocks({
      createClientImpl: () => client,
      telemetry: {
        trackEvent: () => {},
        trackException: () => {},
      },
    });

    const value = await cache.cacheGetJson("catalog:search:h:missing");
    assert.equal(value, null);
  });

  it("cacheGetJson tracks exceptions for parse/get failures", async () => {
    const exceptions = [];
    const parseClient = buildRedisClient({
      get: async () => "{bad json",
    }).client;

    const cacheWithParseError = loadCacheWithMocks({
      createClientImpl: () => parseClient,
      telemetry: {
        trackEvent: () => {},
        trackException: (error, props) => exceptions.push({ error, props }),
      },
    });

    const parseResult = await cacheWithParseError.cacheGetJson("catalog:search:h:parse");
    assert.equal(parseResult, null);
    assert.equal(exceptions.length, 1);
    assert.deepEqual(exceptions[0].props, {
      component: "redis",
      operation: "get",
      keyPrefix: "catalog",
    });

    const getError = new Error("redis get failed");
    const getClient = buildRedisClient({
      get: async () => {
        throw getError;
      },
    }).client;

    const cacheWithGetError = loadCacheWithMocks({
      createClientImpl: () => getClient,
      telemetry: {
        trackEvent: () => {},
        trackException: (error, props) => exceptions.push({ error, props }),
      },
    });

    const getResult = await cacheWithGetError.cacheGetJson("polishes:list:u:1:h:x");
    assert.equal(getResult, null);
    assert.equal(exceptions.length, 2);
    assert.equal(exceptions[1].error, getError);
    assert.deepEqual(exceptions[1].props, {
      component: "redis",
      operation: "get",
      keyPrefix: "polishes",
    });
  });

  it("cacheSetJson serializes payload, applies EX TTL, and tracks set errors", async () => {
    const exceptions = [];
    const { client, state } = buildRedisClient();

    const cache = loadCacheWithMocks({
      createClientImpl: () => client,
      telemetry: {
        trackEvent: () => {},
        trackException: (error, props) => exceptions.push({ error, props }),
      },
    });

    await cache.cacheSetJson("reference:finishes", { ok: true }, 45);
    assert.equal(state.setCalls.length, 1);
    assert.equal(state.setCalls[0][0], "reference:finishes");
    assert.equal(state.setCalls[0][1], JSON.stringify({ ok: true }));
    assert.deepEqual(state.setCalls[0][2], { EX: 45 });

    const setError = new Error("set failed");
    const failingClient = buildRedisClient({
      set: async () => {
        throw setError;
      },
    }).client;

    const failingCache = loadCacheWithMocks({
      createClientImpl: () => failingClient,
      telemetry: {
        trackEvent: () => {},
        trackException: (error, props) => exceptions.push({ error, props }),
      },
    });

    await failingCache.cacheSetJson("reference:harmonies", { ok: true }, 60);
    assert.equal(exceptions.length, 1);
    assert.equal(exceptions[0].error, setError);
    assert.deepEqual(exceptions[0].props, {
      component: "redis",
      operation: "set",
      keyPrefix: "reference",
      ttlSeconds: 60,
    });
  });

  it("cacheDelete calls del and tracks delete failures", async () => {
    const exceptions = [];
    const { client, state } = buildRedisClient();

    const cache = loadCacheWithMocks({
      createClientImpl: () => client,
      telemetry: {
        trackEvent: () => {},
        trackException: (error, props) => exceptions.push({ error, props }),
      },
    });

    await cache.cacheDelete("polishes:detail:u:1:id:2");
    assert.deepEqual(state.delCalls, ["polishes:detail:u:1:id:2"]);

    const deleteError = new Error("del failed");
    const failingClient = buildRedisClient({
      del: async () => {
        throw deleteError;
      },
    }).client;

    const failingCache = loadCacheWithMocks({
      createClientImpl: () => failingClient,
      telemetry: {
        trackEvent: () => {},
        trackException: (error, props) => exceptions.push({ error, props }),
      },
    });

    await failingCache.cacheDelete("catalog:shade:id:1");
    assert.equal(exceptions.length, 1);
    assert.equal(exceptions[0].error, deleteError);
    assert.deepEqual(exceptions[0].props, {
      component: "redis",
      operation: "del",
      keyPrefix: "catalog",
    });
  });

  it("cacheDeleteByPrefix scans, deletes in batches, and removes remainder keys", async () => {
    const exceptions = [];
    let deletedBeforeThirdScan = false;

    const firstBatch = Array.from({ length: 60 }, (_, idx) => `k:${idx}`);
    const secondBatch = Array.from({ length: 40 }, (_, idx) => `k:${idx + 60}`);
    const thirdBatch = Array.from({ length: 5 }, (_, idx) => `k:${idx + 100}`);

    const { client, state } = buildRedisClient({
      scanIterator: async function* (_options, s) {
        yield firstBatch;
        yield secondBatch;
        deletedBeforeThirdScan = s.delCalls.length >= 100;
        yield thirdBatch;
      },
    });

    const cache = loadCacheWithMocks({
      createClientImpl: () => client,
      telemetry: {
        trackEvent: () => {},
        trackException: (error, props) => exceptions.push({ error, props }),
      },
    });

    await cache.cacheDeleteByPrefix("polishes:list:u:1:");

    assert.equal(state.scanCalls.length, 1);
    assert.deepEqual(state.scanCalls[0], {
      MATCH: "polishes:list:u:1:*",
      COUNT: 100,
    });
    assert.equal(deletedBeforeThirdScan, true);
    assert.equal(state.delCalls.length, 105);
    assert.equal(exceptions.length, 0);
  });

  it("cacheDeleteByPrefix tracks scan/delete failures", async () => {
    const exceptions = [];
    const scanError = new Error("scan failed");

    const { client } = buildRedisClient({
      scanIterator: async function* () {
        throw scanError;
      },
    });

    const cache = loadCacheWithMocks({
      createClientImpl: () => client,
      telemetry: {
        trackEvent: () => {},
        trackException: (error, props) => exceptions.push({ error, props }),
      },
    });

    await cache.cacheDeleteByPrefix("reference:");

    assert.equal(exceptions.length, 1);
    assert.equal(exceptions[0].error, scanError);
    assert.deepEqual(exceptions[0].props, {
      component: "redis",
      operation: "scan-del",
      keyPrefix: "reference",
    });
  });

  it("cacheSetJson is a no-op when ttlSeconds <= 0", async () => {
    const { client, state } = buildRedisClient();
    const cache = loadCacheWithMocks({
      createClientImpl: () => client,
      telemetry: {
        trackEvent: () => {},
        trackException: () => {},
      },
    });

    await cache.cacheSetJson("catalog:search:h:ttl0", { ok: true }, 0);
    assert.equal(state.setCalls.length, 0);
  });
});
