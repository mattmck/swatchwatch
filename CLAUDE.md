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

**Data flow:** Clients → Azure Functions REST API (`/api/polishes`, `/api/polish-imports`, `/api/auth/*`, `/api/voice`) → Azure Database for PostgreSQL Flexible Server (schema in `docs/schema.sql`). Voice input goes through Azure Speech Services → Azure OpenAI for parsing polish details from transcriptions. Full canonical schema uses `pg_trgm` for fuzzy shade matching and `pgvector` for swatch similarity/dupe search.

**Finishes:** shades carry `shade.finishes text[]` (canonical, primary first) plus the legacy `shade.finish` (identity key, kept for backward compat). At runtime the admin-managed `finish_type` table is the source of truth for which finishes are valid, and `finish_normalization` holds the alias spellings; both are loaded together (one cached query) by `loadFinishCatalog()` in `packages/functions/src/lib/finishes.ts`, so a finish type created only in the admin UI is fully usable (parsing, validation, filtering, form options). `CANONICAL_FINISHES` in `packages/shared` holds the built-in seeded defaults, used for typing (`PolishFinish`) and as the fallback when the DB/reference API is unavailable; a test keeps it equal to the migration seeds. Request `tags` on polish create/update never modify catalog finishes (shades are shared); only ingestion connectors parse finishes from product tags. **Catalog write rule (#224):** user-supplied `finishes`/`finish` and color fields (`color`, `vendorHex`, `detectedHex`, `nameHex`) are written to a shade only when the request creates it; adopting, matching or updating an existing shared shade never changes them (not even to fill an empty value), except that a user may keep correcting their own private `user_submitted` shade. A `finish_type` still used by any shade (`shade.finishes` or legacy `shade.finish`) or `finish_normalization` alias cannot be deleted: `DELETE /api/reference-admin/finishes/{id}` returns 409 with the usage counts (`FinishTypeInUseResponse`). Renaming one (`PUT` with a new `name`) cascades in one transaction: `finish_type.name` and the `finish_normalization` rows pointing at it change in a single statement (non-deferrable FK), `shade.finishes`/`detected_finishes` entries are rewritten, and an alias old → new name is added; the legacy `shade.finish` is never rewritten because it is the raw vendor dedup key. A name another type already has (any case) returns 409 `FinishTypeNameTakenResponse`. AI prompts (vision hex/finish detection, sync and batch, and label OCR) list the finishes from `finishNamesForPrompt(loadFinishCatalog())`, falling back to `CANONICAL_FINISHES`. **Finish families (#320, D10):** each `finish_type` has an optional `family` (`FINISH_FAMILIES` in `packages/shared`: solid, shimmer, holo, glitter, matte, thermal, glow; CHECK-constrained, migration 20261018175839000_finish-type-family seeds the built-ins), editable in the admin Configuration tab. `loadFinishCatalog()` returns it as `families` (`buildFinishFamilyMap`, catalog rows over the static `DUPE_FINISH_FAMILIES` fallback, which a test keeps equal to the seeds), and the dupe endpoints and the web's client-side add-guard check grade with it; a finish without a family still grades `unknown` and is never penalized. The API always sends `family` (`null` = none); a payload without the key keeps the built-in family. **Product text (#352):** every connector also stores `descriptionText` and `descriptors` in `external_product.normalized_json` (`lib/product-text.ts`; no shade column, reached via `shade_source_product`, never in user-facing responses). Ingestion resolves finishes by precedence in `lib/finish-text.ts`: tags win, then descriptors, then description text (catalog names + aliases with negation/cross-sell/brand guards); text-derived finishes only fill a shade that has none. The vision prompt gets the text as a labeled vendor hint (`PROMPT_VERSION` `vision-direct/2026-10-v3`).

**Inventory status:** each `user_inventory_item` has `status` (`owned | wishlist | destash | archived`, CHECK-constrained; `PolishStatus` / `POLISH_STATUSES` in `packages/shared`), `tried_at`, `last_worn_at` and `wear_count` (migration 20261017061336791_inventory-status). Ownership is only ever `status = 'owned'` (web: `isOwnedPolish` in `apps/web/src/lib/inventory-status.ts`); never infer ownership or wishlist from `quantity`. "Untried" is derived (`owned AND tried_at IS NULL`, `Polish.isUntried`), not a status. `GET /api/polishes` filters with `status=` (comma list) and `untried=true`; create/update validation lives in `packages/functions/src/lib/inventory.ts`. Status rules (decision D5): a new row without `status` is `owned` (only an explicit `quantity: 0` gives `wishlist`); running out archives (`status: "archived"`, reason `used_up`/`decluttered` stored as an `inventory_event`, see `planArchiveEvent`), never wishlists; only an explicit Rebuy / ♡ moves an archived polish to the wishlist; CSV-import rows with quantity 0 and no status wait for the user's wishlist/archived choice. The `/polishes` ownership filters are a single `status=` URL list (`apps/web/src/lib/polish-list-url.ts`).

**Shade hexes:** each shade has `vendor_hex` (vendor product data), `detected_hex` (AI vision on the product image) and `name_hex` (from the color name). Every `detected_hex` write also records provenance (`detected_hex_confidence`, `detected_hex_method`, `detected_hex_model`, `detected_hex_prompt_version`, `detected_hex_at`; migration 20261017024958000_shade-detected-hex-provenance) via `packages/functions/src/lib/hex-provenance.ts`, and `shade.hex_agreement` is a generated column holding the OKLAB distance vendor ↔ detected. Bump `PROMPT_VERSION` in `ai-color-detection.ts` whenever the vision prompt changes. **Snap step (behind `HEX_DETECTION_SNAP_ENABLED`, default off):** every `detected_hex` write path (ingestion sync detection, the batch-submit fallback, the batch poller apply step and admin `recalc-hex`) runs `snapDetectionToImage` from `packages/functions/src/lib/hex-snap.ts` after `detectHexWithAzureOpenAI`: it re-reads the *same image the model was shown* (`lib/detection-image.ts`: data URI, `/api/images/{id}` proxy id decoded to its blob, or the vendor URL; the poller takes each row's image from the batch input file) and replaces the model's hex with the nearest palette chip measured from it (`extractPaletteCandidates`) when one is within `HEX_SNAP_MAX_DISTANCE` (default 0.10). Snapped rows are stored with `detected_hex_method = 'vision-snap'`; a detection with no chip close enough, or whose image cannot be read, keeps the raw hex and `vision-direct`. The prompt and `PROMPT_VERSION` do not change. The eval `blind-snap` strategy imports the same module. Display uses `resolveDisplayHex` (vendor > detected > name); `resolveDisplayHexDetailed` in `packages/shared` adds the source, agreement and a review flag (disagreement > 0.10 MEDIUM, or a caller-marked suspicious vendor hex). Admins review weak detections with `GET /api/polishes-admin/hex-review`, and build hand-picked ground truth for the hex-detection eval in the admin console's Hex Labeling tab (canvas eyedropper over a shade's catalog images → `color_training_sample` rows with `source_type = 'manual'`, one per shade, via `/api/hex-labels-admin/*`; migration 20261017170047543_hex-ground-truth-labels). Labels never write `vendor_hex`/`detected_hex`; `eval:hex:populate` exports them as `manual` cases scored on the sampled image (which needs a public vendor URL from `source_image_url`). Canvas reads rely on `/api/images/{id}` CORS: allowed origins get `Access-Control-Allow-Origin`, every image response has `Vary: Origin`, and private `v3` responses never get `*`.

**Catalog thumbnails:** ingestion (`uploadSourceImageToBlob` → `ensureImageVariants`) writes pre-generated square WebP thumbnails next to each catalog blob, `<blob>.c<IMAGE_VARIANT_CROP_VERSION>.w<size>.webp` for `IMAGE_VARIANT_SIZES` (64/128/256/512, `packages/shared/src/constants/image-variants.ts`). Studio shots on a flat background are cropped to a square around the product (trim the background, `planImageVariantCrop` in `packages/functions/src/lib/image-variants.ts`); other photos are center-cropped. Bump `IMAGE_VARIANT_CROP_VERSION` whenever the crop or rendering changes (variant blobs are never rewritten) and run the backfill. The image proxy snaps public `?w=n&h=n&fit=cover&fm=webp` requests up to that ladder and serves the variant blob, falling back to rendering it from the original (same `renderImageVariant`) when it is missing; private `v3` media has no variants. The web renders catalog thumbnails with `SwatchThumbnail` (`buildSwatchThumbnailSources`: 1x/2x `srcSet`). Changing the ladder needs a backfill (`POST /api/images-admin/variants/backfill`, looped by `npm run backfill:image-variants`).

**Catalog galleries:** a shade's catalog images are its `swatch` rows (`source_product` = primary, `source_gallery` = additional) over `image_asset` rows deduped by `(owner_id = data source, checksum_sha256)`. After linking a product's images, ingestion makes the shade's `source_gallery` swatches from that data source exactly the product's current images (`pruneStaleGallerySwatches` in `packages/functions/src/lib/gallery-dedupe.ts`; only when every image was stored this run, skipped when another product of the same source maps to the shade; `source_product`, other sources, user media, and swatches whose image has a `color_training_sample` label or that have `color_features` are never touched; `image_asset` rows and blobs are kept). Existing duplicates (the same picture stored twice under different checksums by older ingests) are removed by the admin perceptual-match cleanup `POST /api/images-admin/gallery-dedupe` / `npm run dedupe:gallery-images`. Each `image_asset` row stores a perceptual fingerprint (`perceptual_hash`, `thumb_fingerprint`, `image_width`, `image_height`, all-or-nothing; migration 20261018234237112_image-asset-perceptual-fingerprint), computed by `uploadSourceImageToBlob` from the stored bytes and backfilled by the cleanup endpoint for images reused by URL without a download. Ingestion does not link an additional image as a `source_gallery` swatch when it near-duplicates an image already linked for the product in that run (`planProductGalleryLinks`, `INGEST_NEAR_DUPLICATE_THRESHOLDS`: dHash ≤ 64, thumbnail MAD ≤ 20, aspect ≤ 3%, measured on Cracked Polish: catches small same-aspect re-crops and same-pose re-shoots, not crops to another aspect) or the product already links `GALLERY_MAX_IMAGES_PER_SHADE` gallery images; skipped images are still stored and kept in the prune keep-set, a swatch an earlier run linked for one is unlinked (unless protected or the shade is shared with another product of the source), and the image AI hex detection chose (`chooseUploadedImageForDetection`, which still sees every upload) is always linked.

**Color families (#103):** `classifyColorFamily` in `packages/shared/src/color/color-family.ts` bins a shade's display hex by OKLCH lightness/chroma/hue into red, pink, coral, orange, yellow, green, teal, blue, purple, nude, brown, grey, black or white; `multichrome` comes from finishes (`multichrome`/chameleon/color-shift; duochrome is binned by hex). Postgres mirrors it in `shade_color_family()` and stores it as the generated column `shade.color_family` (migration 20261017061637910_add-shade-color-family), which `?family=` filters on in `GET /api/polishes` and `GET /api/catalog/search`. `tests/color-family.unit.test.cjs` keeps the SQL threshold constants equal to `COLOR_FAMILY_THRESHOLDS`; changing a bin needs a new migration that redefines the function and rewrites the rows.

**Product categories (#349, #347; decision D23, plan `docs/plan-catalog-hygiene.md`):** `shade.product_category` (`color | topper | top_coat | base_coat | treatment | accessory`, default `color`; `PRODUCT_CATEGORIES` / `ProductCategory` in `packages/shared`, a test keeps the migration CHECK equal) plus `product_category_source` (`rule | admin`; migration 20261019011858000_shade-product-category). `classifyProductCategory` in `packages/functions/src/lib/product-category.ts` mirrors `docs/queries/catalog-hygiene-audit.sql` rule for rule (accessory from name/color name/title/product type or an explicit tool type tag, never free tags, with ambiguous words such as jewels/foils/studs counting only under a non-polish product type; topper beats coat wording; then base coat, top coat, treatment; else color): change the audit query first, then the classifier. Every connector gates products with `classifyIngestedProduct` (accessories and the June tag blocklist skipped; coats/treatments ingested with their category) and materialization writes the rule category, never over an `admin` one. Vision hex detection (sync, batch, recalc-hex) runs on `color` only. The admin backfill `POST /api/shades-admin/product-category/backfill` (dry run by default; `npm run backfill:product-category`) re-classifies the catalog, sets `status = 'excluded'` on accessories nobody holds (held ones are listed), and with `clearTopperDetectedHex` clears suspicious topper `detected_hex` values; every change is logged in `shade_category_change` (before/after, run id) so it can be undone. Admin override: `PUT /api/shades-admin/{id}/product-category` (sticky). Surfaces (D-C): accessories and `excluded` shades are visible only to holders (`POLISH_VISIBLE_SQL`, import matching) and never in catalog search; color search, gaps, photo match, hex review/labeling are color-only; dupes compare color↔color and topper↔topper only (`areDupeComparableCategories` in the shared dupe rule); Pick for me never picks a non-color main polish (pair-it may add a topper); stats count coats/treatments in spend only and drop accessories; the mani log prefills roles from the category (`manicureRoleForCategory`). `?category=` filters `GET /api/polishes` and catalog search; responses and the export carry `productCategory`.

**Telemetry:** Functions and web both report to the same workspace-based Application Insights (see `docs/observability-plan.md`). The web SDK is lazy-loaded after hydration, sends W3C `traceparent` only to the API host, tags telemetry with the internal user id (never email), and redacts `/api/images/{id}` capability ids; route-group `error.tsx` files and `app/global-error.tsx` report render errors. M2 success metrics (D19): browser events `dupe.warning_shown` / `dupe.warning_outcome` / `mani.logged` / `import.completed` from `apps/web/src/lib/metrics-events.ts`, plus the weekly read-only query `docs/queries/m2-metrics.sql`. Prod alerts (Terraform, `alerts_enabled`) email `alert_email` on API 5xx, exception spikes (server + browser), `ingestion.job_failed` events (emitted by `markIngestionJobFailed`), the daily cap being hit, and failing availability tests (web home page, `GET /api/reference/finishes`).

**Buy from brand (#267):** polish list/detail and catalog search/shade responses carry an optional `buyUrl` — the brand product page from the connector-stored `external_product.normalized_json ->> 'productUrl'`, reached through `shade_source_product` (written by ingestion materialization; migration 20261017061344201_add-shade-source-product). `packages/functions/src/lib/buy-link.ts` validates (absolute http/https only, no credentials) and picks one product deterministically (enabled source, then latest `last_seen_at`, then latest `fetched_at`, then highest id). No affiliate parameters; `applyAffiliateParams()` is the one place to add them. The web renders it via `BuyFromBrandLink` with `rel="noopener noreferrer nofollow"`.
**Private media:** user photos (today the per-item nail photo, #270) live in `USER_MEDIA_CONTAINER`, referenced by `image_asset` rows with `owner_type = 'user'`, and are only ever exposed as owner-scoped `v3` image proxy URLs that require the owner's bearer token (web: `PrivateImage`). Every upload is re-encoded server-side so no EXIF/GPS metadata is stored; never return raw blob URLs or public `v2` ids for user media. Rows orphaned by cascade deletes outside the API (an `app_user` delete, an admin merge removing a duplicate inventory row) are removed by the daily `orphan-media-sweep` timer (#319, `src/lib/orphan-media-sweep.ts`): an `owner_type = 'user'` asset whose `captured_at` is older than `ORPHAN_MEDIA_SWEEP_GRACE_SECONDS` (rows without `captured_at` are never swept) that no foreign key references (discovered from `pg_constraint` each run, so new referencing tables are covered automatically) loses its blob first, then its row; only blobs in `USER_MEDIA_CONTAINER` under the owner's `{ownerId}/` prefix, and used by no other `image_asset` row, are ever deleted.
**Wear stats:** `user_inventory_item.wear_count` and `last_worn_at` are derived from the mani log (`manicure` / `manicure_polish`, keyed by `shade_id`): `packages/functions/src/lib/manicure.ts` `recomputeWearStats()` rewrites them for the affected shades after every manicure create/edit/delete (and after polish create/update), never by incrementing or decrementing. `tried_at` is only filled from the earliest wear when NULL, never cleared by the log.
**Shareable wishlist (#268):** an opt-in, revocable public read-only page for a user's `status = 'wishlist'` items, entirely behind the server flag `SHAREABLE_WISHLIST_ENABLED` (default off, pending roadmap §6 decision 2; all `/api/wishlist-share*` and `/api/wishlist/{token}` routes 404 with `code: "feature_disabled"` while off, and the web card hides itself on that response). One `wishlist_share` row per user (migration 20261017064751368_wishlist-share) stores only a salt and `SHA-256(token)`; the token is `HMAC(subkey of IMAGE_PROXY_SIGNING_KEY, user_id:salt)`, re-derivable by the owner but not from a DB leak. The public payload is an explicit allowlist (owner-chosen display name; brand, shade, finishes, display hex, public `v2` catalog image) — never ids, email, notes, prices, quantities, private `v3` media, or the owner's private `user_submitted` shades. Anonymous reads are rate-limited per IP and per token with in-memory token buckets (`src/lib/rate-limit.ts`, best effort per instance).

**Collection stats:** `GET /api/stats/collection` (`packages/functions/src/lib/collection-stats.ts`) aggregates the caller's inventory in five `user_id`-scoped SQL queries. Money is grouped by `purchase_currency` and never summed across currencies (`null` currency is its own group); spend counts `owned`/`destash`/`archived` rows with a price, and the month bucket falls back from `purchase_date` to the UTC `created_at` date. Cached per user for 60s in Redis; `invalidatePolishCachesForUser()` (`lib/polish-cache.ts`) drops the entry, so any new inventory or mani-log write path must call it.

**Backups:** all in Terraform (`infrastructure/main.tf`, see `infrastructure/README.md` → Backups & Restore), nothing geo-redundant. Postgres has 35 days of point-in-time restore. The app storage account has blob versioning, change feed and blob + container soft delete, with a management policy that expires old versions. That account also holds the live Terraform state in its `tfstate` container, so never remove that container. In prod (`backup_vault_enabled`) an Azure Backup vault takes weekly Postgres and daily `nail-photos` backups, and `CanNotDelete` locks cover Postgres, the storage account and the vault (`delete_locks_enabled`). Key Vault has purge protection. The vault role assignments and the locks need User Access Administrator, so the first apply that adds them runs locally, not in CI.

**Auth:** Azure AD B2C / Entra External ID (tenants and the web app registration provisioned outside Terraform via portal; only the web app's service principal can be Terraform-managed, opt-in per environment with `manage_ciam_service_principal`, through the `azuread.ciam` provider and a GitHub-OIDC deployer app in the CIAM tenant — see `infrastructure/README.md`). Functions read `AZURE_AD_B2C_TENANT` and `AZURE_AD_B2C_CLIENT_ID` from environment. Token validation is JWT-based via the `/api/auth/validate` endpoint. `app_user.role` is re-synced from the token's Entra `roles` claim on every sign-in, so admin is granted in Entra (app role `admin`), never edited in the app. **Admin user management (#45):** `/api/users-admin*` (`admin-users.ts`, `lib/admin-users.ts`; migration 20261018180032156_admin-user-management) lists/searches users, edits the handle and suspends/reactivates accounts; a suspended account (`app_user.suspended_at`) gets 403 `account_suspended` from `withAuth`/`withAdmin` (read via `to_jsonb(app_user.*)` so auth survives an un-migrated DB), an admin cannot suspend themselves, and every change and account merge writes an `admin_audit_event` row (who, what as before/after, when, target) in the same transaction. **Sign-in methods / password reset (#45, `docs/admin-password-reset.md`):** each environment has one External ID tenant (email + password, Google, Facebook); one email address is one Entra user with exactly one sign-in method (Entra sends a second sign-up with the same address to the existing method), and SwatchWatch stores no passwords. Reset is never done by the app: email + password users use "Forgot password?" on the Microsoft sign-in page, Google/Facebook users reset with that provider, and admins get copyable instructions plus an Entra admin center link per identity in `UserDetailDialog` (`apps/web/src/lib/entra-admin-links.ts`; Entra logs admin resets in its own audit log). Suspend is the lockout tool.

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
npm run generate:pwa-icons  # Regenerate PWA/apple-touch PNG icons in apps/web/public from the brand SVG (sharp; commit the PNGs)
npm run test --workspace=swatchwatch-functions      # Functions unit tests (no DB; includes access-control isolation tests)
npm run test:e2e --workspace=swatchwatch-functions  # E2E API + cross-user access-control tests against a running local host (skips if unreachable)
npm run eval:hex --workspace=swatchwatch-functions -- --strategy pixel            # Hex-detection ground-truth eval (strategies: azure-current, azure-blind, pixel, region-crop, palette-pick, image-select, image-select-ai, blind-snap, image-select-ai-snap, ensemble; `--list-strategies` for all; Azure ones skip without config; region-crop knobs: HEX_EVAL_REGION_CROP_MODE/CELLS/DETAIL)
npm run backfill:image-variants --workspace=swatchwatch-functions -- --after 0  # Generate missing catalog thumbnail variants in batches via POST /api/images-admin/variants/backfill (API_BASE_URL, ADMIN_BEARER_TOKEN; idempotent, resumable)
npm run dedupe:gallery-images --workspace=swatchwatch-functions -- --shade 294   # Unlink gallery images that duplicate another image of the shade (perceptual match) via POST /api/images-admin/gallery-dedupe; dry run unless --write (API_BASE_URL, ADMIN_BEARER_TOKEN; idempotent, --after resumes)
npm run eval:hex:populate --workspace=swatchwatch-functions -- --dry-run         # Fill color_training_sample from shades with real vendor hexes and export a fixture (needs Postgres); `--source-type manual` exports only admin hand labels
npm run backfill:product-category --workspace=swatchwatch-functions -- --out report.json  # Re-classify shade product categories via POST /api/shades-admin/product-category/backfill and save the report (#349; dry run unless --write, --clear-topper-hex also clears suspicious topper detected hexes; API_BASE_URL, ADMIN_BEARER_TOKEN)
npm run backfill:product-text --workspace=swatchwatch-functions                  # Recompute normalized_json descriptionText/descriptors from raw_json and report empty-finish coverage (#352; dry run by default, `--write [--fill-finishes]` applies; needs Postgres)
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
| `/dashboard` | `src/app/(app)/dashboard/page.tsx` | Client component, stats + "Pick for me" card + recent additions + collection stats panels (spend by brand/month per currency, worn vs waiting + untried %, most-worn, cost per wear) via `GET /api/stats/collection` |
| `/admin` | `src/app/(admin)/admin/page.tsx` | Unified admin console — tabs: Configuration, Job Runs, Admin Jobs, User Management, Review Queue, Hex Labeling; active tab synced to `?tab=` (`?tab=review-queue`; `?tab=hex-labeling`: eyedropper ground-truth hex labeler for the hex-detection eval); the Review Queue tab also holds the Product categories panel (backfill dry run/apply, held accessories, sticky Category control, #349) |
| `/admin/reference-data` | `src/app/(admin)/admin/reference-data/page.tsx` | Legacy redirect → `/admin?tab=configuration` |
| `/admin/jobs` | `src/app/(app)/admin/jobs/page.tsx` | Legacy redirect → `/admin?tab=admin-jobs` |
| `/polishes` | `src/app/(app)/polishes/page.tsx` | Client component, filterable/sortable table; status chips + untried badge, optimistic row quick actions (♡ wishlist, ✓ own, status/tried menu), `status=` / `untried=` URL filters, color family chips (`?family=`), Category chips (`?category=`, #349), category pill on non-color rows and a neutral topper swatch; header "Export" menu downloads the collection as CSV/JSON |
| `/polishes/new` | `src/app/(app)/polishes/new/page.tsx` | Client component, form with color picker + star rating |
| `/polishes/detail` | `src/app/(app)/polishes/detail/page.tsx` | Client component, detail shell driven by query params; admins also get a collapsed "Sip ground-truth hex" panel (`AdminHexSipPanel`, #351); owned polishes show the private nail photo (`NailPhotoPanel`) beside the vendor/AI swatches |
| `/polishes/gaps` | `src/app/(app)/polishes/gaps/page.tsx` | Client component, collection gap heatmap (hue × lightness coverage + next-buy targets) |
| `/polishes/match` | `src/app/(app)/polishes/match/page.tsx` | Client component, photo → owned-polish color matching (upload/drop/camera, extracted palette filter, confidence badges) via `POST /api/polishes/match-image` |
| `/polishes/import` | `src/app/(app)/polishes/import/page.tsx` | Client component, CSV import wizard (upload → column mapping → review matched/ambiguous/unmatched with candidate picker → commit → summary) via `/api/polish-imports` |
| `/polishes/search` | `src/app/(app)/polishes/search/page.tsx` | Client component, canvas color wheel + OKLAB matching |
| `/manis` | `src/app/(app)/manis/page.tsx` | Client component, mani log: recent-weeks calendar strip + history list, "Log a mani" dialog (polishes with roles, date, notes); `?log=<shadeId>` preselects a polish |
| `/rapid-add` | `src/app/rapid-add/page.tsx` | Client component, camera-first Rapid Add: live `getUserMedia` rear camera, on-device barcode (`BarcodeDetector`, lazy `@zxing/library` fallback), frames → capture API, verdict card (own it / added / add), mobile-web install prompt; `layout.tsx` adds `RequireAuth` + `AppShell` |
| `/w/?token=…` | `src/app/w/page.tsx` | Public shared wishlist (#268): no auth/AppShell, `noindex` + `no-referrer` metadata. Static export → token is a query param, not `/w/{token}`. Feature behind `SHAREABLE_WISHLIST_ENABLED` (off by default) |

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
- ✅ Unified admin console at `/admin` — Configuration (finish/harmony CRUD + finish-normalization aliases), Job Runs (reference-admin job history), Admin Jobs (ingestion pipeline), User Management (server-side search/filter/sort user table, detail dialog to edit the handle and suspend/reactivate, audit history, duplicate-account merge; #45), Review Queue (user-submitted shades)
- ✅ Admin shade review queue (#45) — `/api/shades-admin/review*` (`admin-shade-review.ts`, `src/lib/shade-review.ts`; migration `20261017063252270_shade-review-queue`): lists `user_submitted` shades with submitter counts and `pg_trgm` merge candidates; approve (→ `active`, optional edits), merge into an active shade (one transaction; inventory re-pointed, a user's duplicate rows combined generically from `pg_attribute` so new inventory columns are carried; source retired in place with `review_status = 'merged'` + `merged_into_shade_id`, still private and hidden from user polish queries), or reject (stays private). Who/when/what is recorded on the shade (`reviewed_by_user_id`, `reviewed_at`, `review_status`, `review_note`)
- ✅ Capture API — barcode/label/color frame submission with adaptive question flow (`capture.ts`); read-only `POST /api/capture/{captureId}/check` returns the match plus the caller's relationship (owned/wishlisted/notOwned) without touching inventory, via `classifyInventoryOwnership` in `src/lib/inventory-relationship.ts` (from the inventory `status` column: only `owned` rows count as owned)
- ✅ Catalog search — `pg_trgm`-based fuzzy search across brand/shade names and aliases (`catalog.ts`)
- ✅ Image proxy — private blob storage served through `/api/images/{id}` (`images.ts`); ids are HMAC-signed, expiring capabilities. Public `v2` ids (anonymous, `Cache-Control: public`) read only the source-image container; owner-scoped `v3` ids for private media (#227) read only `USER_MEDIA_CONTAINER` and are served only to the owner's bearer token (401/403 otherwise, `Cache-Control: private` + `Vary: Authorization`)
- ✅ Per-user access control (#47) — all user-data routes use `withAuth` with `user_id`-scoped SQL; admin/ops routes use `withAdmin`; capture frames can only reference the caller's own `image_asset` rows; user-created shades are `user_submitted` (private until an admin approves them in the review queue; rejected and merged submissions stay private, merged ones are hidden even from their creator), shared shades are read-only for users (catalog finishes/colors are written only when the request creates the shade, #224), and email account-linking requires a verified email
- ✅ Connector ingestion pipeline — async queue-backed jobs for OpenBeautyFacts, MakeupAPI, HoloTacoShopify, and generic Shopify sources
- ✅ AI hex detection — Azure OpenAI vision-based `detected_hex` from product images, with `recalc-hex` admin endpoint
- ✅ Detected-hex provenance + reconciliation — confidence/method/deployment/prompt version/timestamp on every `detected_hex` write, generated `hex_agreement` (migration 20261017024958000_shade-detected-hex-provenance), `resolveDisplayHexDetailed`, admin review queue `GET /api/polishes-admin/hex-review`
- ✅ Reference data management — `finish_type`, `harmony_type`, `finish_normalization` tables with admin CRUD and public read endpoints
- ✅ Color family filter (#103) — shared OKLCH classifier + generated `shade.color_family` column; `family` filter on the polishes list and catalog search; swatch chips on `/polishes`
- ✅ Hex-detection evaluation harness — `packages/functions/src/eval/hex/` scores detection strategies against ground-truth fixtures (OKLAB distance, HIGH/MEDIUM shares, per brand/finish); `color_training_sample` (migration `20261017033500000_add-color-training-sample.sql`) holds DB-sourced samples. See `packages/functions/README.md`
- ✅ Private nail photo per polish (#270) — `GET/PUT/DELETE /api/inventory/{inventoryItemId}/nail-photo` (`functions/nail-photos.ts`, owner-only, 404 for anyone else); uploads are decoded and re-encoded server-side with sharp (`lib/nail-photo-image.ts`: EXIF/GPS/XMP/ICC removed, orientation applied, ≤ 2048px JPEG, fail closed), stored in `USER_MEDIA_CONTAINER` via an `image_asset` row linked by `inventory_nail_photo` (migration `20261017062948506_inventory-nail-photo`), and returned only as owner-scoped `v3` image URLs. The image proxy resolves `v3` callers read-only (`authenticateRequestReadOnly`, no `getOrCreateUser` write per image). Web: `NailPhotoPanel` on the polish detail page
- ✅ Mani log (#269) — `manicure` / `manicure_polish` (migration `20261017063740704_manicure-log`), `/api/manicures` CRUD (`withAuth`, caller's own inventory items and photos only), wear stats (`wear_count`, `last_worn_at`, fill-if-null `tried_at`) recomputed from the log in the same transaction on every create/edit/delete plus `inventory_event(used)` sync; `/manis` page and one-tap "Log today's mani" on the polish detail page and owned table rows
- ✅ Wear history survives deletes and merges (D8 #317, D7 #316) — `inventory_event` keyed by `user_id` + `shade_id` with `inventory_item_id ON DELETE SET NULL` (migration `20261017232537776_inventory-event-keep-wear-history`); detached events re-attach on re-add (`reattachInventoryEvents` in `lib/manicure.ts`). Admin shade merges keep the higher inventory status (`owned` > `destash` > `wishlist` > `archived`) and move manicure polishes/events to the target, recomputing wear stats
- ✅ CSV / spreadsheet import (#263) — `/api/polish-imports` (upload → batched `pg_trgm` matching against brand/shade names + aliases with finish normalization → review decisions → commit through the #261 inventory upsert, idempotent on `(user_id, shade_id)`); sessions in `polish_import_session` (migration `20261017064132576_polish-import-session`, 24 h TTL, hourly cleanup timer), every query `user_id`-scoped; unmatched rows become private `user_submitted` shades only on request. Parser + header detection are shared (`packages/shared/src/import/`)
- ✅ Collection export (#264) — `GET /api/polishes/export?format=csv|json[&status=…]` (`withAuth`, `ui.user_id`-scoped keyset pages in `packages/functions/src/lib/collection-export.ts`): RFC 4180 CSV with UTF-8 BOM and a formula-injection guard (`src/lib/csv.ts`), or the versioned `CollectionExport` JSON envelope; `/polishes` "Export" menu downloads it with auth headers. The CSV columns are `POLISH_CSV_COLUMNS` in `packages/shared` (`types/collection-export.ts`), the contract the CSV import reuses so an export re-imports without remapping
- ✅ Admin Hex Labeling tool — `/admin?tab=hex-labeling` (the sampler is shared: admins can also sip a hex on `/polishes/detail` via `GET /api/hex-labels-admin/shades/{shadeId}`, #351): queue of shades (unlabeled, with images, worst vendor↔detected agreement first), canvas eyedropper with loupe and 1/3/5/9/15/25/41/61 px averaging (`HEX_LABEL_SAMPLE_SIZES`) plus native `EyeDropper`, keyboard flow and undo; saves `color_training_sample` `manual` labels (`/api/hex-labels-admin/*`, migration 20261017170047543_hex-ground-truth-labels) that `eval:hex:populate` exports as ground truth
- ✅ "Pick for me" (#272) — dashboard card + `/polishes` button pick a random owned polish weighted toward untried, not-recently-worn and thin gap-heatmap cells (pure, seedable `apps/web/src/lib/pick-for-me.ts`, weights in `PICK_WEIGHTS`; client-side, no endpoint), never repeating the last 3 picks; "Pair it" suggests up to 2 owned complementary/analogous/topper polishes, and the pick (with pairings) logs straight to the mani log
- ✅ Collection stats (#271) — `GET /api/stats/collection` (`withAuth`, five `user_id`-scoped aggregate queries, per-currency money, 60s per-user Redis cache invalidated with the polish caches) and dashboard panels: spend by brand / by month, worn vs waiting ring + untried %, most-worn top 10, cost per wear (best / worst), each with a skeleton, empty state and table view
- ✅ Feature-flagged Azure OpenAI batch pipeline for Shopify vision hex detection — per-chunk batches run in parallel while the worker keeps ingesting (`metrics.aiBatches`), then awaiting_ai → poll/apply each batch → complete, with synchronous fallback for small runs
- ✅ Dupe finder (#265) — `GET /api/polishes/{id}/dupes` + batch `POST /api/polishes/dupes` (≤ 100 ids): the caller's owned shades by OKLAB distance between display hexes, graded with the match-image HIGH/MEDIUM thresholds and finish-aware (a different finish family drops one grade); pure rule in `packages/shared/src/color/dupes.ts`, web helpers in `apps/web/src/lib/dupes.ts`; surfaced as the detail-page "You own N close dupes" callout and a "Dupe owned" hint on catalog/wishlist rows
- ✅ Add guard (#266) — adding a not-owned shade to the collection or wishlist first shows its owned near-dupes in `AddGuardDialog` (swatch pairs, grade, finish compatibility, links; cancel / wishlist instead / add anyway, "don't warn again this session" in sessionStorage) on `/polishes` and `/polishes/search` row Add buttons and the `/polishes/new` form (create + edit status changes). One `GET /api/polishes/{id}/dupes` call (skipped when a loaded batch hint says "no dupe"), 2s timeout, failures never block; brand-new shades are checked client-side against `GET /api/polishes?status=owned` with the shared dupe rule. Logic in `apps/web/src/lib/add-guard.ts`; telemetry `dupe.warning_shown` / `dupe.warning_outcome` (M2 funnel) / `add_guard.check_failed`

## Environment Variables (Functions)

**Canonical reference:** `packages/functions/local.settings.json.example` — this is the single source of truth for all settings. Copy it to `local.settings.json` (gitignored) and fill in the `<YOUR_*>` placeholders.

Required:
`AzureWebJobsStorage`, `FUNCTIONS_WORKER_RUNTIME`, `AZURE_STORAGE_CONNECTION`, `INGESTION_JOB_QUEUE_NAME`, `SOURCE_IMAGE_CONTAINER`, `BLOB_READ_SAS_TTL_SECONDS`, `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_KEY`, `AZURE_OPENAI_DEPLOYMENT_HEX`, `AZURE_AD_B2C_TENANT`, `AZURE_AD_B2C_CLIENT_ID`, `REDIS_URL`, `REDIS_KEY`, `IMAGE_PROXY_SIGNING_KEY`

- `IMAGE_PROXY_SIGNING_KEY` — secret (>= 32 chars) that HMAC-signs `/api/images/{id}` capability ids (`src/lib/image-proxy.ts`). Fails closed when unset (image URLs omitted, proxy refuses requests) unless dev bypass is active (`AUTH_DEV_BYPASS=true` and not hosted in Azure), which uses an ephemeral per-process dev key. Terraform generates it into Key Vault (`image-proxy-signing-key`).

Optional / dev-only:
- `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT` — Azure AI Document Intelligence endpoint for server-side OCR (graceful degradation when missing)
- `AZURE_DOCUMENT_INTELLIGENCE_KEY` — Azure AI Document Intelligence subscription key
- `AUTH_DEV_BYPASS` — enables `Bearer dev:<userId>` tokens for local dev only. Fails closed when hosted in Azure (`WEBSITE_INSTANCE_ID` or a non-loopback `WEBSITE_HOSTNAME`, see `src/lib/runtime-env.ts`); the deploy workflow always sets it to `false`
- `IMAGE_PROXY_ID_TTL_SECONDS` — minimum lifetime of newly minted signed image ids (default `259200` = 3 days, clamped 1h–30d; keep above the AI batch completion window plus poller lag, since the batch poller re-reads the same proxy ids for the `HEX_DETECTION_SNAP_ENABLED` snap step and an expired id just keeps the raw `vision-direct` hex)
- `IMAGE_PROXY_LEGACY_ID_ACCEPT_UNTIL` — optional ISO-8601 cutoff for accepting legacy non-expiring v1 image ids during rollout (unset = rejected)
- `SHAREABLE_WISHLIST_ENABLED` — feature flag for opt-in public wishlist links (#268); default `false` (only `true` enables). Off → every wishlist-share route returns 404 `feature_disabled` and the web share card is hidden. Terraform-managed in Azure (`shareable_wishlist_enabled`, default `false`, fed by the `SHAREABLE_WISHLIST_ENABLED` GitHub variable in Deploy Infra); needs `IMAGE_PROXY_SIGNING_KEY`
- `USER_MEDIA_CONTAINER` — blob container for private user media such as nail photos (default `nail-photos`, Terraform-provisioned); readable only through owner-scoped `v3` image ids (#227)
- `IMAGE_PROXY_PRIVATE_ID_TTL_SECONDS` — minimum lifetime of owner-scoped `v3` private-media image ids (default `3600`, clamped 300–86400, bucketed to 15 minutes; #227)
- `ORPHAN_MEDIA_SWEEP_SCHEDULE` — NCRONTAB schedule for the `orphan-media-sweep` timer that deletes unreferenced owner-scoped `image_asset` rows and their `USER_MEDIA_CONTAINER` blobs (#319; default `0 17 3 * * *`, daily 03:17 UTC)
- `ORPHAN_MEDIA_SWEEP_GRACE_SECONDS` — minimum age (by `image_asset.captured_at`) before an unreferenced user asset may be swept (default `86400` = 24h, clamped 3600–2592000)
- `ORPHAN_MEDIA_SWEEP_BATCH_SIZE` — candidates fetched per sweep scan query (default `100`, clamped 1–1000)
- `ORPHAN_MEDIA_SWEEP_MAX_PER_RUN` — most candidates one sweep run examines (default `2000`, clamped 1–20000); the rest wait for the next run
- `AZURE_OPENAI_DEPLOYMENT_LABEL` — Azure OpenAI deployment name for label OCR structured extraction (falls back to `AZURE_OPENAI_DEPLOYMENT_HEX`, then `AZURE_OPENAI_DEPLOYMENT`)
- `AZURE_OPENAI_DEPLOYMENT` — fallback deployment name when `AZURE_OPENAI_DEPLOYMENT_HEX` is unset
- `AZURE_OPENAI_DEPLOYMENT_HEX_BATCH` — optional Azure OpenAI deployment name dedicated to batch hex detection (falls back to `AZURE_OPENAI_DEPLOYMENT_HEX`, then `AZURE_OPENAI_DEPLOYMENT`)
- `HEX_DETECTION_SNAP_ENABLED` — feature flag (default `false`; only `true` enables) for the production snap step: after every vision hex detection (ingestion sync and batch-submit fallback, the batch poller apply step, admin `recalc-hex`) the model's hex is replaced by the nearest palette chip measured from the same image when one is within `HEX_SNAP_MAX_DISTANCE`, and stored as `detected_hex_method = 'vision-snap'`. Read at call time. Terraform-managed in Azure (`hex_detection_snap_enabled`, fed by the `HEX_DETECTION_SNAP_ENABLED` GitHub variable in Deploy Infra)
- `HEX_SNAP_MAX_DISTANCE` — largest OKLAB distance at which the snap step (production, when `HEX_DETECTION_SNAP_ENABLED` is on) and the hex-eval `blind-snap` / `image-select-ai-snap` strategies replace the model's hex with the nearest measured palette chip (default `0.10`, the MEDIUM threshold); further away, the model hex is kept
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
- `GALLERY_MAX_IMAGES_PER_SHADE` — max `source_gallery` images one product links to its shade per ingest, after near-duplicate skipping, in vendor order (positive integer; unset/empty/`0`/invalid = unlimited, the default). Images past the cap are still stored; the AI detection image is always linked; lowering it unlinks the extras on the next ingest of the product (see `src/lib/gallery-dedupe.ts`)
- `INGESTION_AI_BATCH_POLL_SCHEDULE` — NCRONTAB schedule for the batch completion poller (default: `0 * * * * *`, every minute)
- `INGESTION_AI_BATCH_MAX_POLL_JOBS` — maximum awaiting jobs processed per poller run (default: `10`)
- `INGESTION_AI_IMAGE_PROXY_ORIGIN` — optional public origin used to build `/api/images/{id}` URLs for Azure OpenAI vision calls (defaults to `https://$WEBSITE_HOSTNAME`)
- `INGESTION_WORKER_TIME_BUDGET_MS` — wall-clock budget per ingestion worker invocation (default: `240000`, clamped to `30000`–`270000`); when spent, the worker saves `metrics.checkpoint`, sets stage `continuation_queued`, and enqueues a continuation message so long jobs survive the Consumption plan timeout
- `INGESTION_LOG_FLUSH_INTERVAL_MS` — interval for ingestion worker log/metrics flushes while jobs run (default: `10000`)
- `INGESTION_JOB_LOG_MAX_ENTRIES` — entries kept in a job's `metrics_json.logs` across all its invocations and poller runs (default: `500`, clamped 100–2000); the first 20% of the run is kept, then the newest lines, with one marker entry counting the omitted lines by level (`src/lib/job-log.ts`)
- `SOURCE_IMAGE_MAX_EDGE_PX` — long edge (px) above which ingested catalog images are downscaled before storage (default `2048`, clamped 256–8192; covers AI vision at `detail: high` and the ≤ 1024 px proxy transforms; thumbnail variants are rendered from the stored image). Images still over 5 MB after resizing are re-encoded as WebP; the 5 MB limit applies to stored bytes, not downloads
- `SOURCE_IMAGE_MAX_DOWNLOAD_BYTES` — largest catalog image download accepted before resizing (default `26214400` = 25 MB, clamped 5–100 MB)
- `SHOPIFY_CONNECTOR_REQUEST_TIMEOUT_MS` — per-request timeout for Shopify `products.json` downloads (default: `45000`)
- `SHOPIFY_CONNECTOR_MAX_RETRIES` — retry count for transient Shopify request errors (default: `2`)
- `SHOPIFY_CONNECTOR_RETRY_BASE_DELAY_MS` — linear backoff base delay for Shopify retries in milliseconds (default: `1000`)
- `PG_POOL_MAX` — Postgres pool max client count (default: `10`)
- `PG_IDLE_TIMEOUT_MS` — Postgres pool idle timeout in milliseconds (default: `30000`)
- `PG_CONNECTION_TIMEOUT_MS` — Postgres connection acquisition timeout in milliseconds (default: `15000`)
- `PG_QUERY_MAX_RETRIES` — retries for retry-safe DB queries (`SELECT` and `UPDATE ingestion_job`) when connection timeouts occur (default: `2`)
- `PG_QUERY_RETRY_BASE_MS` — linear backoff base delay for retry-safe DB query retries in milliseconds (default: `250`)
- `APPLICATIONINSIGHTS_CONNECTION_STRING` — custom telemetry sink for `trackEvent`/`trackMetric`/`trackException`; `src/index.ts` imports `lib/telemetry` first so dependencies are auto-instrumented and correlated with the host request (keep it first)
- `CORS_ALLOWED_METHODS` — overrides the Functions CORS wrapper's allowed methods (default `GET,POST,PUT,PATCH,DELETE,OPTIONS`)
- `CORS_ALLOWED_HEADERS` — overrides the Functions CORS wrapper's allowed headers (default `Content-Type, Authorization, traceparent, tracestate, Request-Id, Request-Context`, so browser telemetry can correlate with API requests)
- `CORS_ALLOWED_ORIGINS` — comma-separated origins allowed by the Functions CORS wrapper (`src/lib/http.ts`; default `http://localhost:3000,https://*.azurestaticapps.net`); Terraform sets it to the web app origins
- `CONNECTOR_RAW_CONTAINER` — blob container for raw connector snapshots and the ingestion catalog cache (Terraform-provisioned; the legacy name `RAW_SNAPSHOT_CONTAINER` is still read but deprecated)
- `NEXT_PUBLIC_*` — web client vars included in example for convenience; not used by the Functions host itself

Web (build-time `NEXT_PUBLIC_*`, inlined into the static export; set in `.github/workflows/deploy.yml`, not SWA app settings):
- `NEXT_PUBLIC_APPLICATIONINSIGHTS_CONNECTION_STRING` — enables browser telemetry (`apps/web/src/lib/telemetry.ts`: page views, exceptions, fetch dependencies correlated with Functions requests via W3C `traceparent`). Unset = telemetry off (local dev default). The deploy workflow reads it from the Terraform output `application_insights_connection_string`; a missing output leaves telemetry off without failing the deploy
- `NEXT_PUBLIC_APPINSIGHTS_SAMPLING` — browser telemetry sampling percentage, `(0, 100]` (default `100`); deploy reads the `NEXT_PUBLIC_APPINSIGHTS_SAMPLING` GitHub environment variable

Infra (GitHub environment settings read by `.github/workflows/deploy-infra.yml`, exported as `TF_VAR_*`; see `infrastructure/README.md`):
- `ALERT_EMAIL` — address the prod alert action group emails (`TF_VAR_alert_email`). Set it as an environment **secret** so it is masked in logs (a variable also works); never commit it to tfvars
- `MANAGE_CIAM_SERVICE_PRINCIPAL` — `true` lets Terraform import and manage the web sign-in app's service principal in the External ID tenant (`app_role_assignment_required = false`); default `false`. Needs `CIAM_TENANT_ID` and `CIAM_TERRAFORM_CLIENT_ID` (deployer app in the CIAM tenant with a GitHub OIDC federated credential + Cloud Application Administrator; one-time bootstrap in `infrastructure/README.md`)
- `ALERTS_ENABLED` — optional override for `TF_VAR_alerts_enabled` (default `true` for `prod`, `false` otherwise)

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
- `docs/admin-password-reset.md` — #45 password-reset decision record: sign-in method model, tested Entra behavior, rejected Graph options, open tenant issues
- `docs/queries/m2-metrics.sql` — weekly read-only M2 success-metrics query (D19; definitions in `docs/observability-plan.md`)
- `docs/schema.sql` — canonical Postgres DDL (pg_trgm, pgvector, all tables + indexes)
- `docs/seed_data_sources.sql` — idempotent seed data for external sources (OpenBeautyFacts, CosIng, etc.)
- `docs/mvp-backlog.md` — epics, capabilities, stories, and milestone timeline
- `docs/decisions-2026-10.md` — decision log (D1–D22) for the M2 batch: product rules, observability, release, follow-up tickets
- `docs/retro-m2.md` — M2 retro (#274): what shipped in release #340, decisions, §4 metric readings, open issues, Q1 candidates
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
