/**
 * sRGB gamut mapping for OKLCH colors. `oklabToRgb` clips channels, which shifts hue (a dark
 * yellow clips toward orange); `clampOklchToSrgb` instead lowers chroma at the same L and h.
 */
import type { OKLab } from "./oklab";

/** Linear-light sRGB of an OKLCH color, unclipped (in gamut when every channel is in [0, 1]). */
function oklchToLinearRgb(L: number, C: number, h: number): [number, number, number] {
  const hRad = (h * Math.PI) / 180;
  const a = C * Math.cos(hRad);
  const b = C * Math.sin(hRad);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

// Slack so a color sitting exactly on the gamut edge is not rejected for float noise.
const EPS = 1e-4;

/** True when the OKLCH color is inside the sRGB gamut. */
export function isOklchInSrgb(L: number, C: number, h: number): boolean {
  return oklchToLinearRgb(L, C, h).every((v) => v >= -EPS && v <= 1 + EPS);
}

/**
 * Largest chroma `<= C` at which `(L, C, h)` is inside sRGB (binary search), keeping L and h.
 * Returns `C` unchanged when it is already in gamut; L outside (0, 1) gives chroma 0.
 */
export function clampChromaToSrgb(L: number, C: number, h: number): number {
  if (!(C > 0)) return 0;
  if (L <= 0 || L >= 1) return 0;
  if (isOklchInSrgb(L, C, h)) return C;
  let lo = 0;
  let hi = C;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (isOklchInSrgb(L, mid, h)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** OKLAB of an OKLCH color after clamping its chroma into the sRGB gamut (L and hue kept). */
export function clampOklchToSrgb(L: number, C: number, h: number): OKLab {
  const c = clampChromaToSrgb(L, C, h);
  const hRad = (h * Math.PI) / 180;
  return { L, a: c * Math.cos(hRad), b: c * Math.sin(hRad) };
}
