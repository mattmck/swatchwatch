import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GETTING_STARTED_STEPS } from "swatchwatch-shared";
import { ONBOARDING_ROUTES, isBrandNewCollection, swatchStripHexes } from "./onboarding";

describe("ONBOARDING_ROUTES", () => {
  it("has a route for every shared step", () => {
    assert.deepEqual(
      GETTING_STARTED_STEPS.map((s) => ONBOARDING_ROUTES[s.id]),
      ["/import", "/add", "/search"],
    );
  });
});

describe("swatchStripHexes", () => {
  const row = (createdAt: string, vendorHex: string | null, status = "owned") =>
    ({ status, createdAt, vendorHex, detectedHex: null, nameHex: null }) as never;

  it("lists owned polishes oldest first and ignores other statuses", () => {
    const hexes = swatchStripHexes([
      row("2026-03-02", "#222222"),
      row("2026-03-01", "#111111"),
      row("2026-03-03", "#333333", "wishlist"),
    ]);
    assert.deepEqual(hexes, ["#111111", "#222222"]);
  });

  it("keeps a polish without a color as null and stops at the goal", () => {
    assert.deepEqual(swatchStripHexes([row("2026-01-01", null)]), [null]);
    const many = Array.from({ length: 25 }, (_, i) => row(`2026-01-${String(i + 1).padStart(2, "0")}`, "#abcdef"));
    assert.equal(swatchStripHexes(many).length, 20);
  });
});

describe("isBrandNewCollection", () => {
  it("is true only once counts are known and both are zero", () => {
    assert.equal(isBrandNewCollection(undefined), false);
    assert.equal(isBrandNewCollection({ owned: 0, wishlist: 0 }), true);
    assert.equal(isBrandNewCollection({ owned: 0, wishlist: 2 }), false);
    assert.equal(isBrandNewCollection({ owned: 1, wishlist: 0 }), false);
  });
});
