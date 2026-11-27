/**
 * The bottle-flow outline as `quality.guideRegion`: the rectangle the user saw drawn over the
 * live preview, as 0–1 fractions of the frame image that is uploaded. The capture API measures
 * the glass color inside it and drops a printed name read far outside it (`frame-region.ts` on
 * the server), so a wrong region is worse than none: every case this cannot map exactly
 * returns `null` and the server falls back to its default outline.
 *
 * The preview `<video>` fills its box with `object-fit: cover` (centred), so the visible area is
 * a crop of the video frame. `guideRegionInFrame` gives the outline in fractions of the whole
 * video frame; a photo is then cut around it (`planGuideCrop`) and the region is reported in
 * fractions of that cut.
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

/**
 * How much of the frame around the outline a photo keeps, as a multiple of the outline's own
 * size. The outlines are small so the bottle is held far enough away to focus (an iPhone Pro's
 * main camera cannot focus closer than about 15 cm), which leaves the bottle a small part of the
 * camera frame; the photo is cropped to it so the text is as large as the camera allows when it
 * reaches the vision model, and the upload is small. The margin keeps a bottle that is held a
 * little off the outline in the photo.
 */
export const GUIDE_CROP_FACTOR: Readonly<Record<string, number>> = {
  bottom: 2.4,
  glass: 3,
  front: 1.5,
  box: 1.5,
  label: 1.5,
};

/**
 * For a label surface the region sent is the outline plus this slack: the capture API drops a
 * printed name far outside the region, and a hand-held bottle is rarely exactly on a small
 * outline. The glass region stays exact, because the color is measured inside it.
 */
export const GUIDE_LABEL_SLACK = 1.5;

/** `region` scaled about its centre by `factor`, clipped to the frame. */
export function scaleRegion(region: CaptureGuideRegion, factor: number): CaptureGuideRegion {
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const cx = region.x + region.w / 2;
  const cy = region.y + region.h / 2;
  const left = clamp(cx - (region.w * factor) / 2);
  const top = clamp(cy - (region.h * factor) / 2);
  const right = clamp(cx + (region.w * factor) / 2);
  const bottom = clamp(cy + (region.h * factor) / 2);
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** `region` (fractions of the frame) as fractions of `crop` (also fractions of the frame), clipped to it; null when nothing of it is left. */
export function regionWithinCrop(region: CaptureGuideRegion, crop: CaptureGuideRegion): CaptureGuideRegion | null {
  if (!(crop.w > 0) || !(crop.h > 0)) return null;
  const left = Math.max(region.x, crop.x);
  const top = Math.max(region.y, crop.y);
  const right = Math.min(region.x + region.w, crop.x + crop.w);
  const bottom = Math.min(region.y + region.h, crop.y + crop.h);
  const round = (v: number) => Math.round(v * DECIMALS) / DECIMALS;
  const x = round((left - crop.x) / crop.w);
  const y = round((top - crop.y) / crop.h);
  const w = Math.min(round((right - left) / crop.w), 1 - x);
  const h = Math.min(round((bottom - top) / crop.h), 1 - y);
  if (w < GUIDE_REGION_MIN_SIDE || h < GUIDE_REGION_MIN_SIDE) return null;
  return { x, y, w, h };
}

/**
 * How a photo of `guide` is cut from the camera frame, given where the outline lies in it:
 * `crop` is the part of the frame to keep, `region` the outline to report with the photo
 * (`quality.guideRegion`), as fractions of the cropped photo. A guide with no crop factor (the
 * barcode band) keeps the whole frame.
 */
export function planGuideCrop(
  guide: string,
  outline: CaptureGuideRegion,
): { crop: CaptureGuideRegion | null; region: CaptureGuideRegion | null } {
  const factor = GUIDE_CROP_FACTOR[guide];
  const reported = guide === "glass" ? outline : scaleRegion(outline, GUIDE_LABEL_SLACK);
  if (!factor) return { crop: null, region: reported };
  const crop = scaleRegion(outline, factor);
  return { crop, region: regionWithinCrop(reported, crop) };
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
