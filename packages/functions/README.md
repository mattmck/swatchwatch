# Azure Functions — `packages/functions`

Azure Functions v4 HTTP API (Node 22, TypeScript).

## Running Locally

```bash
# From repo root
npm run setup            # Install workspace dependencies first
npm run dev:infra        # Start local Postgres + Azurite
npm run dev:functions    # TypeScript watch + func host on http://localhost:7071
npm run test --workspace=swatchwatch-functions  # Run Functions unit tests
npm run test:e2e --workspace=swatchwatch-functions  # E2E tests against the running local host

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
  rejects unsigned/forged/tampered ids (the `images signed-id (requires #47)` block). Its nested
  `owner-scoped private ids (#227)` block asserts that a private `v3` id is served only to its owner
  (401 without a token, 403 for another user or an expired/forged id) and that neither id version can
  read the other's container. The `private nail photos are scoped to the inventory owner (#270)` block
  asserts that another user (admins included) gets 404 on GET/PUT/DELETE
  `/api/inventory/{id}/nail-photo` for the owner's item before any body parsing, image processing or
  storage access, that the owner's photo URL is a `v3` id the attacker's token cannot read, and that
  deleting the polish removes its photo. `tests/nail-photos.unit.test.cjs` covers the nail-photo
  handlers (validation, replace, delete, 413/415/503, orphan-blob cleanup) and
  `tests/nail-photo-image.unit.test.cjs` proves with real sharp that EXIF/GPS/XMP/ICC metadata is
  stripped and orientation applied. `tests/auth-read-only.unit.test.cjs` covers the read-only caller
  lookup the image proxy uses.
  `tests/shade-review.unit.test.cjs` drives the review-queue merge/approve/reject transactions
  against a fake pg client (duplicate-inventory combine, reference re-pointing before delete, generic
  column carry-over incl. a `status` column, refusals with no writes); the admin route families in
  `access-control.unit.test.cjs` include `admin-shade-review-*` (403/401), and
  `access-control-catalog.unit.test.cjs` checks that rejected and merged submissions never reach other
  users (and merged ones are hidden from their creator too).
  `tests/manicures.unit.test.cjs` covers the mani log (#269): request validation, wear-stat
  recomputation on create/edit/delete against an in-memory fake of the manicure tables, the
  `inventory_event` sync, and cross-user isolation (another user's manicures, inventory items and photos
  are 404, every statement is bound to the caller).
  `tests/wishlist-share.unit.test.cjs` covers the shareable wishlist (#268): token derivation,
  hashing and canonical parsing, the flag (404 `feature_disabled` on every route, before auth and SQL),
  rotate/revoke making old links 404, the public payload allowlist (no PII, no private fields, only
  `wishlist` items on catalog shades, public `v2` images only), the rate limiter (429 + `Retry-After`
  per IP and per token), and cross-user isolation of the owner routes.
- **E2E** (`npm run test:e2e`): `tests/api.test.cjs` + `tests/access-control.e2e.test.cjs` against
  a live host at `http://localhost:7071/api` started with `AUTH_DEV_BYPASS=true` and migrated dev
  data (seed users `dev:1` and `dev:2`). The access-control suite has user 2 attempt to read/modify
  user 1's polish and capture session (including spoofed `userId` bodies/query params and searching by
  user 1's private notes/tags), verifies user 1's data is unchanged, checks tampered image ids, and
  checks that user 1's nail photo routes are 404 for user 2 and the uploaded photo's `v3` URL is 403 for
  user 2 (the upload part is skipped when the host has no blob storage, i.e. answers 503). It
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
| `GET` | `/api/polishes-admin/hex-review` | `getHexReview` | `polishes.ts` | ✅ Live (admin-only) |
| `POST` | `/api/polishes/match-image` | `matchImage` | `polishes.ts` | ✅ Live |
| `GET` | `/api/manicures/{id?}` | `getManicures` | `manicures.ts` | ✅ Live (mani log list/get) |
| `POST` | `/api/manicures` | `createManicure` | `manicures.ts` | ✅ Live |
| `PUT`/`PATCH` | `/api/manicures/{id}` | `updateManicure` | `manicures.ts` | ✅ Live (partial update) |
| `DELETE` | `/api/manicures/{id}` | `deleteManicure` | `manicures.ts` | ✅ Live |
| `POST` | `/api/polish-imports` | `createImport` | `polish-imports.ts` | ✅ Live (CSV upload → parse + match → review session) |
| `GET` | `/api/polish-imports/{id}` | `getImport` | `polish-imports.ts` | ✅ Live (owner only) |
| `PATCH` | `/api/polish-imports/{id}` | `patchImport` | `polish-imports.ts` | ✅ Live (save review decisions) |
| `DELETE` | `/api/polish-imports/{id}` | `deleteImport` | `polish-imports.ts` | ✅ Live (discard) |
| `POST` | `/api/polish-imports/{id}/commit` | `commitImport` | `polish-imports.ts` | ✅ Live (idempotent inventory upsert) |
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
| `PUT` | `/api/reference-admin/finishes/{id}` | `adminFinishesItemHandler` | `admin-reference.ts` | ✅ Working (admin-only; a `name` change cascades to shades and finish normalizations in one transaction, `409` when the name is taken) |
| `DELETE` | `/api/reference-admin/finishes/{id}` | `adminFinishesItemHandler` | `admin-reference.ts` | ✅ Working (admin-only; `409` + usage counts while the finish type is in use) |
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
| `GET` | `/api/shades-admin/review` | `listReviewQueue` | `admin-shade-review.ts` | ✅ Working (admin-only) |
| `GET` | `/api/shades-admin/review/{id}/candidates` | `getCandidates` | `admin-shade-review.ts` | ✅ Working (admin-only) |
| `POST` | `/api/shades-admin/review/{id}/approve` | `approve` | `admin-shade-review.ts` | ✅ Working (admin-only) |
| `POST` | `/api/shades-admin/review/{id}/merge` | `merge` | `admin-shade-review.ts` | ✅ Working (admin-only) |
| `POST` | `/api/shades-admin/review/{id}/reject` | `reject` | `admin-shade-review.ts` | ✅ Working (admin-only) |
| `POST` | `/api/voice` | `processVoiceInput` | `voice.ts` | ⬜ Stub (auth required) |
| `GET` | `/api/images/{id}` | `images` | `images.ts` | ✅ Working (signed ids; owner-scoped for private media) |
| `GET` | `/api/inventory/{inventoryItemId}/nail-photo` | `getNailPhoto` | `nail-photos.ts` | ✅ Working (owner only; `{ photo: NailPhoto \| null }`) |
| `PUT` | `/api/inventory/{inventoryItemId}/nail-photo` | `putNailPhoto` | `nail-photos.ts` | ✅ Working (owner only; upload/replace, EXIF stripped) |
| `DELETE` | `/api/inventory/{inventoryItemId}/nail-photo` | `deleteNailPhoto` | `nail-photos.ts` | ✅ Working (owner only; 204, idempotent) |
| `GET` | `/api/wishlist-share` | `getWishlistShare` | `wishlist-share.ts` | 🚩 Behind `SHAREABLE_WISHLIST_ENABLED` (auth required) |
| `POST` | `/api/wishlist-share` | `enableWishlistShare` | `wishlist-share.ts` | 🚩 Behind `SHAREABLE_WISHLIST_ENABLED` (auth required) |
| `DELETE` | `/api/wishlist-share` | `revokeWishlistShare` | `wishlist-share.ts` | 🚩 Behind `SHAREABLE_WISHLIST_ENABLED` (auth required) |
| `POST` | `/api/wishlist-share/rotate` | `rotateWishlistShare` | `wishlist-share.ts` | 🚩 Behind `SHAREABLE_WISHLIST_ENABLED` (auth required) |
| `GET` | `/api/wishlist/{token}` | `getPublicWishlist` | `wishlist-share.ts` | 🚩 Behind `SHAREABLE_WISHLIST_ENABLED` (anonymous, rate-limited) |


Background triggers:
- `ingestion-job-worker` (`ingestion-worker.ts`) — Azure Storage Queue trigger for async ingestion jobs.
- `ingestion-ai-batch-poller` (`ingestion-ai-batch-poller.ts`) — Timer trigger that polls Azure OpenAI batch status and applies completed detections.
- `polish-import-session-cleanup` (`polish-imports.ts`) — Hourly timer (`0 23 * * * *`) that deletes expired `polish_import_session` rows (the API already hides them).


All handlers return `Promise<HttpResponseInit>` and accept `(request: HttpRequest, context: InvocationContext)`.

`GET /api/polishes` returns a paginated canonical shade catalog joined with the requesting user's inventory rows. `inventoryItemId` and user-facing fields are undefined when the user has not added that shade yet, but catalog metadata (brand, finish, color hexes, swatch) is still returned so the UI can show "not owned" entries. `swatchImageUrl` is the shade's primary image: its `source_product` swatch when one exists, otherwise its newest swatch. Supported query params include `search`, `brand`, `finish`, `scope` (`all|collection`; `collection` = `status = 'owned'`), `availability` (`all|owned|wishlist`; legacy alias for `status=owned` / `status=wishlist`), `status` (one or comma-separated `owned|wishlist|destash|archived`; 400 on anything else), `untried` (`true|false`; owned and `tried_at IS NULL`), `tags`, `family` (color families, see below), `sortBy` (`status|brand|name|finish|collection|createdAt|rating`; `status` orders owned, wishlist, destash, archived, then catalog-only rows), `sortOrder`, `page`, and `pageSize`. `GET /api/polishes/{id}` looks up a shade by `shade_id` and includes `sourceImageUrls` (all source images associated with that shade's swatches, primary `source_product` image first, then newest first) for the detail page. The list's `total` comes from a `COUNT(*) OVER()` window column on the page query itself (one scan per page, no separate count query); a page past the end falls back to an explicit count. The swatch LATERAL lookup in `POLISH_SELECT` is served by `idx_swatch_shade_latest` (migration `20261016040000000_add-swatch-shade-index`).
**Inventory status (#261, migration `20261017061336791_inventory-status`):** each `user_inventory_item` has `status` (`owned | wishlist | destash | archived`, CHECK-constrained), `tried_at`, `last_worn_at` and `wear_count` (default 0). Ownership is **only** `status = 'owned'` — nothing reads `quantity` to decide ownership or wishlist any more (the migration backfilled `quantity <= 0` → `wishlist`, else `owned`). "Untried" is derived (`status = 'owned' AND tried_at IS NULL`), never stored. List/detail responses add `status` (null when the caller has no inventory row), `isUntried` (false for catalog-only rows), `triedAt`, `lastWornAt`, `wearCount`, `purchasePrice` (number) and `purchaseCurrency`. `POST /api/polishes` and `PUT /api/polishes/{id}` accept, validated in `src/lib/inventory.ts` (400 on bad input, before any write): `status` (exactly one of the four values), `triedAt` (ISO-8601 date or date-time with zone, not in the future), `purchasePrice` (number, 0–99,999,999.99, at most 2 decimals) and `purchaseCurrency` (3-letter ISO 4217 code, upper-cased). For `triedAt`, `purchasePrice` and `purchaseCurrency`, omitting the field keeps the stored value and `null` clears it. Omitting `status` keeps the stored status on an existing row; a **new** row defaults to `owned` when `quantity > 0` and `wishlist` otherwise (same rule as the backfill, so clients that only send `quantity` behave as before), and an omitted `quantity` on a new row defaults to 1 for `owned`/`destash` and 0 otherwise. `lastWornAt` / `wearCount` are read-only in this API: the mani log (below) derives them, and `POST`/`PUT /api/polishes` re-derive them for the written row (so a polish removed and re-added picks its wear history back up) without touching `tried_at`. Other write paths: Rapid Add capture inserts `owned` rows and flips a `wishlist`/`archived` row to `owned` when it adds a bottle; ingestion materialization inserts `wishlist` rows (`quantity = 0`); the admin account merge keeps the strongest status either account had for the shade (`owned` > `destash` > `wishlist` > `archived`, so a destash bottle is never downgraded to wishlist), the earliest `tried_at`, the latest `last_worn_at` and the summed `wear_count`, and moves the source account's manicures to the target (`mergedManicureRows`), which is what those merged stats derive from.

**Mani log (#269, migration `20261017063740704_manicure-log`):** `manicure` (one row per logged manicure: `user_id`, `worn_on DATE`, `notes` ≤ 2000 chars, optional `photo_image_id` → `image_asset`) and `manicure_polish` (`shade_id`, `role` `base|color|accent|topper|other`, `position`; unique per manicure + shade + role). Polishes are keyed by `shade_id` because `user_inventory_item` is unique per `(user_id, shade_id)`; removing a polish from the collection keeps its history. `inventory_event.manicure_id` (FK, `ON DELETE CASCADE`) ties the `used` events the log writes to their manicure.
- `POST /api/manicures` body (`ManicureCreateRequest`): `{ wornOn?: "YYYY-MM-DD" (default today UTC; clients send the user's local date; not after tomorrow UTC, not before 1900-01-01), notes?, photoImageId?, polishes: [{ shadeId | inventoryItemId, role? (default color) }] }` with 1–20 polishes; array order is `position`. `PUT`/`PATCH /api/manicures/{id}` take the same fields, all optional (`ManicureUpdateRequest`): omitted fields are kept, `null` clears `notes`/`photoImageId`, and `polishes` replaces the whole list. Responses (`ManicureMutationResponse`) are the manicure plus `wearStats` (`shadeId`, `inventoryItemId`, `wearCount`, `lastWornAt`, `triedAt`) for every affected inventory row; `DELETE` returns `{ message, id, wearStats }`. `GET /api/manicures` lists newest first (`worn_on DESC, manicure_id DESC`) with `from` / `to` (inclusive dates), `shadeId` (manicures that include the shade), `page` (default 1) and `pageSize` (default 50, max 200) → `ManicureListResponse` `{ manicures, total, page, pageSize }`; `GET /api/manicures/{id}` returns one. Each polish carries brand, name, hexes, role, position and the caller's current `inventoryItemId` (null after removal). Not cached.
- **Wear stats are derived, not counted up and down.** Each write runs in one transaction: lock the manicure (edit/delete) and the caller's affected inventory rows (`FOR UPDATE`, id order, so concurrent logs for one polish serialize and each recomputation sees the other's rows), write the manicure, then for every affected shade (old ∪ new on edit) set `wear_count` = number of the user's manicures with that shade, `last_worn_at` = latest `worn_on` (midnight UTC; NULL when none) and fill `tried_at` from the earliest `worn_on` **only when it is NULL** (the mani log never clears or moves an existing `tried_at`). Then the manicure's `inventory_event(used)` rows are synced: one per inventory row with payload `{ source: "manicure", manicureId, wornOn, roles }`; events of dropped polishes are deleted, kept ones get the new payload, new ones are inserted; deleting the manicure cascades its events. The caller's polish list/detail caches are invalidated for the affected shades.
- **Access control:** `withAuth`; every statement is bound to the caller's `user_id`. Polishes must be in the caller's inventory (any status; `shadeId` or `inventoryItemId`, resolved with `user_id = caller`); anything else — another user's item, an unknown id, a catalog shade the caller does not hold — is `404 "polishes[i] is not in your collection"`, checked before any write. On edit, a shade already on that manicure stays referenceable after the caller removed it from the collection. `photoImageId` must be an `image_asset` with `owner_type = 'user' AND owner_id = caller` (else `404 "Photo not found"`); `photoUrl` is minted as an owner-scoped `v3` id, and only for a blob in `USER_MEDIA_CONTAINER` (or the catalog container), otherwise null. Another user's manicure is `404` for get/edit/delete. Bad ids, dates, roles, a duplicate shade + role pair, or an empty update are `400`. No upload endpoint exists yet: photos arrive with #270.

**Multi-finish contract (#43):** polish list/detail responses include `finishes: string[]` (all canonical finishes for the shade, primary first) alongside the legacy `finish` string. `finish` stays populated for older consumers: it is the shade's stored `finish` column (its identity/dedup key) and falls back to `finishes[0]` when that column is empty. Filters: `finish=<value>` matches shades that have the finish anywhere in `finishes` *or* as the legacy `finish`; `finishes=a,b` matches shades with ANY of the listed finishes; both accept aliases (`holo`, `cream`, …). `sortBy=finish` sorts by the primary finish. `POST /api/polishes` and `PUT /api/polishes/{id}` accept `finishes` (explicit list → replaces the shade's finishes; `[]` clears) in addition to `finish` (legacy → merged), but these only reach the catalog under the **catalog write rule** below: they are stored when the request creates the shade, and are ignored when it adopts, matches or updates an existing shared shade. Request `tags` are the caller's personal inventory tags and are **never** used to change finishes (a tags-only request leaves them untouched; only ingestion connectors parse finishes from product tags). Unknown values are ignored; a value is accepted when it is (or aliases to) a `finish_type` row, including types added through the admin UI. When only `finishes` is sent, the legacy `finish`/identity key defaults to `finishes[0]`.
When `REDIS_URL` + `REDIS_KEY` are configured, list/detail reads are served through a Redis read-through cache (short TTL), and create/update/delete/recalc writes invalidate related user and catalog cache keys.
For private blob storage, the API rewrites blob URLs to `/api/images/{id}` so image bytes are served through Functions (no public container access or client-side SAS required).

**CSV / spreadsheet import (#263, migration `20261017064132576_polish-import-session`):** three steps, all `withAuth`, and every `polish_import_session` query filters on the caller's `user_id` (another user's session is a 404, never a 403).
1. **Upload + match** — `POST /api/polish-imports` with `PolishImportCreateRequest` `{ csv, fileName?, mapping?, headerRowIndex? }`. `csv` is the file's text (max 1 MB, 1000 data rows, 100 columns; 413 / 400 beyond). The shared parser (`swatchwatch-shared` `parseCsv`) handles a BOM, quoted fields with `""` escapes, embedded delimiters/newlines, CRLF/LF/CR, an Excel `sep=` line and `,` `;` tab `|` auto-detection. Without `mapping` the header row is detected among the first 10 records (`detectPolishImportHeader`: common spreadsheet names, case/space/punctuation-insensitive, camelCase, including the collection export's headers; identifier columns such as `Shade ID` / `Display hex` are ignored); 422 when brand + shade name columns can't be found (the web wizard then asks for a mapping). Cells (`lib/polish-import.ts`): finishes split on `/ , + &` and canonicalized through `loadFinishCatalog()` (unknown finishes → row warning), quantity, price (`$9.50`, `12,50 €`, `1,234.50`; `€ £ ¥ ₩ ₹` imply a currency, `$` does not), currency, dates (ISO, `M/D/Y` or `D/M/Y` decided per column, month names), status synonyms → `PolishStatus`, tried (yes/no or a date). Prices, currencies and dates also pass the #261 `parseInventoryFields` validation; an unusable cell is dropped with a row `warning`, a missing brand or name makes the row `invalid`. A leading `'` before `= + - @` (spreadsheet formula guard) is stripped. Matching is batched (≤ 3 `pg_trgm` queries per upload, never one per row): candidate brands per distinct sheet brand (`similarity` on `brand.name_canonical` + `brand_alias`), then shades of those brands for all rows in one `unnest` + `LATERAL` query (`shade_name_canonical` / `shade_alias`), then a brand-less name search for rows whose brand matched nothing. Only shades visible to the caller are candidates (shared catalog rows, their own `user_submitted` shades, or shades in their inventory). Confidence = 0.35 × brand similarity + 0.65 × name similarity (exact case/punctuation-insensitive names count as 1) ± 0.05 for finish agreement. A row is `matched` when exactly one candidate has the exact brand + name (or the row's finish picks one of several), or when the best score is ≥ 0.9 and 0.08 ahead of the runner-up; `ambiguous` at ≥ 0.45; else `unmatched`. Returns `201` + `PolishImportSession` (rows with `values`, `warnings`, `errors`, up to 5 `candidates` with display hex / `inCollection` / `userSubmitted` / `exactMatch`, and the default `action`: `match` for matched rows, `pending` otherwise). The caller keeps at most 10 sessions; sessions expire after 24 h.
2. **Review** — `PATCH /api/polish-imports/{id}` with `{ decisions: [{ rowNumber, action: "match" | "create" | "skip", shadeId? }] }` stores decisions (400 for an unknown row, a non-skip decision on an invalid row, or a malformed body; 409 once committed). A `shadeId` that is not one of the row's candidates (e.g. picked from catalog search) must be visible to the caller (404 otherwise) and is appended to the row's candidates.
3. **Commit** — `POST /api/polish-imports/{id}/commit` (optional `{ decisions }`, applied first) runs in one transaction with the session row locked and a savepoint per row: `match` rows upsert inventory through `upsertInventoryItem` (keyed on `(user_id, shade_id)`), `create` rows go through `findOrCreateShade` (reusing the caller's existing private shade or an exact catalog shade, else creating a `user_submitted` shade with the canonical finishes; the brand reuses a candidate's spelling when it matches), `skip`/`pending`/`invalid` rows are skipped, and a second row resolving to the same shade is skipped as a duplicate. Blank cells are never sent, so re-importing never clears stored values; a **new** inventory row without a status column defaults to `owned` (`wishlist` when the sheet says quantity 0), an existing row keeps its status; `tried = yes` keeps an existing `tried_at` and otherwise uses the sheet's tried date, the purchase date, or today; `tried = no` clears it. Shared catalog shades are never modified by an import: `findOrCreateShade` writes catalog finishes only when it creates the shade or for the caller's own `user_submitted` shade (catalog write rule, #224). Response `PolishImportCommitResponse` `{ session, result: { created, updated, skipped, failed, shadesCreated }, alreadyCommitted }`; per-row `outcome` / `outcomeMessage` land on the session rows. A failing row is reported as `failed` and the rest still commit. Committing again returns the stored result (`alreadyCommitted: true`) without writing. Re-uploading the same sheet matches the shades the first import used or created, so its commit reports `updated`, never duplicates. A 200-row sheet parses + matches in ~0.2 s and commits in ~0.6 s against the local dev DB.

Access control (issue #47):
- Every user-data route (`/api/polishes*`, `/api/inventory/*`, `/api/manicures*`, `/api/polish-imports*`, `/api/capture/*`, `/api/voice`, `/api/wishlist-share*`) is wrapped in `withAuth`, and every query is scoped to the caller's `user_id` (inventory upserts/deletes key on `(user_id, shade_id)`; capture sessions are looked up by `capture_uuid` **and** `user_id`, and questions/answers/frames hang off that session). Admin/ops routes (`/api/ingestion/*`, `/api/reference-admin/*`, `/api/users-admin*`, `/api/shades-admin/*`, `/api/polishes/{id}/recalc-hex`) use `withAdmin`. Only `/api/auth/*`, `/api/catalog/*`, `/api/reference/*`, `/api/images/{id}` and `/api/wishlist/{token}` are anonymous, and none of them return per-user data anonymously except the shared wishlist, which the owner opted into (behind `SHAREABLE_WISHLIST_ENABLED`; see below): `/api/images/{id}` is anonymous for public catalog (`v2`) ids and requires the owner's bearer token for private (`v3`) ids.
- **Catalog write rule (#224, decision 1b):** a user request writes catalog fields (`finish`/`finishes` and the color fields `color`, `vendorHex`, `detectedHex`, `nameHex`) to a shade **only when the request creates that shade** (`POST`, or `PUT` with a new brand + name). Adopting a shade by id, matching an existing shade by brand + name, or updating one by id never modifies its `finishes`, `finish` or colors, not even to fill an empty value; the request still succeeds and only the caller's inventory row is written. Catalog data on existing shades is owned by ingestion and admin tooling (e.g. `recalc-hex`). The one exception is the caller's own private `user_submitted` shade: its creator may keep correcting it (`finishes` replace/merge, provided colors replace stored ones). `shade.finish` (the dedup key) is never changed after creation.
- Shades created through `POST/PUT /api/polishes` start as `status = 'user_submitted'` with `created_by_user_id` (migration 024) and are private until an admin promotes them (sets `status = 'active'`; no approval endpoint yet). A `user_submitted` shade is visible only to its creator and to users holding it in their inventory: it is excluded from other users' polish list/count/detail (`GET /api/polishes*`), `polishes/match-image`, `GET /api/catalog/shade/{id}` (404) and catalog search/capture matching (`status = 'active'` only). Adopting such a shade by id (`POST shadeId`, `PUT /polishes/{id}`, capture `candidate_select`) returns 404. A brand + name that only matches another user's private shade creates the caller's own row (idx_shade_unique includes the NULL `product_line_id`, so it does not block this). Ingestion promotes a matching `user_submitted` shade to `active`. New brand rows are still created immediately.
- Account linking: a new external identity links to an existing `app_user` by email only when the token proves the email is verified (`email_verified` true or Entra `xms_edov` true). Otherwise a separate user is created with no stored email and `auth.email_link_skipped` is tracked. Identities already linked (by `external_id`) are unaffected.
- `PUT /api/polishes/{id}` with an unchanged `brand` + `name` edits that shade in place (including a finish-only change); a different brand or name resolves to (or creates) the matching shade instead.
- `POST /api/capture/{captureId}/frame` with an `imageId` only accepts image assets owned by the caller (`image_asset.owner_type='user' AND owner_id=<caller>`); anything else returns `404`.
- `GET /api/images/{id}` is `authLevel: "anonymous"` and serves two id scopes, both minted only by the API (`src/lib/image-proxy.ts`). Each id carries an HMAC-SHA256 signature (key `IMAGE_PROXY_SIGNING_KEY`) over its version, expiry, owner (`v3` only) and storage URL, so none of these can be changed without the key. The scope is chosen at mint time from the URL: blobs in the catalog container (`SOURCE_IMAGE_CONTAINER`, `isCatalogStorageUrl` in `src/lib/blob-storage.ts`) get public ids, everything else gets a private id or nothing.
  - **Public** (catalog imagery): `v2.<base64url(storageUrl)>.<exp base36>.<base64url(HMAC(key, "swatchwatch:image-proxy:v2:" + exp + ":" + storageUrl))>`. Served to anyone, because catalog images are rendered in `<img src>` and fetched anonymously by Azure OpenAI vision (`INGESTION_AI_IMAGE_PROXY_ORIGIN`). Ids stay valid for at least `IMAGE_PROXY_ID_TTL_SECONDS` (default 3 days, well past the 24h Azure OpenAI batch window) and are bucketed to day boundaries so the same image keeps a stable, cacheable URL.
  - **Private** (user media): `v3.<base64url(storageUrl)>.<exp base36>.<ownerUserId base36>.<base64url(HMAC(key, "swatchwatch:image-proxy:v3:" + exp + ":" + ownerUserId + ":" + storageUrl))>`. Minted only for blobs outside the catalog container, and only for a caller who owns the `image_asset` row (`owner_type = 'user' AND owner_id = <caller>`): polish detail reads each image's `image_asset` owner and omits (`null`) any non-catalog image the caller does not own, and any image outside both `SOURCE_IMAGE_CONTAINER` and `USER_MEDIA_CONTAINER` (it could never be served). Ownership is decided at mint time; the read path does no DB lookup beyond authentication. Ids stay valid for at least `IMAGE_PROXY_PRIVATE_ID_TTL_SECONDS` (default 3600, clamped 300–86400) and are bucketed to 15 minutes. Serving one requires a valid `Authorization: Bearer` token whose user id equals the bound owner: no or invalid token → `401 {"error":"Unauthorized"}`, another user → `403 {"error":"Forbidden"}`. `<img>` cannot send the header, so clients fetch private ids with the bearer token and render the bytes themselves (web: `PrivateImage` / `usePrivateImage`); there is no cookie auth. Every non-200 response for a private id (401, 403, 404, 5xx) carries `Cache-Control: no-store`. The caller is resolved read-only (`authenticateRequestReadOnly` in `src/lib/auth.ts`): the JWT is verified as usual but the user is only looked up (linked identity, then legacy `app_user.external_id`), never created or updated, so a page of N private photos costs N reads instead of N `getOrCreateUser` write transactions; an identity without a user yet gets `401`. Private media today is the per-item nail photo (#270, below).
  - Unsigned, forged, tampered, or expired ids of either version return `403 {"error":"Forbidden"}` before any auth check or storage call. Legacy non-expiring v1 ids are never minted, are treated as public, and are rejected unless `IMAGE_PROXY_LEGACY_ID_ACCEPT_UNTIL` is set to a future timestamp (rollout grace window; each acceptance emits `image_proxy.legacy_id_accepted`).
  - Container allowlist by scope: the decoded URL must be a plain blob URL (no query string/credentials) on the configured storage account, inside `SOURCE_IMAGE_CONTAINER` for public ids or `USER_MEDIA_CONTAINER` (default `nail-photos`) for private ids, otherwise `403`. A validly signed id can never read the other container. The two containers must differ: if `USER_MEDIA_CONTAINER` equals `SOURCE_IMAGE_CONTAINER`, nothing is minted and private reads return `500` (`ImageProxyConfigError`), rather than user media being treated as public catalog imagery.
  - Minting fails closed: a non-catalog URL without an owner throws `ImageProxyScopeError` instead of producing a public id, and polish responses omit such images rather than leak a URL.
  - Ids are deterministic per URL+key+expiry bucket (plus owner for `v3`), so rotating `IMAGE_PROXY_SIGNING_KEY` invalidates every previously issued public and private image URL (clients pick up new ones on the next API read; Redis-cached polish responses expire within ~90s).
- If `IMAGE_PROXY_SIGNING_KEY` is missing, signing fails closed: polish responses omit proxied image URLs (`swatchImageUrl: null`) and `/api/images/{id}` returns `500` — unless dev bypass is active (`AUTH_DEV_BYPASS=true` and not hosted in Azure), in which case an ephemeral per-process key is generated (with a warning) for local development.
- Image proxy caching: public catalog ids are served `Cache-Control: public` (honoring the blob's own max-age). Private `v3` responses get `Cache-Control: private, max-age=<min(300, remaining id lifetime)>` with no `stale-while-revalidate`, plus `Vary: Authorization`. `max-age` never exceeds the id's remaining lifetime.
- `AUTH_DEV_BYPASS` fails closed when hosted in Azure (`WEBSITE_INSTANCE_ID` set, or a non-loopback `WEBSITE_HOSTNAME`; Core Tools' `localhost:7071` still counts as local). In that case the flag is ignored, a one-time error is logged plus an `auth.dev_bypass_refused` event, and `dev:*` tokens go through JWT validation (401). There is no override.
- `POST /api/capture/{captureId}/frame` `imageBlobUrl` accepts only a base64 `data:image/*` URL or a plain `https://` blob URL on the configured storage account (`AZURE_STORAGE_CONNECTION`) inside `SOURCE_IMAGE_CONTAINER`, with no credentials, port, query string or fragment. `http:`, other hosts and SAS URLs are rejected with `400`, as are all remote URLs when no storage account is configured. The URL is validated even when `imageId` is also sent, so only validated input reaches Document Intelligence / Azure OpenAI.

**Shareable wishlist (#268, migration `20261017064751368_wishlist-share`)** — an opt-in, revocable, read-only public page for the owner's `status = 'wishlist'` items. The whole feature is behind the server flag `SHAREABLE_WISHLIST_ENABLED` (default `false`, pending roadmap §6 decision 2): while it is off, every route above answers `404 { "error": "Shareable wishlists are not enabled", "code": "feature_disabled" }` before auth and before any SQL. The web share card calls `GET /api/wishlist-share` and hides itself on that response, so flipping the flag is the only switch (no web build variable).
- **Owner routes** (`withAuth`, every statement keyed by the caller's `user_id`; one row per user, `UNIQUE (user_id)`): `GET` returns `WishlistShareStatus` (`enabled`, `token`, `path` = `/w/?token=…`, `displayName`, `wishlistCount`, `hiddenCount`, `createdAt`, `rotatedAt`). `POST` body `{ displayName?: string | null }` enables the link (idempotent: an existing link keeps its token) and sets the optional public name (trimmed, ≤ 60 chars, email-looking values rejected with 400; omit the field to keep the stored name). `POST /rotate` replaces the token (404 when there is no link). `DELETE` revokes it by deleting the row (idempotent, 200). Rotation and revocation take effect on the next public request; nothing is cached server-side.
- **Token design (HMAC-derived, hash-stored):** `token = base64url(HMAC-SHA256(k, "<user_id>:<token_salt>"))` (32 bytes, 43 chars), with `k = deriveSigningSubkey("wishlist-share:v1")` (`HMAC(IMAGE_PROXY_SIGNING_KEY, "swatchwatch:subkey:wishlist-share:v1")`, `src/lib/image-proxy.ts`) and a random 16-byte `token_salt`. Only `token_hash = hex(SHA-256(token))` and the salt are stored; the raw token never is. The owner endpoint re-derives the token on demand (so "copy link" keeps working), but a database leak alone (salt + hash) cannot be replayed without the server key. If `IMAGE_PROXY_SIGNING_KEY` rotates, existing links keep resolving (lookup is by hash) but `token` comes back `null` and the owner must rotate to copy a link again. Code: `src/lib/wishlist-share.ts`.
- **Public route** `GET /api/wishlist/{token}` (anonymous): looks the share up by `token_hash` and returns `PublicWishlistResponse` = `{ displayName, items: [{ brand, name, finishes, hex, imageUrl }] }` — an explicit allowlist (no user id, email, handle, ids, notes, prices, quantities, ratings, tags or dates). Items are the owner's `status = 'wishlist'` rows on shared-catalog shades only: the owner's own `user_submitted` shades stay hidden (reported to the owner as `hiddenCount`). `hex` follows `resolveDisplayHex` (vendor > detected > name). `imageUrl` is a public `v2` image-proxy URL and only for blobs in the catalog container; private media, other containers and external URLs are omitted, never minted as `v3`. At most 500 items, ordered by brand then shade. There is no buy-from-brand URL (no such shade field exists yet). Headers: `Cache-Control: private, max-age=60` (browser-only, so a shared cache cannot keep serving a revoked list), `X-Robots-Tag: noindex, nofollow, noarchive`, `Referrer-Policy: no-referrer`; 404/429 responses are `no-store`. Unknown, malformed, rotated and revoked tokens all return the same `404 { "error": "Wishlist not found" }`.
- **Rate limiting** (`src/lib/rate-limit.ts`): in-memory token buckets per Functions instance, checked before any DB access — per client IP (right-most `X-Forwarded-For` entry, port stripped): burst 30, then 1 request / 2 s; per token (keyed by its SHA-256, across all IPs): burst 60, then 1 request / s. Over the limit → `429 { "error": "Too many requests" }` with `Retry-After` (seconds). Best effort only: buckets are per instance and reset on cold start (Redis is not wired for this); the 256-bit token is what actually prevents guessing.
- Telemetry: `wishlist_share.enabled|rotated|revoked|viewed|rate_limited` (no token, no user data). The host's own request telemetry still records the request path; the web client redacts tokens from its telemetry (`apps/web/src/lib/telemetry.ts`).
- Account merge (`/api/users-admin/merge`) deletes the source user, which cascades to (revokes) the source's share; the target's link keeps working and now shows the merged wishlist.

Error responses: unexpected `500`s return only a generic message and a correlation id, `{ "error": "Failed to …", "requestId": "<invocationId>" }`. The full error (including Postgres messages) is logged server-side via `context.error` and `trackException` (`src/lib/errors.ts` → `internalServerError()`), never sent to the client.
`POST /api/polishes/{id}/recalc-hex` is admin-only, fetches the shade's primary swatch image (the `source_product` swatch, falling back to the newest swatch), runs Azure OpenAI hex detection, updates `detected_hex` plus its provenance columns (always overwriting), and returns a 200 with the detected hex and confidence (or a 422 if no image is available for detection). The response also carries `method`, `model` (deployment), `promptVersion`, `vendorHex`, `previousHexAgreement` and `hexAgreement`. Responses now also include `tokenUsage` (`promptTokens`, `completionTokens`, `totalTokens`) when Azure returns usage metadata. Vendor context is derived from shade metadata (for example `finish`) so the endpoint does not depend on source-specific external IDs.

**Detected-hex provenance (migration 20261017024958000_shade-detected-hex-provenance).** Every write of `shade.detected_hex` also records `detected_hex_confidence` (model-reported 0–1, `NUMERIC(4,3)`), `detected_hex_method` (`vision-direct` today; `palette-pick`/`region-crop`/`ensemble` reserved for the strategies in `src/eval/hex/`; `client-supplied` when a user `POST`/`PUT /api/polishes` request creates a shade with a `detectedHex`, or the creator corrects their own `user_submitted` shade), `detected_hex_model` (Azure OpenAI deployment name), `detected_hex_prompt_version` (`PROMPT_VERSION` in `src/lib/ai-color-detection.ts`; bump it when the prompt changes) and `detected_hex_at`. Write paths: the ingestion sync shade update and `applyAiBatchShadeDetections` (batch poller and batch-submit fallback) in `src/lib/ingestion-repo.ts`, `recalc-hex`, and the user backfills in `polishes.ts`; all SQL goes through `src/lib/hex-provenance.ts`. `overwriteDetectedHex` semantics are preserved: when not overwriting, provenance is only filled if `detected_hex` was NULL before. For batch jobs the deployment and prompt version are captured at submit time (`deployment` / `promptVersion` on each `metrics.aiBatches` entry) so results are stamped with what actually produced them; older jobs fall back to the model id echoed in the batch output and the current `PROMPT_VERSION`. `shade.hex_agreement` is a STORED GENERATED column, `hex_oklab_distance(vendor_hex, detected_hex)` (Postgres functions `hex_to_oklab`/`hex_oklab_distance`, mirroring `colorDistance` in swatchwatch-shared, rounded to 4 decimals), so it is current after any write and NULL unless both hexes are valid. Polish list/detail responses expose `detectedHexConfidence`, `detectedHexMethod`, `detectedHexModel`, `detectedHexPromptVersion`, `detectedHexAt` and `hexAgreement`.

`GET /api/polishes-admin/hex-review` (admin-only) is the review queue for weak detections: shades with a `detected_hex`, ordered by `sort=agreement` (default; largest vendor↔detected OKLAB distance first, shades without a vendor hex last) or `sort=confidence` (lowest confidence first, unrecorded last). Query: `page` (default 1), `pageSize` (default 50, max 200), `flaggedOnly=true` (only `hex_agreement > 0.10`, the MEDIUM threshold), `method`, `promptVersion`, `brand` (substring). Response (`HexReviewResponse`): `{ items, total, page, pageSize, sort, disagreementThreshold }`; each item has the three hexes, the provenance fields, `hexAgreement`, and `displayHex`/`displaySource`/`flagged` from `resolveDisplayHexDetailed()`. Re-run a bad row with `recalc-hex`. Not cached.

`POST /api/polishes/match-image` (authenticated) matches a photo against the **caller's owned polishes** (`status = 'owned'`). Body (`PolishImageMatchRequest`): `{ image: "data:image/<type>;base64,…", maxColors?: 1–10 (default 6), limit?: 1–50 (default 20) }` — the same base64 data-URL convention as capture frames and the same upload policy (5 MB decoded, JPEG/PNG/WebP/GIF/HEIC/HEIF MIME allowlist). Bodies larger than the base64-encoded 5 MB limit are rejected with 413; missing/invalid images, non-image MIME types, undecodable bytes, images over 40 MP, and out-of-range options return 400. The handler decodes the image in memory with `sharp`, extracts dominant colors (`lib/dominant-color.ts`), merges perceptually near-duplicate colors (OKLAB < 0.04) and drops colors under 1% of pixels, then scores each owned polish's display hex (`vendorHex > detectedHex > nameHex`) by its minimum OKLAB distance to any extracted color. Response (`PolishImageMatchResponse`): `{ extractedColors: [{ hex, fraction }], matches: [{ polish, matchedColor, distance, confidence }], candidateCount }`, sorted by ascending distance. `confidence` comes from `confidenceForDistance()` (`high` ≤ 0.05, `medium` ≤ 0.10, else `low`; tune via `HIGH_CONFIDENCE_MAX_DISTANCE` / `MEDIUM_CONFIDENCE_MAX_DISTANCE`, defined in swatchwatch-shared `color/thresholds.ts` and re-exported from `src/lib/color-match.ts`). **Privacy:** the image is never persisted — not to blob storage, the database, Redis, or logs — and responses are not cached.
Image uploads now enforce a shared validation policy (`maxSizeBytes=5MB`; allowed mime types: `image/jpeg`, `image/png`, `image/webp`, `image/heic`, `image/heif`, `image/gif`) used by capture-frame data URLs and source-image ingestion; uploads outside these limits are rejected with a 400. All uploaded image bytes are auto-oriented and metadata-stripped with `sharp` (removing EXIF/GPS and other embedded metadata) before any checksum generation, persistence, or forwarding to AI/OCR services. This applies to both source-image ingestion (before blob upload) and capture-frame data URLs (`quality_json.ingestion.exifStripped` records whether stripping ran). `sharp` failures degrade gracefully to the original bytes.

Reference endpoints:
- `GET /api/reference/finishes` and `GET /api/reference/harmonies` are public read endpoints for UI lookup data, sorted by `sort_order` and served with cache headers.
- Admin CRUD endpoints under `/api/reference-admin/finishes` and `/api/reference-admin/harmonies` manage reference data and update audit columns (`updated_at`, `updated_by_user_id`) on writes.
- **In-use finish types cannot be deleted (#224, decision 2a).** `DELETE /api/reference-admin/finishes/{id}` checks usage and deletes in one statement. When any shade still uses the finish type (in `shade.finishes` or the legacy `shade.finish`, compared case-insensitively) or any `finish_normalization` alias maps to it, nothing is deleted and the response is `409` with a `FinishTypeInUseResponse` body: `{ "error": "Cannot delete finish \"Chrome\": it is still used by 12 shades and 1 finish normalization. Remove it from those shades and delete or repoint its normalizations first.", "code": "FINISH_TYPE_IN_USE", "finishTypeId": 7, "name": "chrome", "shadeCount": 12, "normalizationCount": 1 }`. The `/admin` Configuration tab shows `error` in the delete dialog. Caches (including the in-process finish catalog) are only cleared when a row is actually deleted, so a refused delete leaves them valid. A `404` means the id does not exist.
- **Renaming a finish type cascades atomically.** `PUT /api/reference-admin/finishes/{id}` with a changed `name` runs in one transaction: it locks the `finish_type` row; answers `409` with a `FinishTypeNameTakenResponse` (`{ "error": "Cannot rename finish \"Chrome\" to \"Glitter\": finish type \"glitter\" already exists.", "code": "FINISH_TYPE_NAME_TAKEN", "finishTypeId": 7, "name": "Chrome", "requestedName": "Glitter", "conflictingFinishTypeId": 3, "conflictingName": "glitter" }`) when another finish type has the same name ignoring case and extra spaces, changing nothing; updates `finish_type.name` and repoints every `finish_normalization` row that targets the old name in **one statement** (the `normalized_finish_name` FK has no `ON UPDATE CASCADE` and is not deferrable, so separate statements fail, which was the old `500`); then, when the finish key changes, rewrites `shade.finishes` and `shade.detected_finishes` (case-insensitive match, array order kept, duplicates dropped; a shade with an empty `finishes` whose legacy `finish` is the old name gets `finishes = {new}`) and adds a `finish_normalization` alias old name → new name unless that spelling already has an alias. The legacy `shade.finish` is **not** rewritten: it is the raw vendor value and part of the shade dedup key (`idx_shade_unique`, ingestion shade matching), so rewriting it would make the next ingestion run create duplicate shades. The alias keeps that value, vendor tags with the old spelling and other instances' stale catalog caches resolving to the new name. A case-only rename (`Chrome` → `chrome`) is allowed: it repoints normalizations and leaves shades alone (they store lowercase keys). The `200` body is a `FinishTypeUpdateResponse`: the finish type plus `rename: { previousName, shadeCount, normalizationCount, aliasCreated }`. Reference, catalog and polish caches are cleared only after the commit. Matching is case-insensitive, so the shade rewrite scans `shade` once instead of using `idx_shade_finishes`. That is fine for an admin action at catalog scale; `shade` has no triggers, and stored generated columns recompute on the rewrite. The `/admin` Configuration edit dialog shows the result or the `409` message.
- Admin CRUD endpoints under `/api/reference-admin/finish-normalizations` manage aliases and misspellings used to normalize AI/vendor finish strings into canonical `finish_type.name` values.
- `GET /api/catalog/search` results and `GET /api/catalog/shade/{id}` include `finishes: string[]` next to the legacy `finish`.

**Color family filter (#103, migration 20261017061637910_add-shade-color-family).** `GET /api/polishes?family=red,pink` and `GET /api/catalog/search?q=…&family=red,pink` return only shades in ANY of the listed families: `red`, `pink`, `coral`, `orange`, `yellow`, `green`, `teal`, `blue`, `purple`, `nude`, `brown`, `grey` (`gray` accepted), `black`, `white`, `multichrome`. Values are comma-separated and/or repeated (`family=red&family=pink`), case-insensitive; an unknown family is a 400 (not silently ignored). Shades with no usable hex have no family and never match a family filter. The family is the STORED GENERATED column `shade.color_family = shade_color_family(vendor_hex, detected_hex, name_hex, finishes, finish)` (indexed by `idx_shade_color_family`): `multichrome` for color-shifting finishes, otherwise OKLCH bins of the display hex (vendor > detected > name). It mirrors `classifyColorFamily()` in swatchwatch-shared; `tests/color-family.unit.test.cjs` parses the migration's threshold `CONSTANT`s and multichrome finish list and fails if they drift from `COLOR_FAMILY_THRESHOLDS` / `MULTICHROME_FAMILY_FINISHES` (set `COLOR_FAMILY_SQL_TEST_DATABASE_URL` to a migrated database to also compare the bins row for row). Because the filter is a plain `WHERE s.color_family = ANY($n)`, pagination, the `COUNT(*) OVER()` total and the page-past-the-end fallback count all stay correct. Polish list/detail responses and catalog search results expose it as `colorFamily` (null when unclassifiable). Changing a bin needs a new migration that redefines `shade_color_family_from_hex()` and rewrites the rows (`UPDATE shade SET finish = finish`) so the stored column is recomputed.

### "Buy from brand" links (#267, `src/lib/buy-link.ts`)

Polish list rows and detail (`GET /api/polishes`, `GET /api/polishes/{id}`, so catalog, collection and wishlist rows alike), `GET /api/catalog/search` results and `GET /api/catalog/shade/{id}` carry an optional `buyUrl`: the brand's product page, taken from the URL the connector stored (`external_product.normalized_json ->> 'productUrl'`; Shopify sources build `https://<store>/products/<handle>`, MakeupAPI uses `product_link`, OpenBeautyFacts stores none). Shades reach their products through `shade_source_product` (migration `20261017061344201_add-shade-source-product`), which ingestion writes (`recordShadeSourceProduct`) every time it materializes a shade from a product, bumping `last_seen_at`. The key is **absent** when the shade has no stored URL or only unsafe ones, so clients render no link.

- **Validation (server-side, `sanitizeBuyUrl`)**: only absolute `http://`/`https://` URLs with a host reach the client. Any other scheme (`javascript:`, `data:`, `vbscript:`, `file:`, `ftp:`, `mailto:` …), relative or protocol-relative URLs, URLs with embedded credentials (`https://user:pass@…`), URLs containing whitespace/control characters, and URLs over 2048 characters are dropped. The returned value is the normalized `URL.href`.
- **Selection when a shade has several source products (`selectBuyFromBrandUrl`)**: ignore candidates whose URL fails validation; prefer a product whose `data_source.enabled` is true; then the most recent `shade_source_product.last_seen_at`; then the most recent `external_product.fetched_at`; then the highest `external_product_id`. The result does not depend on row order.
- **No affiliate parameters.** `applyAffiliateParams(url)` is the single (currently no-op) hook where they would be added; its output is re-validated.
- Lookups run as one extra query for the shades on the returned page only (`ANY($1::bigint[])`), after the main query, so the list SQL itself is unchanged. A lookup failure (for example before the migration has run) is logged as a warning and the response simply has no `buyUrl` values.
- Clients must render the link with `target="_blank" rel="noopener noreferrer nofollow"` (`OUTBOUND_LINK_TARGET` / `OUTBOUND_LINK_REL` in swatchwatch-shared).

### Private nail photos (`src/functions/nail-photos.ts`, #270)

One private on-nail photo per inventory item, linked by `inventory_nail_photo` (migration `20261017062948506_inventory-nail-photo`; PK `inventory_item_id`, `image_id` → `image_asset`).

- **Ownership:** every statement joins `user_inventory_item` with `ui.user_id = <caller>`. Another user's item (or a nonexistent one) is `404` before the body is read, any image is decoded, or storage is touched. Admins get no bypass.
- **Upload (`PUT`):** JSON body `{ "image": "data:image/jpeg;base64,…" }` (`NailPhotoUploadRequest`). Accepted declared types: `image/jpeg`, `image/png`, `image/webp`, `image/heic`, `image/heif` (`415` otherwise); decoded size ≤ `NAIL_PHOTO_MAX_UPLOAD_BYTES` (8 MB, `413`). A `Content-Length` is required (`411` without one, e.g. chunked uploads; `400` if malformed) and must be within the limit, and the body read itself stops at the limit (`413`) even if the stream is longer than declared; the base64 length is checked again before decoding. `src/lib/nail-photo-image.ts` (sharp, already a dependency) sniffs the real format (JPEG/PNG/WebP/HEIF only, `415` for anything else, including GIF/TIFF/SVG and HEIC variants the bundled libvips cannot decode), caps decoded pixels at 36 MP (`NAIL_PHOTO_MAX_INPUT_PIXELS`, ~108 MB decoded RGB; checked from the image header before decoding, `413`), runs at most 2 decodes at once per instance (`NAIL_PHOTO_MAX_CONCURRENT_DECODES`, others queue), applies the EXIF orientation to the pixels, downscales to ≤ 2048 px on the longest edge, flattens alpha onto white and re-encodes as sRGB JPEG (q85, mozjpeg). Nothing but pixels survives: no EXIF (GPS, camera, timestamps), XMP, IPTC or ICC; the output is re-checked and refused if any metadata remains (fail closed, unlike the capture-frame `stripImageMetadata`).
- **Storage:** blob `<userId>/<inventoryItemId>/<uuid>.jpg` in `USER_MEDIA_CONTAINER` (default `nail-photos`), an `image_asset` row (`owner_type 'user'`, `owner_id` = caller, `copyright_status 'user_uploaded'`), then the link is upserted under a `FOR UPDATE` lock on the inventory row. Replacing deletes the previous `image_asset` row and blob; a failed DB write deletes the just-uploaded blob. `503` when `AZURE_STORAGE_CONNECTION` is unset. `201` for a first upload, `200` for a replacement.
- **Responses:** `NailPhotoResponse` with `imageUrl` as an owner-scoped `v3` proxy URL only (never a raw blob URL or `v2` id; `null` if it cannot be signed), `Cache-Control: private, no-store`. Fetch the image with the bearer token (web: `PrivateImage`).
- **Delete:** `DELETE` removes the link, the `image_asset` row and the blob (`204`, also when there was no photo). `DELETE /api/polishes/{id}` locks the inventory row (`FOR UPDATE`), deletes the photo's `image_asset` rows and the item in one transaction, and deletes the blobs only after commit (a failed delete leaves photo and blob untouched; a concurrent upload waits on the lock). Blob deletes are best-effort after the DB commit (`nail_photo.blob_delete_failed` telemetry); a photo without its row can no longer be minted a URL.
- **Telemetry:** `nail_photo.uploaded`, `nail_photo.rejected` (status), `nail_photo.deleted`, `nail_photo.blob_delete_failed`.

### Finish canonicalization (`src/lib/finishes.ts`)

Source-of-truth split (decided in #43):

- **Which finishes exist** — the DB `finish_type` table (admin-managed via `/api/reference-admin/finishes`). A finish type created only through the admin UI is a valid finish for parsing, validation, `finish=`/`finishes=` list filters, ingestion, and AI finish detection. The build-time `CANONICAL_FINISHES` list in `packages/shared/src/constants/finishes.ts` is only the built-in seeded defaults: it types `PolishFinish` and is the fallback when the DB lookup fails. `tests/finishes.unit.test.cjs` fails if it drifts from the `finish_type` rows seeded by migrations 005/018.
- **How messy spellings map onto them** — the DB-backed `finish_normalization` table (admin-editable). An alias only resolves when its target is an existing `finish_type`.
- **One loader** — `loadFinishCatalog()` runs a single query over both tables and returns a `FinishCatalog` `{ aliases, validNames }` (`validNames` = every normalized `finish_type.name`). It is cached in-process for 5 minutes (cleared by `resetFinishAliasCache()` on every admin finish_type / finish_normalization create/update/delete; other instances pick changes up within the TTL) and falls back to `DEFAULT_FINISH_CATALOG` (`CANONICAL_FINISHES` + `DEFAULT_FINISH_ALIASES`, a mirror of the seeded alias rows also asserted by the test) if the query fails. If `finish_type` returns no rows, the built-in names are used.

Helpers (all take an optional `FinishCatalog`, defaulting to the built-ins): `canonicalizeFinish(value, catalog?)`, `canonicalizeFinishes(values, catalog?)`, `mergeFinishLists(lists, catalog?)`, and the pure tag parser `parseFinishesFromTags(tags, catalog?)` (used by ingestion connectors only, never for user request `tags`) — recognizes `finish:<value>` (prefix case-insensitive) and bare `<value>` tags, trims, lowercases, de-duplicates, ignores unknown values and other namespaces (`collection:holographic`, `color:blue`), and orders explicit `finish:` tags before bare tags. AI hex detection (`ai-color-detection.ts`) uses the same catalog loader for `detected_finishes`, so runtime finish types are accepted there too.

**AI prompt finish list (#224, item 3).** The vision hex/finish detection prompt (`buildHexDetectionRequestPayload`, used by the synchronous `detectHexWithAzureOpenAI` path and by the batch JSONL in `submitVisionHexBatch`) and the label OCR prompt (`buildLabelSystemPrompt` in `ocr-parser.ts`) list the finishes the model may return from `finishNamesForPrompt(await loadFinishCatalog())`: built-ins in seeded order, then admin-added finish types alphabetically, without the `other` catch-all. So an admin-added type such as `chrome` is offered to the model. When the catalog cannot be loaded the built-in `CANONICAL_FINISHES` are listed. The sync path loads the catalog once per call and uses it for both the prompt and validating the reply; the batch path loads it once per batch. The list only changes when an admin edits `finish_type`, so the prompt prefix stays cacheable. `PROMPT_VERSION` is `vision-direct/2026-10-v2` since this change; admin edits to the list do not bump it. The eval-only strategy prompts (`palette-pick-detection.ts`, `src/eval/hex/strategies/region-crop.ts`) still carry their own example lists.
- `GET /api/reference-admin/jobs` lists recent ingestion jobs with pagination (`page`, `pageSize`) and optional `status` filter (`queued|running|succeeded|failed|cancelled`), joined with `data_source` for source metadata.
- `GET /api/users-admin` lists users with linked identities plus quick counts (inventory, submissions, capture sessions) for account-repair workflows.
- `POST /api/users-admin/merge` manually merges one local user account into another (inventory, capture sessions, submissions, click events, and linked external identities), intended for repairing duplicate accounts created before identity linking was enabled.

### Shade review queue (`admin-shade-review.ts`, `src/lib/shade-review.ts`)

Shades created through the user polish API are `status = 'user_submitted'`: private to their creator and anyone holding them in inventory. Admins review them (all routes `withAdmin`; migration `20261017063252270_shade-review-queue`):

- `GET /api/shades-admin/review` — the queue, oldest first. Query: `state` (`pending` = never reviewed, default; `rejected`), `page` (1), `pageSize` (25, max 100), `q` (brand/name substring), `candidates` (merge candidates per item, default 5, max 10, `0` disables). Each `ShadeReviewItem` has brand, name, finishes, the three hexes + display hex, `createdAt`, `createdByUserId`, `submitterCount` (distinct users whose inventory references it), the last review decision, and `candidates`: active shades found with `pg_trgm` (`%` on shade names and aliases, the same GIN indexes as catalog search), ranked by 0.7 × best name/alias similarity + 0.3 × brand similarity, each with hexes, OKLAB `colorDistance` to the submission, `sameBrand`, `inventoryCount` and a signed catalog `swatchImageUrl` (user media is never exposed).
- `GET /api/shades-admin/review/{id}/candidates?q=&limit=` — re-rank candidates for one submission, or search other active shades by name/alias (`limit` default 10, max 25).
- `POST /api/shades-admin/review/{id}/approve` — sets `status = 'active'`. Optional body edits (`ShadeReviewApproveRequest`): `brand` (find-or-create), `name`, `finishes` (every value must be a valid finish from `loadFinishCatalog()`, else 400), `collection`, `colorName`, `vendorHex`, `nameHex` (`#RRGGBB`, `null` clears), `note`. `detected_hex` is not editable here (it carries provenance; use `recalc-hex`), and the legacy `shade.finish` identity column is never rewritten. Returns 409 with `conflictShadeId` when an active shade of the same brand already has the same name (case-insensitive) and primary finish: merge instead.
- `POST /api/shades-admin/review/{id}/merge` — body `{ targetShadeId, keepNameAsAlias?, note? }`; the target must be an `active` shade. One transaction: users holding only the submission get their row re-pointed; users holding both have the rows combined (the `(user_id, shade_id)` unique index forbids keeping both): quantity summed, earliest `purchase_date`/`created_at`, notes concatenated, array columns (tags) unioned, every other column keeps the target row's value and fills NULLs from the source. The column list is read from `pg_attribute` at merge time, so columns added later (e.g. the inventory `status` from #261) are carried without code changes. Rows referencing the deleted duplicate (`inventory_event`, and any other single-column FK to `user_inventory_item`) move to the surviving row. Aliases are copied (plus the submitted name, unless `keepNameAsAlias: false`), SKUs and catalog (`owner_type = 'source'`) swatches move; user-owned swatch images stay on the retired row. The target's own data is never modified. The source is retired in place: `review_status = 'merged'`, `merged_into_shade_id`, audit columns; its status stays `user_submitted`, so it remains private, and user polish queries hide it entirely (find-or-create by brand + name resolves it to the merge target for its creator). 23505 from a concurrent inventory insert → 409 (retry).
- `POST /api/shades-admin/review/{id}/reject` — body `{ note? }`; sets `review_status = 'rejected'` only. The shade stays `user_submitted` (private to its submitter); no user data is deleted. Rejected shades are listed with `state=rejected` and can still be approved or merged later.
- Audit: every decision records `reviewed_by_user_id`, `reviewed_at`, `review_status` and `review_note` on the shade (last decision wins; there is no generic admin audit table yet). Ingestion no longer promotes a merged (retired) row back to `active`.
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
- Sources are registered in `docs/seed_data_sources.sql` (which `npm run generate:types` turns into `src/lib/connectors/generated-types.ts`) plus a migration for the `data_source` row. Per-source verification (products.json exposed, robots.txt, terms of service, date checked) lives in `data_source.metadata.notes`.
- `data_source.enabled = false` keeps a source out of `/api/ingestion/sources`, which feeds the admin single-job and bulk-run pickers; nothing schedules ingestion on a timer. Sources listed in `SHOPIFY_SOURCES_PENDING_APPROVAL` (`connectors/shopify-generic.ts`) are auto-provisioned disabled as well. Currently pending owner approval (#273, roadmap 2026-10-to-12 decision 4): `NightOwlLacquerShopify`, `PahlishShopify` (migration `20261017062550000_add-indie-shopify-sources`). To activate one: `UPDATE data_source SET enabled = true, metadata = metadata - 'pendingApproval' WHERE name = '<Source>';` (clears the `metadata.pendingApproval` flag both rows carry; also drop the source from `SHOPIFY_SOURCES_PENDING_APPROVAL`). `PahlishShopify` additionally needs a store-specific product filter before it is enabled: its products have an empty `product_type` and tags that are only collection names, so the generic connector polish filter accepts none of them (0 of 36 on 2026-10-17, see `metadata.verification`) and ingestion would yield nothing.
- The generic Shopify connector replaces Shopify's placeholder vendor (`vendor-unknown`, `Default Vendor`) with the brand derived from the source name (`NightOwlLacquerShopify` → "Night Owl Lacquer").

Auth requirement:
- Ingestion endpoints are admin-only (`withAdmin`).
- In production auth mode, admin is determined from the Entra access-token `roles` claim (`admin`).
- In dev bypass mode, use an admin dev user token (for example `Bearer dev:2` with seeded admin user id 2).

For `MakeupAPI`, ingestion also materializes product color variants into searchable `shade`
rows and user inventory rows (`quantity=0`, `status='wishlist'`) by default. Set `materializeToInventory` to
`false` to store only raw/normalized external records.

Both materializers (MakeupAPI and every `*Shopify` source) also record a `shade_source_product`
row linking each materialized shade to its `external_product`, which is where the shade's
"Buy from brand" `buyUrl` comes from (see "Buy from brand" links above).

For `HoloTacoShopify`, ingestion materializes searchable shade rows (brand/name/finish/collection)
and user inventory rows (`quantity=0`, `status='wishlist'`) with source tags. `shade.finishes` is filled from the product
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
**Which image AI detection sees.** Both Shopify connectors (`shopify-generic.ts`, `holo-taco-shopify.ts`)
store `normalized.images` — `{ url, alt, position }` per Shopify image (via `connectors/shopify-images.ts`)
— next to the unchanged `imageUrls` / `primaryImageUrl`. Before AI detection, `prepareHoloTacoImageData`
ranks the images with `rankImagesForColorDetection` (`src/lib/image-selection.ts`): alt-text keywords score
high (`swatch`, `nail(s)`, `hand`, `macro`, `close-up`, `finger`) or low (`bottle`, `cap`, `box`,
`packaging`, `collection`, `set`, `lifestyle`); URL/filename words are a weak signal (`hand2`, `macro2`,
`BottleHeroes`, camelCase split). Detection uses the top-ranked image only when its **alt text** is a
confident on-nail signal and that image was uploaded; otherwise it uses the primary image as before.
Each decision is logged to the job's progress log as `[image-selection] …` with the chosen URL, the
primary URL and the reason. Blob uploads are unchanged (primary + additional images). Records ingested
before `images` existed fall back to `imageUrls` with no alt text. As of 2026-10-16 neither Holo Taco nor
Mooncat sets image alt text, so production still uses the primary image for them; filename hints are
measured by the `image-select` eval strategy before production trusts them.

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
- `detectHexOnSuspiciousOnly` (default `false`) only runs image AI when vendor hex is missing/suspicious (see
  [Hex sources and suspicious vendor hexes](#hex-sources-and-suspicious-vendor-hexes)).

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

## Hex sources and suspicious vendor hexes

Every ingested shade carries up to three independent hex sources, resolved for display in the
order `vendorHex > detectedHex > nameHex`:

| Source | Column | Produced by |
|---|---|---|
| Vendor hex | `vendor_hex` | `extractHexFromProduct` in `connectors/shopify-generic.ts` — a `#RRGGBB` regex over Shopify variant options/title, stored as-is even when it looks like a placeholder. |
| Detected hex | `detected_hex` | Azure OpenAI vision over the primary product image (`ai-color-detection.ts`, sync or batch). |
| Name hex | `name_hex` | `detectHexFromColorName` in `connectors/color-name-detection.ts` — Azure OpenAI (preferred) or the builtin `COMMON_COLORS` web palette. |

**Brand-aware name hex.** The Shopify connector calls `detectHexFromColorName(colorName, { preferAi: true, context })`
with `context` = { `brand` (vendor), `productLine` (`product_type`), `collection` (first `collection:` tag), `description`
(`body_html` stripped of tags via `stripHtmlToText`, 400 chars), `tags`, `finishes` }. `buildColorNamePrompt` turns that
into `<product-context>Brand: X. Product line: … Collection: Y. Shade name: "Z". Finish: … Tags: … Description: …</product-context>`
(vendor text is escaped so it cannot close the block, and the system prompt marks the block as untrusted data whose
instructions are ignored), and the system prompt
tells the model to use its knowledge of that brand's actual shade when it has it (confidence ≥ 0.7) and to answer from
the words with confidence ≤ 0.5 otherwise, so "Mooncat Wildberry" and a generic "wildberry" no longer get the same
answer. Without a context the prompt is the original `Color name: "X"` question, and the response shape
(`{ hex, confidence, provider }`) is unchanged. Nothing new is stored on the shade; the connector still records
`hexSource` (`variant-option` / `ai-lookup` / `builtin-lookup`).

**Suspicious vendor hexes.** `src/lib/suspicious-hex.ts` decides whether a vendor hex is trustworthy enough to skip
image AI when a job runs with `detectHexOnSuspiciousOnly`:

- `isSuspiciousHex(hex)` — the original context-free check: missing values plus a static set of pure
  black/white/gray/primary placeholders. Still used by callers that look at one hex in isolation (eval populate).
- `buildSuspiciousHexContext(vendorHexes)` — built once per data-source batch in `ingestion-repo.ts`
  (`prepareHoloTacoImageData`); counts how often each vendor hex repeats and marks **template defaults**: a hex on
  ≥ `SUSPICIOUS_HEX_REPEAT_MIN_RECORDS` records (default 3) **and** ≥ `SUSPICIOUS_HEX_REPEAT_MIN_SHARE` (default 10%)
  of the records that have a vendor hex — the `#C8A2C8`-on-40-shades store theme default the static list never caught.
- `classifySuspiciousHex(hex, context, { shadeName, tags })` / `isSuspiciousHexInContext(...)` — on top of the static
  set and template defaults, flags **near-grayscale** hexes (OKLAB chroma < `SUSPICIOUS_HEX_GRAYSCALE_MAX_CHROMA`,
  default 0.02) unless the shade name or tags contain a gray/silver/black/white/nude/chrome-type word, and **web-palette**
  hexes (an exact `COMMON_COLORS` value such as `#FF69B4` hot pink) when the shade name/tags do not carry that color word
  or its base word (`pink`). The verdict's `reason` (`missing`, `malformed`, `placeholder`, `template-default`,
  `near-grayscale`, `web-palette`) and `detail` are logged per record to the console, the "Image upload started" job-log
  line carries the run's template defaults, and a separate job-log line names them when `detectHexOnSuspiciousOnly` is on.

Both the batch-candidate estimate (sync vs. batch mode) and the per-record decision use the same context, so a
run's `estimatedBatchCandidates` reflects the contextual verdicts. Unit tests: `tests/suspicious-hex.unit.test.cjs`,
`tests/suspicious-hex-context.unit.test.cjs`, `tests/color-name-detection.unit.test.cjs`.

## Hex detection evaluation harness

`src/eval/hex/` measures how well vendor-image hex detection recovers a shade's true color, so
prompt and pipeline changes (palette-pick, region crops, image selection, blind prompts) can be
compared with numbers instead of by eye. Nothing in it touches the production detection prompt or
the shade write path.

```bash
# From repo root
npm run eval:hex --workspace=swatchwatch-functions -- --strategy pixel            # offline pixel baseline
npm run eval:hex --workspace=swatchwatch-functions -- --strategy azure-current,azure-blind --verbose
npm run eval:hex --workspace=swatchwatch-functions -- --strategy ensemble --limit 5      # N samples/case, see below
npm run eval:hex --workspace=swatchwatch-functions -- --strategy all --fixture eval/hex/fixtures/color-training-sample.json
npm run eval:hex --workspace=swatchwatch-functions -- --strategy image-select,azure-blind --fixture eval/hex/fixtures/sample-with-images.json
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
| `image-select` | Ranks the case's `images` with the production `rankImagesForColorDetection`, then runs `azure-blind` detection on the top image (any positive score, so filename hints count; `meta.chosenImage.confident` says whether alt text backed it). Cases without `images`, or with no positive signal, use the case image. `meta` records the chosen image, the reason and the full ranking. (`src/eval/hex/strategies/image-select.ts`) | yes |
| `image-select-ai` | `image-select`, plus one low-detail vision call that asks which photo (up to 8) shows painted nails when no image has alt text; `meta.swatchPick` records the answer. Compare with `image-select` to price the extra call. | yes |
| `blind-snap` | `azure-blind` on the case image, then the model's hex is replaced by the nearest color measured from the same photo (palette-pick's candidate chips) unless no chip is within `HEX_SNAP_MAX_DISTANCE`. The model points, the pixels measure. | yes |
| `image-select-ai-snap` | `image-select-ai`'s photo choice (alt-text ranking, or one vision call picking the on-nail photo), then `blind-snap` on that photo. | yes |
| `ensemble` | `azure-current` sampled several times at a small temperature, optionally across more than one deployment, reduced to one answer by `src/lib/hex-ensemble.ts` (see below). | yes |

When Azure OpenAI is not configured (`AZURE_OPENAI_ENDPOINT` + `AZURE_OPENAI_KEY` + `AZURE_OPENAI_DEPLOYMENT_HEX`/`AZURE_OPENAI_DEPLOYMENT`,
or the APIM gateway equivalents), Azure strategies print `Skipping strategy …` and the run still exits 0.

**Snap strategies** (`src/eval/hex/strategies/snap.ts` + pure `snapHexToPalette` in `src/lib/hex-snap.ts`). On
`sample.json` the measured palette already holds a chip within 0.05 of the ground truth for 78% of cases, but
palette-pick's chip *choice* fails on painted-hand photos (it picks skin or the cap). Snapping uses the blind prompt's
hex only as a pointer into that palette: the nearest chip in OKLAB wins when it is within `HEX_SNAP_MAX_DISTANCE`
(default `0.10`, the MEDIUM threshold), otherwise the model hex is kept because the palette probably missed the polish.
A cap sweep on saved results kept the blind prompt's p90 at caps ≤ 0.10 and widened it above. `meta` records
`modelHex`, `snapped`, `nearestChip`, `snapDistance`, `maxSnapDistance` and the candidates.

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

**Ensemble strategy** (`src/eval/hex/strategies/ensemble.ts` + pure math in `src/lib/hex-ensemble.ts`):
one detection at temperature 0 gives one opinion and no idea how stable it is. The ensemble makes the
same production call (image + vendor context) `HEX_DETECTION_ENSEMBLE_SAMPLES` times per deployment
(default 3) at `HEX_DETECTION_ENSEMBLE_TEMPERATURE` (default 0.3), against every deployment in
`AZURE_OPENAI_DEPLOYMENT_HEX_ENSEMBLE` (comma-separated; unset → the sync deployment
`AZURE_OPENAI_DEPLOYMENT_HEX` → `AZURE_OPENAI_DEPLOYMENT`), with at most three calls in flight per
case and the library's usual 429/5xx retries. `aggregateHexSamples` then:

- picks the **medoid** in OKLAB (the sample with the smallest summed distance to the others), so the
  answer is always one of the model's own outputs;
- reports the **spread** (mean OKLAB distance of the other samples to the medoid; 0 = unanimous);
- derives **confidence** as agreement (1 at spread 0, 0 at spread ≥ the MEDIUM threshold `0.10`)
  blended 50/50 with the samples' mean reported confidence;
- **votes on finishes**, keeping those reported by at least half the valid samples.

A single valid sample is returned as-is (no spread, its own confidence); samples that error are kept
in the output with their message, and the case only errors when every sample fails. The results JSON
`meta` holds every sample (deployment, temperature, hex, confidence, finishes, usage, distance to the
medoid), `medoidIndex`, `spread`, `agreement`, `votes`, `config` and per-deployment token usage. The
ensemble costs samples × deployments calls per case, so run it on small fixtures or with `--limit`.
The production ingestion path still makes one temperature-0 call; this is eval-only.

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
  This is the primary image every single-image strategy sees (`input.image`).
- `images` (optional): `[{ "url": "https://…", "alt": "optional", "position": 1 }]`, every product image.
  Strategies receive it as `input.images`, lazy loaders (`{ index, url, alt, position, load() }`) that
  download through the same cache only when called; it is absent when the case has no `images`, so
  existing strategies and fixtures are unaffected.
- `groundTruthSource` is one of `vendor_option` (hex published by the vendor), `swatch_measured`
  (measured from the vendor's own painted-nail photo), `manual`, `ai_detected` (approved AI output).
- `finishes[0]` is the "primary finish" used for the per-finish breakdown (`unknown` when empty).

`eval/hex/fixtures/sample.json` is a checked-in 18-case smoke set (Holo Taco + Mooncat cremes, mattes,
metallics). Its image is the first Shopify product image (what ingestion sends to the model) and its
ground truth was measured from a *different* vendor photo of painted nails (each case's `notes` says
which). It is a curated sample for exercising the runner, not vendor-published hex data.
`eval/hex/fixtures/sample-with-images.json` is the same 18 cases plus each product's full Shopify image
list (captured 2026-10-16; no alt text on either store). Note that each case's ground-truth photo is one of
those images, so an image-selection strategy that finds it is partly being graded on its own input.



**Populating from ingested data** (`src/eval/hex/populate.ts`, migration `20261017033500000_add-color-training-sample.sql`): reads shades whose
`vendor_hex` is set and not a known placeholder (`src/lib/suspicious-hex.ts`), matches each to its
latest `external_product` row (same brand + shade name; a product with no brand only falls back to Holo Taco when it comes from `HoloTacoShopify`) for the public product image, upserts one
`color_training_sample` row per external product (`source_type = 'vendor_option'`,
`training_status = 'pending'`; re-runs refresh `pending` rows instead of duplicating, and never touch rows already curated to `approved`/`rejected`/`used`), and exports rows with status
`pending`/`approved` to `eval/hex/fixtures/color-training-sample.json`
(image rows keep `alt`/`position` from `normalized_json.images` when the connector stored them, and
multi-image samples export an `images` list) (gitignored — copy it to a named
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
| `025_correct_shopify_source_notes.sql` | Corrects Shopify `data_source.metadata.notes` (no store publishes hex values) and disables Clionadh, Garden Path, Roylalee and Potion Polish, which the connector cannot read |
| `20261016030127700_clear-fake-shopify-vendor-hex.sql` | Nulls `shade.vendor_hex` values the generic Shopify connector invented before PR #238: regex false positives (hex digits found in the shade name/color name/raw Shopify title or options but never as a literal `#RRGGBB` token, e.g. "Facade" → `#FACADE`) and the `#000000`/`#D3D3D3` placeholders. Only Shopify-sourced shades (inventory tagged `shopify` or swatch owned by a `*Shopify` data source); MakeupAPI-linked shades and `detected_hex`/`name_hex` are untouched. Old values go to `shade_vendor_hex_cleanup_backup`; down restores them where `vendor_hex` is still null, then drops the table |
| `20261016030938732_move-ai-hex-out-of-shopify-vendor-hex.sql` | Moves AI-detected hex values out of `shade.vendor_hex` on Shopify-sourced shades. Before 011 the Holo Taco connector stored only the Azure OpenAI vision result in `color_hex`, which 011/012 relabeled as `vendor_hex`. A value moves when its hex digits appear nowhere in the shade name, color name or raw Shopify title/options (so the connector regex could not have produced it). It goes to `detected_hex` when that is empty; otherwise `vendor_hex` is only cleared. Same Shopify-sourced/MakeupAPI-exclusion rules as `20261016030127700_clear-fake-shopify-vendor-hex.sql`; `#000000`/`#D3D3D3` placeholders and user-created shades are skipped. Old values go to `shade_vendor_hex_to_detected_backup`; down resets `detected_hex` where it still holds the moved value, restores `vendor_hex` where it is still null, then drops the table |
| `20261016033423000_cleanup-gallery-swatches-on-primary-image.sql` | Deletes `source_gallery` swatches that re-ingestion had repointed at the shade's primary image (duplicates of the `source_product` swatch) and collapses duplicate gallery swatches per shade + image. Idempotent; down is a no-op |
| `20261017024958000_shade-detected-hex-provenance.sql` | Adds `detected_hex` provenance to `shade` (`detected_hex_confidence NUMERIC(4,3)` with a 0–1 check, `detected_hex_method`, `detected_hex_model`, `detected_hex_prompt_version`, `detected_hex_at`) and `hex_agreement NUMERIC(6,4)`, a STORED GENERATED column = `hex_oklab_distance(vendor_hex, detected_hex)`. Creates the IMMUTABLE SQL functions `hex_to_oklab`/`hex_oklab_distance` (mirror `colorDistance` in swatchwatch-shared) and partial indexes for the hex-review queue. Existing rows get `hex_agreement` computed on migrate. Down drops the columns, indexes, constraint and functions |
| `20261017063252270_shade-review-queue.sql` | Admin review of `user_submitted` shades: adds `shade.review_status` (`approved`/`rejected`/`merged`, NULL = not reviewed), `reviewed_at`, `reviewed_by_user_id` (FK → `app_user`, `ON DELETE SET NULL`), `review_note`, `merged_into_shade_id` (FK → `shade`, `ON DELETE SET NULL`; only on merged rows, never self), plus a partial index for the pending queue and one on `merged_into_shade_id`. Idempotent. Down drops the constraints, indexes and columns (merged rows then look like plain private submissions; their inventory stays on the merge target) |
| `20261017033500000_add-color-training-sample.sql` | Creates `color_training_sample` (ground-truth hex samples from `docs/schema.sql`) plus a partial unique index on `(external_product_id, source_type)` so the eval harness populate script is idempotent. Originally `025_add_color_training_sample.sql`; renamed so it sorts after every dated migration (including the interim name `20261016040629000_add-color-training-sample`) |
| `20261017061344201_add-shade-source-product.sql` | Creates `shade_source_product (shade_id, external_product_id, first_seen_at, last_seen_at)` linking shades to the connector products they were materialized from (drives the "Buy from brand" `buyUrl`, #267), plus an index on `external_product_id`. Backfills existing shades best-effort the way ingestion resolves them: Shopify sources by brand + shade name + first finish + first collection (brandless products fall back to Holo Taco only for `HoloTacoShopify`), MakeupAPI by brand + product name = shade collection. Idempotent; down drops the table |
| `20261017062948506_inventory-nail-photo.sql` | Creates `inventory_nail_photo` (PK `inventory_item_id` → `user_inventory_item` ON DELETE CASCADE, UNIQUE `image_id` → `image_asset` ON DELETE CASCADE, `content_type`, `width`, `height`, `size_bytes`, timestamps): one private on-nail photo per inventory item (#270). Ownership is the inventory row's `user_id`. Down drops the table (assets/blobs are left in place) |
| `20261017063740704_manicure-log.sql` | Mani log (#269): creates `manicure` (user, `worn_on DATE`, notes ≤ 2000, optional `photo_image_id` → `image_asset` `ON DELETE SET NULL`) with `idx_manicure_user_worn_on`, and `manicure_polish` (`shade_id`, role CHECK `base\|color\|accent\|topper\|other`, `position`, unique manicure + shade + role) with `idx_manicure_polish_shade`; adds `inventory_event.manicure_id` (FK `ON DELETE CASCADE`) + partial index. Down deletes the mani-log `used` events, then drops the column and both tables (inventory wear stats keep their last values) |

node-pg-migrate tracks applied migrations in a `pgmigrations` table and refuses to run an unapplied file that sorts before an applied one, so new migrations must sort after every existing file (use `npm run migrate:create`, which writes UTC-dated names). `npm run migrate` first runs `scripts/forget-renamed-migrations.cjs`, which deletes the `pgmigrations` row of any migration renamed to a later name (listed in that script, currently `025_add_color_training_sample` and the interim `20261016040629000_add-color-training-sample` → `20261017033500000_add-color-training-sample`) so it re-runs under the new name; only idempotent migrations may be listed there. `DATABASE_URL` is the preferred connection method; it also falls back to individual `PG*` env vars (`PGHOST`, `PGPORT`, etc.).

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
- On successful AI hex detection, ingestion logs a structured success entry with `brand`, `colorName`, and `hex` to the console (App Insights traces); the job log gets the per-chunk summary instead (see [Ingestion job logs](#ingestion-job-logs)).
- Sync and batch hex detection logs now include Azure token usage when present, and those totals are persisted in ingestion job metrics for cost tracking.
- When `APPLICATIONINSIGHTS_CONNECTION_STRING` is configured, token usage is also emitted as custom metrics: `hex_detection.sync.{prompt_tokens|completion_tokens|total_tokens}` and `hex_detection.batch.{rows_with_token_usage|prompt_tokens|completion_tokens|total_tokens}`.
- For ingestion runs, AI **warnings and errors** are mirrored into the job `metrics.logs` stream shown on `/admin/jobs` (info-level diagnostics stay in the console/App Insights); poller events (batch status changes and apply results, prefixed `[poller]`) are appended to that same stream.

## Ingestion job logs

A job's log (`ingestion_job.metrics_json.logs`, shown under **Admin Jobs** in `/admin`) covers the **whole run**: every
worker invocation (continuations restore the stored log before appending), the `awaiting_ai` pause, and every AI batch
poller run. Two rules keep it readable and bounded:

- **Milestones only** (`progressLogger` in `ingestion-repo.ts`): per chunk the job log gets the upsert, image upload
  start/finish (uploaded/reused/failed, elapsed), hex detection + database writes start/finish (elapsed), the Azure
  OpenAI batch submission (elapsed), and one summary line such as
  `Records 11–20 of 250 on page 3: 10 shades (2 new), 8 hex detected, 0 upload failures, 41.0s`. Every per-record
  **warning and error** (image upload failures, records without an image or shade name, AI detection failures and AI
  client warnings) is logged too. Step-by-step per-record lines (image selection, token usage, detection success, shade /
  inventory / swatch writes) are console-only, so they reach App Insights traces but not the job log. The poller logs a
  pending batch only when its status changes, not on every one-minute poll.
- **Bounded, never silently truncated** (`src/lib/job-log.ts`, used by `JobLogger` and the poller): the log holds at most
  `INGESTION_JOB_LOG_MAX_ENTRIES` entries (default 500). It keeps the first 20% (the request, config and early
  progress), then the newest lines, and a single marker entry between them (`omitted: { count, byLevel, firstTs,
  lastTs }`, message `… N earlier log lines omitted … (including E errors and W warnings)`) that keeps counting as more
  lines roll off. The Admin Jobs view renders the marker, shows `shown of total` lines, includes omitted warnings/errors
  in its counts, and has **Warnings & errors** and **Expand log** toggles.

`host.json` excludes `Trace` from App Insights adaptive sampling (with `Request` and `Exception`), so the console lines
are all kept there; the daily cap (`appinsights_daily_cap_gb`) bounds the cost.


## Environment Variables

Defined in `local.settings.json` (git-ignored values). See the root README for the full list. For production, secrets are injected via Key Vault references.

Key variables:

| Variable | Purpose |
|----------|---------|
| `AUTH_DEV_BYPASS` | Local-dev-only bypass mode. When `true` **and the host is not running in Azure**, auth accepts `Bearer dev:<userId>` tokens. Ignored (fail closed, logged + `auth.dev_bypass_refused`) on Azure-hosted Function Apps; the deploy workflow always sets it to `false`. |
| `IMAGE_PROXY_SIGNING_KEY` | Secret (>= 32 chars) used to HMAC-sign `/api/images/{id}` ids. Required outside dev: when unset and dev bypass is not active, image URLs are omitted and the proxy refuses every request. When unset with dev bypass active (local only), an ephemeral per-process key is used (URLs break on restart). Generate with `openssl rand -base64 48`. Terraform stores a generated value in Key Vault (`image-proxy-signing-key`). |
| `IMAGE_PROXY_ID_TTL_SECONDS` | Minimum remaining lifetime of newly minted public (`v2`, catalog) `/api/images/{id}` ids (default `259200` = 3 days, clamped to 3600–2592000). Keep it above the Azure OpenAI batch completion window. |
| `IMAGE_PROXY_LEGACY_ID_ACCEPT_UNTIL` | Optional ISO-8601 timestamp until which legacy non-expiring (v1) image ids are still accepted. Unset or in the past means they are rejected (`403`). |
| `SHAREABLE_WISHLIST_ENABLED` | Feature flag for opt-in public wishlist links (#268). Default `false` (unset = off; only `true`, any case, enables). While off, `/api/wishlist-share*` and `/api/wishlist/{token}` return `404` with `code: "feature_disabled"` and the web share card stays hidden. In Azure it is a Terraform-managed app setting (`shareable_wishlist_enabled`, fed from the `SHAREABLE_WISHLIST_ENABLED` GitHub variable by Deploy Infra). Tokens are derived from `IMAGE_PROXY_SIGNING_KEY`, so that key must be configured too. |
| `INGESTION_JOB_QUEUE_NAME` | Optional queue name for async ingestion jobs. Defaults to `ingestion-jobs`. |
| `SOURCE_IMAGE_CONTAINER` | Optional blob container override for source-ingested images. Defaults to `source-images`. |
| `USER_MEDIA_CONTAINER` | Optional blob container override for private user media (e.g. nail photos). Defaults to `nail-photos`; Terraform sets it from `azurerm_storage_container.nail_photos`. The only container owner-scoped `v3` image ids may read (and `v2` ids may not), see #227. |
| `IMAGE_PROXY_PRIVATE_ID_TTL_SECONDS` | Minimum remaining lifetime of newly minted owner-scoped private (`v3`) image ids (default `3600` = 1h, clamped to 300–86400, expiry bucketed to 15 minutes), see #227. |
| `AZURE_STORAGE_CONNECTION` | Connection string for uploading source images to Azure Blob Storage. When unset (for local dev or bring-up), ingestion falls back to storing the original source image URLs so swatch images still appear. |
| `AZURE_OPENAI_GATEWAY_ENDPOINT` | Optional APIM gateway base URL used when `AZURE_OPENAI_USE_GATEWAY=true`. |
| `AZURE_OPENAI_GATEWAY_SUBSCRIPTION_KEY` | Optional APIM subscription key header value (`Ocp-Apim-Subscription-Key`) used in gateway mode. |
| `AZURE_OPENAI_USE_GATEWAY` | Feature flag (`true`/`false`) to route Azure OpenAI calls through APIM gateway endpoint. |
| `AZURE_OPENAI_DEPLOYMENT_LABEL` | Optional Azure OpenAI deployment name for label OCR structured extraction (`src/lib/ocr-parser.ts`). Falls back to `AZURE_OPENAI_DEPLOYMENT_HEX`, then `AZURE_OPENAI_DEPLOYMENT`. |
| `AZURE_OPENAI_DEPLOYMENT_HEX` | Optional Azure OpenAI deployment name for synchronous image hex detection (falls back to `AZURE_OPENAI_DEPLOYMENT` when unset). |
| `AZURE_OPENAI_DEPLOYMENT_HEX_BATCH` | Optional Azure OpenAI deployment name for batch image hex detection (falls back to `AZURE_OPENAI_DEPLOYMENT_HEX`, then `AZURE_OPENAI_DEPLOYMENT`). |
| `HEX_SNAP_MAX_DISTANCE` | Eval-only: largest OKLAB distance at which the `blind-snap` / `image-select-ai-snap` strategies replace the model's hex with the nearest measured palette chip (default `0.10`, the MEDIUM threshold). |
| `AZURE_OPENAI_DEPLOYMENT_HEX_ENSEMBLE` | Optional comma-separated Azure OpenAI deployment names the eval `ensemble` strategy samples from (falls back to `AZURE_OPENAI_DEPLOYMENT_HEX`, then `AZURE_OPENAI_DEPLOYMENT`). Eval-only. |
| `HEX_DETECTION_ENSEMBLE_SAMPLES` | Samples per deployment for the eval `ensemble` strategy (default `3`, clamped 1–10). Eval-only. |
| `HEX_DETECTION_ENSEMBLE_TEMPERATURE` | Sampling temperature for the eval `ensemble` strategy (default `0.3`, clamped 0–2). Eval-only; production detection stays at 0. |
| `AZURE_OPENAI_BATCH_API_VERSION` | Optional API version used for Azure OpenAI Files/Batch endpoints (default `2025-03-01-preview`). |
| `AZURE_OPENAI_BATCH_COMPLETION_WINDOW` | Optional completion window sent during batch creation (default `24h`). |
| `AZURE_OPENAI_VISION_DETAIL` | Optional image detail level for vision hex detection, sync and batch (`low` default — flat ~85 tokens/image; `high`/`auto` for more resolution). Unrecognized values fall back to `low`. |
| `HEX_DETECTION_BATCH_ENABLED` | Feature flag to enable Azure OpenAI Batch API for Shopify image detection (default `false`). |
| `HEX_DETECTION_BATCH_MIN_IMAGES` | Minimum record count before switching from synchronous detection to batch submission (default `5`). |
| `HEX_DETECTION_BATCH_MAX_IN_FLIGHT` | Max hex batches one ingestion job keeps pending before the worker pauses for `awaiting_ai` (default `20`, clamped 1–100); bounds the job's share of the batch deployment's enqueued-token quota. |
| `HEX_DETECTION_DELAY_MS` | Pause after each synchronous (non-batch) hex detection call, per concurrency slot (default `1000`, max `60000`, `0` disables). The old fixed 6s pacing predates low-detail images; 429s are still retried with `Retry-After`. |
| `HEX_DETECTION_CONCURRENCY` | Synchronous hex detection calls in flight at once (default `4`, max `32`). Records still commit to Postgres one at a time, in order. The deployment's tokens-per-minute quota is the real ceiling, so raise this together with `openai_deployment_capacity`. |
| `SUSPICIOUS_HEX_REPEAT_MIN_RECORDS` | Batch-aware suspicious-hex check (`src/lib/suspicious-hex.ts`): a vendor hex shared by at least this many records of one data source is a store template default (default `3`). Used when `detectHexOnSuspiciousOnly` is on. |
| `SUSPICIOUS_HEX_REPEAT_MIN_SHARE` | ...and shared by at least this fraction (0–1) of the records that carry a vendor hex (default `0.1`). Both repeat thresholds must be met. |
| `SUSPICIOUS_HEX_GRAYSCALE_MAX_CHROMA` | OKLAB chroma below which a vendor hex is near-grayscale and flagged unless the shade name/tags say gray, silver, black, white, nude or chrome (default `0.02`). |
| `INGESTION_AI_BATCH_POLL_SCHEDULE` | NCRONTAB schedule for the timer poller that checks batch completion (default `0 * * * * *`, every minute). |
| `INGESTION_AI_BATCH_MAX_POLL_JOBS` | Max `awaiting_ai` ingestion jobs the poller processes per run (default `10`). |
| `INGESTION_AI_IMAGE_PROXY_ORIGIN` | Optional public origin used when building AI image-proxy URLs (for example `https://<func-app>.azurewebsites.net`). Falls back to `https://$WEBSITE_HOSTNAME`. |
| `INGESTION_WORKER_TIME_BUDGET_MS` | Wall-clock budget per ingestion worker invocation before it checkpoints and enqueues a continuation message (default `240000`, clamped to `30000`–`270000` to stay under the Consumption plan timeout). |
| `INGESTION_LOG_FLUSH_INTERVAL_MS` | Interval for ingestion worker metric/log flushes while a job runs (default `10000`). Increase to reduce write pressure on Postgres. |
| `INGESTION_JOB_LOG_MAX_ENTRIES` | Entries kept in a job's `metrics_json.logs` for the whole run, shared by every worker invocation and the AI batch poller (default `500`, clamped `100`–`2000`). The first 20% of the run is kept, then the newest lines, with one marker entry counting the omitted lines by level. See [Ingestion job logs](#ingestion-job-logs). |
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
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | Optional custom telemetry sink for `trackEvent` / `trackMetric` / `trackException` in `src/lib/telemetry.ts`. When unset, telemetry calls are no-ops. `src/index.ts` imports `lib/telemetry` first so `pg`/`http` dependencies are auto-instrumented; the SDK's Functions `preInvocation` hook puts dependencies, custom events and exceptions under the host request's `operation_Id`. |
| `CORS_ALLOWED_HEADERS` | Overrides `Access-Control-Allow-Headers` in `src/lib/http.ts` (default `Content-Type, Authorization, traceparent, tracestate, Request-Id, Request-Context`; the last four let browser telemetry correlate with Functions requests). `Request-Context` is always exposed. |
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
