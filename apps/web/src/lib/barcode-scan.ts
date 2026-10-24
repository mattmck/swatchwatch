/**
 * On-device retail barcode scanning for Rapid Add.
 *
 * Two engines sit behind one `BarcodeScanner` interface:
 * - `native`: the browser's `BarcodeDetector` (Chrome/Edge on Android, Safari 17+ behind
 *   the Shape Detection API), used when it supports at least one retail format.
 * - `zxing`: a pure-JS fallback (`@zxing/library`), loaded with a dynamic `import()` so it
 *   stays out of the main bundle and is only fetched by browsers that need it.
 *
 * Everything above `createBarcodeScanner` is DOM-free so it can be unit tested in Node.
 */
import { rgbaToLuminance } from "./camera";

export type RetailBarcodeFormat = "ean_13" | "ean_8" | "upc_a" | "upc_e";

/** Formats printed on nail polish packaging (and the only ones the capture API resolves). */
export const RETAIL_BARCODE_FORMATS: readonly RetailBarcodeFormat[] = [
  "ean_13",
  "upc_a",
  "ean_8",
  "upc_e",
];

export type BarcodeEngine = "native" | "zxing";

/** A raw decoder result, before validation (`format` may be any vendor spelling). */
export interface RawBarcodeResult {
  rawValue: string;
  format: string;
}

export interface NormalizedBarcode {
  gtin: string;
  format: RetailBarcodeFormat;
}

export interface ScannedBarcode extends NormalizedBarcode {
  engine: BarcodeEngine;
}

/**
 * Map decoder format names onto ours: `BarcodeDetector` reports `ean_13`, zxing reports
 * `EAN_13`, and Azure OCR reports `EAN13`. Returns null for non-retail formats.
 */
export function normalizeBarcodeFormat(format: string): RetailBarcodeFormat | null {
  const key = format.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  switch (key) {
    case "ean13":
      return "ean_13";
    case "ean8":
      return "ean_8";
    case "upca":
      return "upc_a";
    case "upce":
      return "upc_e";
    default:
      return null;
  }
}

/** GS1 mod-10 check digit validation for GTIN-8/12/13/14. */
export function hasValidGtinCheckDigit(digits: string): boolean {
  if (!/^\d+$/.test(digits) || ![8, 12, 13, 14].includes(digits.length)) {
    return false;
  }
  const body = digits.slice(0, -1);
  let sum = 0;
  for (let i = 0; i < body.length; i += 1) {
    // Weights alternate 3,1,3,… starting from the digit next to the check digit.
    const digit = body.charCodeAt(body.length - 1 - i) - 48;
    sum += i % 2 === 0 ? digit * 3 : digit;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === digits.charCodeAt(digits.length - 1) - 48;
}

/** Expand an 8-digit UPC-E (number system + 6 digits + check) to its 12-digit UPC-A. */
export function expandUpcE(upcE: string): string | null {
  if (!/^\d{8}$/.test(upcE)) return null;
  const numberSystem = upcE[0];
  if (numberSystem !== "0" && numberSystem !== "1") return null;
  const d = upcE.slice(1, 7);
  const check = upcE[7];
  const last = d[5];
  let body: string;
  if (last === "0" || last === "1" || last === "2") {
    body = `${d[0]}${d[1]}${last}0000${d[2]}${d[3]}${d[4]}`;
  } else if (last === "3") {
    body = `${d[0]}${d[1]}${d[2]}00000${d[3]}${d[4]}`;
  } else if (last === "4") {
    body = `${d[0]}${d[1]}${d[2]}${d[3]}00000${d[4]}`;
  } else {
    body = `${d[0]}${d[1]}${d[2]}${d[3]}${d[4]}0000${last}`;
  }
  return `${numberSystem}${body}${check}`;
}

/**
 * Validate a decoder result. Returns the digits exactly as printed (no zero-padding), so
 * the capture API sees the same value its own OCR barcode path would extract.
 */
export function normalizeScannedBarcode(raw: RawBarcodeResult): NormalizedBarcode | null {
  const format = normalizeBarcodeFormat(raw.format);
  if (!format) return null;
  const gtin = raw.rawValue.trim();
  if (!/^\d+$/.test(gtin)) return null;

  switch (format) {
    case "ean_13":
      return gtin.length === 13 && hasValidGtinCheckDigit(gtin) ? { gtin, format } : null;
    case "upc_a":
      return gtin.length === 12 && hasValidGtinCheckDigit(gtin) ? { gtin, format } : null;
    case "ean_8":
      return gtin.length === 8 && hasValidGtinCheckDigit(gtin) ? { gtin, format } : null;
    case "upc_e": {
      if (gtin.length !== 8) return null;
      const expanded = expandUpcE(gtin);
      return expanded && hasValidGtinCheckDigit(expanded) ? { gtin, format } : null;
    }
  }
}

const FORMAT_PREFERENCE: Record<RetailBarcodeFormat, number> = {
  ean_13: 0,
  upc_a: 1,
  ean_8: 2,
  upc_e: 3,
};

/**
 * Pick the most useful valid barcode from one frame's results. Mirrors the capture API's
 * OCR preference (EAN-13, then UPC-A, EAN-8, UPC-E) so both paths agree on multi-code boxes.
 */
export function pickBestBarcode(results: readonly RawBarcodeResult[]): NormalizedBarcode | null {
  let best: NormalizedBarcode | null = null;
  for (const result of results) {
    const normalized = normalizeScannedBarcode(result);
    if (!normalized) continue;
    if (!best || FORMAT_PREFERENCE[normalized.format] < FORMAT_PREFERENCE[best.format]) {
      best = normalized;
    }
  }
  return best;
}

export interface BarcodeEnvironment {
  /** `typeof BarcodeDetector === "function"` */
  hasNativeDetector: boolean;
  /**
   * `await BarcodeDetector.getSupportedFormats()`, or null when it is missing or threw.
   * Some desktop builds expose the constructor but report no formats.
   */
  nativeFormats: readonly string[] | null;
}

/** Retail formats the native detector can read (in our preference order). */
export function supportedNativeRetailFormats(
  nativeFormats: readonly string[] | null,
): RetailBarcodeFormat[] {
  if (!nativeFormats) return [];
  const supported = new Set(
    nativeFormats
      .map((format) => normalizeBarcodeFormat(format))
      .filter((format): format is RetailBarcodeFormat => format !== null),
  );
  return RETAIL_BARCODE_FORMATS.filter((format) => supported.has(format));
}

/**
 * Prefer the native detector only when it can read EAN-13 or UPC-A (the codes on almost
 * every bottle); otherwise fall back to zxing, which reads all four retail formats.
 */
export function selectBarcodeEngine(env: BarcodeEnvironment): BarcodeEngine {
  if (!env.hasNativeDetector) return "zxing";
  const formats = supportedNativeRetailFormats(env.nativeFormats);
  return formats.includes("ean_13") || formats.includes("upc_a") ? "native" : "zxing";
}

// ---------------------------------------------------------------------------
// Browser-only below this line.
// ---------------------------------------------------------------------------

/** Anything a frame can be read from: a live `<video>`, a canvas, or a decoded bitmap. */
export type BarcodeSource = HTMLVideoElement | HTMLCanvasElement | ImageBitmap;

/** The live scan keeps running after a read; the same code is reported again at most this often. */
export const LIVE_BARCODE_REPEAT_MS = 2500;
/** After any read, pause the live scan this long so one bottle isn't read twice in a row. */
export const LIVE_BARCODE_COOLDOWN_MS = 1200;

/** Whether a live read should be reported, given the last one reported (`null` = none yet). */
export function shouldReportLiveBarcode(
  last: { gtin: string; at: number } | null,
  gtin: string,
  now: number,
): boolean {
  if (!last) return true;
  if (last.gtin !== gtin) return now - last.at >= LIVE_BARCODE_COOLDOWN_MS;
  return now - last.at >= LIVE_BARCODE_REPEAT_MS;
}

export interface BarcodeScanner {
  engine: BarcodeEngine;
  /** Resolve the best retail barcode in `source`, or null when none is readable. */
  detect(source: BarcodeSource, options?: { thorough?: boolean }): Promise<ScannedBarcode | null>;
}

interface NativeBarcodeDetector {
  detect(source: BarcodeSource): Promise<Array<{ rawValue: string; format: string }>>;
}

interface NativeBarcodeDetectorConstructor {
  new (options?: { formats?: string[] }): NativeBarcodeDetector;
  getSupportedFormats?: () => Promise<string[]>;
}

function getNativeDetectorConstructor(): NativeBarcodeDetectorConstructor | null {
  const candidate = (globalThis as { BarcodeDetector?: unknown }).BarcodeDetector;
  return typeof candidate === "function" ? (candidate as NativeBarcodeDetectorConstructor) : null;
}

export async function probeBarcodeEnvironment(): Promise<BarcodeEnvironment> {
  const Detector = getNativeDetectorConstructor();
  if (!Detector) return { hasNativeDetector: false, nativeFormats: null };
  try {
    const formats = (await Detector.getSupportedFormats?.()) ?? null;
    return { hasNativeDetector: true, nativeFormats: formats };
  } catch {
    return { hasNativeDetector: true, nativeFormats: null };
  }
}

function sourceSize(source: BarcodeSource): { width: number; height: number } {
  if (typeof HTMLVideoElement !== "undefined" && source instanceof HTMLVideoElement) {
    return { width: source.videoWidth, height: source.videoHeight };
  }
  return { width: source.width, height: source.height };
}

/** Longest edge zxing decodes at: live frames stay fast, stills get more pixels. */
const ZXING_LIVE_MAX_EDGE = 960;
const ZXING_THOROUGH_MAX_EDGE = 1600;

async function createZxingScanner(): Promise<BarcodeScanner> {
  // Lazy chunk: only browsers without a usable BarcodeDetector download zxing.
  const { createZxingDecoder } = await import("./barcode-zxing");
  const fastDecoder = createZxingDecoder({ tryHarder: false });
  const thoroughDecoder = createZxingDecoder({ tryHarder: true });
  const canvas = document.createElement("canvas");

  return {
    engine: "zxing",
    async detect(source, options) {
      const { width, height } = sourceSize(source);
      if (!width || !height) return null;
      const maxEdge = options?.thorough ? ZXING_THOROUGH_MAX_EDGE : ZXING_LIVE_MAX_EDGE;
      const scale = Math.min(1, maxEdge / Math.max(width, height));
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return null;
      ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const luminance = rgbaToLuminance(data, canvas.width, canvas.height);
      const decoder = options?.thorough ? thoroughDecoder : fastDecoder;
      const raw = decoder.decode(luminance, canvas.width, canvas.height);
      const best = raw ? pickBestBarcode([raw]) : null;
      return best ? { ...best, engine: "zxing" } : null;
    },
  };
}

function createNativeScanner(
  Detector: NativeBarcodeDetectorConstructor,
  formats: RetailBarcodeFormat[],
): BarcodeScanner {
  const detector = new Detector({ formats });
  return {
    engine: "native",
    async detect(source) {
      const { width, height } = sourceSize(source);
      if (!width || !height) return null;
      const results = await detector.detect(source);
      const best = pickBestBarcode(results);
      return best ? { ...best, engine: "native" } : null;
    },
  };
}

/** Build the best available scanner for this browser. */
export async function createBarcodeScanner(): Promise<BarcodeScanner> {
  const env = await probeBarcodeEnvironment();
  const Detector = getNativeDetectorConstructor();
  if (selectBarcodeEngine(env) === "native" && Detector) {
    try {
      return createNativeScanner(Detector, supportedNativeRetailFormats(env.nativeFormats));
    } catch {
      // Constructor rejected the formats; fall through to zxing.
    }
  }
  return createZxingScanner();
}
