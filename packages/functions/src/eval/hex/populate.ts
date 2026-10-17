#!/usr/bin/env node
/**
 * Populate `color_training_sample` from ingested shades whose vendor hex is
 * present and not a known placeholder, then export the samples as an eval
 * fixture.
 *
 *   npm run eval:hex:populate --workspace=swatchwatch-functions
 *   npm run eval:hex:populate --workspace=swatchwatch-functions -- --source HoloTacoShopify,MooncatShopify --limit 200
 *   npm run eval:hex:populate --workspace=swatchwatch-functions -- --export-only --status approved
 *
 * Needs Postgres (PG* vars, loaded from local.settings.json when present) and
 * migration 20261016040629000_add-color-training-sample.sql. Candidate shades are matched to their latest external_product
 * row (same brand + shade name) so the fixture can reference the vendor's
 * public product image rather than a private blob.
 */
import { promises as fs } from "fs";
import path from "path";
import { CANONICAL_FINISHES } from "swatchwatch-shared";
import { normalizeHex } from "../../lib/color-match";
import { closePool, query } from "../../lib/db";
import { isSuspiciousHex } from "../../lib/suspicious-hex";
import { EVAL_PATHS, loadLocalSettings } from "./env";
import type { EvalCase, EvalCaseImageRef, EvalFixture, GroundTruthSource } from "./types";

// ── Pure candidate selection ────────────────────────────────────────────────

/** One shade ↔ external product pair read from the DB. */
export interface TrainingCandidateRow {
  externalProductId: number;
  dataSourceId: number;
  sourceName: string;
  externalId: string | null;
  brand: string;
  shadeName: string;
  vendorHex: string | null;
  primaryImageUrl: string | null;
  imageUrls: string[] | null;
  /** `normalized_json.images` (`{url, alt, position}`) when the connector stored it. */
  images?: unknown;
  productHandle: string | null;
  productName: string | null;
}

/** One `color_training_sample.image_urls` entry; alt/position only when known. */
export interface TrainingSampleImage {
  url: string;
  is_primary: boolean;
  alt?: string;
  position?: number;
}

/** Row written to `color_training_sample`. */
export interface TrainingSampleInput {
  dataSourceId: number;
  externalProductId: number;
  hex: string;
  colorName: string;
  brandName: string;
  productName: string | null;
  productHandle: string | null;
  imageUrls: TrainingSampleImage[];
  sourceType: "vendor_option";
  notes: string;
}

export type CandidateRejection = "invalid_hex" | "suspicious_hex" | "no_image";

export interface CandidateSelection {
  accepted: TrainingSampleInput[];
  rejected: Array<{ row: TrainingCandidateRow; reason: CandidateRejection }>;
}

/** `{url → {alt, position}}` from a connector's `normalized.images`. */
function imageMetadataByUrl(images: unknown): Map<string, { alt?: string; position?: number }> {
  const byUrl = new Map<string, { alt?: string; position?: number }>();
  if (!Array.isArray(images)) return byUrl;
  for (const entry of images) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const url = typeof row.url === "string" ? row.url.trim() : "";
    if (!url || byUrl.has(url)) continue;
    const alt = typeof row.alt === "string" && row.alt.trim() ? row.alt.trim() : undefined;
    const position =
      typeof row.position === "number" && Number.isInteger(row.position) && row.position > 0 ? row.position : undefined;
    byUrl.set(url, { ...(alt ? { alt } : {}), ...(position ? { position } : {}) });
  }
  return byUrl;
}

/** Keep candidates with a real-looking vendor hex and a public product image. Pure. */
export function selectTrainingCandidates(rows: TrainingCandidateRow[]): CandidateSelection {
  const accepted: TrainingSampleInput[] = [];
  const rejected: CandidateSelection["rejected"] = [];

  for (const row of rows) {
    const hex = normalizeHex(row.vendorHex);
    if (!hex) {
      rejected.push({ row, reason: "invalid_hex" });
      continue;
    }
    if (isSuspiciousHex(hex)) {
      rejected.push({ row, reason: "suspicious_hex" });
      continue;
    }
    const primary = row.primaryImageUrl?.trim() || row.imageUrls?.find((url) => url.trim()) || null;
    if (!primary) {
      rejected.push({ row, reason: "no_image" });
      continue;
    }
    const extras = (row.imageUrls ?? []).map((url) => url.trim()).filter((url) => url && url !== primary);
    const metadata = imageMetadataByUrl(row.images);
    const withMetadata = (url: string, isPrimary: boolean): TrainingSampleImage => ({
      url,
      is_primary: isPrimary,
      ...(metadata.get(url) ?? {}),
    });
    accepted.push({
      dataSourceId: row.dataSourceId,
      externalProductId: row.externalProductId,
      hex,
      colorName: row.shadeName,
      brandName: row.brand,
      productName: row.productName,
      productHandle: row.productHandle,
      imageUrls: [withMetadata(primary, true), ...extras.map((url) => withMetadata(url, false))],
      sourceType: "vendor_option",
      notes: `shade.vendor_hex via ${row.sourceName} external_id=${row.externalId ?? "?"}`,
    });
  }

  return { accepted, rejected };
}

// ── Pure export mapping ─────────────────────────────────────────────────────

/** `color_training_sample` row joined with its external product context. */
export interface TrainingSampleExportRow {
  trainingSampleId: number;
  hex: string;
  colorName: string | null;
  brandName: string | null;
  productName: string | null;
  productHandle: string | null;
  imageUrls: unknown;
  sourceType: string;
  trainingStatus: string;
  notes: string | null;
  sourceName: string | null;
  externalId: string | null;
  tags: unknown;
  finishes: unknown;
  bodyHtml: string | null;
}

const SOURCE_TYPE_TO_GROUND_TRUTH: Record<string, GroundTruthSource> = {
  vendor_option: "vendor_option",
  swatch: "swatch_measured",
  manual: "manual",
  ai_detected: "ai_detected",
};

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "") : [];
}

function primaryImageUrl(imageUrls: unknown): string | null {
  if (!Array.isArray(imageUrls)) return null;
  const entries = imageUrls.filter((e): e is { url?: unknown; is_primary?: unknown } => !!e && typeof e === "object");
  const primary = entries.find((e) => e.is_primary === true && typeof e.url === "string") ?? entries.find((e) => typeof e.url === "string");
  return primary && typeof primary.url === "string" ? primary.url : null;
}

/**
 * Every image on a training sample as fixture `images` (primary first), or []
 * when there is only the primary and nothing else worth choosing between.
 */
export function caseImagesFromTrainingSample(imageUrls: unknown): EvalCaseImageRef[] {
  if (!Array.isArray(imageUrls)) return [];
  const entries = imageUrls.filter(
    (e): e is Record<string, unknown> => !!e && typeof e === "object" && typeof (e as Record<string, unknown>).url === "string"
  );
  const ordered = [...entries.filter((e) => e.is_primary === true), ...entries.filter((e) => e.is_primary !== true)];
  const seen = new Set<string>();
  const refs: EvalCaseImageRef[] = [];
  for (const entry of ordered) {
    const url = String(entry.url).trim();
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    const alt = typeof entry.alt === "string" && entry.alt.trim() ? entry.alt.trim() : undefined;
    const position =
      typeof entry.position === "number" && Number.isInteger(entry.position) && entry.position > 0 ? entry.position : undefined;
    refs.push({ url, ...(alt ? { alt } : {}), ...(position ? { position } : {}) });
  }
  const hasMetadata = refs.some((ref) => ref.alt !== undefined || ref.position !== undefined);
  return refs.length > 1 || hasMetadata ? refs : [];
}

function stripHtml(html: string | null, maxLength = 220): string | null {
  if (!html) return null;
  const text = html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > maxLength ? `${text.slice(0, maxLength).trimEnd()}…` : text;
}

const CANONICAL_FINISH_SET: ReadonlySet<string> = new Set<string>(CANONICAL_FINISHES);

/** Finishes implied by vendor tags: `finish:<name>` tags first, else bare tags that name a built-in finish. */
export function finishesFromTags(tags: string[]): string[] {
  const lowered = tags.map((t) => t.trim().toLowerCase());
  const prefixed = lowered.filter((t) => t.startsWith("finish:")).map((t) => t.slice("finish:".length));
  const found = prefixed.length ? prefixed : lowered.filter((t) => CANONICAL_FINISH_SET.has(t));
  return [...new Set(found)];
}

/** Map a training sample row to a fixture case; null when it lacks a usable image or hex. */
export function trainingSampleToEvalCase(row: TrainingSampleExportRow): EvalCase | null {
  const hex = normalizeHex(row.hex);
  const imageUrl = primaryImageUrl(row.imageUrls);
  const brand = row.brandName?.trim();
  const shadeName = (row.colorName ?? row.productName)?.trim();
  if (!hex || !imageUrl || !brand || !shadeName) return null;

  const tags = asStringArray(row.tags);
  const images = caseImagesFromTrainingSample(row.imageUrls);
  const finishes = asStringArray(row.finishes).length ? asStringArray(row.finishes) : finishesFromTags(tags);

  return {
    id: `training-sample:${row.trainingSampleId}`,
    brand,
    shadeName,
    finishes: finishes.map((f) => f.trim().toLowerCase()).filter(Boolean),
    groundTruthHex: hex,
    groundTruthSource: SOURCE_TYPE_TO_GROUND_TRUTH[row.sourceType] ?? "manual",
    source: row.sourceName ?? "unknown",
    imageUrl,
    ...(images.length ? { images } : {}),
    description: stripHtml(row.bodyHtml),
    tags,
    externalId: row.externalId,
    notes: [row.notes, `training_status=${row.trainingStatus}`].filter(Boolean).join("; "),
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

export interface PopulateArgs {
  sources: string[] | null;
  limit: number;
  statuses: string[];
  out: string;
  exportOnly: boolean;
  dryRun: boolean;
  help: boolean;
}

export const USAGE = `Usage: eval:hex:populate -- [options]

Reads shades with a non-placeholder vendor_hex, upserts them into color_training_sample
(source_type=vendor_option, one row per external product) and exports a fixture.

Options:
  --source <names>   Only these data_source names (comma-separated), e.g. HoloTacoShopify,MooncatShopify
  --limit <n>        Max candidate rows to read (default 500)
  --status <list>    training_status values to export (default pending,approved)
  --out <path>       Fixture path (default eval/hex/fixtures/color-training-sample.json)
  --export-only      Skip the DB write; just export existing samples
  --dry-run          Report what would be written; write nothing (DB or file)
  --help             Show this help
`;

export function parsePopulateArgs(argv: string[]): PopulateArgs {
  const args: PopulateArgs = {
    sources: null,
    limit: 500,
    statuses: ["pending", "approved"],
    out: EVAL_PATHS.exportedFixture,
    exportOnly: false,
    dryRun: false,
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
      case "--source":
        args.sources = next(arg, i).split(",").map((s) => s.trim()).filter(Boolean);
        i += 1;
        break;
      case "--limit": {
        const parsed = Number.parseInt(next(arg, i), 10);
        if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("--limit must be a positive integer");
        args.limit = parsed;
        i += 1;
        break;
      }
      case "--status":
        args.statuses = next(arg, i).split(",").map((s) => s.trim()).filter(Boolean);
        i += 1;
        break;
      case "--out":
        args.out = path.resolve(next(arg, i));
        i += 1;
        break;
      case "--export-only":
        args.exportOnly = true;
        break;
      case "--dry-run":
        args.dryRun = true;
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

/**
 * Shades with a vendor hex, matched to their latest `external_product` (same brand + shade name).
 * Products with no normalized brand only fall back to "Holo Taco" when they come from
 * `HoloTacoShopify` (that connector omits the brand); from any other source they stay
 * unmatched, so a brandless product can never borrow a Holo Taco shade's identity.
 * `$1` is an optional source-name filter, `$2` the row limit.
 */
export const READ_CANDIDATES_SQL = `SELECT DISTINCT ON (s.shade_id)
       ep.external_product_id AS "externalProductId",
       ep.data_source_id AS "dataSourceId",
       ds.name AS "sourceName",
       ep.external_id AS "externalId",
       b.name_canonical AS brand,
       s.shade_name_canonical AS "shadeName",
       s.vendor_hex AS "vendorHex",
       NULLIF(ep.normalized_json ->> 'primaryImageUrl', '') AS "primaryImageUrl",
       CASE WHEN jsonb_typeof(ep.normalized_json -> 'imageUrls') = 'array'
            THEN ARRAY(SELECT jsonb_array_elements_text(ep.normalized_json -> 'imageUrls'))
            ELSE NULL END AS "imageUrls",
       ep.normalized_json -> 'images' AS images,
       ep.raw_json ->> 'handle' AS "productHandle",
       ep.raw_json ->> 'title' AS "productName"
     FROM shade s
     JOIN brand b ON b.brand_id = s.brand_id
     JOIN data_source ds
       ON ($1::text[] IS NULL OR ds.name = ANY($1::text[]))
     JOIN external_product ep
       ON ep.data_source_id = ds.data_source_id
      AND lower(COALESCE(
            NULLIF(trim(ep.normalized_json ->> 'brand'), ''),
            CASE WHEN ds.name = 'HoloTacoShopify' THEN 'Holo Taco' END
          )) = lower(b.name_canonical)
      AND lower(NULLIF(trim(ep.normalized_json ->> 'name'), '')) = lower(s.shade_name_canonical)
     WHERE s.vendor_hex IS NOT NULL
     ORDER BY s.shade_id, ep.fetched_at DESC
     LIMIT $2`;

async function readCandidates(sources: string[] | null, limit: number): Promise<TrainingCandidateRow[]> {
  const result = await query<TrainingCandidateRow>(READ_CANDIDATES_SQL, [sources, limit]);
  return result.rows;
}

/**
 * Insert one sample, or refresh an existing one for the same product + source type. Only rows
 * still `pending` are refreshed: `approved`, `rejected` and `used` rows were curated by a person
 * and are left untouched (the conflicting insert then affects 0 rows).
 */
export const UPSERT_SAMPLE_SQL = `INSERT INTO color_training_sample
         (data_source_id, external_product_id, image_urls, hex, color_name, brand_name,
          product_name, product_handle, source_type, notes)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (external_product_id, source_type) WHERE external_product_id IS NOT NULL
       DO UPDATE SET
         data_source_id = EXCLUDED.data_source_id,
         image_urls = EXCLUDED.image_urls,
         hex = EXCLUDED.hex,
         color_name = EXCLUDED.color_name,
         brand_name = EXCLUDED.brand_name,
         product_name = EXCLUDED.product_name,
         product_handle = EXCLUDED.product_handle,
         notes = EXCLUDED.notes,
         updated_at = now()
       WHERE color_training_sample.training_status = 'pending'`;

/** Returns the number of rows inserted or refreshed (curated rows that were skipped are not counted). */
async function upsertSamples(samples: TrainingSampleInput[]): Promise<number> {
  let written = 0;
  for (const sample of samples) {
    const result = await query(UPSERT_SAMPLE_SQL, [
      sample.dataSourceId,
      sample.externalProductId,
      JSON.stringify(sample.imageUrls),
      sample.hex,
      sample.colorName,
      sample.brandName,
      sample.productName,
      sample.productHandle,
      sample.sourceType,
      sample.notes,
    ]);
    written += result.rowCount ?? 0;
  }
  return written;
}

async function readSamplesForExport(sources: string[] | null, statuses: string[]): Promise<TrainingSampleExportRow[]> {
  const result = await query<TrainingSampleExportRow>(
    `SELECT cts.training_sample_id AS "trainingSampleId",
            cts.hex,
            cts.color_name AS "colorName",
            cts.brand_name AS "brandName",
            cts.product_name AS "productName",
            cts.product_handle AS "productHandle",
            cts.image_urls AS "imageUrls",
            cts.source_type AS "sourceType",
            cts.training_status AS "trainingStatus",
            cts.notes,
            ds.name AS "sourceName",
            ep.external_id AS "externalId",
            ep.normalized_json -> 'tags' AS tags,
            ep.normalized_json -> 'finishes' AS finishes,
            ep.raw_json ->> 'body_html' AS "bodyHtml"
     FROM color_training_sample cts
     LEFT JOIN data_source ds ON ds.data_source_id = cts.data_source_id
     LEFT JOIN external_product ep ON ep.external_product_id = cts.external_product_id
     WHERE cts.training_status = ANY($1::text[])
       AND ($2::text[] IS NULL OR ds.name = ANY($2::text[]))
     ORDER BY cts.brand_name, cts.color_name, cts.training_sample_id`,
    [statuses, sources]
  );
  return result.rows;
}

export async function main(argv: string[]): Promise<number> {
  let args: PopulateArgs;
  try {
    args = parsePopulateArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  loadLocalSettings();
  if (!process.env.PGHOST) {
    console.error("Postgres is not configured (PGHOST missing; copy local.settings.json.example to local.settings.json).");
    return 1;
  }

  try {
    if (!args.exportOnly) {
      const rows = await readCandidates(args.sources, args.limit);
      const selection = selectTrainingCandidates(rows);
      const reasons = selection.rejected.reduce<Record<string, number>>((acc, r) => {
        acc[r.reason] = (acc[r.reason] ?? 0) + 1;
        return acc;
      }, {});
      console.log(
        `Candidates: ${rows.length} read, ${selection.accepted.length} accepted, ${selection.rejected.length} rejected ${JSON.stringify(reasons)}`
      );
      if (args.dryRun) {
        for (const sample of selection.accepted) {
          console.log(`  would write ${sample.brandName} / ${sample.colorName} ${sample.hex} ${sample.imageUrls[0]?.url}`);
        }
      } else {
        const written = await upsertSamples(selection.accepted);
        console.log(`Upserted ${written} color_training_sample rows (source_type=vendor_option; curated non-pending rows are never overwritten)`);
      }
    }

    const exportRows = await readSamplesForExport(args.sources, args.statuses);
    const cases = exportRows.map(trainingSampleToEvalCase).filter((c): c is EvalCase => c !== null);
    const fixture: EvalFixture = {
      version: 1,
      description: `Exported from color_training_sample (status ${args.statuses.join("/")}) on ${new Date().toISOString()}`,
      cases,
    };
    console.log(`Export: ${exportRows.length} samples → ${cases.length} fixture cases`);
    if (args.dryRun) {
      console.log(`  would write ${args.out}`);
    } else if (cases.length === 0) {
      console.log("Nothing to export; fixture not written.");
    } else {
      await fs.mkdir(path.dirname(args.out), { recursive: true });
      await fs.writeFile(args.out, `${JSON.stringify(fixture, null, 2)}\n`);
      console.log(`Wrote ${args.out}`);
    }
    return 0;
  } finally {
    await closePool();
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
