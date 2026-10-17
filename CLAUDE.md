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

**Shade hexes:** each shade has `vendor_hex` (vendor product data), `detected_hex` (AI vision on the product image) and `name_hex` (from the color name). Every `detected_hex` write also records provenance (`detected_hex_confidence`, `detected_hex_method`, `detected_hex_model`, `detected_hex_prompt_version`, `detected_hex_at`; migration 20261017024958000_shade-detected-hex-provenance) via `packages/functions/src/lib/hex-provenance.ts`, and `shade.hex_agreement` is a generated column holding the OKLAB distance vendor ↔ detected. Bump `PROMPT_VERSION` in `ai-color-detection.ts` whenever the vision prompt changes. Display uses `resolveDisplayHex` (vendor > detected > name); `resolveDisplayHexDetailed` in `packages/shared` adds the source, agreement and a review flag (disagreement > 0.10 MEDIUM, or a caller-marked suspicious vendor hex). Admins review weak detections with `GET /api/polishes-admin/hex-review`.

**Telemetry:** Functions and web both report to the same workspace-based Application Insights (see `docs/observability-plan.md`). The web SDK is lazy-loaded after hydration, sends W3C `traceparent` only to the API host, tags telemetry with the internal user id (never email), and redacts `/api/images/{id}` capability ids; route-group `error.tsx` files and `app/global-error.tsx` report render errors.

**Buy from brand (#267):** polish list/detail and catalog search/shade responses carry an optional `buyUrl` — the brand product page from the connector-stored `external_product.normalized_json ->> 'productUrl'`, reached through `shade_source_product` (written by ingestion materialization; migration 20261017061344201_add-shade-source-product). `packages/functions/src/lib/buy-link.ts` validates (absolute http/https only, no credentials) and picks one product deterministically (enabled source, then latest `last_seen_at`, then latest `fetched_at`, then highest id). No affiliate parameters; `applyAffiliateParams()` is the one place to add them. The web renders it via `BuyFromBrandLink` with `rel="noopener noreferrer nofollow"`.

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
npm run eval:hex --workspace=swatchwatch-functions -- --strategy pixel            # Hex-detection ground-truth eval (strategies: azure-current, azure-blind, pixel, region-crop, palette-pick, image-select, image-select-ai, blind-snap, image-select-ai-snap, ensemble; `--list-strategies` for all; Azure ones skip without config; region-crop knobs: HEX_EVAL_REGION_CROP_MODE/CELLS/DETAIL)
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
- ✅ Image proxy — private blob storage served through `/api/images/{id}` (`images.ts`); ids are HMAC-signed, expiring capabilities. Public `v2` ids (anonymous, `Cache-Control: public`) read only the source-image container; owner-scoped `v3` ids for private media (#227) read only `USER_MEDIA_CONTAINER` and are served only to the owner's bearer token (401/403 otherwise, `Cache-Control: private` + `Vary: Authorization`)
- ✅ Per-user access control (#47) — all user-data routes use `withAuth` with `user_id`-scoped SQL; admin/ops routes use `withAdmin`; capture frames can only reference the caller's own `image_asset` rows; user-created shades are `user_submitted` (private until an admin sets `active`), shared shades are fill-only for users, and email account-linking requires a verified email
- ✅ Connector ingestion pipeline — async queue-backed jobs for OpenBeautyFacts, MakeupAPI, HoloTacoShopify, and generic Shopify sources
- ✅ AI hex detection — Azure OpenAI vision-based `detected_hex` from product images, with `recalc-hex` admin endpoint
- ✅ Detected-hex provenance + reconciliation — confidence/method/deployment/prompt version/timestamp on every `detected_hex` write, generated `hex_agreement` (migration 20261017024958000_shade-detected-hex-provenance), `resolveDisplayHexDetailed`, admin review queue `GET /api/polishes-admin/hex-review`
- ✅ Reference data management — `finish_type`, `harmony_type`, `finish_normalization` tables with admin CRUD and public read endpoints
- ✅ Hex-detection evaluation harness — `packages/functions/src/eval/hex/` scores detection strategies against ground-truth fixtures (OKLAB distance, HIGH/MEDIUM shares, per brand/finish); `color_training_sample` (migration `20261017033500000_add-color-training-sample.sql`) holds DB-sourced samples. See `packages/functions/README.md`
- ✅ Feature-flagged Azure OpenAI batch pipeline for Shopify vision hex detection — per-chunk batches run in parallel while the worker keeps ingesting (`metrics.aiBatches`), then awaiting_ai → poll/apply each batch → complete, with synchronous fallback for small runs

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
- `USER_MEDIA_CONTAINER` — blob container for private user media such as nail photos (default `nail-photos`, Terraform-provisioned); readable only through owner-scoped `v3` image ids (#227)
- `IMAGE_PROXY_PRIVATE_ID_TTL_SECONDS` — minimum lifetime of owner-scoped `v3` private-media image ids (default `3600`, clamped 300–86400, bucketed to 15 minutes; #227)
- `AZURE_OPENAI_DEPLOYMENT_LABEL` — Azure OpenAI deployment name for label OCR structured extraction (falls back to `AZURE_OPENAI_DEPLOYMENT_HEX`, then `AZURE_OPENAI_DEPLOYMENT`)
- `AZURE_OPENAI_DEPLOYMENT` — fallback deployment name when `AZURE_OPENAI_DEPLOYMENT_HEX` is unset
- `AZURE_OPENAI_DEPLOYMENT_HEX_BATCH` — optional Azure OpenAI deployment name dedicated to batch hex detection (falls back to `AZURE_OPENAI_DEPLOYMENT_HEX`, then `AZURE_OPENAI_DEPLOYMENT`)
- `HEX_SNAP_MAX_DISTANCE` — eval-only: largest OKLAB distance at which the hex-eval `blind-snap` / `image-select-ai-snap` strategies snap the model's hex to the nearest measured palette chip (default `0.10`, the MEDIUM threshold)
- `AZURE_OPENAI_DEPLOYMENT_HEX_ENSEMBLE` — optional comma-separated deployment names the hex-eval `ensemble` strategy samples from (falls back to `AZURE_OPENAI_DEPLOYMENT_HEX`, then `AZURE_OPENAI_DEPLOYMENT`); eval-only, not used by ingestion
- `HEX_DETECTION_ENSEMBLE_SAMPLES` — samples per deployment for the hex-eval `ensemble` strategy (default `3`, clamped 1–10); eval-only
- `HEX_DETECTION_ENSEMBLE_TEMPERATURE` — sampling temperature for the hex-eval `ensemble` strategy (default `0.3`, clamped 0–2); eval-only, production detection stays at temperature 0
- `HEX_EVAL_REGION_CROP_MODE` — eval-only: localization mode for the hex-eval `region-crop` strategy, `cells` (default, labeled grid) or `bbox` (normalized box)
- `HEX_EVAL_REGION_CROP_CELLS` — eval-only: grid size per axis for `region-crop` `cells` mode (default `6`, clamped 2–10)
- `HEX_EVAL_REGION_CROP_GRID` — eval-only: `true` draws a 4×4 grid on the image in `region-crop` `bbox` mode (default `false`)
- `HEX_EVAL_REGION_CROP_DETAIL` — eval-only: `low`/`high`/`auto` vision detail for the `region-crop` locator call (default: `AZURE_OPENAI_VISION_DETAIL`, then `low`)
- `AZURE_OPENAI_BATCH_API_VERSION` — Azure OpenAI API version used for files/batches operations (default: `2025-03-01-preview`)
- `AZURE_OPENAI_BATCH_COMPLETION_WINDOW` — Batch completion window passed to Azure OpenAI (default: `24h`)
- `AZURE_OPENAI_VISION_DETAIL` — image detail level for vision hex detection, sync and batch: `low` (default, flat ~85 tokens/image), `high`, or `auto`; raise if finish detection needs more resolution
- `HEX_DETECTION_BATCH_ENABLED` — enables batch mode for Shopify vision hex detection and the `ingestion-ai-batch-poller` timer workflow
- `HEX_DETECTION_BATCH_MIN_IMAGES` — minimum record count required before ingestion switches to batch mode (default: `5`)
- `HEX_DETECTION_BATCH_MAX_IN_FLIGHT` — max hex batches one ingestion job keeps pending (default: `20`, clamped 1–100); the worker submits a batch per chunk and keeps ingesting, pausing for `awaiting_ai` only at this cap
- `HEX_DETECTION_DELAY_MS` — pause after each synchronous (non-batch) hex detection call, per concurrency slot (default: `1000`, max `60000`; `0` disables); 429s are still retried with `Retry-After`
- `HEX_DETECTION_CONCURRENCY` — synchronous hex detection calls in flight at once (default: `4`, max `32`); DB writes stay sequential. Throughput is capped by the Azure OpenAI deployment's tokens-per-minute quota, so raise this together with deployment capacity
- `SUSPICIOUS_HEX_REPEAT_MIN_RECORDS` — a vendor hex shared by at least this many records in one data source's batch is treated as a store template default and sent to AI detection when `detectHexOnSuspiciousOnly` is on (default: `3`; see `src/lib/suspicious-hex.ts`)
- `SUSPICIOUS_HEX_REPEAT_MIN_SHARE` — ...and by at least this share (0–1) of the records that carry a vendor hex (default: `0.1`); both repeat thresholds must be met
- `SUSPICIOUS_HEX_GRAYSCALE_MAX_CHROMA` — OKLAB chroma below which a vendor hex counts as near-grayscale and is flagged unless the shade name or tags suggest a gray/silver/black/white/nude/chrome polish (default: `0.02`; pure grays are `0`, a nude ≈ `0.08`)
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
- `APPLICATIONINSIGHTS_CONNECTION_STRING` — custom telemetry sink for `trackEvent`/`trackMetric`/`trackException`; `src/index.ts` imports `lib/telemetry` first so dependencies are auto-instrumented and correlated with the host request (keep it first)
- `CORS_ALLOWED_HEADERS` — overrides the Functions CORS wrapper's allowed headers (default `Content-Type, Authorization, traceparent, tracestate, Request-Id, Request-Context`, so browser telemetry can correlate with API requests)
- `CORS_ALLOWED_ORIGINS` — comma-separated origins allowed by the Functions CORS wrapper (`src/lib/http.ts`; default `http://localhost:3000,https://*.azurestaticapps.net`); Terraform sets it to the web app origins
- `CONNECTOR_RAW_CONTAINER` — blob container for raw connector snapshots and the ingestion catalog cache (Terraform-provisioned; the legacy name `RAW_SNAPSHOT_CONTAINER` is still read but deprecated)
- `NEXT_PUBLIC_*` — web client vars included in example for convenience; not used by the Functions host itself

Web (build-time `NEXT_PUBLIC_*`, inlined into the static export; set in `.github/workflows/deploy.yml`, not SWA app settings):
- `NEXT_PUBLIC_APPLICATIONINSIGHTS_CONNECTION_STRING` — enables browser telemetry (`apps/web/src/lib/telemetry.ts`: page views, exceptions, fetch dependencies correlated with Functions requests via W3C `traceparent`). Unset = telemetry off (local dev default). The deploy workflow reads it from the Terraform output `application_insights_connection_string`; a missing output leaves telemetry off without failing the deploy
- `NEXT_PUBLIC_APPINSIGHTS_SAMPLING` — browser telemetry sampling percentage, `(0, 100]` (default `100`); deploy reads the `NEXT_PUBLIC_APPINSIGHTS_SAMPLING` GitHub environment variable

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
