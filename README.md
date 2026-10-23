# 💅 SwatchWatch

[![CI](https://github.com/mattmck/swatchwatch/actions/workflows/ci.yml/badge.svg?branch=dev)](https://github.com/mattmck/swatchwatch/actions/workflows/ci.yml)
[![Deploy Dev](https://github.com/mattmck/swatchwatch/actions/workflows/deploy-dev.yml/badge.svg?branch=dev)](https://github.com/mattmck/swatchwatch/actions/workflows/deploy-dev.yml)
[![Deploy Prod](https://github.com/mattmck/swatchwatch/actions/workflows/deploy-prod.yml/badge.svg?branch=main)](https://github.com/mattmck/swatchwatch/actions/workflows/deploy-prod.yml)
![Last Commit](https://img.shields.io/github/last-commit/mattmck/swatchwatch)
![Issues](https://img.shields.io/github/issues/mattmck/swatchwatch)
![PRs](https://img.shields.io/github/issues-pr/mattmck/swatchwatch)
![License](https://img.shields.io/github/license/mattmck/swatchwatch)

Smart nail polish collection manager with voice input, color-based search, and cross-platform support.

## Architecture

```
swatchwatch/
├── apps/
│   ├── web/              → Next.js 16 (App Router) + Tailwind v4 + shadcn/ui
│   └── mobile/           → Expo / React Native (SDK 57, Expo Router)
├── packages/
│   ├── functions/        → Azure Functions v4 (Node 22, TypeScript)
│   └── shared/           → Shared TypeScript types (polish, user, voice)
└── infrastructure/       → Terraform (azurerm ~4.50)
```


**Live API:** As of Feb 2026, all frontend pages fetch from the live Azure Functions API. The dev database is seeded with realistic data matching the original mock-data.ts. See `packages/functions/migrations/002_add_user_facing_columns.sql` and `003_seed_dev_data.sql`.

**npm workspaces monorepo.** All commands run from the repo root.


### Data Flow

```
Web / Mobile → Azure Functions REST API → Azure PostgreSQL Flexible Server
                  ├── /api/polishes       → CRUD operations (user inventory)
                  ├── /api/auth/*         → Entra External ID / Azure AD B2C token validation
                  ├── /api/ingestion/jobs → Connector pull jobs → external_product + ingestion_job
                  └── /api/voice          → Azure Speech → Azure OpenAI → parsed polish details
```

Admin authorization note:
- In production auth mode, admin access is determined by Entra token `roles` (expects `admin`).
- The backend mirrors that role into `app_user.role` on authenticated requests.
- External identities are linked to one local account by email via `user_external_identities`; admins can manually merge duplicates with `POST /api/users-admin/merge`. Apply the migration that creates `user_external_identities` first (`npm run migrate --workspace=packages/functions`) before relying on linkage or using `POST /api/users-admin/merge`.

### Deploy Targets

| Package | Target | Infrastructure |
|---------|--------|---------------|
| `apps/web` | Azure Static Web App | `infrastructure/main.tf` |
| `packages/functions` | Azure Linux Function App (Consumption) | `infrastructure/main.tf` |
| `apps/mobile` | Expo (iOS / Android) | N/A |

## Prerequisites

- **Node.js ≥ 20** (see `engines` in `package.json`)
- **Docker** — for local Postgres (pgvector)
- **Azure Functions Core Tools v4** — for local functions development (`brew install azure-functions-core-tools@4`)
- **Terraform ≥ 1.5** — for infrastructure provisioning
- **Expo CLI** — for mobile development (`npx expo`)

## Quick Start

```bash
# Install workspace dependencies
npm run setup            # (same as npm ci)

# Start local infra containers (Postgres + Azurite)
npm run dev:infra

# Start dev stack (shared types + functions + web)
npm run dev              # → web on http://localhost:3000, API on http://localhost:7071/api/*

# Or run pieces individually
npm run dev:web          # → web only
npm run dev:functions    # → functions only (builds on change via TypeScript watch)
npm run dev:mobile       # → mobile via Expo (see apps/mobile/README.md)
```

## All Commands

| Command | What it does |
|---------|-------------|
| `npm run setup` | Install workspace dependencies (`npm ci`) |
| `npm run dev:infra` | Start local Postgres + Azurite containers in Docker |
| `npm run dev` | Run shared type watcher, Functions host, and web dev server together (CTRL+C stops all) |
| `npm run dev:web` | Next.js dev server (port 3000) |
| `npm run dev:mobile` | Build shared types, then Expo start for `apps/mobile` (copy `apps/mobile/.env.example` to `.env.local` first) |
| `npm run lint\|typecheck\|test --workspace=apps/mobile` | Mobile ESLint, `tsc --noEmit` and unit tests (what CI's Mobile job runs) |
| `npm run sync:design-tokens` | Regenerate the shared light/dark color tokens (used by mobile) from the web theme; `-- --check` fails on drift |
| `npm run dev:functions` | Functions TypeScript watch + Azure Functions Core Tools (`func start`) |
| `npm run dev:shared` | Watch-build `packages/shared` only |
| `npm run build` | Build all workspaces (shared → web → functions) |
| `npm run build:shared` | Build shared types only |
| `npm run build:web` | Build shared types + Next.js production build |
| `npm run build:functions` | Build shared types + TypeScript compile for functions |
| `npm run lint` | ESLint across all workspaces |
| `npm run test` | Run workspace tests where present (includes Functions unit tests; builds shared + functions first) |
| `npm run test --workspace=swatchwatch-shared` | Shared unit tests (color harmonies, Pair it; node:test via tsx; CI's "Shared unit tests" step) |
| `npm run test:e2e --workspace=swatchwatch-functions` | E2E API + cross-user access-control tests against a running local Functions host (`AUTH_DEV_BYPASS=true`); skips when the host is unreachable |
| `npm run backfill:product-category --workspace=swatchwatch-functions` | Re-classify every shade's product category (#349, #347) via `POST /api/shades-admin/product-category/backfill` and save the JSON report (`--out`); dry run unless `--write`; `--clear-topper-hex` also clears suspicious topper detected hexes (logged for undo); `API_BASE_URL`, `ADMIN_BEARER_TOKEN` |
| `npm run backfill:product-price --workspace=swatchwatch-functions` | Recompute product `price`/`currency` (brand list price for the buy link) from `raw_json`; Shopify store currency from `data_source.metadata.currency`, earlier ingests, or the shop's `/meta.json` (`--no-fetch-currency` skips it); dry run unless `--write`; needs Postgres |
| `npm run backfill:product-text --workspace=swatchwatch-functions` | Recompute product `descriptionText`/`descriptors` from `raw_json` and report empty-finish coverage (#352); dry run unless `--write` (`--fill-finishes` also fills empty shade finishes) |
| `npm run typecheck` | `tsc --noEmit` across all workspaces |
| `npm run migrate` / `npm run migrate:down` | Apply pending Postgres migrations / roll back the last one (an exported `DATABASE_URL`, else the `PG*` values from `local.settings.json`) |
| `npm run generate:types` | Regenerate the `SupportedConnectorSource` type from `docs/seed_data_sources.sql` |
| `npm run generate:pwa-icons` | Regenerate the PWA / apple-touch PNG icons in `apps/web/public` from the brand SVG (commit the PNGs) |
| `npm run dedupe:gallery-images --workspace=swatchwatch-functions` | Unlink catalog gallery images that duplicate another image of the same shade (the same vendor picture stored twice), matched perceptually, in batches via `POST /api/images-admin/gallery-dedupe` (`API_BASE_URL`, `ADMIN_BEARER_TOKEN`; dry run unless `--write`, `--shade <ids>`, `--after <shadeId>` resumes); also backfills `image_asset` perceptual fingerprints, even in a dry run, unless `--no-store-fingerprints` |
| `npm run backfill:barcodes --workspace=swatchwatch-functions` | Build catalog `barcode` rows from stored connector products (GTIN + variant barcodes → shade via `shade_source_product`) in batches via `POST /api/barcodes-admin/backfill` (`API_BASE_URL`, `ADMIN_BEARER_TOKEN`; dry run unless `--write`, `--after <externalProductId>` resumes; first shade to claim a GTIN keeps it, conflicts are listed) |
| `npm run backfill:image-variants --workspace=swatchwatch-functions` | Generate missing pre-generated catalog thumbnails for images stored before variants existed, in batches via `POST /api/images-admin/variants/backfill` (`API_BASE_URL`, `ADMIN_BEARER_TOKEN`; idempotent, `--after <imageId>` resumes) |

`dev`, `dev:web`, `dev:functions`, and `dev:shared` run a dependency preflight and print a clear
`npm run setup` hint if dependencies are missing.

> Linting extends `eslint-config-next` from the repo root, so `next@16.1.6` is included in the root `devDependencies` to supply its bundled Babel parser. When upgrading Next in `apps/web`, bump the root version as well.

## CI/CD Workflows

| Workflow | Purpose | Trigger |
|----------|---------|---------|
| `.github/workflows/deploy.yml` | Reusable app deploy workflow (web + functions + smoke tests) | Called by env-specific workflows, manual dispatch |
| `.github/workflows/deploy-dev.yml` | Deploy app stack to dev (runs infra first when infra files changed) | Push to `dev`, manual dispatch |
| `.github/workflows/deploy-prod.yml` | Deploy app stack to prod (runs infra first when `infrastructure/**` changed) | Push to `main`, manual dispatch |
| `.github/workflows/deploy-infra.yml` | Reusable Terraform deploy workflow | Called by env-specific workflows, manual dispatch |
| `.github/workflows/deploy-infra-dev.yml` | Deploy Terraform infrastructure to dev (infra-only; never while Deploy Dev runs, see `infrastructure/README.md` → Deploy ordering) | Manual dispatch |
| `.github/workflows/deploy-infra-prod.yml` | Deploy Terraform infrastructure to prod (infra-only) | Manual dispatch |

Claude assistant workflows (`.github/workflows/claude.yml`, `.github/workflows/claude-code-review.yml`) are advisory and configured as non-blocking, so quota/credit failures emit warnings without failing the overall run.

App deploy workflow requirements (environment-scoped in GitHub `dev` / `prod` environments):
- Variables: `AUTH_DEV_BYPASS`, `NEXT_PUBLIC_AUTH_DEV_BYPASS`, `NEXT_PUBLIC_B2C_TENANT`, `NEXT_PUBLIC_B2C_TENANT_ID` (CIAM tenant GUID), `NEXT_PUBLIC_B2C_SIGNUP_SIGNIN_POLICY`, `NEXT_PUBLIC_B2C_API_SCOPE` (optional)
- Secrets: `AZURE_AD_B2C_CLIENT_ID`, `NEXT_PUBLIC_B2C_CLIENT_ID`, `AZURE_STATIC_WEB_APPS_API_TOKEN`, `DATABASE_URL`

Infrastructure deploy workflow requirements (environment-scoped in GitHub `dev` / `prod` environments):
- GitHub secrets: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`
- GitHub variables: `TFSTATE_RESOURCE_GROUP`, `TFSTATE_STORAGE_ACCOUNT`, `TFSTATE_CONTAINER` (recommended: `tfstate`), `TFSTATE_BLOB_NAME` (recommended: `<environment>.terraform.tfstate`)
- OpenAI mode variable: `CREATE_OPENAI_RESOURCES` (`true` to have Terraform manage OpenAI account/deployment; default in workflow is `true`)
- Optional OpenAI variables (used when `CREATE_OPENAI_RESOURCES=false` for external/shared accounts): `OPENAI_ENDPOINT`, `OPENAI_ACCOUNT_NAME`, `OPENAI_DEPLOYMENT_NAME`
- Recommended for auth settings drift prevention in Terraform deploys: secret `AZURE_AD_B2C_CLIENT_ID`, variables `AUTH_DEV_BYPASS` and `AZURE_AD_B2C_TENANT` (or `NEXT_PUBLIC_B2C_TENANT`)
The workflow reads `pg-password` from Azure Key Vault at runtime and sets `TF_VAR_pg_admin_password` automatically. In external OpenAI mode (`CREATE_OPENAI_RESOURCES=false`), it resolves the account name and injects `TF_VAR_openai_api_key` from Azure Cognitive Services keys.

## Project Structure — Web App

The web app is the most developed part of the project. Key pages:

| Route | File | Description |
|-------|------|-------------|
| `/` | `apps/web/src/app/(marketing)/page.tsx` | Marketing landing page |
| `/dashboard` | `apps/web/src/app/(app)/dashboard/page.tsx` | Dashboard — stats cards, recent additions, finish breakdown |
| `/admin` | `apps/web/src/app/(admin)/admin/page.tsx` | Unified admin console — tabs: Configuration (finish/harmony CRUD), Job Runs (reference-admin jobs), Admin Jobs (ingestion jobs), User Management (search/filter/sort users, detail dialog to edit the handle and suspend/reactivate, audit history, duplicate-account merge), Review Queue (user-submitted shades), Hex Labeling (eyedropper ground-truth hexes for the hex-detection eval) |
| `/admin/reference-data` | `apps/web/src/app/(admin)/admin/reference-data/page.tsx` | Legacy redirect → `/admin?tab=configuration` |
| `/admin/jobs` | `apps/web/src/app/(app)/admin/jobs/page.tsx` | Legacy redirect → `/admin?tab=admin-jobs` |
| `/polishes` | `apps/web/src/app/(app)/polishes/page.tsx` | Collection table — search/filter/sort with All/My Collection scope toggle and URL-persisted list state |
| `/polishes/new` | `apps/web/src/app/(app)/polishes/new/page.tsx` | Add polish form — color picker, star rating, voice input placeholder |
| `/polishes/detail` | `apps/web/src/app/(app)/polishes/detail/page.tsx` | Polish detail shell (query-param based) |
| `/polishes/gaps` | `apps/web/src/app/(app)/polishes/gaps/page.tsx` | Collection gap map — 8×5 hue/lightness heatmap with missing/thin coverage, next-buy suggestions, and deep-link handoff to color search |
| `/polishes/match` | `apps/web/src/app/(app)/polishes/match/page.tsx` | Photo match (#105) — upload, drop, or snap a photo (drag to focus on one area); extracts its dominant colors and ranks shades from your collection, wishlist or the whole catalog by OKLAB distance, with finish/color-family filters, per-color matches, confidence badges and wishlist/own actions (image is never stored) |
| `/polishes/search` | `apps/web/src/app/(app)/polishes/search/page.tsx` | Color wheel search — hover to preview, click to lock, similar/complementary modes |
| `/rapid-add` | `apps/web/src/app/rapid-add/page.tsx` | Capture-driven rapid add flow |

**UI stack:** [shadcn/ui](https://ui.shadcn.com/) components in `src/components/ui/`, custom components in `src/components/`, Tailwind v4 styling.

**Data:** All pages now use the live API. The old `mock-data.ts` is no longer used.

## Environment Variables

Each deploy target has its own settings. The full references, grouped by module with defaults, live next to the code:

| Target | Local file | Reference |
|--------|-----------|-----------|
| Functions API | `packages/functions/local.settings.json` (copy `local.settings.json.example`) | [`packages/functions/README.md` → Environment Variables](packages/functions/README.md#environment-variables) |
| Web | `apps/web/.env.local` (`NEXT_PUBLIC_*`, inlined at build time; Next.js reads env files from `apps/web` only) | [`apps/web/README.md` → Environment Variables](apps/web/README.md#environment-variables) |
| Mobile | `apps/mobile/.env.local` (copy `apps/mobile/.env.example`) | [`apps/mobile/README.md`](apps/mobile/README.md) |
| Migrations | `PG*` from `local.settings.json`, or an exported `DATABASE_URL` (local value in the root `.env.example`) | [`packages/functions/README.md` → Migrations](packages/functions/README.md#migrations) |
| Terraform / CI | GitHub environment variables and secrets | [`infrastructure/README.md`](infrastructure/README.md) |

For a local stack (`npm run dev:infra` + `npm run dev`) the copied example files already work with dev bypass auth. The settings you most often change:

| Variable | Where | Purpose |
|----------|-------|---------|
| `PGHOST` … `PGPASSWORD` | Functions | Postgres connection (example points at the `dev:infra` container on port 55432) |
| `AZURE_STORAGE_CONNECTION`, `AzureWebJobsStorage` | Functions | Blob + queue storage (example points at Azurite, see below) |
| `AUTH_DEV_BYPASS` / `NEXT_PUBLIC_AUTH_DEV_BYPASS` / `EXPO_PUBLIC_AUTH_DEV_BYPASS` | Functions / web / mobile | Dev-only `Bearer dev:<userId>` auth; refused by Functions hosted in Azure |
| `AZURE_AD_B2C_TENANT`, `AZURE_AD_B2C_CLIENT_ID` / `NEXT_PUBLIC_B2C_*` | Functions / web | Real Entra External ID sign-in |
| `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_KEY`, `AZURE_OPENAI_DEPLOYMENT_HEX` | Functions | Vision hex detection and label OCR parsing (ingestion, `recalc-hex`) |
| `IMAGE_PROXY_SIGNING_KEY` | Functions | Signs `/api/images/{id}` ids; optional locally with dev bypass (ephemeral key) |
| `NEXT_PUBLIC_API_URL` / `EXPO_PUBLIC_API_URL` | Web / mobile | Functions API base URL (default `http://localhost:7071/api`) |

### Local storage emulator (Azurite)

For local blob storage (used by the Holo Taco connector and other ingestion jobs), run Azurite via `docker-compose`:

```bash
npm run dev:infra
```

Then set the following in `packages/functions/local.settings.json` (the `agent-worktree.sh` script already uses these defaults for new worktrees):

```jsonc
{
  "Values": {
    "AzureWebJobsStorage": "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;QueueEndpoint=http://127.0.0.1:10001/devstoreaccount1;TableEndpoint=http://127.0.0.1:10002/devstoreaccount1;",
    "AZURE_STORAGE_CONNECTION": "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;QueueEndpoint=http://127.0.0.1:10001/devstoreaccount1;TableEndpoint=http://127.0.0.1:10002/devstoreaccount1;",
    "SOURCE_IMAGE_CONTAINER": "source-images"
  }
}
```

`npm run migrate` loads `packages/functions/local.settings.json` into the environment, so the `PG*` values above are enough; an exported `DATABASE_URL` (local value in the root `.env.example`) takes precedence.

## VS Code

The repo includes VS Code configurations in `.vscode/`:

- **`launch.json`** — "Attach to Node Functions" debug config (port 9229)
- **`tasks.json`** — Build/watch/start tasks for functions
- **`settings.json`** — Azure Functions workspace settings
- **`extensions.json`** — Recommended extensions


**Migrations & Seed:**
Run new migrations with:
```bash
cd packages/functions
PGUSER=pgadmin PGPASSWORD=... PGHOST=... PGDATABASE=swatchwatch npm run migrate
# Or run .sql files directly with psql
```
See `migrations/002_add_user_facing_columns.sql` and `003_seed_dev_data.sql`.

## Current Status

This project is in early development. The web UI is now fully API-driven. See [Known State & TODOs](.github/copilot-instructions.md#known-state--todos) for backend stubs.

## Documentation

| Document | Audience | Content |
|----------|----------|---------|
| [This README](README.md) | All developers | Setup, architecture, quick start |
| [CLAUDE.md](CLAUDE.md) | AI coding agents | Conventions, patterns, decision rationale (canonical; other agent files are symlinks) |
| [apps/web/README.md](apps/web/README.md) | Web developers | Web app architecture, components, routing |
| [docs/issue-42-ui-findings-tracker.md](docs/issue-42-ui-findings-tracker.md) | Web + product | Live tracker for Issue #42 UI findings and implementation status |
| [packages/functions/README.md](packages/functions/README.md) | Backend developers | API routes, handler patterns, local dev |
| [packages/shared/README.md](packages/shared/README.md) | All developers | Shared types, how to add new types |
| [infrastructure/README.md](infrastructure/README.md) | DevOps / infra | Terraform resources, provisioning, variables |
