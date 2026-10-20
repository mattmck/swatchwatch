#!/usr/bin/env node
/**
 * Re-classify every catalog shade's product category (#349, #347; decision D23) by calling
 * POST /api/shades-admin/product-category/backfill, and save the report it returns.
 * Dry run unless --write is given: the report shows what would change (counts per category and
 * source, category changes, accessories to exclude, held accessories to review, toppers whose
 * detected hex looks like the base color) and nothing is written.
 *
 *   API_BASE_URL=https://<function-app>.azurewebsites.net/api \
 *   ADMIN_BEARER_TOKEN=<admin access token, or dev:<adminUserId> with AUTH_DEV_BYPASS locally> \
 *   npm run backfill:product-category --workspace=swatchwatch-functions -- [--write] [--clear-topper-hex] [--out report.json]
 *
 * --clear-topper-hex also clears detected_hex on the listed toppers (old values are recorded in
 * shade_category_change under the run id, so it can be undone). Idempotent: a second run changes
 * nothing. The report holds no user ids, only holder counts.
 */
const fs = require("node:fs");

const args = process.argv.slice(2);
const write = args.includes("--write");
const clearTopperDetectedHex = args.includes("--clear-topper-hex");
const outIndex = args.indexOf("--out");
const out = outIndex === -1 ? `product-category-${write ? "applied" : "dry-run"}-${Date.now()}.json` : args[outIndex + 1];
if (!out) {
  console.error("--out needs a file name");
  process.exit(2);
}

const apiBase = (process.env.API_BASE_URL || "http://localhost:7071/api").replace(/\/+$/, "");
const token = process.env.ADMIN_BEARER_TOKEN;
if (!token) {
  console.error("Set ADMIN_BEARER_TOKEN to an admin bearer token (dev:<adminUserId> with AUTH_DEV_BYPASS locally).");
  process.exit(2);
}

async function main() {
  console.log(write ? "Applying product categories." : "Dry run (pass --write to apply).");
  const response = await fetch(`${apiBase}/shades-admin/product-category/backfill`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ dryRun: !write, clearTopperDetectedHex }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status} ${text}`.trim());
  }
  const report = await response.json();
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`Scanned ${report.scannedShades} shades. Report saved to ${out}.`);
  for (const [category, counts] of Object.entries(report.byCategory)) {
    console.log(`  ${category.padEnd(10)} ${String(counts.shades).padStart(6)} shades, ${counts.active} active, ${counts.held} held`);
  }
  for (const transition of report.transitions) {
    console.log(`  ${transition.from} → ${transition.to}: ${transition.shades}`);
  }
  console.log(
    `${report.categoryChanges.length} category changes, ${report.excluded.length} accessories to exclude, ` +
      `${report.heldAccessories.length} held accessories to review, ${report.adminDisagreements.length} admin categories the rule disagrees with, ` +
      `${report.topperByTagOnly.length} toppers by tag only, ${report.topperHexCandidates.length} toppers with a suspicious detected hex.`
  );
  if (write) {
    console.log(`Applied (run ${report.runId}): ${JSON.stringify(report.applied)}`);
  }
}

main().catch((error) => {
  console.error(`Backfill failed: ${error.message}`);
  process.exit(1);
});
