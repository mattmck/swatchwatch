#!/usr/bin/env node
/**
 * Retire (status = 'excluded') the active shades whose every listing is a brand store product the
 * store's current gate rejects (gel / LED lines while includeGel is off, another vendor's items),
 * by calling POST /api/shades-admin/brand-store-rejected/backfill in batches of shades until the
 * scan is finished. Dry run unless --write is given. Rules: lib/brand-store-rejected.ts.
 *
 *   API_BASE_URL=https://<function-app>.azurewebsites.net/api \
 *   ADMIN_BEARER_TOKEN=<admin access token, or dev:<adminUserId> with AUTH_DEV_BYPASS locally> \
 *   npm run backfill:brand-store-rejected --workspace=swatchwatch-functions -- [--write] [--sources A,B] [--after <shadeId>] [--limit <1-1000>] [--verbose] [--out report.json]
 *
 * Held, user, review-approved and admin-edited shades are kept and listed. Each retirement is a
 * shade_category_change 'exclude' row (one runId per batch), so it can be undone. Idempotent: a
 * re-run finds nothing new. On an error it prints the --after value to resume from.
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
const sourcesText = stringOption("sources");
const sources = sourcesText
  ? [...new Set(sourcesText.split(",").map((name) => name.trim()).filter(Boolean))]
  : null;
const apiBase = (process.env.API_BASE_URL || "http://localhost:7071/api").replace(/\/+$/, "");
const token = process.env.ADMIN_BEARER_TOKEN;
if (!token) {
  console.error("Set ADMIN_BEARER_TOKEN to an admin bearer token (dev:<adminUserId> with AUTH_DEV_BYPASS locally).");
  process.exit(2);
}

let afterShadeId = intOption("after", 0);

const ref = (shade) => `${shade.shadeId} ${shade.brand} "${shade.name}"`;

async function main() {
  const limit = intOption("limit", 200);
  const totals = { scannedShades: 0, retired: 0 };
  const collected = { retire: [], held: [], protectedShades: [], partial: [], unsupported: [], brandsWithoutActiveShades: [] };
  console.log(write ? "Retiring rejected brand-store shades." : "Dry run (pass --write to apply).");

  for (;;) {
    const response = await fetch(`${apiBase}/shades-admin/brand-store-rejected/backfill`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ afterShadeId, limit, dryRun: !write, ...(sources ? { sources } : {}) }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status} ${text}`.trim());
    }
    const batch = await response.json();
    for (const key of Object.keys(totals)) totals[key] += batch[key] ?? 0;
    for (const key of Object.keys(collected)) collected[key].push(...(batch[key] ?? []));

    if (verbose) {
      for (const shade of batch.retire) console.log(`  retire ${ref(shade)}`);
    }
    for (const shade of batch.held) console.log(`  held ${ref(shade)} (${shade.holders} holder(s)): kept`);
    for (const shade of batch.protectedShades) console.log(`  kept ${ref(shade)}: ${shade.reasons.join(", ")}`);
    for (const brand of batch.brandsWithoutActiveShades) {
      console.log(`  brand ${brand.brandId} ${brand.brand} has no active shade left (${brand.shades} shade rows)`);
    }
    console.log(
      `after=${afterShadeId}: ${batch.scannedShades} shades read, ${batch.retired} ${write ? "retired" : "to retire"}, ${batch.held.length} held, ${batch.partial.length} partly rejected, ${batch.unsupported.length} unsupported`
    );
    if (batch.nextAfterShadeId === null) break;
    afterShadeId = batch.nextAfterShadeId;
  }

  if (outPath) {
    fs.writeFileSync(outPath, JSON.stringify({ dryRun: !write, ...totals, ...collected }, null, 2));
    console.log(`Report written to ${outPath}`);
  }
  console.log(
    `Done${write ? "" : " (dry run)"}: ${totals.scannedShades} shades read, ${totals.retired} ${write ? "retired" : "to retire"}, ` +
      `${collected.held.length} held, ${collected.protectedShades.length} protected, ${collected.partial.length} partly rejected, ` +
      `${collected.unsupported.length} unsupported, ${collected.brandsWithoutActiveShades.length} brand(s) without an active shade.`
  );
}

main().catch((error) => {
  console.error(`Backfill stopped: ${error.message}`);
  console.error(`Resume with --after ${afterShadeId}.`);
  process.exit(1);
});
