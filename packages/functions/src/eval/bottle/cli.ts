#!/usr/bin/env node
/**
 * Bottle recognition eval: replays every admin-labelled bottle eval sample through the live
 * capture API and scores the answers against the labels.
 *
 *   API_BASE_URL=http://localhost:7071/api ADMIN_BEARER_TOKEN=dev:2 \
 *     npm run eval:bottle --workspace=swatchwatch-functions -- --verbose
 *
 * Per sample: `POST capture/start` (metadata `{ source: "bottle-eval", sampleId }`), `POST
 * capture/{id}/frame` per frame (the private blob sent as a data URL, `frameType` from the frame,
 * `quality: { surface }`), the read-only `POST capture/{id}/check`, then `GET capture/{id}/status`
 * for the resolver's model-call count. When the server answers `start` with a `nextFrame` (bottle
 * flow on) the frames are sent as it asks (see `runSample`); otherwise all in shooting order.
 * `finalize` is never called, so nothing is added to the admin's collection. Prints the summary and
 * writes the JSON report to the (gitignored) results directory. Exit 1 on config, reachability or
 * admin-token errors (before any sample is loaded or any JSON written) or when any sample errored.
 */
import path from "path";
import type { CaptureFrameRequestSpec } from "swatchwatch-shared";
import { readBlobFromStorageUrl, userMediaContainer } from "../../lib/blob-storage";
import { closePool } from "../../lib/db";
import { FUNCTIONS_ROOT, loadLocalSettings } from "../hex/env";
import { assertAdminToken, assertApiReachable, createCaptureApi, EvalConfigError, type CaptureApi } from "./api-client";
import { formatSummary, writeReportJson } from "./report";
import { loadEvalSamples } from "./samples";
import { candidateShadeId, classifyOutcome, modelCallsFromStatus, summarize } from "./scoring";
import type { EvalSample, SampleResult } from "./types";

export const DEFAULT_API_BASE_URL = "http://localhost:7071/api";
export const DEFAULT_RESULTS_DIR = path.join(FUNCTIONS_ROOT, "eval", "bottle", "results");

export interface CliArgs {
  limit: number | null;
  only: string | null;
  verbose: boolean;
  resultsDir: string;
  help: boolean;
}

export const USAGE = `Usage: eval:bottle -- [options]

Replays every bottle eval sample through the capture API (start → frames → read-only check →
status) and scores the verdict against the label. Frames follow the server's prompts when it
sends them.

Options:
  --limit <n>            Only the newest n samples (after --only)
  --only <text>          Only samples whose brand or shade name contains <text>
  --verbose              Also print the per-sample table
  --results-dir <path>   Where the report JSON is written (default: eval/bottle/results, gitignored)
  --help                 Show this help

Environment (local.settings.json values fill unset variables):
  API_BASE_URL               Functions API base URL (default ${DEFAULT_API_BASE_URL})
  ADMIN_BEARER_TOKEN         Admin bearer token (required; dev:<adminId> locally, e.g. dev:2)
  PG*                        Postgres the samples are read from
  AZURE_STORAGE_CONNECTION   Storage account holding the private frames
`;

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { limit: null, only: null, verbose: false, resultsDir: DEFAULT_RESULTS_DIR, help: false };
  const next = (flag: string, index: number): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--limit": {
        const raw = next(arg, i);
        const parsed = /^\d+$/.test(raw) ? Number(raw) : NaN;
        if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("--limit must be a positive integer");
        args.limit = parsed;
        i += 1;
        break;
      }
      case "--only":
        args.only = next(arg, i);
        i += 1;
        break;
      case "--verbose":
      case "-v":
        args.verbose = true;
        break;
      case "--results-dir":
        args.resultsDir = path.resolve(next(arg, i));
        i += 1;
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

/** Read a private frame blob and return it as a `data:` URL for `capture/{id}/frame`. */
export async function readFrameDataUrl(storageUrl: string): Promise<string> {
  const blob = await readBlobFromStorageUrl(storageUrl, { allowedContainers: [userMediaContainer()] });
  const contentType = blob.contentType.toLowerCase().startsWith("image/") ? blob.contentType : "image/jpeg";
  return `data:${contentType};base64,${blob.bytes.toString("base64")}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Index of the first unsent frame of the requested surface, else of the first unsent frame; -1 when none are left. */
function pickFrameIndex(frames: EvalSample["frames"], sent: ReadonlySet<number>, surface: CaptureFrameRequestSpec["surface"]): number {
  const unsent = frames.map((_, index) => index).filter((index) => !sent.has(index));
  return unsent.find((index) => frames[index].surface === surface) ?? unsent[0] ?? -1;
}

/**
 * Run one sample through the capture API. A sample without frames is `skipped_no_frames` and makes
 * no API call; any API or blob failure is recorded as `error` (never thrown).
 *
 * Adaptive when `start` returns a `nextFrame`: send the sample's first unsent frame of the
 * requested surface (the next unsent frame when it has none of that surface), then follow each
 * frame response's `nextFrame` until it is null or the frames run out. Without a `nextFrame` on
 * start, all frames are sent in position order. `status` is read once after `check` for the
 * resolver's model calls; a failed read leaves `modelCalls` null and is not an error.
 */
export async function runSample(
  api: CaptureApi,
  sample: EvalSample,
  readFrame: (storageUrl: string) => Promise<string> = readFrameDataUrl
): Promise<SampleResult> {
  const base = {
    sampleId: sample.sampleId,
    brand: sample.brand,
    shadeName: sample.shadeName,
    inCatalog: sample.shadeId !== null,
    finishFamily: sample.finishFamily,
  };
  if (sample.frames.length === 0) {
    return {
      ...base,
      outcome: "skipped_no_frames",
      status: "skipped",
      topEntityId: null,
      candidateIds: [],
      frames: 0,
      ms: 0,
      modelCalls: null,
      promptsFollowed: 0,
      adaptive: false,
      createCard: false,
    };
  }

  const startedAt = Date.now();
  let sent = 0;
  let promptsFollowed = 0;
  let adaptive = false;
  try {
    const started = await api.start({ source: "bottle-eval", sampleId: sample.sampleId });
    const captureId = started.captureId;
    const sentIndexes = new Set<number>();
    const sendFrame = async (index: number) => {
      const frame = sample.frames[index];
      sentIndexes.add(index);
      const imageBlobUrl = await readFrame(frame.storageUrl);
      const response = await api.frame(captureId, {
        imageBlobUrl,
        frameType: frame.frameType,
        quality: { surface: frame.surface },
      });
      sent += 1;
      return response.nextFrame;
    };

    if (started.nextFrame) {
      adaptive = true;
      let requested: CaptureFrameRequestSpec | null | undefined = started.nextFrame;
      while (requested) {
        const index = pickFrameIndex(sample.frames, sentIndexes, requested.surface);
        if (index < 0) break;
        promptsFollowed += 1;
        requested = await sendFrame(index);
      }
    } else {
      for (let index = 0; index < sample.frames.length; index += 1) await sendFrame(index);
    }

    const check = await api.check(captureId);
    const modelCalls = await api.status(captureId).then(modelCallsFromStatus, () => null);
    const candidates = check.candidates ?? [];
    const candidateIds = candidates.map(candidateShadeId).filter((id): id is number => id !== null);
    return {
      ...base,
      outcome: classifyOutcome(sample, check),
      status: check.outcome,
      topEntityId: candidateShadeId(check.match ?? candidates[0]),
      candidateIds,
      frames: sent,
      ms: Date.now() - startedAt,
      modelCalls,
      promptsFollowed,
      adaptive,
      createCard: check.suggestedShade !== undefined && check.suggestedShade !== null,
    };
  } catch (error) {
    return {
      ...base,
      outcome: "error",
      status: "error",
      topEntityId: null,
      candidateIds: [],
      frames: sent,
      ms: Date.now() - startedAt,
      modelCalls: null,
      promptsFollowed,
      adaptive,
      createCard: false,
      error: errorMessage(error),
    };
  }
}

export async function main(argv: string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(errorMessage(error));
    console.error(USAGE);
    return 1;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  const applied = loadLocalSettings();
  if (applied > 0) console.error(`Loaded ${applied} settings from local.settings.json`);

  // Configuration, reachability and the admin token first: nothing is loaded or written when they fail.
  let api: CaptureApi;
  try {
    api = createCaptureApi(process.env.API_BASE_URL?.trim() || DEFAULT_API_BASE_URL, process.env.ADMIN_BEARER_TOKEN ?? "");
    if (!process.env.AZURE_STORAGE_CONNECTION?.trim()) {
      throw new EvalConfigError("AZURE_STORAGE_CONNECTION is required to read the eval frames");
    }
    userMediaContainer();
    await assertApiReachable(api);
    await assertAdminToken(api);
  } catch (error) {
    console.error(`eval:bottle: ${errorMessage(error)}`);
    return 1;
  }

  try {
    let samples: EvalSample[];
    try {
      samples = await loadEvalSamples({ limit: args.limit, only: args.only });
    } catch (error) {
      console.error(`eval:bottle: could not load samples from Postgres: ${errorMessage(error)}`);
      return 1;
    }
    if (samples.length === 0) {
      console.log(args.only ? `No bottle eval samples match "${args.only}".` : "No bottle eval samples yet.");
      return 0;
    }
    console.error(`API: ${api.baseUrl} — ${samples.length} sample(s)`);

    const results: SampleResult[] = [];
    for (const [index, sample] of samples.entries()) {
      const result = await runSample(api, sample);
      results.push(result);
      const label = `${sample.brand} — ${sample.shadeName}`;
      console.error(
        `[${index + 1}/${samples.length}] #${sample.sampleId} ${label}: ${result.outcome}` +
          `${result.error ? ` (${result.error})` : ""} ${result.ms} ms`
      );
    }

    const summary = summarize(results);
    console.log("");
    console.log(formatSummary(summary, results, args.verbose));
    const written = writeReportJson(args.resultsDir, summary, results);
    console.log(`\nReport JSON: ${written}`);
    return summary.byOutcome.error > 0 ? 1 : 0;
  } finally {
    await closePool().catch(() => undefined);
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
