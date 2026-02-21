import type {
  CollectionGapAnalysis,
  CollectionGapCell,
  HueFamily,
  LightnessBand,
} from "swatchwatch-shared";

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

/** OKLCH — cylindrical form of OKLAB (perceptually uniform hue) */
export interface OKLCH {
  L: number; // 0-1
  C: number; // chroma (0+)
  h: number; // hue in degrees (0-360), NaN for achromatic
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

// ── OKLCH (perceptually uniform hue rotation) ───────────────

export function oklabToOklch({ L, a, b }: OKLab): OKLCH {
  const C = Math.sqrt(a * a + b * b);
  const h = C < 1e-8 ? NaN : ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  return { L, C, h };
}

export function oklchToOklab({ L, C, h }: OKLCH): OKLab {
  const hRad = Number.isNaN(h) ? 0 : (h * Math.PI) / 180;
  return { L, a: C * Math.cos(hRad), b: C * Math.sin(hRad) };
}

function delinearize(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

export function oklabToRgb({ L, a, b }: OKLab): RGB {
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

function isRgbInGamut(rgb: RGB): boolean {
  return rgb.r >= 0 && rgb.r <= 255 && rgb.g >= 0 && rgb.g <= 255 && rgb.b >= 0 && rgb.b <= 255;
}

/** Reduce chroma until the OKLCH color fits within sRGB gamut. */
export function clampChromaToGamut(oklch: OKLCH): OKLCH {
  if (oklch.C < 1e-8) return { ...oklch, C: 0 };
  let lo = 0;
  let hi = oklch.C;
  let result = { ...oklch, C: 0 };
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    const candidate = { ...oklch, C: mid };
    const rgb = oklabToRgb(oklchToOklab(candidate));
    if (isRgbInGamut(rgb)) {
      result = candidate;
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return result;
}

export function oklchToHex(oklch: OKLCH): string {
  const clamped = clampChromaToGamut(oklch);
  return rgbToHex(oklabToRgb(oklchToOklab(clamped)));
}

export function hexToOklch(hex: string): OKLCH {
  return oklabToOklch(hexToOklab(hex));
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

export const HUE_FAMILY_ORDER: HueFamily[] = [
  "reds",
  "oranges-corals",
  "yellows-golds",
  "greens",
  "blues-teals",
  "purples-violets",
  "pinks-magentas",
  "neutrals",
];

export const LIGHTNESS_BAND_ORDER: LightnessBand[] = [
  "dark",
  "dark-medium",
  "medium",
  "medium-light",
  "light",
];

const GAP_HUE_SEED: Record<HueFamily, number> = {
  reds: 8,
  "oranges-corals": 26,
  "yellows-golds": 52,
  greens: 130,
  "blues-teals": 205,
  "purples-violets": 275,
  "pinks-magentas": 328,
  neutrals: 220,
};

const GAP_LIGHTNESS_SEED: Record<LightnessBand, number> = {
  dark: 0.24,
  "dark-medium": 0.38,
  medium: 0.52,
  "medium-light": 0.7,
  light: 0.86,
};

function classifyHueFamily(oklch: OKLCH): HueFamily {
  if (oklch.C < 0.04 || Number.isNaN(oklch.h)) return "neutrals";

  const hue = oklch.h;
  if (hue >= 350 || hue < 10) return "reds";
  if (hue >= 10 && hue < 40) return "oranges-corals";
  if (hue >= 40 && hue < 80) return "yellows-golds";
  if (hue >= 80 && hue < 170) return "greens";
  if (hue >= 170 && hue < 260) return "blues-teals";
  if (hue >= 260 && hue < 310) return "purples-violets";
  return "pinks-magentas";
}

function classifyLightnessBand(L: number): LightnessBand {
  if (L < 0.3) return "dark";
  if (L < 0.44) return "dark-medium";
  if (L < 0.6) return "medium";
  if (L < 0.76) return "medium-light";
  return "light";
}

export function classifyHexToGapCell(
  hex: string,
): { hueFamily: HueFamily; lightnessBand: LightnessBand } | null {
  if (!/^#[0-9A-Fa-f]{6}$/.test(hex)) return null;
  const oklch = hexToOklch(hex);
  return {
    hueFamily: classifyHueFamily(oklch),
    lightnessBand: classifyLightnessBand(oklch.L),
  };
}

export function gapCellToSeedHex(
  hueFamily: HueFamily,
  lightnessBand: LightnessBand,
): string {
  const hue = GAP_HUE_SEED[hueFamily];
  const lightness = GAP_LIGHTNESS_SEED[lightnessBand];
  const chroma = hueFamily === "neutrals" ? 0 : 0.09;
  return oklchToHex({ L: lightness, C: chroma, h: hue });
}

/**
 * Analyze hue/lightness coverage for owned colors and surface gaps.
 */
export function analyzeCollectionGaps(hexColors: string[]): CollectionGapAnalysis {
  const counts = new Map<string, number>();
  for (const hueFamily of HUE_FAMILY_ORDER) {
    for (const lightnessBand of LIGHTNESS_BAND_ORDER) {
      counts.set(`${hueFamily}:${lightnessBand}`, 0);
    }
  }

  for (const hex of hexColors) {
    if (!/^#[0-9A-Fa-f]{6}$/.test(hex)) continue;
    const oklch = hexToOklch(hex);
    const hueFamily = classifyHueFamily(oklch);
    const lightnessBand = classifyLightnessBand(oklch.L);
    const key = `${hueFamily}:${lightnessBand}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const cells: CollectionGapCell[] = [];
  for (const hueFamily of HUE_FAMILY_ORDER) {
    for (const lightnessBand of LIGHTNESS_BAND_ORDER) {
      cells.push({
        hueFamily,
        lightnessBand,
        count: counts.get(`${hueFamily}:${lightnessBand}`) ?? 0,
      });
    }
  }

  const missing = cells.filter((cell) => cell.count === 0);
  const avgPerCell = hexColors.length / Math.max(cells.length, 1);
  const lowThreshold = Math.max(1, Math.floor(avgPerCell * 0.5));
  const underrepresented = cells.filter(
    (cell) => cell.count > 0 && cell.count <= lowThreshold,
  );

  return { cells, missing, underrepresented };
}

// ── Complementary color ──────────────────────────────────────

/** Rotate hue by 180° in OKLCH for perceptually uniform complement */
export function complementaryHex(hex: string): string {
  const oklch = hexToOklch(hex);
  return oklchToHex({ ...oklch, h: Number.isNaN(oklch.h) ? oklch.h : (oklch.h + 180) % 360 });
}
