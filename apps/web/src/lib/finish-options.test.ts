import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildFinishOptions, knownFinishNames, resolveFinishLabel } from "./finish-options";

const refTypes = [
  { name: "creme", displayName: "Creme" },
  { name: "holographic", displayName: "Holographic" },
  // Added via the admin UI only: not a built-in finish.
  { name: "chrome", displayName: "Chrome Mirror" },
];

describe("buildFinishOptions", () => {
  it("includes finish types that are not built-in (admin-added)", () => {
    const options = buildFinishOptions(refTypes);
    assert.deepEqual(options.find((o) => o.value === "chrome"), { value: "chrome", label: "Chrome Mirror" });
    assert.equal(options.length, 3);
  });

  it("sorts options by label", () => {
    assert.deepEqual(
      buildFinishOptions(refTypes).map((o) => o.label),
      ["Chrome Mirror", "Creme", "Holographic"]
    );
  });

  it("falls back to the built-in finishes when reference data is empty or missing", () => {
    for (const empty of [[], null, undefined]) {
      const values = buildFinishOptions(empty).map((o) => o.value);
      assert.ok(values.includes("holographic"));
      assert.ok(values.includes("creme"));
      assert.ok(!values.includes("chrome"));
    }
  });

  it("keeps extra (saved) finishes that are missing from the reference list, without duplicates", () => {
    const options = buildFinishOptions(refTypes, ["velvet", "CHROME", "creme"]);
    assert.deepEqual(options.find((o) => o.value === "velvet"), { value: "velvet", label: "Velvet" });
    assert.equal(options.filter((o) => o.value.toLowerCase() === "chrome").length, 1);
    assert.equal(options.filter((o) => o.value === "creme").length, 1);
    assert.equal(options.length, 4);
  });
});

describe("knownFinishNames / resolveFinishLabel", () => {
  it("derives known finish names from reference rows", () => {
    assert.deepEqual(knownFinishNames(refTypes).sort(), ["chrome", "creme", "holographic"]);
  });

  it("prefers the reference displayName and falls back to a capitalized name", () => {
    assert.equal(resolveFinishLabel("chrome", refTypes), "Chrome Mirror");
    assert.equal(resolveFinishLabel("CHROME", refTypes), "Chrome Mirror");
    assert.equal(resolveFinishLabel("velvet", refTypes), "Velvet");
    assert.equal(resolveFinishLabel("holo"), "Holo");
    assert.equal(resolveFinishLabel("  "), "");
  });
});
