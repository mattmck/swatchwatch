import pLimit = require("p-limit");
import {
  detectHexWithAzureOpenAI,
  type HexDetectionOptions,
  type HexDetectionResult,
  type HexDetectionTokenUsage,
} from "../../../lib/ai-color-detection";
import { resolveAzureOpenAiConfig } from "../../../lib/azure-openai-config";
import { aggregateHexSamples, type HexSample } from "../../../lib/hex-ensemble";
import type { HexDetectionStrategy, StrategyInput, StrategyOutput } from "../types";

/**
 * Ensemble strategy: the production detection call repeated several times at a
 * small temperature (and optionally across more than one deployment), reduced
 * to one hex by `aggregateHexSamples` (OKLAB medoid + spread-derived confidence
 * + finish voting). Every sample is kept in `meta` so a results file shows how
 * stable the model's answer was, not just what it was.
 *
 * Configuration (read from the environment at run time, after the CLI has
 * loaded `local.settings.json`):
 * - `AZURE_OPENAI_DEPLOYMENT_HEX_ENSEMBLE` — comma-separated deployment names to
 *   sample from; unset → the single sync deployment (`AZURE_OPENAI_DEPLOYMENT_HEX`
 *   → `AZURE_OPENAI_DEPLOYMENT`).
 * - `HEX_DETECTION_ENSEMBLE_SAMPLES` — samples per deployment (default 3, 1–10).
 * - `HEX_DETECTION_ENSEMBLE_TEMPERATURE` — sampling temperature (default 0.3, 0–2).
 */

export const DEFAULT_ENSEMBLE_SAMPLES = 3;
export const DEFAULT_ENSEMBLE_TEMPERATURE = 0.3;
export const DEFAULT_ENSEMBLE_CONCURRENCY = 3;
const MAX_ENSEMBLE_SAMPLES = 10;

export interface EnsembleConfig {
  /** Samples taken from each deployment. */
  samplesPerDeployment: number;
  temperature: number;
  /** Deployment overrides; `null` entries mean "the library's default deployment". */
  deployments: Array<string | null>;
  /** Maximum in-flight detection calls per case. */
  concurrency: number;
}

export type EnsembleDetectFn = (
  imageUrlOrDataUri: string,
  options?: HexDetectionOptions
) => Promise<HexDetectionResult>;

export interface EnsembleStrategyOptions {
  /** Fixed configuration; anything omitted is read from the environment at run time. */
  config?: Partial<EnsembleConfig>;
  /** Detection function (defaults to `detectHexWithAzureOpenAI`; injectable for tests). */
  detect?: EnsembleDetectFn;
}

export interface EnsembleSampleRecord {
  index: number;
  deployment: string;
  temperature: number;
  hex: string | null;
  confidence: number | null;
  finishes: string[] | null;
  usage: HexDetectionTokenUsage | null;
  error: string | null;
  /** OKLAB distance to the medoid (0 for the medoid, null when the sample had no hex). */
  distanceToMedoid: number | null;
}

export interface EnsembleUsageByDeployment {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

function parseBoundedNumber(raw: string | undefined, fallback: number, min: number, max: number, integer = false): number {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  const parsed = integer ? Number.parseInt(trimmed, 10) : Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

/** Parse `AZURE_OPENAI_DEPLOYMENT_HEX_ENSEMBLE` (comma-separated, de-duplicated). Empty → `[null]` (library default). */
export function parseEnsembleDeployments(raw: string | undefined): Array<string | null> {
  const names = (raw ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const unique = [...new Set(names)];
  return unique.length ? unique : [null];
}

export function resolveEnsembleConfig(
  overrides: Partial<EnsembleConfig> = {},
  env: NodeJS.ProcessEnv = process.env
): EnsembleConfig {
  return {
    samplesPerDeployment:
      overrides.samplesPerDeployment ??
      parseBoundedNumber(env.HEX_DETECTION_ENSEMBLE_SAMPLES, DEFAULT_ENSEMBLE_SAMPLES, 1, MAX_ENSEMBLE_SAMPLES, true),
    temperature:
      overrides.temperature ??
      parseBoundedNumber(env.HEX_DETECTION_ENSEMBLE_TEMPERATURE, DEFAULT_ENSEMBLE_TEMPERATURE, 0, 2),
    deployments: overrides.deployments ?? parseEnsembleDeployments(env.AZURE_OPENAI_DEPLOYMENT_HEX_ENSEMBLE),
    concurrency: overrides.concurrency ?? DEFAULT_ENSEMBLE_CONCURRENCY,
  };
}

/** Name used in meta for a `null` deployment override: whatever the library would resolve. */
function defaultDeploymentLabel(): string {
  return (
    resolveAzureOpenAiConfig({ deploymentEnvKeys: ["AZURE_OPENAI_DEPLOYMENT_HEX", "AZURE_OPENAI_DEPLOYMENT"] })
      .deployment ?? "default"
  );
}

/** Suppress the library's per-call console chatter; errors still surface through the result. */
const quietLog: HexDetectionOptions["onLog"] = () => undefined;

/** Same vendor context `azure-current` forwards: what production would have had for this shade. */
function vendorContextFor(input: StrategyInput): NonNullable<HexDetectionOptions["vendorContext"]> {
  return {
    shadeName: input.evalCase.shadeName,
    vendorHex: input.evalCase.groundTruthSource === "vendor_option" ? input.evalCase.groundTruthHex : null,
    description: input.evalCase.description ?? null,
    tags: input.evalCase.tags?.length ? input.evalCase.tags : null,
  };
}

function addUsage(target: EnsembleUsageByDeployment, usage: HexDetectionTokenUsage | null | undefined): void {
  target.calls += 1;
  if (!usage) return;
  target.promptTokens += usage.promptTokens ?? 0;
  target.completionTokens += usage.completionTokens ?? 0;
  target.totalTokens += usage.totalTokens ?? 0;
}

export function createEnsembleStrategy(options: EnsembleStrategyOptions = {}): HexDetectionStrategy {
  const detect = options.detect ?? detectHexWithAzureOpenAI;

  return {
    name: "ensemble",
    description:
      "azure-current sampled N times at a small temperature (optionally across deployments), OKLAB medoid + spread confidence + finish votes",
    requiresAzureOpenAI: true,
    run: async (input): Promise<StrategyOutput> => {
      const config = resolveEnsembleConfig(options.config);
      const vendorContext = vendorContextFor(input);
      const limit = pLimit(Math.max(1, config.concurrency));

      const plan: Array<{ index: number; deployment: string | null; label: string }> = [];
      for (const deployment of config.deployments) {
        const label = deployment ?? defaultDeploymentLabel();
        for (let i = 0; i < config.samplesPerDeployment; i++) {
          plan.push({ index: plan.length, deployment, label });
        }
      }

      const records: EnsembleSampleRecord[] = await Promise.all(
        plan.map((entry) =>
          limit(async () => {
            const record: EnsembleSampleRecord = {
              index: entry.index,
              deployment: entry.label,
              temperature: config.temperature,
              hex: null,
              confidence: null,
              finishes: null,
              usage: null,
              error: null,
              distanceToMedoid: null,
            };
            try {
              const result = await detect(input.image.dataUri, {
                onLog: quietLog,
                vendorContext,
                temperature: config.temperature,
                ...(entry.deployment ? { deployment: entry.deployment } : {}),
              });
              if (result.provider === "none") {
                throw new Error("Azure OpenAI config missing");
              }
              record.hex = result.hex;
              record.confidence = result.confidence;
              record.finishes = result.finishes;
              record.usage = result.usage ?? null;
            } catch (error) {
              record.error = error instanceof Error ? error.message : String(error);
            }
            return record;
          })
        )
      );

      const errors = records.filter((record) => record.error);
      if (errors.length === records.length) {
        throw new Error(`All ${records.length} ensemble samples failed: ${errors[0].error}`);
      }

      const samples: HexSample[] = records.map((record) => ({
        hex: record.hex,
        confidence: record.confidence,
        finishes: record.finishes,
      }));
      const aggregate = aggregateHexSamples(samples);
      records.forEach((record, i) => {
        record.distanceToMedoid = aggregate.distances[i];
      });

      const usageByDeployment: Record<string, EnsembleUsageByDeployment> = {};
      for (const record of records) {
        if (record.error) continue;
        usageByDeployment[record.deployment] ??= { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
        addUsage(usageByDeployment[record.deployment], record.usage);
      }

      return {
        hex: aggregate.hex,
        confidence: aggregate.confidence,
        finishes: aggregate.finishes,
        meta: {
          samples: records,
          medoidIndex: aggregate.medoidIndex,
          spread: aggregate.spread,
          agreement: aggregate.agreement,
          votes: aggregate.votes,
          validSamples: aggregate.validCount,
          failedSamples: errors.length,
          config: {
            samplesPerDeployment: config.samplesPerDeployment,
            temperature: config.temperature,
            deployments: plan.length ? [...new Set(plan.map((entry) => entry.label))] : [],
            concurrency: config.concurrency,
          },
          usageByDeployment,
        },
      };
    },
  };
}

/** (d) The ensemble as the CLI runs it: configuration from the environment. */
export const ensembleStrategy: HexDetectionStrategy = createEnsembleStrategy();
