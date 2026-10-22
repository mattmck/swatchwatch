---
name: create-migration
description: Create a new Postgres migration for SwatchWatch (node-pg-migrate, UTC-timestamped SQL with a Down section) and keep docs/schema.sql in sync.
argument-hint: <kebab-case-description>
disable-model-invocation: true
---

# Create a migration

Argument: `$ARGUMENTS` — a short kebab-case description (e.g. `add-shade-notes`). If empty, ask for one.

## Rules

- **Never edit a migration that is already committed.** Applied migrations are immutable; add a new one. (A PreToolUse hook, `.claude/hooks/guard-protected-files.mjs`, blocks this when registered.)
- Migrations are plain SQL in `packages/functions/migrations/`, named `<UTC timestamp>_<description>.sql`. The timestamp must sort **after** every existing file (`ls packages/functions/migrations | tail -3`); node-pg-migrate requires applied migrations to be an exact prefix of the files on disk.
- Renaming an already-applied migration needs an entry in `packages/functions/scripts/forget-renamed-migrations.cjs`, and only if every statement is idempotent. Avoid renames.

## Steps

1. Generate the file (needs no DB):
   ```bash
   npm run migrate:create --workspace=swatchwatch-functions -- <description>
   ```
   Confirm the new file sorts last.
2. Write the file in the house style (see `20261017024958000_shade-detected-hex-provenance.sql`):
   - Starts with `-- Up Migration`, wraps statements in `BEGIN; … COMMIT;`.
   - Prefer idempotent statements (`IF NOT EXISTS`, `DROP … IF EXISTS`).
   - A data migration that upserts rows which may already exist must let its Down tell them apart: mark the rows the Up inserts (e.g. `metadata.insertedByMigration`, kept out of the `ON CONFLICT` update) and delete only marked rows, restoring or disabling the others (see `20261020032543929_guard-more-indie-shopify-sources-rollback.sql`).
   - Has a `-- Down Migration` section that fully reverses the Up section, also in `BEGIN; … COMMIT;`.
   - Leading comment explaining *why* (and any related `docs/schema.sql` section).
   - New user-owned tables carry a `user_id` and are always queried with it (per-user isolation, issue #47).
3. Update `docs/schema.sql` so the canonical DDL matches the post-migration schema.
4. If the change affects API shapes, update `packages/shared` types and the `packages/functions/README.md` route table.
5. Verify against the local DB (`npm run dev:infra` first; Postgres is on port 55432):
   ```bash
   npm run migrate --workspace=swatchwatch-functions
   npm run migrate:down --workspace=swatchwatch-functions
   npm run migrate --workspace=swatchwatch-functions
   ```
   Up → down → up proves the Down section works. Then run `npm run test --workspace=swatchwatch-functions`.
6. Report the filename and the three commands' results. Do not commit unless asked.
