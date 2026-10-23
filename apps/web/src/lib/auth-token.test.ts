import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  getAccessToken,
  getFreshAccessToken,
  setAccessToken,
  setAccessTokenProvider,
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
