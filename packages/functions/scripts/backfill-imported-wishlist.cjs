#!/usr/bin/env node
/**
 * Remove the untouched wishlist rows ingestion used to add for the admin who ran each job by
 * calling POST /api/inventory-admin/imported-wishlist/backfill in batches until the scan is
 * finished. Dry run unless --write is given. The rule (what counts as untouched) lives in
 * src/lib/imported-wishlist-cleanup.ts.
 *
 *   API_BASE_URL=https://<function-app>.azurewebsites.net/api \
 *   ADMIN_BEARER_TOKEN=<admin access token, or dev:<adminUserId> with AUTH_DEV_BYPASS locally> \
 *   npm run backfill:imported-wishlist --workspace=swatchwatch-functions -- [--write] [--after <inventoryItemId>] [--limit <1-2000>]
 *
 * Idempotent. On an error it prints the --after value to resume from. Afterwards run
 * `npm run backfill:product-category -- --write` so accessories nobody holds are excluded.
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
const apiBase = (process.env.API_BASE_URL || "http://localhost:7071/api").replace(/\/+$/, "");
const token = process.env.ADMIN_BEARER_TOKEN;
if (!token) {
  console.error("Set ADMIN_BEARER_TOKEN to an admin bearer token (dev:<adminUserId> with AUTH_DEV_BYPASS locally).");
  process.exit(2);
}

let afterInventoryItemId = intOption("after", 0);

async function main() {
  const limit = intOption("limit", 1000);
  let scanned = 0;
  let removed = 0;
  const bySource = {};
  console.log(write ? "Removing imported wishlist rows." : "Dry run (pass --write to delete).");

  for (;;) {
    const response = await fetch(`${apiBase}/inventory-admin/imported-wishlist/backfill`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ afterInventoryItemId, limit, dryRun: !write }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status} ${text}`.trim());
    }
    const batch = await response.json();
    scanned += batch.scanned;
    removed += batch.removed;
    for (const [source, count] of Object.entries(batch.bySource ?? {})) bySource[source] = (bySource[source] ?? 0) + count;
    console.log(`after=${afterInventoryItemId}: ${batch.scanned} matching, ${batch.removed} removed`);
    if (batch.nextAfterInventoryItemId === null) break;
    afterInventoryItemId = batch.nextAfterInventoryItemId;
  }

  const sources = Object.entries(bySource).map(([source, count]) => `${source} ${count}`).join(", ") || "none";
  console.log(`Done${write ? "" : " (dry run)"}: ${scanned} rows matching, ${removed} removed. By source: ${sources}.`);
}

main().catch((error) => {
  console.error(`Backfill stopped: ${error.message}`);
  console.error(`Resume with --after ${afterInventoryItemId}.`);
  process.exit(1);
});
