import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TOKEN_REDIRECT_GUARD_KEY,
  TOKEN_REDIRECT_GUARD_WINDOW_MS,
  claimTokenRedirect,
  createAccessTokenProvider,
  type AccessTokenProviderDeps,
} from "./token-renewal";

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
  };
}

function deps(overrides: Partial<AccessTokenProviderDeps> = {}) {
  const calls = { silent: 0, interactive: 0, errors: [] as unknown[] };
  const resolved: AccessTokenProviderDeps = {
    acquireSilent: async () => {
      calls.silent += 1;
      return "token-1";
    },
    acquireInteractive: async () => {
      calls.interactive += 1;
    },
    claimRedirect: () => true,
    onError: (error) => calls.errors.push(error),
    ...overrides,
  };
  return { deps: resolved, calls };
}

describe("claimTokenRedirect", () => {
  it("records the first redirect and refuses another inside the guard window", () => {
    const storage = memoryStorage();
    assert.equal(claimTokenRedirect(storage, 1_000), true);
    assert.equal(storage.getItem(TOKEN_REDIRECT_GUARD_KEY), "1000");
    assert.equal(claimTokenRedirect(storage, 1_000 + TOKEN_REDIRECT_GUARD_WINDOW_MS - 1), false);
    assert.equal(claimTokenRedirect(storage, 1_000 + TOKEN_REDIRECT_GUARD_WINDOW_MS), true);
  });

  it("ignores an unreadable stored timestamp", () => {
    assert.equal(claimTokenRedirect(memoryStorage({ [TOKEN_REDIRECT_GUARD_KEY]: "junk" }), 5), true);
  });
});

describe("createAccessTokenProvider", () => {
  it("returns the silently acquired token on every call", async () => {
    const { deps: d, calls } = deps();
    const getToken = createAccessTokenProvider(d);
    assert.equal(await getToken(), "token-1");
    assert.equal(await getToken(), "token-1");
    assert.equal(calls.silent, 2);
    assert.equal(calls.interactive, 0);
  });

  it("shares one acquisition between concurrent calls", async () => {
    let release: (token: string) => void = () => {};
    const { deps: d, calls } = deps({
      acquireSilent: () => {
        calls.silent += 1;
        return new Promise<string>((resolve) => {
          release = resolve;
        });
      },
    });
    const getToken = createAccessTokenProvider(d);
    const pending = Promise.all([getToken(), getToken(), getToken()]);
    release("shared");
    assert.deepEqual(await pending, ["shared", "shared", "shared"]);
    assert.equal(calls.silent, 1);
  });

  it("does not redirect when nobody is signed in", async () => {
    const { deps: d, calls } = deps({ acquireSilent: async () => null });
    assert.equal(await createAccessTokenProvider(d)(), null);
    assert.equal(calls.interactive, 0);
  });

  it("sends any silent failure to interactive sign-in and returns null", async () => {
    // Not only InteractionRequiredAuthError: block_iframe_reload and timeouts are BrowserAuthErrors.
    const failure = Object.assign(new Error("block_iframe_reload"), { errorCode: "block_iframe_reload" });
    const { deps: d, calls } = deps({
      acquireSilent: async () => {
        throw failure;
      },
    });
    assert.equal(await createAccessTokenProvider(d)(), null);
    assert.equal(calls.interactive, 1);
    assert.deepEqual(calls.errors, [failure]);
  });

  it("does not redirect again while the redirect guard holds", async () => {
    const storage = memoryStorage();
    const { deps: d, calls } = deps({
      acquireSilent: async () => {
        throw new Error("timed_out");
      },
      claimRedirect: () => claimTokenRedirect(storage, 10_000),
    });
    const getToken = createAccessTokenProvider(d);
    await getToken();
    await getToken();
    assert.equal(calls.interactive, 1);
  });

  it("reports a failing redirect instead of throwing", async () => {
    const redirectError = new Error("interaction_in_progress");
    const { deps: d, calls } = deps({
      acquireSilent: async () => {
        throw new Error("silent");
      },
      acquireInteractive: async () => {
        throw redirectError;
      },
    });
    assert.equal(await createAccessTokenProvider(d)(), null);
    assert.equal(calls.errors.at(-1), redirectError);
  });

  it("starts a new acquisition after the previous one settles", async () => {
    let n = 0;
    const getToken = createAccessTokenProvider(deps({ acquireSilent: async () => `token-${++n}` }).deps);
    assert.equal(await getToken(), "token-1");
    assert.equal(await getToken(), "token-2");
  });
});
