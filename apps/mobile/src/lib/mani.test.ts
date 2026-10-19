import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Polish } from "swatchwatch-shared";
import { addEntry, buildManiRequest, cycleRole, defaultRoleFor, entryFromPolish, formatWornOn, isValidWornOn, removeEntry, shiftDate, validateManiForm, type ManiEntry } from "./mani";

const entry = (shadeId: string, role: ManiEntry["role"] = "color"): ManiEntry => ({ shadeId, role, brand: "B", name: `P${shadeId}` });

describe("entries", () => {
  it("adds, dedupes the same polish+role and removes", () => {
    let entries = addEntry([], entry("1"));
    entries = addEntry(entries, entry("1"));
    assert.equal(entries.length, 1);
    entries = addEntry(entries, entry("1", "topper"));
    assert.equal(entries.length, 2);
    assert.deepEqual(removeEntry(entries, 0).map((e) => e.role), ["topper"]);
  });

  it("caps at 20 polishes", () => {
    let entries: ManiEntry[] = [];
    for (let i = 0; i < 25; i += 1) entries = addEntry(entries, entry(String(i)));
    assert.equal(entries.length, 20);
  });

  it("cycles roles in order and skips a duplicate of the same polish", () => {
    let entries = [entry("1", "base")];
    entries = cycleRole(entries, 0);
    assert.equal(entries[0].role, "color");
    const two = [entry("1", "color"), entry("1", "accent")];
    assert.equal(cycleRole(two, 0)[0].role, "topper");
  });

  it("toppers default to the topper role", () => {
    assert.equal(defaultRoleFor({ finishes: ["glitter", "Topper"] }), "topper");
    assert.equal(entryFromPolish({ id: "9", brand: "B", name: "N", vendorHex: "#ff0000", finishes: ["creme"] } as Polish).role, "color");
  });
});

describe("dates", () => {
  it("validates real dates not in the future", () => {
    assert.equal(isValidWornOn("2026-10-18", "2026-10-18"), true);
    assert.equal(isValidWornOn("2026-10-19", "2026-10-18"), false);
    assert.equal(isValidWornOn("2026-02-30", "2026-10-18"), false);
    assert.equal(isValidWornOn("10/18/2026", "2026-10-18"), false);
  });

  it("shifts across month and year boundaries", () => {
    assert.equal(shiftDate("2026-03-01", -1), "2026-02-28");
    assert.equal(shiftDate("2026-12-31", 1), "2027-01-01");
    assert.equal(shiftDate("nope", 1), "nope");
  });

  it("formats today, yesterday and older days", () => {
    assert.equal(formatWornOn("2026-10-18", "2026-10-18"), "Today");
    assert.equal(formatWornOn("2026-10-17", "2026-10-18"), "Yesterday");
    assert.equal(formatWornOn("2026-10-10", "2026-10-18"), "Sat, Oct 10");
  });
});

describe("request", () => {
  it("validates and builds the create body", () => {
    const entries = [entry("1"), entry("2", "topper")];
    assert.equal(validateManiForm({ entries: [], wornOn: "2026-10-18", notes: "" }, "2026-10-18"), "Add at least one polish.");
    assert.ok(validateManiForm({ entries, wornOn: "2027-01-01", notes: "" }, "2026-10-18"));
    assert.equal(validateManiForm({ entries, wornOn: "2026-10-18", notes: "" }, "2026-10-18"), null);
    assert.deepEqual(buildManiRequest({ entries, wornOn: "2026-10-18", notes: "  gel  " }), {
      wornOn: "2026-10-18",
      notes: "gel",
      polishes: [
        { shadeId: "1", role: "color" },
        { shadeId: "2", role: "topper" },
      ],
    });
    assert.equal(buildManiRequest({ entries, wornOn: "2026-10-18", notes: " " }).notes, null);
  });
});
