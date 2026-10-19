import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Polish } from "swatchwatch-shared";
import type { Look } from "./looks";
import { DEFAULT_VIBE } from "./looks";
import { MAX_SAVED_LOOKS, addSavedLook, parseSavedLooks, removeSavedLook, toSavedLook } from "./looks-saved";

const polish = { id: "12", brand: "Brand", name: "Nude", vendorHex: "#E8D5C4", status: "owned" } as Polish;

const look: Look = {
  templateId: "office-neutral",
  name: "Office Neutral",
  description: "",
  difficulty: "easy",
  minutes: 15,
  ownedSteps: 1,
  missingSteps: 1,
  steps: [
    { role: "base", label: "Base", targetHex: "#D8BFAA", hex: "#E8D5C4", polish, source: "owned", distance: 0.05, alternatives: [] },
    { role: "accent", label: "Accent nail", targetHex: "#A8846A", hex: "#A8846A", polish: null, source: "template", distance: null, alternatives: [] },
  ],
};

describe("toSavedLook", () => {
  it("keeps only what is needed to show and re-wear the look", () => {
    const saved = toSavedLook(look, DEFAULT_VIBE, new Date("2026-10-18T10:00:00Z"));
    assert.equal(saved.id, "office-neutral:12,-");
    assert.equal(saved.savedAt, "2026-10-18T10:00:00.000Z");
    assert.deepEqual(saved.steps, [
      { role: "base", label: "Base", hex: "#E8D5C4", source: "owned", shadeId: "12", brand: "Brand", name: "Nude" },
      { role: "accent", label: "Accent nail", hex: "#A8846A", source: "template" },
    ]);
  });
});

describe("saved look list", () => {
  it("adds newest first, dedupes by id and caps the list", () => {
    const saved = toSavedLook(look, DEFAULT_VIBE, new Date(0));
    let list = addSavedLook([], saved);
    list = addSavedLook(list, saved);
    assert.equal(list.length, 1);
    const many = Array.from({ length: MAX_SAVED_LOOKS + 5 }, (_, i) => ({ ...saved, id: `x${i}` }));
    const capped = many.reduce(addSavedLook, [] as ReturnType<typeof addSavedLook>);
    assert.equal(capped.length, MAX_SAVED_LOOKS);
    assert.equal(capped[0].id, `x${MAX_SAVED_LOOKS + 4}`);
    assert.deepEqual(removeSavedLook(list, saved.id), []);
  });

  it("parses stored JSON defensively", () => {
    const saved = toSavedLook(look, DEFAULT_VIBE, new Date(0));
    assert.deepEqual(parseSavedLooks(JSON.stringify([saved])), [saved]);
    assert.deepEqual(parseSavedLooks(null), []);
    assert.deepEqual(parseSavedLooks("not json"), []);
    assert.deepEqual(parseSavedLooks(JSON.stringify({ a: 1 })), []);
    assert.deepEqual(parseSavedLooks(JSON.stringify([{ id: 3 }, saved])), [saved]);
  });
});
