import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  HeicConversionError,
  decodeHeic,
  hasHeicSignature,
  isHeicFile,
  looksLikeHeic,
  type HeicDecoder,
} from "./heic-convert";

/** First bytes of an ISO-BMFF file: box size, "ftyp", major brand, minor version. */
function ftyp(brand: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array([0, 0, 0, 24, ...Buffer.from("ftyp"), ...Buffer.from(brand), 0, 0, 0, 0]);
}

describe("looksLikeHeic", () => {
  it("matches HEIC/HEIF MIME types, case-insensitively", () => {
    for (const type of ["image/heic", "image/HEIF", "image/heic-sequence", "image/heif-sequence"]) {
      assert.equal(looksLikeHeic({ type, name: "photo" }), true, type);
    }
  });

  it("falls back to the extension when the browser reports no type", () => {
    assert.equal(looksLikeHeic({ type: "", name: "IMG_0001.HEIC" }), true);
    assert.equal(looksLikeHeic({ type: "", name: "IMG_0001.heif" }), true);
    assert.equal(looksLikeHeic({ type: "application/octet-stream", name: "IMG_0001.hif" }), true);
  });

  it("trusts a concrete non-HEIC type over the name", () => {
    assert.equal(looksLikeHeic({ type: "image/jpeg", name: "IMG_0001.heic" }), false);
    assert.equal(looksLikeHeic({ type: "image/avif", name: "photo.avif" }), false);
    assert.equal(looksLikeHeic({ type: "", name: "IMG_0001.jpg" }), false);
    assert.equal(looksLikeHeic({ type: "" }), false);
  });
});

describe("hasHeicSignature", () => {
  it("recognizes HEIC major brands", () => {
    for (const brand of ["heic", "heix", "hevc", "heim"]) assert.equal(hasHeicSignature(ftyp(brand)), true, brand);
  });

  it("rejects AVIF/generic HEIF brands, other formats and short input", () => {
    assert.equal(hasHeicSignature(ftyp("avif")), false);
    assert.equal(hasHeicSignature(ftyp("mif1")), false, "mif1 is shared with AVIF");
    assert.equal(hasHeicSignature(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), false);
    assert.equal(hasHeicSignature(ftyp("heic").subarray(0, 10)), false);
  });
});

describe("isHeicFile", () => {
  it("sniffs untyped, unnamed files", async () => {
    assert.equal(await isHeicFile(new File([ftyp("heic")], "image", { type: "" })), true);
    assert.equal(await isHeicFile(new File([ftyp("avif")], "image", { type: "" })), false);
  });

  it("does not sniff files with a concrete type", async () => {
    assert.equal(await isHeicFile(new File([ftyp("heic")], "image", { type: "image/png" })), false);
    assert.equal(await isHeicFile(new File([new Uint8Array(4)], "IMG.HEIC", { type: "image/heic" })), true);
  });
});

describe("decodeHeic", () => {
  const bitmap = { width: 3024, height: 4032, close() {} } as unknown as ImageBitmap;

  it("decodes with the lazily loaded decoder", async () => {
    let loads = 0;
    const seen: Blob[] = [];
    const load = async (): Promise<HeicDecoder> => {
      loads += 1;
      return async (blob) => {
        seen.push(blob);
        return bitmap;
      };
    };
    const file = new File([ftyp("heic")], "IMG.HEIC", { type: "image/heic" });
    assert.equal(await decodeHeic(file, load), bitmap);
    assert.equal(loads, 1);
    assert.deepEqual(seen, [file]);
  });

  it("maps a decoder that can't load to a connection message", async () => {
    await assert.rejects(
      decodeHeic(new Blob([]), async () => {
        throw new Error("ChunkLoadError");
      }),
      (error: unknown) => error instanceof HeicConversionError && /converter/.test(error.message)
    );
  });

  it("maps an undecodable file to a JPEG hint", async () => {
    await assert.rejects(
      decodeHeic(new Blob([]), async () => async () => {
        throw new Error("libheif: unsupported");
      }),
      (error: unknown) => error instanceof HeicConversionError && /JPEG/.test(error.message)
    );
  });
});
