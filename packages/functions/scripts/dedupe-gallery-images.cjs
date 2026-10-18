#!/usr/bin/env node
/**
 * Unlink catalog gallery images that duplicate another image of the same shade (the same vendor
 * picture stored twice under different checksums), by calling POST /api/images-admin/gallery-dedupe
 * in batches until the scan is finished. Dry run unless --write is given.
 *
 *   API_BASE_URL=https://<function-app>.azurewebsites.net/api \
 *   ADMIN_BEARER_TOKEN=<admin access token, or dev:<adminUserId> with AUTH_DEV_BYPASS locally> \
 *   npm run dedupe:gallery-images --workspace=swatchwatch-functions -- [--write] [--shade 294,295] [--after <shadeId>] [--limit <1-100>] [--verbose]
 *
 * Idempotent: re-running removes nothing new. On an error it prints the `--after` value to resume from.
 */
const args = process.argv.slice(2);
function intOption(name, fallback) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = Number.parseInt(args[index + 1], 10);
  if (!Number.isInteger(value) || value < 0) {
    console.error(`--${name} needs a non-negative integer`);
    process.exit(2);
  }
  return value;
}

const write = args.includes("--write");
const verbose = args.includes("--verbose");
const shadeIndex = args.indexOf("--shade");
const shadeIds =
  shadeIndex === -1
    ? undefined
    : String(args[shadeIndex + 1] ?? "")
        .split(",")
        .map((id) => Number.parseInt(id.trim(), 10));
if (shadeIds && !shadeIds.every((id) => Number.isInteger(id) && id > 0)) {
  console.error("--shade needs a comma-separated list of shade ids");
  process.exit(2);
}

const apiBase = (process.env.API_BASE_URL || "http://localhost:7071/api").replace(/\/+$/, "");
const token = process.env.ADMIN_BEARER_TOKEN;
if (!token) {
  console.error("Set ADMIN_BEARER_TOKEN to an admin bearer token (dev:<adminUserId> with AUTH_DEV_BYPASS locally).");
  process.exit(2);
}

let afterShadeId = intOption("after", 0);

async function main() {
  const limit = intOption("limit", 25);
  const totals = {
    scannedShades: 0,
    shadesWithDuplicates: 0,
    imagesFingerprinted: 0,
    unreadableImages: 0,
    duplicateGroups: 0,
    swatchesRemoved: 0,
    duplicatesKept: 0,
  };
  console.log(write ? "Removing duplicate gallery swatches." : "Dry run (pass --write to remove).");

  for (;;) {
    const response = await fetch(`${apiBase}/images-admin/gallery-dedupe`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ afterShadeId, limit, dryRun: !write, ...(shadeIds ? { shadeIds } : {}) }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status} ${text}`.trim());
    }
    const batch = await response.json();
    for (const key of Object.keys(totals)) totals[key] += batch[key] ?? 0;
    for (const failure of batch.failures) {
      console.warn(`  image ${failure.imageId}: ${failure.error}`);
    }
    for (const group of batch.groups) {
      if (!verbose && !shadeIds) continue;
      console.log(
        `  shade ${group.shadeId}: keep image ${group.keepImageId}, ${write ? "removed" : "remove"} ${group.removeImageIds.join(", ")}` +
          ` (dHash ≤ ${group.maxHashDistance}, thumb ≤ ${group.maxThumbDistance}${group.keptSwatchIds.length ? `, kept swatches ${group.keptSwatchIds.join(", ")}` : ""})`
      );
    }
    console.log(
      `after=${afterShadeId}: ${batch.scannedShades} shades, ${batch.shadesWithDuplicates} with duplicates, ${batch.swatchesRemoved} swatches ${write ? "removed" : "to remove"}`
    );
    if (batch.nextAfterShadeId === null) break;
    afterShadeId = batch.nextAfterShadeId;
  }

  console.log(
    `Done${write ? "" : " (dry run)"}: ${totals.scannedShades} shades scanned, ${totals.shadesWithDuplicates} with duplicates, ` +
      `${totals.duplicateGroups} duplicate groups, ${totals.swatchesRemoved} gallery swatches ${write ? "removed" : "to remove"}, ` +
      `${totals.duplicatesKept} duplicates kept (product/protected/current pipeline), ${totals.imagesFingerprinted} images fingerprinted, ${totals.unreadableImages} unreadable.`
  );
}

main().catch((error) => {
  console.error(`Dedupe stopped: ${error.message}`);
  console.error(`Resume with --after ${afterShadeId}.`);
  process.exit(1);
});
