#!/usr/bin/env node
/**
 * Build catalog barcode rows from stored connector products (external_product GTIN + variant
 * barcodes, linked to shades through shade_source_product) by calling
 * POST /api/barcodes-admin/backfill in batches until the scan is finished. Dry run unless
 * --write is given.
 *
 *   API_BASE_URL=https://<function-app>.azurewebsites.net/api \
 *   ADMIN_BEARER_TOKEN=<admin access token, or dev:<adminUserId> with AUTH_DEV_BYPASS locally> \
 *   npm run backfill:barcodes --workspace=swatchwatch-functions -- [--write] [--after <externalProductId>] [--limit <1-1000>] [--verbose]
 *
 * A dry run executes each batch's statements and rolls them back, so it is exact within a
 * batch; a GTIN shared by products in different batches only shows up as a conflict when
 * writing. Use the default --limit 1000 for the dry run to keep that rare.
 * Idempotent: re-running links nothing new. On an error it prints the --after value to resume from.
 */
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

const write = args.includes("--write");
const verbose = args.includes("--verbose");
const apiBase = (process.env.API_BASE_URL || "http://localhost:7071/api").replace(/\/+$/, "");
const token = process.env.ADMIN_BEARER_TOKEN;
if (!token) {
  console.error("Set ADMIN_BEARER_TOKEN to an admin bearer token (dev:<adminUserId> with AUTH_DEV_BYPASS locally).");
  process.exit(2);
}

let afterExternalProductId = intOption("after", 0);

async function main() {
  const limit = intOption("limit", 1000);
  const totals = {
    scannedProducts: 0,
    productsWithGtins: 0,
    gtinsFound: 0,
    inserted: 0,
    alreadyLinked: 0,
    shadesGainingBarcode: 0,
    conflicts: 0,
    ambiguousProducts: 0,
    invalidCheckDigit: 0,
  };
  console.log(write ? "Writing barcode rows." : "Dry run (pass --write to write).");

  for (;;) {
    const response = await fetch(`${apiBase}/barcodes-admin/backfill`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ afterExternalProductId, limit, dryRun: !write }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status} ${text}`.trim());
    }
    const batch = await response.json();
    for (const key of Object.keys(totals)) {
      const value = batch[key];
      totals[key] += Array.isArray(value) ? value.length : value ?? 0;
    }
    for (const conflict of batch.conflicts) {
      console.warn(
        `  conflict: GTIN ${conflict.gtin} of product ${conflict.externalProductId} (shade ${conflict.shadeId}) already belongs to shade ${conflict.existingShadeId}; kept there`
      );
    }
    for (const bad of batch.invalidCheckDigit ?? []) {
      console.warn(`  wrong check digit: GTIN ${bad.gtin} of product ${bad.externalProductId} (shade ${bad.shadeId}); stored anyway`);
    }
    if (verbose) {
      for (const product of batch.ambiguousProducts) {
        console.log(`  skipped product ${product.externalProductId}: linked to shades ${product.shadeIds.join(", ")}`);
      }
    }
    console.log(
      `after=${afterExternalProductId}: ${batch.scannedProducts} products, ${batch.gtinsFound} GTINs, ${batch.inserted} ${write ? "linked" : "to link"}, ${batch.conflicts.length} conflicts`
    );
    if (batch.nextAfterExternalProductId === null) break;
    afterExternalProductId = batch.nextAfterExternalProductId;
  }

  console.log(
    `Done${write ? "" : " (dry run)"}: ${totals.scannedProducts} products scanned, ${totals.productsWithGtins} with GTINs, ` +
      `${totals.gtinsFound} GTINs, ${totals.inserted} barcode rows ${write ? "written" : "to write"}, ${totals.alreadyLinked} already linked, ` +
      `${totals.shadesGainingBarcode} shades gain a barcode, ${totals.conflicts} conflicts, ${totals.ambiguousProducts} ambiguous products skipped, ${totals.invalidCheckDigit} with a wrong check digit (kept).`
  );
}

main().catch((error) => {
  console.error(`Backfill stopped: ${error.message}`);
  console.error(`Resume with --after ${afterExternalProductId}.`);
  process.exit(1);
});
