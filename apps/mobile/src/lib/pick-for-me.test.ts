import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Polish } from "swatchwatch-shared";
import { generateHarmonyPalette } from "swatchwatch-shared";
import {
  buildPickManicure,
  createSeededRandom,
  pickForMe,
  PICK_WEIGHTS,
  pushPickHistory,
  scorePickCandidates,
  suggestPairings,
  thinGapCells,
} from "./pick-for-me";

const NOW = Date.parse("2026-10-18T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

function polish(id: string, extra: Partial<Polish> = {}): Polish {
  return {
    id,
    shadeId: id,
    userId: "1",
    brand: "B",
    name: `P${id}`,
    color: "x",
    vendorHex: "#FF0000",
    status: "owned",
    triedAt: daysAgo(200),
    lastWornAt: daysAgo(10),
    createdAt: "",
    updatedAt: "",
    ...extra,
  } as Polish;
}

describe("scorePickCandidates", () => {
  it("only scores owned polishes", () => {
    const rows = [polish("1"), polish("2", { status: "wishlist" }), polish("3", { status: "archived" })];
    assert.deepEqual(scorePickCandidates(rows, NOW).map((c) => c.polish.id), ["1"]);
  });

  it("untried, never-worn polishes weigh the most; worn yesterday weighs 0", () => {
    const rows = [
      polish("fresh", { triedAt: null, lastWornAt: null }),
      polish("yesterday", { lastWornAt: daysAgo(1) }),
      polish("old", { lastWornAt: daysAgo(120) }),
    ];
    const byId = Object.fromEntries(scorePickCandidates(rows, NOW).map((c) => [c.polish.id, c]));
    assert.equal(byId.fresh.weight, PICK_WEIGHTS.untriedMultiplier * PICK_WEIGHTS.staleMaxMultiplier);
    assert.equal(byId.yesterday.weight, 0);
    assert.equal(byId.old.weight, PICK_WEIGHTS.staleMaxMultiplier);
    assert.ok(byId.old.reasons.some((r) => r.kind === "not-worn"));
  });
});

describe("pickForMe", () => {
  it("is reproducible with a seed and returns null when nothing is owned", () => {
    const rows = Array.from({ length: 6 }, (_, i) => polish(String(i), { vendorHex: `#${(i * 40).toString(16).padStart(2, "0")}8040` }));
    const a = pickForMe(rows, { now: NOW, random: createSeededRandom(7) });
    const b = pickForMe(rows, { now: NOW, random: createSeededRandom(7) });
    assert.equal(a?.polish.id, b?.polish.id);
    assert.equal(pickForMe([polish("1", { status: "wishlist" })], { now: NOW, random: createSeededRandom(1) }), null);
  });

  it("never repeats the last three picks while others exist", () => {
    const rows = Array.from({ length: 5 }, (_, i) => polish(String(i)));
    const exclude = ["0", "1", "2"];
    for (let seed = 0; seed < 50; seed += 1) {
      const result = pickForMe(rows, { now: NOW, random: createSeededRandom(seed), exclude });
      assert.ok(result && !exclude.includes(result.polish.id));
    }
  });

  it("ignores the wear cooldown when every candidate is in it", () => {
    const rows = [polish("1", { lastWornAt: daysAgo(0) })];
    assert.equal(pickForMe(rows, { now: NOW, random: createSeededRandom(1) })?.polish.id, "1");
  });
});

describe("history and gaps", () => {
  it("keeps the last three picks, most recent last", () => {
    let history: string[] = [];
    for (const id of ["a", "b", "c", "d", "b"]) history = pushPickHistory(history, id);
    assert.deepEqual(history, ["c", "d", "b"]);
  });

  it("flags a lone polish in a sparse collection as a thin cell", () => {
    const hexes = [...Array.from({ length: 10 }, () => "#FF0000"), "#0000FF"];
    const thin = thinGapCells(hexes);
    assert.equal(thin.size, 1);
    assert.ok([...thin][0].startsWith("purples-violets") || [...thin][0].startsWith("blues-teals"));
  });
});

describe("main pick — product categories (#349, D-C)", () => {
  it("only color polishes are main-pick candidates", () => {
    const rows = [
      polish("color"),
      polish("topper", { productCategory: "topper", finishes: ["glitter"] }),
      polish("coat", { productCategory: "top_coat" }),
    ];
    assert.deepEqual(scorePickCandidates(rows, NOW).map((c) => c.polish.id), ["color"]);
  });
});

describe("Pair it", () => {
  const pick = polish("pick", { vendorHex: "#1F4E9C" });
  const complement = polish("complement", { vendorHex: generateHarmonyPalette("#1F4E9C", "complementary")[1] });
  const topper = polish("topper", { productCategory: "topper", vendorHex: "#EEEEEE", finishes: ["topper"] });

  it("suggests owned pairings with the shared rule", () => {
    const pairs = suggestPairings(pick, [pick, complement, topper]);
    assert.deepEqual(
      pairs.map((p) => [p.polish.id, p.role]),
      [
        ["complement", "accent"],
        ["topper", "topper"],
      ],
    );
  });

  it("logs the pick as main color plus only the selected pairings", () => {
    const pairs = suggestPairings(pick, [pick, complement, topper]);
    assert.deepEqual(buildPickManicure(pick, pairs, new Set(["topper"]), "2026-10-18"), {
      wornOn: "2026-10-18",
      polishes: [
        { shadeId: "pick", role: "color" },
        { shadeId: "topper", role: "topper" },
      ],
    });
    assert.deepEqual(buildPickManicure(pick, pairs, new Set(), "2026-10-18").polishes, [{ shadeId: "pick", role: "color" }]);
  });
});
