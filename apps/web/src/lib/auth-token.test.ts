import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  getAccessToken,
  getFreshAccessToken,
  hasUsableAccessToken,
  setAccessToken,
  setAccessTokenProvider,
  setAuthOffline,
  subscribeAccessToken,
} from "./auth-token";

function deferred() {
  let resolve: (token: string | null) => void = () => {};
  const promise = new Promise<string | null>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("getFreshAccessToken", () => {
  beforeEach(() => {
    setAccessTokenProvider(null);
    setAccessToken(null);
  });

  it("returns the stored token when no provider is registered", async () => {
    setAccessToken("stored");
    assert.equal(await getFreshAccessToken(), "stored");
  });

  it("stores and returns the provider's token", async () => {
    setAccessTokenProvider(async () => "fresh");
    assert.equal(await getFreshAccessToken(), "fresh");
    assert.equal(getAccessToken(), "fresh");
  });

  it("does not write back a token that settles after sign-out cleared the store", async () => {
    const pending = deferred();
    setAccessTokenProvider(() => pending.promise);
    const call = getFreshAccessToken();
    setAccessToken(null);
    pending.resolve("stale");
    assert.equal(await call, null);
    assert.equal(getAccessToken(), null);
  });

  it("returns the token MSAL's success event stored while the call was pending", async () => {
    const pending = deferred();
    setAccessTokenProvider(() => pending.promise);
    const call = getFreshAccessToken();
    setAccessToken("from-event");
    pending.resolve("from-event");
    assert.equal(await call, "from-event");
  });

  it("returns null when the provider was replaced while pending", async () => {
    const pending = deferred();
    setAccessTokenProvider(() => pending.promise);
    const call = getFreshAccessToken();
    setAccessTokenProvider(async () => "other");
    pending.resolve("stale");
    assert.equal(await call, null);
    assert.equal(getAccessToken(), null);
  });
});

describe("subscribeAccessToken", () => {
  beforeEach(() => {
    setAccessTokenProvider(null);
    setAccessToken(null);
    setAuthOffline(false);
  });

  it("notifies the guard when a token lands after it rendered without one", async () => {
    // The guard rendered the sign-in card with no token; telemetry's API call then stores one.
    let calls = 0;
    const unsubscribe = subscribeAccessToken(() => {
      calls += 1;
    });
    assert.equal(hasUsableAccessToken(), false);
    setAccessTokenProvider(async () => "renewed");
    await getFreshAccessToken();
    assert.equal(calls, 1);
    assert.equal(hasUsableAccessToken(), true);
    unsubscribe();
  });

  it("notifies on setAccessToken and on sign-out", () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeAccessToken(() => seen.push(hasUsableAccessToken()));
    setAccessToken("from-event");
    setAccessToken(null);
    assert.deepEqual(seen, [true, false]);
    unsubscribe();
  });

  it("does not notify when the token is unchanged", async () => {
    setAccessToken("same");
    let calls = 0;
    const unsubscribe = subscribeAccessToken(() => {
      calls += 1;
    });
    setAccessToken("same");
    setAccessTokenProvider(async () => "same");
    await getFreshAccessToken();
    assert.equal(calls, 0);
    unsubscribe();
  });

  it("does not notify for a result discarded after sign-out", async () => {
    const pending = deferred();
    setAccessTokenProvider(() => pending.promise);
    const call = getFreshAccessToken();
    setAccessToken(null);
    let calls = 0;
    const unsubscribe = subscribeAccessToken(() => {
      calls += 1;
    });
    pending.resolve("stale");
    await call;
    assert.equal(calls, 0);
    unsubscribe();
  });

  it("counts an offline session as usable and notifies when it flips", () => {
    let calls = 0;
    const unsubscribe = subscribeAccessToken(() => {
      calls += 1;
    });
    setAuthOffline(true);
    assert.equal(hasUsableAccessToken(), true);
    setAuthOffline(true);
    setAuthOffline(false);
    assert.equal(hasUsableAccessToken(), false);
    assert.equal(calls, 2);
    unsubscribe();
  });

  it("stops notifying after unsubscribe", () => {
    let calls = 0;
    const unsubscribe = subscribeAccessToken(() => {
      calls += 1;
    });
    unsubscribe();
    setAccessToken("after");
    assert.equal(calls, 0);
  });
});
