import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatSavedAt,
  isApiUnreachable,
  isBrowserOffline,
  isOfflineRenewalFailure,
  savedCopyAgeBucket,
} from "./offline";

const HOUR = 60 * 60 * 1000;

class FakeApiError extends Error {
  constructor(public status: number) {
    super("api");
  }
}

describe("isBrowserOffline", () => {
  it("is true only when the browser says it is offline", () => {
    assert.equal(isBrowserOffline({ onLine: false }), true);
    assert.equal(isBrowserOffline({ onLine: true }), false);
    assert.equal(isBrowserOffline(undefined), false);
    assert.equal(isBrowserOffline({}), false);
  });
});

describe("isApiUnreachable", () => {
  it("treats fetch network failures as unreachable", () => {
    assert.equal(isApiUnreachable(new TypeError("Failed to fetch"), false), true);
    assert.equal(isApiUnreachable(new TypeError("Load failed"), false), true);
    assert.equal(isApiUnreachable(new TypeError("NetworkError when attempting to fetch resource."), false), true);
  });

  it("treats gateway errors as unreachable but real answers as not", () => {
    for (const status of [502, 503, 504]) assert.equal(isApiUnreachable(new FakeApiError(status), false), true);
    for (const status of [400, 401, 403, 404, 409, 500]) {
      assert.equal(isApiUnreachable(new FakeApiError(status), false), false, String(status));
      assert.equal(isApiUnreachable(new FakeApiError(status), true), false, `${status} while offline`);
    }
  });

  it("treats any non-HTTP failure while the browser is offline as unreachable", () => {
    assert.equal(isApiUnreachable(new Error("anything"), true), true);
    assert.equal(isApiUnreachable(new Error("anything"), false), false);
    assert.equal(isApiUnreachable(new TypeError("Cannot read properties of undefined"), false), false);
  });
});

describe("isOfflineRenewalFailure", () => {
  it("does not redirect to sign-in while the browser is offline", () => {
    assert.equal(isOfflineRenewalFailure(new Error("interaction_required"), true), true);
    assert.equal(isOfflineRenewalFailure(null, true), true);
  });

  it("recognises network failures while the browser claims to be online", () => {
    assert.equal(isOfflineRenewalFailure(new TypeError("Failed to fetch"), false), true);
    for (const errorCode of ["no_network_connectivity", "network_error", "endpoints_resolution_error", "post_request_failed"]) {
      assert.equal(isOfflineRenewalFailure(Object.assign(new Error("msal"), { errorCode }), false), true, errorCode);
    }
  });

  it("still redirects for real session problems when online", () => {
    for (const errorCode of ["interaction_required", "invalid_grant", "block_iframe_reload", "monitor_window_timeout", "login_required"]) {
      assert.equal(isOfflineRenewalFailure(Object.assign(new Error("msal"), { errorCode }), false), false, errorCode);
    }
    assert.equal(isOfflineRenewalFailure(new Error("boom"), false), false);
    assert.equal(isOfflineRenewalFailure(undefined, false), false);
  });
});

describe("savedCopyAgeBucket", () => {
  const now = Date.UTC(2026, 9, 23, 12);
  it("buckets the age of a saved copy", () => {
    assert.equal(savedCopyAgeBucket(now - 5 * 60 * 1000, now), "lt_1h");
    assert.equal(savedCopyAgeBucket(now - HOUR, now), "lt_1d");
    assert.equal(savedCopyAgeBucket(now - 23 * HOUR, now), "lt_1d");
    assert.equal(savedCopyAgeBucket(now - 24 * HOUR, now), "lt_3d");
    assert.equal(savedCopyAgeBucket(now - 71 * HOUR, now), "lt_3d");
    assert.equal(savedCopyAgeBucket(now - 72 * HOUR, now), "lt_7d");
    assert.equal(savedCopyAgeBucket(now - 200 * HOUR, now), "lt_7d");
  });

  it("treats a save time in the future as fresh", () => {
    assert.equal(savedCopyAgeBucket(now + HOUR, now), "lt_1h");
  });
});

describe("formatSavedAt", () => {
  it("renders a non-empty local date and time", () => {
    assert.match(formatSavedAt(Date.UTC(2026, 9, 23, 12)), /2026/);
  });
});
