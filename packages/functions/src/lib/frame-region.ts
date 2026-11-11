import sharp from "sharp";
import type { BottleSurface } from "swatchwatch-shared";

/**
 * Where the shown bottle is in a Rapid Add bottle frame (Bottle Flow slice A).
 *
 * A client may send the outline it showed as `quality.guideRegion` ({ x, y, w, h } as 0–1
 * fractions of the frame it sends, x/y = top-left); without one the server assumes the outline
 * the web client draws (`AUTO_SHUTTER_REGIONS` in `apps/web/src/lib/auto-shutter.ts`, centred in
 * the frame because the preview fills its box with `object-cover`). The glass color is measured
 * on that region only, so the hand and the room around the bottle never become the lacquer.
 *
 * Sticker reads are not cropped: a held bottle's sticker often lies partly outside the outline
 * (bottle eval 2026-11-10) and the background bottle a read must ignore can lie inside it.
 * Instead the read reports where the held bottle and the name it read are (`bottleBox`,
 * `nameBox`), and `nameLocation` rejects a name that is not on the held bottle (or, with a
 * client outline, not near it).
 */

export interface NormalizedRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** [left, top, right, bottom] as 0–1 fractions of the image. */
export type NormalizedBox = readonly [number, number, number, number];

/** The outline the web client draws per surface (`AUTO_SHUTTER_REGIONS`), the default guide. */
export const DEFAULT_GUIDE_REGIONS: Readonly<Record<BottleSurface, NormalizedRegion>> = {
  front: { x: 0.3, y: 0.15, w: 0.4, h: 0.7 },
  bottom: { x: 0.28, y: 0.25, w: 0.44, h: 0.5 },
  glass: { x: 0.38, y: 0.38, w: 0.24, h: 0.24 },
  box: { x: 0.22, y: 0.2, w: 0.56, h: 0.6 },
};

/** A guide region smaller than this (either side) is ignored: nothing could be measured in it. */
export const GUIDE_REGION_MIN_SIDE = 0.05;
/** How far (fraction of the image) a name may sit outside the reported bottle box and still be on it. */
export const NAME_BOX_BOTTLE_MARGIN = 0.05;
/** How far (fraction of the image) a name may sit outside the client's outline and still count. */
export const NAME_BOX_GUIDE_MARGIN = 0.1;
/** Smallest cropped side in pixels; a smaller crop measures the whole frame instead. */
const MIN_CROP_PX = 8;
const EPSILON = 1e-6;

function finite(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * A client-sent `quality.guideRegion`, or null when it is missing or not a region inside the
 * frame (each side at least `GUIDE_REGION_MIN_SIDE`, nothing outside 0–1).
 */
export function parseGuideRegion(value: unknown): NormalizedRegion | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const x = finite(record.x);
  const y = finite(record.y);
  const w = finite(record.w);
  const h = finite(record.h);
  if (x === null || y === null || w === null || h === null) return null;
  if (x < 0 || y < 0 || w < GUIDE_REGION_MIN_SIDE || h < GUIDE_REGION_MIN_SIDE) return null;
  if (x + w > 1 + EPSILON || y + h > 1 + EPSILON) return null;
  return { x, y, w: Math.min(w, 1 - x), h: Math.min(h, 1 - y) };
}

/** The region a surface's frame is measured on: the client's outline, else the default one. */
export function guideRegionFor(surface: BottleSurface, quality: Record<string, unknown> | null | undefined): NormalizedRegion {
  return parseGuideRegion(quality?.guideRegion) ?? DEFAULT_GUIDE_REGIONS[surface];
}

/**
 * A model-reported box: four numbers [left, top, right, bottom] in 0–1 with left < right and
 * top < bottom; anything else (pixels, percents, a missing or degenerate box) is null.
 */
export function parseNormalizedBox(value: unknown): NormalizedBox | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const numbers = value.map(finite);
  if (numbers.some((n) => n === null)) return null;
  const [left, top, right, bottom] = numbers as number[];
  if ([left, top, right, bottom].some((n) => n < -EPSILON || n > 1 + EPSILON)) return null;
  if (right - left < EPSILON || bottom - top < EPSILON) return null;
  return [left, top, right, bottom];
}

function centreInside(box: NormalizedBox, region: NormalizedRegion, margin: number): boolean {
  const cx = (box[0] + box[2]) / 2;
  const cy = (box[1] + box[3]) / 2;
  return (
    cx >= region.x - margin &&
    cx <= region.x + region.w + margin &&
    cy >= region.y - margin &&
    cy <= region.y + region.h + margin
  );
}

export type NameLocation = "on_bottle" | "off_bottle" | "off_guide" | "unknown";

/**
 * Whether the name a read reports sits on the held bottle: `off_bottle` when the centre of
 * `nameBox` lies outside `bottleBox` (plus `NAME_BOX_BOTTLE_MARGIN`), `off_guide` when a client
 * outline was sent and the centre lies outside it (plus `NAME_BOX_GUIDE_MARGIN`), `on_bottle`
 * when both boxes are valid and neither applies, `unknown` without a valid name box (a model
 * that does not report boxes keeps today's behaviour).
 */
export function nameLocation(input: {
  bottleBox: NormalizedBox | null;
  nameBox: NormalizedBox | null;
  guideRegion?: NormalizedRegion | null;
}): NameLocation {
  if (!input.nameBox) return "unknown";
  if (input.guideRegion && !centreInside(input.nameBox, input.guideRegion, NAME_BOX_GUIDE_MARGIN)) return "off_guide";
  if (!input.bottleBox) return "unknown";
  const [left, top, right, bottom] = input.bottleBox;
  const bottle = { x: left, y: top, w: right - left, h: bottom - top };
  return centreInside(input.nameBox, bottle, NAME_BOX_BOTTLE_MARGIN) ? "on_bottle" : "off_bottle";
}

/**
 * The `region` of an image as PNG bytes (orientation applied first, as the client saw it).
 * Returns the image unchanged when the crop would be smaller than a few pixels. Throws only
 * when the bytes are not an image.
 */
export async function cropToRegion(image: Buffer, region: NormalizedRegion): Promise<Buffer> {
  const oriented = await sharp(image).rotate().toBuffer({ resolveWithObject: true });
  const width = oriented.info.width;
  const height = oriented.info.height;
  const left = Math.min(width - 1, Math.max(0, Math.round(region.x * width)));
  const top = Math.min(height - 1, Math.max(0, Math.round(region.y * height)));
  const right = Math.min(width, Math.round((region.x + region.w) * width));
  const bottom = Math.min(height, Math.round((region.y + region.h) * height));
  if (right - left < MIN_CROP_PX || bottom - top < MIN_CROP_PX) return image;
  return sharp(oriented.data).extract({ left, top, width: right - left, height: bottom - top }).png().toBuffer();
}
