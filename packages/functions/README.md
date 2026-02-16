# Azure Functions — `packages/functions`

Azure Functions v4 HTTP API (Node 20, TypeScript).

## Running Locally

```bash
# From repo root
npm run setup            # Install workspace dependencies first
npm run dev:infra        # Start local Postgres + Azurite
npm run dev:functions    # TypeScript watch + func host on http://localhost:7071

# Or for debugging (VS Code):
# Press F5 → "Attach to Node Functions" (builds, watches, starts with --inspect on port 9229)
```

Requires **Azure Functions Core Tools v4** (`npm i -g azure-functions-core-tools@4`).

## API Routes

| Method | Route | Handler | File | Status |
|--------|-------|---------|------|--------|
| `GET` | `/api/polishes/{id?}` | `getPolishes` | `polishes.ts` | ✅ Live |
| `POST` | `/api/polishes` | `createPolish` | `polishes.ts` | ✅ Live |
| `PUT` | `/api/polishes/{id}` | `updatePolish` | `polishes.ts` | ✅ Live |
| `DELETE` | `/api/polishes/{id}` | `deletePolish` | `polishes.ts` | ✅ Live |
| `POST` | `/api/auth/validate` | `validateToken` | `auth.ts` | ✅ Working |
| `GET` | `/api/auth/config` | `getAuthConfig` | `auth.ts` | ✅ Working |
| `GET` | `/api/ingestion/jobs` | `ingestionJobsHandler` | `ingestion.ts` | ✅ Working |
| `POST` | `/api/ingestion/jobs` | `enqueueIngestionJob` | `ingestion.ts` | ✅ Working |
| `GET` | `/api/ingestion/jobs/{id}` | `handleGetIngestionJob` | `ingestion.ts` | ✅ Working |
| `POST` | `/api/voice` | `processVoiceInput` | `voice.ts` | ⬜ Stub |
| `GET` | `/api/images/{id}` | `images` | `images.ts` | ✅ Working |


All handlers return `Promise<HttpResponseInit>` and accept `(request: HttpRequest, context: InvocationContext)`.

`GET /api/polishes` and `GET /api/polishes/{id}` return `swatchImageUrl` ready for browser rendering.
For private blob storage, the API rewrites blob URLs to `/api/images/{id}` so image bytes are served through Functions (no public container access or client-side SAS required).

### Connector Ingestion Jobs

`POST /api/ingestion/jobs` now **queues** an async ingestion run and returns `202 Accepted` with a queued job record.
Execution happens in a queue-triggered worker (`ingestion-worker.ts`) backed by Azure Storage Queue.

Current source support:
- `OpenBeautyFacts` (search-based pull)
- `MakeupAPI` (nail-polish catalog pull)
- `HoloTacoShopify` (current Shopify storefront pull, bundle-filtered)
- Additional `*Shopify` sources from the generated connector list are auto-provisioned into `data_source` when missing, so they appear in `/api/ingestion/sources` and can be queued without manual SQL seeding.

Auth requirement:
- Ingestion endpoints are admin-only (`withAdmin`). In dev bypass mode, use an admin dev user token (for example `Bearer dev:2` with seeded admin user id 2).

For `MakeupAPI`, ingestion also materializes product color variants into searchable `shade`
rows and user inventory rows (`quantity=0`) by default. Set `materializeToInventory` to
`false` to store only raw/normalized external records.

For `HoloTacoShopify`, ingestion materializes searchable shade rows (brand/name/finish/collection)
and user inventory rows (`quantity=0`) with source tags. Use `recentDays` to constrain to newer
products by publish/create/update timestamps. It also uploads source product images to Azure Blob
Storage (`image_asset` + `swatch`) and attempts Azure OpenAI-based representative `color_hex`
detection from the product image.

Holo Taco run options:
- `detectHexFromImage` (default `true`) toggles image-based AI hex detection.
- `overwriteDetectedHex` (default `false`) refreshes existing `color_hex` values on reruns instead of only filling blanks.

Example request:
```json
{
  "source": "HoloTacoShopify",
  "searchTerm": "recent",
  "page": 1,
  "pageSize": 50,
  "maxRecords": 50,
  "recentDays": 120,
  "materializeToInventory": true,
  "detectHexFromImage": true,
  "overwriteDetectedHex": true
}
```

Use `GET /api/ingestion/jobs` and `GET /api/ingestion/jobs/{id}` to inspect queued/running/completed status and metrics.
If a queue message is malformed but includes a valid `jobId`, the worker marks that ingestion job as `failed` with validation details in `error` and `metrics.pipeline`.

## Migrations

Schema migrations use [node-pg-migrate](https://github.com/salsita/node-pg-migrate) with raw SQL files in `migrations/`. Each file contains an up migration and a `-- Down Migration` section for rollback.

```bash
# From repo root (requires DATABASE_URL or PG* env vars)
npm run migrate          # Apply pending migrations
npm run migrate:down     # Roll back last migration

# From packages/functions
npm run migrate:create -- my-migration-name   # Create a new migration file
```

**Migration files:**
| File | Description |
|------|-------------|
| `001_initial_schema.sql` | Full schema: catalog, swatches, matching, users, inventory, capture, retail, provenance |
| `002_add_user_facing_columns.sql` | Adds color_name, color_hex, rating, tags, size_display, updated_at to user_inventory_item |
| `003_seed_dev_data.sql` | Inserts brands, shades, demo user, and 20 inventory items |
| `007_add_makeup_api_data_source.sql` | Registers `MakeupAPI` in `data_source` for connector ingestion |
| `008_add_holo_taco_shopify_data_source.sql` | Registers `HoloTacoShopify` in `data_source` for connector ingestion |
| `009_add_admin_role_and_ingestion_queue_support.sql` | Adds `app_user.role`, seeds dev admin user (`user_id=2`), supports admin-gated async ingestion flow |

node-pg-migrate tracks applied migrations in a `pgmigrations` table. `DATABASE_URL` is the preferred connection method; it also falls back to individual `PG*` env vars (`PGHOST`, `PGPORT`, etc.).

## Adding a New Function

1. Create `src/functions/my-feature.ts`
2. Define handler(s):
   ```ts
   import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";

   async function myHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
     // implementation
   }

   app.http("my-feature", {
     methods: ["GET"],
     authLevel: "anonymous",
     route: "my-feature/{id?}",
     handler: myHandler,
   });
   ```
3. Import types from `swatchwatch-shared` — **do not** redefine domain types locally


## Known Issues

- Voice handler stubs Speech-to-text and OpenAI parsing

## Troubleshooting

- If the Function App starts but no functions are listed, check startup logs for module resolution errors and confirm runtime dependencies (for example `jose` for auth JWT validation) are in `dependencies`, not only dev deps.
- AI hex detection diagnostics are logged under the `[ai-color-detection]` prefix, including retry attempts, delay timings, upstream status codes, and Azure request IDs (`x-request-id`/`apim-request-id`) for failed calls.
- For ingestion runs, those AI diagnostics are also mirrored into the job `metrics.logs` stream shown on `/admin/jobs`.


## Environment Variables

Defined in `local.settings.json` (git-ignored values). See the root README for the full list. For production, secrets are injected via Key Vault references.

Key variables:

| Variable | Purpose |
|----------|---------|
| `AUTH_DEV_BYPASS` | Dev-only bypass mode. When `true`, auth accepts `Bearer dev:<userId>` tokens. Keep this disabled outside isolated dev scenarios. |
| `INGESTION_JOB_QUEUE_NAME` | Optional queue name for async ingestion jobs. Defaults to `ingestion-jobs`. |
| `SOURCE_IMAGE_CONTAINER` | Optional blob container override for source-ingested images. Defaults to `source-images`. |
| `AZURE_OPENAI_DEPLOYMENT_HEX` | Optional Azure OpenAI deployment name dedicated to image hex detection (falls back to `AZURE_OPENAI_DEPLOYMENT` when unset). |

Temporary cloud note (as of February 11, 2026):
`deploy-dev.yml` currently sets `AUTH_DEV_BYPASS=true` on the dev Function App after deploy. Remove this once dev Azure AD B2C flow is fully wired.

## Build

```bash
npm run build --workspace=packages/functions   # tsc → dist/
npm run watch --workspace=packages/functions   # tsc -w (used by debug task)
```

Output goes to `dist/`. The `host.json` and `local.settings.json` stay at package root.
