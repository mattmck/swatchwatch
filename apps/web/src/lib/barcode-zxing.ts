/**
 * zxing fallback decoder for browsers without a usable `BarcodeDetector`.
 *
 * Only imported dynamically from `barcode-scan.ts`, so `@zxing/library` lands in its own
 * chunk. Decodes 1D retail codes (EAN-13/8, UPC-A/E) from a luminance buffer; no DOM use,
 * which keeps it testable in Node.
 */
import {
  BarcodeFormat,
  BinaryBitmap,
  DecodeHintType,
  HybridBinarizer,
  MultiFormatReader,
  RGBLuminanceSource,
} from "@zxing/library";
import type { RawBarcodeResult } from "./barcode-scan";

const ZXING_RETAIL_FORMATS = [
  BarcodeFormat.EAN_13,
  BarcodeFormat.UPC_A,
  BarcodeFormat.EAN_8,
  BarcodeFormat.UPC_E,
];

export interface ZxingDecoder {
  decode(luminance: Uint8ClampedArray, width: number, height: number): RawBarcodeResult | null;
}

/**
 * Rotate a luminance buffer 90° clockwise (the result is `height` wide, `width` tall).
 * zxing's `RGBLuminanceSource` can't rotate, so its own TRY_HARDER rotation never runs.
 */
export function rotateLuminance90(
  luminance: Uint8ClampedArray,
  width: number,
  height: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    const column = height - 1 - y;
    for (let x = 0; x < width; x += 1) {
      out[x * height + column] = luminance[row + x];
    }
  }
  return out;
}

export function createZxingDecoder(options: { tryHarder: boolean }): ZxingDecoder {
  const hints = new Map<DecodeHintType, unknown>();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, ZXING_RETAIL_FORMATS);
  if (options.tryHarder) {
    hints.set(DecodeHintType.TRY_HARDER, true);
  }
  const reader = new MultiFormatReader();
  reader.setHints(hints);

  function decodeOnce(
    luminance: Uint8ClampedArray,
    width: number,
    height: number,
  ): RawBarcodeResult | null {
    try {
      const source = new RGBLuminanceSource(luminance, width, height);
      const bitmap = new BinaryBitmap(new HybridBinarizer(source));
      const result = reader.decodeWithState(bitmap);
      return {
        rawValue: result.getText(),
        format: BarcodeFormat[result.getBarcodeFormat()] ?? "",
      };
    } catch {
      // NotFound/Checksum/Format exceptions all mean "no readable code in this frame".
      return null;
    } finally {
      reader.reset();
    }
  }

  return {
    decode(luminance, width, height) {
      // 1D readers only scan rows, so also try the frame turned 90° for codes printed
      // down a bottle's label (bars horizontal in a portrait camera frame).
      return (
        decodeOnce(luminance, width, height) ??
        decodeOnce(rotateLuminance90(luminance, width, height), height, width)
      );
    },
  };
}
