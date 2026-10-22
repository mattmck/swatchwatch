/**
 * "Focus on an area" for the photo match page (#105, Phase 5 region selection): the user drags
 * a box over the preview and only that part of the photo is matched. The box is kept as
 * fractions of the image (0–1) so it does not depend on how large the preview is drawn.
 */

export interface Point {
  x: number;
  y: number;
}

/** A rectangle in image fractions: `x`/`y` top-left, `width`/`height` sizes, all 0–1. */
export interface ImageRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Smallest region side (fraction of the image) that counts as a selection, not a click. */
export const MIN_REGION_FRACTION = 0.04;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/**
 * The region spanned by two pointer positions in display pixels over an element of
 * `displayWidth` × `displayHeight`, in either drag direction, clamped to the image. Null when
 * the box is too small to be a deliberate selection or the element has no size.
 */
export function regionFromDrag(
  start: Point,
  end: Point,
  displayWidth: number,
  displayHeight: number
): ImageRegion | null {
  if (!(displayWidth > 0) || !(displayHeight > 0)) return null;
  const x1 = clamp01(start.x / displayWidth);
  const x2 = clamp01(end.x / displayWidth);
  const y1 = clamp01(start.y / displayHeight);
  const y2 = clamp01(end.y / displayHeight);
  const region = {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
  return region.width >= MIN_REGION_FRACTION && region.height >= MIN_REGION_FRACTION ? region : null;
}

/** Integer source rectangle for drawing the region of a `naturalWidth` × `naturalHeight` image (at least 1 px). */
export function regionToPixels(
  region: ImageRegion,
  naturalWidth: number,
  naturalHeight: number
): { sx: number; sy: number; sw: number; sh: number } {
  const sx = Math.min(naturalWidth - 1, Math.max(0, Math.floor(region.x * naturalWidth)));
  const sy = Math.min(naturalHeight - 1, Math.max(0, Math.floor(region.y * naturalHeight)));
  const sw = Math.max(1, Math.min(naturalWidth - sx, Math.round(region.width * naturalWidth)));
  const sh = Math.max(1, Math.min(naturalHeight - sy, Math.round(region.height * naturalHeight)));
  return { sx, sy, sw, sh };
}

/** CSS percentages for drawing the region box over the preview. */
export function regionStyle(region: ImageRegion): { left: string; top: string; width: string; height: string } {
  const pct = (value: number) => `${(value * 100).toFixed(2)}%`;
  return { left: pct(region.x), top: pct(region.y), width: pct(region.width), height: pct(region.height) };
}
