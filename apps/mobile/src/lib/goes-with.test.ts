import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateHarmonyColors, PAIR_MAX_DISTANCE, type Polish } from "swatchwatch-shared";
import { goesWithTargets, hexRouteParam } from "./goes-with";

function polish(id: string, extra: Partial<Polish> = {}): Polish {
  return { id, shadeId: id, userId: "1", brand: "B", name: `P${id}`, status: "owned", createdAt: "", updatedAt: "", ...extra } as Polish;
}

const RED = "#C0392B";

describe("goesWithTargets", () => {
  it("lists complementary, analogous and triadic targets", () => {
    const targets = goesWithTargets(RED, []);
    assert.deepEqual(
      targets.map((t) => t.harmony),
      ["complementary", "analogous", "analogous", "triadic", "triadic"],
    );
    assert.equal(targets[0].targetHex, generateHarmonyColors(RED, "complementary")[0].toUpperCase());
    assert.ok(targets.every((t) => t.match === null));
  });

  it("matches the closest owned color polish within PAIR_MAX_DISTANCE, each used once", () => {
    const complement = generateHarmonyColors(RED, "complementary")[0];
    const owned = [
      polish("near", { vendorHex: complement }),
      polish("also-near", { vendorHex: complement }),
      polish("self", { vendorHex: RED }),
      polish("topper", { vendorHex: complement, productCategory: "topper" }),
      polish("wish", { vendorHex: complement, status: "wishlist" }),
    ];
    const targets = goesWithTargets(RED, owned, "self");
    assert.equal(targets[0].match?.polish.id, "also-near"); // tie → name order (Palso-near < Pnear)
    assert.ok((targets[0].match?.distance ?? 1) <= PAIR_MAX_DISTANCE);
    const ids = targets.flatMap((t) => (t.match ? [t.match.polish.id] : []));
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(!ids.includes("self") && !ids.includes("topper") && !ids.includes("wish"));
  });

  it("leaves a target unmatched when nothing owned is close", () => {
    const targets = goesWithTargets(RED, [polish("far", { vendorHex: "#FFFFFF" })]);
    assert.ok(targets.every((t) => t.match === null));
  });

  it("returns nothing for neutral or missing sources", () => {
    assert.deepEqual(goesWithTargets("#808080", []), []);
    assert.deepEqual(goesWithTargets(null, []), []);
  });
});

describe("hexRouteParam", () => {
  it("strips # and uppercases", () => {
    assert.equal(hexRouteParam("#c0392b"), "C0392B");
  });
});
