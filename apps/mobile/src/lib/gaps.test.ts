import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HUE_FAMILY_ORDER, LIGHTNESS_BAND_ORDER, type Polish } from "swatchwatch-shared";
import { buildGapsModel, ownedColorHexes, GAPS_MIN_OWNED, NEXT_BUYS_LIMIT } from "./gaps";

function polish(id: string, extra: Partial<Polish> = {}): Polish {
  return { id, shadeId: id, userId: "1", brand: "B", name: `P${id}`, status: "owned", createdAt: "", updatedAt: "", ...extra } as Polish;
}

describe("ownedColorHexes", () => {
  it("keeps distinct owned color hexes only", () => {
    const hexes = ownedColorHexes([
      polish("a", { vendorHex: "#c0392b" }),
      polish("dupe", { vendorHex: "#C0392B" }),
      polish("topper", { vendorHex: "#00AA00", productCategory: "topper" }),
      polish("wish", { vendorHex: "#0000FF", status: "wishlist" }),
      polish("bad", { vendorHex: "nope" }),
      polish("none"),
    ]);
    assert.deepEqual(hexes, ["#C0392B"]);
  });
});

describe("buildGapsModel", () => {
  it("builds a dark → light grid of 5 rows × 8 hue cells", () => {
    const model = buildGapsModel(["#C0392B", "#008B8B", "#FFFFFF"]);
    assert.equal(model.rows.length, LIGHTNESS_BAND_ORDER.length);
    assert.ok(model.rows.every((row) => row.cells.length === HUE_FAMILY_ORDER.length));
    assert.equal(model.hexCount, 3);
    assert.equal(model.rows.flatMap((r) => r.cells).reduce((s, c) => s + c.count, 0), 3);
    assert.equal(model.missingCount + model.thinCount + model.rows.flatMap((r) => r.cells).filter((c) => c.severity === "healthy").length, 40);
  });

  it("lists next buys (missing first) with By color links", () => {
    const model = buildGapsModel(["#C0392B", "#008B8B", "#FFFFFF", "#000000", "#00AA00"]);
    assert.equal(model.nextBuys.length, NEXT_BUYS_LIMIT);
    for (const buy of model.nextBuys) {
      assert.equal(buy.severity, "missing");
      assert.equal(buy.searchHref.pathname, "/search");
      assert.match(buy.searchHref.params.hex, /^[0-9A-F]{6}$/);
      assert.equal(`#${buy.searchHref.params.hex}`, buy.seedHex);
    }
  });

  it("marks thin cells and scales healthy tint with density", () => {
    const hexes = [...Array.from({ length: 30 }, () => "#C0392B"), "#008B8B"];
    const model = buildGapsModel(hexes);
    const cells = model.rows.flatMap((r) => r.cells);
    const full = cells.find((c) => c.count === 30)!;
    const thin = cells.find((c) => c.count === 1)!;
    assert.equal(full.severity, "healthy");
    assert.equal(thin.severity, "thin");
    assert.ok(full.tintOpacity > thin.tintOpacity);
    assert.ok(cells.find((c) => c.severity === "missing")!.tintOpacity < thin.tintOpacity);
  });

  it("has an empty-collection threshold constant", () => {
    assert.equal(GAPS_MIN_OWNED, 5);
  });
});
