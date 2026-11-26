/**
 * The bottle-flow outline as `quality.guideRegion`: the rectangle the user saw drawn over the
 * live preview, as 0–1 fractions of the frame image that is uploaded. The capture API measures
 * the glass color inside it and drops a printed name read far outside it (`frame-region.ts` on
 * the server), so a wrong region is worse than none: every case this cannot map exactly
 * returns `null` and the server falls back to its default outline.
 *
 * The preview `<video>` fills its box with `object-fit: cover` (centred), so the visible area is
 * a crop of the video frame, while the uploaded still is the whole frame scaled uniformly
 * (`captureFrameFromSource`), so fractions of the video frame are fractions of the upload.
 * DOM-free so it can be unit tested in Node; the measuring glue is in
 * `components/rapid-add/camera-capture.tsx`.
 */
import type { BottleSurface, CaptureGuideRegion } from "swatchwatch-shared";

export interface Size {
  width: number;
  height: number;
}

/** A rectangle in the preview element's own CSS pixels (left/top relative to the element). */
export interface ElementRect extends Size {
  left: number;
  top: number;
}

/** The server ignores a region with a side below this (`GUIDE_REGION_MIN_SIDE`). */
export const GUIDE_REGION_MIN_SIDE = 0.05;
/** Layout rounding: an outline may overhang the element by this many CSS px and still count. */
const OVERHANG_TOLERANCE_PX = 1;
const DECIMALS = 1e4;

function positive(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}

/**
 * Where the `guide` rectangle drawn over an `object-fit: cover` (centred) preview of a
 * `frame`-sized video lies in the video frame, as fractions. `mirrored` when the preview is
 * shown flipped horizontally (the frame is not). Null for missing sizes, a non-finite or
 * too-small guide, or one lying outside the preview.
 */
export function guideRegionInFrame(input: {
  guide: ElementRect;
  element: Size;
  frame: Size;
  mirrored?: boolean;
}): CaptureGuideRegion | null {
  const { guide, element, frame } = input;
  if (![element.width, element.height, frame.width, frame.height, guide.width, guide.height].every(positive)) return null;
  if (!Number.isFinite(guide.left) || !Number.isFinite(guide.top)) return null;
  if (
    guide.left < -OVERHANG_TOLERANCE_PX ||
    guide.top < -OVERHANG_TOLERANCE_PX ||
    guide.left + guide.width > element.width + OVERHANG_TOLERANCE_PX ||
    guide.top + guide.height > element.height + OVERHANG_TOLERANCE_PX
  ) {
    return null;
  }

  // object-fit: cover scales the frame to cover the element, centred (object-position 50% 50%).
  const scale = Math.max(element.width / frame.width, element.height / frame.height);
  const shownWidth = frame.width * scale;
  const shownHeight = frame.height * scale;
  const offsetX = (element.width - shownWidth) / 2;
  const offsetY = (element.height - shownHeight) / 2;

  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  let left = clamp((Math.max(0, guide.left) - offsetX) / shownWidth);
  let right = clamp((Math.min(element.width, guide.left + guide.width) - offsetX) / shownWidth);
  const top = clamp((Math.max(0, guide.top) - offsetY) / shownHeight);
  const bottom = clamp((Math.min(element.height, guide.top + guide.height) - offsetY) / shownHeight);
  if (input.mirrored) [left, right] = [1 - right, 1 - left];

  const x = Math.round(left * DECIMALS) / DECIMALS;
  const y = Math.round(top * DECIMALS) / DECIMALS;
  const w = Math.min(Math.round((right - left) * DECIMALS) / DECIMALS, 1 - x);
  const h = Math.min(Math.round((bottom - top) * DECIMALS) / DECIMALS, 1 - y);
  if (w < GUIDE_REGION_MIN_SIDE || h < GUIDE_REGION_MIN_SIDE) return null;
  return { x, y, w, h };
}

/** The outline measured when a photo was taken: which guide was drawn and where it lay in the frame. */
export interface ShownGuide {
  guide: string;
  region: CaptureGuideRegion;
}

/**
 * The `quality.guideRegion` to send with a frame, or null. Only a bottle-flow surface photo
 * (`bottleCapture` on) taken from the live preview (shutter or auto-shutter) gets one, and only
 * when the outline drawn was that surface's own; uploads have no outline and live barcode reads
 * are not surface frames.
 */
export function guideRegionForFrame(input: {
  bottleCapture: boolean;
  surface: BottleSurface | null;
  trigger: "live-scan" | "shutter" | "auto" | "file";
  shown: ShownGuide | null | undefined;
}): CaptureGuideRegion | null {
  if (!input.bottleCapture || !input.surface || !input.shown) return null;
  if (input.trigger !== "shutter" && input.trigger !== "auto") return null;
  if (input.shown.guide !== input.surface) return null;
  return input.shown.region;
}
