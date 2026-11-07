/**
 * `.bottle-eval-import.json`, written in every take folder by `eval:bottle:import`: which eval
 * sample each variant of the take became and which surfaces were uploaded to it, so a re-run skips
 * them. The merge helpers are pure (they return a new manifest); `readManifest` / `writeManifest`
 * touch the file system (the write is atomic: temp file + rename).
 */
import { readFile, rename, writeFile } from "fs/promises";
import path from "path";
import { BOTTLE_SURFACES, type BottleSurface } from "swatchwatch-shared";
import { MANIFEST_FILE_NAME } from "./layout";

export const MANIFEST_VERSION = 1;

export interface ManifestFrame {
  surface: BottleSurface;
  /** Source file name; a clip frame adds its position, e.g. `glass.mov@2.125s`. */
  source: string;
  frameId: string;
}

export interface ManifestSample {
  /** 1-based variant of the take (clip frame k of n; always 1 for photos only). */
  variant: number;
  sampleId: string;
  /** How the sample was labelled, e.g. `catalog #123 (Holo Taco Up in Smoke)` or `external Brand / Shade`. */
  label: string;
  notes: string | null;
  frames: ManifestFrame[];
}

export interface ImportManifest {
  version: number;
  /** Bottle folder name. */
  bottle: string;
  /** Take folder name, `null` for the default take. */
  take: string | null;
  samples: ManifestSample[];
}

export function emptyManifest(bottle: string, take: string | null): ImportManifest {
  return { version: MANIFEST_VERSION, bottle, take, samples: [] };
}

function isSurface(value: unknown): value is BottleSurface {
  return typeof value === "string" && (BOTTLE_SURFACES as readonly string[]).includes(value);
}

/**
 * Parse manifest JSON. Entries that do not have the expected shape are dropped (so they are
 * redone) rather than failing the run; anything that is not a version-1 manifest object throws.
 */
export function parseManifest(text: string, bottle: string, take: string | null): ImportManifest {
  const doc = JSON.parse(text) as Partial<ImportManifest> | null;
  if (!doc || typeof doc !== "object" || doc.version !== MANIFEST_VERSION || !Array.isArray(doc.samples)) {
    throw new Error(`not a version ${MANIFEST_VERSION} ${MANIFEST_FILE_NAME}`);
  }
  const samples: ManifestSample[] = [];
  for (const raw of doc.samples as unknown[]) {
    const entry = raw as Partial<ManifestSample> | null;
    if (!entry || typeof entry.sampleId !== "string" || !entry.sampleId) continue;
    if (!Number.isInteger(entry.variant) || (entry.variant as number) < 1) continue;
    if (samples.some((sample) => sample.variant === entry.variant)) continue;
    const frames = (Array.isArray(entry.frames) ? (entry.frames as unknown[]) : [])
      .map((frame) => frame as Partial<ManifestFrame> | null)
      .filter(
        (frame): frame is ManifestFrame =>
          !!frame && isSurface(frame.surface) && typeof frame.frameId === "string" && typeof frame.source === "string"
      );
    samples.push({
      variant: entry.variant as number,
      sampleId: entry.sampleId,
      label: typeof entry.label === "string" ? entry.label : "",
      notes: typeof entry.notes === "string" ? entry.notes : null,
      frames,
    });
  }
  return { version: MANIFEST_VERSION, bottle, take, samples };
}

export function findSample(manifest: ImportManifest, variant: number): ManifestSample | undefined {
  return manifest.samples.find((sample) => sample.variant === variant);
}

/** The planned surfaces that the variant's recorded sample does not have yet (all of them when there is none). */
export function surfacesToUpload(
  manifest: ImportManifest,
  variant: number,
  planned: readonly BottleSurface[]
): BottleSurface[] {
  const recorded = new Set(findSample(manifest, variant)?.frames.map((frame) => frame.surface) ?? []);
  return planned.filter((surface) => !recorded.has(surface));
}

/** Record a newly created sample for a variant (replacing any entry for that variant). */
export function withSample(
  manifest: ImportManifest,
  entry: Omit<ManifestSample, "frames">
): ImportManifest {
  const samples = manifest.samples.filter((sample) => sample.variant !== entry.variant);
  samples.push({ ...entry, frames: [] });
  samples.sort((a, b) => a.variant - b.variant);
  return { ...manifest, samples };
}

/** Record an uploaded frame on a variant's sample (one frame per surface; a newer one replaces it). Throws when the variant has no sample. */
export function withFrame(manifest: ImportManifest, variant: number, frame: ManifestFrame): ImportManifest {
  if (!findSample(manifest, variant)) throw new Error(`No sample recorded for variant ${variant}`);
  return {
    ...manifest,
    samples: manifest.samples.map((sample) =>
      sample.variant === variant
        ? { ...sample, frames: [...sample.frames.filter((f) => f.surface !== frame.surface), frame] }
        : sample
    ),
  };
}

export function manifestPath(takeDir: string): string {
  return path.join(takeDir, MANIFEST_FILE_NAME);
}

/** The take's manifest, or an empty one when the file is missing (or `reset`). Throws on an unreadable manifest. */
export async function readManifest(
  takeDir: string,
  bottle: string,
  take: string | null,
  reset = false
): Promise<ImportManifest> {
  if (reset) return emptyManifest(bottle, take);
  let text: string;
  try {
    text = await readFile(manifestPath(takeDir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyManifest(bottle, take);
    throw error;
  }
  try {
    return parseManifest(text, bottle, take);
  } catch (error) {
    throw new Error(
      `${manifestPath(takeDir)}: ${error instanceof Error ? error.message : String(error)} (fix or delete it, or pass --reset)`
    );
  }
}

export async function writeManifest(takeDir: string, manifest: ImportManifest): Promise<void> {
  const target = manifestPath(takeDir);
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await rename(temp, target);
}
