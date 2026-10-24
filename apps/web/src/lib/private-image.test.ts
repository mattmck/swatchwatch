import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyPrivateImageResponse,
  defaultApiOrigin,
  isPrivateImageUrl,
  loadPrivateImage,
  type PrivateImageLoaderDeps,
  type PrivateImageState,
} from "./private-image";

const V3_ID = "/api/images/v3.aHR0cHM6Ly9leGFtcGxl.mf0abc.1.c2ln";
const V2_ID = "/api/images/v2.aHR0cHM6Ly9leGFtcGxl.mf0abc.c2ln";

const API_ORIGIN = "https://api.swatchwatch.app";

describe("isPrivateImageUrl", () => {
  it("accepts relative v3 paths", () => {
    assert.equal(isPrivateImageUrl(V3_ID, API_ORIGIN), true);
    assert.equal(isPrivateImageUrl(`${V3_ID}?w=96&h=96&fm=webp`, API_ORIGIN), true);
    assert.equal(isPrivateImageUrl(V3_ID, null), true);
  });

  it("accepts absolute v3 ids on the API origin", () => {
    assert.equal(isPrivateImageUrl(`${API_ORIGIN}${V3_ID}`, API_ORIGIN), true);
    assert.equal(
      isPrivateImageUrl(`http://localhost:7071${V3_ID}?w=96`, "http://localhost:7071"),
      true
    );
  });

  it("rejects v3 paths on any other origin so no token is sent there", () => {
    assert.equal(isPrivateImageUrl(`https://evil.example.com${V3_ID}`, API_ORIGIN), false);
    assert.equal(isPrivateImageUrl(`//evil.example.com${V3_ID}`, API_ORIGIN), false);
    assert.equal(isPrivateImageUrl(`http://api.swatchwatch.app${V3_ID}`, API_ORIGIN), false);
    assert.equal(isPrivateImageUrl(`https://api.swatchwatch.app:8443${V3_ID}`, API_ORIGIN), false);
    assert.equal(isPrivateImageUrl(`${API_ORIGIN}${V3_ID}`, null), false);
  });

  it("defaults the API origin to the base URL api.ts calls", () => {
    // No NEXT_PUBLIC_API_URL and no window in tests: api.ts falls back to localhost:7071.
    assert.equal(defaultApiOrigin(), "http://localhost:7071");
    assert.equal(isPrivateImageUrl(`http://localhost:7071${V3_ID}`), true);
    assert.equal(isPrivateImageUrl(`https://evil.example.com${V3_ID}`), false);
  });

  it("rejects public v2 ids", () => {
    assert.equal(isPrivateImageUrl(V2_ID, API_ORIGIN), false);
    assert.equal(isPrivateImageUrl(`${API_ORIGIN}${V2_ID}`, API_ORIGIN), false);
  });

  it("rejects external, data and blob URLs", () => {
    assert.equal(isPrivateImageUrl("https://cdn.example.com/nails/photo.jpg", API_ORIGIN), false);
    assert.equal(isPrivateImageUrl(`${API_ORIGIN}/v3.photo.jpg`, API_ORIGIN), false);
    assert.equal(isPrivateImageUrl("data:image/png;base64,iVBORw0KGgo=", API_ORIGIN), false);
    assert.equal(isPrivateImageUrl(`blob:${API_ORIGIN}${V3_ID}`, API_ORIGIN), false);
  });

  it("rejects empty and unparsable input", () => {
    assert.equal(isPrivateImageUrl("", API_ORIGIN), false);
    assert.equal(isPrivateImageUrl("http://[::1", API_ORIGIN), false);
    assert.equal(isPrivateImageUrl(undefined as unknown as string, API_ORIGIN), false);
  });

  it("only matches the v3 prefix at the start of the path", () => {
    assert.equal(isPrivateImageUrl("/proxy/api/images/v3.abc", API_ORIGIN), false);
    assert.equal(isPrivateImageUrl("/api/images/v30abc", API_ORIGIN), false);
  });
});

describe("classifyPrivateImageResponse", () => {
  it("maps statuses to outcomes", () => {
    assert.equal(classifyPrivateImageResponse(200), "ready");
    assert.equal(classifyPrivateImageResponse(401), "denied");
    assert.equal(classifyPrivateImageResponse(403), "denied");
    assert.equal(classifyPrivateImageResponse(404), "error");
    assert.equal(classifyPrivateImageResponse(500), "error");
  });
});

type FetchImpl = PrivateImageLoaderDeps["fetch"];

function createDeps(fetchImpl: FetchImpl) {
  const calls: { url: string; init: RequestInit }[] = [];
  const created: string[] = [];
  const revoked: string[] = [];
  let counter = 0;
  const deps: PrivateImageLoaderDeps = {
    fetch: (url, init) => {
      calls.push({ url, init });
      return fetchImpl(url, init);
    },
    getHeaders: async () => ({ Authorization: "Bearer dev:1" }),
    createObjectURL: () => {
      const objectUrl = `blob:test/${++counter}`;
      created.push(objectUrl);
      return objectUrl;
    },
    revokeObjectURL: (objectUrl) => {
      revoked.push(objectUrl);
    },
  };
  return { deps, calls, created, revoked };
}

function imageResponse(status: number): Response {
  return new Response(status === 200 ? new Blob(["img"], { type: "image/webp" }) : null, { status });
}

describe("loadPrivateImage", () => {
  it("fetches with auth headers and resolves 200 to a ready object URL", async () => {
    const { deps, calls, created } = createDeps(async () => imageResponse(200));
    const states: PrivateImageState[] = [];

    const load = loadPrivateImage(V3_ID, (state) => states.push(state), deps);
    await load.done;

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, V3_ID);
    assert.deepEqual(calls[0].init.headers, { Authorization: "Bearer dev:1" });
    assert.ok(calls[0].init.signal instanceof AbortSignal);
    assert.deepEqual(states, [{ status: "ready", objectUrl: "blob:test/1" }]);
    assert.deepEqual(created, ["blob:test/1"]);
  });

  it("reports denied for 401 and 403 without creating an object URL", async () => {
    for (const status of [401, 403]) {
      const { deps, created } = createDeps(async () => imageResponse(status));
      const states: PrivateImageState[] = [];
      await loadPrivateImage(V3_ID, (state) => states.push(state), deps).done;
      assert.deepEqual(states, [{ status: "denied", objectUrl: null }]);
      assert.deepEqual(created, []);
    }
  });

  it("reports error for other non-OK statuses", async () => {
    const { deps } = createDeps(async () => imageResponse(500));
    const states: PrivateImageState[] = [];
    await loadPrivateImage(V3_ID, (state) => states.push(state), deps).done;
    assert.deepEqual(states, [{ status: "error", objectUrl: null }]);
  });

  it("reports error when the request throws", async () => {
    const { deps } = createDeps(async () => {
      throw new TypeError("Failed to fetch");
    });
    const states: PrivateImageState[] = [];
    await loadPrivateImage(V3_ID, (state) => states.push(state), deps).done;
    assert.deepEqual(states, [{ status: "error", objectUrl: null }]);
  });

  it("revokes the object URL on dispose (unmount or url change)", async () => {
    const { deps, revoked } = createDeps(async () => imageResponse(200));
    const load = loadPrivateImage(V3_ID, () => {}, deps);
    await load.done;

    assert.deepEqual(revoked, []);
    load.dispose();
    assert.deepEqual(revoked, ["blob:test/1"]);
    load.dispose();
    assert.deepEqual(revoked, ["blob:test/1"], "revokes only once");
  });

  it("aborts an in-flight request and ignores its late response", async () => {
    let resolveFetch: (response: Response) => void = () => {};
    let signal: AbortSignal | undefined;
    const { deps, created, revoked } = createDeps((_url, init) => {
      signal = init.signal ?? undefined;
      return new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
    });
    const states: PrivateImageState[] = [];

    const load = loadPrivateImage(V3_ID, (state) => states.push(state), deps);
    await new Promise((resolve) => setImmediate(resolve));
    load.dispose();
    assert.equal(signal?.aborted, true);

    resolveFetch(imageResponse(200));
    await load.done;

    assert.deepEqual(states, []);
    assert.deepEqual(created, []);
    assert.deepEqual(revoked, []);
  });

  it("does not report an error when the abort rejects the request", async () => {
    const { deps } = createDeps(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError"))
          );
        })
    );
    const states: PrivateImageState[] = [];

    const load = loadPrivateImage(V3_ID, (state) => states.push(state), deps);
    await new Promise((resolve) => setImmediate(resolve));
    load.dispose();
    await load.done;

    assert.deepEqual(states, []);
  });
});

describe("loadPrivateImage default wiring", () => {
  it("uses global fetch and URL.createObjectURL / URL.revokeObjectURL", async (t) => {
    const fetchMock = t.mock.method(globalThis, "fetch", async () => imageResponse(200));
    const createMock = t.mock.method(URL, "createObjectURL", () => "blob:global/1");
    const revokeMock = t.mock.method(URL, "revokeObjectURL", () => {});
    const states: PrivateImageState[] = [];

    const load = loadPrivateImage(V3_ID, (state) => states.push(state));
    await load.done;
    load.dispose();

    assert.equal(fetchMock.mock.callCount(), 1);
    assert.equal(fetchMock.mock.calls[0].arguments[0], V3_ID);
    assert.equal(createMock.mock.callCount(), 1);
    assert.deepEqual(states, [{ status: "ready", objectUrl: "blob:global/1" }]);
    assert.deepEqual(revokeMock.mock.calls.map((call) => call.arguments[0]), ["blob:global/1"]);
  });
});

describe("loadPrivateImage admin token", () => {
  function recordingDeps() {
    const headerCalls: { admin: boolean }[] = [];
    const deps: PrivateImageLoaderDeps = {
      fetch: async () => imageResponse(200),
      getHeaders: async (options) => {
        headerCalls.push(options);
        return { Authorization: options.admin ? "Bearer admin" : "Bearer user" };
      },
      createObjectURL: () => "blob:test/admin",
      revokeObjectURL: () => {},
    };
    return { deps, headerCalls };
  }

  it("asks for the user token by default", async () => {
    const { deps, headerCalls } = recordingDeps();
    await loadPrivateImage(V3_ID, () => {}, deps).done;
    assert.deepEqual(headerCalls, [{ admin: false }]);
  });

  it("forwards the admin flag to the header builder", async () => {
    const { deps, headerCalls } = recordingDeps();
    await loadPrivateImage(V3_ID, () => {}, deps, { admin: true }).done;
    assert.deepEqual(headerCalls, [{ admin: true }]);
  });

  it("sends the dev-bypass admin token by default wiring when admin is set", async (t) => {
    const previous = {
      bypass: process.env.NEXT_PUBLIC_AUTH_DEV_BYPASS,
      adminId: process.env.NEXT_PUBLIC_AUTH_DEV_ADMIN_USER_ID,
    };
    process.env.NEXT_PUBLIC_AUTH_DEV_BYPASS = "true";
    process.env.NEXT_PUBLIC_AUTH_DEV_ADMIN_USER_ID = "7";
    t.after(() => {
      for (const [key, value] of [
        ["NEXT_PUBLIC_AUTH_DEV_BYPASS", previous.bypass],
        ["NEXT_PUBLIC_AUTH_DEV_ADMIN_USER_ID", previous.adminId],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    const fetchMock = t.mock.method(globalThis, "fetch", async () => imageResponse(200));
    t.mock.method(URL, "createObjectURL", () => "blob:global/admin");
    t.mock.method(URL, "revokeObjectURL", () => {});

    await loadPrivateImage(V3_ID, () => {}, undefined, { admin: true }).done;
    await loadPrivateImage(V3_ID, () => {}).done;

    const headers = fetchMock.mock.calls.map(
      (call) => (call.arguments[1] as RequestInit).headers as Record<string, string>
    );
    assert.deepEqual(headers, [{ Authorization: "Bearer dev:7" }, { Authorization: "Bearer dev:1" }]);
  });
});
