import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Polish } from "swatchwatch-shared";
import {
  PICK_HISTORY_SIZE,
  PICK_WEIGHTS,
  createSeededRandom,
  describeGapCell,
  formatRestPeriod,
  pickForMe,
  pushPickHistory,
  scorePickCandidates,
  suggestPairings,
} from "./pick-for-me";
import { colorDistance } from "./color-utils";
import { generateHarmonyPalette } from "./color-harmonies";

const NOW = Date.parse("2026-10-17T12:00:00.000Z");
const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(NOW - days * DAY).toISOString();

function polish(id: string, extra: Partial<Polish> = {}): Polish {
  return {
    id,
    shadeId: id,
    userId: "1",
    brand: "Brand",
    name: `Shade ${id}`,
    status: "owned",
    triedAt: daysAgo(200),
    lastWornAt: daysAgo(10),
    vendorHex: "#C0392B",
    createdAt: "",
    updatedAt: "",
    ...extra,
  } as Polish;
}

function counts(polishes: Polish[], draws: number, seed = 42): Map<string, number> {
  const random = createSeededRandom(seed);
  const tally = new Map<string, number>(polishes.map((p) => [p.id, 0]));
  for (let i = 0; i < draws; i++) {
    const result = pickForMe(polishes, { now: NOW, random });
    assert.ok(result);
    tally.set(result.polish.id, (tally.get(result.polish.id) ?? 0) + 1);
  }
  return tally;
}

describe("createSeededRandom", () => {
  it("is deterministic per seed and stays in [0, 1)", () => {
    const a = createSeededRandom(7);
    const b = createSeededRandom(7);
    const c = createSeededRandom(8);
    const seqA = Array.from({ length: 50 }, a);
    assert.deepEqual(seqA, Array.from({ length: 50 }, b));
    assert.notDeepEqual(seqA, Array.from({ length: 50 }, c));
    assert.ok(seqA.every((x) => x >= 0 && x < 1));
  });
});

describe("scorePickCandidates", () => {
  it("drops everything that is not owned (wishlist, destash, archived, catalog rows)", () => {
    const scored = scorePickCandidates(
      [
        polish("owned"),
        polish("wish", { status: "wishlist" }),
        polish("destash", { status: "destash" }),
        polish("archived", { status: "archived" }),
        polish("catalog", { status: null }),
      ],
      NOW
    );
    assert.deepEqual(
      scored.map((c) => c.polish.id),
      ["owned"]
    );
  });

  it("multiplies the documented factors", () => {
    // Twelve reds in one cell keep that cell "healthy"; the blue is alone in a thin cell.
    const reds = Array.from({ length: 12 }, (_, i) => polish(`r${i}`, { vendorHex: "#C0392B" }));
    const blue = polish("blue", { vendorHex: "#1F4E9C", triedAt: null, lastWornAt: null });
    const scored = new Map(scorePickCandidates([...reds, blue], NOW).map((c) => [c.polish.id, c]));

    const b = scored.get("blue")!;
    assert.equal(b.factors.tried, PICK_WEIGHTS.untriedMultiplier);
    assert.equal(b.factors.recency, PICK_WEIGHTS.staleMaxMultiplier);
    assert.equal(b.factors.gap, PICK_WEIGHTS.gapThinMultiplier);
    assert.equal(b.weight, 3 * 2 * 2);
    assert.deepEqual(
      b.reasons.map((r) => r.kind),
      ["untried", "gap"]
    );

    const r = scored.get("r0")!;
    assert.equal(r.factors.tried, 1);
    assert.equal(r.factors.gap, 1);
    assert.ok(Math.abs(r.factors.recency - (1 + 10 / 90)) < 1e-9, "recency ramps linearly to 90 days");
    assert.deepEqual(r.reasons, []);
  });

  it("caps recency at staleFullDays and zeroes polishes worn today or yesterday", () => {
    const [old, ancient, today, yesterday, twoDays] = scorePickCandidates(
      [
        polish("old", { lastWornAt: daysAgo(90) }),
        polish("ancient", { lastWornAt: daysAgo(400) }),
        polish("today", { lastWornAt: daysAgo(0) }),
        polish("yesterday", { lastWornAt: daysAgo(1) }),
        polish("two", { lastWornAt: daysAgo(2) }),
      ],
      NOW
    );
    assert.equal(old.factors.recency, PICK_WEIGHTS.staleMaxMultiplier);
    assert.equal(ancient.factors.recency, PICK_WEIGHTS.staleMaxMultiplier);
    assert.equal(today.weight, 0);
    assert.equal(yesterday.weight, 0);
    assert.ok(twoDays.weight > 0);
  });

  it("explains rest periods and gaps in words", () => {
    const [stale, tried] = scorePickCandidates(
      [polish("stale", { lastWornAt: daysAgo(95) }), polish("tried", { lastWornAt: null })],
      NOW
    );
    assert.ok(stale.reasons.some((r) => r.label === "Not worn in 3 months"));
    assert.ok(tried.reasons.some((r) => r.kind === "never-worn"));
    assert.equal(formatRestPeriod(35), "5 weeks");
    assert.equal(formatRestPeriod(5), "5 days");
    assert.equal(describeGapCell({ hueFamily: "blues-teals", lightnessBand: "dark" }, "#0B4F4A"), "deep teal");
    assert.equal(describeGapCell({ hueFamily: "blues-teals", lightnessBand: "light" }, "#B8C8F8"), "pale blue");
    assert.equal(describeGapCell({ hueFamily: "pinks-magentas", lightnessBand: "medium-light" }), "soft pink");
  });
});

describe("pickForMe", () => {
  it("returns null for an empty collection (or one with nothing owned)", () => {
    const random = createSeededRandom(1);
    assert.equal(pickForMe([], { now: NOW, random }), null);
    assert.equal(pickForMe([polish("w", { status: "wishlist" })], { now: NOW, random }), null);
  });

  it("always returns the only polish of a single-item collection, even on re-roll or in cooldown", () => {
    const only = polish("only", { lastWornAt: daysAgo(0) });
    const random = createSeededRandom(3);
    for (let i = 0; i < 5; i++) {
      const result = pickForMe([only], { now: NOW, random, exclude: ["only"] });
      assert.equal(result?.polish.id, "only");
    }
  });

  it("is reproducible with a fixed seed", () => {
    const collection = Array.from({ length: 10 }, (_, i) =>
      polish(`p${i}`, { triedAt: i % 2 ? null : daysAgo(100), vendorHex: i % 3 ? "#C0392B" : "#2E8B57" })
    );
    const run = (seed: number) => {
      const random = createSeededRandom(seed);
      return Array.from({ length: 20 }, () => pickForMe(collection, { now: NOW, random })?.polish.id);
    };
    assert.deepEqual(run(99), run(99));
  });

  it("favors untried polishes, and only weight-0 polishes are never picked", () => {
    // Same hex for everyone so only the tried/recency factors differ.
    const collection = [
      ...Array.from({ length: 5 }, (_, i) => polish(`tried${i}`, { lastWornAt: daysAgo(10) })),
      ...Array.from({ length: 5 }, (_, i) => polish(`untried${i}`, { triedAt: null, lastWornAt: daysAgo(10) })),
      polish("wornToday", { lastWornAt: daysAgo(0) }),
    ];
    const tally = counts(collection, 6000);
    const sum = (prefix: string) =>
      [...tally.entries()].filter(([id]) => id.startsWith(prefix)).reduce((s, [, n]) => s + n, 0);

    const untried = sum("untried");
    const tried = sum("tried");
    // Expected ratio is untriedMultiplier (3); allow generous slack for sampling noise.
    assert.ok(untried / tried > 2.4 && untried / tried < 3.6, `untried/tried = ${untried / tried}`);
    assert.equal(tally.get("wornToday"), 0, "weight 0 is never picked while others exist");
    for (const [id, n] of tally) {
      if (id !== "wornToday") assert.ok(n > 0, `${id} has positive weight and must be pickable`);
    }
  });

  it("spreads picks toward thin gap cells", () => {
    const reds = Array.from({ length: 12 }, (_, i) => polish(`red${i}`, { vendorHex: "#C0392B" }));
    const greens = [polish("green", { vendorHex: "#2E8B57" })];
    const tally = counts([...reds, ...greens], 6500, 5);
    const perRed = [...tally.entries()].filter(([id]) => id.startsWith("red")).reduce((s, [, n]) => s + n, 0) / 12;
    const green = tally.get("green")!;
    assert.ok(green / perRed > 1.6, `green should be ~2× an average red, got ${green / perRed}`);
  });

  it("still picks when the whole collection is tried (and when all are in cooldown)", () => {
    const allTried = [polish("a"), polish("b"), polish("c")];
    const random = createSeededRandom(11);
    const result = pickForMe(allTried, { now: NOW, random });
    assert.ok(result);
    assert.ok(!result.reasons.some((r) => r.kind === "untried"));
    assert.equal(result.reasons.length, 1);
    assert.equal(result.reasons[0].kind, "random", "no standout reason falls back to a random-pick label");

    const allCooldown = [polish("x", { lastWornAt: daysAgo(0) }), polish("y", { lastWornAt: daysAgo(1) })];
    assert.ok(pickForMe(allCooldown, { now: NOW, random }));
  });

  it("never repeats the last 3 picks across re-rolls", () => {
    const collection = Array.from({ length: 6 }, (_, i) => polish(`p${i}`, { triedAt: i === 0 ? null : daysAgo(50) }));
    const random = createSeededRandom(2026);
    let history: string[] = [];
    for (let i = 0; i < 300; i++) {
      const result = pickForMe(collection, { now: NOW, random, exclude: history });
      assert.ok(result);
      assert.ok(!history.includes(result.polish.id), `draw ${i} repeated ${result.polish.id} from ${history}`);
      history = pushPickHistory(history, result.polish.id);
      assert.ok(history.length <= PICK_HISTORY_SIZE);
    }
  });

  it("relaxes to 'not the previous pick' for tiny collections", () => {
    const collection = [polish("a"), polish("b")];
    const random = createSeededRandom(4);
    let last = "a";
    for (let i = 0; i < 20; i++) {
      const result = pickForMe(collection, { now: NOW, random, exclude: ["b", last] });
      assert.ok(result);
      assert.notEqual(result.polish.id, last);
      last = result.polish.id;
    }
  });
});

describe("pushPickHistory", () => {
  it("keeps the last PICK_HISTORY_SIZE unique ids, most recent last", () => {
    let history: string[] = [];
    for (const id of ["a", "b", "c", "d", "c"]) history = pushPickHistory(history, id);
    assert.deepEqual(history, ["b", "d", "c"]);
  });
});

describe("suggestPairings", () => {
  const pick = polish("pick", { vendorHex: "#1F4E9C" }); // blue
  const complementHex = generateHarmonyPalette("#1F4E9C", "complementary")[1];
  const analogousHex = generateHarmonyPalette("#1F4E9C", "analogous")[2];

  it("suggests the complementary and analogous owned polishes plus a topper, at most 2", () => {
    const collection = [
      pick,
      polish("complement", { vendorHex: complementHex }),
      polish("analogous", { vendorHex: analogousHex }),
      polish("glitter", { vendorHex: "#DDDDDD", finishes: ["glitter"], wearCount: 1 }),
      polish("topper", { vendorHex: "#EEEEEE", finishes: ["topper"], wearCount: 4 }),
      polish("far", { vendorHex: "#1F4E9D", status: "wishlist" }),
    ];
    const pairs = suggestPairings(pick, collection);
    assert.equal(pairs.length, 2);
    assert.ok(["complement", "analogous"].includes(pairs[0].polish.id));
    assert.equal(pairs[1].polish.id, "topper", "a `topper` finish beats glitter");
    assert.equal(pairs[1].role, "topper");
    assert.equal(pairs[0].role, "accent");

    const three = suggestPairings(pick, collection, 3);
    assert.deepEqual(new Set(three.map((p) => p.harmony)), new Set(["complementary", "analogous", "topper"]));
    const complement = three.find((p) => p.harmony === "complementary")!;
    assert.equal(complement.polish.id, "complement");
    assert.ok((complement.distance ?? 1) < 0.02);
  });

  it("returns nothing when no owned polish is close enough and there are no toppers", () => {
    const collection = [pick, polish("nearly-same", { vendorHex: "#1F4E9D" })];
    assert.deepEqual(suggestPairings(pick, collection), []);
    assert.deepEqual(suggestPairings(pick, [pick]), []);
  });

  it("skips hue harmonies for neutral picks and topper suggestions for topper picks", () => {
    const gray = polish("gray", { vendorHex: "#808080" });
    const red = polish("red", { vendorHex: "#C0392B" });
    const topper = polish("topper", { vendorHex: "#EEEEEE", finishes: ["topper"] });
    assert.deepEqual(
      suggestPairings(gray, [gray, red, topper]).map((p) => p.harmony),
      ["topper"]
    );
    const topperPick = polish("tp", { vendorHex: "#C0392B", finishes: ["topper"] });
    assert.ok(suggestPairings(topperPick, [topperPick, topper]).every((p) => p.harmony !== "topper"));
    assert.ok(colorDistance("#808080", "#808080") === 0);
  });
});
