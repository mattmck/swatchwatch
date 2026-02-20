import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Polish } from "swatchwatch-shared";
import { runRecalcHexFlow } from "./recalc-hex-flow";

function polish(overrides: Partial<Polish>): Polish {
  return {
    id: "1",
    shadeId: "1",
    userId: "1",
    brand: "Zoya",
    name: "Default",
    color: "Default",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("runRecalcHexFlow", () => {
  it("updates polish state and shows success toast when detectedHex exists", async () => {
    let pending: Record<string, boolean> = {};
    const pendingStates: Record<string, boolean>[] = [];
    let polishes: Polish[] = [
      polish({ id: "target", finish: undefined }),
      polish({ id: "other", finish: "glitter" }),
    ];
    const toastCalls: Array<{ level: string; message: string; description?: string }> = [];

    await runRecalcHexFlow({
      polishId: "target",
      recalc: async () => ({
        message: "Detected hex #ABCDEF",
        detectedHex: "#ABCDEF",
        confidence: 0.82,
        finishes: ["creme", "shimmer"],
      }),
      knownFinishes: ["creme", "shimmer", "glitter"],
      setPendingById: (updater) => {
        pending = updater(pending);
        pendingStates.push({ ...pending });
      },
      setPolishes: (updater) => {
        polishes = updater(polishes);
      },
      toast: {
        success: (message, options) =>
          toastCalls.push({ level: "success", message, description: options?.description }),
        info: (message, options) =>
          toastCalls.push({ level: "info", message, description: options?.description }),
        error: (message, options) =>
          toastCalls.push({ level: "error", message, description: options?.description }),
      },
    });

    assert.deepEqual(pendingStates[0], { target: true });
    assert.deepEqual(pendingStates[pendingStates.length - 1], {});
    assert.equal(polishes[0].detectedHex, "#ABCDEF");
    assert.equal(polishes[0].finish, "creme");
    assert.equal(toastCalls.length, 1);
    assert.equal(toastCalls[0].level, "success");
    assert.equal(toastCalls[0].message, "Detected hex #ABCDEF");
    assert.match(toastCalls[0].description || "", /82% confidence/);
    assert.match(toastCalls[0].description || "", /Finishes: creme, shimmer/);
  });

  it("shows info toast and keeps polish values when no detectedHex is returned", async () => {
    let pending: Record<string, boolean> = {};
    let polishes: Polish[] = [polish({ id: "target", finish: "glitter", detectedHex: "#111111" })];
    const toastCalls: Array<{ level: string; message: string; description?: string }> = [];

    await runRecalcHexFlow({
      polishId: "target",
      recalc: async () => ({
        message: "Could not detect hex from image",
        detectedHex: null,
        confidence: 0.4,
        finishes: null,
      }),
      knownFinishes: ["creme", "shimmer", "glitter"],
      setPendingById: (updater) => {
        pending = updater(pending);
      },
      setPolishes: (updater) => {
        polishes = updater(polishes);
      },
      toast: {
        success: (message, options) =>
          toastCalls.push({ level: "success", message, description: options?.description }),
        info: (message, options) =>
          toastCalls.push({ level: "info", message, description: options?.description }),
        error: (message, options) =>
          toastCalls.push({ level: "error", message, description: options?.description }),
      },
    });

    assert.deepEqual(pending, {});
    assert.equal(polishes[0].detectedHex, "#111111");
    assert.equal(polishes[0].finish, "glitter");
    assert.equal(toastCalls.length, 1);
    assert.equal(toastCalls[0].level, "info");
    assert.equal(toastCalls[0].message, "Could not detect hex from image");
    assert.equal(toastCalls[0].description, "40% confidence");
  });
});
