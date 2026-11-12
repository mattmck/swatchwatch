# SwatchWatch — Agent Instructions

This file is the short entry point. The detail lives in topic files under `docs/agents/` (index: `docs/agents/README.md`). Keep this file under 20,000 characters (see Documentation Maintenance).

## Architecture Overview

Smart nail polish collection manager. **npm workspaces monorepo** with three deployable targets and a shared types package:

```
apps/web          → Next.js 16 (App Router) + Tailwind v4 + shadcn/ui → Azure Static Web App
apps/mobile       → Expo / React Native (SDK 58, RN 0.88) + Expo Router
packages/functions → Azure Functions v4 (Node 22, TS)    → Azure Linux Function App
packages/shared    → Shared TypeScript types (polish, user, voice)
infrastructure/    → Terraform (azurerm ~4.50) for all Azure resources
```

**Data flow:** Clients → Azure Functions REST API (`/api/polishes`, `/api/polish-imports`, `/api/auth/*`, `/api/voice`) → Azure Database for PostgreSQL Flexible Server (schema in `docs/schema.sql`). Voice input goes through Azure Speech Services → Azure OpenAI for parsing polish details from transcriptions. Full canonical schema uses `pg_trgm` for fuzzy shade matching and `pgvector` for swatch similarity/dupe search.

### Rules that are easy to break

- **Ownership** is only `status = 'owned'` on `user_inventory_item`; never infer ownership or wishlist from `quantity`. Running out archives, never wishlists. → `docs/agents/inventory-and-wear.md`
- **Catalog write rule (#224):** user-supplied finishes and color fields are written to a shade only when the request creates it; adopting, matching or updating a shared shade never changes them (a user's own private `user_submitted` shade excepted). → `docs/agents/catalog-finishes-and-categories.md`
- **Private user media** is exposed only as owner-scoped `v3` image-proxy URLs; never return raw blob URLs or public `v2` ids for user media, and strip EXIF by re-encoding. → `docs/agents/private-media-and-sharing.md`
- **Access control:** every user-data route uses `withAuth` with `user_id`-scoped SQL; admin/ops routes use `withAdmin`.
- **CORS:** every HTTP route lists `"OPTIONS"` in `methods` and wraps its handler in `withCors` (no platform CORS). → `docs/agents/environment-variables.md`
- **Feature flags** are on only for the exact value `true` and are read through `isFeatureEnabled()` (`src/lib/feature-flags.ts`). → `docs/agents/environment-variables.md`
- **Color:** use OKLAB for color matching and sorting; never rank a fetched page by color on the client (ask the API with `nearHex=`; client ranking only for the fully loaded owned collection). → `docs/agents/color.md`
- **Retailers and feeds are fill-only** on brand-store shades; every listing write goes through `planListingWrites`. → `docs/agents/ingestion-sources.md`
- **Ingestion** writes catalog rows only, never inventory, and never replaces a `manual_label` vendor hex (`planIngestedVendorHex`). → `docs/agents/ingestion-sources.md`, `docs/agents/hexes-and-images.md`
- **Prompt versions:** bump `PROMPT_VERSION` (and `GLASS_PROMPT_VERSION` / `STICKER_READ_PROMPT_VERSION`) whenever a vision prompt changes. → `docs/agents/hexes-and-images.md`
- **Migrations:** never edit a committed migration; add a new one (`/create-migration`).
- **Store permission:** never enable a pending source or claim a store's OK that was not recorded (`data_source.metadata.permission`, admin Sources tab). → `docs/agents/ingestion-sources.md`
- **Caches:** any new inventory or mani-log write path calls `invalidatePolishCachesForUser()`. → `docs/agents/inventory-and-wear.md`

### Where to read before you change X

You MUST read the matching topic file before working in its area; this file only summarises.

| Area | Read |
|---|---|
| Finishes, finish catalog, product categories, accessories | `docs/agents/catalog-finishes-and-categories.md` |
| Color families, color search / sort, harmonies, gaps, Looks color rules | `docs/agents/color.md` |
| Vendor / detected / name hexes, hex labels, snap step, thumbnails, galleries | `docs/agents/hexes-and-images.md` |
| Inventory status, wear stats, collection stats, wishlist value | `docs/agents/inventory-and-wear.md` |
| Barcodes, capture API, Rapid Add bottle flow | `docs/agents/capture-barcodes-bottle.md` |
| Ingestion, data sources, connectors, retailers, buy links, MakeupAPI | `docs/agents/ingestion-sources.md` |
| Private media, nail / mani photos, capture frames, share links | `docs/agents/private-media-and-sharing.md` |
| Mobile app (`apps/mobile`) | `docs/agents/mobile-app.md` |
| Auth, admin users, telemetry, alerts, backups | `docs/agents/auth-telemetry-backups.md` |
| Web routes and pages | `docs/agents/web-routes.md` |
| Environment variables, flags, Terraform app settings | `docs/agents/environment-variables.md` |
| npm scripts beyond the everyday ones (evals, backfills, dedupes) | `docs/agents/dev-commands.md` |
| What has shipped already | `docs/agents/completed-work.md` |

## Dev Commands

```bash
# From repo root — all use npm workspaces
npm run setup            # Install workspace dependencies (npm ci)
npm run dev              # Shared types + Functions + web (parallel)
npm run dev:infra        # Start local Postgres + Azurite containers
npm run dev:web          # Next.js dev server (port 3000)
npm run dev:functions    # Functions TypeScript watch + func host
npm run dev:mobile       # Build shared types, then Expo start (apps/mobile)
npm run build            # Build all workspaces (shared → web → functions)
npm run lint             # ESLint across all workspaces
npm run typecheck        # tsc --noEmit across all workspaces
npm run migrate          # Run Postgres migrations
npm run test --workspace=swatchwatch-functions      # Functions unit tests (no DB)
npm run test --workspace=swatchwatch-shared         # Shared unit tests
npm run test --workspace=apps/mobile                 # Mobile unit tests
npm run test:e2e --workspace=swatchwatch-functions  # E2E API tests against a running local host
```

Every other script (`build:*`, `migrate:down`, `migrate:create`, `sync:design-tokens`, `generate:*`, `eval:*`, `backfill:*`, `dedupe:*`, `remove:source-images`, `roster:*`, the web and devtools tests, lifecycle hooks) is in `docs/agents/dev-commands.md`.

**Important:** `dev`, `dev:web`, `dev:functions`, and `dev:shared` run a dependency preflight and
print `npm run setup` if workspace dependencies are missing.

If you run web/functions separately without the watcher flow, build `packages/shared` first:
```bash
npm run build:shared
```

## Key Conventions

- **TypeScript strict mode everywhere.** Base config in `tsconfig.base.json` (ES2022, bundler resolution). Each package extends it.
- **Azure Functions v4 programming model:** Register HTTP triggers with `app.http()` in individual files under `packages/functions/src/functions/`. Each file exports handler functions and registers routes at module scope. Example pattern from `polishes.ts`:
  ```ts
  app.http("polishes-list", {
    methods: ["GET"],
    authLevel: "anonymous",
    route: "polishes/{id?}",
    handler: getPolishes,
  });
  ```
- **Shared types** live in `packages/shared/src/types/` and are re-exported from `packages/shared/src/index.ts`. The canonical domain types are `Polish`, `PolishFinish`, `User`, `AuthProvider`, `VoiceProcessRequest`, `VoiceProcessResponse`, etc. When adding new domain types, add them here and re-export.
- **Web app** uses `@/*` path alias pointing to `apps/web/src/*`. Styling uses Tailwind v4 via `@tailwindcss/postcss`.
- **UI components:** shadcn/ui primitives in `apps/web/src/components/ui/`. Custom components in `apps/web/src/components/`. Add new shadcn components with `cd apps/web && npx shadcn@latest add <name>`.
- **Color utilities:** use OKLAB for any color matching/sorting logic. Pure color rules shared by web and mobile (harmonies, gaps, dupes, Looks) live in `packages/shared/src/color/` and `packages/shared/src/looks/`; the web files are re-export shims. Full rules: `docs/agents/color.md`.
- **Mock data:** All pages now use the live API. The old `mock-data.ts` is no longer used. Dev DB is seeded with realistic data via migration 003.
- **Infrastructure as Code:** All Azure resources defined in `infrastructure/main.tf`. Resource naming follows `${base_name}-${environment}-{resource}-${random_suffix}` convention.

## Web App Routes

Route → file (under `apps/web/`). Behaviour notes for every route: `docs/agents/web-routes.md`.

| Route | File |
|-------|------|
| `/` | `src/app/(marketing)/page.tsx` |
| `/dashboard` | `src/app/(app)/dashboard/page.tsx` |
| `/admin` | `src/app/(admin)/admin/page.tsx` (tabs via `?tab=`) |
| `/admin/reference-data`, `/admin/jobs` | legacy redirects to `/admin?tab=…` |
| `/polishes` | `src/app/(app)/polishes/page.tsx` |
| `/polishes/<sub>` for `new`, `detail`, `looks`, `gaps`, `match`, `import`, `search` | `src/app/(app)/polishes/<sub>/page.tsx` |
| `/manis` | `src/app/(app)/manis/page.tsx` |
| `/rapid-add` | `src/app/rapid-add/page.tsx` |
| `/w/?token=…` | `src/app/w/page.tsx` (shared wishlist) |
| `/l/?token=…` | `src/app/l/page.tsx` (shared look) |

**Route groups:**
- `(marketing)` — Public pages with glass header + footer (no sidebar)
- `(app)` — Authenticated app pages wrapped in `AppShell` (sidebar navigation)
- `(admin)` — Admin-only pages with `RequireAuth` + `AppShell` at the page level

## Known State & TODOs

This project is in early development. The web UI is now fully API-driven. Backend handlers have placeholder/stub implementations marked with `TODO` comments:
- Voice processing in `voice.ts` stubs Speech-to-text and OpenAI parsing (returns empty transcription + zero-confidence parsed details)

Everything already shipped is listed in `docs/agents/completed-work.md`.

## Environment Variables

- Functions → `packages/functions/local.settings.json` (copy `local.settings.json.example`); Terraform-managed app settings + Key Vault references in Azure (e.g. `AZURE_AD_B2C_TENANT`, `AZURE_AD_B2C_CLIENT_ID`).
- Web → build-time `NEXT_PUBLIC_*` in `apps/web/.env.local`; mobile → `EXPO_PUBLIC_*` in `apps/mobile/.env.local`; infra → GitHub environment variables/secrets read by `deploy-infra.yml`.
- Migrations: `local.settings.json` values override the shell, then `DATABASE_URL` if set, else `PG*`.
- Flags are on only for the exact value `true`.
- Adding a variable: put it in its group in `docs/agents/environment-variables.md`, the `packages/functions/README.md` table and `local.settings.json.example` (web / mobile / infra: their READMEs); a new Functions setting also gets a Terraform variable, a `main.tf` app setting, a `deploy-infra.yml` line and a GitHub variable in `dev` and `prod`.

Every variable, by group: `docs/agents/environment-variables.md`.

## Adding a New Azure Function

1. Create a new file in `packages/functions/src/functions/`
2. Define handler function(s) with signature `(request: HttpRequest, context: InvocationContext) => Promise<HttpResponseInit>`
3. Register with `app.http("descriptive-name", { methods, route, handler })` at module scope
4. Use types from `swatchwatch-shared` — do not redefine domain types locally

## Claude Code Tooling

Project-level Claude Code config lives in `.claude/` and `.mcp.json` (checked in):

- **MCP servers** (`.mcp.json`, approve on first use): `context7` (live docs for Next 16, Tailwind v4, Expo, Azure Functions) and `postgres-dev` (read-only SQL against the `npm run dev:infra` Postgres on port 55432).
- **Skills** (`.claude/skills/`, user-invoked): `/create-migration <description>` (timestamped migration + Down section + `docs/schema.sql`) and `/add-endpoint <METHOD> <route> [admin]` (handler scaffold with `withAuth`/`withAdmin`, `user_id`-scoped SQL, tests, README row).
- **Subagents** (`.claude/agents/`): `access-control-reviewer` (per-user isolation review of a diff) and `docs-sync-checker` (diff vs. the Documentation Maintenance table).
- **Hook scripts** (`.claude/hooks/`): `guard-protected-files.mjs` (PreToolUse: blocks edits to committed migrations, `local.settings.json`, and `.env*` files other than `.env.example`) and `rebuild-shared.mjs` (PostToolUse: rebuilds `packages/shared` after edits). Both resolve the checkout from the edited file, so they work inside worktrees. They only see the Edit/Write/MultiEdit tools: changes made via Bash (`sed -i`, redirects) bypass them, so they are guard rails, not a hard boundary. They take effect once registered under `hooks` in `.claude/settings.json` (`PreToolUse`/`PostToolUse`, matcher `Edit|Write|MultiEdit`, command `node "$CLAUDE_PROJECT_DIR/.claude/hooks/<script>"`).

## Documentation Maintenance

**Always update documentation when making changes.** This is not optional.

**Keep `CLAUDE.md` under 20,000 characters.** It is loaded into every agent session and sent to GitHub Copilot code review, which refuses PRs whose custom instructions are too large. Put new detail in the matching `docs/agents/` file, not here.

When you add, remove, or modify functionality, update the relevant docs as part of the same PR:

| What changed | Update these |
|---|---|
| New route or page | `docs/agents/web-routes.md` + the compact Web App Routes table above + `apps/web/README.md` (mobile: `apps/mobile/README.md` routes table) |
| New/changed API endpoint | `packages/functions/README.md` route table |
| New shared type | `packages/shared/README.md` type catalog |
| New component | `apps/web/README.md` components section |
| New env variable | `docs/agents/environment-variables.md` (matching group) + `packages/functions/README.md` table + `packages/functions/local.settings.json.example` (web: `apps/web/README.md`; mobile: `apps/mobile/README.md` + `.env.example`; infra: `infrastructure/README.md`) |
| Infrastructure change | `infrastructure/README.md` resource table |
| New dev command or workflow | `docs/agents/dev-commands.md` (and the Dev Commands list above if it is an everyday command) + root `README.md` |
| New backfill / catalog data-repair job (`backfill:*`, `dedupe:*`) | Admin batch endpoint (body `after…Id` / `limit` / `dryRun`, response `nextAfter…Id`, `null` when done) + an entry in `BACKFILLS` in `apps/web/src/app/(admin)/admin/reference-data/components/backfills-tab.tsx` so it runs from `/admin?tab=backfills`; the npm script loops the same batch step |
| Shipped feature | a line in `docs/agents/completed-work.md` |
| Architectural decision | the matching `docs/agents/` file, plus a line in this file's "Rules that are easy to break" only if it is a cross-cutting invariant |

Documentation files in this project:
- `README.md` — project overview and quick start
- `.github/copilot-instructions.md` — AI agent context (symlink to `CLAUDE.md`)
- `docs/agents/` — agent topic files `CLAUDE.md` points to (index in `docs/agents/README.md`): architecture by area, full web routes, completed work, environment variables, all dev commands
- `CONTRIBUTING.md` — git workflow, code standards, PR process
- `docs/implementation-guide.md` — knowledge graph data model, matching, AI pipeline, Azure architecture, MVP plan
- `docs/schema.sql` — canonical Postgres DDL (pg_trgm, pgvector, all tables + indexes)
- `docs/seed_data_sources.sql` — idempotent seed data for external sources (OpenBeautyFacts, CosIng, etc.)
- Plans, specs, runbooks, retros, evaluations, queries and the backlog: listed in `docs/agents/README.md` → Other documentation files
- `docs/decisions-2026-10.md` — decision log (D1–D25) for the M2 batch: product rules, observability, release, follow-up tickets, catalog categories (D23), Expo/Looks early start and the overnight merge-to-`dev` rule (D24), Azure OpenAI APIM gateway removal (D25)
- `apps/web/README.md` — web app routes, components, conventions
- `apps/mobile/README.md` — mobile (Expo) app: run, env, auth + redirect URI, routes, Rapid Add, design tokens
- `packages/functions/README.md` — API routes, handler patterns
- `packages/functions/local.settings.json.example` — template for every Functions env var, in the same groups as the docs (copy → `local.settings.json`, gitignored)
- `packages/shared/README.md` — shared type catalog
- `infrastructure/README.md` — Terraform resources and variables

> **For AI agents:** `CLAUDE.md` is the canonical agent instruction source. `.github/copilot-instructions.md`, `.cursorrules`, `.windsurfrules`, and `AGENTS.md` are all symlinks to it.

## Git Workflow

**GitHub Flow** with **Conventional Commits**. See `CONTRIBUTING.md` for full details.

- **Branches:** `<type>/<issue#>-<description>` off `dev` (e.g., `feat/12-catalog-search`, `fix/34-color-wheel-safari`); `scripts/agent-worktree.sh` branches from `dev` by default
- **Commits:** `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:` prefixes
- **PRs:** Squash merge into `dev`. PR title = conventional commit message. Reference issues with `Closes #N`.
- **Integration branch (`dev`, decision D24):** feature PRs target `dev`. An unattended (overnight) session may squash-merge its own PR into `dev` once CI is green and every review thread is fixed or answered; only the owner merges `dev → main` (a release PR with a merge commit). Closing keywords fire only on `main`, so issues shipped to `dev` are closed by hand after the release (see the overnight runbooks in `docs/`).
- **Issues:** Use GitHub Issue templates (Feature, Bug, Chore). Add scope labels (`web`, `mobile`, `functions`, `infra`).

## Agent Worktrees

When working on a branch that isn't the current checkout, use **git worktrees** instead of switching branches. This avoids dirty-file conflicts (e.g., `.claude/settings.local.json`) and lets multiple agents work in parallel.

```bash
# Create a worktree for a new branch (defaults to branching from dev)
scripts/agent-worktree.sh feat/42-new-feature

# Branch from main instead
scripts/agent-worktree.sh fix/99-hotfix main

# Clean up when done
git worktree remove ../swatchwatch-worktrees/feat/42-new-feature
```

Worktrees live in `../swatchwatch-worktrees/<branch-name>` (sibling to the primary repo root). The script copies local `.env` and `packages/functions/local.settings.json` when present, then runs `npm ci` and builds shared types so the worktree is ready to use immediately.

**Rules:**
- Never switch branches in the primary checkout during agent work — use a worktree.
- Each worktree is independent: changes in one don't affect the other.
- Run `git worktree list` to see active worktrees.
- Remove worktrees after the branch is merged.
