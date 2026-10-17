/**
 * OKLAB color math shared by the web app and Azure Functions so perceptual
 * color distances agree everywhere (e.g. /polishes/search on the client and
 * POST /api/polishes/match-image on the server).
 *
 * Pure and dependency-free. Euclidean OKLAB distance: black↔white ≈ 1.0 and
 * ~0.02 is roughly a just-noticeable difference.
 */

/** OKLAB color space coordinates (L: 0–1 lightness, a/b: chroma axes). */
export interface OKLab {
  L: number;
  a: number;
  b: number;
}

function linearize(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Convert 0–255 sRGB channels to OKLAB. */
export function rgbToOklab({ r, g, b }: { r: number; g: number; b: number }): OKLab {
  const lr = linearize(r / 255);
  const lg = linearize(g / 255);
  const lb = linearize(b / 255);

  const l_ = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m_ = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s_ = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);

  return {
    L: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  };
}

/** Convert a 6-digit hex color (`#RRGGBB` or `RRGGBB`) to OKLAB. */
export function hexToOklab(hex: string): OKLab {
  const cleaned = hex.replace("#", "");
  return rgbToOklab({
    r: parseInt(cleaned.substring(0, 2), 16),
    g: parseInt(cleaned.substring(2, 4), 16),
    b: parseInt(cleaned.substring(4, 6), 16),
  });
}

/** Perceptual distance between two OKLAB colors (lower = more similar). */
export function oklabDistance(a: OKLab, b: OKLab): number {
  return Math.sqrt((a.L - b.L) ** 2 + (a.a - b.a) ** 2 + (a.b - b.b) ** 2);
}

/** Perceptual distance between two hex colors using OKLAB. */
export function colorDistance(hex1: string, hex2: string): number {
  return oklabDistance(hexToOklab(hex1), hexToOklab(hex2));
}

function delinearize(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/**
 * Convert OKLAB back to 0–255 sRGB. Out-of-gamut values are clipped per channel
 * (the same behaviour as `oklabToRgb` in the web app's `color-utils.ts`).
 */
export function oklabToRgb({ L, a, b }: OKLab): { r: number; g: number; b: number } {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  const r = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bl = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;

  return {
    r: Math.round(Math.max(0, Math.min(1, delinearize(r))) * 255),
    g: Math.round(Math.max(0, Math.min(1, delinearize(g))) * 255),
    b: Math.round(Math.max(0, Math.min(1, delinearize(bl))) * 255),
  };
}

/** Convert 0–255 sRGB channels to an uppercase `#RRGGBB` string (channels are rounded and clamped). */
export function rgbToHexString({ r, g, b }: { r: number; g: number; b: number }): string {
  const toHex = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, "0")
      .toUpperCase();
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** Convert OKLAB to an uppercase `#RRGGBB` string (gamut-clipped). */
export function oklabToHex(oklab: OKLab): string {
  return rgbToHexString(oklabToRgb(oklab));
}
