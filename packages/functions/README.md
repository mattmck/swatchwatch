# Azure Functions — `packages/functions`

Azure Functions v4 HTTP API (Node 22, TypeScript).

## Running Locally

```bash
# From repo root
npm run setup            # Install workspace dependencies first
npm run dev:infra        # Start local Postgres + Azurite
npm run dev:functions    # TypeScript watch + func host on http://localhost:7071
npm run test --workspace=packages/functions  # Run Functions unit tests
npm run test:e2e --workspace=packages/functions  # E2E tests against the running local host

# Or for debugging (VS Code):
# Press F5 → "Attach to Node Functions" (builds, watches, starts with --inspect on port 9229)
```

### Tests

- **Unit** (`npm run test`): `tests/*.unit.test.cjs`, no DB or host required; runs in CI.
  `tests/access-control.unit.test.cjs` covers cross-user isolation (issue #53): every inventory /
  capture-session query must be bound to the caller's `user_id`, cross-user GET/PUT/DELETE and
  capture status/frame/finalize/answer must not read or mutate the owner's rows, user-scoped routes
  return 401 without credentials, admin routes return 403 for regular users, `userId`/`user_id` in
  request bodies or query params is ignored in favor of the authenticated caller, and `/api/images/{id}`
  rejects unsigned/forged/tampered ids (the `images signed-id (requires #47)` block). A nested
  `known gap #227` block pins that a valid signed image id is currently served to any caller (ids are
  not owner-scoped or expiring) — flip it when #227 lands.
- **E2E** (`npm run test:e2e`): `tests/api.test.cjs` + `tests/access-control.e2e.test.cjs` against
  a live host at `http://localhost:7071/api` started with `AUTH_DEV_BYPASS=true` and migrated dev
  data (seed users `dev:1` and `dev:2`). The access-control suite has user 2 attempt to read/modify
  user 1's polish and capture session (including spoofed `userId` bodies/query params and searching by
  user 1's private notes/tags), verifies user 1's data is unchanged, and checks tampered image ids. It
  skips itself when the host is unreachable. Override with `E2E_API_BASE` (honored by both files),
  `E2E_OWNER_TOKEN`, `E2E_ATTACKER_TOKEN`, and `E2E_OWNER_ID` (the owner's `app_user` id; needed for the
  `userId`-spoofing cases when the owner token isn't `dev:<id>`, otherwise those cases skip). Note that `GET /polishes/{id}` and the default list are
  catalog views joined to the caller's own inventory, so cross-user isolation means "no other user's
  inventory fields", not a 404; `scope=collection` restricts the list to owned items.

- **Hex-detection eval** (`npm run eval:hex -- --strategy <name>`): not a test — a ground-truth
  harness that scores detection strategies against a fixture (see
  [Hex detection evaluation harness](#hex-detection-evaluation-harness)). The pixel baseline runs
  offline; Azure strategies are skipped when Azure OpenAI is not configured.

Requires **Azure Functions Core Tools v4** (`npm i -g azure-functions-core-tools@4`).

## API Routes

| Method | Route | Handler | File | Status |
|--------|-------|---------|------|--------|
| `GET` | `/api/polishes/{id?}` | `getPolishes` | `polishes.ts` | ✅ Live |
| `POST` | `/api/polishes` | `createPolish` | `polishes.ts` | ✅ Live |
| `PUT` | `/api/polishes/{id}` | `updatePolish` | `polishes.ts` | ✅ Live |
| `DELETE` | `/api/polishes/{id}` | `deletePolish` | `polishes.ts` | ✅ Live |
| `POST` | `/api/polishes/{id}/recalc-hex` | `recalcHex` | `polishes.ts` | ✅ Live (admin-only) |
| `POST` | `/api/polishes/match-image` | `matchImage` | `polishes.ts` | ✅ Live |
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
| `POST` | `/api/ingestion/bulk` | `bulkIngestionHandler` | `ingestion.ts` | ✅ Working (admin-only) |
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
| `GET` | `/api/reference-admin/finish-normalizations` | `adminFinishNormalizationsCollectionHandler` | `admin-reference.ts` | ✅ Working (admin-only) |
| `POST` | `/api/reference-admin/finish-normalizations` | `adminFinishNormalizationsCollectionHandler` | `admin-reference.ts` | ✅ Working (admin-only) |
| `PUT` | `/api/reference-admin/finish-normalizations/{id}` | `adminFinishNormalizationsItemHandler` | `admin-reference.ts` | ✅ Working (admin-only) |
| `DELETE` | `/api/reference-admin/finish-normalizations/{id}` | `adminFinishNormalizationsItemHandler` | `admin-reference.ts` | ✅ Working (admin-only) |
| `GET` | `/api/users-admin` | `listUsers` | `admin-users.ts` | ✅ Working (admin-only) |
| `POST` | `/api/users-admin/merge` | `mergeUsers` | `admin-users.ts` | ✅ Working (admin-only) |
| `POST` | `/api/voice` | `processVoiceInput` | `voice.ts` | ⬜ Stub (auth required) |
| `GET` | `/api/images/{id}` | `images` | `images.ts` | ✅ Working (signed ids only) |


Background triggers:
- `ingestion-job-worker` (`ingestion-worker.ts`) — Azure Storage Queue trigger for async ingestion jobs.
- `ingestion-ai-batch-poller` (`ingestion-ai-batch-poller.ts`) — Timer trigger that polls Azure OpenAI batch status and applies completed detections.


All handlers return `Promise<HttpResponseInit>` and accept `(request: HttpRequest, context: InvocationContext)`.

`GET /api/polishes` returns a paginated canonical shade catalog joined with the requesting user's inventory rows. `inventoryItemId` and user-facing fields are undefined when the user has not added that shade yet, but catalog metadata (brand, finish, color hexes, swatch) is still returned so the UI can show "not owned" entries. `swatchImageUrl` is the shade's primary image: its `source_product` swatch when one exists, otherwise its newest swatch. Supported query params include `search`, `brand`, `finish`, `scope` (`all|collection`), `availability` (`all|owned|wishlist`), `tags`, `sortBy` (`status|brand|name|finish|collection|createdAt|rating`), `sortOrder`, `page`, and `pageSize`. `GET /api/polishes/{id}` looks up a shade by `shade_id` and includes `sourceImageUrls` (all source images associated with that shade's swatches, primary `source_product` image first, then newest first) for the detail page. The list's `total` comes from a `COUNT(*) OVER()` window column on the page query itself (one scan per page, no separate count query); a page past the end falls back to an explicit count. The swatch LATERAL lookup in `POLISH_SELECT` is served by `idx_swatch_shade_latest` (migration `20261016040000000_add-swatch-shade-index`).
**Multi-finish contract (#43):** polish list/detail responses include `finishes: string[]` (all canonical finishes for the shade, primary first) alongside the legacy `finish` string. `finish` stays populated for older consumers: it is the shade's stored `finish` column (its identity/dedup key) and falls back to `finishes[0]` when that column is empty. Filters: `finish=<value>` matches shades that have the finish anywhere in `finishes` *or* as the legacy `finish`; `finishes=a,b` matches shades with ANY of the listed finishes; both accept aliases (`holo`, `cream`, …). `sortBy=finish` sorts by the primary finish. `POST /api/polishes` and `PUT /api/polishes/{id}` accept `finishes` (explicit list → replaces the shade's finishes; `[]` clears) in addition to `finish` (legacy → merged). Request `tags` are the caller's personal inventory tags and are **not** used to change finishes: shades are shared catalog rows, so only an explicit `finishes`/`finish` can modify `shade.finishes` (a tags-only request leaves them untouched; only ingestion connectors parse finishes from product tags). Unknown values are ignored; a value is accepted when it is (or aliases to) a `finish_type` row, including types added through the admin UI. When only `finishes` is sent, the legacy `finish`/identity key defaults to `finishes[0]`.
When `REDIS_URL` + `REDIS_KEY` are configured, list/detail reads are served through a Redis read-through cache (short TTL), and create/update/delete/recalc writes invalidate related user and catalog cache keys.
For private blob storage, the API rewrites blob URLs to `/api/images/{id}` so image bytes are served through Functions (no public container access or client-side SAS required).

Access control (issue #47):
- Every user-data route (`/api/polishes*`, `/api/capture/*`, `/api/voice`) is wrapped in `withAuth`, and every query is scoped to the caller's `user_id` (inventory upserts/deletes key on `(user_id, shade_id)`; capture sessions are looked up by `capture_uuid` **and** `user_id`, and questions/answers/frames hang off that session). Admin/ops routes (`/api/ingestion/*`, `/api/reference-admin/*`, `/api/users-admin*`, `/api/polishes/{id}/recalc-hex`) use `withAdmin`. Only `/api/auth/*`, `/api/catalog/*`, `/api/reference/*`, and `/api/images/{id}` are anonymous, and none of them return per-user data.
- Shared catalog shades are never rewritten by regular users: color fields and `finishes` are **fill-only** (a user request may only fill NULL colors / an empty `shade.finishes`, never replace, clear or append to existing values), and `shade.finish` (the dedup key) is never changed. The one exception is a user's own `user_submitted` shade, whose finishes they may edit freely.
- Shades created through `POST/PUT /api/polishes` start as `status = 'user_submitted'` with `created_by_user_id` (migration 024) and are private until an admin promotes them (sets `status = 'active'`; no approval endpoint yet). A `user_submitted` shade is visible only to its creator and to users holding it in their inventory: it is excluded from other users' polish list/count/detail (`GET /api/polishes*`), `polishes/match-image`, `GET /api/catalog/shade/{id}` (404) and catalog search/capture matching (`status = 'active'` only). Adopting such a shade by id (`POST shadeId`, `PUT /polishes/{id}`, capture `candidate_select`) returns 404. A brand + name that only matches another user's private shade creates the caller's own row (idx_shade_unique includes the NULL `product_line_id`, so it does not block this). Ingestion promotes a matching `user_submitted` shade to `active`. New brand rows are still created immediately.
- Account linking: a new external identity links to an existing `app_user` by email only when the token proves the email is verified (`email_verified` true or Entra `xms_edov` true). Otherwise a separate user is created with no stored email and `auth.email_link_skipped` is tracked. Identities already linked (by `external_id`) are unaffected.
- Shades are a shared catalog. Color fields (`color`, `vendorHex`, `detectedHex`, `nameHex`) sent to `POST`/`PUT /api/polishes` only **backfill NULL** shade columns (`COALESCE(column, $new)`); a regular user can never overwrite catalog color data other users see. Corrections to existing values go through admin tooling (e.g. `recalc-hex`).
- `POST /api/capture/{captureId}/frame` with an `imageId` only accepts image assets owned by the caller (`image_asset.owner_type='user' AND owner_id=<caller>`); anything else returns `404`.
- `GET /api/images/{id}` is anonymous because ids are embedded in `<img src>` (no `Authorization` header). The id is therefore an expiring signed capability: `v2.<base64url(storageUrl)>.<exp base36>.<base64url(HMAC-SHA256(IMAGE_PROXY_SIGNING_KEY, "swatchwatch:image-proxy:v2:" + exp + ":" + storageUrl))>`, minted only by the API (`src/lib/image-proxy.ts`). The expiry is covered by the HMAC; ids stay valid for at least `IMAGE_PROXY_ID_TTL_SECONDS` (default 3 days, well past the 24h Azure OpenAI batch window) and are bucketed to day boundaries so the same image keeps a stable, cacheable URL. Unsigned, forged, tampered, or expired ids return `403 {"error":"Forbidden"}` without touching storage. Legacy non-expiring v1 ids are never minted and are rejected unless `IMAGE_PROXY_LEGACY_ID_ACCEPT_UNTIL` is set to a future timestamp (rollout grace window; each acceptance emits `image_proxy.legacy_id_accepted`). The decoded URL must also be a plain blob URL (no query string/credentials) on the configured storage account inside the source-image container (`SOURCE_IMAGE_CONTAINER`), otherwise `403`. Ids are deterministic per URL+key+expiry bucket, so rotating `IMAGE_PROXY_SIGNING_KEY` invalidates previously issued image URLs (clients pick up new ones on the next API read; Redis-cached polish responses expire within ~90s).
- If `IMAGE_PROXY_SIGNING_KEY` is missing, signing fails closed: polish responses omit proxied image URLs (`swatchImageUrl: null`) and `/api/images/{id}` returns `500` — unless dev bypass is active (`AUTH_DEV_BYPASS=true` and not hosted in Azure), in which case an ephemeral per-process key is generated (with a warning) for local development.
- Image proxy caching: only catalog blobs (the `SOURCE_IMAGE_CONTAINER` container) are served `Cache-Control: public`; any other media gets `private, max-age=<n>` with no `stale-while-revalidate`. `max-age` never exceeds the id's remaining lifetime.
- `AUTH_DEV_BYPASS` fails closed when hosted in Azure (`WEBSITE_INSTANCE_ID` set, or a non-loopback `WEBSITE_HOSTNAME`; Core Tools' `localhost:7071` still counts as local). In that case the flag is ignored, a one-time error is logged plus an `auth.dev_bypass_refused` event, and `dev:*` tokens go through JWT validation (401). There is no override.
- `POST /api/capture/{captureId}/frame` `imageBlobUrl` accepts only a base64 `data:image/*` URL or a plain `https://` blob URL on the configured storage account (`AZURE_STORAGE_CONNECTION`) inside `SOURCE_IMAGE_CONTAINER`, with no credentials, port, query string or fragment. `http:`, other hosts and SAS URLs are rejected with `400`, as are all remote URLs when no storage account is configured. The URL is validated even when `imageId` is also sent, so only validated input reaches Document Intelligence / Azure OpenAI.

Error responses: unexpected `500`s return only a generic message and a correlation id, `{ "error": "Failed to …", "requestId": "<invocationId>" }`. The full error (including Postgres messages) is logged server-side via `context.error` and `trackException` (`src/lib/errors.ts` → `internalServerError()`), never sent to the client.
`POST /api/polishes/{id}/recalc-hex` is admin-only, fetches the shade's primary swatch image (the `source_product` swatch, falling back to the newest swatch), runs Azure OpenAI hex detection, updates `detected_hex`, and returns a 200 with the detected hex and confidence (or a 422 if no image is available for detection). Responses now also include `tokenUsage` (`promptTokens`, `completionTokens`, `totalTokens`) when Azure returns usage metadata. Vendor context is derived from shade metadata (for example `finish`) so the endpoint does not depend on source-specific external IDs.

`POST /api/polishes/match-image` (authenticated) matches a photo against the **caller's owned polishes** (`quantity > 0`). Body (`PolishImageMatchRequest`): `{ image: "data:image/<type>;base64,…", maxColors?: 1–10 (default 6), limit?: 1–50 (default 20) }` — the same base64 data-URL convention as capture frames and the same upload policy (5 MB decoded, JPEG/PNG/WebP/GIF/HEIC/HEIF MIME allowlist). Bodies larger than the base64-encoded 5 MB limit are rejected with 413; missing/invalid images, non-image MIME types, undecodable bytes, images over 40 MP, and out-of-range options return 400. The handler decodes the image in memory with `sharp`, extracts dominant colors (`lib/dominant-color.ts`), merges perceptually near-duplicate colors (OKLAB < 0.04) and drops colors under 1% of pixels, then scores each owned polish's display hex (`vendorHex > detectedHex > nameHex`) by its minimum OKLAB distance to any extracted color. Response (`PolishImageMatchResponse`): `{ extractedColors: [{ hex, fraction }], matches: [{ polish, matchedColor, distance, confidence }], candidateCount }`, sorted by ascending distance. `confidence` comes from `confidenceForDistance()` in `src/lib/color-match.ts` (`high` ≤ 0.05, `medium` ≤ 0.10, else `low`; tune via `HIGH_CONFIDENCE_MAX_DISTANCE` / `MEDIUM_CONFIDENCE_MAX_DISTANCE`). **Privacy:** the image is never persisted — not to blob storage, the database, Redis, or logs — and responses are not cached.
Image uploads now enforce a shared validation policy (`maxSizeBytes=5MB`; allowed mime types: `image/jpeg`, `image/png`, `image/webp`, `image/heic`, `image/heif`, `image/gif`) used by capture-frame data URLs and source-image ingestion; uploads outside these limits are rejected with a 400. All uploaded image bytes are auto-oriented and metadata-stripped with `sharp` (removing EXIF/GPS and other embedded metadata) before any checksum generation, persistence, or forwarding to AI/OCR services. This applies to both source-image ingestion (before blob upload) and capture-frame data URLs (`quality_json.ingestion.exifStripped` records whether stripping ran). `sharp` failures degrade gracefully to the original bytes.

Reference endpoints:
- `GET /api/reference/finishes` and `GET /api/reference/harmonies` are public read endpoints for UI lookup data, sorted by `sort_order` and served with cache headers.
- Admin CRUD endpoints under `/api/reference-admin/finishes` and `/api/reference-admin/harmonies` manage reference data and update audit columns (`updated_at`, `updated_by_user_id`) on writes.
- Admin CRUD endpoints under `/api/reference-admin/finish-normalizations` manage aliases and misspellings used to normalize AI/vendor finish strings into canonical `finish_type.name` values.
- `GET /api/catalog/search` results and `GET /api/catalog/shade/{id}` include `finishes: string[]` next to the legacy `finish`.

### Finish canonicalization (`src/lib/finishes.ts`)

Source-of-truth split (decided in #43):

- **Which finishes exist** — the DB `finish_type` table (admin-managed via `/api/reference-admin/finishes`). A finish type created only through the admin UI is a valid finish for parsing, validation, `finish=`/`finishes=` list filters, ingestion, and AI finish detection. The build-time `CANONICAL_FINISHES` list in `packages/shared/src/constants/finishes.ts` is only the built-in seeded defaults: it types `PolishFinish` and is the fallback when the DB lookup fails. `tests/finishes.unit.test.cjs` fails if it drifts from the `finish_type` rows seeded by migrations 005/018.
- **How messy spellings map onto them** — the DB-backed `finish_normalization` table (admin-editable). An alias only resolves when its target is an existing `finish_type`.
- **One loader** — `loadFinishCatalog()` runs a single query over both tables and returns a `FinishCatalog` `{ aliases, validNames }` (`validNames` = every normalized `finish_type.name`). It is cached in-process for 5 minutes (cleared by `resetFinishAliasCache()` on every admin finish_type / finish_normalization create/update/delete; other instances pick changes up within the TTL) and falls back to `DEFAULT_FINISH_CATALOG` (`CANONICAL_FINISHES` + `DEFAULT_FINISH_ALIASES`, a mirror of the seeded alias rows also asserted by the test) if the query fails. If `finish_type` returns no rows, the built-in names are used.

Helpers (all take an optional `FinishCatalog`, defaulting to the built-ins): `canonicalizeFinish(value, catalog?)`, `canonicalizeFinishes(values, catalog?)`, `mergeFinishLists(lists, catalog?)`, and the pure tag parser `parseFinishesFromTags(tags, catalog?)` (used by ingestion connectors only, never for user request `tags`) — recognizes `finish:<value>` (prefix case-insensitive) and bare `<value>` tags, trims, lowercases, de-duplicates, ignores unknown values and other namespaces (`collection:holographic`, `color:blue`), and orders explicit `finish:` tags before bare tags. AI hex detection (`ai-color-detection.ts`) uses the same catalog loader for `detected_finishes`, so runtime finish types are accepted there too.
- `GET /api/reference-admin/jobs` lists recent ingestion jobs with pagination (`page`, `pageSize`) and optional `status` filter (`queued|running|succeeded|failed|cancelled`), joined with `data_source` for source metadata.
- `GET /api/users-admin` lists users with linked identities plus quick counts (inventory, submissions, capture sessions) for account-repair workflows.
- `POST /api/users-admin/merge` manually merges one local user account into another (inventory, capture sessions, submissions, click events, and linked external identities), intended for repairing duplicate accounts created before identity linking was enabled.
- Public reference reads and catalog lookups also use Redis read-through caching when configured; admin reference writes clear those cache entries.

Adding a new reference category (example: `texture_type`):
1. Start with a migration that creates the DB table + audit columns, and seed rows using `ON CONFLICT DO NOTHING`.
2. Implement public read endpoint(s) in `reference.ts` with `sort_order` ordering and cache headers.
3. Wire admin CRUD endpoint(s) in `admin-reference.ts` via `withAdmin`, including audit updates on writes.
4. Define shared contracts in `packages/shared/src/types/reference.ts`, then re-export from `packages/shared/src/index.ts`.
5. Finish by adding web API helpers and a `use-reference-data` consumption path for fallback-safe UI behavior.

### Connector Ingestion Jobs

`POST /api/ingestion/jobs` now **queues** an async ingestion run and returns `202 Accepted` with a queued job record.
Execution happens in a queue-triggered worker (`ingestion-worker.ts`) backed by Azure Storage Queue.

`POST /api/ingestion/bulk` is admin-only and queues one exhaustive ingestion job per
source. Use it when an admin needs to refresh complete catalogs across multiple
connectors, for example reindexing all enabled Shopify sources after improving
normalization or AI hex detection.

Request payload:
- `sources: IngestionSourceName[]` — supported source names with runnable connectors.
- `options.materializeToInventory?: boolean` — defaults to `true`.
- `options.detectHexFromImage?: boolean` — defaults to `true`.
- `options.overwriteDetectedHex?: boolean` — defaults to `false`.

Response payload:
- `enqueued: number` — number of queue messages created.
- `jobs: IngestionJobRecord[]` — queued ingestion job records.

Example request:

```json
{
  "sources": ["HoloTacoShopify", "MooncatShopify"],
  "options": {
    "materializeToInventory": true,
    "detectHexFromImage": true,
    "overwriteDetectedHex": false
  }
}
```

Example response:

```json
{
  "enqueued": 2,
  "jobs": [
    {
      "jobId": "123",
      "source": "HoloTacoShopify",
      "jobType": "connector_verify",
      "status": "queued",
      "startedAt": "2026-04-18T22:13:11.000Z"
    }
  ]
}
```

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
and user inventory rows (`quantity=0`) with source tags. `shade.finishes` is filled from the product
tags via `parseFinishesFromTags` (merged with any existing values, never removed). The legacy
`shade.finish` is still the raw first `finish:` tag value because it is part of the shade dedup key;
it is intentionally not canonicalized so re-imports keep matching existing shades. The same applies to
generic `*Shopify` sources; `MakeupAPI` materialization also merges finishes parsed from `tag_list`. Use `recentDays` to constrain to newer
products by publish/create/update timestamps. It also uploads source product images to Azure Blob
Storage (`image_asset` + `swatch`) and attempts Azure OpenAI-based representative `color_hex`
detection from the product image. Each shade gets one `swatch_type = 'source_product'` swatch for the
primary image (repointed in place when the shop changes it) and one `source_gallery` swatch per
additional image; re-imports only look at the `source_product` row, and a gallery swatch on the primary
image (e.g. the shop promoted a gallery image) is removed so the old primary is re-linked as gallery.
The generic Shopify connector only records a `vendor_hex` when a variant option or product title
contains a literal `#RRGGBB` token (e.g. `#A1B2C3`); bare words made of hex letters such as
"Facade" or "Decadence" are ignored. As of 2026-10-14 none of the supported Shopify storefronts
publish real hex values, so `detected_hex` from image AI is the only color source for those shades.
When `HEX_DETECTION_BATCH_ENABLED=true`, Shopify image detection can switch to Azure OpenAI Batch API
for larger runs (`HEX_DETECTION_BATCH_MIN_IMAGES` threshold). Records are committed before their batch
is submitted (the batch only fills in `detected_hex`), so the worker submits one batch per chunk, records
it in `metrics.aiBatches`, and keeps ingesting while the batches run in parallel. Once every record is
committed, the job stays `running` with pipeline stage `awaiting_ai`; a timer-triggered poller
(`ingestion-ai-batch-poller`) polls each pending batch, applies each one as it completes (persisting
after each), and marks the job `succeeded` when none are pending. A whole-store run therefore takes
roughly one batch window instead of one window per chunk. If a job reaches
`HEX_DETECTION_BATCH_MAX_IN_FLIGHT` pending batches with work remaining, the worker pauses early and
stores `metrics.resumeMessage`; after applying the pending batches the poller writes `metrics.checkpoint`
from it, removes `resumeMessage`, sets pipeline stage `continuation_queued`, persists, and then
re-enqueues the message so the worker continues. A failed or expired batch, a malformed
`resumeMessage`, or an enqueue failure marks the job `failed` (enqueue/resume problems use stage
`continuation_enqueue`). Jobs paused by an older worker with a single `metrics.aiBatch` are still
handled.
If batch submission itself fails, the worker logs the reason and falls back to synchronous detection for
that run (applying detections through the same shade write path the poller uses), recording the count in
the `batchFallbacks` metric instead of failing the job.
Batch and sync image detection now send URL inputs to Azure OpenAI (instead of base64 payloads) using
the Functions image proxy route (`/api/images/{id}`) when storage is configured.
The proxy origin is resolved from `INGESTION_AI_IMAGE_PROXY_ORIGIN` or falls back to
`https://$WEBSITE_HOSTNAME` in Azure.
Batch deployment resolution order is `AZURE_OPENAI_DEPLOYMENT_HEX_BATCH` → `AZURE_OPENAI_DEPLOYMENT_HEX` → `AZURE_OPENAI_DEPLOYMENT`.
When `AZURE_STORAGE_CONNECTION` isn't configured (for example in a fresh local checkout), the connector
falls back to storing the original Shopify `image.src` URL so images still appear in the app while
you bring storage online.
Materialization now commits per record while the job is running, so newly imported polishes become
visible progressively instead of waiting for the final job commit.

**Long-running jobs (continuations).** The Function App runs on the Consumption plan, which kills an
invocation at `functionTimeout` (`host.json`: 10 min; default 5 min). The ingestion worker therefore
processes each page in chunks (10 records with synchronous hex detection; up to 50 in batch mode, dropping
to 10 for the rest of the job once a batch submission fails and falls back to synchronous detection —
`metrics.hexBatchDegraded`) and saves `metrics.checkpoint` (`nextPage`, `recordOffset`, `pagesCompleted`, `recordsProcessed`,
`continuationCount`) after every chunk, so a hard kill loses at most one chunk. Once
`INGESTION_WORKER_TIME_BUDGET_MS` is spent, it persists the checkpoint with pipeline stage
`continuation_queued`, enqueues a continuation message carrying that checkpoint on `ingestion-jobs`, and
returns; the job stays `running` and the next invocation resumes from the checkpoint, keeping cumulative
totals (separate persistence/materialization totals live in `metrics.workerTotals`) and the log history.
Duplicate or redelivered messages are resolved by `resolveIngestionResumePoint` (`ingestion.ts`): a message
whose `continuationCount` is behind the job's checkpoint is dropped as stale; a current one resumes from
whichever checkpoint is further along. Between chunks the worker re-reads the job and stops without writing
if it was cancelled/finished or superseded. When a chunk pauses for an AI batch, the worker stores
`metrics.resumeMessage` (the continuation for the next unprocessed position, omitted when no work remains);
after applying the batch, the poller enqueues it instead of completing the job. `host.json` processes one
queue message per instance at a time (`batchSize: 1`, `newBatchThreshold: 0`) and moves a message to
`ingestion-jobs-poison` after 5 dequeues.
Shopify connectors download the whole store catalog per pull, so the worker gives each job a catalog
cache: the first download is kept in memory for the rest of the invocation and, when
`CONNECTOR_RAW_CONTAINER` is configured, saved as `catalog-cache/<source>/<jobId>.json.gz` with its URL in
`metrics.catalogSnapshot`. Continuations reuse that snapshot, so every invocation pages through the same
catalog; an unreadable snapshot just triggers a fresh download.
Ingestion metrics now include token totals for synchronous image detection (`hexDetectionPromptTokens`, `hexDetectionCompletionTokens`, `hexDetectionTotalTokens`) and batch apply totals under `aiBatchApply` (`promptTokens`, `completionTokens`, `totalTokens`, `rowsWithTokenUsage`) for the latest batch; `aiBatchApplyTotals` and `aiBatchesCompleted` accumulate across every batch in a job.

Holo Taco run options:
- `detectHexFromImage` (default `true`) toggles image-based AI hex detection.
- `overwriteDetectedHex` (default `false`) refreshes existing `color_hex` values on reruns instead of only filling blanks.
- `detectHexOnSuspiciousOnly` (default `false`) only runs image AI when vendor hex is missing/suspicious.

Reruns skip work that cannot change anything. Without `overwriteDetectedHex`, a record whose shade already has a
`detected_hex` and whose `source_product` swatch is already on the same image (same checksum) skips AI detection, because the shade write
would keep the existing hex anyway. These are counted in `hexDetectionSkippedUnchanged` (a subset of
`hexDetectionSkipped`). Every stored source image is also recorded in `source_image_url` under the connector URL it
came from; on a rerun, an image whose URL is unchanged (Shopify CDN URLs carry a `?v=` version that changes when the
image is replaced) reuses the stored blob and checksum without downloading it. These are counted in `imagesReused`,
while `imageUploads` and `additionalImagesUploaded` count only images downloaded this run. New URLs are downloaded to
compute the checksum, and the blob upload is skipped when the checksum-named blob already exists. Set `overwriteDetectedHex: true` to re-detect everything, for example after
a prompt or model change.

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

## Hex detection evaluation harness

`src/eval/hex/` measures how well vendor-image hex detection recovers a shade's true color, so
prompt and pipeline changes (palette-pick, region crops, image selection, blind prompts) can be
compared with numbers instead of by eye. Nothing in it touches the production detection prompt or
the shade write path.

```bash
# From repo root
npm run eval:hex --workspace=swatchwatch-functions -- --strategy pixel            # offline pixel baseline
npm run eval:hex --workspace=swatchwatch-functions -- --strategy azure-current,azure-blind --verbose
npm run eval:hex --workspace=swatchwatch-functions -- --strategy all --fixture eval/hex/fixtures/color-training-sample.json
npm run eval:hex --workspace=swatchwatch-functions -- --list-strategies
npm run eval:hex:populate --workspace=swatchwatch-functions -- --dry-run         # DB → color_training_sample → fixture
```

Both scripts build `swatchwatch-shared` and this package first, then run `dist/eval/hex/cli.js` /
`dist/eval/hex/populate.js`. They load `local.settings.json` `Values` into the environment (without
overriding variables already set), so the same Postgres / Azure OpenAI config the host uses applies.

**Strategies** (`src/eval/hex/strategies.ts`, one object each — add a new one by appending to `STRATEGIES`):

| Name | What it does | Needs Azure OpenAI |
|---|---|---|
| `azure-current` | `detectHexWithAzureOpenAI` exactly as ingestion calls it: image + vendor context (shade name, description, tags, and the vendor hex only when the ground truth *is* a vendor option). | yes |
| `azure-blind` | The same call with `vendorContext` removed — what the model gets from the image alone. | yes |
| `pixel` | Top dominant color from `extractDominantColors` over the whole image. A deliberately naive baseline (product shots mostly return the background). | no |
| `region-crop` | Two steps: the model only *localizes* (names the labeled grid cells filled with polish — painted nail/swatch first, else lacquer in the bottle; never cap, label, brush, skin, background — or, in `bbox` mode, returns one normalized box) plus the finishes it sees, and the pixels there are *measured* (`src/lib/region-color.ts`). See below. | yes |
| `palette-pick` | Pixels measure, the model chooses: 8–12 perceptually distinct candidate colors are extracted from the image, drawn as labeled chips (A, B, C, …) beside the photo in one composite, and the model is asked which chip is the base lacquer. The answer is the chosen chip's *measured* hex, so the model can never answer in CSS named colors. | yes |

When Azure OpenAI is not configured (`AZURE_OPENAI_ENDPOINT` + `AZURE_OPENAI_KEY` + `AZURE_OPENAI_DEPLOYMENT_HEX`/`AZURE_OPENAI_DEPLOYMENT`,
or the APIM gateway equivalents), Azure strategies print `Skipping strategy …` and the run still exits 0.

**`region-crop` in detail** (`src/eval/hex/strategies/region-crop.ts` + `src/lib/region-color.ts`). LLMs localize
better than they read absolute color values, so the model is never asked for a hex. Step 1 calls
`requestAzureOpenAiChatCompletion` in `src/lib/ai-color-detection.ts`. It has the same config, timeout, 429/5xx retry and
safer-prompt retry after a content-filter rejection as `detectHexWithAzureOpenAI`, but takes a custom JSON-mode prompt. Two localization modes
(`HEX_EVAL_REGION_CROP_MODE`):

- `cells` (default): a labeled N×N grid (`HEX_EVAL_REGION_CROP_CELLS`, default 6) is drawn on the copy sent to the model
  (`drawLabeledGrid`). The model answers `{"cells":["C3",…],"region","finishes","confidence"}`, listing up to 8 cells filled
  with polish. Each valid cell's central 60% is measured (`gridCellToBox`); labels outside the grid are dropped.
- `bbox`: the model answers `{"x","y","w","h","region","finishes","confidence"}` in normalized 0..1 coordinates.
  `HEX_EVAL_REGION_CROP_GRID=true` adds a 4×4 grid to the copy. `clampBox` rejects empty, non-finite and fully-outside
  boxes; such cases get `hex: null` with `meta.reason = "invalid_box"`.

Step 2, `measureRegionsColor(image, boxes, { darkerHalf })`, crops every box from the *original* image with sharp
and pools the pixels. It converts them to OKLAB and drops the top 5% by lightness as specular highlights. It also
drops very dark edge pixels (OKLAB L < 0.2), but only when they are at most a quarter of the crop, so a black polish
keeps its pixels. The result is the per-channel OKLAB median. When the model reports a sparkle finish
(glitter/holo/flake/shimmer), the median is taken over the darker half so particles do not lift the base color.
`meta` records the mode, grid size, cells or box, pixel crops, region kind, raw and canonical finishes, pixel counts,
`highlightCutoffL`, `darkFloorApplied`, `usedDarkerHalf`, the measured OKLAB and token usage.
`HEX_EVAL_REGION_CROP_DETAIL=low|high|auto` overrides the vision detail for the locator call (default:
`AZURE_OPENAI_VISION_DETAIL`, then `low`).

Why cells is the default. These results are from `sample.json` (18 cases), gpt-4o-mini, 2026-10-16, median OKLAB distance:

| variant | overall | Holo Taco (bottle shots) | Mooncat (painted hands) | ≤0.05 overall | prompt tokens/image |
|---|---|---|---|---|---|
| `azure-blind` (reference) | 0.077 | 0.059 | 0.086 | 28% | ~3.1k |
| bbox, low | 0.215 | 0.203 | 0.231 | 17% | ~3.2k |
| bbox + 4×4 grid, low | 0.201 | 0.186 | 0.233 | 17% | ~3.2k |
| bbox, high | 0.207 | 0.176 | 0.237 | 6% | ~26k |
| **cells 6×6, low (default)** | 0.157 | 0.080 | 0.230 | 22% | ~3.2k |
| cells 6×6, high | 0.186 | 0.083 | 0.229 | 22% | ~26k |
| cells 8×8, low | 0.192 | 0.125 | 0.206 | 22% | ~3.2k |
| cells 8×8, high | 0.155 | **0.039** | 0.236 | 28% | ~26k |

In bbox mode the model ignores the image and returns a generic centered box, usually `(0.2, 0.2, 0.6, 0.6)`. The grid
overlay barely changes that, so drawing a grid only pays off when the model answers in cell names. Cell mode beats the
blind prompt on bottle shots: 63% within 0.05 with 8×8 high detail, against 50% for the blind prompt. It still loses
badly on painted-hand photos, where the model picks the middle columns of the fingers (knuckles and skin) instead of the
nail beds. Region-crop is therefore not a drop-in replacement yet. It is a candidate for bottle shots, or for an
ensemble with a skin- or variance-aware cell filter.

**Palette pick** (`src/lib/palette-pick-detection.ts`, strategy file `src/eval/hex/strategies/palette-pick.ts`)
is a reusable library piece, not just an eval strategy, so ingestion can adopt it later; today nothing in the
production write path calls it. `detectHexByPalettePick(imageBytes, options)` runs the whole pipeline:

1. `extractPaletteCandidates` — `extractDominantColors` (96 px sample, 4-bit quantization, 48 raw buckets)
   merged with `mergeSimilarColors` in OKLAB. The merge distance is loosened→tightened (`0.04`, `0.025`,
   `0.015`) until at least 8 candidates survive, capped at 12; each gets a letter label in prominence order.
2. `renderPaletteComposite` — sharp draws the photo (longest edge ≤ 512 px) at the left and a strip of solid
   chips at the right (one column up to 6 chips, two columns row-major above that; chips sized to fit the photo
   height, 56–128 px, with a big contrasting letter). `computeCompositeLayout` is the pure geometry.
3. `requestAzureOpenAIChatCompletion` (the lower-level helper in `ai-color-detection.ts` that the production
   detector also uses: config resolution, timeout/retry on 429/5xx, one content-filter retry with a safe
   prompt) sends the composite with a prompt that asks for `{"choice":"B","confidence":0..1,"finishes":[...]}`
   — ignore cap, brush, packaging, background, glitter; pick the underlying base for effect finishes. The chip
   hexes are *not* in the prompt.
4. `parsePaletteChoice` maps the letter back to its chip (tolerating `"b"`, `"chip B"`, `2`); an unknown or
   missing letter yields `hex: null` with a `reason` rather than a guessed color.

The eval strategy records `candidates`, `choice`, `composite` (width/height/chip size/grid) and token `usage`
in each case's `meta`, plus `rawContent` when no hex was produced. Vision detail follows
`AZURE_OPENAI_VISION_DETAIL` (default `low`, i.e. a single 512 px view — the chips are sized to stay legible
at that scale). Token-usage metrics are emitted under `hex_detection.palette_pick.*`.

**Scoring** (`src/eval/hex/scoring.ts`): each case's predicted hex is compared with its ground truth by
OKLAB Euclidean distance (`hexToOklab` / `oklabDistance` from `swatchwatch-shared`, the same math as
`/api/polishes/match-image`). The report gives, overall and per brand and per primary finish: case count,
scored count, median and p90 distance (nearest-rank, over cases with a prediction), and the share of
**all** cases within the HIGH (`0.05`) and MEDIUM (`0.10`) thresholds from `src/lib/color-match.ts`
(a missing prediction counts as outside both). It is printed as a table (`--verbose` adds a per-case
table) and written as JSON to `eval/hex/results/<strategy>-<timestamp>.json` plus
`<strategy>-latest.json` (gitignored). Downloaded images are cached in `eval/hex/.cache/` (gitignored;
`--no-cache` to refetch).

**Fixture format** (`eval/hex/fixtures/*.json`, validated by `src/eval/hex/fixture.ts`):

```json
{
  "version": 1,
  "description": "optional",
  "cases": [
    {
      "id": "holotaco:pier-pressure",
      "brand": "Holo Taco",
      "shadeName": "Pier Pressure",
      "finishes": ["creme"],
      "groundTruthHex": "#22BACC",
      "groundTruthSource": "swatch_measured",
      "source": "HoloTacoShopify",
      "imageUrl": "https://cdn.shopify.com/.../bottle.jpg",
      "description": "optional vendor copy forwarded as context",
      "tags": ["finish:creme", "color:teal"],
      "externalId": "7902303944794",
      "notes": "optional provenance"
    }
  ]
}
```

- `imageUrl` (http/https) **or** `imagePath` (relative to the fixture file, no `..`) — exactly one.
- `groundTruthSource` is one of `vendor_option` (hex published by the vendor), `swatch_measured`
  (measured from the vendor's own painted-nail photo), `manual`, `ai_detected` (approved AI output).
- `finishes[0]` is the "primary finish" used for the per-finish breakdown (`unknown` when empty).

`eval/hex/fixtures/sample.json` is a checked-in 18-case smoke set (Holo Taco + Mooncat cremes, mattes,
metallics). Its image is the first Shopify product image (what ingestion sends to the model) and its
ground truth was measured from a *different* vendor photo of painted nails (each case's `notes` says
which). It is a curated sample for exercising the runner, not vendor-published hex data.

**Populating from ingested data** (`src/eval/hex/populate.ts`, migration `20261016040629000_add-color-training-sample.sql`): reads shades whose
`vendor_hex` is set and not a known placeholder (`src/lib/suspicious-hex.ts`), matches each to its
latest `external_product` row (same brand + shade name; a product with no brand only falls back to Holo Taco when it comes from `HoloTacoShopify`) for the public product image, upserts one
`color_training_sample` row per external product (`source_type = 'vendor_option'`,
`training_status = 'pending'`; re-runs refresh `pending` rows instead of duplicating, and never touch rows already curated to `approved`/`rejected`/`used`), and exports rows with status
`pending`/`approved` to `eval/hex/fixtures/color-training-sample.json` (gitignored — copy it to a named
fixture to check one in). Curate by setting `training_status` to `approved`/`rejected`, then export
again with `--export-only --status approved`. Options: `--source <names>`, `--limit <n>`,
`--status <list>`, `--out <path>`, `--export-only`, `--dry-run`. Note that in the current dev data most
`vendor_hex` values are placeholders or CSS named colors left by older runs, so treat exported ground
truth as "pending" until reviewed.

## Migrations

Schema migrations use [node-pg-migrate](https://github.com/salsita/node-pg-migrate) with raw SQL files in `migrations/`. Each file contains an up migration and a `-- Down Migration` section for rollback.

### Naming convention (dated filenames)

**New migrations use a UTC timestamp prefix:** `YYYYMMDDHHMMSSsss_description.sql` — a 17-digit UTC datetime down to the millisecond, e.g. `20260608021420930_add-swatch-index.sql`. `npm run migrate:create -- "add swatch index"` generates this automatically (`--migration-filename-format utc`).

Timestamp prefixes are monotonic and globally unique, which avoids the prefix collisions the old sequential `NNN_` scheme is prone to (this repo already has two `020_` files). They also sort *after* the legacy `0NN_` files lexicographically, so ordering is preserved.

> **Existing `001_`–`022_` files are intentionally left as-is.** node-pg-migrate records applied migrations by filename in the `pgmigrations` table — renaming an already-applied migration would make it look unapplied and re-run it. Only new migrations adopt the dated format; the legacy files are migrated forward by convention, not by rename.

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
| `004_add_expiration_date.sql` | Adds expiration_date to user_inventory_item |
| `005_seed_production_reference_data.sql` | Seeds production reference data |
| `006_add_user_external_id.sql` | Adds external_id column to app_user for Entra identity linking |
| `007_add_makeup_api_data_source.sql` | Registers `MakeupAPI` in `data_source` for connector ingestion |
| `008_add_holo_taco_shopify_data_source.sql` | Registers `HoloTacoShopify` in `data_source` for connector ingestion |
| `009_add_admin_role_and_ingestion_queue_support.sql` | Adds `app_user.role`, seeds dev admin user (`user_id=2`), supports admin-gated async ingestion flow |
| `010_add_ingestion_settings.sql` | Adds per-source and global ingestion settings tables |
| `011_split_color_hex.sql` | Splits monolithic color_hex into vendor_hex, detected_hex, name_hex fields |
| `012_move_color_data_to_shade.sql` | Moves color fields from user_inventory_item to the canonical shade table |
| `013_shade_catalog_visibility.sql` | Adds timestamps to `shade`, enforces one `user_inventory_item` per user/shade to support catalog-wide visibility |
| `014_add_user_inventory_unique_constraint.sql` | Adds unique constraint on (user_id, shade_id) in user_inventory_item |
| `015_normalize_finish_creme.sql` | Normalizes finish values (cream → creme) across existing data |
| `016_add_shade_detected_finishes.sql` | Adds detected_finishes array column to shade for AI-extracted finish tags |
| `017_add_admin_support.sql` | Adds `finish_type` audit columns and creates/seeds `harmony_type` for admin-managed reference data |
| `018_add_finish_normalizations.sql` | Adds editable `finish_normalization` mappings (source alias → canonical finish name) for AI/vendor finish parsing |
| `019_add_user_external_identities.sql` | Adds `user_external_identities` and backfills existing `app_user.external_id` values to support multi-provider identity linking |
| `023_add_shade_finishes.sql` | Adds `shade.finishes text[] NOT NULL DEFAULT '{}'` + GIN index for multi-finish shades, backfills `ARRAY[canonical(finish)]` from the legacy column (canonical names + `finish_normalization` aliases), and seeds `flakie`/`flakies`/`toppers` aliases. Down drops the column/index and those alias rows |
| `024_shade_user_submitted.sql` | Adds nullable `shade.created_by_user_id` (FK → `app_user`, `ON DELETE SET NULL`) + partial index; user-created shades use `status = 'user_submitted'` until an admin promotes them. Down drops the column/index |
| `025_add_color_training_sample.sql` | Creates `color_training_sample` (ground-truth hex samples from `docs/schema.sql`) plus a partial unique index on `(external_product_id, source_type)` so the eval harness populate script is idempotent |
| `025_correct_shopify_source_notes.sql` | Corrects Shopify `data_source.metadata.notes` (no store publishes hex values) and disables Clionadh, Garden Path, Roylalee and Potion Polish, which the connector cannot read |
| `20261016030127700_clear-fake-shopify-vendor-hex.sql` | Nulls `shade.vendor_hex` values the generic Shopify connector invented before PR #238: regex false positives (hex digits found in the shade name/color name/raw Shopify title or options but never as a literal `#RRGGBB` token, e.g. "Facade" → `#FACADE`) and the `#000000`/`#D3D3D3` placeholders. Only Shopify-sourced shades (inventory tagged `shopify` or swatch owned by a `*Shopify` data source); MakeupAPI-linked shades and `detected_hex`/`name_hex` are untouched. Old values go to `shade_vendor_hex_cleanup_backup`; down restores them where `vendor_hex` is still null, then drops the table |
| `20261016030938732_move-ai-hex-out-of-shopify-vendor-hex.sql` | Moves AI-detected hex values out of `shade.vendor_hex` on Shopify-sourced shades. Before 011 the Holo Taco connector stored only the Azure OpenAI vision result in `color_hex`, which 011/012 relabeled as `vendor_hex`. A value moves when its hex digits appear nowhere in the shade name, color name or raw Shopify title/options (so the connector regex could not have produced it). It goes to `detected_hex` when that is empty; otherwise `vendor_hex` is only cleared. Same Shopify-sourced/MakeupAPI-exclusion rules as `20261016030127700_clear-fake-shopify-vendor-hex.sql`; `#000000`/`#D3D3D3` placeholders and user-created shades are skipped. Old values go to `shade_vendor_hex_to_detected_backup`; down resets `detected_hex` where it still holds the moved value, restores `vendor_hex` where it is still null, then drops the table |
| `20261016033423000_cleanup-gallery-swatches-on-primary-image.sql` | Deletes `source_gallery` swatches that re-ingestion had repointed at the shade's primary image (duplicates of the `source_product` swatch) and collapses duplicate gallery swatches per shade + image. Idempotent; down is a no-op |
| `20261016040629000_add-color-training-sample.sql` | Creates `color_training_sample` (ground-truth hex samples from `docs/schema.sql`) plus a partial unique index on `(external_product_id, source_type)` so the eval harness populate script is idempotent |

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
- AI image detection uses URL payloads (image-proxy or source URL fallback). If no usable image URL is available for a record, detection is skipped and a warning is logged to the Admin Jobs stream.
- On successful AI hex detection, ingestion logs a structured success entry with `brand`, `colorName`, and `hex` in job logs (Admin Jobs expandable log view).
- Sync and batch hex detection logs now include Azure token usage when present, and those totals are persisted in ingestion job metrics for cost tracking.
- When `APPLICATIONINSIGHTS_CONNECTION_STRING` is configured, token usage is also emitted as custom metrics: `hex_detection.sync.{prompt_tokens|completion_tokens|total_tokens}` and `hex_detection.batch.{rows_with_token_usage|prompt_tokens|completion_tokens|total_tokens}`.
- For ingestion runs, those AI diagnostics are mirrored into the job `metrics.logs` stream shown on `/admin/jobs`; poller status events (`awaiting_ai` checks and apply results) are appended to that same stream.


## Environment Variables

Defined in `local.settings.json` (git-ignored values). See the root README for the full list. For production, secrets are injected via Key Vault references.

Key variables:

| Variable | Purpose |
|----------|---------|
| `AUTH_DEV_BYPASS` | Local-dev-only bypass mode. When `true` **and the host is not running in Azure**, auth accepts `Bearer dev:<userId>` tokens. Ignored (fail closed, logged + `auth.dev_bypass_refused`) on Azure-hosted Function Apps; the deploy workflow always sets it to `false`. |
| `IMAGE_PROXY_SIGNING_KEY` | Secret (>= 32 chars) used to HMAC-sign `/api/images/{id}` ids. Required outside dev: when unset and dev bypass is not active, image URLs are omitted and the proxy refuses every request. When unset with dev bypass active (local only), an ephemeral per-process key is used (URLs break on restart). Generate with `openssl rand -base64 48`. Terraform stores a generated value in Key Vault (`image-proxy-signing-key`). |
| `IMAGE_PROXY_ID_TTL_SECONDS` | Minimum remaining lifetime of newly minted `/api/images/{id}` ids (default `259200` = 3 days, clamped to 3600–2592000). Keep it above the Azure OpenAI batch completion window. |
| `IMAGE_PROXY_LEGACY_ID_ACCEPT_UNTIL` | Optional ISO-8601 timestamp until which legacy non-expiring (v1) image ids are still accepted. Unset or in the past means they are rejected (`403`). |
| `INGESTION_JOB_QUEUE_NAME` | Optional queue name for async ingestion jobs. Defaults to `ingestion-jobs`. |
| `SOURCE_IMAGE_CONTAINER` | Optional blob container override for source-ingested images. Defaults to `source-images`. |
| `AZURE_STORAGE_CONNECTION` | Connection string for uploading source images to Azure Blob Storage. When unset (for local dev or bring-up), ingestion falls back to storing the original source image URLs so swatch images still appear. |
| `AZURE_OPENAI_GATEWAY_ENDPOINT` | Optional APIM gateway base URL used when `AZURE_OPENAI_USE_GATEWAY=true`. |
| `AZURE_OPENAI_GATEWAY_SUBSCRIPTION_KEY` | Optional APIM subscription key header value (`Ocp-Apim-Subscription-Key`) used in gateway mode. |
| `AZURE_OPENAI_USE_GATEWAY` | Feature flag (`true`/`false`) to route Azure OpenAI calls through APIM gateway endpoint. |
| `AZURE_OPENAI_DEPLOYMENT_LABEL` | Optional Azure OpenAI deployment name for label OCR structured extraction (`src/lib/ocr-parser.ts`). Falls back to `AZURE_OPENAI_DEPLOYMENT_HEX`, then `AZURE_OPENAI_DEPLOYMENT`. |
| `AZURE_OPENAI_DEPLOYMENT_HEX` | Optional Azure OpenAI deployment name for synchronous image hex detection (falls back to `AZURE_OPENAI_DEPLOYMENT` when unset). |
| `AZURE_OPENAI_DEPLOYMENT_HEX_BATCH` | Optional Azure OpenAI deployment name for batch image hex detection (falls back to `AZURE_OPENAI_DEPLOYMENT_HEX`, then `AZURE_OPENAI_DEPLOYMENT`). |
| `AZURE_OPENAI_BATCH_API_VERSION` | Optional API version used for Azure OpenAI Files/Batch endpoints (default `2025-03-01-preview`). |
| `AZURE_OPENAI_BATCH_COMPLETION_WINDOW` | Optional completion window sent during batch creation (default `24h`). |
| `AZURE_OPENAI_VISION_DETAIL` | Optional image detail level for vision hex detection, sync and batch (`low` default — flat ~85 tokens/image; `high`/`auto` for more resolution). Unrecognized values fall back to `low`. |
| `HEX_DETECTION_BATCH_ENABLED` | Feature flag to enable Azure OpenAI Batch API for Shopify image detection (default `false`). |
| `HEX_DETECTION_BATCH_MIN_IMAGES` | Minimum record count before switching from synchronous detection to batch submission (default `5`). |
| `HEX_DETECTION_BATCH_MAX_IN_FLIGHT` | Max hex batches one ingestion job keeps pending before the worker pauses for `awaiting_ai` (default `20`, clamped 1–100); bounds the job's share of the batch deployment's enqueued-token quota. |
| `HEX_DETECTION_DELAY_MS` | Pause after each synchronous (non-batch) hex detection call, per concurrency slot (default `1000`, max `60000`, `0` disables). The old fixed 6s pacing predates low-detail images; 429s are still retried with `Retry-After`. |
| `HEX_DETECTION_CONCURRENCY` | Synchronous hex detection calls in flight at once (default `4`, max `32`). Records still commit to Postgres one at a time, in order. The deployment's tokens-per-minute quota is the real ceiling, so raise this together with `openai_deployment_capacity`. |
| `INGESTION_AI_BATCH_POLL_SCHEDULE` | NCRONTAB schedule for the timer poller that checks batch completion (default `0 * * * * *`, every minute). |
| `INGESTION_AI_BATCH_MAX_POLL_JOBS` | Max `awaiting_ai` ingestion jobs the poller processes per run (default `10`). |
| `INGESTION_AI_IMAGE_PROXY_ORIGIN` | Optional public origin used when building AI image-proxy URLs (for example `https://<func-app>.azurewebsites.net`). Falls back to `https://$WEBSITE_HOSTNAME`. |
| `INGESTION_WORKER_TIME_BUDGET_MS` | Wall-clock budget per ingestion worker invocation before it checkpoints and enqueues a continuation message (default `240000`, clamped to `30000`–`270000` to stay under the Consumption plan timeout). |
| `INGESTION_LOG_FLUSH_INTERVAL_MS` | Interval for ingestion worker metric/log flushes while a job runs (default `10000`). Increase to reduce write pressure on Postgres. |
| `SHOPIFY_CONNECTOR_REQUEST_TIMEOUT_MS` | Per-request timeout for Shopify `products.json` downloads (default `45000`). |
| `SHOPIFY_CONNECTOR_MAX_RETRIES` | Retry count for transient Shopify request errors (default `2`, total attempts = retries + 1). |
| `SHOPIFY_CONNECTOR_RETRY_BASE_DELAY_MS` | Linear backoff base delay for Shopify retries (default `1000`). |
| `PG_POOL_MAX` | Postgres pool max client count for Functions process (default `10`). |
| `PG_IDLE_TIMEOUT_MS` | Idle timeout for pooled Postgres clients (default `30000`). |
| `PG_CONNECTION_TIMEOUT_MS` | Connection acquisition timeout for Postgres clients (default `15000`). |
| `PG_QUERY_MAX_RETRIES` | Retries for retry-safe DB queries (`SELECT` and `UPDATE ingestion_job`) when connection timeouts occur (default `2`). |
| `PG_QUERY_RETRY_BASE_MS` | Linear backoff base delay in ms for retry-safe DB query retries (default `250`). |
| `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT` | Azure AI Document Intelligence endpoint for server-side OCR (`src/lib/ocr.ts`). Graceful degradation when missing. |
| `AZURE_DOCUMENT_INTELLIGENCE_KEY` | Azure AI Document Intelligence subscription key for OCR. |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | Optional custom telemetry sink for `trackEvent` / `trackMetric` / `trackException` in `src/lib/telemetry.ts`. When unset, telemetry calls are no-ops. |
| `REDIS_URL` | Redis endpoint URL for API read-through caching (for example `rediss://<host>:10000`). |
| `REDIS_KEY` | Redis access key paired with `REDIS_URL`. When either Redis var is missing, cache helpers become no-ops and requests fall back to Postgres. |

Batch runtime note: `HEX_DETECTION_BATCH_ENABLED` and `HEX_DETECTION_BATCH_MIN_IMAGES` are read when each ingestion worker message and batch poller run starts, so logs reflect the effective values used for that execution.

JWT validation note:
- In production mode (`AUTH_DEV_BYPASS=false`), auth discovery first tries Entra External ID (`ciamlogin.com`) metadata for `AZURE_AD_B2C_TENANT`, then falls back to legacy Azure AD B2C (`b2clogin.com`) metadata.
- Accepted token audiences are `AZURE_AD_B2C_CLIENT_ID` and `api://AZURE_AD_B2C_CLIENT_ID` to support exposed-API scopes like `access_as_user`.
- Auth links identities by `external_id` first, then by email (`one app_user per email`) using `user_external_identities`.
- `role` is synchronized from Entra token roles on each authenticated request.

Dev deploy note:
`deploy-dev.yml` configures Function App auth settings from GitHub `dev` environment values on each deploy.
- `AUTH_DEV_BYPASS` is always set to `false` (the `vars.AUTH_DEV_BYPASS` GitHub variable is no longer read; the host would refuse it in Azure anyway)
- Secret: `AZURE_AD_B2C_CLIENT_ID`
- Tenant source: `AZURE_AD_B2C_TENANT` variable (falls back to `NEXT_PUBLIC_B2C_TENANT`)
- Deployment packaging installs `swatchwatch-shared` from a local `.tgz` tarball (not a `file:` directory symlink) so `WEBSITE_RUN_FROM_PACKAGE` can resolve it reliably.
- Build artifacts run npm install scripts (no `--ignore-scripts`) so native dependencies like `sharp` can hydrate their platform-specific binaries.
- The workflow sets `FUNCTIONS_NODE_BLOCK_ON_ENTRY_POINT_ERROR=true` so entrypoint/import failures hard-fail startup instead of surfacing as misleading route-level `404` responses.
- The workflow explicitly runs `az functionapp sync-functions` after zip deployment to force trigger refresh.
- Post-deploy smoke tests:
  - `POST /api/voice` without a token should return `401` (host reachable + routing + auth wrapper works; the workflow check is currently commented out).
  - `GET /api/polishes?pageSize=1` without a token should return `401` (or `200`): host reachable + routing + auth wrapper.

## Build

```bash
npm run build --workspace=packages/functions   # tsc → dist/
npm run watch --workspace=packages/functions   # tsc -w (used by debug task)
```

Output goes to `dist/`. The `host.json` and `local.settings.json` stay at package root.
