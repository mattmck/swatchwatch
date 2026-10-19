#!/usr/bin/env node
/**
 * Unlink catalog gallery images that duplicate another image of the same shade (the same vendor
 * picture stored twice under different checksums), by calling POST /api/images-admin/gallery-dedupe
 * in batches until the scan is finished. Dry run unless --write is given.
 *
 *   API_BASE_URL=https://<function-app>.azurewebsites.net/api \
 *   ADMIN_BEARER_TOKEN=<admin access token, or dev:<adminUserId> with AUTH_DEV_BYPASS locally> \
 *   npm run dedupe:gallery-images --workspace=swatchwatch-functions -- [--write] [--shade 294,295] [--after <shadeId>] [--limit <1-100>] [--verbose] [--allow-unreadable]
 *
 * Idempotent: re-running removes nothing new. On an error it prints the `--after` value to resume from.
 * A batch with unreadable images stops the run before the cursor moves past it, so the batch can be
 * retried; pass --allow-unreadable to continue past images that stay unreadable (they are never removed).
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
const allowUnreadable = args.includes("--allow-unreadable");
const shadeIndex = args.indexOf("--shade");
const shadeIds =
  shadeIndex === -1
    ? undefined
    : String(args[shadeIndex + 1] ?? "")
        .split(",")
        // Whole tokens only: parseInt would read "294oops" as 294.
        .map((id) => (/^[1-9]\d*$/.test(id.trim()) ? Number(id.trim()) : Number.NaN));
if (shadeIds && !shadeIds.every((id) => Number.isSafeInteger(id) && id > 0)) {
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
    if (batch.unreadableImages > 0 && !allowUnreadable) {
      // Duplicates of an unreadable image were not matched; stop before moving the cursor past them.
      throw new Error(
        `${batch.unreadableImages} image(s) in this batch could not be read; retry, or pass --allow-unreadable to continue past them`
      );
    }
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
