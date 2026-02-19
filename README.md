# 💅 SwatchWatch

Smart nail polish collection manager with voice input, color-based search, and cross-platform support.

## Architecture

```
swatchwatch/
├── apps/
│   ├── web/              → Next.js 16 (App Router) + Tailwind v4 + shadcn/ui
│   └── mobile/           → Expo / React Native (SDK 54)
├── packages/
│   ├── functions/        → Azure Functions v4 (Node 20, TypeScript)
│   └── shared/           → Shared TypeScript types (polish, user, voice)
└── infrastructure/       → Terraform (azurerm ~3.100)
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

### Deploy Targets

| Package | Target | Infrastructure |
|---------|--------|---------------|
| `apps/web` | Azure Static Web App | `infrastructure/main.tf` |
| `packages/functions` | Azure Linux Function App (Consumption) | `infrastructure/main.tf` |
| `apps/mobile` | Expo (iOS / Android) | N/A |

## Prerequisites

- **Node.js ≥ 20** (see `engines` in `package.json`)
- **Azure Functions Core Tools v4** — for local functions development (`npm i -g azure-functions-core-tools@4`)
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
npm run dev:mobile       # → mobile via Expo
```

## All Commands

| Command | What it does |
|---------|-------------|
| `npm run setup` | Install workspace dependencies (`npm ci`) |
| `npm run dev:infra` | Start local Postgres + Azurite containers in Docker |
| `npm run dev` | Run shared type watcher, Functions host, and web dev server together (CTRL+C stops all) |
| `npm run dev:web` | Next.js dev server (port 3000) |
| `npm run dev:mobile` | Expo start |
| `npm run dev:functions` | Functions TypeScript watch + Azure Functions Core Tools (`func start`) |
| `npm run build` | Build all workspaces (shared → web → functions) |
| `npm run build:shared` | Build shared types only |
| `npm run build:web` | Build shared types + Next.js production build |
| `npm run build:functions` | Build shared types + TypeScript compile for functions |
| `npm run lint` | ESLint across all workspaces |
| `npm run typecheck` | `tsc --noEmit` across all workspaces |

`dev`, `dev:web`, `dev:functions`, and `dev:shared` run a dependency preflight and print a clear
`npm run setup` hint if dependencies are missing.

> Linting extends `eslint-config-next` from the repo root, so `next@16.1.6` is included in the root `devDependencies` to supply its bundled Babel parser. When upgrading Next in `apps/web`, bump the root version as well.

## CI/CD Workflows

| Workflow | Purpose | Trigger |
|----------|---------|---------|
| `.github/workflows/deploy-dev.yml` | Deploy web + function app code to dev | Push to `dev`, manual dispatch |
| `.github/workflows/deploy-infra-dev.yml` | Deploy Terraform infrastructure to dev | Push to `dev` when `infrastructure/**` changes, manual dispatch |

Dev auth deploy note:
`deploy-dev.yml` reads auth config from the GitHub `dev` environment.
- Variables: `AUTH_DEV_BYPASS`, `NEXT_PUBLIC_AUTH_DEV_BYPASS`, `NEXT_PUBLIC_B2C_TENANT`, `NEXT_PUBLIC_B2C_SIGNUP_SIGNIN_POLICY`, `NEXT_PUBLIC_B2C_API_SCOPE` (optional)
- Secrets: `AZURE_AD_B2C_CLIENT_ID`, `NEXT_PUBLIC_B2C_CLIENT_ID`

Infrastructure deploy workflow requirements:
- GitHub secrets: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`
- GitHub variables: `TFSTATE_RESOURCE_GROUP`, `TFSTATE_STORAGE_ACCOUNT`, `TFSTATE_CONTAINER` (recommended: `tfstate`), `TFSTATE_BLOB_NAME` (recommended: `dev.terraform.tfstate`)
- Recommended for auth settings drift prevention in Terraform deploys: secret `AZURE_AD_B2C_CLIENT_ID`, variables `AUTH_DEV_BYPASS` and `AZURE_AD_B2C_TENANT` (or `NEXT_PUBLIC_B2C_TENANT`)
The workflow reads `pg-password` from Azure Key Vault at runtime and sets `TF_VAR_pg_admin_password` automatically.

## Project Structure — Web App

The web app is the most developed part of the project. Key pages:

| Route | File | Description |
|-------|------|-------------|
| `/` | `apps/web/src/app/(marketing)/page.tsx` | Marketing landing page |
| `/dashboard` | `apps/web/src/app/(app)/dashboard/page.tsx` | Dashboard — stats cards, recent additions, finish breakdown |
| `/admin/jobs` | `apps/web/src/app/(app)/admin/jobs/page.tsx` | Internal ingestion admin — run jobs, monitor status, inspect change metrics |
| `/polishes` | `apps/web/src/app/(app)/polishes/page.tsx` | Collection table — search, filter by brand/finish, sortable columns |
| `/polishes/new` | `apps/web/src/app/(app)/polishes/new/page.tsx` | Add polish form — color picker, star rating, voice input placeholder |
| `/polishes/detail` | `apps/web/src/app/(app)/polishes/detail/page.tsx` | Polish detail shell (query-param based) |
| `/polishes/search` | `apps/web/src/app/(app)/polishes/search/page.tsx` | Color wheel search — hover to preview, click to lock, similar/complementary modes |
| `/rapid-add` | `apps/web/src/app/rapid-add/page.tsx` | Capture-driven rapid add flow |

**UI stack:** [shadcn/ui](https://ui.shadcn.com/) components in `src/components/ui/`, custom components in `src/components/`, Tailwind v4 styling.

**Data:** All pages now use the live API. The old `mock-data.ts` is no longer used.

## Environment Variables

Functions require secrets defined in `packages/functions/local.settings.json`:

| Variable | Purpose |
|----------|---------|
| `COSMOS_DB_CONNECTION` | Cosmos DB connection string |
| `AZURE_STORAGE_CONNECTION` | Storage account (swatch/nail photos). In local dev this points to Azurite (see "Local storage emulator" below). |
| `INGESTION_JOB_QUEUE_NAME` | Optional async ingestion queue name (default: `ingestion-jobs`) |
| `SOURCE_IMAGE_CONTAINER` | Optional container for source-ingested product images (default: `source-images`) |
| `BLOB_READ_SAS_TTL_SECONDS` | Optional signed read URL TTL for blob-backed swatch images, in seconds (default: `3600`) |
| `AZURE_SPEECH_KEY` | Azure Speech Services key |
| `AZURE_SPEECH_REGION` | Azure Speech Services region |
| `AZURE_OPENAI_ENDPOINT` | Azure OpenAI endpoint for voice parsing |
| `AZURE_OPENAI_KEY` | Azure OpenAI key |
| `AZURE_OPENAI_DEPLOYMENT_HEX` | Optional Azure OpenAI deployment name for image-based hex detection |
| `AZURE_AD_B2C_TENANT` | B2C tenant name |
| `AZURE_AD_B2C_CLIENT_ID` | B2C app client ID |
| `AUTH_DEV_BYPASS` | Dev-only bypass (`true` enables `Bearer dev:<userId>` tokens); do not use in shared/prod environments |
| `NEXT_PUBLIC_API_URL` | Web API base URL used at web build time |
| `NEXT_PUBLIC_AUTH_DEV_BYPASS` | Web dev-only bypass toggle (`true` makes the UI send `Authorization: Bearer dev:1`) |
| `NEXT_PUBLIC_AUTH_DEV_ADMIN_USER_ID` | Optional web admin bypass user id for admin-only API calls (defaults to `2`) |
| `NEXT_PUBLIC_B2C_API_SCOPE` | Optional web auth scope(s) for API tokens (space-delimited). Defaults to `api://<NEXT_PUBLIC_B2C_CLIENT_ID>/access_as_user` |

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
    "SOURCE_IMAGE_CONTAINER": "source-images",
    "BLOB_READ_SAS_TTL_SECONDS": "3600"
  }
}
```

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
