#!/usr/bin/env node
/**
 * Merge the duplicate shades the MakeupAPI connector created (copies inside MakeupAPI, and
 * MakeupAPI copies of a brand-store shade) and delete the MakeupAPI-only shades nothing
 * references, by calling POST /api/shades-admin/makeupapi-dedupe/backfill in batches of brands
 * until the scan is finished. Dry run unless --write is given. Rules: lib/makeupapi-dedupe.ts.
 *
 *   API_BASE_URL=https://<function-app>.azurewebsites.net/api \
 *   ADMIN_BEARER_TOKEN=<admin access token, or dev:<adminUserId> with AUTH_DEV_BYPASS locally> \
 *   npm run dedupe:makeupapi-shades --workspace=swatchwatch-functions -- [--write] [--after <brandId>] [--limit <1-100>] [--verbose] [--out report.json]
 *
 * A dry run executes each batch's statements and rolls them back, so its report is exact.
 * Idempotent: a re-run finds nothing new. On an error it prints the --after value to resume from.
 */
const fs = require("node:fs");

const args = process.argv.slice(2);
function intOption(name, fallback) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const raw = String(args[index + 1] ?? "");
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value)) {
    console.error(`--${name} needs a non-negative integer`);
    process.exit(2);
  }
  return value;
}
function stringOption(name) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? null : args[index + 1] ?? null;
}

const write = args.includes("--write");
const verbose = args.includes("--verbose");
const outPath = stringOption("out");
const apiBase = (process.env.API_BASE_URL || "http://localhost:7071/api").replace(/\/+$/, "");
const token = process.env.ADMIN_BEARER_TOKEN;
if (!token) {
  console.error("Set ADMIN_BEARER_TOKEN to an admin bearer token (dev:<adminUserId> with AUTH_DEV_BYPASS locally).");
  process.exit(2);
}

let afterBrandId = intOption("after", 0);

async function main() {
  const limit = intOption("limit", 10);
  const totals = { scannedBrands: 0, makeupApiShades: 0, merged: 0, mergedIntoStoreShades: 0, deleted: 0, inventoryRowsMoved: 0 };
  const collected = { merges: [], skippedGroups: [], deletedShades: [], keptShades: [] };
  console.log(write ? "Merging and deleting MakeupAPI shades." : "Dry run (pass --write to apply).");

  for (;;) {
    const response = await fetch(`${apiBase}/shades-admin/makeupapi-dedupe/backfill`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ afterBrandId, limit, dryRun: !write }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status} ${text}`.trim());
    }
    const batch = await response.json();
    for (const key of Object.keys(totals)) totals[key] += batch[key] ?? 0;
    for (const key of Object.keys(collected)) collected[key].push(...(batch[key] ?? []));

    for (const merge of batch.merges) {
      console.log(`  merge ${merge.brand} "${merge.sourceName}" ${merge.sourceShadeId} → ${merge.targetShadeId} "${merge.targetName}" (${merge.reason})`);
    }
    for (const group of batch.skippedGroups) {
      console.warn(`  skipped ${group.brand} "${group.key}" (${group.reason}): shades ${group.shadeIds.join(", ")}`);
    }
    for (const kept of batch.keptShades) {
      console.log(`  kept ${kept.shadeId} ${kept.brand} "${kept.name}": ${kept.reasons.join(", ")}`);
    }
    if (verbose) {
      for (const shade of batch.deletedShades) console.log(`  delete ${shade.shadeId} ${shade.brand} "${shade.name}"`);
    }
    console.log(
      `after=${afterBrandId}: ${batch.scannedBrands} brands, ${batch.makeupApiShades} MakeupAPI-only shades, ${batch.merged} ${write ? "merged" : "to merge"}, ${batch.deleted} ${write ? "deleted" : "to delete"}, ${batch.keptShades.length} kept`
    );
    if (batch.nextAfterBrandId === null) break;
    afterBrandId = batch.nextAfterBrandId;
  }

  if (outPath) {
    fs.writeFileSync(outPath, JSON.stringify({ dryRun: !write, ...totals, ...collected }, null, 2));
    console.log(`Report written to ${outPath}`);
  }
  console.log(
    `Done${write ? "" : " (dry run)"}: ${totals.scannedBrands} brands, ${totals.makeupApiShades} MakeupAPI-only shades, ` +
      `${totals.merged} merges (${totals.mergedIntoStoreShades} into store shades), ${totals.inventoryRowsMoved} inventory rows moved, ` +
      `${totals.deleted} shades ${write ? "deleted" : "to delete"}, ${collected.keptShades.length} kept, ${collected.skippedGroups.length} groups skipped.`
  );
}

main().catch((error) => {
  console.error(`Dedupe stopped: ${error.message}`);
  console.error(`Resume with --after ${afterBrandId}.`);
  process.exit(1);
});
