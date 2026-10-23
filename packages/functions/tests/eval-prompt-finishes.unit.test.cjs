/** #322 step 4: the eval prompts (palette-pick, region-crop) list finishes from the finish catalog. */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { buildPalettePickPayload } = require("../dist/lib/palette-pick-detection");
const { buildRegionLocatorPayload } = require("../dist/eval/hex/strategies/region-crop");
const { DEFAULT_FINISH_CATALOG, finishNamesForPrompt } = require("../dist/lib/finishes");

const candidates = [{ label: "A", hex: "#111111", fraction: 0.5 }];
const textOf = (payload) =>
  payload.messages.flatMap((m) => (typeof m.content === "string" ? [m.content] : m.content.filter((p) => p.type === "text").map((p) => p.text))).join("\n");

const customCatalog = {
  aliases: DEFAULT_FINISH_CATALOG.aliases,
  validNames: new Set([...DEFAULT_FINISH_CATALOG.validNames, "aurora-flux"]),
};

describe("eval prompt finish lists", () => {
  it("fall back to the built-in finishes without a catalog (no database needed)", () => {
    const list = finishNamesForPrompt().join(", ");
    assert.match(textOf(buildPalettePickPayload("data:x", candidates)), new RegExp(`\\(${list}\\)`));
    for (const mode of ["bbox", "cells"]) {
      const payload = buildRegionLocatorPayload("data:x", { mode, gridCells: mode === "cells" ? 6 : 0, detail: "low" });
      assert.ok(textOf(payload).includes(`(${list})`), mode);
    }
  });

  it("include a finish type created only in the admin UI", () => {
    assert.match(textOf(buildPalettePickPayload("data:x", candidates, false, undefined, customCatalog)), /aurora-flux/);
    const region = buildRegionLocatorPayload("data:x", { mode: "bbox", gridCells: 0, detail: "low", finishCatalog: customCatalog });
    assert.match(textOf(region), /aurora-flux/);
    assert.doesNotMatch(textOf(buildPalettePickPayload("data:x", candidates)), /aurora-flux/);
  });
});
