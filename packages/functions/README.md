# Azure Functions — `packages/functions`

Azure Functions v4 HTTP API (Node 20, TypeScript).

## Running Locally

```bash
# From repo root
npm run dev:functions    # Builds TypeScript then starts func host (dev CORS enabled) on http://localhost:7071

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
| `POST` | `/api/capture/start` | `startCapture` | `capture.ts` | ✅ Live |
| `POST` | `/api/capture/{captureId}/frame` | `addCaptureFrame` | `capture.ts` | ✅ Live |
| `POST` | `/api/capture/{captureId}/finalize` | `finalizeCapture` | `capture.ts` | ✅ Live |
| `GET` | `/api/capture/{captureId}/status` | `getCaptureStatus` | `capture.ts` | ✅ Live |
| `POST` | `/api/capture/{captureId}/answer` | `answerCaptureQuestion` | `capture.ts` | ✅ Live |
| `POST` | `/api/auth/validate` | `validateToken` | `auth.ts` | ✅ Live (dev bypass + B2C) |
| `GET` | `/api/auth/config` | `getAuthConfig` | `auth.ts` | ✅ Working |
| `GET` | `/api/catalog/search?q=` | `searchCatalog` | `catalog.ts` | ✅ Live |
| `GET` | `/api/catalog/shade/{id}` | `getShade` | `catalog.ts` | ✅ Live |
| `POST` | `/api/voice` | `processVoiceInput` | `voice.ts` | ⬜ Stub |


All handlers return `Promise<HttpResponseInit>` and accept `(request: HttpRequest, context: InvocationContext)`.

### Capture Endpoint Behavior (Current)

- `POST /api/capture/{captureId}/finalize` now runs a deterministic resolver (`gtin` barcode lookup first, then shade similarity).
- On `matched`, the function also creates or increments a `user_inventory_item` for the authenticated user.
- On medium/low confidence, it returns `needs_question` with a persisted capture question.
- `POST /api/capture/{captureId}/frame` accepts either:
  - `imageBlobUrl` as `https://...` URL, or
  - base64 `data:image/...;base64,...` payloads from web/mobile camera uploads.
- Frame ingest normalizes/stores metadata (`ingestion.source`, MIME type, byte size, checksum), writes structured evidence under `quality_json.extracted`, and rejects browser-local `blob:` URLs.
- Each frame ingest updates `capture_session.metadata.pipeline.ingest` with durable progress details (`framesReceived`, `frameTypeCounts`, `lastFrameType`, extraction source).
- Finalize now writes durable run metadata to `capture_session.metadata.pipeline.finalize` (`attempt`, `runId`, timestamps, outcome) and resolver audit evidence under `metadata.resolver.audit`.

### Authentication

Polish CRUD and capture session endpoints require a `Bearer` token in the `Authorization` header. The auth middleware (`src/lib/auth.ts`) supports two modes:

- **Dev bypass** (`AUTH_DEV_BYPASS=true` in `local.settings.json`): accepts `Bearer dev:<userId>` tokens (e.g., `Bearer dev:1`) — maps directly to `app_user.user_id`. No cryptographic validation.
- **Production** (B2C configured): validates JWTs against Azure AD B2C JWKS, extracts the `oid` claim, and upserts the user by `external_id`.

To protect a handler, wrap it with `withAuth`:

```ts
import { withAuth } from "../lib/auth";

async function myHandler(request: HttpRequest, context: InvocationContext, userId: number) {
  // userId is the authenticated user's local DB ID
}

app.http("my-route", { ..., handler: withAuth(myHandler) });
```

Catalog endpoints (`/api/catalog/*`) remain public — no auth required.

## Migrations

Schema migrations use [node-pg-migrate](https://github.com/salsita/node-pg-migrate) with raw SQL files in `migrations/`. Each file contains an up migration and a `-- Down Migration` section for rollback.

```bash
# From repo root (requires DATABASE_URL or PG* env vars)
npm run migrate          # Apply pending migrations (prod-safe)
npm run migrate:dev      # Apply pending migrations + seed dev data (demo user, mock polishes)
npm run migrate:down     # Roll back last migration
npm run migrate:down:dev # Roll back last migration (with dev seed awareness)

# From packages/functions
npm run migrate:create -- my-migration-name   # Create a new migration file
```

`migrate:dev` sets `PGOPTIONS='-c app.seed_dev_data=true'` so migration 003 inserts the demo user and sample inventory. Without it (i.e. `migrate` in prod), 003 is a safe no-op.

**Migration files:**
| File | Description |
|------|-------------|
| `001_initial_schema.sql` | Full schema: catalog, swatches, matching, users, inventory, capture, retail, provenance |
| `002_add_user_facing_columns.sql` | Adds color_name, color_hex, rating, tags, size_display, updated_at to user_inventory_item |
| `003_seed_dev_data.sql` | Dev-only: demo user, sample shades, 20 inventory items (gated by `app.seed_dev_data` session var) |
| `004_add_expiration_date.sql` | Adds expiration_date column to user_inventory_item |
| `005_seed_production_reference_data.sql` | Prod reference data: finish_type table, data sources, 49 brands, brand aliases, claims, retailers, affiliate programs, disclosure config, INCI ingredients, product lines |
| `006_add_user_external_id.sql` | Adds `external_id` (B2C oid) and `email` to `app_user`; sets demo user external_id |

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
- Capture finalize currently uses deterministic resolver heuristics (barcode lookup + shade similarity). Durable OCR/LLM matching pipeline is not wired yet.


## Environment Variables

Defined in `local.settings.json` (git-ignored values). See the root README for the full list. For production, secrets are injected via Key Vault references.

## Build

```bash
npm run build --workspace=packages/functions   # tsc → dist/
npm run watch --workspace=packages/functions   # tsc -w (used by debug task)
```

Output goes to `dist/`. The `host.json` and `local.settings.json` stay at package root.
