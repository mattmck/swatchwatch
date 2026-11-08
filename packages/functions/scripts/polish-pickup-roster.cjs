#!/usr/bin/env node
/**
 * Polish Pickup maker roster: one GET of the shop's products.json, grouped by vendor, with the
 * registered data_source (docs/seed_data_sources.sql, string match, no database) each vendor maps to.
 *
 *   npm run roster:polish-pickup --workspace=swatchwatch-functions            # one line per vendor
 *   npm run roster:polish-pickup --workspace=swatchwatch-functions -- --json  # { fetchedAt, vendors: [...] }
 *
 * Needs a built dist (`npm run build:functions`).
 */
const fs = require("node:fs");
const path = require("node:path");

const { diffRoster, parseSeedSources } = require("../dist/lib/polish-pickup-roster");
const { USER_AGENT } = require("../dist/lib/connectors/shopify-generic");

const ROSTER_URL = "https://www.polishpickup.com/products.json?limit=250";
const SEED_PATH = path.resolve(__dirname, "../../../docs/seed_data_sources.sql");

async function main() {
  const asJson = process.argv.includes("--json");
  const response = await fetch(ROSTER_URL, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  if (!response.ok) throw new Error(`GET ${ROSTER_URL} failed: HTTP ${response.status}`);
  const body = await response.json();
  const products = Array.isArray(body.products) ? body.products : [];

  const counts = new Map();
  for (const product of products) {
    const vendor = typeof product.vendor === "string" ? product.vendor.trim() : "";
    if (vendor) counts.set(vendor, (counts.get(vendor) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const sources = parseSeedSources(fs.readFileSync(SEED_PATH, "utf8"));
  const rows = diffRoster(sorted.map(([vendor]) => vendor), sources);
  const vendors = rows.map((row, i) => ({ vendor: row.vendor, products: sorted[i][1], source: row.source }));

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ fetchedAt: new Date().toISOString(), vendors }, null, 2)}\n`);
    return;
  }
  for (const entry of vendors) console.log(`${entry.vendor}  ${entry.products}  ${entry.source ?? "-"}`);
  const mapped = vendors.filter((entry) => entry.source).length;
  console.error(`${vendors.length} vendors, ${mapped} already registered sources`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
