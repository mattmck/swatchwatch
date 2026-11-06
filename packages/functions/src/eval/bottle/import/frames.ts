/**
 * Frame selection for `eval:bottle:import`: candidate timestamps in a clip, sharpness
 * (variance of the Laplacian) and which candidates to keep. The pure helpers are unit-tested;
 * `measureSharpness`, `normalizeForUpload` and the ffmpeg calls touch sharp / child processes.
 */
import { execFile, spawn } from "child_process";
import { mkdtemp, readFile, rm } from "fs/promises";
import os from "os";
import path from "path";
import sharp from "sharp";

/** Longest edge of an uploaded frame (the API re-encodes to the same bound). */
export const UPLOAD_MAX_EDGE = 2048;
const UPLOAD_JPEG_QUALITY = 90;
/** Sharpness is measured on a downscaled grey copy so photos of different sizes compare fairly. */
export const SHARPNESS_MEASURE_EDGE = 512;
/** Fewest candidate frames read from a clip. */
export const MIN_CLIP_CANDIDATES = 8;
/** Candidates per kept frame when `--frames-per-clip` is above 1. */
export const CANDIDATES_PER_KEPT_FRAME = 4;

/**
 * Variance of the 4-neighbour Laplacian over the interior pixels of a greyscale image (row-major,
 * one byte per pixel). Higher = sharper. 0 for images smaller than 3×3.
 */
export function laplacianVariance(gray: Uint8Array, width: number, height: number): number {
  if (width < 3 || height < 3 || gray.length < width * height) return 0;
  let sum = 0;
  let sumSquares = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y += 1) {
    const row = y * width;
    for (let x = 1; x < width - 1; x += 1) {
      const i = row + x;
      const value = gray[i - width] + gray[i + width] + gray[i - 1] + gray[i + 1] - 4 * gray[i];
      sum += value;
      sumSquares += value * value;
      count += 1;
    }
  }
  const mean = sum / count;
  return sumSquares / count - mean * mean;
}

/** How many candidates to read from a clip when keeping `framesPerClip` frames. */
export function candidateCount(framesPerClip: number): number {
  return Math.max(MIN_CLIP_CANDIDATES, framesPerClip * CANDIDATES_PER_KEPT_FRAME);
}

/**
 * `count` evenly spaced timestamps (seconds) in a clip of `durationSeconds`, at the centres of
 * equal slices, so the very first and last frames (often motion blur while starting or stopping
 * the recording) are skipped. Rounded to milliseconds. Empty for a non-positive duration or count.
 */
export function candidateTimestamps(durationSeconds: number, count: number): number[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || !Number.isInteger(count) || count <= 0) return [];
  return Array.from({ length: count }, (_, i) => Math.round(((durationSeconds * (i + 0.5)) / count) * 1000) / 1000);
}

export interface ScoredCandidate {
  /** Position in the clip (seconds). */
  time: number;
  sharpness: number;
}

/** Candidates sharpest first; ties keep clip order. */
export function rankBySharpness<T extends ScoredCandidate>(candidates: readonly T[]): T[] {
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => b.candidate.sharpness - a.candidate.sharpness || a.index - b.index)
    .map((entry) => entry.candidate);
}

/**
 * Keep `framesPerClip` frames: the sharpest candidate first, then the next sharpest ones that are
 * at least `span / (2 × framesPerClip)` away from every frame kept so far (span = the clip length
 * the candidates cover), so the kept frames are sharp *and* from different moments of the clip
 * (different poses) rather than neighbours of one sharp second. When too few candidates are far
 * enough apart, the sharpest remaining ones fill up. With one frame it is simply the sharpest
 * candidate. Never more frames than candidates. Returned in clip order.
 */
export function pickClipFrames<T extends ScoredCandidate>(candidates: readonly T[], framesPerClip: number): T[] {
  const wanted = Math.min(Math.max(1, Math.floor(framesPerClip)), candidates.length);
  if (wanted === 0) return [];
  const times = candidates.map((c) => c.time);
  const min = Math.min(...times);
  const max = Math.max(...times);
  const step = candidates.length > 1 ? (max - min) / (candidates.length - 1) : 0;
  const minGap = (max - min + step) / (2 * wanted);
  const ranked = rankBySharpness(candidates);
  const kept: T[] = [];
  for (const candidate of ranked) {
    if (kept.length >= wanted) break;
    if (kept.every((k) => Math.abs(k.time - candidate.time) >= minGap - 1e-9)) kept.push(candidate);
  }
  for (const candidate of ranked) {
    if (kept.length >= wanted) break;
    if (!kept.includes(candidate)) kept.push(candidate);
  }
  return kept.sort((a, b) => a.time - b.time);
}

/**
 * The clip duration (seconds) from `ffmpeg -i` stderr (`Duration: 00:01:02.50,`); `null` when
 * absent or `N/A`.
 */
export function parseFfmpegDuration(stderr: string): number | null {
  const match = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr);
  if (!match) return null;
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/** Sharpness of an encoded image (`laplacianVariance` of a ≤ 512 px greyscale copy, orientation applied). */
export async function measureSharpness(image: Buffer): Promise<number> {
  const { data, info } = await sharp(image, { failOn: "error" })
    .rotate()
    .resize({ width: SHARPNESS_MEASURE_EDGE, height: SHARPNESS_MEASURE_EDGE, fit: "inside", withoutEnlargement: true })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return laplacianVariance(data, info.width, info.height);
}

/** Decode, apply orientation, bound to 2048 px, flatten and re-encode as JPEG without metadata. */
export async function normalizeForUpload(image: Buffer): Promise<{ bytes: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(image, { failOn: "error" })
    .rotate()
    .resize({ width: UPLOAD_MAX_EDGE, height: UPLOAD_MAX_EDGE, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .toColourspace("srgb")
    .jpeg({ quality: UPLOAD_JPEG_QUALITY, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return { bytes: data, width: info.width, height: info.height };
}

export function toJpegDataUrl(bytes: Buffer): string {
  return `data:image/jpeg;base64,${bytes.toString("base64")}`;
}

function run(command: string, args: string[]): Promise<{ stdout: Buffer; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8"), code }));
  });
}

/** True when `ffmpeg` runs (`ffmpeg -version`). */
export async function ffmpegAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("ffmpeg", ["-version"], (error) => resolve(!error));
  });
}

/** Clip duration in seconds, read from `ffmpeg -i <file>`. Throws when ffmpeg reports none. */
export async function clipDuration(file: string): Promise<number> {
  const { stderr } = await run("ffmpeg", ["-hide_banner", "-i", file]);
  const duration = parseFfmpegDuration(stderr);
  if (duration === null) throw new Error(`ffmpeg could not read the duration of ${file}`);
  return duration;
}

/** One frame at `time` seconds as PNG bytes (ffmpeg applies the clip's rotation). */
export async function extractFrame(file: string, time: number): Promise<Buffer> {
  const { stdout, stderr, code } = await run("ffmpeg", [
    "-v",
    "error",
    "-ss",
    time.toFixed(3),
    "-i",
    file,
    "-frames:v",
    "1",
    "-f",
    "image2pipe",
    "-c:v",
    "png",
    "pipe:1",
  ]);
  if (code !== 0 || stdout.length === 0) {
    throw new Error(`ffmpeg could not read a frame at ${time.toFixed(3)}s of ${file}: ${stderr.trim().slice(0, 300)}`);
  }
  return stdout;
}

export interface ClipCandidate extends ScoredCandidate {
  image: Buffer;
}

/** Read `candidateCount(framesPerClip)` evenly spaced frames of a clip and score each one. */
export async function readClipCandidates(file: string, framesPerClip: number): Promise<ClipCandidate[]> {
  const duration = await clipDuration(file);
  const candidates: ClipCandidate[] = [];
  for (const time of candidateTimestamps(duration, candidateCount(framesPerClip))) {
    const image = await extractFrame(file, time);
    candidates.push({ time, image, sharpness: await measureSharpness(image) });
  }
  return candidates;
}

/**
 * Read a photo. sharp's prebuilt binaries cannot decode HEVC-coded HEIC (iPhone photos), so a
 * HEIC/HEIF that sharp rejects is converted with `sips` on macOS, else with ffmpeg.
 */
export async function readImage(file: string): Promise<Buffer> {
  const bytes = await readFile(file);
  const ext = path.extname(file).toLowerCase();
  if (ext !== ".heic" && ext !== ".heif") return bytes;
  try {
    await sharp(bytes, { failOn: "error" }).resize(8, 8).raw().toBuffer();
    return bytes;
  } catch {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bottle-eval-import-"));
    try {
      if (process.platform === "darwin") {
        const out = path.join(dir, "frame.jpg");
        const result = await run("sips", ["-s", "format", "jpeg", file, "--out", out]);
        if (result.code === 0) return await readFile(out);
      }
      const result = await run("ffmpeg", ["-v", "error", "-i", file, "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "pipe:1"]);
      if (result.code === 0 && result.stdout.length > 0) return result.stdout;
      throw new Error(`Could not decode ${file} (HEIC needs sips on macOS or an ffmpeg with HEIF support; or export it as JPEG)`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
