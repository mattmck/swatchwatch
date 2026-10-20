/**
 * Helpers shared by the design-token scripts: read the web theme's CSS custom properties
 * (apps/web/src/app/globals.css) and convert their `oklch(...)` values to sRGB hex, the
 * format React Native understands.
 */
import { readFileSync } from "node:fs";

/** CSS variables mirrored into `packages/shared/src/constants/design-tokens.ts`. */
export const TOKEN_VARS = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "border",
  "input",
  "ring",
];

export const BRAND_VARS = [
  "brand-pink",
  "brand-pink-light",
  "brand-pink-soft",
  "brand-purple",
  "brand-purple-deep",
  "brand-lilac",
  "brand-ink",
];

function block(css, selector) {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`No ${selector} block in globals.css`);
  return css.slice(start, css.indexOf("}", start));
}

function readVars(text) {
  const vars = {};
  for (const match of text.matchAll(/--([a-z0-9-]+):\s*(oklch\([^)]*\))\s*;/g)) {
    vars[match[1]] = match[2];
  }
  return vars;
}

export function readWebTheme(cssPath) {
  const css = readFileSync(cssPath, "utf8");
  return { light: readVars(block(css, ":root")), dark: readVars(block(css, ".dark")) };
}

/** `oklch(L C H [/ A%])` → `#rrggbb` or `#rrggbbaa`. */
export function oklchToHex(value) {
  const match = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)(%?))?\s*\)$/.exec(value.trim());
  if (!match) throw new Error(`Unsupported color: ${value}`);
  const [, lRaw, cRaw, hRaw, aRaw, aPct] = match;
  const L = Number(lRaw);
  const C = Number(cRaw);
  const h = (Number(hRaw) * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const toByte = (x) => {
    const clamped = Math.min(1, Math.max(0, x));
    const srgb = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
    return Math.round(srgb * 255).toString(16).padStart(2, "0");
  };
  let hex = `#${linear.map(toByte).join("")}`;
  if (aRaw !== undefined) {
    const alpha = aPct ? Number(aRaw) / 100 : Number(aRaw);
    if (alpha < 1) hex += Math.round(alpha * 255).toString(16).padStart(2, "0");
  }
  return hex;
}

function camel(name) {
  return name.replace(/-([a-z0-9])/g, (_, ch) => ch.toUpperCase());
}

/** The token object the shared constants file must contain. */
export function buildTokens(theme) {
  const pick = (vars, names) =>
    Object.fromEntries(
      names.map((name) => {
        if (!vars[name]) throw new Error(`Missing --${name} in globals.css`);
        return [camel(name), oklchToHex(vars[name])];
      }),
    );
  return {
    brand: Object.fromEntries(
      Object.entries(pick(theme.light, BRAND_VARS)).map(([k, v]) => [camel(k.replace(/^brand/, "").replace(/^./, (c) => c.toLowerCase())), v]),
    ),
    light: pick(theme.light, TOKEN_VARS),
    dark: pick(theme.dark, TOKEN_VARS),
  };
}
