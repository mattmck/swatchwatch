import {
  loadDetectionFinishCatalog,
  parseConfidence,
  requestAzureOpenAiChatCompletion,
  resolveVisionImageDetail,
  type HexDetectionRequestPayload,
  type VisionImageDetail,
} from "../../../lib/ai-color-detection";
import { canonicalizeFinishes, finishNamesForPrompt, type FinishCatalog } from "../../../lib/finishes";
import {
  clampBox,
  drawLabeledGrid,
  gridCellLabel,
  gridCellToBox,
  isSparkleFinish,
  measureRegionsColor,
  parseNormalizedBox,
  REGION_KINDS,
  type NormalizedBox,
  type RegionKind,
} from "../../../lib/region-color";
import type { HexDetectionStrategy, StrategyInput, StrategyOutput } from "../types";

/**
 * "region-crop": the model localizes, the pixels measure.
 *
 * Step 1 asks Azure OpenAI where the polish's true color is (painted nail /
 * swatch first, else the lacquer inside the bottle; never cap, label, brush or
 * background) plus the finishes it sees. Step 2 (`measureRegionsColor`) crops
 * that area from the ORIGINAL image, drops specular highlights and dark edge
 * pixels, and takes the per-channel OKLAB median — the darker half only for
 * sparkle finishes, so glitter does not lift the base color.
 *
 * Two localization modes (`HEX_EVAL_REGION_CROP_MODE`):
 * - `cells` (default): a labeled N×N grid is drawn on the copy sent to the
 *   model, which lists the cells completely filled with polish; each cell's
 *   central 60% is measured. On the sample fixture gpt-4o-mini answered raw
 *   bounding boxes with a generic centered box (0.2,0.2,0.6,0.6) for most
 *   images, grid or not, so naming cells is the mode that actually localizes.
 * - `bbox`: the model returns one normalized box `{x,y,w,h}` (optionally on a
 *   gridded copy with `HEX_EVAL_REGION_CROP_GRID=true`). Kept for comparison.
 *
 * Other env toggles (read at run time, so `local.settings.json` applies):
 * - `HEX_EVAL_REGION_CROP_CELLS`  grid size per axis for `cells` mode (2–10, default 6).
 * - `HEX_EVAL_REGION_CROP_DETAIL` `low`/`high`/`auto` vision detail for the
 *   locator call. Defaults to `AZURE_OPENAI_VISION_DETAIL` (then `low`).
 */

export type RegionLocatorMode = "cells" | "bbox";

/** Grid size used for the optional overlay in `bbox` mode. */
export const BBOX_GRID_CELLS = 4;
export const DEFAULT_CELL_GRID = 6;
/** Most cells measured per image (the model is asked for at most this many). */
export const MAX_CELLS = 8;

export interface RegionLocatorPayloadOptions {
  mode: RegionLocatorMode;
  /** Grid cells per axis drawn on the image (`cells` mode always; `bbox` mode only when > 0). */
  gridCells: number;
  detail: VisionImageDetail;
  safePrompt?: boolean;
  /** Finish names for the prompt come from this catalog (the built-in finishes when omitted). */
  finishCatalog?: FinishCatalog;
}

const REGION_FIELD = '"region":"nail"|"bottle"|"swatch"|"other"';
const BBOX_JSON_SHAPE = `{"x":0..1,"y":0..1,"w":0..1,"h":0..1,${REGION_FIELD},"finishes":["creme","shimmer",...],"confidence":0..1}`;
const CELLS_JSON_SHAPE = `{"cells":["C3","C4",...],${REGION_FIELD},"finishes":["creme","shimmer",...],"confidence":0..1}`;

function gridDescription(cells: number): string {
  return `${cells}x${cells} grid (rows A–${String.fromCharCode(64 + cells)} top to bottom, columns 1–${cells} left to right; A1 is top-left, ${gridCellLabel(cells - 1, cells - 1)} bottom-right)`;
}

function buildPrompts(options: RegionLocatorPayloadOptions): { system: string; user: string } {
  const { mode, gridCells, safePrompt } = options;
  const finishList = finishNamesForPrompt(options.finishCatalog).join(", ");
  if (mode === "cells") {
    const grid = gridDescription(gridCells);
    if (safePrompt) {
      return {
        system: `Pick grid cells of a product photo that show a nail polish's own color. Respond with valid JSON only: ${CELLS_JSON_SHAPE}.`,
        user: `A labeled ${grid} is drawn over the image. List up to ${MAX_CELLS} cells that are completely filled with the polish color. region = what those cells show. finishes = visible finishes. confidence = how sure you are.`,
      };
    }
    return {
      system: `You locate where a nail polish's true color is visible in a product photo. A labeled ${grid} is drawn over the image. Prefer, in this order: painted nails or a painted swatch; otherwise the lacquer visible through the glass bottle. Never choose cells showing the cap, label, logo, text, brush, box/packaging, skin, shadows, glare or background. Respond with valid JSON only: ${CELLS_JSON_SHAPE}.`,
      user: `List up to ${MAX_CELLS} grid cells that are filled edge to edge with the polish color and nothing else. If no cell is completely filled, list the cells whose center is polish. Read the labels printed in the cells. region: "nail" for painted nails, "swatch" for a painted swatch stick or card, "bottle" for lacquer in the bottle, "other" otherwise. finishes: every visible finish (${finishList}). confidence: 0..1, how sure you are the cells show only polish of the marketed shade.`,
    };
  }

  const gridNote =
    gridCells > 0
      ? ` A labeled ${gridDescription(gridCells)} is drawn over the image to help you locate the area; still answer in normalized 0..1 coordinates, not cell names.`
      : "";
  if (safePrompt) {
    return {
      system: `Locate the part of a product photo that shows a nail polish's own color. Respond with valid JSON only: ${BBOX_JSON_SHAPE}. Always include x, y, w, h and confidence.`,
      user: `Return one bounding box in normalized image coordinates (origin top-left; x,y = box top-left corner; w,h = width and height as fractions of the image). Keep the box inside a single evenly colored area. region = what the box contains. finishes = visible finishes. confidence = how sure you are the box covers only polish.${gridNote}`,
    };
  }
  return {
    system: `You locate the area of a nail polish product photo that best shows the polish's true color. Prefer, in this order: a painted nail or painted nail swatch; otherwise the lacquer visible inside the glass bottle. Never choose the cap, label, text, brush, box, shadows, reflections or background. Respond with valid JSON only: ${BBOX_JSON_SHAPE}.`,
    user: `Return one tight bounding box in normalized image coordinates with the origin at the top-left: x,y is the box's top-left corner and w,h its width and height, all as fractions (0..1) of the image width and height. Keep the box inside a single evenly colored area of polish — shrink it rather than include nail edges, skin, the cap, glass highlights or background. region: "nail" for a painted nail, "swatch" for a painted swatch stick or card, "bottle" for lacquer inside the bottle, "other" otherwise. finishes: every visible finish (${finishList}). confidence: 0..1, how sure you are the box covers only polish of the marketed shade.${gridNote}`,
  };
}

export function buildRegionLocatorPayload(
  imageDataUri: string,
  options: RegionLocatorPayloadOptions
): HexDetectionRequestPayload {
  const { system, user } = buildPrompts(options);
  return {
    temperature: 0,
    max_tokens: 200,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          { type: "text", text: user },
          { type: "image_url", image_url: { url: imageDataUri, detail: options.detail } },
        ],
      },
    ],
  };
}

export interface RegionLocatorResult {
  /** The model's box as parsed (not clamped), or null when it was missing/non-numeric. `bbox` mode only. */
  rawBox: NormalizedBox | null;
  /** Cell labels as returned (upper-cased, de-duplicated). `cells` mode only. */
  rawCells: string[];
  /** Usable boxes to measure: the clamped bbox, or one inset box per valid cell. Empty when nothing usable. */
  boxes: NormalizedBox[];
  region: RegionKind | null;
  /** Finish strings exactly as reported (used for the sparkle decision). */
  rawFinishes: string[];
  confidence: number | null;
}

function parseRegionKind(value: unknown): RegionKind | null {
  if (typeof value !== "string") return null;
  const needle = value.trim().toLowerCase();
  return REGION_KINDS.find((kind) => kind === needle) ?? null;
}

export interface ParseRegionLocatorOptions {
  mode: RegionLocatorMode;
  /** Grid size for `cells` mode. */
  gridCells?: number;
}

/** Parse the locator's JSON reply. Never throws; unparseable content yields an empty result. */
export function parseRegionLocatorContent(
  content: string | null | undefined,
  options: ParseRegionLocatorOptions = { mode: "bbox" }
): RegionLocatorResult {
  const empty: RegionLocatorResult = { rawBox: null, rawCells: [], boxes: [], region: null, rawFinishes: [], confidence: null };
  if (!content) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return empty;
  const row = parsed as Record<string, unknown>;
  const rawFinishes = Array.isArray(row.finishes)
    ? row.finishes.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const common = { region: parseRegionKind(row.region), rawFinishes, confidence: parseConfidence(row.confidence) };

  if (options.mode === "cells") {
    const gridCells = options.gridCells ?? DEFAULT_CELL_GRID;
    const rawCells: string[] = [];
    const boxes: NormalizedBox[] = [];
    if (Array.isArray(row.cells)) {
      for (const value of row.cells) {
        if (typeof value !== "string") continue;
        const label = value.trim().toUpperCase().replace(/\s+/g, "");
        if (!label || rawCells.includes(label)) continue;
        rawCells.push(label);
        const box = gridCellToBox(label, gridCells);
        if (box && boxes.length < MAX_CELLS) boxes.push(box);
      }
    }
    return { ...common, rawBox: null, rawCells, boxes };
  }

  // Accept either top-level coordinates or a nested `box`/`bbox` object.
  const rawBox = parseNormalizedBox(row.box ?? row.bbox ?? row);
  const clamped = clampBox(rawBox);
  return { ...common, rawBox, rawCells: [], boxes: clamped ? [clamped] : [] };
}

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === "true" || raw === "1" || raw === "yes") return true;
  if (raw === "false" || raw === "0" || raw === "no") return false;
  return fallback;
}

function resolveLocatorDetail(): VisionImageDetail {
  const raw = process.env.HEX_EVAL_REGION_CROP_DETAIL?.trim().toLowerCase();
  if (raw === "low" || raw === "high" || raw === "auto") return raw;
  return resolveVisionImageDetail();
}

function resolveMode(): RegionLocatorMode {
  return process.env.HEX_EVAL_REGION_CROP_MODE?.trim().toLowerCase() === "bbox" ? "bbox" : "cells";
}

function resolveCellGrid(): number {
  const parsed = Number.parseInt(process.env.HEX_EVAL_REGION_CROP_CELLS ?? "", 10);
  return Number.isFinite(parsed) ? Math.max(2, Math.min(10, parsed)) : DEFAULT_CELL_GRID;
}

/** Suppress the library's per-call console chatter; errors still surface through the result. */
const quietLog = () => undefined;

export async function runRegionCrop(input: StrategyInput): Promise<StrategyOutput> {
  const mode = resolveMode();
  const gridCells = mode === "cells" ? resolveCellGrid() : envFlag("HEX_EVAL_REGION_CROP_GRID", false) ? BBOX_GRID_CELLS : 0;
  const detail = resolveLocatorDetail();

  let locatorDataUri = input.image.dataUri;
  if (gridCells > 0) {
    const overlaid = await drawLabeledGrid(input.image.bytes, { cells: gridCells });
    locatorDataUri = `data:image/jpeg;base64,${overlaid.toString("base64")}`;
  }

  const finishCatalog = await loadDetectionFinishCatalog({ onLog: quietLog });
  const response = await requestAzureOpenAiChatCompletion(
    (safePrompt) => buildRegionLocatorPayload(locatorDataUri, { mode, gridCells, detail, safePrompt, finishCatalog }),
    { onLog: quietLog, label: "region locator" }
  );
  if (response.provider === "none") {
    throw new Error("Azure OpenAI config missing");
  }

  const locator = parseRegionLocatorContent(response.content, { mode, gridCells });
  const sparkle = isSparkleFinish(locator.rawFinishes);
  // The built-in catalog is enough for eval output; production canonicalizes against the DB catalog.
  const finishes = canonicalizeFinishes(locator.rawFinishes);
  const baseMeta: Record<string, unknown> = {
    mode,
    gridCells,
    detail,
    region: locator.region,
    rawFinishes: locator.rawFinishes,
    rawBox: locator.rawBox,
    cells: locator.rawCells,
    locatorConfidence: locator.confidence,
    contentFiltered: response.contentFiltered,
    usage: response.usage ?? null,
  };

  if (locator.boxes.length === 0) {
    return {
      hex: null,
      confidence: locator.confidence,
      finishes: finishes.length ? finishes : null,
      meta: { ...baseMeta, box: null, reason: response.contentFiltered ? "content_filtered" : mode === "cells" ? "no_valid_cells" : "invalid_box" },
    };
  }

  const measured = await measureRegionsColor(input.image.bytes, locator.boxes, { darkerHalf: sparkle });
  return {
    hex: measured.hex,
    confidence: locator.confidence,
    finishes: finishes.length ? finishes : null,
    meta: {
      ...baseMeta,
      box: locator.boxes.length === 1 ? locator.boxes[0] : null,
      boxes: locator.boxes,
      pixelBox: measured.box,
      pixelBoxes: measured.boxes,
      imageSize: { width: measured.imageWidth, height: measured.imageHeight },
      pixels: measured.pixels,
      highlightCutoffL: measured.highlightCutoffL,
      darkFloorApplied: measured.darkFloorApplied,
      usedDarkerHalf: measured.usedDarkerHalf,
      measuredOklab: measured.oklab,
    },
  };
}

/** (d) Model picks where the polish is (grid cells or a bbox); the pixels there are measured (OKLAB median). */
export const regionCropStrategy: HexDetectionStrategy = {
  name: "region-crop",
  description: "model localizes the polish (grid cells / bbox), pixels there are measured (OKLAB median)",
  requiresAzureOpenAI: true,
  run: runRegionCrop,
};
