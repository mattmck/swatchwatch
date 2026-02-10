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

**Auth:** Azure AD B2C (provisioned outside Terraform via portal). Functions read `AZURE_AD_B2C_TENANT` and `AZURE_AD_B2C_CLIENT_ID` from environment. Token validation is JWT-based via the `/api/auth/validate` endpoint.

## Dev Commands

```bash
# From repo root — all use npm workspaces
npm run dev:web          # Next.js dev server (port 3000)
npm run dev:mobile       # Expo start
npm run dev:functions    # Azure Functions Core Tools (func start)
npm run build:web        # Next.js production build
npm run build:functions  # TypeScript compile for functions
npm run lint             # ESLint across all workspaces
npm run typecheck        # tsc --noEmit across all workspaces
npm run migrate          # Run Postgres migrations (needs DATABASE_URL)
npm run migrate:down     # Roll back last migration
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
- **Mock data:** Currently using `apps/web/src/lib/mock-data.ts` with realistic `Polish` objects. When connecting to the real API, replace mock imports with `fetch("/api/polishes")` — types are already aligned.
- **Infrastructure as Code:** All Azure resources defined in `infrastructure/main.tf`. Resource naming follows `${base_name}-${environment}-{resource}-${random_suffix}` convention.

## Web App Routes

The web app uses Next.js route groups to separate public marketing pages from the authenticated app:

| Route | File | Notes |
|-------|------|-------|
| `/` | `src/app/(marketing)/page.tsx` | Landing page — hero, features, color showcase, CTA |
| `/dashboard` | `src/app/(app)/dashboard/page.tsx` | Client component, stats + recent additions |
| `/polishes` | `src/app/(app)/polishes/page.tsx` | Client component, filterable/sortable table |
| `/polishes/new` | `src/app/(app)/polishes/new/page.tsx` | Client component, form with color picker + star rating |
| `/polishes/[id]` | `src/app/(app)/polishes/[id]/page.tsx` | Server component, uses `generateStaticParams` |
| `/polishes/search` | `src/app/(app)/polishes/search/page.tsx` | Client component, canvas color wheel + OKLAB matching |

**Route groups:**
- `(marketing)` — Public pages with glass header + footer (no sidebar)
- `(app)` — Authenticated app pages wrapped in `AppShell` (sidebar navigation)

## Known State & TODOs

This project is in early development. The web UI prototype is functional with mock data. Backend handlers have placeholder/stub implementations marked with `TODO` comments:
- Postgres reads/writes in `polishes.ts` are stubbed — no DB client yet
- JWT validation in `auth.ts` returns 501 — Azure AD B2C JWKS verification not implemented
- Voice processing in `voice.ts` stubs Speech-to-text and OpenAI parsing
- `packages/functions` defines a local `Polish` interface that duplicates `packages/shared` — new code should import from `swatchwatch-shared` instead
- Infrastructure is migrating from Cosmos DB to Azure Database for PostgreSQL Flexible Server

## Environment Variables (Functions)

Defined in `packages/functions/local.settings.json`. Required secrets:
`PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `AZURE_STORAGE_CONNECTION`, `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_KEY`, `AZURE_AD_B2C_TENANT`, `AZURE_AD_B2C_CLIENT_ID`

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
