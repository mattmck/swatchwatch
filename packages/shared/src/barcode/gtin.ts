/**
 * Retail barcode (GTIN) validation shared by the clients' Rapid Add scanners. Same rules as
 * `apps/web/src/lib/barcode-scan.ts` (which predates this module and can switch to it): only
 * the formats printed on polish packaging, GS1 check digits, and the digits exactly as
 * printed, because the capture API looks barcodes up by exact `barcode.gtin`.
 */

export type RetailBarcodeFormat = "ean_13" | "ean_8" | "upc_a" | "upc_e";

/** Formats printed on nail polish packaging (and the only ones the capture API resolves). */
export const RETAIL_BARCODE_FORMATS: readonly RetailBarcodeFormat[] = ["ean_13", "upc_a", "ean_8", "upc_e"];

export interface NormalizedBarcode {
  gtin: string;
  format: RetailBarcodeFormat;
}

/**
 * Map decoder format names onto ours (`ean_13`, `EAN_13`, `EAN13`, `ean13` all → `ean_13`).
 * Returns null for non-retail formats.
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

/** Validate one decoder result; returns the digits as printed (no zero-padding) or null. */
export function normalizeScannedBarcode(raw: { rawValue: string; format: string }): NormalizedBarcode | null {
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
