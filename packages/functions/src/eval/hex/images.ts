import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import sharp from "sharp";
import type { CaseImage, EvalCase } from "./types";

const FETCH_TIMEOUT_MS = 30000;

const FORMAT_CONTENT_TYPES: Record<string, string> = {
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  tiff: "image/tiff",
  heif: "image/heif",
  svg: "image/svg+xml",
};

export interface LoadCaseImageOptions {
  /** Directory `imagePath` entries resolve against. */
  fixtureDir: string;
  /** When set, downloaded images are cached here (keyed by URL hash) so re-runs are offline. */
  cacheDir?: string | null;
  /** Injectable fetch for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** Content type derived from the decoded image format (`image/jpeg`, `image/png`, ...). */
export async function detectContentType(bytes: Buffer): Promise<string> {
  const { format } = await sharp(bytes).metadata();
  return (format && FORMAT_CONTENT_TYPES[format]) || "application/octet-stream";
}

export function cacheFileFor(cacheDir: string, url: string): string {
  const hash = createHash("sha1").update(url).digest("hex");
  return path.join(cacheDir, `${hash}.img`);
}

async function readCached(cacheDir: string | null | undefined, url: string): Promise<Buffer | null> {
  if (!cacheDir) return null;
  try {
    return await fs.readFile(cacheFileFor(cacheDir, url));
  } catch {
    return null;
  }
}

async function writeCached(cacheDir: string | null | undefined, url: string, bytes: Buffer): Promise<void> {
  if (!cacheDir) return;
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(cacheFileFor(cacheDir, url), bytes);
}

async function fetchBytes(url: string, fetchImpl: typeof fetch): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching ${url}`);
    }
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve a case's image to bytes (local file or cached/downloaded URL). */
export async function loadCaseImage(evalCase: EvalCase, options: LoadCaseImageOptions): Promise<CaseImage> {
  let bytes: Buffer;
  let sourceUrl: string | null = null;

  if (evalCase.imagePath) {
    const fixtureDir = path.resolve(options.fixtureDir);
    const resolved = path.resolve(fixtureDir, evalCase.imagePath);
    if (!resolved.startsWith(fixtureDir + path.sep)) {
      throw new Error(`imagePath escapes the fixture directory: ${evalCase.imagePath}`);
    }
    bytes = await fs.readFile(resolved);
  } else if (evalCase.imageUrl) {
    sourceUrl = evalCase.imageUrl;
    const cached = await readCached(options.cacheDir, sourceUrl);
    if (cached) {
      bytes = cached;
    } else {
      bytes = await fetchBytes(sourceUrl, options.fetchImpl ?? fetch);
      await writeCached(options.cacheDir, sourceUrl, bytes);
    }
  } else {
    throw new Error(`Case ${evalCase.id} has neither imageUrl nor imagePath`);
  }

  const contentType = await detectContentType(bytes);
  return {
    bytes,
    contentType,
    dataUri: `data:${contentType};base64,${bytes.toString("base64")}`,
    sourceUrl,
  };
}
