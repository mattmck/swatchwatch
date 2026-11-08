#!/usr/bin/env node
/**
 * Remove a disabled data source's catalog images (a store asked us to stop using its pictures) by
 * calling POST /api/images-admin/source-images/remove in batches until the scan is finished: the
 * source's swatches are unlinked, its image_asset rows deleted and their blobs + thumbnail variants
 * removed. Images with a hex label or color_features are kept, as are blobs another image_asset
 * row shares. Disable the source first (the endpoint answers 409 while it is enabled). Dry run
 * unless --write is given.
 *
 *   API_BASE_URL=https://<function-app>.azurewebsites.net/api \
 *   ADMIN_BEARER_TOKEN=<admin access token, or dev:<adminUserId> with AUTH_DEV_BYPASS locally> \
 *   npm run remove:source-images --workspace=swatchwatch-functions -- --source <name> [--write] [--after <imageId>] [--limit <1-500>] [--verbose]
 *
 * Idempotent: re-running removes nothing new. On an error it prints the `--after` value to resume from.
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
const sourceIndex = args.indexOf("--source");
const source = sourceIndex === -1 ? "" : String(args[sourceIndex + 1] ?? "").trim();
if (!source || source.startsWith("--")) {
  console.error("--source <data source name> is required");
  process.exit(2);
}

const apiBase = (process.env.API_BASE_URL || "http://localhost:7071/api").replace(/\/+$/, "");
const token = process.env.ADMIN_BEARER_TOKEN;
if (!token) {
  console.error("Set ADMIN_BEARER_TOKEN to an admin bearer token (dev:<adminUserId> with AUTH_DEV_BYPASS locally).");
  process.exit(2);
}

let afterImageId = intOption("after", 0);

async function main() {
  const limit = intOption("limit", 100);
  const totals = { scanned: 0, swatchesUnlinked: 0, imagesDeleted: 0, blobsDeleted: 0, kept: 0, failures: 0 };
  console.log(write ? `Removing the images of ${source}.` : `Dry run for ${source} (pass --write to remove).`);

  for (;;) {
    const response = await fetch(`${apiBase}/images-admin/source-images/remove`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ sources: [source], afterImageId, limit, dryRun: !write }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status} ${text}`.trim());
    }
    const batch = await response.json();
    for (const key of ["scanned", "swatchesUnlinked", "imagesDeleted", "blobsDeleted"]) totals[key] += batch[key] ?? 0;
    totals.kept += batch.kept.length;
    totals.failures += batch.failures.length;
    for (const failure of batch.failures) {
      console.warn(`  image ${failure.imageId}: ${failure.error}`);
    }
    if (verbose) {
      for (const kept of batch.kept) console.log(`  image ${kept.imageId}: kept (${kept.reason})`);
    }
    console.log(
      `after=${afterImageId}: ${batch.scanned} images, ${batch.imagesDeleted} ${write ? "deleted" : "to delete"}, ` +
        `${batch.swatchesUnlinked} swatches, ${batch.blobsDeleted} blobs, ${batch.kept.length} kept`
    );
    if (batch.nextAfterImageId === null) break;
    afterImageId = batch.nextAfterImageId;
  }

  console.log(
    `Done${write ? "" : " (dry run)"}: ${totals.scanned} images scanned, ${totals.imagesDeleted} image rows ${write ? "deleted" : "to delete"}, ` +
      `${totals.swatchesUnlinked} swatches unlinked, ${totals.blobsDeleted} blobs ${write ? "deleted" : "to delete"}, ` +
      `${totals.kept} kept (labeled, color_features or shared blob), ${totals.failures} failures.`
  );
}

main().catch((error) => {
  console.error(`Removal stopped: ${error.message}`);
  console.error(`Resume with --after ${afterImageId}.`);
  process.exit(1);
});
