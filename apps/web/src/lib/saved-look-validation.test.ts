import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_SAVED_LOOKS, savedLookKey, validateSavedLookInput } from "swatchwatch-shared";

const valid = {
  id: "office-neutral:12,-",
  templateId: "office-neutral",
  name: "Office Neutral",
  vibe: { occasion: "work", mood: "soft", finish: null, ownedOnly: false },
  steps: [
    { role: "base", label: "Base", hex: "#E8D5C4", source: "owned", shadeId: "12", brand: "Essie", name: "Ballet Slippers" },
    { role: "accent", label: "Accent nail", hex: "#a8846a", source: "template" },
  ],
};

describe("validateSavedLookInput", () => {
  it("accepts a well-formed look and normalizes it", () => {
    const result = validateSavedLookInput(valid);
    assert.ok(result.ok, result.ok ? "" : result.error);
    assert.equal(result.look.steps[1].hex, "#A8846A");
    assert.deepEqual(Object.keys(result.look.steps[1]).sort(), ["hex", "label", "role", "source"]);
  });

  it("drops unknown fields instead of storing them", () => {
    const result = validateSavedLookInput({ ...valid, userId: 7, steps: [{ ...valid.steps[0], extra: "x" }, valid.steps[1]] });
    assert.ok(result.ok);
    assert.ok(!("userId" in result.look));
    assert.ok(!("extra" in result.look.steps[0]));
  });

  it("rejects bad shapes with a reason", () => {
    const cases: unknown[] = [
      null,
      { ...valid, id: "" },
      { ...valid, templateId: "Office Neutral" },
      { ...valid, name: "x".repeat(81) },
      { ...valid, vibe: { ...valid.vibe, occasion: "brunch" } },
      { ...valid, steps: [] },
      { ...valid, steps: Array(5).fill(valid.steps[1]) },
      { ...valid, steps: [{ ...valid.steps[0], role: "base-coat" }] },
      { ...valid, steps: [{ ...valid.steps[0], hex: "red" }] },
      { ...valid, steps: [{ ...valid.steps[0], shadeId: "12abc" }] },
      { ...valid, steps: [{ ...valid.steps[0], source: "stolen" }] },
      { ...valid, steps: [{ ...valid.steps[0], name: "n".repeat(161) }] },
    ];
    for (const input of cases) {
      const result = validateSavedLookInput(input);
      assert.equal(result.ok, false, JSON.stringify(input)?.slice(0, 80));
      if (!result.ok) assert.ok(result.error.length > 0);
    }
  });

  it("requires the id to be the look key of its template and steps", () => {
    assert.equal(validateSavedLookInput({ ...valid, id: "office-neutral:99,-" }).ok, false);
    assert.equal(savedLookKey(valid.templateId, valid.steps), "office-neutral:12,-");
  });

  it("caps saved looks at 30", () => {
    assert.equal(MAX_SAVED_LOOKS, 30);
  });
});
