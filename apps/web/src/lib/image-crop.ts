import type { DownscaledImage } from "@/lib/image-downscale";
import { regionToPixels, type ImageRegion } from "@/lib/image-region";

/**
 * Crop an already-downscaled photo (a data URL) to `region` on a canvas and return the crop as a
 * new data URL. Browser-only (canvas); the geometry lives in `image-region.ts`.
 */
export async function cropDownscaledImage(image: DownscaledImage, region: ImageRegion): Promise<DownscaledImage> {
  const element = new Image();
  element.decoding = "async";
  element.src = image.dataUrl;
  await element.decode();

  const { sx, sy, sw, sh } = regionToPixels(region, element.naturalWidth, element.naturalHeight);
  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Couldn't crop that image in this browser.");
  ctx.drawImage(element, sx, sy, sw, sh, 0, 0, sw, sh);

  const mimeType = image.dataUrl.startsWith("data:image/png") ? "image/png" : "image/jpeg";
  return { dataUrl: canvas.toDataURL(mimeType, 0.9), width: sw, height: sh };
}
