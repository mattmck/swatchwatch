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

export function createZxingDecoder(options: { tryHarder: boolean }): ZxingDecoder {
  const hints = new Map<DecodeHintType, unknown>();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, ZXING_RETAIL_FORMATS);
  if (options.tryHarder) {
    hints.set(DecodeHintType.TRY_HARDER, true);
  }
  const reader = new MultiFormatReader();
  reader.setHints(hints);

  return {
    decode(luminance, width, height) {
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
    },
  };
}
