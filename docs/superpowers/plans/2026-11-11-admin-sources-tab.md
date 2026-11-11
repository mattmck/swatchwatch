# Admin Sources Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new admin tab `/admin?tab=sources` with a Sites / Brands switch: filterable, sortable tables of every `data_source` (with store permission recorded, on/off and Run) and every `brand` (with zero-shade brands, supply, a small ingest profile and Add brand).

**Architecture:** Pure rules (permission derivation, supply class, display name, run defaults) live in `packages/shared` so the API and the web agree. The Functions side has a pure planner per write (`lib/sources-admin.ts`, `lib/brands-admin.ts`) and thin `withAdmin` handlers that load the row `FOR UPDATE`, apply the plan and write one `admin_audit_event` in the same transaction. The web loads whole lists once and filters and sorts client-side from URL state (`lib/sources-admin-url.ts`, `lib/sources-admin-view.ts`).

**Tech Stack:** Azure Functions v4 (TypeScript, `pg`), Postgres migration (node-pg-migrate SQL), Next.js 16 client components with shadcn/ui, `node:test` (functions `.cjs` tests against `dist`, shared and web tests via `tsx --test`).

**Spec:** `docs/superpowers/specs/2026-11-10-admin-sources-brands-design.md`

## Global Constraints

- Every new route: `withCors(withAdmin(...))`, `methods` includes `"OPTIONS"`, `authLevel: "anonymous"`, registered with `app.http` at module scope and exported from `packages/functions/src/index.ts` (`tests/http-routes.unit.test.cjs` checks this).
- Every write runs in `transaction()` and calls `recordAdminAuditEvent(client, { actorUserId, targetUserId: null, action, changes })` in that transaction.
- New audit actions, exact strings: `data_source.permission`, `data_source.enable`, `data_source.disable`, `data_source.images`, `brand.create`, `brand.profile_update`.
- Permission statuses, exact strings: `not_needed`, `not_asked`, `asked`, `granted`, `declined`.
- Turn on is never blocked: without an OK (status not `granted`/`not_needed`) the request needs `override: true`, else 409 `permission_required`; the audit row stores `override: true` and the status at that moment.
- No blocked-store handling anywhere in the tab (owner decision 2026-11-11). `metadata.blocked` is never read or written by this feature; a Run on such a row shows the API's 409 `source_blocked` message.
- Brand name match (Add brand 409 `brand_exists`): `lower(name_canonical) = lower($1)` or a `brand_alias` with `lower(alias) = lower($1)`, after trimming and collapsing whitespace.
- Shade counts use the catalog predicate: `s.status = 'active' AND s.merged_into_shade_id IS NULL`; color = `product_category = 'color'`, other = everything else.
- Live listing = `external_product.missing_since IS NULL`.
- Dates in permission fields are `YYYY-MM-DD` strings; `channel` is one of `email`, `dm`, `form`, `phone`, `other`.
- URL params, exact names: `view` (`sites` default, `brands`), `kind`, `enabled`, `permission`, `supply`, `q`, `sort`, `dir`, `open`.
- Never edit a committed migration, `local.settings.json` or `.env*` (hook-enforced).
- Commits are GPG-signed (global config) and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; the pre-commit hook runs the whole test suite.

## Review Focus

1. **Recording an OK on a source that is already granted** (fixing a typo): fields update, `enabled` and `metadata.notes` are left alone, no second notes sentence. Test in Task 3.
2. **Add brand with a name that differs only in case, spacing, or is an alias** ("ilnp", " I  Scream Nails ", an alias row): 409 `brand_exists` with the existing `brandId`, nothing inserted. Test in Task 5.
3. **`imagesPermitted` out of step with the recorded grant**: a grant writes `imagesPermitted = imagesGranted`; the images toggle writes both; the toggle on a non-granted source is 409 `not_granted`. Test in Task 3.
4. **Hand-edited or garbage URLs** (`?kind=shop&sort=nope&dir=up&open=abc&permission=granted,bogus`): unknown values drop to defaults, valid ones survive, the page never throws, and `open` naming a row not in the list opens nothing. Test in Task 6.
5. **Malformed stored `metadata.permission`** (wrong status string, not an object): the API falls back to the derived status rather than returning garbage or 500. Test in Task 2.

---

### Task 1: Migration, schema and audit actions

**Files:**
- Create: `packages/functions/migrations/20261111120000000_admin-sources-brands.sql`
- Modify: `docs/schema.sql` (`admin_audit_event_action_check` ~line 548; new `brand_ingest_profile` after `brand_alias` ~line 246)
- Modify: `packages/shared/src/types/user.ts:102` (`AdminAuditAction`)
- Test: `packages/functions/tests/sources-admin-migration.unit.test.cjs`

**Interfaces:**
- Produces: table `brand_ingest_profile(brand_id PK FK brand ON DELETE CASCADE, website_url, platform CHECK, blocker, notes, own_data_source_id FK data_source ON DELETE SET NULL, updated_by_user_id, updated_at)` exactly as in the spec; `ADMIN_AUDIT_ACTIONS` (readonly tuple) and `AdminAuditAction = (typeof ADMIN_AUDIT_ACTIONS)[number]` exported from `swatchwatch-shared`, now including `shade.catalog_merge`, `shade.catalog_delete` (missing today) and the six new actions.

- [ ] **Step 1: Write the failing test** `sources-admin-migration.unit.test.cjs`:
  - `it("audit CHECK in the migration, schema.sql and ADMIN_AUDIT_ACTIONS list the same actions")`: extract the quoted strings inside `admin_audit_event_action_check … CHECK (action IN (…))` from the migration's Up section and from `docs/schema.sql`; both sorted equal `[...require("swatchwatch-shared").ADMIN_AUDIT_ACTIONS].sort()`, which has length 14.
  - `it("platform CHECK matches BRAND_PLATFORMS")`: the `platform` CHECK list in migration and schema equals `["shopify","woocommerce","bigcartel","custom","feed","none","unknown"]` (this constant is added in Task 2; keep the literal here so the test is self-contained, Task 2 adds the cross-check).
  - `it("seeds the three known blockers and the Mooncat / Cupcake grants")`: migration text contains `'ILNP'`, `'KBShimmer'`, `'I Scream Nails'`, `'MooncatShopify'`, `'CupcakePolishShopify'` and `"recordedByMigration"`.
- [ ] **Step 2:** Run `npm test --workspace=swatchwatch-functions -- --test-name-pattern="audit CHECK"`. Expected: FAIL (file missing / export missing).
- [ ] **Step 3: Write the migration** (`-- Up Migration` / `-- Down Migration`, `BEGIN; … COMMIT;` like `20261026045216957_makeupapi-cleanup.sql`). Up:
  1. `CREATE TABLE brand_ingest_profile` per spec, `platform` CHECK the seven values.
  2. Drop and re-add `admin_audit_event_action_check` with the 14 actions.
  3. Insert brands `ILNP`, `KBShimmer`, `I Scream Nails` when no brand or alias matches case-insensitively (`INSERT … SELECT … WHERE NOT EXISTS`).
  4. Insert profiles (joined by `lower(name_canonical)`, `ON CONFLICT (brand_id) DO NOTHING`): ILNP `platform 'custom'`, `blocker 'Custom site (Laravel), no products feed'`, `website_url 'https://www.ilnp.com'`; KBShimmer `'woocommerce'`, `'WooCommerce behind Cloudflare, which answers 403 to automated requests'`, `'https://www.kbshimmer.com'`; I Scream Nails `'none'`, `'No official store; carried by Beyond Polish and Sleek Nail'`, website NULL.
  5. `UPDATE data_source SET metadata = metadata || jsonb_build_object('permission', jsonb_build_object('status','granted','summary','OK on record in the owner''s notes (recorded 2026-11-11)','decidedAt','2026-11-11','imagesGranted', COALESCE((metadata->>'imagesPermitted')::boolean, true),'recordedByMigration','20261111120000000'))` `WHERE name IN ('MooncatShopify','CupcakePolishShopify') AND NOT (metadata ? 'permission')`.
  Down: remove `permission` where `metadata->'permission'->>'recordedByMigration' = '20261111120000000'`; `DELETE FROM admin_audit_event` with the six new actions; restore the 8-action CHECK; `DROP TABLE brand_ingest_profile` (brand rows stay).
- [ ] **Step 4: Update `docs/schema.sql`** (table + CHECK with a comment naming the migration) and `user.ts`: replace the `AdminAuditAction` union with `export const ADMIN_AUDIT_ACTIONS = [...] as const` plus the derived type; keep the doc comment, add one line for the `data_source.*` / `brand.*` actions (target user NULL, ids in `changes`).
- [ ] **Step 5:** Run the test again. Expected: PASS. Run `npm run typecheck`. Expected: no errors.
- [ ] **Step 6: Commit** `feat(admin): brand_ingest_profile table and data source / brand audit actions`.

---

### Task 2: Shared types and pure rules

**Files:**
- Create: `packages/shared/src/types/sources-admin.ts`, `packages/shared/src/admin/sources-admin.ts`
- Modify: `packages/shared/src/index.ts` (export both)
- Test: `packages/shared/src/admin/sources-admin.test.ts`

**Interfaces:**
- Consumes: `ConnectorProtocol`, `IngestionJobStatus`, `IngestionJobRunRequest` (`types/ingestion.ts`), `AdminAuditEvent` (`types/user.ts`).
- Produces (types file):
  - `SOURCE_PERMISSION_STATUSES` tuple, `SourcePermissionStatus`; `SOURCE_PERMISSION_CHANNELS = ["email","dm","form","phone","other"]`, `SourcePermissionChannel`.
  - `SourcePermission { status; askedAt?; decidedAt?; grantedBy?; channel?; summary?; imagesGranted?; recordedByUserId?; recordedAt? }`.
  - `AdminSourceKind = "brand" | "retailer" | "feed"`.
  - `AdminSourceLastJob { jobId: string; status: IngestionJobStatus; startedAt: string | null; finishedAt: string | null; recordsProcessed: number | null }`.
  - `AdminSourceListItem { dataSourceId: number; name: string; displayName: string; baseUrl: string | null; kind: AdminSourceKind; connector: ConnectorProtocol; fetchable: boolean; enabled: boolean; permission: SourcePermission; permissionStored: boolean; onWithoutOk: boolean; imagesPermitted: boolean; currency: string | null; termsScrapingClause: boolean | null; termsCheckedAt: string | null; lastJob: AdminSourceLastJob | null; liveListings: number; shades: number }`.
  - `AdminSourceListResponse { sources: AdminSourceListItem[] }`; `AdminSourceDetailResponse { source: AdminSourceListItem; notes: string | null; history: AdminAuditEvent[] }`.
  - `AdminSourcePermissionRequest` = union on `action`: `{ action: "asked"; askedAt: string }` | `{ action: "granted"; decidedAt; grantedBy; channel; summary; imagesGranted: boolean }` | `{ action: "declined"; decidedAt; channel; summary?: string }` | `{ action: "images"; imagesGranted: boolean }`.
  - `AdminSourceEnabledRequest { enabled: boolean; override?: boolean }`.
  - `BRAND_PLATFORMS` tuple (7 values), `BrandPlatform`; `BRAND_BLOCKER_PRESETS = ["Custom site, no products feed", "Cloudflare blocks automated access", "No official store"]`.
  - `BrandIngestProfile { websiteUrl: string | null; platform: BrandPlatform | null; blocker: string | null; notes: string | null; ownDataSourceId: number | null; updatedAt: string | null }`.
  - `AdminBrandSourceRef { dataSourceId: number; displayName: string; kind: AdminSourceKind; enabled: boolean; permissionStatus: SourcePermissionStatus; link: "explicit" | "metadata" | "listings" }`.
  - `BrandSupply = "own" | "retailer" | "both" | "none"`.
  - `AdminBrandListItem { brandId: number; name: string; colorShades: number; otherShades: number; ownStores: AdminBrandSourceRef[]; retailers: AdminBrandSourceRef[]; supply: BrandSupply; profile: BrandIngestProfile | null; latestIngestAt: string | null }`; `AdminBrandListResponse { brands: AdminBrandListItem[] }`.
  - `AdminBrandProfileRequest` = partial of `websiteUrl | platform | blocker | notes | ownDataSourceId`, each `… | null` (null clears, missing keeps); `AdminBrandCreateRequest { name: string; profile?: AdminBrandProfileRequest }`; `AdminBrandCreateResponse { brand: AdminBrandListItem }`.
- Produces (rules file):
  - `deriveSourcePermission(input: { metadata: Record<string, unknown> | null; enabled: boolean; fetchable: boolean }): { permission: SourcePermission; stored: boolean }`.
  - `isPermissionOk(status: SourcePermissionStatus): boolean` (true for `granted`, `not_needed`).
  - `sourceDisplayName(name: string): string`.
  - `classifyBrandSupply(ownStores: number, retailers: number): BrandSupply`.
  - `SOURCE_RUN_DEFAULTS: Omit<IngestionJobRunRequest, "source">` = `{ exhaustive: true, materializeToInventory: true, detectHexFromImage: true, overwriteDetectedHex: false }` (the Admin Jobs bulk "full-catalog pull" defaults).

- [ ] **Step 1: Write the failing tests** (`node:test` + `assert/strict`):
  - `deriveSourcePermission`:
    - stored `{status:"asked",askedAt:"2026-11-08"}` → that permission, `stored: true`.
    - stored `{status:"bogus"}` or `"granted"` (a string) → falls back to derivation, `stored: false` (Review Focus 5).
    - `verification.writtenPermission: "email 2026-10-22"`, `imagesPermitted: false` → `{status:"granted", imagesGranted:false, summary:"email 2026-10-22"}`.
    - `verification.termsScrapingClause: false` → `not_needed`.
    - `pendingApproval: true` (clause true) → `not_asked`.
    - `enabled` with no verification → `not_asked`.
    - `fetchable: false` → `not_needed` regardless of metadata.
    - `metadata: null` → `not_asked`.
  - `isPermissionOk`: true only for `granted`, `not_needed`.
  - `sourceDisplayName`: `"HypnoticPolishShopify"` → `"Hypnotic Polish"`, `"KbshimmerWooCommerce"` → `"Kbshimmer"`, `"PaintedPolishBigCartel"` → `"Painted Polish"`, `"OpiSitemap"` → `"Opi"`, `"AcmeFeed"` → `"Acme"`, `"OpenBeautyFacts"` → `"Open Beauty Facts"`, `"Manual"` → `"Manual"`, `"HoloTacoShopify"` → `"Holo Taco"`.
  - `classifyBrandSupply`: (1,0) own, (0,2) retailer, (1,1) both, (0,0) none.
  - `BRAND_PLATFORMS` equals the 7-value list; `SOURCE_RUN_DEFAULTS` deep-equals the object above.
  - Add to `sources-admin-migration.unit.test.cjs`: the migration/schema platform list equals `require("swatchwatch-shared").BRAND_PLATFORMS`.
- [ ] **Step 2:** Run `npm test --workspace=swatchwatch-shared`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement.** `sourceDisplayName` strips one trailing suffix from `Shopify|WooCommerce|BigCartel|Sitemap|Feed` (only when something remains), then inserts a space before each capital that follows a lowercase letter. `deriveSourcePermission` validates a stored object with `status` in the tuple and copies only known keys with the right primitive types; derivation order exactly as the spec (1 written permission, 2 clause false, 3 pending, 4 otherwise `not_asked`), with `fetchable: false` checked first.
- [ ] **Step 4:** Run shared tests and the functions migration test. Expected: PASS.
- [ ] **Step 5: Commit** `feat(shared): sources admin types, permission derivation and brand supply rules`.

---

### Task 3: Source write planner (Functions lib)

**Files:**
- Create: `packages/functions/src/lib/sources-admin.ts`
- Test: `packages/functions/tests/sources-admin.unit.test.cjs` (planner `describe` blocks; Task 4 adds handler blocks)

**Interfaces:**
- Consumes: Task 2 types and `deriveSourcePermission`, `isPermissionOk`; `sourceKindFromMetadata` (`lib/source-settings.ts`); `protocolOfName`, `isRunnableProtocol` (`lib/connectors/registry.ts`).
- Produces:
  - `type SourceState = { name: string; enabled: boolean; metadata: Record<string, unknown> }`.
  - `type PlanResult = { ok: true; metadata: Record<string, unknown>; enabled: boolean; action: AdminAuditAction; changes: Record<string, unknown> } | { ok: false; status: 400 | 409; code: string; error: string }`.
  - `isFetchableSource(name: string): boolean` = `isRunnableProtocol(protocolOfName(name))`.
  - `parsePermissionRequest(body: unknown): { ok: true; value: AdminSourcePermissionRequest } | { ok: false; error: string }` (dates `^\d{4}-\d{2}-\d{2}$`, `grantedBy`/`summary` trimmed non-empty ≤ 500 chars, channel in the tuple).
  - `planPermissionChange(state: SourceState, req: AdminSourcePermissionRequest, actorUserId: number, nowIso: string): PlanResult`.
  - `planEnabledChange(state: SourceState, req: AdminSourceEnabledRequest): PlanResult`.
  - `grantNoteSentence(p: { grantedBy: string; displayName: string; decidedAt: string; channel: string; summary: string }): string` → `"Acceptable use confirmed by ${grantedBy} at ${displayName} on ${decidedAt} via ${channel}: ${summary}"`.

- [ ] **Step 1: Write the failing tests** (`describe("planPermissionChange")`, `describe("planEnabledChange")`), all on plain objects:
  - `asked` → `metadata.permission = {status:"asked", askedAt, recordedByUserId, recordedAt}`, `enabled` unchanged, action `data_source.permission`.
  - `granted` on a pending store (`pendingApproval: true`, `enabled: false`, notes "x") → `enabled: true`, no `pendingApproval` key, `imagesPermitted === imagesGranted`, notes `"x " + grantNoteSentence(...)` (space-joined; notes absent → just the sentence), `changes.enabled = {from:false,to:true}`.
  - `granted` when the stored status is already `granted` (Review Focus 1) → permission fields replaced, `enabled` and `notes` unchanged.
  - `declined` → `status:"declined"`, `enabled: false`.
  - `images` on granted → `imagesPermitted` and `permission.imagesGranted` both set, action `data_source.images`; on `asked` → `{ok:false,status:409,code:"not_granted"}` (Review Focus 3).
  - any request on a non-fetchable source (`name: "Manual"`) → 409 `not_fetchable`.
  - `planEnabledChange` on `not_asked`, `asked`, `declined` without `override` → 409 `permission_required`; with `override: true` → ok, action `data_source.enable`, `changes.override === true`, `changes.permissionStatus` the status at that moment, `pendingApproval` removed, `permission` untouched.
  - `planEnabledChange` on `granted`/`not_needed` → ok without override and `changes` has no `override` key.
  - turning off → action `data_source.disable`, `enabled: false`, works on any status; non-fetchable → 409 `not_fetchable`.
  - `parsePermissionRequest`: bad date `"2026-1-5"`, unknown action, unknown channel, empty `grantedBy` → `ok:false`.
- [ ] **Step 2:** Run `npm test --workspace=swatchwatch-functions -- --test-name-pattern="plan"`. Expected: FAIL.
- [ ] **Step 3: Implement** in `lib/sources-admin.ts`. The planners never mutate their input (return a new metadata object). The status used by the guards comes from `deriveSourcePermission({ metadata, enabled, fetchable })`.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(functions): plan data source permission and on/off changes`.

---

### Task 4: Sources admin endpoints

**Files:**
- Modify: `packages/functions/src/lib/sources-admin.ts` (list SQL + row mapper)
- Create: `packages/functions/src/functions/sources-admin.ts`
- Modify: `packages/functions/src/index.ts` (export after `shade-sources-admin`)
- Test: `packages/functions/tests/sources-admin.unit.test.cjs` (handler blocks, mock pattern of `admin-users.unit.test.cjs`: `Module._resolveFilename` interception of `@azure/functions`, `jose`, `../lib/db`)

**Interfaces:**
- Consumes: Task 3 planners, `recordAdminAuditEvent` (`lib/admin-users.ts`), `withAdmin`, `withCors`, `query`, `transaction`.
- Produces routes (names for `app.http`): `sources-admin-list` GET `sources-admin`; `sources-admin-item` GET `sources-admin/{id}`; `sources-admin-permission` PUT `sources-admin/{id}/permission`; `sources-admin-enabled` PUT `sources-admin/{id}/enabled`. Each write answers `AdminSourceDetailResponse` (reloaded after commit).
- Produces lib: `SOURCES_ADMIN_LIST_SQL: string` (optional `WHERE ds.data_source_id = $1` variant via `sourcesAdminSql(byId: boolean)`), `toAdminSourceListItem(row: SourceAdminRow): AdminSourceListItem`.

- [ ] **Step 1: Write the failing handler tests:**
  - non-admin token → 403 on all four routes (reuse the suite's admin/non-admin jwt helpers).
  - GET list maps one fake row (counts as strings, `metadata` object) to an `AdminSourceListItem` with numeric counts, derived permission and `onWithoutOk: true` for an enabled `not_asked` store.
  - PUT permission `granted` → inside one `transactionMock` call: a `SELECT … FOR UPDATE`, one `UPDATE data_source SET enabled = $…, metadata = $…::jsonb`, one `INSERT INTO admin_audit_event` with action `data_source.permission`; response 200.
  - PUT enabled `{enabled:true}` on a `not_asked` row → 409 `{ code: "permission_required" }` and no UPDATE/INSERT issued; with `override:true` → 200 and the audit `changes` JSON contains `"override":true`.
  - unknown id → 404; `id=abc` → 400; invalid JSON body → 400.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement the list SQL** (one query, all rows, ordered by name): `data_source` columns; `last_job` via `LEFT JOIN LATERAL (SELECT … FROM ingestion_job j WHERE j.data_source_id = ds.data_source_id ORDER BY j.started_at DESC, j.ingestion_job_id DESC LIMIT 1)` (served by `idx_ingestion_job_source_time`) with `recordsProcessed` from `(metrics_json->>'processed')::int` (the key the Admin Jobs page reads); `live_listings` = count of `external_product` with `missing_since IS NULL`; `shades` = count of distinct unmerged `shade` through `shade_source_product` → `external_product` of the source. Mapper derives `kind` with `sourceKindFromMetadata`, `connector` with `protocolOfName`, `fetchable` with `isFetchableSource`, `displayName` with `sourceDisplayName`, `imagesPermitted` = `metadata.imagesPermitted` else default `kind === "brand"`, `onWithoutOk` = `enabled && fetchable && !isPermissionOk(status)`.
- [ ] **Step 4: Implement the handlers.** Detail = list row + `metadata.notes` + `admin_audit_event` rows `WHERE action LIKE 'data_source.%' AND (changes->>'dataSourceId')::bigint = $1 ORDER BY created_at DESC LIMIT 50`, so every write puts `dataSourceId` in `changes`. Writes: `transaction(async client => { SELECT … FOR UPDATE; plan; UPDATE; recordAdminAuditEvent })`, then reload. Telemetry `trackEvent("admin.source_permission", …)` like `admin-users.ts` does.
- [ ] **Step 5:** Run `npm test --workspace=swatchwatch-functions`. Expected: PASS (including `http-routes.unit.test.cjs`).
- [ ] **Step 6: Commit** `feat(functions): sources-admin endpoints`.

---

### Task 5: Brands admin endpoints

**Files:**
- Create: `packages/functions/src/lib/brands-admin.ts`, `packages/functions/src/functions/brands-admin.ts`
- Modify: `packages/functions/src/index.ts`
- Test: `packages/functions/tests/brands-admin.unit.test.cjs`

**Interfaces:**
- Consumes: Task 2 types, `classifyBrandSupply`, `deriveSourcePermission`, `sourceDisplayName`; Task 4 `isFetchableSource`; `recordAdminAuditEvent`.
- Produces lib: `normalizeBrandName(raw: string): string` (trim, collapse whitespace); `parseBrandProfileRequest(body: unknown): { ok: true; value: AdminBrandProfileRequest } | { ok: false; error: string }` (`websiteUrl` absolute http(s) without credentials, ≤ 500; `platform` in `BRAND_PLATFORMS`; `blocker`, `notes` ≤ 1000; `ownDataSourceId` positive integer); `buildBrandList(rows: { brands: BrandRow[]; sources: SourceRow[]; links: BrandSourceLinkRow[] }): AdminBrandListItem[]` (pure: joins explicit/metadata/listing own stores, dedupes by `dataSourceId` keeping the strongest link `explicit > metadata > listings`, sorts explicit first, retailers = retailer/feed sources with live listings, `supply` from `classifyBrandSupply`).
- Produces routes: `brands-admin-list` GET `brands-admin`; `brands-admin-create` POST `brands-admin` (201 `AdminBrandCreateResponse`, 409 `{ code: "brand_exists", brandId }`); `brands-admin-profile` PUT `brands-admin/{id}/profile` (200 `AdminBrandCreateResponse`; 404 unknown brand; 400 `ownDataSourceId` that does not exist).

- [ ] **Step 1: Write the failing tests:**
  - `buildBrandList`: a brand with zero shades and an explicit pending store → `supply: "own"`, counts 0, `ownStores[0].link === "explicit"`; a brand whose store appears as explicit and via listings → one entry with `link: "explicit"`; a brand matched by `metadata.brand` "ilnp" (case-insensitive) → own store `link: "metadata"`; retailer-only brand → `"retailer"`; nothing → `"none"`.
  - `normalizeBrandName(" I  Scream   Nails ")` → `"I Scream Nails"`.
  - POST with `"ilnp"` when the duplicate lookup returns `{brand_id: 7}` → 409 `{code:"brand_exists", brandId:7}` and no INSERT (Review Focus 2); assert the lookup SQL compares `lower(` against both `brand.name_canonical` and `brand_alias.alias`.
  - POST new name → one transaction with `INSERT INTO brand`, `INSERT INTO brand_ingest_profile` (when `profile` given) and audit `brand.create`; 201.
  - PUT profile with `platform: "squarespace"` → 400; with `websiteUrl: "javascript:x"` → 400; valid → upsert (`ON CONFLICT (brand_id) DO UPDATE`), audit `brand.profile_update` with `changes` `{ brandId, field: {from,to} }` for changed fields only.
  - non-admin → 403.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement.** List = three queries run in parallel: brands with color/other counts and `max(ssp.last_seen_at)` (catalog predicate from Global Constraints) left-joined to `brand_ingest_profile`; all `data_source` rows (id, name, enabled, metadata); and distinct `(brand_id, data_source_id)` pairs with live listings (`shade_source_product` → `external_product` with `missing_since IS NULL` → `shade` predicate). `metadata.brand` matching is done in `buildBrandList` by lower-cased name and lower-cased aliases (load `brand_alias` in the brands query as an array).
- [ ] **Step 4:** Run the functions tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(functions): brands-admin endpoints with ingest profiles`.

---

### Task 6: Web URL state, view helpers, API client and tab registration

**Files:**
- Create: `apps/web/src/lib/sources-admin-url.ts`, `apps/web/src/lib/sources-admin-view.ts`
- Modify: `apps/web/src/lib/api.ts` (after the users-admin functions ~line 1080), `apps/web/src/lib/admin-tabs.ts`
- Test: `apps/web/src/lib/sources-admin-url.test.ts`, `apps/web/src/lib/sources-admin-view.test.ts`, `apps/web/src/lib/admin-tabs.test.ts`

**Interfaces:**
- Produces:
  - `SourcesAdminState { view: "sites" | "brands"; q: string; kind: AdminSourceKind | null; enabled: "on" | "off" | null; permission: SourcePermissionStatus[]; supply: BrandSupply | null; sort: SiteSortKey | BrandSortKey; dir: "asc" | "desc"; open: number | null }`.
  - `SiteSortKey = "site" | "kind" | "connector" | "enabled" | "permission" | "lastJob" | "listings" | "shades"`; `BrandSortKey = "brand" | "shades" | "ownStore" | "retailers" | "blocker" | "latestIngest"`; default sort `site`/`brand` asc.
  - `parseSourcesAdminState(params: Pick<URLSearchParams, "get">): SourcesAdminState`; `buildSourcesAdminSearch(currentSearch: string, state: SourcesAdminState): string` (keeps `tab` and unknown params, writes only non-default values, `permission` in tuple order).
  - `filterSites(items: AdminSourceListItem[], s: SourcesAdminState): AdminSourceListItem[]`, `sortSites(items, sort, dir)`, `filterBrands(items: AdminBrandListItem[], s)`, `sortBrands(items, sort, dir)`. `q` matches `displayName`, `name`, `baseUrl` (sites) or `name` (brands), case-insensitive. `supply=own` matches `own` and `both`. Nulls sort last in both directions; ties break on display name.
  - api.ts: `listAdminSources()`, `getAdminSource(id: number)`, `updateAdminSourcePermission(id: number, data: AdminSourcePermissionRequest)`, `setAdminSourceEnabled(id: number, data: AdminSourceEnabledRequest)`, `listAdminBrands()`, `createAdminBrand(data: AdminBrandCreateRequest)`, `updateAdminBrandProfile(id: number, data: AdminBrandProfileRequest)`, same `getAuthHeaders({ admin: true })` / `handleResponse` pattern as `updateAdminUser`.
  - `ADMIN_TABS` gains `"sources"` after `"admin-jobs"`.

- [ ] **Step 1: Write the failing tests:**
  - round trip: a state with every field set → `buildSourcesAdminSearch("?tab=sources", s)` → parse → equal state; defaults serialize to `?tab=sources`.
  - garbage (Review Focus 4): `?view=x&kind=shop&enabled=maybe&permission=granted,bogus,asked&sort=nope&dir=up&open=abc` → `{view:"sites", kind:null, enabled:null, permission:["asked","granted"], sort:"site", dir:"asc", open:null}`; a brand sort key with `view=sites` falls back to `site`.
  - `filterSites` by kind + enabled + permission + q; `filterBrands` with `supply=own` returns own and both rows; `sortSites("lastJob","desc")` puts never-run rows last.
  - `getTabFromQuery("sources") === "sources"`.
- [ ] **Step 2:** Run `npm test --workspace=apps/web`. Expected: FAIL.
- [ ] **Step 3: Implement** the two libs, the API functions and the tab entry.
- [ ] **Step 4:** Run the web tests and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): sources admin URL state, view helpers and API client`.

---

### Task 7: Sources tab UI

**Files:**
- Create in `apps/web/src/app/(admin)/admin/reference-data/components/sources/`: `sources-tab.tsx`, `sites-table.tsx`, `site-panel.tsx`, `brands-table.tsx`, `brand-panel.tsx`
- Modify: `apps/web/src/app/(admin)/admin/page.tsx` (import, Trigger "Sources" after Admin Jobs, Content, card description sentence)

**Interfaces:**
- Consumes: Task 6 libs and API functions; `runIngestionJob` and `SOURCE_RUN_DEFAULTS`; shadcn `Table`, `Sheet`, `Badge`, `Button`, `Input`, `Select`, `Checkbox`, `AlertDialog` already in `components/ui/` (check which exist; no new dependencies).
- Produces: `export function SourcesTab(): JSX.Element`.

- [ ] **Step 1: `sources-tab.tsx`.** Reads state with `parseSourcesAdminState(useSearchParams())`, writes with `window.history.replaceState(null, "", buildSourcesAdminSearch(window.location.search, next))` (the admin page's pattern). Loads both lists on mount (each with loading skeleton and `ErrorState` on failure, retry button). Sites / Brands segmented control with counts; filter chips and search input; renders the table and the open panel.
- [ ] **Step 2: `sites-table.tsx`.** The spec's eight columns; clickable sortable headers (`aria-sort`); Permission column chips: Not needed (neutral), Not asked (neutral), Asked `<date>` (amber), Granted (green, plus "no images" when `imagesPermitted` is false), Declined (red), and a separate amber "On, no OK recorded" chip when `onWithoutOk`. Last job: status icon, relative time, records. Row click sets `open`.
- [ ] **Step 3: `site-panel.tsx`** (Sheet). Header: display name, raw name, kind · connector · currency · on/off, base URL link, terms finding. Permission form by status: Mark asked (date, today default); Record OK (who, date, channel select, what they agreed to, ☑ images allowed defaulting to `kind === "brand"`; button "Record OK & turn on", or "Save" when already granted); Record decline (date, channel, note). Buttons: Turn on / Turn off; Turn on without an OK opens an AlertDialog "No OK on record for {name}. Turn on anyway?" (or "{name} declined on {date}. Turn on anyway?") and sends `override: true`; Turn off confirms "Listings from {name} stop counting for buy links and prices until it is turned on again. Shades and images stay." Images toggle (granted only). Run ingestion (enabled only) calls `runIngestionJob({ source: name as IngestionSourceName, ...SOURCE_RUN_DEFAULTS })`, then polls `getAdminSource` every 5 s while `lastJob.status` is `queued`/`running` (stop on unmount), and shows API errors (e.g. `source_blocked`) inline. Notes collapsed; history list newest first. Non-fetchable sources: read-only panel, no form or buttons. After any write, replace the row in the list from the response.
- [ ] **Step 4: `brands-table.tsx`** with the spec's six columns (own store chips with on/permission state; retailer chips), Supplied by chips, search, and **+ Add brand** (dialog: name + optional website, platform, blocker; 409 `brand_exists` shows "Already exists" with a button that opens that brand).
- [ ] **Step 5: `brand-panel.tsx`** (Sheet): website, platform select, blocker with the three `BRAND_BLOCKER_PRESETS` as quick picks plus free text, notes, own store select (all brand-kind sources, plus "none"), Save → `updateAdminBrandProfile`; lists own stores and retailers with links that switch to `view=sites&open=<id>`.
- [ ] **Step 6: Register the tab in `page.tsx`.**
- [ ] **Step 7:** Run `npm run lint`, `npm run typecheck`, `npm run build:web`. Expected: all pass.
- [ ] **Step 8: Commit** `feat(web): admin Sources tab with sites and brands`.

---

### Task 8: Docs

**Files:** `CLAUDE.md` (Web App Routes `/admin` row: tabs list and a `?tab=sources` sentence; Connector ingestion / "pending" paragraphs: an OK is recorded and the store turned on in the Sources tab, no code or migration needed), `apps/web/README.md` (route + the five components + the two libs), `packages/functions/README.md` (route table rows for the seven routes; rewrite "Enabling a pending store" to the tab, with editing `SHOPIFY_SOURCES_PENDING_APPROVAL` / the seed as optional hygiene for fresh databases), `packages/shared/README.md` (new types and rules), `docs/schema.sql` (done in Task 1).

- [ ] **Step 1:** Make the edits.
- [ ] **Step 2:** Dispatch the `docs-sync-checker` subagent on `git diff origin/dev...HEAD`; fix what it lists.
- [ ] **Step 3: Commit** `docs: Sources admin tab`.

---

### Task 9: Verify end to end and open the PR

- [ ] **Step 1:** Run `npm run test --workspace=swatchwatch-functions`, `npm run test --workspace=swatchwatch-shared`, `npm run test --workspace=apps/web`, `npm run lint`, `npm run typecheck`. Expected: all pass.
- [ ] **Step 2:** Start Docker, `npm run dev:infra`, `npm run migrate -- --no-check-order` (local DB quirk), then the functions host and the web dev server with `NEXT_PUBLIC_AUTH_DEV_BYPASS=true`.
- [ ] **Step 3:** In the browser pane at `/admin?tab=sources`: filters and sort survive a reload; Mooncat shows Granted; record an OK on a pending source (e.g. Hypnotic Polish) and see it turn on with the notes sentence and a history row; Turn on another pending source and see the confirmation; Run starts a job and Last job updates; switch to Brands, ILNP / KBShimmer / I Scream Nails show their blockers; add a zero-shade brand, link its store, filter `supply=own` shows it. Screenshot each.
- [ ] **Step 4:** Revert the local test writes you don't want kept (local DB only).
- [ ] **Step 5:** Push the branch and open a PR against `dev` (`feat(admin): Sources tab for sites, brands and store permission`), body with summary, screenshots, test plan, and `🤖 Generated with [Claude Code](https://claude.com/claude-code)`; then bind it with the ccd_pr tools.
