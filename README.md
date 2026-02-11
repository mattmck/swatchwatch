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
                  ├── /api/auth/*         → Azure AD B2C token validation
                  ├── /api/ingestion/jobs → Connector pull jobs → external_product + ingestion_job
                  └── /api/voice          → Azure Speech → Azure OpenAI → parsed polish details
```

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
# Install all workspace dependencies
npm install

# Build shared types (required before other packages can import them)
npm run build --workspace=packages/shared

# Start web dev server
npm run dev:web          # → http://localhost:3000

# Start functions locally
npm run dev:functions    # → http://localhost:7071/api/*

# Start mobile
npm run dev:mobile       # → Expo dev server
```

## All Commands

| Command | What it does |
|---------|-------------|
| `npm run dev:web` | Next.js dev server (port 3000) |
| `npm run dev:mobile` | Expo start |
| `npm run dev:functions` | Azure Functions Core Tools (`func start`) |
| `npm run build:web` | Next.js production build |
| `npm run build:functions` | TypeScript compile for functions |
| `npm run lint` | ESLint across all workspaces |
| `npm run typecheck` | `tsc --noEmit` across all workspaces |

> Linting extends `eslint-config-next` from the repo root, so `next@16.1.6` is included in the root `devDependencies` to supply its bundled Babel parser. When upgrading Next in `apps/web`, bump the root version as well.

## CI/CD Workflows

| Workflow | Purpose | Trigger |
|----------|---------|---------|
| `.github/workflows/deploy-dev.yml` | Deploy web + function app code to dev | Push to `dev`, manual dispatch |
| `.github/workflows/deploy-infra-dev.yml` | Deploy Terraform infrastructure to dev | Push to `dev` when `infrastructure/**` changes, manual dispatch |

Temporary dev auth note:
`deploy-dev.yml` currently sets `AUTH_DEV_BYPASS=true` on the dev Function App and `NEXT_PUBLIC_AUTH_DEV_BYPASS=true` during dev web builds, so the web app sends `Bearer dev:<userId>` tokens to the API. This is temporary and should be removed after dev B2C auth wiring is complete.

Infrastructure deploy workflow requirements:
- GitHub secrets: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`
- GitHub variables: `TFSTATE_RESOURCE_GROUP`, `TFSTATE_STORAGE_ACCOUNT`, `TFSTATE_CONTAINER` (recommended: `tfstate`), `TFSTATE_BLOB_NAME` (recommended: `dev.terraform.tfstate`)
The workflow reads `pg-password` from Azure Key Vault at runtime and sets `TF_VAR_pg_admin_password` automatically.

## Project Structure — Web App

The web app is the most developed part of the project. Key pages:

| Route | File | Description |
|-------|------|-------------|
| `/` | `apps/web/src/app/(dashboard)/page.tsx` | Dashboard — stats cards, recent additions, finish breakdown |
| `/polishes` | `apps/web/src/app/polishes/page.tsx` | Collection table — search/filter + clickable sorting for status, brand, name, finish, and collection |
| `/polishes/new` | `apps/web/src/app/polishes/new/page.tsx` | Add polish form — color picker, star rating, voice input placeholder |
| `/polishes/[id]` | `apps/web/src/app/polishes/[id]/page.tsx` | Polish detail — all fields, photo placeholders, edit/delete |
| `/polishes/search` | `apps/web/src/app/polishes/search/page.tsx` | Color wheel search — two-column layout with collapsible wheel/harmonies, a single full-width harmony-only selector (All + harmony types) driving matching + recommendations, vertical lightness, snap chip, and one-click palette swatch focus |


**UI stack:** [shadcn/ui](https://ui.shadcn.com/) components in `src/components/ui/`, custom components in `src/components/`, Tailwind v4 styling.

**Data:** All pages now use the live API. The old `mock-data.ts` is no longer used.

## Environment Variables

Functions require secrets defined in `packages/functions/local.settings.json`:

| Variable | Purpose |
|----------|---------|
| `COSMOS_DB_CONNECTION` | Cosmos DB connection string |
| `AZURE_STORAGE_CONNECTION` | Storage account (swatch/nail photos) |
| `AZURE_SPEECH_KEY` | Azure Speech Services key |
| `AZURE_SPEECH_REGION` | Azure Speech Services region |
| `AZURE_OPENAI_ENDPOINT` | Azure OpenAI endpoint for voice parsing |
| `AZURE_OPENAI_KEY` | Azure OpenAI key |
| `AZURE_AD_B2C_TENANT` | B2C tenant name |
| `AZURE_AD_B2C_CLIENT_ID` | B2C app client ID |
| `AUTH_DEV_BYPASS` | Dev-only bypass (`true` enables `Bearer dev:<userId>` tokens); do not use in shared/prod environments |
| `NEXT_PUBLIC_API_URL` | Web API base URL used at web build time |
| `NEXT_PUBLIC_AUTH_DEV_BYPASS` | Web dev-only bypass toggle (`true` makes the UI send `Authorization: Bearer dev:1`) |

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
| [.github/copilot-instructions.md](.github/copilot-instructions.md) | AI coding agents | Conventions, patterns, decision rationale |
| [apps/web/README.md](apps/web/README.md) | Web developers | Web app architecture, components, routing |
| [packages/functions/README.md](packages/functions/README.md) | Backend developers | API routes, handler patterns, local dev |
| [packages/shared/README.md](packages/shared/README.md) | All developers | Shared types, how to add new types |
| [infrastructure/README.md](infrastructure/README.md) | DevOps / infra | Terraform resources, provisioning, variables |
