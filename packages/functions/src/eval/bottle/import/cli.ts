#!/usr/bin/env node
/**
 * Bulk importer for bottle eval samples: turns a folder of bottle photos / clips into samples
 * through the admin API (`POST bottle-eval-admin/samples`, `POST …/samples/{id}/frames`).
 *
 *   API_BASE_URL=http://localhost:7071/api ADMIN_BEARER_TOKEN=dev:2 \
 *     npm run eval:bottle:import --workspace=swatchwatch-functions -- --dir ~/bottles --dry-run
 *
 * Layout (see packages/functions/README.md → "Importing bottle eval samples in bulk"):
 *   <dir>/<Brand> - <Shade name>/front.jpg, bottom.heic, glass.mov, box.png
 *   <dir>/<Brand> - <Shade name>/<take>/front.jpg …     (one sample per take, take name in notes)
 *   <dir>/labels.csv                                     (folder,shadeId,brand,shade,notes)
 *
 * Idempotent through `.bottle-eval-import.json` in each take folder. Exit 1 on config errors
 * (before anything is uploaded) or when any folder failed.
 */
import { readdir, readFile, stat } from "fs/promises";
import path from "path";
import { type BottleEvalSampleRequest, type BottleSurface } from "swatchwatch-shared";
import { loadLocalSettings } from "../../hex/env";
import { CaptureApiError, EvalConfigError } from "../api-client";
import { createImportApi, type ImportApi } from "./api";
import {
  measureSharpness,
  normalizeForUpload,
  pickClipFrames,
  readClipCandidates,
  readImage,
  toJpegDataUrl,
  ffmpegAvailable,
} from "./frames";
import {
  labelKey,
  LABELS_FILE_NAME,
  naturalCompare,
  parseLabelsCsv,
  pickExactCatalogMatch,
  planTake,
  resolveBottleLabel,
  sampleNotes,
  type LabelRow,
  type TakeLayout,
} from "./layout";
import { findSample, readManifest, surfacesToUpload, withFrame, withSample, writeManifest } from "./manifest";

export const DEFAULT_API_BASE_URL = "http://localhost:7071/api";
/** Upper bound for `--frames-per-clip` (each kept frame is its own sample). */
export const MAX_FRAMES_PER_CLIP = 10;

export interface ImportArgs {
  dir: string | null;
  dryRun: boolean;
  labels: string | null;
  requireCatalog: boolean;
  reset: boolean;
  framesPerClip: number;
  only: string | null;
  help: boolean;
}

export const USAGE = `Usage: eval:bottle:import -- --dir <folder> [options]

Turns a folder of bottle photos or clips into bottle eval samples through the admin API.
One folder per bottle named "<Brand> - <Shade name>", files named front / bottom / glass / box
(jpg, jpeg, png, heic, webp, or mp4 / mov clips), optional take subfolders (warm/, window/, …).

Options:
  --dir <path>             Folder holding one subfolder per bottle (required)
  --dry-run                Print the plan (labels, frames, sharpness); only calls the catalog search
  --labels <file>          labels.csv (folder,shadeId,brand,shade,notes); default <dir>/labels.csv
  --require-catalog        A bottle without an exact catalog match is an error (default: external label)
  --reset                  Ignore existing .bottle-eval-import.json manifests (creates new samples)
  --frames-per-clip <n>    Keep n frames of each clip, each its own sample (default 1, max ${MAX_FRAMES_PER_CLIP})
  --only <text>            Only bottle folders whose name contains <text>
  --help                   Show this help

Clips need ffmpeg on PATH.

Environment (local.settings.json values fill unset variables):
  API_BASE_URL         Functions API base URL (default ${DEFAULT_API_BASE_URL})
  ADMIN_BEARER_TOKEN   Admin bearer token (required unless --dry-run; dev:<adminId> locally, e.g. dev:2)
`;

export function parseArgs(argv: string[]): ImportArgs {
  const args: ImportArgs = {
    dir: null,
    dryRun: false,
    labels: null,
    requireCatalog: false,
    reset: false,
    framesPerClip: 1,
    only: null,
    help: false,
  };
  const next = (flag: string, index: number): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--dir":
        args.dir = path.resolve(next(arg, i));
        i += 1;
        break;
      case "--labels":
        args.labels = path.resolve(next(arg, i));
        i += 1;
        break;
      case "--frames-per-clip": {
        const raw = next(arg, i);
        const parsed = /^\d+$/.test(raw) ? Number(raw) : NaN;
        if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_FRAMES_PER_CLIP) {
          throw new Error(`--frames-per-clip must be an integer from 1 to ${MAX_FRAMES_PER_CLIP}`);
        }
        args.framesPerClip = parsed;
        i += 1;
        break;
      }
      case "--only":
        args.only = next(arg, i);
        i += 1;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--require-catalog":
        args.requireCatalog = true;
        break;
      case "--reset":
        args.reset = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

interface BottleFolder {
  name: string;
  dir: string;
  takes: Array<{ dir: string; layout: TakeLayout }>;
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/** List the bottle folders and their takes (files directly in a bottle folder are the default take). */
export async function scanBottles(root: string): Promise<BottleFolder[]> {
  const bottles: BottleFolder[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).sort((a, b) => naturalCompare(a.name, b.name))) {
    const dir = path.join(root, entry.name);
    const inner = await readdir(dir, { withFileTypes: true });
    const files = inner.filter((e) => e.isFile()).map((e) => e.name);
    const takes: BottleFolder["takes"] = [];
    const rootTake = planTake(null, files);
    if (rootTake.surfaces.length > 0 || rootTake.ignored.length > 0) takes.push({ dir, layout: rootTake });
    for (const sub of inner.filter((e) => e.isDirectory() && !e.name.startsWith(".")).sort((a, b) => naturalCompare(a.name, b.name))) {
      const takeDir = path.join(dir, sub.name);
      const takeFiles = (await readdir(takeDir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name);
      takes.push({ dir: takeDir, layout: planTake(sub.name, takeFiles) });
    }
    bottles.push({ name: entry.name, dir, takes });
  }
  return bottles;
}

/** The label a bottle is imported with, after the catalog lookup. */
type ResolvedLabel =
  | { kind: "catalog"; shadeId: string; display: string; notes: string | null }
  | { kind: "external"; brand: string; shade: string; display: string; notes: string | null };

function requestFor(label: ResolvedLabel, notes: string | null): BottleEvalSampleRequest {
  const body: BottleEvalSampleRequest =
    label.kind === "catalog" ? { shadeId: label.shadeId } : { brandText: label.brand, shadeText: label.shade };
  if (notes) body.notes = notes;
  return body;
}

async function resolveLabel(
  api: ImportApi,
  folder: string,
  row: LabelRow | undefined,
  options: { requireCatalog: boolean; dryRun: boolean }
): Promise<{ label: ResolvedLabel; message: string }> {
  const label = resolveBottleLabel(folder, row);
  if (!label) {
    throw new Error(`no label: name the folder "<Brand> - <Shade name>" or add it to ${LABELS_FILE_NAME}`);
  }
  if (label.kind === "shadeId") {
    if (options.dryRun) {
      return {
        label: { kind: "catalog", shadeId: label.shadeId, display: `catalog #${label.shadeId}`, notes: label.notes },
        message: `catalog #${label.shadeId} (from ${label.source}; not checked in a dry run)`,
      };
    }
    const shade = await api.getShade(label.shadeId);
    if (!shade) throw new Error(`shadeId ${label.shadeId} from ${label.source} is not in the catalog`);
    const display = `catalog #${shade.shadeId} (${shade.brand} / ${shade.name})`;
    return { label: { kind: "catalog", shadeId: shade.shadeId, display, notes: label.notes }, message: `${display} from ${label.source}` };
  }

  const hits = await api.searchCatalog(`${label.brand} ${label.shade}`);
  const match = pickExactCatalogMatch(hits, label.brand, label.shade);
  if (match.kind === "match") {
    const display = `catalog #${match.hit.shadeId} (${match.hit.brand} / ${match.hit.name})`;
    return {
      label: { kind: "catalog", shadeId: match.hit.shadeId, display, notes: label.notes },
      message: `${display}, exact match for "${label.brand} / ${label.shade}" (${label.source})`,
    };
  }
  const why =
    match.kind === "ambiguous"
      ? `${match.hits.length} catalog shades match exactly (#${match.hits.map((h) => h.shadeId).join(", #")}); set shadeId in ${LABELS_FILE_NAME}`
      : `no exact catalog match among ${hits.length} search hit(s)`;
  if (options.requireCatalog) throw new Error(`"${label.brand} / ${label.shade}": ${why} (--require-catalog)`);
  const display = `external "${label.brand} / ${label.shade}"`;
  return {
    label: { kind: "external", brand: label.brand, shade: label.shade, display, notes: label.notes },
    message: `${display} (${label.source}; ${why})`,
  };
}

/** A frame ready to upload, or described in the dry run. */
interface PreparedFrame {
  surface: BottleSurface;
  source: string;
  sharpness: number;
  /** Candidate sharpness scores of a clip (time → score), for the dry run. */
  candidates?: Array<{ time: number; sharpness: number }>;
  dataUrl: string;
}

/**
 * Prepare the frames of the given surfaces. A photo gives the same frame to every variant; a clip
 * gives its k-th kept frame to variant k. Returns per variant (index 0 = variant 1).
 */
async function prepareFrames(
  takeDir: string,
  layout: TakeLayout,
  surfaces: ReadonlySet<BottleSurface>,
  variants: number,
  framesPerClip: number
): Promise<Array<Map<BottleSurface, PreparedFrame>>> {
  const perVariant = Array.from({ length: variants }, () => new Map<BottleSurface, PreparedFrame>());
  for (const entry of layout.surfaces) {
    if (!surfaces.has(entry.surface)) continue;
    const file = path.join(takeDir, entry.file);
    if (entry.kind === "image") {
      const raw = await readImage(file);
      const normalized = await normalizeForUpload(raw);
      const frame: PreparedFrame = {
        surface: entry.surface,
        source: entry.file,
        sharpness: await measureSharpness(normalized.bytes),
        dataUrl: toJpegDataUrl(normalized.bytes),
      };
      for (const map of perVariant) map.set(entry.surface, frame);
      continue;
    }
    const candidates = await readClipCandidates(file, framesPerClip);
    const kept = pickClipFrames(candidates, framesPerClip);
    const scores = candidates.map((c) => ({ time: c.time, sharpness: c.sharpness }));
    for (let k = 0; k < variants && k < kept.length; k += 1) {
      const normalized = await normalizeForUpload(kept[k].image);
      perVariant[k].set(entry.surface, {
        surface: entry.surface,
        source: `${entry.file}@${kept[k].time.toFixed(3)}s`,
        sharpness: kept[k].sharpness,
        candidates: scores,
        dataUrl: toJpegDataUrl(normalized.bytes),
      });
    }
  }
  return perVariant;
}

interface FolderSummary {
  folder: string;
  label: string;
  takes: number;
  created: number;
  existing: number;
  frames: number;
  status: "ok" | "dry-run" | "failed";
  detail: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatSharpness(value: number): string {
  return value >= 100 ? value.toFixed(0) : value.toFixed(1);
}

async function importBottle(
  api: ImportApi,
  bottle: BottleFolder,
  labels: Map<string, LabelRow>,
  args: ImportArgs,
  log: (line: string) => void
): Promise<FolderSummary> {
  const summary: FolderSummary = {
    folder: bottle.name,
    label: "-",
    takes: bottle.takes.length,
    created: 0,
    existing: 0,
    frames: 0,
    status: args.dryRun ? "dry-run" : "ok",
    detail: "",
  };
  log(`\n▸ ${bottle.name}`);
  let label: ResolvedLabel;
  try {
    const resolved = await resolveLabel(api, bottle.name, labels.get(labelKey(bottle.name)), args);
    label = resolved.label;
    summary.label = label.kind === "catalog" ? `#${label.shadeId}` : "external";
    log(`  label: ${resolved.message}`);
  } catch (error) {
    log(`  label: ✗ ${errorMessage(error)}`);
    return { ...summary, status: "failed", detail: errorMessage(error) };
  }
  if (bottle.takes.length === 0) {
    log("  no files");
    return { ...summary, status: "failed", detail: "no front/bottom/glass/box files" };
  }

  for (const { dir: takeDir, layout } of bottle.takes) {
    const takeName = layout.take ?? "(default)";
    for (const ignored of layout.ignored) log(`  take ${takeName}: ignoring ${ignored.file} (${ignored.reason})`);
    if (layout.surfaces.length === 0) {
      log(`  take ${takeName}: no surface files, skipped`);
      continue;
    }
    const hasClip = layout.surfaces.some((entry) => entry.kind === "clip");
    const variants = hasClip ? args.framesPerClip : 1;
    const planned = layout.surfaces.map((entry) => entry.surface);

    let manifest;
    try {
      manifest = await readManifest(takeDir, bottle.name, layout.take, args.reset);
    } catch (error) {
      log(`  take ${takeName}: ✗ ${errorMessage(error)}`);
      return { ...summary, status: "failed", detail: errorMessage(error) };
    }

    const needed = new Set<BottleSurface>();
    for (let variant = 1; variant <= variants; variant += 1) {
      for (const surface of surfacesToUpload(manifest, variant, planned)) needed.add(surface);
    }
    if (needed.size === 0) {
      summary.existing += variants;
      log(`  take ${takeName}: up to date (${variants} sample(s) in ${path.basename(takeDir)}/.bottle-eval-import.json)`);
      continue;
    }

    let prepared: Array<Map<BottleSurface, PreparedFrame>>;
    try {
      prepared = await prepareFrames(takeDir, layout, needed, variants, args.framesPerClip);
    } catch (error) {
      log(`  take ${takeName}: ✗ ${errorMessage(error)}`);
      return { ...summary, status: "failed", detail: `${takeName}: ${errorMessage(error)}` };
    }

    for (let variant = 1; variant <= variants; variant += 1) {
      const notes = sampleNotes({
        labelNotes: label.notes,
        take: layout.take,
        clipFrame: hasClip ? { index: variant, total: variants } : null,
      });
      const recorded = findSample(manifest, variant);
      const toUpload = surfacesToUpload(manifest, variant, planned).filter((surface) => prepared[variant - 1].has(surface));
      const header = `  take ${takeName}${variants > 1 ? ` [${variant}/${variants}]` : ""}`;
      if (recorded) {
        summary.existing += 1;
        if (recorded.label && recorded.label !== label.display) {
          log(`${header}: note: sample ${recorded.sampleId} was labelled ${recorded.label}; it keeps that label (--reset re-imports)`);
        }
      }
      if (toUpload.length === 0) {
        log(`${header}: up to date (sample ${recorded?.sampleId ?? "?"})`);
        continue;
      }
      log(
        `${header}: ${recorded ? `add to sample ${recorded.sampleId}` : "new sample"}${notes ? ` · notes "${notes}"` : ""}`
      );
      for (const surface of toUpload) {
        const frame = prepared[variant - 1].get(surface)!;
        const candidates = frame.candidates
          ? ` (sharpest of ${frame.candidates.length}: ${frame.candidates.map((c) => `${c.time.toFixed(1)}s=${formatSharpness(c.sharpness)}`).join(" ")})`
          : "";
        log(`    ${surface.padEnd(6)} ← ${frame.source} sharpness ${formatSharpness(frame.sharpness)}${candidates}`);
      }
      if (args.dryRun) continue;

      try {
        let sampleId = recorded?.sampleId;
        if (!sampleId) {
          sampleId = await api.createSample(requestFor(label, notes));
          manifest = withSample(manifest, { variant, sampleId, label: label.display, notes });
          await writeManifest(takeDir, manifest);
          summary.created += 1;
          log(`    created sample ${sampleId}`);
        }
        for (const surface of toUpload) {
          const frame = prepared[variant - 1].get(surface)!;
          const frameId = await api.addFrame(sampleId, { surface, image: frame.dataUrl });
          manifest = withFrame(manifest, variant, { surface, source: frame.source, frameId });
          await writeManifest(takeDir, manifest);
          summary.frames += 1;
        }
        log(`    uploaded ${toUpload.join(", ")}`);
      } catch (error) {
        const hint =
          error instanceof CaptureApiError && error.status === 404 && recorded
            ? ` (sample ${recorded.sampleId} may have been deleted; re-run with --reset --only "${bottle.name}")`
            : "";
        log(`    ✗ ${errorMessage(error)}${hint}`);
        // Stop this bottle; the manifest already records everything that was uploaded.
        return { ...summary, status: "failed", detail: `${takeName}: ${errorMessage(error)}${hint}` };
      }
    }
  }
  return summary;
}

export function formatSummaryTable(rows: readonly FolderSummary[]): string {
  const header = ["folder", "label", "takes", "created", "existing", "frames", "status"];
  const body = rows.map((row) => [
    row.folder,
    row.label,
    String(row.takes),
    String(row.created),
    String(row.existing),
    String(row.frames),
    row.status === "failed" ? `failed: ${row.detail}` : row.status,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => (i === 6 ? 0 : r[i].length))));
  const line = (cells: string[]) => cells.map((cell, i) => (i === 6 ? cell : cell.padEnd(widths[i]))).join("  ");
  return [line(header), line(widths.map((w, i) => "-".repeat(i === 6 ? 6 : w))), ...body.map(line)].join("\n");
}

export async function main(argv: string[], log: (line: string) => void = console.log): Promise<number> {
  let args: ImportArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(`${errorMessage(error)}\n\n${USAGE}`);
    return 1;
  }
  if (args.help) {
    log(USAGE);
    return 0;
  }
  if (!args.dir) {
    console.error(`--dir is required\n\n${USAGE}`);
    return 1;
  }
  if (!(await isDirectory(args.dir))) {
    console.error(`--dir ${args.dir} is not a folder`);
    return 1;
  }

  loadLocalSettings();
  const baseUrl = process.env.API_BASE_URL?.trim() || DEFAULT_API_BASE_URL;
  const token = process.env.ADMIN_BEARER_TOKEN?.trim() || null;

  try {
    const labelsPath = args.labels ?? path.join(args.dir, LABELS_FILE_NAME);
    let labels = new Map<string, LabelRow>();
    try {
      labels = parseLabelsCsv(await readFile(labelsPath, "utf8"));
      log(`Labels: ${labels.size} row(s) from ${labelsPath}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (args.labels) throw new EvalConfigError(`--labels ${labelsPath} does not exist`);
    }

    let bottles = await scanBottles(args.dir);
    if (args.only) {
      const needle = args.only.toLowerCase();
      bottles = bottles.filter((bottle) => bottle.name.toLowerCase().includes(needle));
    }
    if (bottles.length === 0) {
      log(`No bottle folders in ${args.dir}${args.only ? ` matching "${args.only}"` : ""}`);
      return 0;
    }
    const hasClips = bottles.some((b) => b.takes.some((t) => t.layout.surfaces.some((s) => s.kind === "clip")));
    if (hasClips && !(await ffmpegAvailable())) {
      throw new EvalConfigError("Some surfaces are video clips, which need ffmpeg on PATH (macOS: brew install ffmpeg)");
    }

    const api = createImportApi(baseUrl, token);
    if (!args.dryRun) await api.assertAdmin();
    log(
      `${args.dryRun ? "Dry run" : "Importing"}: ${bottles.length} bottle folder(s) from ${args.dir} → ${api.baseUrl}` +
        `${args.framesPerClip > 1 ? `, ${args.framesPerClip} frames per clip` : ""}${args.reset ? ", ignoring manifests" : ""}`
    );

    const rows: FolderSummary[] = [];
    for (const bottle of bottles) rows.push(await importBottle(api, bottle, labels, args, log));

    log(`\n${formatSummaryTable(rows)}`);
    const failed = rows.filter((row) => row.status === "failed").length;
    if (failed > 0) {
      log(`\n${failed} folder(s) failed; fix them and re-run (uploaded frames are recorded and skipped).`);
      return 1;
    }
    return 0;
  } catch (error) {
    console.error(errorMessage(error));
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error);
      process.exit(1);
    }
  );
}
