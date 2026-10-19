import { ImageManipulator, SaveFormat } from "expo-image-manipulator";

/** The capture API rejects frames over 5 MB (web: `MAX_CAPTURE_FRAME_BYTES`). */
export const MAX_FRAME_BYTES = 5 * 1024 * 1024;

export interface PreparedImage {
  dataUrl: string;
  width: number;
  height: number;
  bytes: number;
}

/**
 * Downscale a photo so its long edge is at most `maxEdge` and re-encode it as JPEG, returning
 * a base64 data URL for the JSON APIs (capture frames, match-image). Re-encoding also drops
 * the EXIF block (incl. GPS) the camera or library wrote.
 */
export async function prepareJpeg(
  uri: string,
  source: { width: number; height: number },
  options: { maxEdge: number; compress: number },
): Promise<PreparedImage> {
  const context = ImageManipulator.manipulate(uri);
  const longEdge = Math.max(source.width, source.height);
  if (longEdge > options.maxEdge) {
    context.resize(source.width >= source.height ? { width: options.maxEdge } : { height: options.maxEdge });
  }
  const rendered = await context.renderAsync();
  const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: options.compress, base64: true });
  if (!saved.base64) throw new Error("Couldn't encode the photo.");
  const bytes = Math.floor((saved.base64.length * 3) / 4);
  if (bytes > MAX_FRAME_BYTES) throw new Error("That photo is too large to upload. Try again a little further away.");
  return { dataUrl: `data:image/jpeg;base64,${saved.base64}`, width: saved.width, height: saved.height, bytes };
}
