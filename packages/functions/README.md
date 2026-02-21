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
| `POST` | `/api/polishes/{id}/recalc-hex` | `recalcHex` | `polishes.ts` | ✅ Live (admin-only) |
| `GET` | `/api/catalog/search` | `searchCatalog` | `catalog.ts` | ✅ Working |
| `GET` | `/api/catalog/shade/{id}` | `getShade` | `catalog.ts` | ✅ Working |
| `POST` | `/api/auth/validate` | `validateToken` | `auth.ts` | ✅ Working |
| `GET` | `/api/auth/config` | `getAuthConfig` | `auth.ts` | ✅ Working |
| `POST` | `/api/capture/start` | `startCapture` | `capture.ts` | ✅ Working |
| `POST` | `/api/capture/{captureId}/frame` | `addCaptureFrame` | `capture.ts` | ✅ Working |
| `POST` | `/api/capture/{captureId}/finalize` | `finalizeCapture` | `capture.ts` | ✅ Working |
| `GET` | `/api/capture/{captureId}/status` | `getCaptureStatus` | `capture.ts` | ✅ Working |
| `POST` | `/api/capture/{captureId}/answer` | `answerCaptureQuestion` | `capture.ts` | ✅ Working |
| `GET` | `/api/ingestion/jobs` | `ingestionJobsHandler` | `ingestion.ts` | ✅ Working |
| `POST` | `/api/ingestion/jobs` | `enqueueIngestionJob` | `ingestion.ts` | ✅ Working |
| `GET` | `/api/ingestion/jobs/{id}` | `ingestionJobDetailHandler` | `ingestion.ts` | ✅ Working |
| `DELETE` | `/api/ingestion/jobs/{id}/cancel` | `ingestionJobCancelHandler` | `ingestion.ts` | ✅ Working |
| `GET` | `/api/ingestion/sources` | `dataSourcesHandler` | `ingestion.ts` | ✅ Working |
| `PATCH` | `/api/ingestion/sources/{id}/settings` | `sourceSettingsHandler` | `ingestion.ts` | ✅ Working |
| `GET` | `/api/ingestion/settings` | `globalSettingsHandler` | `ingestion.ts` | ✅ Working |
| `PATCH` | `/api/ingestion/settings` | `globalSettingsHandler` | `ingestion.ts` | ✅ Working |
| `GET` | `/api/ingestion/queue/stats` | `queueStatsHandler` | `ingestion.ts` | ✅ Working |
| `DELETE` | `/api/ingestion/queue/messages` | `queueMessagesHandler` | `ingestion.ts` | ✅ Working |
| `GET` | `/api/reference/finishes` | `getReferenceFinishes` | `reference.ts` | ✅ Working |
| `GET` | `/api/reference/harmonies` | `getReferenceHarmonies` | `reference.ts` | ✅ Working |
| `GET` | `/api/reference-admin/finishes` | `adminFinishesCollectionHandler` | `admin-reference.ts` | ✅ Working (admin-only) |
| `POST` | `/api/reference-admin/finishes` | `adminFinishesCollectionHandler` | `admin-reference.ts` | ✅ Working (admin-only) |
| `PUT` | `/api/reference-admin/finishes/{id}` | `adminFinishesItemHandler` | `admin-reference.ts` | ✅ Working (admin-only) |
| `DELETE` | `/api/reference-admin/finishes/{id}` | `adminFinishesItemHandler` | `admin-reference.ts` | ✅ Working (admin-only) |
| `GET` | `/api/reference-admin/harmonies` | `adminHarmoniesCollectionHandler` | `admin-reference.ts` | ✅ Working (admin-only) |
| `POST` | `/api/reference-admin/harmonies` | `adminHarmoniesCollectionHandler` | `admin-reference.ts` | ✅ Working (admin-only) |
| `PUT` | `/api/reference-admin/harmonies/{id}` | `adminHarmoniesItemHandler` | `admin-reference.ts` | ✅ Working (admin-only) |
| `DELETE` | `/api/reference-admin/harmonies/{id}` | `adminHarmoniesItemHandler` | `admin-reference.ts` | ✅ Working (admin-only) |
| `GET` | `/api/reference-admin/jobs` | `adminJobsHandler` | `admin-reference.ts` | ✅ Working (admin-only) |
| `POST` | `/api/voice` | `processVoiceInput` | `voice.ts` | ⬜ Stub |
| `GET` | `/api/images/{id}` | `images` | `images.ts` | ✅ Working |


All handlers return `Promise<HttpResponseInit>` and accept `(request: HttpRequest, context: InvocationContext)`.

`GET /api/polishes` now returns the entire canonical shade catalog joined with the requesting user's inventory rows. `inventoryItemId` and user-facing fields are undefined when the user has not added that shade yet, but catalog metadata (brand, finish, color hexes, swatch) is still returned so the UI can show "not owned" entries. `GET /api/polishes/{id}` looks up a shade by `shade_id` and includes `sourceImageUrls` (all source images associated with that shade's swatches) for the detail page.
For private blob storage, the API rewrites blob URLs to `/api/images/{id}` so image bytes are served through Functions (no public container access or client-side SAS required).
`POST /api/polishes/{id}/recalc-hex` is admin-only, fetches the latest swatch image for the shade, runs Azure OpenAI hex detection, updates `detected_hex`, and returns a 200 with the detected hex and confidence (or a 422 if no image is available for detection). Vendor context is derived from shade metadata (for example `finish`) so the endpoint does not depend on source-specific external IDs.

Reference endpoints:
- `GET /api/reference/finishes` and `GET /api/reference/harmonies` are public read endpoints for UI lookup data, sorted by `sort_order` and served with cache headers.
- Admin CRUD endpoints under `/api/reference-admin/finishes` and `/api/reference-admin/harmonies` manage reference data and update audit columns (`updated_at`, `updated_by_user_id`) on writes.
- `GET /api/reference-admin/jobs` lists recent ingestion jobs with pagination (`page`, `pageSize`) and optional `status` filter (`queued|running|succeeded|failed|cancelled`), joined with `data_source` for source metadata.

### Connector Ingestion Jobs

`POST /api/ingestion/jobs` now **queues** an async ingestion run and returns `202 Accepted` with a queued job record.
Execution happens in a queue-triggered worker (`ingestion-worker.ts`) backed by Azure Storage Queue.

Current source support:
- `OpenBeautyFacts` (search-based pull)
- `MakeupAPI` (nail-polish catalog pull)
- `HoloTacoShopify` (current Shopify storefront pull, bundle-filtered)
- Additional `*Shopify` sources from the generated connector list are auto-provisioned into `data_source` when missing, so they appear in `/api/ingestion/sources` and can be queued without manual SQL seeding.

Auth requirement:
- Ingestion endpoints are admin-only (`withAdmin`).
- In production auth mode, admin is determined from the Entra access-token `roles` claim (`admin`).
- In dev bypass mode, use an admin dev user token (for example `Bearer dev:2` with seeded admin user id 2).

For `MakeupAPI`, ingestion also materializes product color variants into searchable `shade`
rows and user inventory rows (`quantity=0`) by default. Set `materializeToInventory` to
`false` to store only raw/normalized external records.

For `HoloTacoShopify`, ingestion materializes searchable shade rows (brand/name/finish/collection)
and user inventory rows (`quantity=0`) with source tags. Use `recentDays` to constrain to newer
products by publish/create/update timestamps. It also uploads source product images to Azure Blob
Storage (`image_asset` + `swatch`) and attempts Azure OpenAI-based representative `color_hex`
detection from the product image.
When `AZURE_STORAGE_CONNECTION` isn't configured (for example in a fresh local checkout), the connector
falls back to storing the original Shopify `image.src` URL so images still appear in the app while
you bring storage online.
Materialization now commits per record while the job is running, so newly imported polishes become
visible progressively instead of waiting for the final job commit.

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
| `013_shade_catalog_visibility.sql` | Adds timestamps to `shade`, enforces one `user_inventory_item` per user/shade to support catalog-wide visibility |
| `017_add_admin_support.sql` | Adds `finish_type` audit columns and creates/seeds `harmony_type` for admin-managed reference data |

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
- If Azure OpenAI returns `400 content_filter` for the primary vision prompt, the detector automatically retries once with a safer prompt. If still filtered, ingestion continues and leaves `detected_hex` empty for that record.
- AI image detection uses base64 image payloads only. If base64 preparation fails for a record, detection is skipped and a warning is logged to the Admin Jobs stream.
- On successful AI hex detection, ingestion logs a structured success entry with `brand`, `colorName`, and `hex` in job logs (Admin Jobs expandable log view).
- For ingestion runs, those AI diagnostics are also mirrored into the job `metrics.logs` stream shown on `/admin/jobs`.


## Environment Variables

Defined in `local.settings.json` (git-ignored values). See the root README for the full list. For production, secrets are injected via Key Vault references.

Key variables:

| Variable | Purpose |
|----------|---------|
| `AUTH_DEV_BYPASS` | Dev-only bypass mode. When `true`, auth accepts `Bearer dev:<userId>` tokens. Keep this disabled outside isolated dev scenarios. |
| `INGESTION_JOB_QUEUE_NAME` | Optional queue name for async ingestion jobs. Defaults to `ingestion-jobs`. |
| `SOURCE_IMAGE_CONTAINER` | Optional blob container override for source-ingested images. Defaults to `source-images`. |
| `AZURE_STORAGE_CONNECTION` | Connection string for uploading source images to Azure Blob Storage. When unset (for local dev or bring-up), ingestion falls back to storing the original source image URLs so swatch images still appear. |
| `AZURE_OPENAI_DEPLOYMENT_HEX` | Optional Azure OpenAI deployment name dedicated to image hex detection (falls back to `AZURE_OPENAI_DEPLOYMENT` when unset). |

JWT validation note:
- In production mode (`AUTH_DEV_BYPASS=false`), auth discovery first tries Entra External ID (`ciamlogin.com`) metadata for `AZURE_AD_B2C_TENANT`, then falls back to legacy Azure AD B2C (`b2clogin.com`) metadata.
- Accepted token audiences are `AZURE_AD_B2C_CLIENT_ID` and `api://AZURE_AD_B2C_CLIENT_ID` to support exposed-API scopes like `access_as_user`.
- User records are still upserted in `app_user`; `role` is synchronized from Entra token roles on each authenticated request.

Dev deploy note:
`deploy-dev.yml` configures Function App auth settings from GitHub `dev` environment values on each deploy.
- Variable: `AUTH_DEV_BYPASS`
- Secret: `AZURE_AD_B2C_CLIENT_ID`
- Tenant source: `AZURE_AD_B2C_TENANT` variable (falls back to `NEXT_PUBLIC_B2C_TENANT`)

## Build

```bash
npm run build --workspace=packages/functions   # tsc → dist/
npm run watch --workspace=packages/functions   # tsc -w (used by debug task)
```

Output goes to `dist/`. The `host.json` and `local.settings.json` stay at package root.
