import { DUPE_FINISH_FAMILIES, parseBottleSurface, type CaptureFrameType } from "swatchwatch-shared";
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
 * Every bottle eval sample (all admins'), newest first, with its frames in shooting order
 * (`position`). `only` keeps samples whose brand or shade name contains it (case-insensitive);
 * `limit` keeps the newest n after that filter.
 */
export async function loadEvalSamples(opts: { limit: number | null; only: string | null }): Promise<EvalSample[]> {
  const only = opts.only?.trim() ? likePattern(opts.only.trim()) : null;
  const rows = await query<EvalSampleRow>(SELECT_EVAL_SAMPLES_SQL, [only, opts.limit]);
  if (rows.rows.length === 0) return [];
  const frames = await query<FrameRow>(SELECT_FRAMES_SQL, [rows.rows.map((row) => row.sampleId)]);
  return toEvalSamples(rows.rows, frames.rows);
}
