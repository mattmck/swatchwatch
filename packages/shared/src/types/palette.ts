export type HarmonyType =
  | "similar"
  | "complementary"
  | "split-complementary"
  | "analogous"
  | "triadic"
  | "tetradic"
  | "monochromatic";

export type PaletteHarmonyType = Exclude<HarmonyType, "similar">;

export interface PaletteSuggestion {
  harmony: PaletteHarmonyType;
  /** 0-1 confidence score for the detected harmony fit. */
  confidence: number;
  /** User-selected anchor colors used for fitting and completion. */
  anchors: string[];
  /** Palette source color selected by detection. */
  sourceHex: string;
  /** Full target palette including source as index 0. */
  targetHexes: string[];
  /** Missing target slots not covered by current anchors. */
  completionHexes: string[];
}

export type HueFamily =
  | "reds"
  | "oranges-corals"
  | "yellows-golds"
  | "greens"
  | "blues-teals"
  | "purples-violets"
  | "pinks-magentas"
  | "neutrals";

export type LightnessBand =
  | "dark"
  | "dark-medium"
  | "medium"
  | "medium-light"
  | "light";

export interface CollectionGapCell {
  hueFamily: HueFamily;
  lightnessBand: LightnessBand;
  count: number;
}

export interface CollectionGapAnalysis {
  cells: CollectionGapCell[];
  missing: CollectionGapCell[];
  underrepresented: CollectionGapCell[];
}
