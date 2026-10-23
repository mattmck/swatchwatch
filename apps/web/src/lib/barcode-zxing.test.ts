import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createZxingDecoder } from "./barcode-zxing";
import { pickBestBarcode } from "./barcode-scan";

// Minimal EAN-13 renderer so the fallback decoder is exercised on a real symbol.
const L = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
const G = ["0100111", "0110011", "0011011", "0100001", "0011101", "0111001", "0000101", "0010001", "0001001", "0010111"];
const R = ["1110010", "1100110", "1101100", "1000010", "1011100", "1001110", "1010000", "1000100", "1001000", "1110100"];
const PARITY = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLG", "LGLGGL", "LGGLGL", "LGLGLL"];

function ean13Modules(code: string): string {
  const digits = code.split("").map(Number);
  const parity = PARITY[digits[0]];
  let modules = "101";
  for (let i = 1; i <= 6; i += 1) {
    modules += (parity[i - 1] === "L" ? L : G)[digits[i]];
  }
  modules += "01010";
  for (let i = 7; i <= 12; i += 1) {
    modules += R[digits[i]];
  }
  return `${modules}101`;
}

function renderEan13(code: string, moduleWidth = 3, height = 40) {
  const quiet = "0".repeat(12);
  const modules = `${quiet}${ean13Modules(code)}${quiet}`;
  const width = modules.length * moduleWidth;
  const luminance = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      luminance[y * width + x] = modules[Math.floor(x / moduleWidth)] === "1" ? 0 : 255;
    }
  }
  return { luminance, width, height };
}

describe("createZxingDecoder", () => {
  it("decodes an EAN-13 symbol", () => {
    const { luminance, width, height } = renderEan13("4006381333931");
    const raw = createZxingDecoder({ tryHarder: false }).decode(luminance, width, height);
    assert.ok(raw);
    assert.deepEqual(pickBestBarcode([raw]), { gtin: "4006381333931", format: "ean_13" });
  });

  it("reports a leading-zero EAN-13 as UPC-A, like BarcodeDetector", () => {
    const { luminance, width, height } = renderEan13("0036000291452");
    const raw = createZxingDecoder({ tryHarder: true }).decode(luminance, width, height);
    assert.deepEqual(raw && pickBestBarcode([raw]), { gtin: "036000291452", format: "upc_a" });
  });

  it("returns null when the frame has no barcode", () => {
    const width = 120;
    const height = 40;
    const blank = new Uint8ClampedArray(width * height).fill(200);
    assert.equal(createZxingDecoder({ tryHarder: true }).decode(blank, width, height), null);
  });

  it("can decode again after a miss (reader state is reset)", () => {
    const decoder = createZxingDecoder({ tryHarder: false });
    assert.equal(decoder.decode(new Uint8ClampedArray(100 * 20).fill(255), 100, 20), null);
    const { luminance, width, height } = renderEan13("4006381333931");
    assert.equal(decoder.decode(luminance, width, height)?.rawValue, "4006381333931");
  });

  it("decodes a symbol turned 90° (bottle held upright, code printed down the label)", () => {
    const { luminance, width, height } = renderEan13("4006381333931");
    // Rotate 90° counter-clockwise: the bars become horizontal rows.
    const rotated = new Uint8ClampedArray(width * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        rotated[(width - 1 - x) * height + y] = luminance[y * width + x];
      }
    }
    for (const tryHarder of [false, true]) {
      const raw = createZxingDecoder({ tryHarder }).decode(rotated, height, width);
      assert.equal(raw?.rawValue, "4006381333931", `tryHarder=${tryHarder}`);
    }
  });
});
