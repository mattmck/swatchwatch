export const swatchWatchBrandPalette = {
  pink: "#ff4fb8",
  pinkLight: "#ffd7f0",
  pinkSoft: "#ffb3e3",
  purple: "#7b2eff",
  purpleDeep: "#42107e",
  lilac: "#c5a6ff",
  white: "#ffffff",
  ink: "#22123b",
} as const;

type CommonShapeProps = {
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  strokeLinecap?: "butt" | "round" | "square";
  strokeLinejoin?: "miter" | "round" | "bevel";
  opacity?: number;
  transform?: string;
};

export type BrandRectShape = CommonShapeProps & {
  kind: "rect";
  x: number;
  y: number;
  width: number;
  height: number;
  rx?: number;
};

export type BrandCircleShape = CommonShapeProps & {
  kind: "circle";
  cx: number;
  cy: number;
  r: number;
};

export type BrandPathShape = CommonShapeProps & {
  kind: "path";
  d: string;
};

export type BrandLineShape = CommonShapeProps & {
  kind: "line";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

export type BrandShape =
  | BrandRectShape
  | BrandCircleShape
  | BrandPathShape
  | BrandLineShape;

export interface BrandIconSpec {
  viewBox: string;
  shapes: readonly BrandShape[];
}

/* ═══════════════════════════════════════════════════════════════════════
 *  MONOGRAM — A single stylized polish drop
 *
 *  Inspired by: Glossier's compact "G" sticker mark, Cirque's restraint.
 *  Concept: One bold teardrop/polish-drop shape in brand pink, sitting
 *  inside a soft-cornered purple-deep rounded square. The drop has a
 *  small white highlight dot — clean, iconic, works at 16px.
 *  No letters. The shape IS the brand mark.
 * ═══════════════════════════════════════════════════════════════════════ */
const monogramSpec: BrandIconSpec = {
  viewBox: "0 0 128 128",
  shapes: [
    // Rounded square container
    {
      kind: "rect",
      x: 8,
      y: 8,
      width: 112,
      height: 112,
      rx: 32,
      fill: swatchWatchBrandPalette.purpleDeep,
    },
    // Main polish drop — centered, clean teardrop
    {
      kind: "path",
      d: "M64 24C64 24 36 56 36 76a28 28 0 0056 0c0-20-28-52-28-52z",
      fill: swatchWatchBrandPalette.pink,
    },
    // Highlight — small circle on upper-left of drop for dimension
    {
      kind: "circle",
      cx: 52,
      cy: 68,
      r: 6,
      fill: swatchWatchBrandPalette.white,
      opacity: 0.45,
    },
  ],
};

/* ═══════════════════════════════════════════════════════════════════════
 *  SWATCH — Three drops fanned out like a color palette
 *
 *  Concept: Three overlapping teardrop shapes rotated into a fan,
 *  lilac / pink / purple. No strokes. Clean fills with subtle overlap.
 *  Works as the "color collection" signifier throughout the app.
 * ═══════════════════════════════════════════════════════════════════════ */
const swatchSpec: BrandIconSpec = {
  viewBox: "0 0 64 64",
  shapes: [
    // Left drop — lilac, rotated left
    {
      kind: "path",
      d: "M26 16C26 16 14 34 14 44a12 12 0 0024 0c0-10-12-28-12-28z",
      fill: swatchWatchBrandPalette.lilac,
      transform: "rotate(-15 26 36)",
    },
    // Center drop — pink, straight
    {
      kind: "path",
      d: "M32 12C32 12 20 32 20 43a12 12 0 0024 0c0-11-12-31-12-31z",
      fill: swatchWatchBrandPalette.pink,
    },
    // Right drop — purple, rotated right
    {
      kind: "path",
      d: "M38 16C38 16 26 34 26 44a12 12 0 0024 0c0-10-12-28-12-28z",
      fill: swatchWatchBrandPalette.purple,
      transform: "rotate(15 38 36)",
    },
  ],
};

/* ═══════════════════════════════════════════════════════════════════════
 *  BRUSH — Minimal nail polish bottle
 *
 *  Inspired by: ILNP/Cirque product-as-hero approach.
 *  Concept: Clean geometric bottle silhouette — rounded body, square
 *  cap, thin neck. Three fills, zero strokes. Recognizable at any size.
 * ═══════════════════════════════════════════════════════════════════════ */
const brushSpec: BrandIconSpec = {
  viewBox: "0 0 64 64",
  shapes: [
    // Bottle body
    {
      kind: "rect",
      x: 17,
      y: 30,
      width: 30,
      height: 28,
      rx: 6,
      fill: swatchWatchBrandPalette.pink,
    },
    // Neck
    {
      kind: "rect",
      x: 27,
      y: 24,
      width: 10,
      height: 8,
      rx: 2,
      fill: swatchWatchBrandPalette.purpleDeep,
    },
    // Cap
    {
      kind: "rect",
      x: 24,
      y: 8,
      width: 16,
      height: 18,
      rx: 4,
      fill: swatchWatchBrandPalette.purple,
    },
    // Body highlight (subtle gloss)
    {
      kind: "rect",
      x: 20,
      y: 34,
      width: 4,
      height: 16,
      rx: 2,
      fill: swatchWatchBrandPalette.white,
      opacity: 0.3,
    },
    // Cap highlight
    {
      kind: "rect",
      x: 27,
      y: 11,
      width: 3,
      height: 11,
      rx: 1.5,
      fill: swatchWatchBrandPalette.lilac,
      opacity: 0.4,
    },
  ],
};

/* ═══════════════════════════════════════════════════════════════════════
 *  APP ICON — The monogram drop on a rich gradient-like squircle
 *
 *  Concept: Same polish drop mark but larger, on a dark background
 *  with a subtle radial glow behind it. App-store ready proportions.
 * ═══════════════════════════════════════════════════════════════════════ */
const appIconSpec: BrandIconSpec = {
  viewBox: "0 0 256 256",
  shapes: [
    // Background squircle
    {
      kind: "rect",
      x: 8,
      y: 8,
      width: 240,
      height: 240,
      rx: 56,
      fill: swatchWatchBrandPalette.purpleDeep,
    },
    // Radial glow behind drop
    {
      kind: "circle",
      cx: 128,
      cy: 148,
      r: 64,
      fill: swatchWatchBrandPalette.purple,
      opacity: 0.2,
    },
    // Main polish drop — centered
    {
      kind: "path",
      d: "M128 44C128 44 80 108 80 148a48 48 0 0096 0c0-40-48-104-48-104z",
      fill: swatchWatchBrandPalette.pink,
    },
    // Drop highlight
    {
      kind: "circle",
      cx: 106,
      cy: 140,
      r: 10,
      fill: swatchWatchBrandPalette.white,
      opacity: 0.35,
    },
  ],
};

export const swatchWatchIconSpecs = {
  app: appIconSpec,
  monogram: monogramSpec,
  swatch: swatchSpec,
  brush: brushSpec,
} as const;

export type SwatchWatchIconName = keyof typeof swatchWatchIconSpecs;
