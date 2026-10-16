#!/usr/bin/env node
/**
 * Ground-truth evaluation runner for vendor-image hex detection.
 *
 *   npm run eval:hex --workspace=swatchwatch-functions -- --strategy pixel
 *   npm run eval:hex --workspace=swatchwatch-functions -- --strategy azure-current,azure-blind --verbose
 *
 * Runs each named strategy over every case in the fixture, scores the predicted
 * hex against the ground truth (OKLAB distance), prints a table and writes the
 * full report JSON to the (gitignored) results directory. Strategies that need
 * Azure OpenAI are skipped — not failed — when the config is missing.
 */
import path from "path";
import { EVAL_PATHS, loadLocalSettings } from "./env";
import { FixtureValidationError, loadFixture, type LoadedFixture } from "./fixture";
import { loadCaseImage } from "./images";
import { formatReport, writeReportJson } from "./report";
import { buildReport, scoreCase } from "./scoring";
import { getStrategy, hasAzureOpenAiConfig, STRATEGIES, strategySkipReason } from "./strategies";
import type { CaseScore, EvalReport, HexDetectionStrategy } from "./types";

export interface CliArgs {
  strategies: string[];
  fixture: string;
  resultsDir: string;
  cacheDir: string | null;
  limit: number | null;
  /** Only run cases whose id contains this substring. */
  only: string | null;
  verbose: boolean;
  listStrategies: boolean;
  help: boolean;
}

export const USAGE = `Usage: eval:hex -- --strategy <name[,name...]> [options]

Options:
  --strategy <names>     Strategy to run (repeatable or comma-separated). Use "all" for every strategy.
  --fixture <path>       Fixture JSON (default: eval/hex/fixtures/sample.json)
  --results-dir <path>   Where report JSON is written (default: eval/hex/results, gitignored)
  --cache-dir <path>     Image download cache (default: eval/hex/.cache, gitignored)
  --no-cache             Always re-download images
  --limit <n>            Only run the first n cases
  --only <text>          Only run cases whose id contains <text>
  --verbose              Also print the per-case table
  --list-strategies      Print the available strategies and exit
  --help                 Show this help

Strategies:
${STRATEGIES.map((s) => `  ${s.name.padEnd(16)} ${s.description}${s.requiresAzureOpenAI ? " [needs Azure OpenAI]" : ""}`).join("\n")}
`;

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    strategies: [],
    fixture: EVAL_PATHS.sampleFixture,
    resultsDir: EVAL_PATHS.resultsDir,
    cacheDir: EVAL_PATHS.cacheDir,
    limit: null,
    only: null,
    verbose: false,
    listStrategies: false,
    help: false,
  };

  const next = (flag: string, index: number): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--strategy":
      case "-s":
        args.strategies.push(...next(arg, i).split(",").map((s) => s.trim()).filter(Boolean));
        i += 1;
        break;
      case "--fixture":
        args.fixture = path.resolve(next(arg, i));
        i += 1;
        break;
      case "--results-dir":
        args.resultsDir = path.resolve(next(arg, i));
        i += 1;
        break;
      case "--cache-dir":
        args.cacheDir = path.resolve(next(arg, i));
        i += 1;
        break;
      case "--no-cache":
        args.cacheDir = null;
        break;
      case "--limit": {
        const parsed = Number.parseInt(next(arg, i), 10);
        if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("--limit must be a positive integer");
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
      case "--list-strategies":
        args.listStrategies = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (args.strategies.includes("all")) {
    args.strategies = STRATEGIES.map((s) => s.name);
  }
  return args;
}

export interface RunStrategyOptions {
  cacheDir: string | null;
  limit?: number | null;
  only?: string | null;
  /** Progress sink (defaults to stderr). */
  log?: (line: string) => void;
}

/** Run one strategy over the fixture and build its report. Never throws per case; errors are recorded on the score. */
export async function runStrategy(
  strategy: HexDetectionStrategy,
  loaded: LoadedFixture,
  options: RunStrategyOptions
): Promise<EvalReport> {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  let cases = loaded.fixture.cases;
  if (options.only) {
    const needle = options.only.toLowerCase();
    cases = cases.filter((evalCase) => evalCase.id.toLowerCase().includes(needle));
  }
  if (options.limit) {
    cases = cases.slice(0, options.limit);
  }

  const scores: CaseScore[] = [];
  for (const [index, evalCase] of cases.entries()) {
    const prefix = `[${strategy.name}] ${index + 1}/${cases.length} ${evalCase.id}`;
    try {
      const image = await loadCaseImage(evalCase, { fixtureDir: loaded.fixtureDir, cacheDir: options.cacheDir });
      const output = await strategy.run({ evalCase, image });
      const score = scoreCase(evalCase, output);
      scores.push(score);
      log(`${prefix}: ${score.predictedHex ?? "no hex"} vs ${score.groundTruthHex} → ${score.distance ?? "-"} (${score.bucket})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      scores.push(scoreCase(evalCase, null, message));
      log(`${prefix}: ERROR ${message}`);
    }
  }

  return buildReport(scores, { strategy: strategy.name, fixture: loaded.fixturePath });
}

export async function main(argv: string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    return 2;
  }

  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.listStrategies) {
    for (const strategy of STRATEGIES) {
      console.log(`${strategy.name.padEnd(16)} ${strategy.description}${strategy.requiresAzureOpenAI ? " [needs Azure OpenAI]" : ""}`);
    }
    return 0;
  }
  if (args.strategies.length === 0) {
    console.error("At least one --strategy is required.");
    console.error(USAGE);
    return 2;
  }

  const strategies: HexDetectionStrategy[] = [];
  for (const name of args.strategies) {
    const strategy = getStrategy(name);
    if (!strategy) {
      console.error(`Unknown strategy "${name}". Available: ${STRATEGIES.map((s) => s.name).join(", ")}`);
      return 2;
    }
    if (!strategies.includes(strategy)) strategies.push(strategy);
  }

  const applied = loadLocalSettings();
  if (applied > 0) {
    console.error(`Loaded ${applied} settings from local.settings.json`);
  }

  let loaded: LoadedFixture;
  try {
    loaded = await loadFixture(args.fixture);
  } catch (error) {
    if (error instanceof FixtureValidationError) {
      console.error(`Invalid fixture: ${error.message}`);
      return 1;
    }
    throw error;
  }
  console.error(`Fixture: ${loaded.fixturePath} (${loaded.fixture.cases.length} cases)`);

  const azureConfigured = hasAzureOpenAiConfig();
  for (const strategy of strategies) {
    const skipReason = strategySkipReason(strategy, azureConfigured);
    if (skipReason) {
      console.log(`Skipping strategy "${strategy.name}": ${skipReason}`);
      continue;
    }

    const report = await runStrategy(strategy, loaded, {
      cacheDir: args.cacheDir,
      limit: args.limit,
      only: args.only,
    });
    console.log("");
    console.log(formatReport(report, { verbose: args.verbose }));
    const written = await writeReportJson(report, args.resultsDir);
    console.log(`\nReport JSON: ${written}`);
  }

  return 0;
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
