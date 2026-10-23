import { parseBottleSurface, type CaptureFrameType } from "swatchwatch-shared";
import { SAMPLE_COLUMNS_SQL, SELECT_FRAMES_SQL, type FrameRow, type SampleRow } from "../../lib/bottle-eval";
import { query } from "../../lib/db";
import type { EvalSample } from "./types";

const FRAME_TYPES: ReadonlySet<string> = new Set<CaptureFrameType>(["barcode", "label", "color", "other"]);

/** `%`, `_` and `\` in a user substring are literal in ILIKE. */
function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/**
 * Samples newest first (`$1` = ILIKE pattern on brand or shade name, or NULL; `$2` = limit or NULL),
 * with the same brand/shade names as the admin list (catalog names for catalog samples).
 */
export const SELECT_EVAL_SAMPLES_SQL = `
  SELECT sample.*
  FROM (${SAMPLE_COLUMNS_SQL}) sample
  WHERE ($1::text IS NULL OR sample.brand ILIKE $1 OR sample."shadeName" ILIKE $1)
  ORDER BY sample."sampleId"::bigint DESC
  LIMIT $2::int`;

function toId(value: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`Unexpected id from the database: ${value}`);
  return id;
}

/** Pure: rows → `EvalSample[]` in row order, each with its frames in the order of `frames`. */
export function toEvalSamples(rows: SampleRow[], frames: FrameRow[]): EvalSample[] {
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
  const rows = await query<SampleRow>(SELECT_EVAL_SAMPLES_SQL, [only, opts.limit]);
  if (rows.rows.length === 0) return [];
  const frames = await query<FrameRow>(SELECT_FRAMES_SQL, [rows.rows.map((row) => row.sampleId)]);
  return toEvalSamples(rows.rows, frames.rows);
}
