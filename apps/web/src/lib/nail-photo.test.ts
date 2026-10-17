import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NAIL_PHOTO_MAX_UPLOAD_BYTES } from "swatchwatch-shared";
import { MAX_SOURCE_IMAGE_BYTES } from "./image-downscale";
import {
  NAIL_PHOTO_INPUT_ACCEPT,
  canUploadOriginal,
  describeNailPhotoError,
  validateNailPhotoFile,
} from "./nail-photo";

describe("NAIL_PHOTO_INPUT_ACCEPT", () => {
  it("lists exactly the types the API accepts", () => {
    assert.equal(NAIL_PHOTO_INPUT_ACCEPT, "image/jpeg,image/png,image/webp,image/heic,image/heif");
  });
});

describe("validateNailPhotoFile", () => {
  it("accepts ordinary photos", () => {
    assert.equal(validateNailPhotoFile({ type: "image/jpeg", size: 3_000_000 }), null);
    assert.equal(validateNailPhotoFile({ type: "image/HEIC", size: 2_000_000 }), null);
  });

  it("rejects non-images, empty files and files too large to decode", () => {
    assert.match(validateNailPhotoFile({ type: "application/pdf", size: 10 }) ?? "", /choose a photo/);
    assert.match(validateNailPhotoFile({ type: "", size: 10 }) ?? "", /choose a photo/);
    assert.match(validateNailPhotoFile({ type: "image/jpeg", size: 0 }) ?? "", /empty/);
    assert.match(validateNailPhotoFile({ type: "image/jpeg", size: MAX_SOURCE_IMAGE_BYTES + 1 }) ?? "", /too large/);
  });
});

describe("canUploadOriginal", () => {
  it("allows accepted types within the server limit", () => {
    assert.equal(canUploadOriginal({ type: "image/heic", size: 1024 }), true);
    assert.equal(canUploadOriginal({ type: "image/jpeg", size: NAIL_PHOTO_MAX_UPLOAD_BYTES }), true);
  });

  it("refuses other types and oversize files", () => {
    assert.equal(canUploadOriginal({ type: "image/gif", size: 1024 }), false);
    assert.equal(canUploadOriginal({ type: "image/tiff", size: 1024 }), false);
    assert.equal(canUploadOriginal({ type: "image/heic", size: NAIL_PHOTO_MAX_UPLOAD_BYTES + 1 }), false);
    assert.equal(canUploadOriginal({ type: "image/jpeg", size: 0 }), false);
  });
});

describe("describeNailPhotoError", () => {
  it("maps API statuses to user-facing messages", () => {
    assert.match(describeNailPhotoError(401), /sign in/);
    assert.match(describeNailPhotoError(403), /isn't in your collection/);
    assert.match(describeNailPhotoError(404), /isn't in your collection/);
    assert.match(describeNailPhotoError(413), /too large/);
    assert.match(describeNailPhotoError(415), /isn't supported/);
    assert.match(describeNailPhotoError(503), /unavailable/);
  });

  it("falls back to the given message, then a generic one", () => {
    assert.equal(describeNailPhotoError(500, "Failed to save nail photo"), "Failed to save nail photo");
    assert.match(describeNailPhotoError(undefined), /went wrong/);
  });
});
