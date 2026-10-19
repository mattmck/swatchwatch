#!/usr/bin/env node
/**
 * Generate the pre-generated catalog thumbnails for images stored before variants existed, by
 * calling POST /api/images-admin/variants/backfill in batches until the scan is finished.
 *
 *   API_BASE_URL=https://<function-app>.azurewebsites.net/api \
 *   ADMIN_BEARER_TOKEN=<admin access token, or dev:<adminUserId> with AUTH_DEV_BYPASS locally> \
 *   npm run backfill:image-variants --workspace=swatchwatch-functions -- [--after <imageId>] [--limit <1-100>]
 *
 * Idempotent: re-running only fills gaps. On an error it prints the `--after` value to resume from.
 */
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = Number.parseInt(args[index + 1], 10);
  if (!Number.isInteger(value) || value < 0) {
    console.error(`--${name} needs a non-negative integer`);
    process.exit(2);
  }
  return value;
}

const apiBase = (process.env.API_BASE_URL || "http://localhost:7071/api").replace(/\/+$/, "");
const token = process.env.ADMIN_BEARER_TOKEN;
if (!token) {
  console.error("Set ADMIN_BEARER_TOKEN to an admin bearer token (dev:<adminUserId> with AUTH_DEV_BYPASS locally).");
  process.exit(2);
}

let afterImageId = option("after", 0);

async function main() {
  const limit = option("limit", 25);
  const totals = { scanned: 0, variantsWritten: 0, complete: 0, skipped: 0, failures: 0 };

  for (;;) {
    const response = await fetch(`${apiBase}/images-admin/variants/backfill`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ afterImageId, limit }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status} ${text}`.trim());
    }
    const batch = await response.json();
    totals.scanned += batch.scanned;
    totals.variantsWritten += batch.variantsWritten;
    totals.complete += batch.complete;
    totals.skipped += batch.skipped;
    totals.failures += batch.failures.length;
    for (const failure of batch.failures) {
      console.warn(`  image ${failure.imageId}: ${failure.error}`);
    }
    console.log(
      `after=${afterImageId}: scanned ${batch.scanned}, wrote ${batch.variantsWritten} variants, ${batch.complete} already complete`
    );
    if (batch.nextAfterImageId === null) break;
    afterImageId = batch.nextAfterImageId;
  }

  console.log(
    `Done: scanned ${totals.scanned} images, wrote ${totals.variantsWritten} variants, ${totals.complete} already complete, ${totals.skipped} skipped, ${totals.failures} with failures.`
  );
}

main().catch((error) => {
  console.error(`Backfill stopped: ${error.message}`);
  console.error(`Resume with --after ${afterImageId}.`);
  process.exit(1);
});
