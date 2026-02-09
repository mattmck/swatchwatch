# SwatchWatch — Agent Instructions

## Architecture Overview

Smart nail polish collection manager. **npm workspaces monorepo** with three deployable targets and a shared types package:

```
apps/web          → Next.js 16 (App Router) + Tailwind v4 + shadcn/ui → Azure Static Web App
apps/mobile       → Expo / React Native (SDK 54, RN 0.81)
packages/functions → Azure Functions v4 (Node 20, TS)    → Azure Linux Function App
packages/shared    → Shared TypeScript types (polish, user, voice)
infrastructure/    → Terraform (azurerm ~3.100) for all Azure resources
```

**Data flow:** Clients → Azure Functions REST API (`/api/polishes`, `/api/auth/*`, `/api/voice`) → Azure Database for PostgreSQL Flexible Server (schema in `docs/schema.sql`). Voice input goes through Azure Speech Services → Azure OpenAI for parsing polish details from transcriptions. Full canonical schema uses `pg_trgm` for fuzzy shade matching and `pgvector` for swatch similarity/dupe search.

**Auth:** Azure AD B2C (provisioned outside Terraform via portal). Functions read `AZURE_AD_B2C_TENANT` and `AZURE_AD_B2C_CLIENT_ID` from environment. Token validation is JWT-based via the `/api/auth/validate` endpoint. Locally, `AUTH_DEV_BYPASS=true` enables `Bearer dev:<userId>` tokens without cryptographic validation. The auth middleware (`packages/functions/src/lib/auth.ts`) provides `withAuth(handler)` to protect endpoints and pass the resolved `userId` to handlers.

## Dev Commands

```bash
# From repo root — all use npm workspaces
npm run dev              # Start functions + web concurrently
npm run dev:web          # Next.js dev server (port 3000)
npm run dev:mobile       # Expo start
npm run dev:functions    # Azure Functions Core Tools (func start)
npm run dev:db           # Start local Postgres via Docker Compose
npm run dev:db:down      # Stop local Postgres
npm run build:web        # Next.js production build
npm run build:functions  # TypeScript compile for functions
npm run lint             # ESLint across all workspaces
npm run typecheck        # tsc --noEmit across all workspaces
npm run migrate          # Run Postgres migrations — prod-safe (needs DATABASE_URL)
npm run migrate:dev      # Run migrations + seed dev data (demo user, mock polishes)
npm run migrate:down     # Roll back last migration
npm run migrate:down:dev # Roll back last migration (with dev seed awareness)
```

**Local dev quick start:**
```bash
cp .env.example .env                       # Set DATABASE_URL (adjust port if needed)
npm run dev:db                             # Start Postgres (pgvector, port 5434)
npm run build --workspace=packages/shared  # Build shared types
npm run migrate:dev                        # Apply migrations + seed data
npm run dev                                # Start functions (7071) + web (3000)
```

**Important:** Build `packages/shared` first when starting fresh — other packages depend on its compiled output:
```bash
npm run build --workspace=packages/shared
```

**Azure Functions debugging:** Use the VS Code launch config "Attach to Node Functions" which runs the `func: host start` task (builds, watches, starts func on port 9229).

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
- **Color utilities:** `apps/web/src/lib/color-utils.ts` provides Hex↔HSL↔RGB↔OKLAB conversions and perceptual `colorDistance()`. Use OKLAB for any color matching/sorting logic.
- **Mock data:** All pages now use the live API. Dev DB is seeded with realistic data via migration 003. The old `mock-data.ts` has been deleted.
- **Infrastructure as Code:** All Azure resources defined in `infrastructure/main.tf`. Resource naming follows `${base_name}-${environment}-{resource}-${random_suffix}` convention.

## Web App Routes

| Route | File | Notes |
|-------|------|-------|
| `/` | `src/app/(dashboard)/page.tsx` | Server component, stats + recent additions |
| `/polishes` | `src/app/polishes/page.tsx` | Client component, filterable/sortable table |
| `/polishes/new` | `src/app/polishes/new/page.tsx` | Client component, form with color picker + star rating |
| `/polishes/[id]` | `src/app/polishes/[id]/page.tsx` | Server component, uses `generateStaticParams` |
| `/polishes/search` | `src/app/polishes/search/page.tsx` | Client component, canvas color wheel + OKLAB matching |

## Known State & TODOs

This project is in early development. The web UI is connected to the live API. Backend handlers have placeholder/stub implementations marked with `TODO` comments:
- Voice processing in `voice.ts` stubs Speech-to-text and OpenAI parsing
- Infrastructure is migrating from Cosmos DB to Azure Database for PostgreSQL Flexible Server
- Auth uses dev bypass locally (`AUTH_DEV_BYPASS=true`) — real B2C login UI not yet built

## Environment Variables (Functions)

Defined in `packages/functions/local.settings.json`. Required secrets:
`PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `AZURE_STORAGE_CONNECTION`, `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_KEY`, `AZURE_AD_B2C_TENANT`, `AZURE_AD_B2C_CLIENT_ID`, `AUTH_DEV_BYPASS`

Web app env (in `.env` / `.env.example`): `DATABASE_URL`, `NEXT_PUBLIC_AUTH_DEV_BYPASS`

## Adding a New Azure Function

1. Create a new file in `packages/functions/src/functions/`
2. Define handler function(s) with signature `(request: HttpRequest, context: InvocationContext) => Promise<HttpResponseInit>`
3. Register with `app.http("descriptive-name", { methods, route, handler })` at module scope
4. Use types from `swatchwatch-shared` — do not redefine domain types locally

## Documentation Maintenance

**Always update documentation when making changes.** This is not optional.

When you add, remove, or modify functionality, update the relevant docs as part of the same PR:

| What changed | Update these |
|---|---|
| New route or page | Web App Routes table above + `apps/web/README.md` |
| New/changed API endpoint | `packages/functions/README.md` route table |
| New shared type | `packages/shared/README.md` type catalog |
| New component | `apps/web/README.md` components section |
| New env variable | Environment Variables section above + `packages/functions/README.md` |
| Infrastructure change | `infrastructure/README.md` resource table |
| New dev command or workflow | Dev Commands section above + root `README.md` |
| Architectural decision | This file's Architecture Overview |

Documentation files in this project:
- `README.md` — project overview and quick start
- `.github/copilot-instructions.md` — AI agent context (canonical source, mirrored to other agent files)
- `CONTRIBUTING.md` — git workflow, code standards, PR process
- `docs/implementation-guide.md` — knowledge graph data model, matching, AI pipeline, Azure architecture, MVP plan
- `docs/schema.sql` — canonical Postgres DDL (pg_trgm, pgvector, all tables + indexes)
- `docs/seed_data_sources.sql` — idempotent seed data for external sources (OpenBeautyFacts, CosIng, etc.)
- `docs/mvp-backlog.md` — epics, capabilities, stories, and milestone timeline
- `docs/azure-iac-bom.md` — per-environment Azure resource bill of materials
- `apps/web/README.md` — web app routes, components, conventions
- `packages/functions/README.md` — API routes, handler patterns
- `packages/shared/README.md` — shared type catalog
- `infrastructure/README.md` — Terraform resources and variables

> **For AI agents:** This file is the canonical agent instruction source. It is mirrored to `CLAUDE.md`, `.cursorrules`, and `.windsurfrules` at the repo root. When updating this file, update those mirrors too.

## Git Workflow

**GitHub Flow** with **Conventional Commits**. See `CONTRIBUTING.md` for full details.

- **Branches:** `<type>/<issue#>-<description>` off `main` (e.g., `feat/12-cosmos-db-client`, `fix/34-color-wheel-safari`)
- **Commits:** `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:` prefixes
- **PRs:** Squash merge into `main`. PR title = conventional commit message. Reference issues with `Closes #N`.
- **Issues:** Use GitHub Issue templates (Feature, Bug, Chore). Add scope labels (`web`, `mobile`, `functions`, `infra`).
