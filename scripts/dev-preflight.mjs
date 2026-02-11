#!/usr/bin/env node

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

