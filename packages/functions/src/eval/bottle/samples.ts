import { DUPE_FINISH_FAMILIES, normalizeMatchText, parseBottleSurface, type CaptureFrameType } from "swatchwatch-shared";
import { SAMPLE_COLUMNS_SQL, SELECT_FRAMES_SQL, type FrameRow, type SampleRow } from "../../lib/bottle-eval";
import { BOTTLE_POOL_PRODUCT_CATEGORIES } from "../../lib/brand-resolve";
import { query } from "../../lib/db";
import type { EvalSample } from "./types";

const FRAME_TYPES: ReadonlySet<string> = new Set<CaptureFrameType>(["barcode", "label", "color", "other"]);

/** `%`, `_` and `\` in a user substring are literal in ILIKE. */
function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/** A sample row plus what failure attribution needs about the labelled (merge-resolved) shade. */
export interface EvalSampleRow extends SampleRow {
  labelBrandId?: string | null;
  labelStatus?: string | null;
  labelCategory?: string | null;
  labelMergedIntoShadeId?: string | null;
}

/**
 * Samples newest first (`$1` = ILIKE pattern on brand or shade name, or NULL; `$2` = limit or NULL),
 * with the same brand/shade names as the admin list (catalog names for catalog samples), plus the
 * labelled shade's brand, status, category and merge target for failure attribution.
 */
export const SELECT_EVAL_SAMPLES_SQL = `
  SELECT sample.*,
         label.brand_id::text AS "labelBrandId",
         label.status AS "labelStatus",
         label.product_category AS "labelCategory",
         label.merged_into_shade_id::text AS "labelMergedIntoShadeId"
  FROM (${SAMPLE_COLUMNS_SQL}) sample
  LEFT JOIN shade label ON label.shade_id = sample."shadeId"::bigint
  WHERE ($1::text IS NULL OR sample.brand ILIKE $1 OR sample."shadeName" ILIKE $1)
  ORDER BY sample."sampleId"::bigint DESC
  LIMIT $2::int`;

/** Catalog family, else the built-in family of the finish name, else `"unknown"`; external samples are always unknown. */
function finishFamilyOf(row: SampleRow): string {
  if (row.shadeId === null || row.shadeId === undefined) return "unknown";
  const finish = row.primaryFinish?.trim().toLowerCase();
  const builtIn = finish && Object.prototype.hasOwnProperty.call(DUPE_FINISH_FAMILIES, finish) ? DUPE_FINISH_FAMILIES[finish] : null;
  return row.finishFamily || builtIn || "unknown";
}

/**
 * Whether the labelled shade can be in its brand's resolver pool (`BOTTLE_CANDIDATES_SQL`: unmerged
 * shades of a bottle category, never `accessory`, that are `active`, or the caller's own `user_submitted`). `null` when unknown: no
 * shade row was read, or a `user_submitted` shade (eligible only for its creator).
 */
export function labelPoolEligibility(row: EvalSampleRow): boolean | null {
  if (row.shadeId === null || row.shadeId === undefined || !row.labelStatus) return null;
  if (row.labelMergedIntoShadeId) return false;
  if (row.labelCategory && !(BOTTLE_POOL_PRODUCT_CATEGORIES as readonly string[]).includes(row.labelCategory)) return false;
  if (row.labelStatus === "active") return true;
  return row.labelStatus === "user_submitted" ? null : false;
}

function toId(value: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`Unexpected id from the database: ${value}`);
  return id;
}

/** Pure: rows → `EvalSample[]` in row order, each with its frames in the order of `frames`. */
export function toEvalSamples(rows: EvalSampleRow[], frames: FrameRow[]): EvalSample[] {
  const bySample = new Map<string, EvalSample["frames"]>();
  for (const frame of frames) {
    const surface = parseBottleSurface(frame.surface);
    if (!surface || !FRAME_TYPES.has(frame.frameType)) {
      throw new Error(`Frame ${frame.frameId} has an unknown surface or frame type`);
    }
    const list = bySample.get(frame.sampleId) ?? [];
    list.push({ frameId: toId(frame.frameId), surface, frameType: frame.frameType, storageUrl: frame.storageUrl });
    bySample.set(frame.sampleId, list);
  }
  return rows.map((row) => ({
    sampleId: toId(row.sampleId),
    shadeId: row.shadeId === null || row.shadeId === undefined ? null : toId(row.shadeId),
    brand: row.brand,
    shadeName: row.shadeName,
    brandId: row.labelBrandId ? toId(row.labelBrandId) : null,
    labelPoolEligible: labelPoolEligibility(row),
    finishFamily: finishFamilyOf(row),
    frames: bySample.get(row.sampleId) ?? [],
  }));
}

/**
 * Live catalog shades of the brands in `$1` (lower-cased brand names or brand aliases), with what a
 * catalog label needs: the brand's name and aliases (lower-cased), the shade's status, category,
 * first finish and its family. Merged shades are left out (their target is the live shade).
 */
export const SELECT_TEXT_LABEL_CANDIDATES_SQL = `
  SELECT sh.shade_id::text AS "shadeId",
         b.brand_id::text AS "brandId",
         b.name_canonical AS brand,
         sh.shade_name_canonical AS "shadeName",
         ARRAY(SELECT lower(ba.alias) FROM brand_alias ba WHERE ba.brand_id = b.brand_id) || lower(b.name_canonical) AS "brandKeys",
         sh.status AS "status",
         sh.product_category AS "category",
         sh.finishes[1] AS "primaryFinish",
         (SELECT MAX(ft.family) FROM finish_type ft WHERE lower(ft.name) = lower(sh.finishes[1])) AS "finishFamily"
  FROM shade sh
  JOIN brand b ON b.brand_id = sh.brand_id
  WHERE sh.merged_into_shade_id IS NULL
    AND (lower(b.name_canonical) = ANY($1::text[])
         OR EXISTS (SELECT 1 FROM brand_alias ba WHERE ba.brand_id = b.brand_id AND lower(ba.alias) = ANY($1::text[])))`;

/** One `SELECT_TEXT_LABEL_CANDIDATES_SQL` row. */
export interface TextLabelCandidate {
  shadeId: string;
  brandId: string;
  brand: string;
  shadeName: string;
  brandKeys: string[];
  status: string | null;
  category: string | null;
  primaryFinish: string | null;
  finishFamily: string | null;
}

function isTextLabel(row: SampleRow): boolean {
  return (row.shadeId === null || row.shadeId === undefined) && row.brand.trim() !== "" && row.shadeName.trim() !== "";
}

/** Lower-cased, whitespace-collapsed brand text, the form `brandKeys` holds. */
function brandKey(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Pure: a sample labelled by text (brand + shade typed at import because the bottle was not in the
 * catalog then) is re-checked against the catalog as it is now. When exactly one live shade of that
 * brand (by name or alias, case-insensitive) has the same name (`normalizeMatchText`, so case,
 * apostrophes and punctuation never matter: "I'm a Haunt Mess" = "I’m a haunt mess"), the sample is
 * scored as that catalog shade; otherwise it stays a bottle that is not in the catalog. Catalog
 * labels are never changed. `relabelled` counts the samples that now have a shade, `ambiguous` the
 * ones several shades matched (left as text).
 */
export function resolveTextLabels(
  rows: EvalSampleRow[],
  candidates: TextLabelCandidate[]
): { rows: EvalSampleRow[]; relabelled: number; ambiguous: number } {
  let relabelled = 0;
  let ambiguous = 0;
  const out = rows.map((row) => {
    if (!isTextLabel(row)) return row;
    const wantBrand = brandKey(row.brand);
    const wantName = normalizeMatchText(row.shadeName);
    if (!wantName) return row;
    const hits = new Map<string, TextLabelCandidate>();
    for (const candidate of candidates) {
      if (!candidate.brandKeys.some((key) => brandKey(key) === wantBrand)) continue;
      if (normalizeMatchText(candidate.shadeName) === wantName) hits.set(candidate.shadeId, candidate);
    }
    if (hits.size > 1) ambiguous += 1;
    if (hits.size !== 1) return row;
    const hit = [...hits.values()][0];
    relabelled += 1;
    return {
      ...row,
      shadeId: hit.shadeId,
      brand: hit.brand,
      shadeName: hit.shadeName,
      finishFamily: hit.finishFamily,
      primaryFinish: hit.primaryFinish,
      labelBrandId: hit.brandId,
      labelStatus: hit.status,
      labelCategory: hit.category,
      labelMergedIntoShadeId: null,
    };
  });
  return { rows: out, relabelled, ambiguous };
}

/**
 * Every bottle eval sample (all admins'), newest first, with its frames in shooting order
 * (`position`). `only` keeps samples whose brand or shade name contains it (case-insensitive);
 * `limit` keeps the newest n after that filter. Text labels are re-checked against the catalog
 * (`resolveTextLabels`), so a bottle ingested after it was labelled is scored as a catalog bottle.
 */
export async function loadEvalSamples(opts: {
  limit: number | null;
  only: string | null;
}): Promise<{ samples: EvalSample[]; relabelled: number; ambiguous: number }> {
  const only = opts.only?.trim() ? likePattern(opts.only.trim()) : null;
  const rows = await query<EvalSampleRow>(SELECT_EVAL_SAMPLES_SQL, [only, opts.limit]);
  if (rows.rows.length === 0) return { samples: [], relabelled: 0, ambiguous: 0 };
  const brands = [...new Set(rows.rows.filter(isTextLabel).map((row) => brandKey(row.brand)))];
  const candidates = brands.length > 0 ? (await query<TextLabelCandidate>(SELECT_TEXT_LABEL_CANDIDATES_SQL, [brands])).rows : [];
  const resolved = resolveTextLabels(rows.rows, candidates);
  const frames = await query<FrameRow>(SELECT_FRAMES_SQL, [resolved.rows.map((row) => row.sampleId)]);
  return { samples: toEvalSamples(resolved.rows, frames.rows), relabelled: resolved.relabelled, ambiguous: resolved.ambiguous };
}
