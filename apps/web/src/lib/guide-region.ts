/**
 * The bottle-flow outline as `quality.guideRegion`. Mapping the outline drawn over the preview
 * into the camera frame (`guideRegionInFrame`), which photos get a region (`guideRegionForFrame`)
 * and the outline shapes are shared with the Expo app: see
 * `packages/shared/src/capture/guide-region.ts`. A web photo is then cut around the outline
 * (`planGuideCrop`, below) and the region is reported in fractions of that cut. DOM-free so it
 * can be unit tested in Node; the measuring glue is in `components/rapid-add/camera-capture.tsx`.
 */
import { GUIDE_REGION_MIN_SIDE, type CaptureGuideRegion } from "swatchwatch-shared";

export {
  DEFAULT_GUIDE_REGIONS,
  GUIDE_REGION_MIN_SIDE,
  guideRegionForFrame,
  guideRegionInFrame,
  type ElementRect,
  type ShownGuide,
  type Size,
} from "swatchwatch-shared";

const DECIMALS = 1e4;

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
