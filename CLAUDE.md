# SwatchWatch — Agent Instructions

## Architecture Overview

Smart nail polish collection manager. **npm workspaces monorepo** with three deployable targets and a shared types package:

```
apps/web          → Next.js 16 (App Router) + Tailwind v4 + shadcn/ui → Azure Static Web App
apps/mobile       → Expo / React Native (SDK 54, RN 0.81)
packages/functions → Azure Functions v4 (Node 22, TS)    → Azure Linux Function App
packages/shared    → Shared TypeScript types (polish, user, voice)
infrastructure/    → Terraform (azurerm ~4.50) for all Azure resources
```

**Data flow:** Clients → Azure Functions REST API (`/api/polishes`, `/api/auth/*`, `/api/voice`) → Azure Database for PostgreSQL Flexible Server (schema in `docs/schema.sql`). Voice input goes through Azure Speech Services → Azure OpenAI for parsing polish details from transcriptions. Full canonical schema uses `pg_trgm` for fuzzy shade matching and `pgvector` for swatch similarity/dupe search.

**Finishes:** shades carry `shade.finishes text[]` (canonical, primary first) plus the legacy `shade.finish` (identity key, kept for backward compat). At runtime the admin-managed `finish_type` table is the source of truth for which finishes are valid, and `finish_normalization` holds the alias spellings; both are loaded together (one cached query) by `loadFinishCatalog()` in `packages/functions/src/lib/finishes.ts`, so a finish type created only in the admin UI is fully usable (parsing, validation, filtering, form options). `CANONICAL_FINISHES` in `packages/shared` holds the built-in seeded defaults, used for typing (`PolishFinish`) and as the fallback when the DB/reference API is unavailable; a test keeps it equal to the migration seeds. Request `tags` on polish create/update never modify catalog finishes (shades are shared); only ingestion connectors parse finishes from product tags.

**Auth:** Azure AD B2C (provisioned outside Terraform via portal). Functions read `AZURE_AD_B2C_TENANT` and `AZURE_AD_B2C_CLIENT_ID` from environment. Token validation is JWT-based via the `/api/auth/validate` endpoint.

## Dev Commands

```bash
# From repo root — all use npm workspaces
npm run setup            # Install workspace dependencies (npm ci)
npm run dev              # Shared types + Functions + web (parallel)
npm run dev:infra        # Start local Postgres + Azurite containers
npm run dev:web          # Next.js dev server (port 3000)
npm run dev:mobile       # Expo start
npm run dev:functions    # Functions TypeScript watch + func host
npm run build            # Build all workspaces (shared → web → functions)
npm run build:shared     # Build shared types only
npm run build:web        # Build shared types + Next.js production build
npm run build:functions  # Build shared types + TypeScript compile for functions
npm run lint             # ESLint across all workspaces
npm run typecheck        # tsc --noEmit across all workspaces
npm run migrate          # Run Postgres migrations (needs DATABASE_URL)
npm run migrate:down     # Roll back last migration
npm run test --workspace=swatchwatch-functions      # Functions unit tests (no DB; includes access-control isolation tests)
npm run test:e2e --workspace=swatchwatch-functions  # E2E API + cross-user access-control tests against a running local host (skips if unreachable)
npm run eval:hex --workspace=swatchwatch-functions -- --strategy pixel            # Hex-detection ground-truth eval (strategies: azure-current, azure-blind, pixel; Azure ones skip without config)
npm run eval:hex:populate --workspace=swatchwatch-functions -- --dry-run         # Fill color_training_sample from shades with real vendor hexes and export a fixture (needs Postgres)
```

**Important:** `dev`, `dev:web`, `dev:functions`, and `dev:shared` run a dependency preflight and
print `npm run setup` if workspace dependencies are missing.

If you run web/functions separately without the watcher flow, build `packages/shared` first:
```bash
npm run build:shared
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
- **Mock data:** All pages now use the live API. The old `mock-data.ts` is no longer used. Dev DB is seeded with realistic data via migration 003.
- **Infrastructure as Code:** All Azure resources defined in `infrastructure/main.tf`. Resource naming follows `${base_name}-${environment}-{resource}-${random_suffix}` convention.

## Web App Routes

The web app uses Next.js route groups to separate public marketing pages from the authenticated app:

| Route | File | Notes |
|-------|------|-------|
| `/` | `src/app/(marketing)/page.tsx` | Landing page — hero, features, color showcase, CTA |
| `/dashboard` | `src/app/(app)/dashboard/page.tsx` | Client component, stats + recent additions |
| `/admin` | `src/app/(admin)/admin/page.tsx` | Unified admin console — tabs: Configuration, Job Runs, Admin Jobs |
| `/admin/reference-data` | `src/app/(admin)/admin/reference-data/page.tsx` | Legacy redirect → `/admin?tab=configuration` |
| `/admin/jobs` | `src/app/(app)/admin/jobs/page.tsx` | Legacy redirect → `/admin?tab=admin-jobs` |
| `/polishes` | `src/app/(app)/polishes/page.tsx` | Client component, filterable/sortable table |
| `/polishes/new` | `src/app/(app)/polishes/new/page.tsx` | Client component, form with color picker + star rating |
| `/polishes/detail` | `src/app/(app)/polishes/detail/page.tsx` | Client component, detail shell driven by query params |
| `/polishes/gaps` | `src/app/(app)/polishes/gaps/page.tsx` | Client component, collection gap heatmap (hue × lightness coverage + next-buy targets) |
| `/polishes/match` | `src/app/(app)/polishes/match/page.tsx` | Client component, photo → owned-polish color matching (upload/drop/camera, extracted palette filter, confidence badges) via `POST /api/polishes/match-image` |
| `/polishes/search` | `src/app/(app)/polishes/search/page.tsx` | Client component, canvas color wheel + OKLAB matching |
| `/rapid-add` | `src/app/rapid-add/page.tsx` | Client component, capture-first rapid add workflow |

**Route groups:**
- `(marketing)` — Public pages with glass header + footer (no sidebar)
- `(app)` — Authenticated app pages wrapped in `AppShell` (sidebar navigation)
- `(admin)` — Admin-only pages with `RequireAuth` + `AppShell` at the page level

## Known State & TODOs

This project is in early development. The web UI is now fully API-driven. Backend handlers have placeholder/stub implementations marked with `TODO` comments:
- Voice processing in `voice.ts` stubs Speech-to-text and OpenAI parsing (returns empty transcription + zero-confidence parsed details)

**Completed (M0):**
- ✅ JWT validation in `packages/functions/src/lib/auth.ts` — Full JWKS-based validation with dev bypass mode, user auto-creation on first login
- ✅ Web app B2C auth wiring — MSAL integration with graceful dev bypass fallback, auth guards on `(app)` routes, real user display in sidebar
- ✅ Unified admin console at `/admin` — Configuration (finish/harmony CRUD + finish-normalization aliases), Job Runs (reference-admin job history), Admin Jobs (ingestion pipeline)
- ✅ Capture API — barcode/label/color frame submission with adaptive question flow (`capture.ts`)
- ✅ Catalog search — `pg_trgm`-based fuzzy search across brand/shade names and aliases (`catalog.ts`)
- ✅ Image proxy — private blob storage served through `/api/images/{id}` (`images.ts`); ids are HMAC-signed capabilities and reads are limited to the source-image container
- ✅ Per-user access control (#47) — all user-data routes use `withAuth` with `user_id`-scoped SQL; admin/ops routes use `withAdmin`; capture frames can only reference the caller's own `image_asset` rows; user-created shades are `user_submitted` (private until an admin sets `active`), shared shades are fill-only for users, and email account-linking requires a verified email
- ✅ Connector ingestion pipeline — async queue-backed jobs for OpenBeautyFacts, MakeupAPI, HoloTacoShopify, and generic Shopify sources
- ✅ AI hex detection — Azure OpenAI vision-based `detected_hex` from product images, with `recalc-hex` admin endpoint
- ✅ Reference data management — `finish_type`, `harmony_type`, `finish_normalization` tables with admin CRUD and public read endpoints
- ✅ Hex-detection evaluation harness — `packages/functions/src/eval/hex/` scores detection strategies against ground-truth fixtures (OKLAB distance, HIGH/MEDIUM shares, per brand/finish); `color_training_sample` (migration `20261016040629000_add-color-training-sample.sql`) holds DB-sourced samples. See `packages/functions/README.md`
- ✅ Feature-flagged Azure OpenAI batch pipeline for Shopify vision hex detection — submit → awaiting_ai → poll/apply completion flow with synchronous fallback for small runs

## Environment Variables (Functions)

**Canonical reference:** `packages/functions/local.settings.json.example` — this is the single source of truth for all settings. Copy it to `local.settings.json` (gitignored) and fill in the `<YOUR_*>` placeholders.

Required:
`AzureWebJobsStorage`, `FUNCTIONS_WORKER_RUNTIME`, `AZURE_STORAGE_CONNECTION`, `INGESTION_JOB_QUEUE_NAME`, `SOURCE_IMAGE_CONTAINER`, `BLOB_READ_SAS_TTL_SECONDS`, `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_KEY`, `AZURE_OPENAI_DEPLOYMENT_HEX`, `AZURE_AD_B2C_TENANT`, `AZURE_AD_B2C_CLIENT_ID`, `REDIS_URL`, `REDIS_KEY`, `IMAGE_PROXY_SIGNING_KEY`

- `IMAGE_PROXY_SIGNING_KEY` — secret (>= 32 chars) that HMAC-signs `/api/images/{id}` capability ids (`src/lib/image-proxy.ts`). Fails closed when unset (image URLs omitted, proxy refuses requests) unless dev bypass is active (`AUTH_DEV_BYPASS=true` and not hosted in Azure), which uses an ephemeral per-process dev key. Terraform generates it into Key Vault (`image-proxy-signing-key`).

Optional / dev-only:
- `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT` — Azure AI Document Intelligence endpoint for server-side OCR (graceful degradation when missing)
- `AZURE_DOCUMENT_INTELLIGENCE_KEY` — Azure AI Document Intelligence subscription key
- `AUTH_DEV_BYPASS` — enables `Bearer dev:<userId>` tokens for local dev only. Fails closed when hosted in Azure (`WEBSITE_INSTANCE_ID` or a non-loopback `WEBSITE_HOSTNAME`, see `src/lib/runtime-env.ts`); the deploy workflow always sets it to `false`
- `IMAGE_PROXY_ID_TTL_SECONDS` — minimum lifetime of newly minted signed image ids (default `259200` = 3 days, clamped 1h–30d; keep above the AI batch completion window)
- `IMAGE_PROXY_LEGACY_ID_ACCEPT_UNTIL` — optional ISO-8601 cutoff for accepting legacy non-expiring v1 image ids during rollout (unset = rejected)
- `AZURE_OPENAI_DEPLOYMENT_LABEL` — Azure OpenAI deployment name for label OCR structured extraction (falls back to `AZURE_OPENAI_DEPLOYMENT_HEX`, then `AZURE_OPENAI_DEPLOYMENT`)
- `AZURE_OPENAI_DEPLOYMENT` — fallback deployment name when `AZURE_OPENAI_DEPLOYMENT_HEX` is unset
- `AZURE_OPENAI_DEPLOYMENT_HEX_BATCH` — optional Azure OpenAI deployment name dedicated to batch hex detection (falls back to `AZURE_OPENAI_DEPLOYMENT_HEX`, then `AZURE_OPENAI_DEPLOYMENT`)
- `AZURE_OPENAI_BATCH_API_VERSION` — Azure OpenAI API version used for files/batches operations (default: `2025-03-01-preview`)
- `AZURE_OPENAI_BATCH_COMPLETION_WINDOW` — Batch completion window passed to Azure OpenAI (default: `24h`)
- `AZURE_OPENAI_VISION_DETAIL` — image detail level for vision hex detection, sync and batch: `low` (default, flat ~85 tokens/image), `high`, or `auto`; raise if finish detection needs more resolution
- `HEX_DETECTION_BATCH_ENABLED` — enables batch mode for Shopify vision hex detection and the `ingestion-ai-batch-poller` timer workflow
- `HEX_DETECTION_BATCH_MIN_IMAGES` — minimum record count required before ingestion switches to batch mode (default: `5`)
- `HEX_DETECTION_DELAY_MS` — pause after each synchronous (non-batch) hex detection call, per concurrency slot (default: `1000`, max `60000`; `0` disables); 429s are still retried with `Retry-After`
- `HEX_DETECTION_CONCURRENCY` — synchronous hex detection calls in flight at once (default: `4`, max `32`); DB writes stay sequential. Throughput is capped by the Azure OpenAI deployment's tokens-per-minute quota, so raise this together with deployment capacity
- `INGESTION_AI_BATCH_POLL_SCHEDULE` — NCRONTAB schedule for the batch completion poller (default: `0 * * * * *`, every minute)
- `INGESTION_AI_BATCH_MAX_POLL_JOBS` — maximum awaiting jobs processed per poller run (default: `10`)
- `INGESTION_AI_IMAGE_PROXY_ORIGIN` — optional public origin used to build `/api/images/{id}` URLs for Azure OpenAI vision calls (defaults to `https://$WEBSITE_HOSTNAME`)
- `INGESTION_WORKER_TIME_BUDGET_MS` — wall-clock budget per ingestion worker invocation (default: `240000`, clamped to `30000`–`270000`); when spent, the worker saves `metrics.checkpoint`, sets stage `continuation_queued`, and enqueues a continuation message so long jobs survive the Consumption plan timeout
- `INGESTION_LOG_FLUSH_INTERVAL_MS` — interval for ingestion worker log/metrics flushes while jobs run (default: `10000`)
- `SHOPIFY_CONNECTOR_REQUEST_TIMEOUT_MS` — per-request timeout for Shopify `products.json` downloads (default: `45000`)
- `SHOPIFY_CONNECTOR_MAX_RETRIES` — retry count for transient Shopify request errors (default: `2`)
- `SHOPIFY_CONNECTOR_RETRY_BASE_DELAY_MS` — linear backoff base delay for Shopify retries in milliseconds (default: `1000`)
- `PG_POOL_MAX` — Postgres pool max client count (default: `10`)
- `PG_IDLE_TIMEOUT_MS` — Postgres pool idle timeout in milliseconds (default: `30000`)
- `PG_CONNECTION_TIMEOUT_MS` — Postgres connection acquisition timeout in milliseconds (default: `15000`)
- `PG_QUERY_MAX_RETRIES` — retries for retry-safe DB queries (`SELECT` and `UPDATE ingestion_job`) when connection timeouts occur (default: `2`)
- `PG_QUERY_RETRY_BASE_MS` — linear backoff base delay for retry-safe DB query retries in milliseconds (default: `250`)
- `APPLICATIONINSIGHTS_CONNECTION_STRING` — custom telemetry sink for `trackEvent`/`trackMetric`/`trackException`
- `NEXT_PUBLIC_*` — web client vars included in example for convenience; not used by the Functions host itself

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
- `.github/copilot-instructions.md` — AI agent context (symlink to `CLAUDE.md`)
- `CONTRIBUTING.md` — git workflow, code standards, PR process
- `docs/implementation-guide.md` — knowledge graph data model, matching, AI pipeline, Azure architecture, MVP plan
- `docs/schema.sql` — canonical Postgres DDL (pg_trgm, pgvector, all tables + indexes)
- `docs/seed_data_sources.sql` — idempotent seed data for external sources (OpenBeautyFacts, CosIng, etc.)
- `docs/mvp-backlog.md` — epics, capabilities, stories, and milestone timeline
- `docs/azure-iac-bom.md` — per-environment Azure resource bill of materials
- `apps/web/README.md` — web app routes, components, conventions
- `packages/functions/README.md` — API routes, handler patterns
- `packages/functions/local.settings.json.example` — canonical template for all Functions env vars (copy → `local.settings.json`, gitignored)
- `packages/shared/README.md` — shared type catalog
- `infrastructure/README.md` — Terraform resources and variables

> **For AI agents:** `CLAUDE.md` is the canonical agent instruction source. `.github/copilot-instructions.md`, `.cursorrules`, `.windsurfrules`, and `AGENTS.md` are all symlinks to it.

## Git Workflow

**GitHub Flow** with **Conventional Commits**. See `CONTRIBUTING.md` for full details.

- **Branches:** `<type>/<issue#>-<description>` off `main` (e.g., `feat/12-catalog-search`, `fix/34-color-wheel-safari`)
- **Commits:** `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:` prefixes
- **PRs:** Squash merge into `main`. PR title = conventional commit message. Reference issues with `Closes #N`.
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
