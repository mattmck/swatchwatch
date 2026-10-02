const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");

const { extractDominantColors } = require("../dist/lib/dominant-color");

// Build a PNG from a raw RGBA buffer.
function pngFromRgba(width, height, fill) {
  const buf = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = fill(x, y);
      const i = (y * width + x) * 4;
      buf[i] = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
      buf[i + 3] = a;
    }
  }
  return sharp(buf, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

describe("lib/dominant-color — extractDominantColors", () => {
  it("returns the single color of a solid image", async () => {
    const png = await pngFromRgba(32, 32, () => [255, 0, 0, 255]);
    const colors = await extractDominantColors(png);

    assert.equal(colors.length, 1);
    assert.equal(colors[0].hex, "#FF0000");
    assert.ok(colors[0].fraction > 0.99, `expected ~1.0, got ${colors[0].fraction}`);
  });

  it("returns two colors for a split image, each ~half", async () => {
    const png = await pngFromRgba(40, 40, (x) =>
      x < 20 ? [255, 0, 0, 255] : [0, 0, 255, 255]
    );
    const colors = await extractDominantColors(png, { maxColors: 5 });
    const hexes = colors.map((c) => c.hex);

    assert.ok(hexes.includes("#FF0000"), `missing red: ${hexes.join(",")}`);
    assert.ok(hexes.includes("#0000FF"), `missing blue: ${hexes.join(",")}`);
    for (const c of colors) {
      assert.ok(c.fraction > 0.3 && c.fraction < 0.7, `unexpected fraction ${c.fraction}`);
    }
  });

  it("orders colors by prominence (dominant first)", async () => {
    // 75% green, 25% black
    const png = await pngFromRgba(40, 40, (x) => (x < 30 ? [0, 200, 0, 255] : [0, 0, 0, 255]));
    const colors = await extractDominantColors(png);

    assert.ok(colors.length >= 2);
    assert.equal(colors[0].hex, "#00C800");
    assert.ok(colors[0].fraction > colors[1].fraction);
  });

  it("respects maxColors", async () => {
    // Distinct color per column → many buckets.
    const png = await pngFromRgba(30, 4, (x) => [x * 8, 255 - x * 8, (x * 4) % 256, 255]);
    const colors = await extractDominantColors(png, { maxColors: 3 });

    assert.ok(colors.length <= 3, `expected <= 3, got ${colors.length}`);
  });

  it("ignores transparent pixels and returns [] for a fully transparent image", async () => {
    const png = await pngFromRgba(16, 16, () => [255, 0, 0, 0]);
    const colors = await extractDominantColors(png);

    assert.deepEqual(colors, []);
  });

  it("emits uppercase #RRGGBB hex strings", async () => {
    const png = await pngFromRgba(16, 16, () => [171, 205, 239, 255]); // #ABCDEF
    const [color] = await extractDominantColors(png);

    assert.match(color.hex, /^#[0-9A-F]{6}$/);
  });
});
