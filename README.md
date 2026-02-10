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
│   └── shared/           → Shared TypeScript types (polish, user, voice, capture)
└── infrastructure/       → Terraform (azurerm ~3.100)
```


**Live API:** As of Feb 2026, all frontend pages fetch from the live Azure Functions API. The dev database is seeded with realistic data matching the original mock-data.ts. See `packages/functions/migrations/002_add_user_facing_columns.sql` and `003_seed_dev_data.sql`.

**npm workspaces monorepo.** All commands run from the repo root.


### Data Flow

```
Web / Mobile → Azure Functions REST API → Azure PostgreSQL Flexible Server
                  ├── /api/polishes       → CRUD operations (user inventory)
                  ├── /api/capture/*      → Rapid Add capture session workflow
                  ├── /api/auth/*         → Azure AD B2C token validation
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
- **Docker** — for local Postgres (pgvector)
- **Azure Functions Core Tools v4** — for local functions development (`brew install azure-functions-core-tools@4`)
- **Terraform ≥ 1.5** — for infrastructure provisioning
- **Expo CLI** — for mobile development (`npx expo`)

## Quick Start

```bash
# Install all workspace dependencies
npm install

# Set up local database
cp .env.example .env                       # DATABASE_URL for migrations
npm run dev:db                             # Start Postgres via Docker Compose (port 5434)
npm run build --workspace=packages/shared  # Build shared types first
npm run migrate:dev                        # Apply migrations + seed data

# Start the full stack
npm run dev                                # Functions (7071) + Web (3000)
```

## All Commands

| Command | What it does |
|---------|-------------|
| `npm run dev` | Start functions + web concurrently |
| `npm run dev:web` | Next.js dev server (port 3000) |
| `npm run dev:mobile` | Expo start |
| `npm run dev:functions` | Azure Functions Core Tools (`func start`) |
| `npm run dev:db` | Start local Postgres via Docker Compose |
| `npm run dev:db:down` | Stop local Postgres |
| `npm run build:web` | Next.js production build |
| `npm run build:functions` | TypeScript compile for functions |
| `npm run lint` | ESLint across all workspaces |
| `npm run typecheck` | `tsc --noEmit` across all workspaces |

## Project Structure — Web App

The web app is the most developed part of the project. Key pages:

| Route | File | Description |
|-------|------|-------------|
| `/` | `apps/web/src/app/(dashboard)/page.tsx` | Dashboard — stats cards, recent additions, finish breakdown |
| `/polishes` | `apps/web/src/app/polishes/page.tsx` | Collection table — search, filter by brand/finish, sortable columns |
| `/polishes/new` | `apps/web/src/app/polishes/new/page.tsx` | Add polish form — color picker, star rating, voice input placeholder |
| `/polishes/[id]` | `apps/web/src/app/polishes/[id]/page.tsx` | Polish detail — all fields, photo placeholders, edit/delete |
| `/polishes/search` | `apps/web/src/app/polishes/search/page.tsx` | Color wheel search — hover to preview, click to lock, similar/complementary modes |


**UI stack:** [shadcn/ui](https://ui.shadcn.com/) components in `src/components/ui/`, custom components in `src/components/`, Tailwind v4 styling.

**Data:** All pages now use the live API. The old `mock-data.ts` is no longer used.

## Environment Variables

Functions require secrets defined in `packages/functions/local.settings.json`:

| Variable | Purpose |
|----------|---------|
| `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` | PostgreSQL connection (set by Docker Compose for local dev) |
| `AZURE_STORAGE_CONNECTION` | Storage account (swatch/nail photos) |
| `AZURE_SPEECH_KEY` | Azure Speech Services key |
| `AZURE_SPEECH_REGION` | Azure Speech Services region |
| `AZURE_OPENAI_ENDPOINT` | Azure OpenAI endpoint for voice parsing |
| `AZURE_OPENAI_KEY` | Azure OpenAI key |
| `AZURE_AD_B2C_TENANT` | B2C tenant name |
| `AZURE_AD_B2C_CLIENT_ID` | B2C app client ID |

Migrations use `DATABASE_URL` from the root `.env` file (see `.env.example`).

## VS Code

The repo includes VS Code configurations in `.vscode/`:

- **`launch.json`** — "Attach to Node Functions" debug config (port 9229)
- **`tasks.json`** — Build/watch/start tasks for functions
- **`settings.json`** — Azure Functions workspace settings
- **`extensions.json`** — Recommended extensions


**Migrations & Seed:**
```bash
npm run migrate:dev    # Apply all migrations + seed dev data
npm run migrate:down   # Roll back last migration
```
Migrations read `DATABASE_URL` from `.env` via `--envPath`. See `packages/functions/migrations/` for all migration files.

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
