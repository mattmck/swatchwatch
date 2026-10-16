import { readFileSync } from "fs";
import path from "path";

/** `packages/functions` (this file compiles to `dist/eval/hex/env.js`). */
export const FUNCTIONS_ROOT = path.resolve(__dirname, "..", "..", "..");

/** Default on-disk layout for the eval harness, relative to `packages/functions`. */
export const EVAL_PATHS = {
  fixturesDir: path.join(FUNCTIONS_ROOT, "eval", "hex", "fixtures"),
  sampleFixture: path.join(FUNCTIONS_ROOT, "eval", "hex", "fixtures", "sample.json"),
  exportedFixture: path.join(FUNCTIONS_ROOT, "eval", "hex", "fixtures", "color-training-sample.json"),
  resultsDir: path.join(FUNCTIONS_ROOT, "eval", "hex", "results"),
  cacheDir: path.join(FUNCTIONS_ROOT, "eval", "hex", ".cache"),
} as const;

/**
 * Load `local.settings.json` `Values` into `process.env` (without overriding
 * variables that are already set), mirroring what `npm run migrate` does so the
 * eval scripts see the same Postgres / Azure OpenAI config as the Functions host.
 * Returns the number of variables applied; 0 when the file is missing.
 */
export function loadLocalSettings(settingsPath = path.join(FUNCTIONS_ROOT, "local.settings.json")): number {
  let doc: { Values?: Record<string, unknown> };
  try {
    doc = JSON.parse(readFileSync(settingsPath, "utf8")) as { Values?: Record<string, unknown> };
  } catch {
    return 0;
  }
  let applied = 0;
  for (const [key, value] of Object.entries(doc.Values ?? {})) {
    if (process.env[key] === undefined && typeof value === "string") {
      process.env[key] = value;
      applied += 1;
    }
  }
  return applied;
}
