/**
 * Pure helpers for the admin Hex Labeling tool (`/admin?tab=hex-labeling`): canvas pixel
 * sampling, pointer → pixel mapping, hex input parsing, keyboard shortcuts and undo planning.
 * Kept free of DOM/React so they run under `node:test`.
 */
import {
  HEX_LABEL_SAMPLE_SIZES,
  type HexLabel,
  type HexLabelRequest,
  type HexLabelSamplePoint,
  type HexLabelSaveResponse,
} from "swatchwatch-shared";

export { HEX_LABEL_SAMPLE_SIZES };

export interface RegionSample {
  r: number;
  g: number;
  b: number;
  /** `#RRGGBB` of the averaged colour. */
  hex: string;
  /** Pixels that contributed (fully transparent pixels are skipped). */
  count: number;
}

function toHexByte(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0").toUpperCase();
}

/** `#RRGGBB` (uppercase) from 0–255 channels; values are rounded and clamped. */
export function rgbToHexString(r: number, g: number, b: number): string {
  return `#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}`;
}

/**
 * Average the RGBA pixels in a `size`×`size` window centred on (`cx`, `cy`).
 *
 * - `data` is row-major RGBA (`ImageData.data`), `width`×`height` pixels.
 * - The window is clamped to the image (a sample at an edge only averages pixels that exist).
 * - Fully transparent pixels (alpha 0) are ignored, so a PNG cut-out's background never pulls
 *   the colour towards black; partially transparent pixels count fully (their RGB is the colour).
 * - Even sizes are treated as the next odd size so the window stays centred.
 *
 * Returns null when no opaque pixel falls in the window (or the input is empty).
 */
export function averageRegion(
  data: ArrayLike<number>,
  width: number,
  height: number,
  cx: number,
  cy: number,
  size: number
): RegionSample | null {
  if (width <= 0 || height <= 0 || data.length < width * height * 4) return null;
  const radius = Math.max(0, Math.floor(Math.max(1, Math.round(size)) / 2));
  const centerX = Math.round(cx);
  const centerY = Math.round(cy);
  const x0 = Math.max(0, centerX - radius);
  const x1 = Math.min(width - 1, centerX + radius);
  const y0 = Math.max(0, centerY - radius);
  const y1 = Math.min(height - 1, centerY + radius);
  if (x0 > x1 || y0 > y1) return null;

  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const i = (y * width + x) * 4;
      if (data[i + 3] === 0) continue;
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      count += 1;
    }
  }
  if (count === 0) return null;
  const avg = { r: r / count, g: g / count, b: b / count };
  return {
    r: Math.round(avg.r),
    g: Math.round(avg.g),
    b: Math.round(avg.b),
    hex: rgbToHexString(avg.r, avg.g, avg.b),
    count,
  };
}

/**
 * Map a pointer position to an integer pixel of a canvas drawn at `pixelWidth`×`pixelHeight` and
 * displayed in `rect` (CSS pixels; the canvas keeps its aspect ratio). Null when outside.
 */
export function clientToPixel(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  pixelWidth: number,
  pixelHeight: number
): { x: number; y: number } | null {
  if (rect.width <= 0 || rect.height <= 0 || pixelWidth <= 0 || pixelHeight <= 0) return null;
  const relX = clientX - rect.left;
  const relY = clientY - rect.top;
  if (relX < 0 || relY < 0 || relX > rect.width || relY > rect.height) return null;
  return {
    x: Math.min(pixelWidth - 1, Math.floor((relX / rect.width) * pixelWidth)),
    y: Math.min(pixelHeight - 1, Math.floor((relY / rect.height) * pixelHeight)),
  };
}

/** Sample point normalized to 0..1 (pixel centre) for `HexLabelRequest.samplePoint`. */
export function toSamplePoint(
  pixel: { x: number; y: number },
  size: number,
  width: number,
  height: number
): HexLabelSamplePoint {
  const round = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 10000) / 10000;
  return {
    x: round((pixel.x + 0.5) / width),
    y: round((pixel.y + 0.5) / height),
    size,
    imageWidth: width,
    imageHeight: height,
  };
}

/**
 * Normalize typed hex input to `#RRGGBB` (uppercase). Accepts an optional `#`, surrounding
 * whitespace and 3-digit shorthand (`#abc` → `#AABBCC`). Null for anything else.
 */
export function normalizeHexInput(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim().replace(/^#/, "");
  if (/^[0-9a-f]{6}$/i.test(raw)) return `#${raw.toUpperCase()}`;
  if (/^[0-9a-f]{3}$/i.test(raw)) {
    return `#${raw
      .split("")
      .map((ch) => ch + ch)
      .join("")
      .toUpperCase()}`;
  }
  return null;
}

/** Black or white text, whichever reads better on `hex` (WCAG relative luminance). */
export function readableTextColor(hex: string): "#000000" | "#FFFFFF" {
  const normalized = normalizeHexInput(hex);
  if (!normalized) return "#000000";
  const channel = (offset: number) => {
    const c = parseInt(normalized.slice(offset, offset + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return luminance > 0.179 ? "#000000" : "#FFFFFF";
}

export type HexLabelKeyAction =
  | { type: "save" }
  | { type: "skip" }
  | { type: "next" }
  | { type: "prev" }
  | { type: "undo" }
  | { type: "eyedropper" }
  | { type: "image"; index: number }
  | { type: "sample-size"; delta: 1 | -1 };

/**
 * Keyboard shortcuts: Enter = save, S = skip, N / → = next, P / ← = previous, 1–9 = image,
 * U or Ctrl/⌘+Z = undo last save, E = native eyedropper, [ / ] = smaller / larger sample.
 * While typing in a text field only Enter (save) is handled, and only from the hex input.
 */
export function hexLabelKeyAction(
  event: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean },
  context: { inTextField: boolean; inHexInput?: boolean }
): HexLabelKeyAction | null {
  const key = event.key;
  if (context.inTextField) {
    return key === "Enter" && context.inHexInput ? { type: "save" } : null;
  }
  if ((event.ctrlKey || event.metaKey) && !event.altKey && key.toLowerCase() === "z") return { type: "undo" };
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  switch (key) {
    case "Enter":
      return { type: "save" };
    case "s":
    case "S":
      return { type: "skip" };
    case "n":
    case "N":
    case "ArrowRight":
      return { type: "next" };
    case "p":
    case "P":
    case "ArrowLeft":
      return { type: "prev" };
    case "u":
    case "U":
      return { type: "undo" };
    case "e":
    case "E":
      return { type: "eyedropper" };
    case "[":
      return { type: "sample-size", delta: -1 };
    case "]":
      return { type: "sample-size", delta: 1 };
    default:
      if (/^[1-9]$/.test(key)) return { type: "image", index: Number(key) - 1 };
      return null;
  }
}

/** Step through `HEX_LABEL_SAMPLE_SIZES` (1/3/5/9), clamped at both ends. */
export function stepSampleSize(current: number, delta: 1 | -1): number {
  const sizes: readonly number[] = HEX_LABEL_SAMPLE_SIZES;
  const index = Math.max(0, sizes.indexOf(current));
  return sizes[Math.min(sizes.length - 1, Math.max(0, index + delta))];
}

/** Request that recreates a saved label exactly (used to undo an overwrite). */
export function labelToRequest(label: HexLabel): HexLabelRequest {
  return {
    shadeId: label.shadeId,
    hex: label.hex,
    imageId: label.imageId,
    unreliable: label.unreliable,
    note: label.note,
    method: label.method,
    samplePoint: label.samplePoint,
  };
}

export type UndoPlan =
  | { kind: "delete"; trainingSampleId: string; shadeId: string }
  | { kind: "restore"; request: HexLabelRequest; shadeId: string };

/** Undo a save: delete a brand-new label, or restore the label it replaced. */
export function planUndo(saved: HexLabelSaveResponse): UndoPlan {
  if (saved.previous) {
    return { kind: "restore", request: labelToRequest(saved.previous), shadeId: saved.label.shadeId };
  }
  return { kind: "delete", trainingSampleId: saved.label.trainingSampleId, shadeId: saved.label.shadeId };
}

/** "12 / 340 labeled (3.5%)" style progress numbers; percent is 0 when total is 0. */
export function labelProgress(labeled: number, total: number): { labeled: number; total: number; percent: number } {
  const safeTotal = Math.max(0, total);
  const safeLabeled = Math.max(0, Math.min(labeled, safeTotal));
  return {
    labeled: safeLabeled,
    total: safeTotal,
    percent: safeTotal === 0 ? 0 : Math.round((safeLabeled / safeTotal) * 1000) / 10,
  };
}
