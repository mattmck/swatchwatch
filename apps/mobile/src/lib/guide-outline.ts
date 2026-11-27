/**
 * The bottle-flow outline on the native camera preview (#553, web parity): where the prompted
 * surface's outline is drawn, and the `quality.guideRegion` a photo taken with it is sent with.
 *
 * `expo-camera`'s preview is an aspect-fill (centred cover) crop of the camera frame on iOS
 * (`resizeAspectFill`) and on Android (`FILL_CENTER`, since this app sets no `ratio`), and the
 * still is the whole frame, so the shared `guideRegionInFrame` maps the drawn outline into the
 * photo exactly as the web does for its `object-cover` video. A wrong region is worse than none
 * (the server falls back to its default outline), so anything this cannot map is `null`.
 */
import {
  DEFAULT_GUIDE_REGIONS,
  guideRegionForFrame,
  guideRegionInFrame,
  type BottleSurface,
  type CaptureGuideRegion,
  type ElementRect,
  type Size,
} from "swatchwatch-shared";
import type { NativeShotTrigger } from "./rapid-add";

/** Where a surface's outline is drawn over a `preview`-sized camera preview, in its own points. */
export function guideOutlineRect(surface: BottleSurface, preview: Size): ElementRect {
  const region = DEFAULT_GUIDE_REGIONS[surface];
  return {
    left: region.x * preview.width,
    top: region.y * preview.height,
    width: region.w * preview.width,
    height: region.h * preview.height,
  };
}

/**
 * The `quality.guideRegion` for a native photo, or null. Only a bottle-sequence shutter photo
 * sent as the surface whose outline was drawn gets one (a library photo had no outline, a live
 * barcode read is not a surface frame). The app is portrait-only, so a landscape photo means its
 * rotation is not the preview's and the outline cannot be placed: null.
 */
export function nativeGuideRegion(input: {
  bottleSequence: boolean;
  /** The surface whose outline was on the preview when the photo was taken, or null. */
  drawn: BottleSurface | null;
  /** The surface the photo is sent as (`nativeShotTarget`). */
  surface: BottleSurface | null;
  trigger: NativeShotTrigger;
  /** The preview's size in points when the photo was taken. */
  preview: Size | null;
  /** The photo as sent (after `prepareJpeg`). */
  frame: Size;
}): CaptureGuideRegion | null {
  if (!input.drawn || !input.preview) return null;
  if (input.frame.width > input.frame.height) return null;
  const region = guideRegionInFrame({
    guide: guideOutlineRect(input.drawn, input.preview),
    element: input.preview,
    frame: input.frame,
  });
  if (!region) return null;
  return guideRegionForFrame({
    bottleCapture: input.bottleSequence,
    surface: input.surface,
    trigger: input.trigger,
    shown: { guide: input.drawn, region },
  });
}
