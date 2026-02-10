# Merge Plan: Bring `codex/rapid-add-capture-api-scaffold` in sync with `dev`

1. Re-run `git merge origin/dev` to surface conflicts (spanning docs, tooling, shared types, functions, and web packages).
2. Resolve by category:
   - **Docs / Agent Instructions**: prefer `origin/dev` for `.cursorrules`, `.windsurfrules`, `CLAUDE.md`, `.github/copilot-instructions.md`, etc., then re-apply any rapid-add specifics (e.g., references in `docs/mvp-backlog.md` and `docs/rapid-add-next-giant-push-plan.md`).
   - **Tooling / Husky / Workflows**: keep the updated Husky scripts, tests, and CI workflows from `dev`. After resolving, regenerate `package-lock.json` via `npm install` to ensure dependencies align.
   - **Shared Types & Packages**: start with `packages/shared/src/types/polish.ts` and ensure capture-related exports remain in `packages/shared/src/index.ts`. Reconcile `packages/shared/README.md` with the expanded type catalog.
   - **Azure Functions**: merge `packages/functions/src/functions/polishes.ts`, `packages/functions/package.json`, and migrations (`003_seed_dev_data.sql`, etc.) by using the Postgres-backed structure from `dev` and layering rapid-add capture logic on top.
   - **Web App**: adopt `dev`’s API-driven data flow (no mock data), keep Rapid Add CTA/capture UI. Merge pages/components (`/polishes`, `/polishes/search`, color wheel, pagination, quantity controls) so both pagination + capture features coexist.
3. After conflicts are resolved:
   - Run `npm run lint`, `npm run test --workspace=packages/functions`, and `npm run dev:functions` (or `npm run build:functions`) to ensure the new DB-backed logic works with capture additions.
   - Run `npm run build --workspace=packages/shared` so downstream packages pick up the merged types.
4. Commit the merge and `git push` to share the synced branch.
