import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Polish, PolishDupe, PolishDupeHint, PolishDupesResponse } from "swatchwatch-shared";
import {
  ADD_GUARD_MAX_SUPPRESSED,
  ADD_GUARD_SESSION_KEY,
  ADD_GUARD_TIMEOUT_MS,
  AddGuardTimeoutError,
  addGuardPrecheck,
  addGuardTelemetry,
  dupesForNewShade,
  newShadeGuardKey,
  readSuppressedGuardKeys,
  resolveAddGuard,
  shadeGuardKey,
  suppressGuardKey,
  wishlistInsteadUpdate,
  withTimeout,
} from "./add-guard";

function dupe(overrides: Partial<PolishDupe> = {}): PolishDupe {
  return {
    shadeId: "7",
    brand: "Holo Taco",
    name: "Red Velvet",
    finishes: ["creme"],
    displayHex: "#B0303A",
    displayHexSource: "vendor",
    distance: 0.012,
    colorGrade: "high",
    grade: "high",
    finishCompatibility: "same",
    ...overrides,
  };
}

function response(dupes: PolishDupe[]): PolishDupesResponse {
  return {
    target: { shadeId: "1", displayHex: "#B1313B", displayHexSource: "vendor", finishes: ["creme"] },
    dupes,
    dupeCount: dupes.length,
    highCount: dupes.filter((d) => d.grade === "high").length,
    candidateCount: 10,
  };
}

function hint(best: PolishDupe | null): PolishDupeHint {
  return { shadeId: "1", best, dupeCount: best ? 1 : 0, highCount: best?.grade === "high" ? 1 : 0 };
}

const NONE = new Set<string>();
const KEY = shadeGuardKey("1");

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

/** Manual timers: `fire()` runs every pending callback, so timeouts are deterministic. */
function manualTimers() {
  const pending = new Map<number, () => void>();
  let next = 1;
  return {
    pending,
    setTimeout: (fn: () => void) => {
      const id = next++;
      pending.set(id, fn);
      return id;
    },
    clearTimeout: (handle: unknown) => {
      pending.delete(handle as number);
    },
    fire() {
      for (const [id, fn] of Array.from(pending)) {
        pending.delete(id);
        fn();
      }
    },
  };
}

describe("addGuardPrecheck — when to show", () => {
  it("never guards a shade the user already owns (a quantity increase)", () => {
    assert.deepEqual(
      addGuardPrecheck({ status: "owned", intent: "own", guardKey: KEY, suppressed: NONE }),
      { action: "skip", reason: "already-owned" }
    );
    assert.deepEqual(
      addGuardPrecheck({ status: "owned", intent: "wishlist", guardKey: KEY, suppressed: NONE }),
      { action: "skip", reason: "already-owned" }
    );
  });

  it("skips wishlisting a shade that is already wishlisted", () => {
    assert.deepEqual(
      addGuardPrecheck({ status: "wishlist", intent: "wishlist", guardKey: KEY, suppressed: NONE }),
      { action: "skip", reason: "already-in-status" }
    );
  });

  it("checks catalog, wishlist, destash and archived rows when adding to the collection", () => {
    for (const status of [null, undefined, "wishlist", "destash", "archived"] as const) {
      assert.deepEqual(
        addGuardPrecheck({ status, intent: "own", guardKey: KEY, suppressed: NONE }),
        { action: "check" },
        String(status)
      );
    }
  });

  it("respects session suppression", () => {
    assert.deepEqual(
      addGuardPrecheck({ status: null, intent: "own", guardKey: KEY, suppressed: new Set([KEY]) }),
      { action: "skip", reason: "suppressed" }
    );
    assert.deepEqual(
      addGuardPrecheck({ status: null, intent: "own", guardKey: KEY, suppressed: new Set([shadeGuardKey("2")]) }),
      { action: "check" }
    );
  });

  it("reuses a loaded batch hint: 'none' skips the call, a dupe still checks", () => {
    assert.deepEqual(
      addGuardPrecheck({ status: null, intent: "own", guardKey: KEY, suppressed: NONE, hint: hint(null) }),
      { action: "skip", reason: "hint-none" }
    );
    assert.deepEqual(
      addGuardPrecheck({ status: null, intent: "own", guardKey: KEY, suppressed: NONE, hint: hint(dupe()) }),
      { action: "check" }
    );
    assert.deepEqual(
      addGuardPrecheck({ status: null, intent: "own", guardKey: KEY, suppressed: NONE, hint: undefined }),
      { action: "check" }
    );
  });
});

describe("resolveAddGuard", () => {
  it("warns with the full response when there is an owned dupe", async () => {
    let calls = 0;
    const outcome = await resolveAddGuard({
      status: null,
      intent: "own",
      guardKey: KEY,
      suppressed: NONE,
      loadDupes: async () => {
        calls += 1;
        return response([dupe({ grade: "medium" })]);
      },
    });
    assert.equal(calls, 1, "one GET /dupes call");
    assert.equal(outcome.kind, "warn");
    if (outcome.kind === "warn") assert.equal(outcome.verdict, "near-dupe-owned");
  });

  it("proceeds without a dialog when there are no dupes", async () => {
    const outcome = await resolveAddGuard({
      status: null,
      intent: "own",
      guardKey: KEY,
      suppressed: NONE,
      loadDupes: async () => response([]),
    });
    assert.deepEqual(outcome, { kind: "proceed", reason: "no-dupes" });
  });

  it("does not call the API when the precheck skips", async () => {
    let calls = 0;
    const loadDupes = async () => {
      calls += 1;
      return response([dupe()]);
    };
    for (const input of [
      { status: "owned" as const, hint: undefined, suppressed: NONE },
      { status: null, hint: hint(null), suppressed: NONE },
      { status: null, hint: undefined, suppressed: new Set([KEY]) },
    ]) {
      const outcome = await resolveAddGuard({ ...input, intent: "own", guardKey: KEY, loadDupes });
      assert.equal(outcome.kind, "proceed");
    }
    assert.equal(calls, 0);
  });

  it("proceeds unchecked when the dupe call fails (never blocks the add)", async () => {
    const boom = new Error("500");
    const outcome = await resolveAddGuard({
      status: null,
      intent: "own",
      guardKey: KEY,
      suppressed: NONE,
      loadDupes: async () => {
        throw boom;
      },
    });
    assert.deepEqual(outcome, { kind: "proceed-unchecked", reason: "error", error: boom });
  });

  it("proceeds unchecked when a synchronous loader throws", async () => {
    const outcome = await resolveAddGuard({
      status: null,
      intent: "own",
      guardKey: KEY,
      suppressed: NONE,
      loadDupes: () => {
        throw new Error("sync");
      },
    });
    assert.equal(outcome.kind, "proceed-unchecked");
  });

  it("falls back after the timeout and ignores a late response", async () => {
    const timers = manualTimers();
    let resolveLate: (value: PolishDupesResponse) => void = () => {};
    const pendingOutcome = resolveAddGuard({
      status: null,
      intent: "own",
      guardKey: KEY,
      suppressed: NONE,
      loadDupes: () => new Promise((resolve) => (resolveLate = resolve)),
      timers,
    });
    // Let the loader start, then let the timer win.
    await Promise.resolve();
    timers.fire();
    const outcome = await pendingOutcome;
    assert.equal(outcome.kind, "proceed-unchecked");
    if (outcome.kind === "proceed-unchecked") {
      assert.equal(outcome.reason, "timeout");
      assert.ok(outcome.error instanceof AddGuardTimeoutError);
    }
    resolveLate(response([dupe()]));
  });

  it("uses the 2s default timeout", () => {
    assert.equal(ADD_GUARD_TIMEOUT_MS, 2000);
  });

  it("treats a null loader result as nothing to guard", async () => {
    const outcome = await resolveAddGuard({
      status: null,
      intent: "own",
      guardKey: newShadeGuardKey("A", "B"),
      suppressed: NONE,
      loadDupes: async () => null,
    });
    assert.deepEqual(outcome, { kind: "proceed", reason: "already-owned" });
  });
});

describe("withTimeout", () => {
  it("resolves and clears the timer when the promise wins", async () => {
    const timers = manualTimers();
    assert.equal(await withTimeout(Promise.resolve(5), 100, timers), 5);
    assert.equal(timers.pending.size, 0);
  });

  it("passes through rejections and clears the timer", async () => {
    const timers = manualTimers();
    await assert.rejects(withTimeout(Promise.reject(new Error("x")), 100, timers), /x/);
    assert.equal(timers.pending.size, 0);
  });

  it("rejects with AddGuardTimeoutError on a real timer", async () => {
    await assert.rejects(withTimeout(new Promise(() => {}), 5), AddGuardTimeoutError);
  });
});

describe("session suppression", () => {
  it("round-trips keys through storage", () => {
    const storage = memoryStorage();
    suppressGuardKey(storage, shadeGuardKey("1"));
    suppressGuardKey(storage, shadeGuardKey("2"));
    suppressGuardKey(storage, shadeGuardKey("1"));
    assert.deepEqual([...readSuppressedGuardKeys(storage)], ["shade:2", "shade:1"]);
  });

  it("caps the stored list", () => {
    const storage = memoryStorage();
    for (let i = 0; i < ADD_GUARD_MAX_SUPPRESSED + 5; i += 1) suppressGuardKey(storage, shadeGuardKey(i));
    const keys = readSuppressedGuardKeys(storage);
    assert.equal(keys.size, ADD_GUARD_MAX_SUPPRESSED);
    assert.ok(!keys.has("shade:0"), "oldest dropped");
  });

  it("reads missing, corrupt or non-array storage as empty", () => {
    assert.equal(readSuppressedGuardKeys(null).size, 0);
    assert.equal(readSuppressedGuardKeys(memoryStorage()).size, 0);
    assert.equal(readSuppressedGuardKeys(memoryStorage({ [ADD_GUARD_SESSION_KEY]: "{not json" })).size, 0);
    assert.equal(readSuppressedGuardKeys(memoryStorage({ [ADD_GUARD_SESSION_KEY]: '{"a":1}' })).size, 0);
    assert.deepEqual(
      [...readSuppressedGuardKeys(memoryStorage({ [ADD_GUARD_SESSION_KEY]: '["shade:1", 4, null]' }))],
      ["shade:1"]
    );
  });

  it("never throws when storage throws", () => {
    const throwing = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    assert.equal(readSuppressedGuardKeys(throwing).size, 0);
    assert.doesNotThrow(() => suppressGuardKey(throwing, KEY));
    assert.doesNotThrow(() => suppressGuardKey(null, KEY));
  });

  it("builds stable keys", () => {
    assert.equal(shadeGuardKey(42), "shade:42");
    assert.equal(newShadeGuardKey("  Holo  Taco ", "Red VELVET"), "new:holo taco|red velvet");
  });
});

describe("dupesForNewShade", () => {
  function owned(overrides: Partial<Polish>): Polish {
    return {
      id: "10",
      shadeId: "10",
      userId: "1",
      brand: "Brand",
      name: "Shade",
      color: "red",
      status: "owned",
      finishes: ["creme"],
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
      ...overrides,
    };
  }

  it("grades the entered hex against owned shades with the shared rule", () => {
    const result = dupesForNewShade({ brand: "New", name: "One", hex: "#B0303A", finishes: ["creme"] }, [
      owned({ id: "10", vendorHex: "#B1313B", name: "Near Twin" }),
      owned({ id: "11", vendorHex: "#2050F0", name: "Blue" }),
      owned({ id: "12", vendorHex: "#B0303A", name: "Wishlisted", status: "wishlist" }),
    ]);
    assert.ok(result);
    assert.equal(result.target.displayHex, "#B0303A");
    assert.deepEqual(result.dupes.map((d) => d.shadeId), ["10"], "only owned, only close");
    assert.equal(result.dupes[0].grade, "high");
    assert.equal(result.highCount, 1);
    assert.equal(result.candidateCount, 2);
  });

  it("returns null when the user already owns the same brand + name", () => {
    assert.equal(
      dupesForNewShade({ brand: "brand ", name: "SHADE", hex: "#B0303A", finishes: [] }, [owned({ vendorHex: "#B0303A" })]),
      null
    );
  });

  it("returns null for an unusable hex and an empty result when nothing is close", () => {
    assert.equal(dupesForNewShade({ brand: "a", name: "b", hex: "nope", finishes: [] }, []), null);
    const result = dupesForNewShade({ brand: "a", name: "b", hex: "#FFFFFF", finishes: [] }, [owned({ vendorHex: "#000000" })]);
    assert.equal(result?.dupeCount, 0);
  });
});

describe("telemetry + updates", () => {
  it("describes the guard without PII", () => {
    assert.deepEqual(
      addGuardTelemetry({ surface: "polishes-list", intent: "own", guardKey: KEY, response: response([dupe()]) }),
      {
        surface: "polishes-list",
        intent: "own",
        shade: "1",
        verdict: "dupe-owned",
        dupeCount: 1,
        highCount: 1,
        bestGrade: "high",
        bestFinishCompatibility: "same",
        bestDistance: 0.012,
      }
    );
    assert.deepEqual(
      addGuardTelemetry({ surface: "polish-form-create", intent: "wishlist", guardKey: newShadeGuardKey("a", "b") }),
      { surface: "polish-form-create", intent: "wishlist", shade: "new" }
    );
  });

  it("wishlist instead only changes the status", () => {
    assert.deepEqual(wishlistInsteadUpdate(), { status: "wishlist" });
  });
});
