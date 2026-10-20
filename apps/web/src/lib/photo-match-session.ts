import type { PolishImageMatchResponse } from "swatchwatch-shared";
import type { DownscaledImage } from "@/lib/image-downscale";

/**
 * In-memory home of the last photo match (#105), so that leaving `/polishes/match` for a polish
 * detail page and coming back with the browser's Back button shows the same photo and results.
 *
 * Module scope survives client-side navigation in the App Router but not a reload or a new tab,
 * which is the point: the photo is never written to storage, the URL or the server. Responses
 * are cached per server-side filter key (`matchRequestKey`), so switching back to a scope you
 * already looked at does not re-upload the photo.
 */
export interface PhotoMatchSession {
  /** The downscaled photo that was sent (what the results describe). */
  image: DownscaledImage;
  /** The full photo, when `image` is a cropped region of it. */
  fullImage: DownscaledImage | null;
  responses: Map<string, PolishImageMatchResponse>;
}

/** Most filter combinations kept per photo before the oldest is evicted. */
export const PHOTO_MATCH_SESSION_MAX_RESPONSES = 8;

let session: PhotoMatchSession | null = null;

export function getPhotoMatchSession(): PhotoMatchSession | null {
  return session;
}

/** Start a new session for a photo (drops every cached response of the previous one). */
export function startPhotoMatchSession(image: DownscaledImage, fullImage: DownscaledImage | null = null): PhotoMatchSession {
  session = { image, fullImage, responses: new Map() };
  return session;
}

/** Cache a response for the current photo; ignored when `image` is no longer the current photo. */
export function rememberPhotoMatchResponse(
  image: DownscaledImage,
  key: string,
  response: PolishImageMatchResponse
): void {
  if (!session || session.image !== image) return;
  session.responses.delete(key);
  session.responses.set(key, response);
  while (session.responses.size > PHOTO_MATCH_SESSION_MAX_RESPONSES) {
    const oldest = session.responses.keys().next().value;
    if (oldest === undefined) break;
    session.responses.delete(oldest);
  }
}

/**
 * Forget every cached response except `key`'s. Called after a wishlist / own action: the other
 * scopes' results no longer reflect the inventory (a wishlisted shade now belongs in Wishlist).
 */
export function forgetOtherPhotoMatchResponses(key: string): void {
  if (!session) return;
  for (const cached of [...session.responses.keys()]) {
    if (cached !== key) session.responses.delete(cached);
  }
}

export function clearPhotoMatchSession(): void {
  session = null;
}
