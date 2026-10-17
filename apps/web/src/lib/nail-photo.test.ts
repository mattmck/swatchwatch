import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NAIL_PHOTO_MAX_UPLOAD_BYTES } from "swatchwatch-shared";
import { MAX_SOURCE_IMAGE_BYTES } from "./image-downscale";
import {
  NAIL_PHOTO_INPUT_ACCEPT,
  canUploadOriginal,
  describeNailPhotoError,
  prepareNailPhotoUpload,
  validateNailPhotoFile,
  type NailPhotoPrepareDeps,
} from "./nail-photo";
import { HeicConversionError } from "./heic-convert";

describe("NAIL_PHOTO_INPUT_ACCEPT", () => {
  it("lists the types the API accepts plus the HEIC extensions", () => {
    assert.equal(NAIL_PHOTO_INPUT_ACCEPT, "image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif,.hif");
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

  it("accepts untyped HEIC files (by extension or a sniffed signature)", () => {
    assert.equal(validateNailPhotoFile({ type: "", size: 2_000_000, name: "IMG_0042.HEIC" }), null);
    assert.equal(validateNailPhotoFile({ type: "", size: 2_000_000, name: "image" }, true), null);
    assert.match(validateNailPhotoFile({ type: "", size: 2_000_000, name: "notes.txt" }) ?? "", /choose a photo/);
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

describe("prepareNailPhotoUpload", () => {
  const JPEG = "data:image/jpeg;base64,converted";

  /** Fake browser steps that record which ones ran. */
  function fakeDeps(overrides: Partial<NailPhotoPrepareDeps> & { heic?: boolean } = {}) {
    const ran: string[] = [];
    const deps: NailPhotoPrepareDeps = {
      isHeicFile: async () => overrides.heic ?? false,
      downscaleToJpeg: async () => {
        ran.push("native");
        return JPEG;
      },
      heicToJpeg: async () => {
        ran.push("heic");
        return JPEG;
      },
      readOriginal: async () => {
        ran.push("original");
        return "data:image/heic;base64,original";
      },
      ...overrides,
    };
    return { deps, ran };
  }
  const cannotDecode = async () => {
    throw new Error("Couldn't read that image in this browser. Try a JPEG or PNG.");
  };

  it("re-encodes ordinary photos natively and never loads the HEIC decoder", async () => {
    const { deps, ran } = fakeDeps();
    assert.equal(await prepareNailPhotoUpload(new File(["x"], "a.jpg", { type: "image/jpeg" }), deps), JPEG);
    assert.deepEqual(ran, ["native"]);
  });

  it("uses the browser's own HEIC decoder when it has one (Safari)", async () => {
    const { deps, ran } = fakeDeps({ heic: true });
    await prepareNailPhotoUpload(new File(["x"], "IMG.HEIC", { type: "image/heic" }), deps);
    assert.deepEqual(ran, ["native"]);
  });

  it("converts HEIC the browser can't decode, instead of sending it as-is", async () => {
    const { deps, ran } = fakeDeps({ heic: true, downscaleToJpeg: cannotDecode });
    assert.equal(await prepareNailPhotoUpload(new File(["x"], "IMG.HEIC", { type: "image/heic" }), deps), JPEG);
    assert.deepEqual(ran, ["heic"]);
  });

  it("converts untyped HEIC without trying a native decode", async () => {
    const { deps, ran } = fakeDeps({ heic: true });
    await prepareNailPhotoUpload(new File(["x"], "IMG_0042.HEIC", { type: "" }), deps);
    assert.deepEqual(ran, ["heic"]);
  });

  it("surfaces the converter's message and never falls back to uploading the HEIC", async () => {
    const { deps, ran } = fakeDeps({
      heic: true,
      downscaleToJpeg: cannotDecode,
      heicToJpeg: async () => {
        throw new HeicConversionError();
      },
    });
    await assert.rejects(
      prepareNailPhotoUpload(new File(["x"], "IMG.HEIC", { type: "image/heic" }), deps),
      /Couldn't convert that HEIC photo/
    );
    assert.deepEqual(ran, []);
  });

  it("falls back to the original bytes for other accepted types the browser can't decode", async () => {
    const { deps, ran } = fakeDeps({ downscaleToJpeg: cannotDecode });
    await prepareNailPhotoUpload(new File(["x"], "a.webp", { type: "image/webp" }), deps);
    assert.deepEqual(ran, ["original"]);
  });

  it("rejects non-images before doing any work", async () => {
    const { deps, ran } = fakeDeps();
    await assert.rejects(prepareNailPhotoUpload(new File(["x"], "a.pdf", { type: "application/pdf" }), deps), /choose a photo/);
    assert.deepEqual(ran, []);
  });
});
