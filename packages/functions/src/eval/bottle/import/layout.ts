/**
 * Pure folder-layout and label rules for `eval:bottle:import` (no file system access here; the
 * CLI lists the directories and passes names in).
 *
 * Layout: `<root>/<Brand> - <Shade name>/{front,bottom,glass,box}.<ext>`, optionally grouped in
 * take subfolders (`warm/`, `window/`, …). Files directly in the bottle folder are the default take.
 */
import { BOTTLE_SURFACES, parseCsv, type BottleSurface } from "swatchwatch-shared";

export const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "heic", "heif", "webp"] as const;
export const CLIP_EXTENSIONS = ["mp4", "mov", "m4v"] as const;
/** Written in every take folder; never treated as input. */
export const MANIFEST_FILE_NAME = ".bottle-eval-import.json";
export const LABELS_FILE_NAME = "labels.csv";

export type MediaKind = "image" | "clip";

export interface SurfaceFile {
  surface: BottleSurface;
  kind: MediaKind;
  /** File name inside the take folder. */
  file: string;
}

/** A file in a take folder classified by name. */
export type ClassifiedFile =
  | { type: "media"; surface: BottleSurface; kind: MediaKind; file: string }
  | { type: "ignored"; file: string; reason: string };

export interface TakeLayout {
  /** Take folder name; `null` for files directly in the bottle folder. */
  take: string | null;
  /** The file used for each surface (shooting order: front, bottom, glass, box). */
  surfaces: SurfaceFile[];
  /** Files not used, with why (unknown name, duplicate surface, …). */
  ignored: Array<{ file: string; reason: string }>;
}

function extensionOf(file: string): string {
  const dot = file.lastIndexOf(".");
  return dot > 0 ? file.slice(dot + 1).toLowerCase() : "";
}

function stemOf(file: string): string {
  const dot = file.lastIndexOf(".");
  return (dot > 0 ? file.slice(0, dot) : file).trim().toLowerCase();
}

/**
 * Classify one file name. The stem must be a surface name (any case), optionally followed by a
 * separator and anything (`front.jpg`, `Front.JPG`, `front-2.heic`, `glass (1).mov`, `box_lid.png`);
 * `frontal.jpg` and `myfront.jpg` are not surfaces. Hidden files, the manifest and labels.csv are
 * ignored quietly (reason `hidden` / `manifest` / `labels`).
 */
export function classifyFile(file: string): ClassifiedFile {
  if (file === MANIFEST_FILE_NAME) return { type: "ignored", file, reason: "manifest" };
  if (file.toLowerCase() === LABELS_FILE_NAME) return { type: "ignored", file, reason: "labels" };
  if (file.startsWith(".")) return { type: "ignored", file, reason: "hidden" };
  const ext = extensionOf(file);
  const kind: MediaKind | null = (IMAGE_EXTENSIONS as readonly string[]).includes(ext)
    ? "image"
    : (CLIP_EXTENSIONS as readonly string[]).includes(ext)
      ? "clip"
      : null;
  if (!kind) return { type: "ignored", file, reason: `unsupported file type${ext ? ` .${ext}` : ""}` };
  const stem = stemOf(file);
  const surface = BOTTLE_SURFACES.find((name) => stem === name || new RegExp(`^${name}[^a-z]`).test(stem));
  if (!surface) {
    return { type: "ignored", file, reason: `name does not start with a surface (${BOTTLE_SURFACES.join(", ")})` };
  }
  return { type: "media", surface, kind, file };
}

/** Natural, case-insensitive order (`front 2` before `front 10`). */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * Pick one file per surface from a take folder's file names. For a surface with several files a
 * photo beats a clip, then the first in natural order wins; the rest are listed as ignored.
 */
export function planTake(take: string | null, files: readonly string[]): TakeLayout {
  const ignored: TakeLayout["ignored"] = [];
  const bySurface = new Map<BottleSurface, SurfaceFile[]>();
  for (const file of [...files].sort(naturalCompare)) {
    const classified = classifyFile(file);
    if (classified.type === "ignored") {
      if (!["manifest", "labels", "hidden"].includes(classified.reason)) ignored.push(classified);
      continue;
    }
    const list = bySurface.get(classified.surface) ?? [];
    list.push({ surface: classified.surface, kind: classified.kind, file: classified.file });
    bySurface.set(classified.surface, list);
  }
  const surfaces: SurfaceFile[] = [];
  for (const surface of BOTTLE_SURFACES) {
    const list = bySurface.get(surface);
    if (!list || list.length === 0) continue;
    const chosen = list.find((entry) => entry.kind === "image") ?? list[0];
    surfaces.push(chosen);
    for (const entry of list) {
      if (entry !== chosen) ignored.push({ file: entry.file, reason: `another ${surface} file is used (${chosen.file})` });
    }
  }
  return { take, surfaces, ignored };
}

/** Separators between brand and shade in a folder name: a spaced hyphen, en dash or em dash. */
const LABEL_SEPARATOR = /\s+[-–—]\s+/;

export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Parse a bottle folder name `<Brand> - <Shade name>`. Splits on the first spaced hyphen (or en/em
 * dash), so a hyphenated brand (`Cirque-Colors - Kingdom`) or a shade with ` - ` in it keeps the
 * rest. Underscores count as spaces. `null` when there is no separator or either side is empty.
 */
export function parseFolderLabel(folder: string): { brand: string; shade: string } | null {
  const text = collapseWhitespace(folder.replace(/_/g, " "));
  const match = LABEL_SEPARATOR.exec(text);
  if (!match) return null;
  const brand = collapseWhitespace(text.slice(0, match.index));
  const shade = collapseWhitespace(text.slice(match.index + match[0].length));
  return brand && shade ? { brand, shade } : null;
}

/** One `labels.csv` row (blank cells are `null`). */
export interface LabelRow {
  folder: string;
  shadeId: string | null;
  brand: string | null;
  shade: string | null;
  notes: string | null;
}

const LABEL_COLUMNS = ["folder", "shadeid", "brand", "shade", "notes"] as const;

/**
 * Parse `labels.csv` (header row required: `folder,shadeId,brand,shade,notes`, any order, any case;
 * only `folder` is required). Rows are keyed by the folder name compared case- and
 * whitespace-insensitively (`labelKey`). Throws on an unclosed quote, a missing folder column, a bad
 * shadeId or a folder listed twice.
 */
export function parseLabelsCsv(text: string): Map<string, LabelRow> {
  const { records, unterminatedQuote } = parseCsv(text);
  if (unterminatedQuote) throw new Error("labels.csv has a quoted field that is never closed");
  const rows = new Map<string, LabelRow>();
  if (records.length === 0) return rows;
  const header = records[0].map((cell) => cell.trim().toLowerCase().replace(/[\s_-]/g, ""));
  const index = Object.fromEntries(LABEL_COLUMNS.map((column) => [column, header.indexOf(column)])) as Record<
    (typeof LABEL_COLUMNS)[number],
    number
  >;
  if (index.folder < 0) throw new Error("labels.csv needs a header row with a 'folder' column");
  const cell = (record: string[], column: (typeof LABEL_COLUMNS)[number]): string | null => {
    const at = index[column];
    if (at < 0 || at >= record.length) return null;
    const value = collapseWhitespace(record[at]);
    return value ? value : null;
  };
  for (let i = 1; i < records.length; i += 1) {
    const record = records[i];
    const folder = cell(record, "folder");
    if (!folder) continue;
    const shadeId = cell(record, "shadeid");
    if (shadeId !== null && !/^\d+$/.test(shadeId)) {
      throw new Error(`labels.csv: shadeId for "${folder}" must be a positive integer id (got "${shadeId}")`);
    }
    const key = labelKey(folder);
    if (rows.has(key)) throw new Error(`labels.csv: folder "${folder}" is listed twice`);
    rows.set(key, { folder, shadeId, brand: cell(record, "brand"), shade: cell(record, "shade"), notes: cell(record, "notes") });
  }
  return rows;
}

/** Case-, width- and whitespace-insensitive comparison key for folder names, brands and shade names. */
export function labelKey(value: string): string {
  return collapseWhitespace(value.normalize("NFKC")).toLowerCase();
}

/** What a bottle folder is labelled as, before the catalog lookup. */
export type BottleLabel =
  | { kind: "shadeId"; shadeId: string; notes: string | null; source: "labels.csv" }
  | { kind: "text"; brand: string; shade: string; notes: string | null; source: "folder" | "labels.csv" };

/**
 * The label for a bottle folder. A `labels.csv` row wins field by field: its `shadeId` is used as
 * is; else its brand / shade replace the folder's (either may come from the folder). `null` when
 * neither gives both a brand and a shade.
 */
export function resolveBottleLabel(folder: string, row: LabelRow | undefined): BottleLabel | null {
  const notes = row?.notes ?? null;
  if (row?.shadeId) return { kind: "shadeId", shadeId: row.shadeId, notes, source: "labels.csv" };
  const parsed = parseFolderLabel(folder);
  const brand = row?.brand ?? parsed?.brand ?? null;
  const shade = row?.shade ?? parsed?.shade ?? null;
  if (!brand || !shade) return null;
  const fromCsv = row !== undefined && (row.brand !== null || row.shade !== null);
  return { kind: "text", brand, shade, notes, source: fromCsv ? "labels.csv" : "folder" };
}

/** A catalog search hit (`GET /api/catalog/search` `results[]`). */
export interface CatalogHit {
  shadeId: string;
  brand: string;
  name: string;
}

export type CatalogMatch =
  | { kind: "match"; hit: CatalogHit }
  | { kind: "none" }
  | { kind: "ambiguous"; hits: CatalogHit[] };

/**
 * Accept only an exact brand + shade-name match (`labelKey` equality). Several exact hits with
 * different shade ids are `ambiguous` (the caller falls back to the external label); a fuzzy hit is
 * never accepted.
 */
export function pickExactCatalogMatch(hits: readonly CatalogHit[], brand: string, shade: string): CatalogMatch {
  const wantBrand = labelKey(brand);
  const wantShade = labelKey(shade);
  const exact = hits.filter((hit) => labelKey(hit.brand) === wantBrand && labelKey(hit.name) === wantShade);
  const unique = [...new Map(exact.map((hit) => [String(hit.shadeId), hit])).values()];
  if (unique.length === 1) return { kind: "match", hit: unique[0] };
  if (unique.length > 1) return { kind: "ambiguous", hits: unique };
  return { kind: "none" };
}

/** Sample notes: the label's notes, the take name and the clip frame, joined with " · ". */
export function sampleNotes(parts: {
  labelNotes: string | null;
  take: string | null;
  clipFrame?: { index: number; total: number } | null;
}): string | null {
  const notes: string[] = [];
  if (parts.labelNotes) notes.push(parts.labelNotes);
  if (parts.take) notes.push(`take ${parts.take}`);
  if (parts.clipFrame && parts.clipFrame.total > 1) {
    notes.push(`clip frame ${parts.clipFrame.index}/${parts.clipFrame.total}`);
  }
  return notes.length > 0 ? notes.join(" · ") : null;
}
