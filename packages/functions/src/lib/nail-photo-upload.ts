import type { HttpRequest } from "@azure/functions";
import { NAIL_PHOTO_MAX_UPLOAD_BYTES, type NailPhotoUploadRequest } from "swatchwatch-shared";
import { NailPhotoInputError } from "./nail-photo-image";

/**
 * Request-body reading for private photo uploads (`{ image: "data:...;base64,..." }`), shared by the
 * nail-photo (#270) and mani-log photo (#327) routes. Decoding and re-encoding live in
 * `lib/nail-photo-image`.
 */

/** Generous allowance for JSON framing around the base64 payload. */
export const MAX_PHOTO_REQUEST_BODY_BYTES = Math.ceil(NAIL_PHOTO_MAX_UPLOAD_BYTES / 3) * 4 + 64 * 1024;

function tooLarge(): NailPhotoInputError {
  return new NailPhotoInputError(
    `Image too large: the limit is ${(NAIL_PHOTO_MAX_UPLOAD_BYTES / (1024 * 1024)).toFixed(0)} MB`,
    413
  );
}

/**
 * Read the request body, never buffering more than `maxBytes`. Streams `request.body` and stops
 * (413) as soon as the limit is passed, so a body that is larger than its Content-Length claims
 * still cannot exhaust memory.
 */
export async function readBodyCapped(request: HttpRequest, maxBytes: number): Promise<Buffer> {
  const stream = request.body;
  if (stream && typeof stream.getReader === "function") {
    const reader = stream.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  }
  const bytes = Buffer.from(await request.arrayBuffer());
  if (bytes.length > maxBytes) throw tooLarge();
  return bytes;
}

/**
 * Parse a photo upload body. A Content-Length is required (411 without one, e.g. chunked uploads)
 * and must be within `MAX_PHOTO_REQUEST_BODY_BYTES` (413), so oversize bodies are refused before
 * reading; the read itself is capped at the same limit.
 */
export async function readPhotoUploadBody(request: HttpRequest): Promise<NailPhotoUploadRequest> {
  const rawLength = request.headers.get("content-length")?.trim();
  if (!rawLength) {
    throw new NailPhotoInputError("A Content-Length header is required for photo uploads", 411);
  }
  if (!/^\d+$/.test(rawLength)) {
    throw new NailPhotoInputError("Invalid Content-Length header");
  }
  if (Number(rawLength) > MAX_PHOTO_REQUEST_BODY_BYTES) {
    throw tooLarge();
  }

  const invalidBody = () =>
    new NailPhotoInputError("Request body must be JSON: { \"image\": \"data:image/jpeg;base64,...\" }");
  const raw = await readBodyCapped(request, MAX_PHOTO_REQUEST_BODY_BYTES);
  let body: unknown;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    throw invalidBody();
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw invalidBody();
  }
  return body as NailPhotoUploadRequest;
}
