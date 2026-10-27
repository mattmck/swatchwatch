import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LatestLoader,
  MAX_NEAR_HEX_TARGETS,
  contextNearbyTargets,
  listNearbyTargets,
  nearbyQueryKey,
  uniqueHexes,
  type NearbyTargetsInput,
} from "./color-search-nearby";

const base: NearbyTargetsInput = {
  hoverHex: null,
  selectedHex: "#aa0000",
  focusedTargetHex: null,
  similarMode: false,
  paletteAnchors: [],
  rawHarmonyColors: ["#00AA00", "#0000AA"],
  paletteSlotHexes: [],
};

describe("uniqueHexes", () => {
  it("upper-cases, drops empties and keeps first-seen order", () => {
    assert.deepEqual(uniqueHexes(["#abc123", null, "#ABC123", undefined, "#000000"]), ["#ABC123", "#000000"]);
  });
});

describe("listNearbyTargets", () => {
  it("ranks a harmony list against the selected color and its harmonies, never the hover color", () => {
    assert.deepEqual(listNearbyTargets({ ...base, hoverHex: "#123456" }), ["#AA0000", "#00AA00", "#0000AA"]);
  });

  it("follows the hover color in Similar mode, falling back to the selection", () => {
    assert.deepEqual(listNearbyTargets({ ...base, similarMode: true, hoverHex: "#123456" }), ["#123456"]);
    assert.deepEqual(listNearbyTargets({ ...base, similarMode: true }), ["#AA0000"]);
  });

  it("uses only the focused target when one is set", () => {
    assert.deepEqual(listNearbyTargets({ ...base, focusedTargetHex: "#00aa00", hoverHex: "#123456" }), ["#00AA00"]);
  });

  it("is empty with no selection in harmony mode, and caps at the API limit", () => {
    assert.deepEqual(listNearbyTargets({ ...base, selectedHex: null }), []);
    const many = Array.from({ length: 40 }, (_, i) => `#0000${i.toString(16).padStart(2, "0")}`);
    assert.equal(listNearbyTargets({ ...base, rawHarmonyColors: many }).length, MAX_NEAR_HEX_TARGETS);
  });
});

describe("contextNearbyTargets", () => {
  it("covers selection, focus, anchors and harmonies but not the hover color", () => {
    assert.deepEqual(
      contextNearbyTargets({ ...base, hoverHex: "#123456", focusedTargetHex: "#00AA00", paletteAnchors: ["#ffffff"] }),
      ["#AA0000", "#00AA00", "#FFFFFF", "#0000AA"],
    );
  });

  it("adds the recommended palettes' slots after the other targets, within the API limit", () => {
    assert.deepEqual(
      contextNearbyTargets({ ...base, paletteAnchors: ["#ffffff"], paletteSlotHexes: ["#ffffff", "#123456"] }),
      ["#AA0000", "#FFFFFF", "#00AA00", "#0000AA", "#123456"],
    );
    const many = Array.from({ length: 40 }, (_, i) => `#0000${i.toString(16).padStart(2, "0")}`);
    assert.equal(contextNearbyTargets({ ...base, paletteSlotHexes: many }).length, MAX_NEAR_HEX_TARGETS);
  });

  it("does not change while only the hover color moves", () => {
    const a = contextNearbyTargets({ ...base, similarMode: true, hoverHex: "#111111" });
    const b = contextNearbyTargets({ ...base, similarMode: true, hoverHex: "#222222" });
    assert.deepEqual(a, b);
  });
});

describe("nearbyQueryKey", () => {
  it("is null without targets and differs by brand and finish", () => {
    assert.equal(nearbyQueryKey({ nearHex: [] }), null);
    const plain = nearbyQueryKey({ nearHex: ["#AA0000"] });
    assert.notEqual(plain, nearbyQueryKey({ nearHex: ["#AA0000"], brand: "Holo Taco" }));
    assert.notEqual(plain, nearbyQueryKey({ nearHex: ["#AA0000"], finish: "holo" }));
    assert.equal(plain, nearbyQueryKey({ nearHex: ["#AA0000"] }));
  });
});

/** A fake clock + timers + controllable responses. */
function harness(minIntervalMs = 300) {
  let now = 0;
  let nextTimerId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const calls: { params: string; signal: AbortSignal; resolve: (v: string) => void; reject: (e: unknown) => void }[] = [];
  const loaded: [string, string][] = [];
  const failed: string[] = [];
  const loader = new LatestLoader<string, string>({
    minIntervalMs,
    now: () => now,
    setTimer: (fn, ms) => {
      const id = nextTimerId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (id) => {
      timers.delete(id as number);
    },
    load: (params, signal) =>
      new Promise<string>((resolve, reject) => {
        calls.push({ params, signal, resolve, reject });
      }),
    onLoaded: (key, value) => loaded.push([key, value]),
    onFailed: (key) => failed.push(key),
  });
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= now) {
        timers.delete(id);
        timer.fn();
      }
    }
  };
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  return { loader, calls, loaded, failed, advance, flush, timers };
}

describe("LatestLoader", () => {
  it("starts the first request at once (leading edge)", () => {
    const h = harness();
    h.loader.request("a", "a");
    assert.equal(h.calls.length, 1);
  });

  it("starts at most one request per interval while the key keeps moving, and always fetches the last key", () => {
    const h = harness(300);
    h.loader.request("k0", "k0");
    // A drag: a new key every 16 ms for one second.
    for (let i = 1; i <= 60; i++) {
      h.advance(16);
      h.loader.request(`k${i}`, `k${i}`);
    }
    h.advance(300);
    const started = h.calls.map((c) => c.params);
    assert.ok(started.length <= 5, `expected ≤ 5 requests for a 1 s drag, got ${started.length}`);
    assert.equal(started[0], "k0");
    assert.equal(started.at(-1), "k60");
  });

  it("does not refetch a key that is already running", () => {
    const h = harness(300);
    h.loader.request("a", "a");
    h.advance(50);
    h.loader.request("b", "b"); // scheduled
    h.loader.request("a", "a"); // back to the running one: the scheduled start is dropped
    h.advance(1000);
    assert.deepEqual(h.calls.map((c) => c.params), ["a"]);
  });

  it("never lets an older response overwrite a newer one, and aborts older requests once a newer one lands", async () => {
    const h = harness(0);
    h.loader.request("a", "a");
    h.loader.request("b", "b");
    h.loader.request("c", "c");
    assert.equal(h.calls.length, 3);
    h.calls[1].resolve("rows-b");
    await h.flush();
    assert.deepEqual(h.loaded, [["b", "rows-b"]]);
    assert.equal(h.calls[0].signal.aborted, true, "older request a is aborted");
    assert.equal(h.calls[2].signal.aborted, false, "newer request c keeps running");
    h.calls[0].resolve("rows-a"); // late, stale
    await h.flush();
    h.calls[2].resolve("rows-c");
    await h.flush();
    assert.deepEqual(h.loaded, [["b", "rows-b"], ["c", "rows-c"]]);
    assert.equal(h.loader.pendingCount, 0);
  });

  it("applies intermediate responses during a drag so the rows keep following the color", async () => {
    const h = harness(300);
    h.loader.request("k0", "k0");
    h.advance(100);
    h.loader.request("k1", "k1");
    h.calls[0].resolve("rows-k0");
    await h.flush();
    assert.deepEqual(h.loaded.map(([key]) => key), ["k0"]);
    h.advance(200); // k1 starts on the trailing edge
    h.calls[1].resolve("rows-k1");
    await h.flush();
    assert.deepEqual(h.loaded.map(([key]) => key), ["k0", "k1"]);
  });

  it("reports a failure for the latest key and allows a retry of it", async () => {
    const h = harness(0);
    h.loader.request("a", "a");
    h.calls[0].reject(new Error("500"));
    await h.flush();
    assert.deepEqual(h.failed, ["a"]);
    h.loader.request("a", "a");
    assert.equal(h.calls.length, 2);
  });

  it("cancels everything on null and on dispose", () => {
    const h = harness(300);
    h.loader.request("a", "a");
    h.loader.request("b", "b");
    h.loader.request(null, "");
    assert.equal(h.calls[0].signal.aborted, true);
    assert.equal(h.timers.size, 0);
    h.advance(1000);
    assert.equal(h.calls.length, 1);

    const d = harness(300);
    d.loader.request("a", "a");
    d.loader.request("b", "b");
    d.loader.dispose();
    assert.equal(d.calls[0].signal.aborted, true);
    assert.equal(d.timers.size, 0);
    d.loader.request("c", "c");
    assert.equal(d.calls.length, 1);
  });
});
