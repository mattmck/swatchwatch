#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();

/**
 * Accept either hoisted dependencies under root node_modules
 * or package-scoped node_modules for workspace installs.
 */
const checks = [
  {
    label: "root node_modules",
    paths: ["node_modules"],
  },
  {
    label: "concurrently package",
    paths: ["node_modules/concurrently"],
  },
  {
    label: "TypeScript package",
    paths: ["node_modules/typescript"],
  },
  {
    label: "Next.js package",
    paths: ["node_modules/next", "apps/web/node_modules/next"],
  },
  {
    label: "Expo package",
    paths: ["node_modules/expo", "apps/mobile/node_modules/expo"],
  },
  {
    label: "Azure Functions package",
    paths: [
      "node_modules/@azure/functions",
      "packages/functions/node_modules/@azure/functions",
    ],
  },
];

const missing = checks.filter((check) =>
  !check.paths.some((relativePath) => existsSync(resolve(root, relativePath)))
);

if (missing.length > 0) {
  const missingLabels = missing.map((entry) => `- ${entry.label}`).join("\n");
  console.error("Dependency preflight failed.");
  console.error("Missing required install artifacts:");
  console.error(missingLabels);
  console.error("");
  console.error("Run `npm run setup` (or `npm ci`) at repo root, then retry.");
  process.exit(1);
}


/**
 * `--func`: the Functions host comes from a global Azure Functions Core Tools
 * install (not an npm devDependency, whose postinstall downloads ~1.5 GB of
 * host binaries into every checkout). Require `func` >= MIN_FUNC_VERSION.
 */
const MIN_FUNC_VERSION = [4, 16, 0];

if (process.argv.includes("--func")) {
  let version = "";
  try {
    // On Windows an npm global install exposes func as a func.cmd shim, which
    // Node only launches through a shell; the arguments are fixed, so this is safe.
    version = execFileSync("func", ["--version"], {
      encoding: "utf8",
      shell: process.platform === "win32",
    })
      .trim()
      .split(/\r?\n/)
      .pop()
      .trim();
  } catch {
    version = "";
  }
  const parts = version.match(/^(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  const tooOld =
    parts &&
    MIN_FUNC_VERSION.some((min, i) =>
      parts.slice(0, i).every((p, j) => p === MIN_FUNC_VERSION[j]) && parts[i] < min
    );
  if (!parts || tooOld) {
    console.error(
      parts
        ? `Azure Functions Core Tools ${version} is too old (need >= ${MIN_FUNC_VERSION.join(".")}).`
        : "Azure Functions Core Tools (`func`) was not found on PATH."
    );
    console.error("Install or upgrade it globally, then retry:");
    console.error("  brew tap azure/functions && brew install azure-functions-core-tools@4   # macOS");
    console.error("  npm i -g azure-functions-core-tools@4 --unsafe-perm true               # other platforms");
    console.error("  (Windows: the MSI installer from https://aka.ms/func-install also works)");
    process.exit(1);
  }
}
