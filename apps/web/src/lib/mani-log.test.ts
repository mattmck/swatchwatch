import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Manicure, Polish } from "swatchwatch-shared";
import {
  addDays,
  buildCalendarStrip,
  buildManicureRequest,
  calendarStripRange,
  canLogPolish,
  defaultRoleFor,
  filterPickable,
  formatWornOn,
  manicureHexes,
  pickablePolishes,
  quickLogRequest,
  startOfWeek,
  toLocalIsoDate,
  validateManiForm,
  type ManiFormEntry,
} from "./mani-log";

function manicure(id: string, wornOn: string, polishes: Manicure["polishes"] = []): Manicure {
  return {
    id,
    wornOn,
    notes: null,
    photoImageId: null,
    photoUrl: null,
    polishes,
    createdAt: "2026-10-17T00:00:00.000Z",
    updatedAt: "2026-10-17T00:00:00.000Z",
  };
}

function mp(shadeId: string, role: Manicure["polishes"][number]["role"], hex: string, position = 0) {
  return { shadeId, inventoryItemId: null, role, position, brand: "B", name: `S${shadeId}`, vendorHex: hex };
}

function polish(id: string, extra: Partial<Polish> = {}): Polish {
  return {
    id,
    shadeId: id,
    userId: "1",
    brand: "Brand",
    name: `Shade ${id}`,
    color: "",
    createdAt: "",
    updatedAt: "",
    ...extra,
  } as Polish;
}

describe("date helpers", () => {
  it("formats local dates and does calendar arithmetic across month/year boundaries", () => {
    assert.equal(toLocalIsoDate(new Date(2026, 0, 5, 23, 30)), "2026-01-05");
    assert.equal(addDays("2026-10-31", 1), "2026-11-01");
    assert.equal(addDays("2026-01-01", -1), "2025-12-31");
    assert.equal(addDays("2026-03-28", 2), "2026-03-30", "no DST skips");
  });

  it("weeks start on Monday", () => {
    assert.equal(startOfWeek("2026-10-17"), "2026-10-12"); // Saturday
    assert.equal(startOfWeek("2026-10-12"), "2026-10-12"); // Monday
    assert.equal(startOfWeek("2026-10-18"), "2026-10-12"); // Sunday
  });

  it("the strip range covers whole weeks ending with the current one", () => {
    assert.deepEqual(calendarStripRange("2026-10-17", 6), { from: "2026-09-07", to: "2026-10-18" });
  });

  it("formatWornOn says Today / Yesterday, else a short date (year only when different)", () => {
    assert.equal(formatWornOn("2026-10-17", "2026-10-17"), "Today");
    assert.equal(formatWornOn("2026-10-16", "2026-10-17"), "Yesterday");
    assert.match(formatWornOn("2026-10-12", "2026-10-17"), /12/);
    assert.doesNotMatch(formatWornOn("2026-10-12", "2026-10-17"), /2026/);
    assert.match(formatWornOn("2025-12-31", "2026-10-17"), /2025/);
  });
});

describe("buildCalendarStrip", () => {
  it("lays out weeks oldest first, Monday to Sunday, with the day's manicures", () => {
    const weeks = buildCalendarStrip(
      [
        manicure("1", "2026-10-17", [mp("10", "base", "#111111"), mp("11", "color", "#FF0000", 1)]),
        manicure("2", "2026-10-17", [mp("11", "color", "#FF0000")]),
        manicure("3", "2026-09-07", [mp("12", "color", "#00FF00")]),
        manicure("4", "2026-08-01", [mp("12", "color", "#00FF00")]), // outside the strip
      ],
      "2026-10-17",
      6
    );
    assert.equal(weeks.length, 6);
    assert.ok(weeks.every((week) => week.length === 7));
    assert.equal(weeks[0][0].date, "2026-09-07");
    assert.deepEqual(weeks[0][0].hexes, ["#00FF00"]);
    const today = weeks[5][5];
    assert.equal(today.date, "2026-10-17");
    assert.equal(today.isToday, true);
    assert.equal(today.manicures.length, 2);
    assert.deepEqual(today.hexes, ["#FF0000", "#111111"], "deduped, color before base");
    assert.equal(weeks[5][6].isFuture, true);
    assert.equal(weeks.flat().reduce((n, day) => n + day.manicures.length, 0), 3);
  });
});

describe("manicureHexes", () => {
  it("orders color, accent, topper, other, base and skips polishes without a hex", () => {
    const m = manicure("1", "2026-10-17", [
      mp("1", "base", "#000001"),
      mp("2", "topper", "#000002", 1),
      mp("3", "accent", "#000003", 2),
      mp("4", "color", "#000004", 3),
      { ...mp("5", "color", "", 4), vendorHex: undefined },
    ]);
    assert.deepEqual(manicureHexes(m), ["#000004", "#000003", "#000002", "#000001"]);
  });
});

describe("form helpers", () => {
  const entry = (shadeId: string, role: ManiFormEntry["role"] = "color"): ManiFormEntry => ({
    shadeId,
    role,
    brand: "B",
    name: `S${shadeId}`,
  });

  it("validates date, polishes, duplicates and notes", () => {
    const ok = { wornOn: "2026-10-17", entries: [entry("1")], notes: "" };
    assert.equal(validateManiForm(ok, "2026-10-17"), null);
    assert.match(validateManiForm({ ...ok, wornOn: "" }, "2026-10-17")!, /date/);
    assert.equal(validateManiForm({ ...ok, wornOn: "2026-10-18" }, "2026-10-17"), null, "timezone slack");
    assert.match(validateManiForm({ ...ok, wornOn: "2026-10-19" }, "2026-10-17")!, /future/);
    assert.match(validateManiForm({ ...ok, entries: [] }, "2026-10-17")!, /at least one/);
    assert.match(validateManiForm({ ...ok, entries: [entry("1"), entry("1")] }, "2026-10-17")!, /twice/);
    assert.equal(validateManiForm({ ...ok, entries: [entry("1"), entry("1", "accent")] }, "2026-10-17"), null);
    assert.match(validateManiForm({ ...ok, notes: "x".repeat(2001) }, "2026-10-17")!, /2000/);
  });

  it("builds the API request in pick order, blank notes as null", () => {
    assert.deepEqual(
      buildManicureRequest({ wornOn: "2026-10-17", entries: [entry("2", "base"), entry("1")], notes: "  " }),
      {
        wornOn: "2026-10-17",
        notes: null,
        polishes: [
          { shadeId: "2", role: "base" },
          { shadeId: "1", role: "color" },
        ],
      }
    );
    assert.equal(buildManicureRequest({ wornOn: "2026-10-17", entries: [entry("1")], notes: " glossy " }).notes, "glossy");
  });

  it("toppers default to the topper role, everything else to color", () => {
    assert.equal(defaultRoleFor({ finishes: ["glitter", "topper"] }), "topper");
    assert.equal(defaultRoleFor({ finish: "creme" }), "color");
    assert.deepEqual(quickLogRequest({ id: "9", finishes: ["topper"] }, "2026-10-17"), {
      wornOn: "2026-10-17",
      polishes: [{ shadeId: "9", role: "topper" }],
    });
  });

  it("quickLogRequest adds companions in order, dropping duplicate shade/role pairs", () => {
    assert.deepEqual(
      quickLogRequest({ id: "1", finish: "creme" }, "2026-10-17", [
        { id: "2", role: "accent" },
        { id: "3", role: "topper" },
        { id: "2", role: "accent" },
        { id: "1", role: "color" },
      ]),
      {
        wornOn: "2026-10-17",
        polishes: [
          { shadeId: "1", role: "color" },
          { shadeId: "2", role: "accent" },
          { shadeId: "3", role: "topper" },
        ],
      }
    );
  });

  it("the picker offers owned and destash polishes, filtered on brand + name terms", () => {
    const polishes = [
      polish("1", { status: "owned", brand: "Holo Taco", name: "Rainbow Bridge" }),
      polish("2", { status: "wishlist", brand: "Holo Taco", name: "Wish" }),
      polish("3", { status: "destash", brand: "ILNP", name: "Mega" }),
      polish("4", { brand: "Catalog", name: "Only" }),
    ];
    const pickable = pickablePolishes(polishes);
    assert.deepEqual(pickable.map((p) => p.id), ["1", "3"]);
    assert.deepEqual(filterPickable(pickable, "holo bridge").map((p) => p.id), ["1"]);
    assert.deepEqual(filterPickable(pickable, "  ").map((p) => p.id), ["1", "3"]);
  });

  it("only polishes with an inventory row can be logged", () => {
    assert.equal(canLogPolish({ status: "owned" }), true);
    assert.equal(canLogPolish({ status: "archived" }), true);
    assert.equal(canLogPolish({ status: null }), false);
    assert.equal(canLogPolish({}), false);
  });
});
