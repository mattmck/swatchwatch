# Polish Pickup and Retailer Listings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ingest Polish Pickup (a monthly multi-brand indie pre-order shop) as a *retailer* source whose listings attach to the brands' existing shades without overriding brand-store data, and stop serving buy links for listings that are gone.

**Architecture:** Polish Pickup runs through the generic Shopify connector with a store filter and a store title parser. A `data_source.metadata.kind = 'retailer'` marker makes materialization fill only empty fields on shades it did not create, and ranks its links after brand-store links. Every Shopify run already downloads the whole catalog, so listings absent from a complete catalog get `external_product.missing_since` and are never chosen as a buy link.

**Tech Stack:** Azure Functions v4 (TypeScript), Postgres, node:test `.cjs` unit tests against `dist/`.

**Spec:** this document's "Findings and decisions" section (no separate spec; the decisions come from the 2026-11-06 session that surveyed polishpickup.com).

## Findings and decisions

Measured on 2026-11-06 against the live store (`/products.json`, `/meta.json`, sitemap) and the generic connector code:

- **Store shape.** Shopify, USD. 92 products, only the current month (open the first Friday to Monday); older months are unpublished and absent from the sitemap. `product_type` is `PPU` (70 polishes), `IPU` (16 add-ons: coats, treatments, stamping plates, scrubs), `Merchandise`, `Hand & Nail`, `Gift Cards`. Tags are only the month and `PPU`/`IPU`. `vendor` is the real brand on every product.
- **Today's connector drops all 70 polishes** (`classifyIngestedProduct` cannot classify `PPU`) and would name shades `Brand | Shade`.
- **Finishes:** `parseFinishesFromText` on the descriptions finds finishes for 69 of 70 polishes. No tags, no vendor hex, no barcodes. Descriptions also carry a limited-edition count (`Cap: 250`).
- **Same polishes, same photos.** Cracked Polish lists the same shades on its own store as `Sniff Test PPU` (21 so far, kept sold out as an archive). Polish Pickup's images are the brand's own photos (same file names), re-encoded as 1000×1000 square crops of the brand's 2000–4000 px originals. Ingestion would store them again (different checksums, different aspect, so neither checksum nor the near-duplicate check catches them).
- **Hex detection:** vision runs at `detail: low` (~512 px), so the lower-resolution copy adds no information, and `detected_hex_confidence` is the model's self-report, not calibrated. **Decision:** no "higher confidence wins" rule. A retailer listing gets AI detection only when the shade has no `detected_hex`. Choosing the best image across sources is a hex-eval question (`image-select-ai` strategy against hand labels), not part of this plan. Today detection on another source's image runs and is then discarded by `COALESCE`, so this also saves cost.
- **Enrichment rule (decision):** a brand store is the authority for its shades. A retailer listing on a shade it did not create:
  - links the listing (`shade_source_product`, buy-link candidate, price);
  - fills `finishes` only when the shade has none (already the rule for text-derived finishes), `color_name` / `name_hex` / `detected_hex` only when empty (already the rule without overwrite);
  - never changes `product_category` (its title and `PPU` type carry no category evidence);
  - links no gallery images when the shade already has images from a brand-store source;
  - keeps its description, edition cap and release tag in `normalized_json` only (not shown to users yet).
- **Buy links (decision):** a listing missing from the latest complete catalog of its source is never a buy link; among the rest, a listing with a buyable variant beats a sold-out one, then a brand store beats a retailer, then the existing `last_seen_at` → `fetched_at` → id order. Availability comes from store data (`variants[].available`), never from HTTP status, because a page can answer 200 with no working buy button.
- **Names:** retailer titles are parsed per store; a trailing ` PPU` token is stripped from every Shopify title so `Sniff Test PPU` (Cracked Polish) and `Sniff Test` (Polish Pickup) are one shade. An existing shade still named with the raw title is renamed in place on the next ingest and keeps the raw title as a `shade_alias`.
- **Two kinds of source (decision).** A *brand store* sells one brand and is the authority for its shades. A *retailer* lists many brands; it is a listing (link, price, availability) that fills gaps, never an authority. The kinds differ in: brand resolution (per-product vendor), title parsing, which fields they may write, buy-link rank, image use, and how normal it is for listings to disappear (a retailer's whole month goes away; a brand store's rarely does).
- **Authority takeover (decision).** A shade a retailer created (`shade.catalog_authority = 'retailer'`) is upgraded the first time a brand-store listing matches it: the brand store writes as if it had created the shade (finishes unless admin-set, category unless admin-set, `collection`, `color_name`; detection reruns on the brand image and replaces `detected_hex`; the retailer's gallery swatches are unlinked with the same protections as `pruneStaleGallerySwatches`), then `catalog_authority` becomes `'brand_store'` and stays there. Existing shades default to `'brand_store'`, which is correct: every enabled source today is a brand store. The retailer listing stays linked as a buy-link candidate.
- **Brands:** ingestion matches a vendor to an existing brand by `name_canonical` or an exact (case-insensitive) `brand_alias`, so `Bee's Knees` resolves to `Bee's Knees Lacquer`.

## Global Constraints

- `PolishPickupShopify` is registered **disabled** and listed in `SHOPIFY_SOURCES_PENDING_APPROVAL` until the owner records Polish Pickup's OK in `data_source.metadata.notes`.
- `data_source.metadata.kind`: `"retailer"` or absent; absent means brand store. No new column.
- Never set `missing_since` from an incomplete catalog: the fetch loop must have ended on a short page (not the 30-page cap) and returned at least one product.
- A retailer source never overwrites a value a brand store or an admin set; `finishes_source = 'admin'`, `product_category_source = 'admin'` and `vendor_hex_source = 'manual_label'` rules are unchanged.
- No new user-facing fields in this plan; buy-link responses keep their current shape (`buyUrl`, `buyPrice`, `buyCurrency`, `buyPriceSeenAt`).
- Migrations are new files only (`/create-migration`); `docs/schema.sql` updated in the same task.

## Review Focus

- A Shopify fetch that fails mid-catalog, returns `{"products": []}`, or stops at `MAX_SHOPIFY_PAGES` must not mark every listing missing → Task 4 tests.
- Titles where ` by ` or `|` appear inside the shade name (`Royla Lee | Beloved by Betty`) or the shade part repeats the brand (`Top Coat by Glisten & Glow | Glisten & Glow`) or there is no pipe (`Seal Glaze by DRK Nails`) → Task 2 tests.
- A listing that disappears and comes back (brand relists a PPU shade, next month restock) must clear `missing_since` → Task 4 test.
- Vendor casing/spelling that differs from our brand (`sylvanclaw`, `Bee's Knees`) must not create a second brand → Task 3 test.
- A ` PPU` that is part of the name rather than a suffix (`PPUrple`, `PPU Exclusive Topper`) must be kept → Task 2 test.

## File structure

| File | Responsibility |
|---|---|
| `packages/functions/migrations/<ts>_retailer-listings.sql` (create) | `external_product.missing_since`, Polish Pickup `data_source` row, `brand_alias` seeds |
| `src/lib/connectors/store-filters/polish-pickup.ts` (create) | Polish Pickup product filter and title parser |
| `src/lib/connectors/store-filters/index.ts`, `types.ts` | `SHOPIFY_STORE_TITLE_PARSERS`, `shopifyStoreShadeName` |
| `src/lib/connectors/shopify-title.ts` (create) | `stripRetailerExclusiveSuffix`, `parseEditionCap` |
| `src/lib/connectors/shopify-generic.ts` | use the parsers; report catalog completeness; register the source |
| `src/lib/data-source-kind.ts` (create in Task 5) | `sourceKindFromMetadata`, `planRetailerListingWrites` |
| `src/lib/listing-freshness.ts` (create) | `markExternalProductsMissing` |
| `src/lib/ingestion-repo.ts` | brand alias match, rename on raw-title match, retailer write rules, `missing_since` clear on upsert |
| `src/functions/ingestion.ts` | call `markExternalProductsMissing` after a pull |
| `src/lib/buy-link.ts` | candidate fields and ordering |
| `tests/*.unit.test.cjs` | one test file per new module plus `buy-link.unit.test.cjs` |

All `src/` paths are under `packages/functions/`.

---

### Task 1: Migration and source registration

**Files:**
- Create: `packages/functions/migrations/<timestamp>_retailer-listings.sql` (via `/create-migration retailer listings`)
- Modify: `docs/schema.sql`, `docs/seed_data_sources.sql`, `src/lib/connectors/generated-types.ts` (regenerated), `src/lib/connectors/shopify-generic.ts` (`SHOPIFY_SOURCE_BASE_URLS`, `SHOPIFY_SOURCES_PENDING_APPROVAL`)
- Test: `tests/shopify-indie-sources.unit.test.cjs`

**Interfaces:**
- Produces: column `external_product.missing_since TIMESTAMPTZ NULL` with partial index `(data_source_id) WHERE missing_since IS NULL`; column `shade.catalog_authority TEXT NOT NULL DEFAULT 'brand_store' CHECK (catalog_authority IN ('brand_store', 'retailer'))`; `data_source` row `PolishPickupShopify` (`source_type 'scrape'`, `base_url 'https://polishpickup.com'`, `enabled false`, metadata `{"kind":"retailer","currency":"USD","priority":"medium","mvp":"no","notes":"Polish Pickup: monthly multi-brand indie pre-order shop. Pending owner OK."}`); source name `PolishPickupShopify` in `SupportedConnectorSource`.

- [ ] **Step 1:** Add to `shopify-indie-sources.unit.test.cjs`: `PolishPickupShopify` is in `SHOPIFY_SOURCES_PENDING_APPROVAL`, `defaultShopifyBaseUrl("PolishPickupShopify") === "https://polishpickup.com"`, `isShopifySourceEnabledByDefault("PolishPickupShopify") === false`.
- [ ] **Step 2:** `npm run build:functions && npm run test --workspace=swatchwatch-functions` → the new assertions FAIL.
- [ ] **Step 3:** Write the migration (Up + Down). `brand_alias` seeds: run `SELECT name_canonical FROM brand` against prod (read-only) and insert an alias for every Polish Pickup vendor (the 70 in the 2026-11-06 listing) whose spelling differs from an existing brand only by a suffix like "Lacquer"/"Polish"/"Nail Polish" or punctuation; known today: `Bee's Knees` → `Bee's Knees Lacquer`. `ON CONFLICT DO NOTHING`; skip brands that do not exist.
- [ ] **Step 4:** Add the seed row to `docs/seed_data_sources.sql`, run `npm run generate:types`, add the base URL and the pending-approval entry with a comment pointing at this plan.
- [ ] **Step 5:** `npm run migrate && npm run migrate:down && npm run migrate` against local Postgres; tests PASS.
- [ ] **Step 6:** Commit `feat: register Polish Pickup retailer source and listing freshness column`.

### Task 2: Store filter, title parser, PPU suffix

**Files:**
- Create: `src/lib/connectors/store-filters/polish-pickup.ts`, `src/lib/connectors/shopify-title.ts`
- Modify: `src/lib/connectors/store-filters/index.ts`, `types.ts`, `src/lib/connectors/shopify-generic.ts` (`toNormalizedRecord`)
- Test: `tests/shopify-store-filters.unit.test.cjs`, create `tests/shopify-title.unit.test.cjs`

**Interfaces:**
- Produces:
  - `isPolishPickupPolish(product: StoreFilterProduct): boolean | null` — `PPU` → `true`; `IPU` → `null` (generic gate decides coats vs plates/scrubs); `Merchandise`, `Hand & Nail`, `Gift Cards` → `false`; anything else → `null`.
  - `type StoreTitleParser = (product: StoreFilterProduct & { vendor?: unknown }) => string | null` in `types.ts`; `SHOPIFY_STORE_TITLE_PARSERS: Readonly<Record<string, StoreTitleParser>>`; `shopifyStoreShadeName(source: string, product): string | null` (null = no parser or parser declined).
  - `parsePolishPickupTitle(product): string | null`.
  - `stripRetailerExclusiveSuffix(name: string): string` — removes one trailing whitespace-separated `PPU` token (case-sensitive, also `(PPU)`), trims; returns the input when the result would be empty.
  - `parseEditionCap(text: string | null): number | null` — first `Cap:\s*(\d{1,5})`, else null.
  - `toNormalizedRecord` sets `normalized.name = stripRetailerExclusiveSuffix(shopifyStoreShadeName(source, product) ?? title)`, plus `normalized.rawTitle = title`, `normalized.editionCap = parseEditionCap(descriptionText)`, `normalized.releaseTags = tags` only for retailer parsers (Polish Pickup: the month tag, e.g. `["Nov"]`, paired with `publishedAt`).

- [ ] **Step 1: Write the failing tests.** `parsePolishPickupTitle` cases (vendor in brackets):
  - `Psyche Minerals | Grandma's Pitcher` [Psyche Minerals] → `Grandma's Pitcher`
  - `Royla Lee | Beloved by Betty` [Royla Lee] → `Beloved by Betty`
  - `Top Coat by Cuticula | Wild Strawberry Limitless Quick Dry Scented Top Coat` [Cuticula] → `Wild Strawberry Limitless Quick Dry Scented Top Coat`
  - `Top Coat by Glisten & Glow | Glisten & Glow` [Glisten & Glow] → `Top Coat`
  - `Seal Glaze by DRK Nails` [DRK Nails] → `Seal Glaze`
  - `Gift Card - Electronic` [PPickup] → `null`

  `stripRetailerExclusiveSuffix`: `Sniff Test PPU` → `Sniff Test`; `Mall Goth (PPU)` → `Mall Goth`; `PPUrple` → `PPUrple`; `PPU Exclusive Topper` → unchanged; `PPU` → `PPU`. `parseEditionCap`: `"Darkened teal jelly. Cap: 300 Size: 15ml"` → `300`; `"$10 no cap"` → `null`. `isPolishPickupPolish` for each product type above. Fixture: a trimmed copy of three real products as JSON in the test file.
- [ ] **Step 2:** Build + run → FAIL.
- [ ] **Step 3:** Implement. The parser splits on the first ` | `; the part before it is `<Type> by <Vendor>` when it ends with ` by <vendor>` (case-insensitive), else the vendor; the shade is the part after the pipe unless it equals the vendor (then the `<Type>`); with no pipe, `<Type> by <Vendor>` gives `<Type>`, anything else `null`.
- [ ] **Step 4:** Run against the full 2026-11-06 snapshot as a one-off check (not committed): every `PPU` product kept, names have no `|`, the `IPU` stamping plates / scrubs / tissue holder / thinner / hand creme dropped, coats kept as `top_coat`/`base_coat`. Then unit tests PASS.
- [ ] **Step 5:** Commit `feat: Polish Pickup store filter and title parsing; strip PPU suffix`.

### Task 3: Brand alias match and rename-on-raw-title

**Files:**
- Modify: `src/lib/ingestion-repo.ts` (every `lower(name_canonical) = lower(...)` brand lookup used by Shopify materialization: `materializePreparedHoloTacoRecord`, `findRecordsWithUnchangedDetectedHex`, `findAdminProductCategories`, `applyAiBatchShadeDetections`)
- Test: create `tests/ingestion-brand-match.unit.test.cjs`

**Interfaces:**
- Produces:
  - `INGESTED_BRAND_ID_SQL(param: string): string` — scalar subquery returning the brand id whose `name_canonical` equals the param case-insensitively, else whose `brand_alias.alias` does, lowest id first.
  - `findShadeForIngestedName(client, { brandId, name, rawTitle, finish, collection }): Promise<{ shadeId: number; matchedRaw: boolean } | null>` — tries `name`, then `rawTitle` when it differs.
  - When `matchedRaw`, the materializer runs `UPDATE shade SET shade_name_canonical = $name` and inserts `shade_alias (shade_id, alias = rawTitle)` `ON CONFLICT DO NOTHING`, in the same transaction.

- [ ] **Step 1:** Tests with a fake `client.query` recorder: a brand found only through an alias returns its id and creates no brand; a shade found by raw title is renamed and aliased; a shade found by the clean name is not renamed; both present → the clean-name shade wins and nothing is renamed.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS; `npm run typecheck`.
- [ ] **Step 5:** Commit `feat: match ingested brands by alias and rename shades stored under raw titles`.

### Task 4: Listing freshness

**Files:**
- Create: `src/lib/listing-freshness.ts`
- Modify: `src/lib/connectors/shopify-generic.ts` (`fetchAllProducts`, `pullProducts` result), `src/lib/connectors/types.ts` (`ConnectorPullResult`), `src/lib/ingestion-repo.ts` (`upsertExternalProducts` sets `missing_since = NULL`), `src/functions/ingestion.ts` (after the first successful pull of a job)
- Test: create `tests/listing-freshness.unit.test.cjs`

**Interfaces:**
- Produces:
  - `ConnectorPullResult.catalog?: { externalIds: string[]; complete: boolean }` — Shopify only: every product id in the fetched catalog (before any filter), `complete` true only when the loop ended on a page shorter than `SHOPIFY_PAGE_LIMIT` and the catalog is non-empty.
  - `markExternalProductsMissing(client, dataSourceId: number, catalog: { externalIds: string[]; complete: boolean }): Promise<{ marked: number; cleared: number; skipped: boolean }>` — `skipped` when `!complete || externalIds.length === 0`; else `missing_since = COALESCE(missing_since, now())` for the source's rows not in the list and `NULL` for rows in it.
  - Job metrics gain `listingsMarkedMissing`, `listingsCleared`.

- [ ] **Step 1:** Tests: incomplete catalog → `skipped`, no UPDATE issued; empty list → `skipped`; complete catalog → one UPDATE marking absent ids, one clearing present ids, both scoped to `data_source_id`; a re-seen id is cleared. Connector test (`fetch` stubbed): 30 full pages → `complete: false`; 2 pages with the second short → `complete: true` and ids from both pages even when `searchTerm`/`recentDays` filter the records.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement; call it once per job (first invocation, not continuations). **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: mark connector listings missing from a complete Shopify catalog`.

### Task 5: Buy-link selection

**Files:**
- Modify: `src/lib/buy-link.ts` (`BuyLinkCandidate`, `BUY_LINK_CANDIDATES_SQL`, `compareBuyLinkCandidates`, `selectBuyFromBrandLink`), the listing order in `src/functions/polishes.ts:1634` and `src/lib/product-text-backfill.ts:118`
- Test: `tests/buy-link.unit.test.cjs`

**Interfaces:**
- Consumes: `missing_since` (Task 1).
- Produces: `src/lib/data-source-kind.ts` with `sourceKindFromMetadata(metadata: unknown): "brand_store" | "retailer"` (retailer only for the exact value `"retailer"`; tests for `{kind:"retailer"}`, `{}`, `null`, `{kind:"RETAILER"}` in `tests/data-source-kind.unit.test.cjs`). `BuyLinkCandidate` gains `missingSince?: Date | string | null`, `available?: boolean | null` (SQL: `true` when any `normalized_json->'variants'` element has `available = true`, `false` when variants exist and none is, `null` when there are none), `sourceKind?: "brand_store" | "retailer"`. Selection drops `missingSince != null`; order: `available !== false` first, then `brand_store`, then the existing order. The two listing-order queries put retailer listings after brand-store listings.

- [ ] **Step 1:** Tests: missing listing never chosen even when newest; sold-out brand store vs available retailer → retailer; both available → brand store even when the retailer was seen later; `available: null` ranks with available; all missing → no link.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; existing buy-link tests unchanged.
- [ ] **Step 5:** Commit `feat: skip missing listings and prefer live brand-store buy links`.

### Task 6: Source-kind write rules and brand-store takeover

**Files:**
- Modify: `src/lib/data-source-kind.ts`, `src/lib/ingestion-repo.ts` (`materializePreparedHoloTacoRecord`, the detection skip next to `findRecordsWithUnchangedDetectedHex`)
- Test: `tests/data-source-kind.unit.test.cjs`

**Interfaces:**
- Consumes: `sourceKindFromMetadata` (Task 5).
- Produces:
  - `planListingWrites(input: { sourceKind: "brand_store" | "retailer"; shadeCreated: boolean; shadeAuthority: "brand_store" | "retailer"; shadeHasBrandStoreImages: boolean; shadeHasDetectedHex: boolean }): { writeCategory: boolean; linkGallery: boolean; runDetection: boolean; takeOver: boolean; setAuthority: "brand_store" | "retailer" | null }`:
    - shade created by this listing → all writes `true`, `takeOver: false`, `setAuthority` = the source kind;
    - brand store on a `retailer` shade → all writes `true`, `takeOver: true` (overwrite finishes/detected hex, unlink retailer gallery swatches), `setAuthority: "brand_store"`;
    - brand store on a `brand_store` shade → all writes `true`, `takeOver: false`, `setAuthority: null` (today's behavior);
    - retailer on an existing shade → `writeCategory: false`, `linkGallery: !shadeHasBrandStoreImages`, `runDetection: !shadeHasDetectedHex`, `takeOver: false`, `setAuthority: null`.
  - `findShadesWithDetectedHex(candidates: UnchangedImageCandidate[]): Promise<Set<string>>` — like `findRecordsWithUnchangedDetectedHex` without the same-source image condition; used for retailer sources so their AI call is skipped before it is paid for.

- [ ] **Step 1:** Unit tests for the planner: every combination of its inputs, asserting the four cases above; plus a test for `unlinkRetailerGallerySwatches(client, shadeId)` (unlinks `source_gallery` swatches whose image belongs to a retailer source, skipping swatches whose image has a `color_training_sample` label or `color_features`, like `pruneStaleGallerySwatches`).
- [ ] **Step 2:** FAIL. **Step 3:** Implement and wire: skip `applyRuleProductCategory`, the gallery link/prune block and the AI call per the plan; on `takeOver` treat the write as `overwriteDetectedHex` for this shade, replace a non-admin `finishes` list with the brand store's resolution, call `unlinkRetailerGallerySwatches`; write `setAuthority` when non-null. Finishes/hex `COALESCE` rules are otherwise unchanged. **Step 4:** PASS; `npm run typecheck`.
- [ ] **Step 5:** Local end-to-end: enable the source locally, run a Polish Pickup ingestion job from Admin Jobs, then check with SQL that an existing Lemming/Stella Chroma/Sweet & Sour shade gained a `shade_source_product` row and kept its category and gallery, and new brands appear only for vendors with no brand or alias. Then run the Lemming Lacquer source and check that a Polish Pickup-created Lemming shade it lists flips to `catalog_authority = 'brand_store'` with the brand's gallery.
- [ ] **Step 6:** Commit `feat: retailer listings fill only empty catalog fields`.

### Task 7: Docs and PR

**Files:** `CLAUDE.md` (Architecture: retailer sources, buy-link order, listing freshness; ingestion connector bullet), `packages/functions/README.md` (connector + buy-link sections), `docs/indie-sources-2026-10.md` (Polish Pickup entry with the notes text), `docs/schema.sql` (done in Task 1).

- [ ] **Step 1:** Run the `docs-sync-checker` and `access-control-reviewer` agents on the branch; fix what they find.
- [ ] **Step 2:** `npm run lint && npm run typecheck && npm run test --workspace=swatchwatch-functions` → all pass.
- [ ] **Step 3:** Commit `docs: retailer listings and Polish Pickup`, push, open the PR against `dev`.

## Not in this plan (later, each its own plan)

- **Where to buy:** return every live listing per shade (seller, price, sale via `compareAtPrice > price`, sold out, last seen) and show it on the detail page.
- **Deals:** price snapshots per listing, "cheaper than usual / than the brand store" for wishlisted shades, notifications. Needs reliable cross-seller matching first.
- **Scheduling:** there is no ingestion timer; Polish Pickup is run by hand from Admin Jobs on the opening Friday and again after it closes (the second run marks the month's listings missing).
- **Dam Nail Polish names:** its store titles carry descriptions (`Name - Red Reflective Glitter Nail Polish`), so its Polish Pickup shades will not match until a Dam title parser exists.
- **Non-Shopify link checks:** a page-level checker reading schema.org `Offer.availability` and treating redirects off the product page as gone.
- **Best detection image across sources:** evaluate with `npm run eval:hex` before changing production.
