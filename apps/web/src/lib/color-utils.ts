// ── Hex ↔ RGB ────────────────────────────────────────────────

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface HSL {
  h: number; // 0-360
  s: number; // 0-1
  l: number; // 0-1
}

/** OKLAB color space for perceptual distance */
export interface OKLab {
  L: number;
  a: number;
  b: number;
}

export function hexToRgb(hex: string): RGB {
  const cleaned = hex.replace("#", "");
  return {
    r: parseInt(cleaned.substring(0, 2), 16),
    g: parseInt(cleaned.substring(2, 4), 16),
    b: parseInt(cleaned.substring(4, 6), 16),
  };
}

export function rgbToHex({ r, g, b }: RGB): string {
  const toHex = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// ── HSL ↔ RGB ────────────────────────────────────────────────

export function hslToRgb({ h, s, l }: HSL): RGB {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;

  let r1 = 0,
    g1 = 0,
    b1 = 0;
  if (h < 60) [r1, g1, b1] = [c, x, 0];
  else if (h < 120) [r1, g1, b1] = [x, c, 0];
  else if (h < 180) [r1, g1, b1] = [0, c, x];
  else if (h < 240) [r1, g1, b1] = [0, x, c];
  else if (h < 300) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];

  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255),
  };
}

export function rgbToHsl({ r, g, b }: RGB): HSL {
  const r1 = r / 255;
  const g1 = g / 255;
  const b1 = b / 255;
  const max = Math.max(r1, g1, b1);
  const min = Math.min(r1, g1, b1);
  const d = max - min;
  const l = (max + min) / 2;

  if (d === 0) return { h: 0, s: 0, l };

  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r1) h = ((g1 - b1) / d + (g1 < b1 ? 6 : 0)) * 60;
  else if (max === g1) h = ((b1 - r1) / d + 2) * 60;
  else h = ((r1 - g1) / d + 4) * 60;

  return { h, s, l };
}

export function hslToHex(hsl: HSL): string {
  return rgbToHex(hslToRgb(hsl));
}

export function hexToHsl(hex: string): HSL {
  return rgbToHsl(hexToRgb(hex));
}

// ── OKLAB (perceptual color distance) ────────────────────────

function linearize(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function rgbToOklab({ r, g, b }: RGB): OKLab {
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

export function hexToOklab(hex: string): OKLab {
  return rgbToOklab(hexToRgb(hex));
}

/** Perceptual distance between two colors (lower = more similar) */
export function oklabDistance(a: OKLab, b: OKLab): number {
  return Math.sqrt(
    (a.L - b.L) ** 2 + (a.a - b.a) ** 2 + (a.b - b.b) ** 2
  );
}

/** Distance between two hex colors using OKLAB */
export function colorDistance(hex1: string, hex2: string): number {
  return oklabDistance(hexToOklab(hex1), hexToOklab(hex2));
}

// ── Undertone classification (warm / cool / neutral) ─────────

export type Undertone = "warm" | "cool" | "neutral";

/**
 * Compute a warmth score from an OKLAB color.
 * Positive = warm, negative = cool, near-zero = neutral.
 *
 * Uses the OKLAB `b` axis (blue↔yellow) as primary signal
 * and `a` axis (green↔red) as secondary warmth contributor.
 * Low-chroma colors (greys, whites, blacks) are classified neutral
 * regardless of hue lean.
 */
export function warmthScore(oklab: OKLab): number {
  // b > 0 = yellow lean (warm), b < 0 = blue lean (cool)
  // a > 0 = red lean (warm accent), a < 0 = green lean (cool accent)
  return oklab.b * 1.0 + oklab.a * 0.5;
}

/**
 * Classify a hex color as warm, cool, or neutral.
 *
 * Thresholds tuned against common nail polish colors:
 * - Chroma below 0.04 → neutral (greys, whites, blacks, taupes)
 * - Warmth score > 0.015 → warm
 * - Warmth score < -0.015 → cool
 * - Otherwise → neutral
 */
export function undertone(hex: string): Undertone {
  const lab = hexToOklab(hex);

  // Chroma = distance from the neutral axis in a-b plane
  const chroma = Math.sqrt(lab.a ** 2 + lab.b ** 2);
  if (chroma < 0.04) return "neutral";

  const score = warmthScore(lab);
  if (score > 0.015) return "warm";
  if (score < -0.015) return "cool";
  return "neutral";
}

/**
 * Analyze a collection of hex colors and return the undertone breakdown.
 */
export function undertoneBreakdown(hexColors: string[]): {
  warm: number;
  cool: number;
  neutral: number;
  dominant: Undertone;
} {
  const counts = { warm: 0, cool: 0, neutral: 0 };
  for (const hex of hexColors) {
    counts[undertone(hex)]++;
  }
  const dominant: Undertone =
    counts.warm >= counts.cool && counts.warm >= counts.neutral
      ? "warm"
      : counts.cool >= counts.neutral
        ? "cool"
        : "neutral";
  return { ...counts, dominant };
}

// ── Complementary color ──────────────────────────────────────

/** Rotate hue by 180° to get the complementary color */
export function complementaryHex(hex: string): string {
  const hsl = hexToHsl(hex);
  return hslToHex({ ...hsl, h: (hsl.h + 180) % 360 });
}
