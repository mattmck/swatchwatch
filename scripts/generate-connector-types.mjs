#!/usr/bin/env node

/**
 * Generate connector types from seed_data_sources.sql
 * 
 * Reads the data_source names from seed_data_sources.sql and generates
 * a TypeScript type file with SupportedConnectorSource union type.
 * 
 * Usage: node scripts/generate-connector-types.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const SQL_PATH = resolve(root, "docs/seed_data_sources.sql");
const TYPES_PATH = resolve(root, "packages/functions/src/lib/connectors/generated-types.ts");

// Read the SQL file
const sql = readFileSync(SQL_PATH, "utf-8");

// Extract source names from INSERT statements
// Pattern: ('SourceName', 'api', ...
const sourcePattern = /\(\s*'([A-Za-z0-9_]+)'\s*,\s*'api'/g;
const sources = new Set();

let match;
while ((match = sourcePattern.exec(sql)) !== null) {
  sources.add(match[1]);
}

// TODO: Filter out internal app sources that aren't actual connectors
// Currently includes UserCapture and ManualEntry which should be excluded
// These are app-internal sources, not external API connectors
// Current filter approach: keep all 'api' type sources

// Sort for deterministic output
const sortedSources = Array.from(sources).sort();

// Generate TypeScript - both type and runtime array
const typeContent = `/**
 * Auto-generated from docs/seed_data_sources.sql
 * Do not edit manually - run "npm run generate:types" to regenerate
 */

export type SupportedConnectorSource =
${sortedSources.map((s) => `  | "${s}"`).join("\n")};

// Runtime array for validation - same values as the type above
export const SUPPORTED_SOURCES: SupportedConnectorSource[] = [
${sortedSources.map((s) => `  "${s}",`).join("\n")}];
`;

// Write the generated file
writeFileSync(TYPES_PATH, typeContent);

console.log(`Generated ${TYPES_PATH}`);
console.log(`Found ${sortedSources.length} API sources:`);
sortedSources.forEach((s) => console.log(`  - ${s}`));
