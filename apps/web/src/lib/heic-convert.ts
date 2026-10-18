/**
 * Client-side HEIC/HEIF decoding for photo uploads (#318, decision D9). iPhones save HEIC by
 * default, most browsers other than Safari cannot decode it, and the server answers 415 for HEIC
 * its bundled libvips can't read. So uploads that look like HEIC are decoded in the browser with
 * `heic-to` (libheif compiled to WebAssembly, ~3 MB), which is loaded with a dynamic `import()` the
 * first time it is needed and never ships in the main bundle.
 */

/** MIME types browsers report for HEIC/HEIF stills and sequences (Live Photos, bursts). */
export const HEIC_MIME_TYPES = ["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"] as const;

/** File extensions used for HEIC/HEIF photos. */
export const HEIC_EXTENSIONS = [".heic", ".heif", ".hif"] as const;

/**
 * ISO-BMFF `ftyp` major brands that mean HEIC/HEIF. `mif1`/`msf1` are left out on purpose: AVIF
 * files use them too, and browsers decode AVIF natively.
 */
const HEIC_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "hevm", "hevs"]);

/** Types that carry no format information, so the name (or the bytes) has to decide. */
const UNTYPED = new Set(["", "application/octet-stream"]);

interface FileLike {
  name?: string;
  type: string;
}

function hasHeicExtension(name: string | undefined): boolean {
  const lower = (name ?? "").toLowerCase();
  return HEIC_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * True when the file is HEIC/HEIF judging by its MIME type, or, when the browser reports no
 * useful type (Chrome/Firefox on Windows and some Android pickers leave it empty), by its name.
 */
export function looksLikeHeic(file: FileLike): boolean {
  const type = file.type.trim().toLowerCase();
  if ((HEIC_MIME_TYPES as readonly string[]).includes(type)) return true;
  return UNTYPED.has(type) && hasHeicExtension(file.name);
}

/** True when the first bytes of a file are an ISO-BMFF `ftyp` box with a HEIC major brand. */
export function hasHeicSignature(head: Uint8Array): boolean {
  if (head.length < 12) return false;
  const ascii = (start: number, end: number) => String.fromCharCode(...head.subarray(start, end));
  return ascii(4, 8) === "ftyp" && HEIC_BRANDS.has(ascii(8, 12).toLowerCase());
}

async function readHead(file: Blob, bytes: number): Promise<Uint8Array> {
  const slice = file.slice(0, bytes);
  if (typeof slice.arrayBuffer === "function") {
    return new Uint8Array(await slice.arrayBuffer());
  }
  return new Uint8Array(await new Response(slice).arrayBuffer());
}

/**
 * `looksLikeHeic`, plus a 12-byte signature check for untyped files with no telling name (e.g. a
 * picker that hands over `image` with an empty type).
 */
export async function isHeicFile(file: File): Promise<boolean> {
  if (looksLikeHeic(file)) return true;
  if (!UNTYPED.has(file.type.trim().toLowerCase())) return false;
  try {
    return hasHeicSignature(await readHead(file, 12));
  } catch {
    return false;
  }
}

/** Decodes a HEIC blob to an upright `ImageBitmap`. */
export type HeicDecoder = (blob: Blob) => Promise<ImageBitmap>;

let decoderPromise: Promise<HeicDecoder> | null = null;

/** Lazily import `heic-to` (its own chunk) once per page; a failed load is retried next time. */
export function loadHeicDecoder(): Promise<HeicDecoder> {
  if (!decoderPromise) {
    decoderPromise = import("heic-to/next")
      .then(({ heicTo }) => (blob: Blob) => heicTo({ blob, type: "bitmap" }))
      .catch((error: unknown) => {
        decoderPromise = null;
        throw error;
      });
  }
  return decoderPromise;
}

/** User-presentable failure from `decodeHeic`. */
export class HeicConversionError extends Error {
  constructor(message = "Couldn't convert that HEIC photo. Try sharing it as a JPEG (Most Compatible) instead.") {
    super(message);
    this.name = "HeicConversionError";
  }
}

/**
 * Decode a HEIC/HEIF file in the browser. Loads the decoder on first use (`load` is injectable for
 * tests). Throws `HeicConversionError` when the decoder can't be loaded or can't read the file.
 */
export async function decodeHeic(file: Blob, load: () => Promise<HeicDecoder> = loadHeicDecoder): Promise<ImageBitmap> {
  let decode: HeicDecoder;
  try {
    decode = await load();
  } catch {
    throw new HeicConversionError("Couldn't load the HEIC converter. Check your connection and try again.");
  }
  try {
    return await decode(file);
  } catch {
    throw new HeicConversionError();
  }
}
