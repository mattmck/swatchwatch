#!/usr/bin/env node
// Runs before `node-pg-migrate up` (see the `migrate` script in package.json).
//
// node-pg-migrate requires the applied migrations (pgmigrations, ordered by
// run_on) to be an exact prefix of the files on disk. When a migration file is
// renamed so it sorts later, a database that already ran it under the old name
// fails that check. For each rename below, delete the old pgmigrations row so
// node-pg-migrate re-runs the file under its new name. Only list migrations
// that are safe to re-run (every statement idempotent).
const { Client } = require("pg");

const RENAMED_MIGRATIONS = {
  "025_add_color_training_sample": "20261017033500000_add-color-training-sample",
  // Interim name carried by the hex-eval PRs before dev gained later dated migrations.
  "20261016040629000_add-color-training-sample": "20261017033500000_add-color-training-sample",
  // Merged to dev after later-dated migrations had run there, so it could never run in order
  // (Deploy Dev failed from 2026-10-20). Idempotent; forgets it on any local DB that ran the old name.
  "20261019011858000_shade-product-category": "20261022190729000_shade-product-category",
};

async function main() {
  // Same connection resolution as node-pg-migrate: DATABASE_URL, else PG* env vars.
  const client = new Client(
    process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {},
  );
  await client.connect();
  try {
    const { rows } = await client.query("SELECT to_regclass('public.pgmigrations') AS t");
    if (!rows[0].t) return;
    for (const [oldName, newName] of Object.entries(RENAMED_MIGRATIONS)) {
      const res = await client.query("DELETE FROM public.pgmigrations WHERE name = $1", [oldName]);
      if (res.rowCount > 0) {
        console.log(`Forgot applied migration ${oldName}; it re-runs as ${newName}.`);
      }
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
