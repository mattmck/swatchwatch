# Brand Sources Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ingest every source the November 2026 evaluation found: the three multi-brand resellers (Beyond Polish, Harlow & Co, Hypnotic Polish), the open Shopify brand stores (clause-free ones enabled, clause ones registered pending approval), the Polish Pickup shop, and the non-Shopify platforms (Google product feeds, OPI's sitemap + JSON-LD, WooCommerce Store API, Big Cartel), so the catalog gains the majors, ILNP and KBShimmer, and the long tail of indie makers.

**Architecture:** Everything funnels into the one materializer (`materializeHoloTacoRecords` in `packages/functions/src/lib/ingestion-repo.ts`) through the `ConnectorProductRecord` shape the generic Shopify connector already produces, so new platforms are new connectors and new store kinds are connector options, never new materializers. Phase A makes the pipeline source-kind aware (protocol-driven dispatch instead of `endsWith("Shopify")`, a `data_source.metadata.kind` of `brand | reseller | feed` with retailer rules: adopt the brand's existing shade, fill-only catalog data, images only when permitted, brand-store buy links first, and model calls only for the records a page actually returns). Phase B adds retailer mode to the generic Shopify connector (vendor aliases, a title parser, vendor-code aliases) and the three retailer sources. Phase C registers the brand stores with the per-store filters the probe showed they need. Phase D adds Polish Pickup. Phase E adds four connectors (`product-feed`, `sitemap-jsonld`, `woocommerce-store`, `big-cartel`) that emit the same record shape and register their first sources pending approval. Each phase is its own PR to `dev` (D24); the owner's emails run alongside.

**Tech Stack:** Azure Functions v4 (Node 22, TypeScript strict), Postgres (node-pg-migrate style SQL migrations), node:test against `dist/` (`npm run test --workspace=swatchwatch-functions`), `fast-xml-parser` (new dependency, Phase E), the admin console's existing Admin Jobs tab (no UI work: sources appear from `GET /api/ingestion/sources` grouped by protocol).

**Spec:** `docs/brand-sources-evaluation-2026-11.md` (§3 landscape with the measured counts, §4 strategies S1–S8, §5 order, §6 owner decisions, §7 outreach template, appendix A probe). Earlier context: `docs/indie-sources-2026-10.md` (how a store gets registered, verified and enabled), `docs/decisions-2026-10.md` D2 (approval basis recorded in `data_source.metadata.notes`), D12 (vendor hex), D23 (product categories).

**Unification with PR #497 (dev, 2026-11-06, `docs/superpowers/plans/2026-11-06-polish-pickup-retailer-listings.md`):** dev already carries `data_source.metadata.kind = 'retailer'` (absent = brand store), `shade.catalog_authority` (`brand_store` | `retailer`, migration 20261106120000000), `external_product.missing_since`, buy-link ranking (missing dropped, sold-out last, brand before retailer), `lib/connectors/shopify-title.ts` with `SHOPIFY_STORE_TITLE_PARSERS`, the `PolishPickupShopify` source with its filter and title parser, and brand-alias vendor matching. This plan uses that vocabulary everywhere: the kind key is `metadata.kind` with values `retailer` | `feed` | absent, the word is *retailer* (the evaluation's "reseller" means the same thing), retailer/feed-created shades get `catalog_authority = 'retailer'`, a brand source's step-2 adoption targets shades with `catalog_authority = 'retailer'` and applies dev's authority takeover, the buy-link order is dev's chain with `feed` ranked between brand and retailer, and retailer title parsers register in `SHOPIFY_STORE_TITLE_PARSERS`. Phase A was merged onto dev with these rules (PR #502).

**Calls made in this plan (the spec leaves them open or asks the owner):**
- Spec §6 decision 1 (retailer sources): implemented as `kind: "retailer"` with `imagesPermitted` defaulting to `false`; the owner flips it per source in `data_source.metadata` once a store's OK covers images. No migration needed to flip.
- Spec §6 decision 2 (buy-link priority): brand-store listings win over retailer listings; among equals today's rule (newest seen) holds.
- Spec §6 decision 3 (gel in scope): **out of scope by default**; the Beyond Polish filter keeps only lacquer-typed products unless `data_source.metadata.includeGel = true`, so the owner can change the decision without code. No `shade.system` column in this plan.
- Spec §6 decision 4 (discontinued listings): kept; the retailer connector stores `discontinued: true` in `normalized_json` (no UI in this plan).
- Spec §6 decision 5 (affiliate programme): the feed connector is built (needed for brand-supplied feeds, S7); affiliate link decoration, disclosure UI and network onboarding are a later plan.
- Spec §6 decision 6: Polish Pickup gets a store filter and a source row registered disabled; the roster script is the outreach tool either way.
- Spec S8 (user-driven growth, Open Beauty Facts write-back): already built except the OBF contribution, which is out of this plan.
- A retailer source never creates a `brand` row whose name is a known alias of an existing brand (`vendorAliases` in metadata, Task 5); an unknown vendor still creates its brand, as every store does today.
- Phase C registers stores with the facts from appendix A of the spec; a store filter is written only for stores whose first `products.json` page showed empty or non-polish `product_type` values, from a trimmed fixture, the way `store-filters/sweet-and-sour.ts` was.
- Terms checks in Phase E (OPI's terms page, Big Cartel's API License Agreement) are owner reading steps written into the task; code is registered pending approval until the note is in `metadata.notes`.

## Global Constraints

- Every new `data_source` row is registered in `docs/seed_data_sources.sql` **and** a migration that upserts it with the `insertedByMigration` / `enabledByMigration` stamps and the Down rules of `20261023021845964_add-approved-indie-shopify-sources.sql`; `npm run generate:types` after editing the seed; `tests/shopify-indie-sources.unit.test.cjs` must still pass (a source in `SHOPIFY_SOURCES_PENDING_APPROVAL` is seeded `enabled = false` with `"pendingApproval": true`).
- A source whose terms carry an automated-access clause (Shopify default or its own) is registered **disabled and pending** until the owner records the store's written OK in `metadata.notes` with the sentence from spec §7 ("Acceptable use confirmed by <name, role> at <store> on <date> via <channel>: <summary>"). A source whose terms carry no clause is enabled like Night Owl (D2) with the probe facts in `metadata.verification`.
- Catalog write rules hold: D12 (`planIngestedVendorHex`, never replace a `manual_label` hex), `finishes_source = 'admin'` never rewritten, `product_category_source = 'admin'` never changed, the legacy `shade.finish` never rewritten on an existing shade.
- Ingestion writes catalog rows only, never `user_inventory_item` rows.
- Every connector sends `User-Agent: SwatchWatch/connector-ingestion (+https://github.com/mattmck/swatchwatch)`, waits at least 1 s between requests to the same host when it fetches more than one page or URL (`sleep` as in `shopify-generic.ts` retries), and honours `SHOPIFY_CONNECTOR_REQUEST_TIMEOUT_MS` / `_MAX_RETRIES` / `_RETRY_BASE_DELAY_MS` (reuse the same `parseIntEnv` values).
- Functions tests: `packages/functions/tests/*.unit.test.cjs` against `dist/` (`npm run build:functions` first), no database; fixtures are trimmed `products.json` snapshots under `tests/fixtures/` named `<store>-products.json` with the fetch date in the test comment. Shared tests: `*.test.ts` beside the module.
- Docs rows per CLAUDE.md "Documentation Maintenance": a new env var goes in CLAUDE.md, `packages/functions/README.md` and `local.settings.json.example`; a new connector or source goes in `packages/functions/README.md` → "Connector Ingestion Jobs"; a new protocol in `packages/shared/README.md`; the CLAUDE.md Architecture Overview gets the retailer rule.
- Commits: Conventional Commits, each ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. PRs target `dev`.
- Nothing in this plan contacts a store; the owner sends the emails (spec §7) and records the replies.

## Review Focus

1. **A retailer run must never overwrite brand-store data.** Orly, China Glaze, Color Club, Cirque, Cracked and Starrily exist from their own stores; a Beyond Polish or Harlow run must only add a listing, barcodes and fill-only data to those shades (vendor hex, detected hex, finishes, images untouched when present). Pinned in Task 3 (`adoptExistingShades` tests) and Task 7 (fixture run asserts zero `hexOverwritten`).
2. **Set, combo and duo listings must not become shades.** Beyond Polish's `Gel & Lacquer Polish` combos, `Nail Set` / `TIER COMBO` tags, "Lacquer Set - …", "Combo", "Duo", "Trio", "Collection" titles; Harlow's "It's Fall Good Collection"; Hypnotic's grab bags. Pinned in Tasks 6, 7, 8 (fixture lists of rejected titles).
3. **Vendor spellings must not create duplicate brands.** "ORLY" vs "Orly", "Lippmann" vs "Deborah Lippmann", "Sunday Studio" vs "Sundays", "DND - Daisy Nail Design" vs "DND", "Cirque" vs "Cirque Colors", "Harmony" vs "Gelish", "ella+mila" vs "Ella+Mila". Pinned in Task 5 (`resolveRetailerVendor` tests) with the alias maps in each source's metadata (Tasks 6–8).
4. **Images are stored only when the source permits it.** A retailer source with `imagesPermitted` absent or `false` must make no blob upload and link no swatch, while the shade still materializes with `name_hex`. Pinned in Task 3 (`storeImages: false` test) and Task 7.
5. **A 17,508-product store must not multiply model calls.** One color-name lookup per accepted record per job, never per page; a job on the Beyond Polish fixture pages makes at most `records.length` lookups. Pinned in Task 2.
6. **A feed GTIN with a wrong check digit or a non-GTIN id must not poison the barcode table.** The feed connector passes GTINs through `normalizeGtin` (`lib/barcodes.ts`), drops rejects, keeps wrong-check-digit values the way Shopify variants do. Pinned in Task 14.

---

## Phase A — Pipeline groundwork (one PR)

### Task 1: Protocol-driven connector dispatch

**Files:**
- Modify: `packages/shared/src/types/ingestion.ts` (`ConnectorProtocol` union)
- Modify: `scripts/generate-connector-types.mjs` (`protocolForSource`)
- Modify: `packages/functions/src/lib/connectors/generated-types.ts` (regenerated)
- Modify: `packages/functions/src/functions/ingestion.ts:149-176` (`hasRunnableConnector`, `createConnector`) and the two `payload.request.source.endsWith("Shopify")` checks at lines 814 and 927
- Create: `packages/functions/src/lib/connectors/registry.ts`
- Test: `packages/functions/tests/connector-registry.unit.test.cjs`
- Docs: `packages/shared/README.md` (protocol list), `packages/functions/README.md` → "Connector Ingestion Jobs" → "Current source support"

**Interfaces:**
- Produces: `ConnectorProtocol = "HoloTaco" | "Shopify" | "OpenBeautyFacts" | "MakeupAPI" | "GS1" | "ProductFeed" | "SitemapJsonLd" | "WooCommerce" | "BigCartel" | "Custom"`; in `registry.ts`: `protocolOf(source: SupportedConnectorSource): ConnectorProtocol`, `isRunnableProtocol(protocol): boolean` (true for HoloTaco, Shopify, OpenBeautyFacts, MakeupAPI, ProductFeed, SitemapJsonLd, WooCommerce, BigCartel), `materializesShadeProducts(source): boolean` (true for every runnable protocol except OpenBeautyFacts and MakeupAPI: these are the sources whose records go through `materializeHoloTacoRecords`).
- Generator rule: suffix `Shopify` → Shopify (except `HoloTacoShopify`), `Feed` → ProductFeed, `Sitemap` → SitemapJsonLd, `WooCommerce` → WooCommerce, `BigCartel` → BigCartel; the existing fixed names keep their protocols; everything else Custom.

- [ ] **Step 1: Write the failing test**

```js
// tests/connector-registry.unit.test.cjs
const { protocolOf, isRunnableProtocol, materializesShadeProducts } = require("../dist/lib/connectors/registry");
it("maps suffixes to protocols", () => {
  assert.equal(protocolOf("MooncatShopify"), "Shopify");
  assert.equal(protocolOf("HoloTacoShopify"), "HoloTaco");
  assert.equal(protocolOf("OpenBeautyFacts"), "OpenBeautyFacts");
});
it("only shade-product protocols materialize", () => {
  assert.equal(materializesShadeProducts("MooncatShopify"), true);
  assert.equal(materializesShadeProducts("OpenBeautyFacts"), false);
  assert.equal(materializesShadeProducts("MakeupAPI"), false);
  assert.equal(materializesShadeProducts("CosIng"), false);
});
it("the generator and the registry agree on every supported source", () => {
  for (const s of SUPPORTED_SOURCES) assert.equal(protocolOf(s), SOURCE_PROTOCOL_MAP[s]);
});
```

- [ ] **Step 2: Run it to verify it fails** — `npm run build:functions && node --test packages/functions/tests/connector-registry.unit.test.cjs` → FAIL (module not found).
- [ ] **Step 3: Add the protocols to `ConnectorProtocol`, the suffix rules to `protocolForSource` in the generator, run `npm run generate:types`, create `registry.ts` reading `SOURCE_PROTOCOL_MAP`.**
- [ ] **Step 4: Replace the `endsWith("Shopify")` checks** in `ingestion.ts` (`hasRunnableConnector` → `isRunnableProtocol(protocolOf(source))`; the materialization gates at lines 814 and 927 → `materializesShadeProducts(source)`). `createConnector` keeps its Shopify branch as `protocolOf(source) === "Shopify"`; the new protocols throw `No connector available` until Phase E adds them (the registry says runnable, the factory says not yet: the sources endpoint must not list them, so `hasRunnableConnector` also requires `createConnector` to succeed: implement as a `CONNECTOR_FACTORIES: Partial<Record<ConnectorProtocol, (source, baseUrl, currency) => ProductConnector>>` map in `ingestion.ts` (today's three arguments; Task 3 widens the last one to `SourceSettings`) and `hasRunnableConnector = protocol in CONNECTOR_FACTORIES`).
- [ ] **Step 5: Run the test and the whole suite** — `npm run test --workspace=swatchwatch-functions` → PASS (the generated-types and indie-sources tests included).
- [ ] **Step 6: Docs + commit** — `git commit -m "refactor(ingestion): dispatch connectors and materialization by protocol"`.

### Task 2: Gate first, enrich only the page window

**Files:**
- Modify: `packages/functions/src/lib/connectors/shopify-generic.ts` (`pullProducts`, `toNormalizedRecord`)
- Test: `packages/functions/tests/shopify-generic-enrichment.unit.test.cjs`

**Interfaces:**
- Produces: `gateShopifyProduct(product, source, settings?: SourceSettings): { accept: boolean; category: ProductCategory }` (sync; `settings` is forwarded to the store filter once Task 7 makes filters settings-aware: store filter + `classifyIngestedProduct` + `isBundle`, exactly the current decision) and `enrichShopifyRecord(product, context): Promise<ConnectorProductRecord>` (the current AI color-name lookup and record build). `pullProducts` gates and sorts all products (timestamps come from the raw product, not the record), applies the text/recent filters on raw fields, windows by page, then enriches only the window. `metadata.sourceCount` and `fetchedProductCount` keep their meaning.

- [ ] **Step 1: Write the failing test** — intercept `detectHexFromColorName` (require-cache replacement as in `tests/shopify-generic-hex.unit.test.cjs`) with a counter; feed a 600-product in-memory catalog through `catalogCache` with `pageSize: 250, page: 2`; assert the counter equals the number of records returned (≤ 250), and the same records come back when the call is repeated with the same page (order stable).
- [ ] **Step 2: Run to verify it fails** (today the counter is ~600 per call).
- [ ] **Step 3: Split `toNormalizedRecord` into `gateShopifyProduct` + `enrichShopifyRecord`; make `pullProducts` gate → filter → sort → window → enrich.** Sorting uses `product.published_at / created_at / updated_at` (same `toTimestamp`). The text filter reads title, vendor, handle, tags.
- [ ] **Step 4: Run the test and the existing Shopify tests** → PASS.
- [ ] **Step 5: Commit** — `perf(ingestion): enrich only the page window of a Shopify catalog`.

### Task 3: Source kinds, fill-only adoption, image permission, buy-link priority

**Files:**
- Modify: `packages/functions/src/lib/ingestion-repo.ts` (`DataSourceRecord` / `listDataSourcesWithSettings` expose `metadata`; `HoloTacoMaterializationOptions` gains `storeImages?: boolean` and `adoptExistingShades?: boolean`; `materializePreparedHoloTacoRecord` shade lookup; `prepareHoloTacoImageData` skips uploads when `storeImages === false`)
- Create: `packages/functions/src/lib/source-settings.ts`
- Modify: `packages/functions/src/functions/ingestion.ts` (pass the settings into `createConnector` and `materializeHoloTacoRecords`)
- Modify: `packages/functions/src/lib/buy-link.ts` (`BuyLinkCandidate.kind`, `BUY_LINK_CANDIDATES_SQL`, `compareBuyLinkCandidates`)
- Test: `packages/functions/tests/source-settings.unit.test.cjs`, `packages/functions/tests/ingestion-repo-adopt-existing.unit.test.cjs` (fake client keyed on SQL text, as `ingestion-repo-swatch-linking.unit.test.cjs`), `packages/functions/tests/buy-link.unit.test.cjs` (extend)
- Create: `docs/queries/ambiguous-listings.sql` (read-only: `(data_source_id, external_id)` pairs of enabled sources linked to more than one distinct unmerged shade, with the shade ids and names; the owner runs it on dev and prod before the first reseller job, owner checklist item 0)
- Docs: `packages/functions/README.md` ("Buy from brand" selection rule; a new "Source kinds" paragraph under Connector Ingestion Jobs), CLAUDE.md Architecture Overview (Buy from brand paragraph: brand before reseller)

**Interfaces:**
- Produces (`source-settings.ts`): `SourceKind = "brand" | "retailer" | "feed"`; `SourceSettings { kind: SourceKind; imagesPermitted: boolean; includeGel: boolean; vendorAliases: Record<string, string>; currency: string | null; brand: string | null; maxPages: number | null; feedUrl: string | null; feedAuthEnv: string | null; sitemapUrl: string | null; productUrlPrefixes: string[]; subdomain: string | null }`; `readSourceSettings(metadata: unknown): SourceSettings` (`kind` trimmed and lower-cased; a missing key means brand, but an explicitly unknown value throws `Unknown kind "<value>" on data_source <name>`, which fails the job rather than silently granting brand-style images and overwrites) with defaults `kind: "brand"`, `imagesPermitted: kind === "brand"`, `includeGel: false`, `vendorAliases: {}` (keys lower-cased), `currency` as today, `brand` = `metadata.brand` (used by connectors whose records carry no vendor), `maxPages` = positive integer or null, the five connector keys read as-is from `metadata` (string / string[] or their empty defaults). Every connector factory receives the whole `SourceSettings`, so Phase E connectors read their configuration from it.
- Materialization, shade lookup for every source: a **brand** source first tries (1) today's exact match (brand + name + legacy `finish` + `collection`); a **retailer/feed** source skips the exact-match shortcut (its records carry null `finish`/`collection`, so `LIMIT 1` would attach a holographic listing to a same-name creme shade) and always goes through (2); (2) the candidates `SELECT shade_id, finishes, status FROM shade WHERE brand_id = $1 AND product_line_id IS NULL AND lower(shade_name_canonical) = lower($2) AND status IN ('active', 'excluded') AND merged_into_shade_id IS NULL` filtered by source kind: a **retailer/feed** source (`adoptExistingShades: true`) considers all of them; a **brand** source considers only those with `finish IS NULL AND collection IS NULL` (shades a retailer or feed created, which never set the legacy key). The finish check applies to every candidate set: keep the candidates whose `finishes` share a finish family with the record's canonical finishes, or whose `finishes` are empty, or when the record has none (families from the loaded `finishCatalog.families`, built by `buildFinishFamilyMap` in `swatchwatch-shared`); exactly one left → adopt; none → create; **several → skip the record** with a warning (`{ brand, name, candidateShadeIds }`) through `progressLogger` and `metrics.ambiguousShadesSkipped` (the MakeupAPI rule: no shade and no listing is written, so re-running never multiplies shades and the same product is never linked to two shades), never pick by listing count. Before any of this, step (0): when exactly one `shade_source_product` row links this `(data_source_id, external_id)` to an unmerged shade of any status (the listing is authoritative, so an admin-`excluded` shade is reused rather than duplicated), that shade wins outright; several such links (a merge left two, or an older run linked twice) → a **brand** source falls back to today's exact identity match only when that shade is one of the linked shades (a third link is never added; otherwise it skips with the ambiguity metric), a retailer/feed source skips the record with the same warning and metric as an ambiguous candidate set. Brand step (2) is narrower than "null finish and collection": the candidate must carry `catalog_authority = 'retailer'` (a shade a retailer or feed created), so a brand's re-release with the same name still gets its own shade; adopting it applies dev's authority takeover (the brand writes as creator, retailer gallery swatches are unlinked with the `pruneStaleGallerySwatches` protections, `catalog_authority` becomes `brand_store`). Candidate sets (2) include `active` and `excluded` shades. (3) nothing → create. An adopted shade gets `recordShadeSourceProduct` + `materializeProductBarcodes`; when the source is not a brand source the catalog write is **strictly fill-only** (`overwriteDetectedHex` forced `false` **at the job level in the worker**, so the AI batch submission and the poller's apply step inherit it; `finishes` written only when the shade has none; `detected_finishes` left alone when set; `applyRuleProductCategory` skipped, so a retailer's "Top Coat" tag never flips a brand shade's category; a brand source keeps the request's flag and today's merge/category behaviour); the swatch/gallery block runs only when the shade has no `source_product` swatch yet, or that swatch's image belongs to this source, or the source is a brand source (retailer images never replace brand images). **Resolution happens before detection:** `prepareHoloTacoImageData` resolves every record with the same lookup helper first and carries the result (`found` shade id / `create` / `ambiguous`) into materialization, so (a) an `ambiguous` record gets no upload, no detection and no batch entry, (b) the admin-category gate reads the resolved shade's category directly (an adopted topper/accessory blocks detection on the first run, not only from the second), (c) a non-brand source whose resolved shade already carries another source's `source_product` swatch skips the upload and the detection (nothing would be written), and (d) the materializer uses a pre-resolved `found` shade (re-running the lookup only if that shade has disappeared) and a pre-resolved `ambiguous` result as they are, while a pre-resolved `create` is **revalidated inside the write transaction** (an earlier record of the same chunk may have created the shade): a revalidation that finds one shade adopts it with the same fill-only rules (the detection that already ran is applied fill-only, never overwriting), one that is ambiguous skips the record, and only a still-empty result inserts. A revalidation that changes the outcome happens after the image phase, so the upload and detection already done for that record are either applied fill-only to the adopted shade or discarded on a skip: one wasted upload/detection per such record is accepted; no gate is re-run.
- Every later step that must find the record's shade again uses the listing, not the legacy identity key: the AI batch / sync-fallback apply step (`applyAiBatchShadeDetections`) and the two pre-detection lookups (`findAdminProductCategories`, so an adopted shade an admin marked topper/accessory blocks detection and hex filling, and `findRecordsWithUnchangedDetectedHex`) resolve the shade through the single `shade_source_product` row for `(data_source_id, external_id)` first; the identity fallback runs only for **brand** sources, so a retailer/feed record that materialization skipped as ambiguous (no listing written) is never applied to one of its candidates. Tests: a batch result whose listing points at a shade with a different legacy finish is applied there; a retailer batch result with no listing and two same-name candidates applies nothing (`noShadeMatch` 1).
- A record whose `normalized.brand` is empty is skipped with a warning for every source except `HoloTacoShopify` (today's `"Holo Taco"` fallback in `resolveHoloTacoBrandName` stays for that source only).
- `storeImages: false`: `prepareHoloTacoImageData` returns `preparedImage` with no `storageUrl`/`checksumSha256` and no AI detection (so hex detection also skips), and `metrics.imageUploads` stays 0.
- Buy link: `BUY_LINK_CANDIDATES_SQL` adds `COALESCE(ds.metadata ->> 'kind', 'brand') AS "kind"`; `compareBuyLinkCandidates` orders `brand` < `feed` < `reseller` before the existing keys.

- [ ] **Step 1: Write the failing tests**

```js
// source-settings
assert.deepEqual(readSourceSettings({}), { kind: "brand", imagesPermitted: true, includeGel: false, vendorAliases: {}, currency: null, brand: null, maxPages: null, feedUrl: null, feedAuthEnv: null, sitemapUrl: null, productUrlPrefixes: [], subdomain: null });
assert.equal(readSourceSettings({ kind: "retailer" }).imagesPermitted, false);
assert.equal(readSourceSettings({ kind: "retailer", imagesPermitted: true }).imagesPermitted, true);
assert.deepEqual(readSourceSettings({ vendorAliases: { ORLY: "Orly" } }).vendorAliases, { orly: "Orly" });
assert.equal(readSourceSettings({ kind: " Retailer " }).kind, "retailer"); assert.throws(() => readSourceSettings({ kind: "wholesale" }), /Unknown kind/);
// adopt-existing (retailer source): first-time listing whose only same-name candidate is status 'excluded' → that shade adopted, no INSERT INTO shade
// buy-link: a brand candidate seen a year ago beats a retailer candidate seen today
assert.equal(selectBuyFromBrandLink([reseller(today), brand(lastYear)]).url, brand(lastYear).url);
// adopt-existing (retailer source): record for brand "Orly" name "Velvet Dreams" with an existing shade (finish "creme") → no INSERT INTO shade, one shade_source_product insert, UPDATE shade with overwrite=false
// adopt-existing (retailer source): two active same-name shades, finishes ["creme"] and ["holographic"], record finishes ["holographic"] → the holographic one adopted; record finishes [] → no INSERT INTO shade, no shade_source_product insert, a warning naming both candidate ids, metrics.ambiguousShadesSkipped 1
// adopt-existing (any source): a shade_source_product row already links this external id to shade 41 (finish "holographic") while the exact match would find shade 40 → shade 41 is used, no INSERT (any status, so an excluded listed shade is reused); two unmerged links (41 and 42): a retailer source → record skipped, warning with both ids, ambiguousShadesSkipped 1; a brand source → falls back to the exact identity match only if it is among the linked shades (40 linked → used; 40 not linked → skipped with ambiguousShadesSkipped 1)
// resolution before detection: a first-run retailer record that resolves to an adopted shade with an admin topper category → 0 AI calls, 0 uploads; an ambiguous record → 0 uploads, 0 AI calls, absent from the batch input file; a retailer record whose resolved shade already has another source's product image → 0 uploads / 0 AI calls, while a brand source still uploads
// brand-source same-chunk: brand records A and B (same name, different collections) with a retailer-created shade X → A adopts X, B gets its own shade (the brand lookup is re-run inside the write transaction)
// adopt-existing (brand source): one same-name shade with finish NULL and collection NULL → adopted and the UPDATE keeps the request's overwrite flag; a same-name shade with finish "creme" → not adopted (INSERT INTO shade)
// no brand: a MooncatShopify record with normalized.brand "" → skipped with a warning, no INSERT INTO brand; a HoloTacoShopify record without brand → "Holo Taco"
// worker: a retailer job requested with overwriteDetectedHex true calls materializeHoloTacoRecords with overwriteDetectedHex false (stub the materializer)
```

- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement `source-settings.ts`; thread `SourceSettings` through `ingestion.ts` (the `CONNECTOR_FACTORIES` entries take `settings: SourceSettings` instead of `currency`; `ShopifyGenericConnector`'s constructor `options` gains `settings?: SourceSettings` and keeps `currency` for existing callers and tests); add the two options to `HoloTacoMaterializationOptions`; implement the fallback lookup and the image gate; extend the buy-link SQL and comparator.** The worker sets `storeImages: settings.imagesPermitted`, `adoptExistingShades: settings.kind !== "brand"` and `overwriteDetectedHex: settings.kind === "brand" ? request.overwriteDetectedHex : false`. The worker reads the source through `getDataSourceByName` (`lib/ingestion-repo.ts`), whose query today returns the currency but not `metadata`: extend it (and `DataSourceRecord`) to return `metadata`, and build the settings from that row, so a retailer job uses its seeded metadata rather than brand defaults (the worker test asserts the retailer row's metadata reaches `materializeHoloTacoRecords` as `storeImages: false`).
- [ ] **Step 4: Run the tests** → PASS; `npm run typecheck`.
- [ ] **Step 5: Docs + commit** — `feat(ingestion): source kinds with fill-only adoption, image permission and buy-link priority`.

## Phase B — Retailer mode and the three resellers (two PRs: Tasks 4–6, then 7–9)

### Task 4: Retailer title parser

**Files:**
- Create: `packages/functions/src/lib/connectors/retailer-title.ts` (Task 4 created it as `reseller-title.ts`; Task 5 renames it with `git mv` and renames the test and exports to match)
- Test: `packages/functions/tests/retailer-title.unit.test.cjs`
- Fixture data: inline in the test (the titles below are real Beyond Polish, Harlow & Co and Hypnotic Polish titles from 2026-11-08)

**Interfaces:**
- Produces: `parseRetailerTitle(title: string, brand: string): RetailerTitle | null` where `RetailerTitle { shadeName: string; productLine: string | null; vendorCode: string | null; isSet: boolean }`. Rules, in order: (1) strip a leading `*PRE-ORDER*` / `PRE-ORDER:` marker; (2) split on ` - `; (3) drop the leading segment when it equals the brand (case-insensitive, `+`/`&` kept) or starts with the brand followed by a space, keeping the remainder of that segment as the first segment ("OPI Infinite Shine" → "Infinite Shine", "Essie Eternal Optimist 0.5 oz" → "Eternal Optimist 0.5 oz"); (4) a segment matching `^#\s*[A-Z0-9-]+$` is the vendor code (strip `#`); (5) strip a trailing size `(\d*\.?\d+\s*(oz|ml)\.?)$` and a trailing `\d+X Nail Lacquer` from every segment; drop segments left empty; (6) `isSet` when any segment matches `\b(set|combo|duo|trio|quad|collection|kit|bundle)\b` (case-insensitive) or the whole title starts with "Lacquer Set"; (7) a segment is a *line* when it matches `\b(nail lacquer|nail polish|lacquer|polish|infinite shine|nature strong|vinylux|shellac|lakur|pure colour|patent shine|gel lab pro|gel couture|breathable|enhanced colour)\b` (case-insensitive) and it is not the only segment; (8) `shadeName` = the last non-line segment, with a parenthesised finish `\((magnetic|thermal|flakie|shimmer|holo)\)$` stripped; `productLine` = the line segments joined by " "; null when none. Returns null when no shade name remains.

- [ ] **Step 1: Write the failing test** with these assertions:

```js
p("OPI Nail Lacquer - No Room for the Blues 0.5 oz - #NLB83", "OPI") → { shadeName: "No Room for the Blues", productLine: "Nail Lacquer", vendorCode: "NLB83", isSet: false }
p("OPI Infinite Shine - Pink In Bio - #ISLS001", "OPI") → { shadeName: "Pink In Bio", productLine: "Infinite Shine", vendorCode: "ISLS001" }
p("Zoya - Fairleigh .5 oz. - #ZP1210", "Zoya") → { shadeName: "Fairleigh", productLine: null, vendorCode: "ZP1210" }
p("Essie Eternal Optimist 0.5 oz - #144", "Essie") → { shadeName: "Eternal Optimist", vendorCode: "144" }
p("CND - Vinylux Candlelight 0.5 oz - #387", "CND") → { shadeName: "Vinylux Candlelight" ... }  // one segment, kept whole; productLine null
p("KBShimmer - Nail Polish - Mix It Up", "KBShimmer") → { shadeName: "Mix It Up", productLine: "Nail Polish" }
p("Cirque Colors - Nail Polish - Morningtide 0.37 oz", "Cirque Colors") → { shadeName: "Morningtide" }
p("Londontown - Lakur Enhanced Colour - Dream State 0.4 oz", "Londontown") → { shadeName: "Dream State", productLine: "Lakur Enhanced Colour" }
p("butter LONDON - Pure Colour - Hottie Tottie - 21X Nail Lacquer", "butter LONDON") → { shadeName: "Hottie Tottie", productLine: "Pure Colour" }
p("ella+mila - Pirouette - .45oz", "ella+mila") → { shadeName: "Pirouette" }
p("Sundays - Nail Polish - No. 38", "Sundays") → { shadeName: "No. 38" }
p("*PRE-ORDER* Cuticula Nail Lacquer - Broken Fairytales", "Cuticula Nail Lacquer") → { shadeName: "Broken Fairytales" }
p("Cosmic Polish - Beyond the Infinite (Magnetic)", "Cosmic Polish") → { shadeName: "Beyond the Infinite" }
p("Highline", "ILNP") → { shadeName: "Highline", productLine: null, vendorCode: null }
p("OPI - Gel & Lacquer Combo - Metallic Rewind", "OPI").isSet === true
p("Lacquer Set - Ella+Mila Pretty In Pink", "Ella+Mila").isSet === true
p("KBShimmer - Nail Polish - It's Fall Good Collection", "KBShimmer").isSet === true
p("Zoya - Sonnet Fall Collection", "Zoya").isSet === true
```

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement `parseRetailerTitle`** (pure, no I/O; export the line and set regexes as named constants for the filters in Tasks 6–8).
- [ ] **Step 4: Run the test** → PASS.
- [ ] **Step 5: Commit** — `feat(ingestion): retailer title parser`.

### Task 5: Retailer mode in the generic Shopify connector

(Dev's `SHOPIFY_STORE_TITLE_PARSERS` returns only a shade-name string, runs in `enrichShopifyRecord` after windowing, and its key list doubles as `SHOPIFY_TITLE_PARSER_SOURCES`, which switches on Polish Pickup's month `releaseTags`. Retailer parsing needs the name, line, code and `isSet` **in the gate**, with the alias-resolved brand, so this task adds a settings-aware hook instead of reusing that registry: `gateShopifyProduct` calls `parseRetailerTitle(title, brand)` when `settings.kind !== "brand"` and drops `null`/`isSet` results before windowing, and `enrichShopifyRecord` reuses the same parse for the record fields; `SHOPIFY_STORE_TITLE_PARSERS` and `releaseTags` stay as they are for Polish Pickup. Dev's `stripRetailerExclusiveSuffix` still runs on every title. A retailer product whose vendor is missing or a placeholder, with no alias match, is **dropped in the gate** (no store-brand fallback: `resolveRetailerVendor` returns `null` for retailer/feed sources instead of `fallbackBrand`), with the gate counting it in `metadata.vendorlessSkipped`.)

**Files:**
- Modify: `packages/functions/src/lib/connectors/shopify-generic.ts` (constructor options gain `settings: SourceSettings`; `resolveShopifyVendor` gains the alias map; `enrichShopifyRecord` reseller branch)
- Test: `packages/functions/tests/shopify-retailer-mode.unit.test.cjs`
- Docs: `packages/functions/README.md` → "Connector Ingestion Jobs" (a "Retailer sources" paragraph)

**Interfaces:**
- Produces: `resolveRetailerVendor(vendor: unknown, aliases: Record<string, string>, fallbackBrand: string, kind: SourceKind): string | null` (alias lookup on the lower-cased, whitespace-collapsed vendor; else today's `resolveShopifyVendor` for brand sources; `null` for a retailer/feed source whose vendor is missing or a placeholder). The parser's all-lines fallback (Task 4 review): when every segment matches the line regex, the last segment is the shade name. In retailer mode (`settings.kind === "retailer"`) the record's `normalized` carries: `brand` = resolved vendor; `name` = `parseRetailerTitle(title, brand).shadeName` (the product is dropped **in `gateShopifyProduct`**, before sorting and windowing, when the parser returns null or `isSet`, so a page never comes back empty because of set listings); `productLine`; `vendorCode`; `listingTitle` = the raw title; `finishes` = `[]` (so `parseHoloTacoNormalized` leaves the legacy `finish` identity key null; `extractFinishFromTags` is not used) while `tags` keeps the store's finish words, which the existing resolution in `resolveIngestedShadeFinishResolution` (tags, then descriptors, then description text) turns into the canonical `shade.finishes`; the test materializes one retailer record through the fake client and asserts the shade INSERT has `finish` null and `finishes` `["creme"]`; `collections` = `[]`; `discontinued` = any tag equal to `discontinued` or `bp-discontinued` (case-insensitive); `productUrl` = the retailer's product page as today; `price`/`currency` as today; `kind: "retailer"`. Hypnotic's `| Shimmer` / `|| Top Coat` tags are read with leading `|` characters and spaces stripped before finish parsing.

- [ ] **Step 1: Write the failing test**

```js
const connector = new ShopifyGenericConnector("BeyondPolishShopify", "https://www.beyondpolish.com", { settings: readSourceSettings({ kind: "retailer", vendorAliases: { ORLY: "Orly", "DND - Daisy Nail Design": "DND" } }) });
// catalogCache with 4 products: the OPI NLB83 listing, "Orly Nail Lacquer - Velvet Dreams - #2000478" vendor "ORLY", "OPI - Gel & Lacquer Combo - Metallic Rewind" (tags Nail Set), "Zoya - Sonnet Fall Collection"
const { records } = await connector.pullProducts({ searchTerm: "", page: 1, pageSize: 50, maxRecords: 50, catalogCache });
assert.equal(records.length, 2);
assert.equal(records[0].normalized.brand, "OPI"); assert.equal(records[0].normalized.name, "No Room for the Blues");
assert.equal(records[0].normalized.vendorCode, "NLB83"); assert.equal(records[0].normalized.productLine, "Nail Lacquer");
assert.equal(records[0].normalized.discontinued, true); assert.deepEqual(records[0].normalized.collections, []);
assert.equal(records[1].normalized.brand, "Orly");
assert.equal(resolveRetailerVendor("Lippmann", { lippmann: "Deborah Lippmann" }, "Beyond Polish", "retailer"), "Deborah Lippmann");
assert.equal(resolveRetailerVendor("vendor-unknown", {}, "Beyond Polish", "retailer"), null); // the product is dropped in the gate
assert.deepEqual(parseRetailerTitle("Brand - Nail Polish - Lacquer Up", "Brand").shadeName, "Lacquer Up");
```

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** (brand mode is byte-for-byte today's records: assert that in the test with a brand-mode connector on the same fixture).
- [ ] **Step 4: Run** all Shopify tests → PASS.
- [ ] **Step 5: Docs + commit** — `feat(ingestion): retailer mode for the generic Shopify connector`.

### Task 6: Harlow & Co source

**Files:**
- Create: `packages/functions/src/lib/connectors/store-filters/harlow-and-co.ts`; register in `store-filters/index.ts`
- Create: `packages/functions/tests/fixtures/harlow-and-co-products.json` (trimmed: every product with `product_type` not "Nail Polish" plus 40 polishes across the 6 polish vendors; fetched 2026-11-08 from `harlowandco.org/products.json`, 1,537 products over 7 pages)
- Modify: `docs/seed_data_sources.sql` (row `HarlowAndCoShopify`, enabled, `metadata.kind = "retailer"`, `imagesPermitted` absent, `currency: "CAD"`, `vendorAliases: { "Cirque": "Cirque Colors", "piCture pOlish": "Picture Polish" }`, notes with the probe facts: own terms with no automated-access clause, robots default, 1,537 products / 22 vendors / 1,282 accepted, ILNP 605 / KBShimmer 260 / Cirque 238), `packages/functions/src/lib/connectors/shopify-generic.ts` (`SHOPIFY_SOURCE_BASE_URLS.HarlowAndCoShopify = "https://www.harlowandco.org"`), new migration `packages/functions/migrations/<timestamp>_add-harlow-and-co-source.sql` (upsert pattern of Global Constraints)
- Test: `packages/functions/tests/shopify-store-filters.unit.test.cjs` (new describe block)
- Docs: README connector section; `docs/brand-sources-evaluation-2026-11.md` §3.4 row gets "registered (Task 6)"

**Interfaces:**
- Filter: `isHarlowAndCoPolish(product): boolean | null` — `false` for `product_type` in {Manicure Accessories, Lotion, Stamping Plate, Apparel & Accessories, Gift Card} and for vendors {MILV, Lina Nail Art Supplies, Deco Beauty, Walton Wood Farm, Cutie Oils, Simply Polished, Harlow & Co.}; `false` when the title matches the parser's set regex; `null` otherwise (the generic gate accepts "Nail Polish" / "Nail Polishes").

- [ ] **Step 1: Save the fixture; write the failing test**: 40 named polish titles accepted (ILNP "Highline", KBShimmer "Alloy Matey!", Cirque "Subculture", Color Club "What a Gem", Polished for Days ×2, Emily de Molly ×2 among them), rejected: every MILV / Lina decal, "It's Fall Good Collection" if present, the gift card; assert `shopifyStoreProductVerdict("HarlowAndCoShopify", p)` and the connector's accepted count on the fixture equals the expected number written in the test.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement the filter, the seed row, the base URL, the migration; `npm run generate:types`.**
- [ ] **Step 4: Run the tests** (`shopify-store-filters`, `shopify-indie-sources`, `connector-registry`) → PASS.
- [ ] **Step 5: Local dry run (owner or executor with `npm run dev:infra` + Functions host):** queue an exhaustive job with `materializeToInventory: false`; then with `true`; record in the README paragraph the accepted count and the brands created. Expected: ≈1,282 records, brands ILNP, KBShimmer, Polished for Days, I Scream Nails new; Cirque Colors / Color Club / Emily de Molly adopted (zero new shades for shades those stores already created).
- [ ] **Step 6: Docs + commit** — `feat(ingestion): Harlow & Co retailer source (ILNP, KBShimmer)`.

### Task 7: Beyond Polish source

**Files:**
- Create: `packages/functions/src/lib/connectors/store-filters/beyond-polish.ts`; register
- Create: `packages/functions/tests/fixtures/beyond-polish-products.json` (trimmed to ~200 products: 8 per lacquer vendor of spec §3.4, every `product_type` value at least twice, 10 `Gel & Lacquer Polish` combos, 10 `Gel Polish`, 5 `Nail Set`-tagged lacquers, 5 Hair/Body; fetched 2026-11-08, 17,508 products over 71 pages)
- Modify: seed (row `BeyondPolishShopify`, enabled, `kind: "retailer"`, `currency: "USD"`, `includeGel: false`, `vendorAliases: { "ORLY": "Orly", "Lippmann": "Deborah Lippmann", "Sunday Studio": "Sundays", "DND - Daisy Nail Design": "DND", "Harmony": "Gelish", "ella+mila": "Ella+Mila", "butter LONDON": "butter LONDON" }`, notes with the probe facts: own terms, no automated-access clause, 17,508 / 103 vendors / 9,395 generic-accepted / 4,138 lacquer-typed, no barcodes in products.json), base URL `https://www.beyondpolish.com`, migration
- Test: `shopify-store-filters.unit.test.cjs` + `packages/functions/tests/beyond-polish-ingest.unit.test.cjs` (connector run over the fixture with the fake materializer client: on a second run over an adopted brand shade the recorded `UPDATE shade` keeps the existing `vendor_hex`, `finishes` and category params unchanged (`hexOverwritten` is always 0 for a retailer, so it proves nothing) and zero uploads with `storeImages: false`)
- Docs: README; evaluation §3.4

**Interfaces:**
- Filter: `isBeyondPolishPolish(product, settings: { includeGel: boolean }): boolean` — accept iff `product_type` ∈ `LACQUER_TYPES = {"Nail Lacquer", "Lacquer & Dip", "Gel, Lacquer & Dip"}` or (`includeGel` and `product_type === "Gel Polish"`); `false` for `Gel & Lacquer Polish` (every one is a combo), every other type, any tag in {`Nail Set`, `TIER COMBO`, `Custom Bundle`, `Kit`} (case-insensitive), and titles the parser marks `isSet`. The store-filter registry gains a settings parameter: `StoreProductFilter = (product, settings: SourceSettings) => boolean | null` (Task 3's type; existing filters ignore it).
- Per-vendor count expectations in the test, from the 2026-11-08 pull of the whole store: lacquer-typed accepted OPI 1,160, Zoya 262, Orly 255, Cirque 244, KBShimmer 223, Morgan Taylor 205, CND 159, Ella+Mila 142, Londontown 141, Essie 118, China Glaze 102, Color Club 80, butter LONDON 66 (the fixture asserts the per-vendor accepts on its own subset, and the README records the whole-store numbers).

- [ ] **Step 1: Fixture + failing tests** (accepted: "OPI Nail Lacquer - No Room for the Blues 0.5 oz - #NLB83", "Zoya - Fairleigh .5 oz. - #ZP1210", "Orly Nail Lacquer - Velvet Dreams - #2000478", "Londontown - Lakur Enhanced Colour - Dream State 0.4 oz"; rejected: "OPI - Gel & Lacquer Combo - Metallic Rewind", "OPI - Nail Lacquer Combo - Base, Top & Machu Peach-u 0.5 oz - #NLP36", "Zoya - Sonnet Fall Collection", "Lacquer Set - Ella+Mila Pretty In Pink", any Hair / Rings product, "OPI GelColor - …" with `includeGel: false`; accepted with `includeGel: true`).
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement the filter (settings-aware registry), the seed row, base URL, migration; regenerate types.**
- [ ] **Step 4: Run the tests** → PASS; `npm run typecheck`.
- [ ] **Step 4b: Page limit.** `MAX_SHOPIFY_PAGES` (30) becomes `SHOPIFY_CONNECTOR_MAX_PAGES` (env, default 30, clamped 1–200; CLAUDE.md group "ingestion and catalog images", README table, `local.settings.json.example`) with a per-source override `data_source.metadata.maxPages` read by `readSourceSettings` (`SourceSettings.maxPages`, Task 3); Beyond Polish's seed row sets `maxPages: 100`. Test in `shopify-generic-enrichment.unit.test.cjs`: a stubbed store serving 35 full pages is read to the end with `maxPages: 40` and stops at 30 without it.
- [ ] **Step 5: Local dry run as in Task 6, with `detectHexFromImage: false` the first time.** Expected ≈4,000 accepted records, brands OPI, Zoya, Essie, CND, Morgan Taylor, Londontown, Ella+Mila, Kiara Sky (lacquer line), Loud Lacquer, Sundays, Peacci, Static Nails, Deborah Lippmann created; Orly / China Glaze / Color Club / Cirque / Cracked / KBShimmer adopted. Run `docs/queries/reseller-duplicates.sql` (Task 9) after; the duplicate count per brand goes into the README paragraph.
- [ ] **Step 6: Docs + commit** — `feat(ingestion): Beyond Polish retailer source (lacquer lines, gel behind includeGel)`.

### Task 8: Hypnotic Polish source (pending approval)

**Files:**
- Create: `store-filters/hypnotic-polish.ts`; register; fixture `hypnotic-polish-products.json` (trimmed from the 998-product pull of 2026-11-08)
- Modify: seed (row `HypnoticPolishShopify`, **disabled**, `"pendingApproval": true`, `kind: "retailer"`, `currency: "EUR"`, `vendorAliases: { "Cuticula Nail Lacquer": "Cuticula", "Bee's Knees Lacquer": "Bee's Knees" }`, notes: Shopify default clause, needs written OK; 998 products / 16 vendors / 977 accepted; ILNP 308, Cirque 201, KBShimmer 110, Cosmic Polish 73, Cuticula 68, Emily de Molly 58, Cadillacquer 40), `SHOPIFY_SOURCES_PENDING_APPROVAL` gains it, base URL, migration (inserted disabled)
- Test: store-filters test block
- Docs: README; evaluation §3.4; the owner's email (spec §7) is the next action

**Interfaces:**
- Filter: `false` for `product_type` ∈ {Cuticle Treatment, Accessories} and titles with `grab bag` / `mystery`; `null` otherwise. The `*PRE-ORDER*` prefix and `| ` / `|| ` tag markers are handled by Task 5.

- [ ] Steps as Task 6 (fixture → failing test → filter + seed + migration → tests pass → commit `feat(ingestion): register Hypnotic Polish retailer source pending approval`). No local ingestion: the source is disabled.

### Task 9: Vendor-code aliases and the duplicate audit

**Files:**
- Modify: `packages/functions/src/lib/ingestion-repo.ts` (`materializePreparedHoloTacoRecord`: after `recordShadeSourceProduct`, `INSERT INTO shade_alias (shade_id, alias) VALUES ($1, $2) ON CONFLICT DO NOTHING` for `normalized.vendorCode` and for `normalized.listingTitle` when they differ from the shade name)
- Create: `docs/queries/reseller-duplicates.sql` (read-only: per brand, pairs of active shades whose `lower(shade_name_canonical)` match after stripping sizes/codes, or whose names are within `similarity() > 0.85`, each with its sources; and brands created by a retailer source whose name is within 0.8 similarity of another brand)
- Test: `ingestion-repo-adopt-existing.unit.test.cjs` (extend: the alias insert appears with the vendor code)
- Docs: README (aliases: a scanned OPI bottle whose label says NLB83 matches by alias through catalog search); CLAUDE.md Catalog search line unchanged (aliases already searched)

- [ ] **Step 1: Failing test** — the fake client records an `INSERT INTO shade_alias` with `"NLB83"` for the OPI record and none for a record without a code.
- [ ] **Step 2: Run to verify it fails.** **Step 3: Implement.** **Step 4: Tests pass.**
- [ ] **Step 5: Write the audit query; run it on the dev database after Task 7's dry run; paste the per-brand duplicate counts into the Task 7 README paragraph.**
- [ ] **Step 6: Commit** — `feat(ingestion): vendor-code aliases and reseller duplicate audit`.

### Task 9b: Remove a source's catalog images on request

**Files:**
- Create: `packages/functions/src/lib/source-image-removal.ts`; `packages/functions/src/functions/images-admin.ts` gains `POST /api/images-admin/source-images/remove` (`withAdmin`; body `{ sourceName, afterImageId?: 0, limit?: 100 (≤ 500), dryRun?: true }`; response `{ dryRun, scanned, swatchesUnlinked, imagesDeleted, blobsDeleted, kept[], nextAfterImageId }`)
- Modify: `apps/web/src/app/(admin)/admin/reference-data/components/backfills-tab.tsx` (`BACKFILLS` entry "Remove a source's images"), `packages/functions/package.json` script `remove:source-images` + `packages/functions/scripts/remove-source-images.cjs` (loops the batch step; dry run unless `--write`)
- Test: `packages/functions/tests/source-image-removal.unit.test.cjs`
- Docs: README route table + the "Source kinds" paragraph (disabling a source keeps its images until this job runs), CLAUDE.md Dev Commands, evaluation §4 S1 (correct the sentence that said images are removed by the existing cleanup)

**Interfaces:**
- For `image_asset` rows with `owner_type = 'source'` and `owner_id = <that data_source_id>`: unlink every `swatch` (`source_product` and `source_gallery`) that references the image, then delete the row and its blob and variant blobs, in keyset batches by `image_id`. Kept (listed in `kept` with a reason): an image that has a `color_training_sample` label, a swatch with `color_features`, or that another source's `image_asset` row shares by checksum (the row is removed, the blob stays). A shade left without any `source_product` swatch falls back to its remaining gallery or to no image (display shows the hex). Runs only on a **disabled** source (409 otherwise), so a store that asks us to stop is disabled first, then cleaned.

- [ ] **Step 1: Failing tests** (fake client: two images, one labeled → unlinked but kept; a shared-checksum blob not deleted; enabled source → 409; dry run deletes nothing). **Step 2: Fails. Step 3: Implement. Step 4: Passes.**
- [ ] **Step 5: Docs + commit** — `feat(admin): remove a disabled source's catalog images`.

## Phase C — Brand stores on Shopify (one PR; the pending group needs no code until approved)

### Task 10: Register the clause-free brand stores

**Files:**
- Modify: `docs/seed_data_sources.sql`, `shopify-generic.ts` (`SHOPIFY_SOURCE_BASE_URLS`), one migration `<timestamp>_add-brand-shopify-sources.sql` (upsert, enabled rows stamped)
- Test: `shopify-indie-sources.unit.test.cjs` (extend the "seeded enabled" assertion list), `connector-registry`
- Docs: README "Current source support"; evaluation §3.1 verdict cells → "registered"

**Rows (name, base URL, currency, probe facts for `metadata.notes` / `verification`, filter need):**
| Source | base_url | currency | Facts (2026-11-08) | Filter |
|---|---|---|---|---|
| `DeborahLippmannShopify` | https://deborahlippmann.com | USD | 54 products: Nail Polish 25, Set 14, Treatment 7, Tools 5; no automated-access clause (6,300-char terms) | none (generic gate; sets dropped by the set rule) |
| `LondontownShopify` | https://londontownusa.com | USD | 250+: Nail Color 68, Gels 65, Sets 39, Nail Care 30, Tools 27; no clause | Task 11 |
| `CoteShopify` | https://coteshop.co | USD | 129: Nail Polishes 66, gift set 11, lip shine 9, treatment 8, body 8; no clause | none |
| `ManucuristShopify` | https://manucurist.com | EUR | 250+: "Vernis à ongles Green™" 68, "Semi-permanent LED Green Flash™" 59, Soins 36; no clause; French `product_type` | Task 11 |
| `OliveAndJuneShopify` | https://oliveandjune.com | USD | 250+: Press-On 51, Tab Press-On 30, Nail Polish 28, Pressies 22, Gel Polish 20, Dip; no clause | Task 11 |
| `PiggyPaintShopify` | https://piggypaint.com | USD | 250+: empty 110, Nail Art Kits & Accessories 92, Nail Polishes 24, Wholesale 12; no clause | Task 11 |
| `MavalaShopify` | https://mavala.com | CHF | 150: Nail Care 34, Skincare 27, Make-Up 26, Instruments 19, Nail Polish 19; **terms page answered 500, terms unknown**: disabled, pending as CND | none |
| `WetNWildShopify` | https://wetnwildbeauty.com | USD | 250+ cosmetics, polish not on page 1; no clause | Task 11 (title/type `Nail Color`) |
| `AlchemyLacquersShopify` | https://alchemylacquers.com | USD | 228: Nail Lacquer 198, empty 30; no clause (2,100-char terms) | none |
| `PenelopeLuzShopify` | https://penelopeluz.com | USD | 216 products, `product_type` empty on all; no clause (2,000-char terms) | Task 11 |
| `NoodlesNailPolishShopify` | https://noodlesnailpolish.com | USD | 57 products, types empty; no clause (600-char terms) | Task 11 |
| `CndShopify` | https://cnd.com | USD | 117: empty 111, Gel Polish 6; **no terms page at `/policies/terms-of-service`**: registered **disabled, pending** until the owner reads cnd.com's site terms | Task 11 |
| `BarryMShopify` | https://barrym.com | GBP | 250+: Nail Paint 106, lip/eye cosmetics; **terms page 404**: disabled, pending as CND | Task 11 (`Nail Paint` is the polish signal) |

- [ ] **Step 1: Extend the test** with the enabled list and the three pending names (CND, Barry M, Mavala); run → FAIL.
- [ ] **Step 2: Add rows, base URLs, migration; `npm run generate:types`.**
- [ ] **Step 3: Tests pass; commit** — `feat(ingestion): register clause-free brand Shopify stores`.

### Task 11: Store filters for the brand stores that need one

**Files:**
- Create: `store-filters/londontown.ts`, `manucurist.ts`, `olive-and-june.ts`, `piggy-paint.ts`, `wet-n-wild.ts`, `penelope-luz.ts`, `noodles.ts`, `cnd.ts`, `barry-m.ts`; register each
- Fixtures: `<store>-products.json` per store (first page, trimmed; fetched during the task with the research User-Agent, 1 s apart)
- Test: `shopify-store-filters.unit.test.cjs` blocks
- Docs: README store-filter paragraph

**Rules per filter (from the probe; refine against the fixture):**
- Londontown: keep `product_type` `Nail Color` (and `Nail Care` only when the title names a base/top coat or treatment: the generic gate's categories); drop `Gels`, `Sets`, `Tools`, `Lip Care`; titles with "Set"/"Duo"/"Kit" dropped.
- Manucurist: keep `Vernis à ongles Green™` (lacquer) as color; drop `Semi-permanent LED Green Flash™` (gel) unless `includeGel`; `Soins` → treatment when the title says base/top coat; the filter returns the French types' English meaning by mapping `product_type` before the generic gate (`true` for vernis, `false` for gel/kits/accessoires).
- Olive & June: keep `Nail Polish`; drop Press-On, Tab Press-On, Pressies, Gel Polish (unless `includeGel`), Dip Powder, Tools, Sets.
- Piggy Paint: keep `Nail Polishes`; drop `Nail Art Kits & Accessories`, `Wholesale`; empty types: keep only when the title says "Polish" and not "Set"/"Kit"/"Gift".
- wet n wild: keep titles/type matching `nail color|nail polish|wild shine`; drop everything else.
- Penelope Luz, Noodles: empty types; Pahlish pattern (title blocklist for sets/mystery/gift card/merch, description names a finish or effect) — reuse `SHADE_DESCRIPTION_REGEX` from `sweet-and-sour.ts` by exporting it to `store-filters/shared.ts`.
- CND: empty types; keep titles containing "Vinylux" (lacquer) and base/top coat titles; drop "Shellac" (gel) unless `includeGel`, kits, tools.
- Barry M: keep `Nail Paint` (+ any type containing "Nail" that is not "Nail Art"/"Nail Care Tools"); drop cosmetics types.

- [ ] For each store: **fixture → failing test (≥ 6 accepted titles, ≥ 6 rejected, expected accepted count on the fixture) → filter → test passes.** One commit per filter: `feat(ingestion): <store> store filter`.

### Task 12: Register the clause stores pending approval

**Files:**
- Modify: seed, base URLs, `SHOPIFY_SOURCES_PENDING_APPROVAL`, one migration (all rows disabled, `"pendingApproval": true`, `verification.termsScrapingClause: true` and the clause kind in notes)
- Docs: README; evaluation §3.1; `docs/indie-sources-2026-10.md` gets a pointer to the plan

**Rows:** `DazzleDryShopify` (dazzledry.com; Nail Lacquer 83 + Mini Lacquer 61 on page 1; Shopify clause), `SundaysShopify` (dearsundays.com; 94, types empty; clause), `JinsoonShopify` (jinsoon.com; 135, 15 typed; clause), `TenovertenShopify` (tenoverten.com; 28 polishes; clause), `NailberryShopify` (nailberry.co.uk, GBP; L'Oxygéné 71; clause), `DndShopify` (dndgel.com; gel; clause; `includeGel` matters), `GlamPolishShopify` (glampolish.com.au, AUD; 250+, types empty/"What's New?"; clause), `NailHootShopify` (nailhoot.com; 230: empty 128, Bath and Beauty 92; clause), `MoonShineManiShopify` (moonshinemani.com; 199, types empty; clause), `FunLacquerShopify` (funlacquer.com; NAIL POLISH 88, GEL POLISH 84; clause), `AnchorAndHeartShopify` (anchorandheartlacquer.com; 25; clause), `ButterLondonShopify` (butterlondon.com; own clause), `EllaMilaShopify` (ellamila.com; own clause), `KiaraSkyShopify` (kiarasky.com; own clause; gel-heavy), `StaticNailsShopify` (staticnails.com; own clause), `PacificaShopify` (pacificabeauty.com; own clause), `RevlonShopify` (revlon.com; own clause), `ModelonesShopify` (modelones.com; own clause), `DreamlandLacquerShopify` (dreamlandlacquer.com; own clause), `EtherealLacquerShopify` (ethereallacquer.com; own clause).

- [ ] **Step 1: Extend `shopify-indie-sources.unit.test.cjs`** (every pending name is seeded disabled with the flag) → FAIL. **Step 2: Add rows + migration + set + base URLs; regenerate.** **Step 3: Tests pass; commit** — `feat(ingestion): register clause-bound brand stores pending approval`.
- [ ] **Owner step (not code):** send the spec §7 email to each; on a yes, follow README "Enabling a pending store" (notes sentence, remove from the pending set, flip the seed, a one-line enable migration) and write the store's filter with Task 11's method where the table above says the types are empty or mixed.

## Phase D — Polish Pickup (one PR)

### Task 13: Polish Pickup roster script (the source and filter exist on dev)

**Files:**
- dev (PR #497) already registered `PolishPickupShopify` (disabled, pending, `kind: retailer`) with `store-filters/polish-pickup.ts` and `polish-pickup-title.ts`. This task only verifies them against the November 2026 fixture and adds the roster tool.
- Create: `packages/functions/tests/fixtures/polish-pickup-products.json` (the 92-product November 2026 shop, trimmed) and a block in the Polish Pickup filter test asserting the filter keeps the 70 `PPU` polishes and the usable `IPU` coats and drops the scrub, gift card and merchandise (fix the filter only if the fixture shows a gap).
- Create: `packages/functions/scripts/polish-pickup-roster.cjs` + `package.json` script `roster:polish-pickup`
- Test: `packages/functions/tests/polish-pickup-roster.unit.test.cjs` (pure diff function)
- Docs: README (the script under "Admin scripts"), CLAUDE.md Dev Commands line, evaluation §3.3

**Interfaces:**
- Roster script: `GET https://www.polishpickup.com/products.json?limit=250` once (research User-Agent); prints one line per vendor with the count and whether a `data_source` whose `metadata.brand` or name matches exists in `docs/seed_data_sources.sql` (string match, no DB); `--json` writes `{ fetchedAt, vendors: [{ vendor, products, source: name | null }] }`. Exported pure function `diffRoster(vendors: string[], sources: string[]): RosterRow[]` for the test.

- [ ] **Step 1: Fixture + failing tests** (`diffRoster(["Pahlish", "Lumen"], ["PahlishShopify"])` → Pahlish mapped, Lumen null; the fixture block).
- [ ] **Step 2: Run to verify they fail.** **Step 3: Implement the script (and any filter gap).** **Step 4: Tests pass.**
- [ ] **Step 5: Commit** — `feat(ingestion): Polish Pickup maker roster script`.

## Phase E — New connectors (one PR each)

### Task 14: Google product feed connector

**Files:**
- Add dependency: `fast-xml-parser` in `packages/functions/package.json` (exact version, `npm install --workspace=swatchwatch-functions`)
- Create: `packages/functions/src/lib/connectors/product-feed.ts`
- Modify: `packages/functions/src/functions/ingestion.ts` (`CONNECTOR_FACTORIES.ProductFeed`)
- Create: `packages/functions/tests/fixtures/product-feed-sample.xml`, `product-feed-sample.tsv` (hand-written, 7 items each: a lacquer with gtin 0096200010000-style UPC-12, one with an EAN-13, one with a wrong check digit, one with `id` only, one `availability: out of stock` (kept, `available: false`), one set titled "… Duo", one non-polish item: a stamping plate with `g:product_type` "Nail Art > Stamping Plates")
- Test: `packages/functions/tests/product-feed-connector.unit.test.cjs`
- Docs: README (connector + metadata keys), CLAUDE.md Architecture Overview (one sentence), `local.settings.json.example` + README env table for `PRODUCT_FEED_AUTH_<SOURCE>` (optional basic-auth `user:pass` per source, read when `metadata.feedAuthEnv` names it)

**Interfaces:**
- `class ProductFeedConnector implements ProductConnector` with `constructor(source, feedUrl: string, settings: SourceSettings)`; reads `data_source.base_url` as the feed URL (`metadata.feedUrl` overrides); format by `Content-Type`/extension: XML (RSS 2.0 `channel/item` or Atom `entry`, `g:` namespace) or delimited text (first row = attribute names, tab or comma). Record: `externalId` = `g:id`; `gtin` = `normalizeGtin(g:gtin)` key (null when rejected; wrong check digit kept and reported in `metadata.invalidCheckDigits`); `normalized` = `{ brand: g:brand ?? settings.brand, name: g:title (through parseRetailerTitle when settings.kind === "retailer", else as is), productType: g:product_type, tags: [], descriptors: [g:color, g:product_type, g:item_group_id].filter(Boolean), descriptionText: stripped g:description, imageUrls: [g:image_link, ...g:additional_image_link], primaryImageUrl, productUrl: g:link, price: amount of "12.50 USD", currency: "USD", available: g:availability === "in stock", kind: settings.kind }`; gate = `classifyIngestedProduct({ title, productType: g:product_type, tags: [g:color] })` + the set regex. Pagination: the whole feed is one download cached through `catalogCache`; `pullProducts` windows exactly like Task 2.

- [ ] **Step 1: Failing test** — parse both fixtures through a connector whose `fetch` is stubbed to return the file: 5 records each (the "Duo" and the stamping plate dropped; the out-of-stock lacquer kept with `available: false`), the UPC-12 and EAN-13 normalize to their keys, the wrong-check-digit gtin is kept and listed in `metadata.invalidCheckDigits`, the id-only item has `gtin: null`, price `12.5` + `USD`.
- [ ] **Step 2: Run to verify it fails.** **Step 3: Implement.** **Step 4: Tests pass; `npm run typecheck`.**
- [ ] **Step 5: Docs + commit** — `feat(ingestion): Google product feed connector`.
- [ ] **Owner step:** ask the indies that already said yes (Stella Chroma, Lemming Lacquer, Sweet & Sour, Pahlish, Emily de Molly, Cirque) for their Google Shopping feed URL (spec S7); register each as `<Brand>Feed` with `kind: "brand"` (one migration per batch, Task 10's pattern) so barcodes arrive.

### Task 15: Sitemap + JSON-LD connector (OPI first, pending approval)

**Files:**
- Create: `packages/functions/src/lib/connectors/sitemap-jsonld.ts`
- Modify: `ingestion.ts` (`CONNECTOR_FACTORIES.SitemapJsonLd`), seed (row `OpiSitemap`, base_url https://www.opi.com, `metadata.sitemapUrl: "https://www.opi.com/sitemap.xml"`, `metadata.productUrlPrefixes: ["https://www.opi.com/products/nail-lacquer-", "https://www.opi.com/products/infinite-shine-"]`, `brand: "OPI"`, **disabled, pending**: terms page not found at `/terms-of-use` on 2026-11-08; the owner locates and reads OPI's site terms and asks for the OK), migration
- Fixtures: `opi-sitemap-sample.xml` (10 URLs, 3 matching prefixes) and `opi-product-sample.html` (one saved product page: JSON-LD `Product` with `gtin` 4064665004236, `sku` 99350098453, brand, image, offers; strip everything but `<head>` scripts)
- Test: `packages/functions/tests/sitemap-jsonld-connector.unit.test.cjs`
- Docs: README (connector, metadata keys, the 1 s pacing and the `lastmod` cache), CLAUDE.md sentence

**Interfaces:**
- `class SitemapJsonLdConnector implements ProductConnector` with `constructor(source, baseUrl, settings, { sitemapUrl, productUrlPrefixes })`. Pull: fetch the sitemap (a `<sitemapindex>` is followed one level), keep `<loc>` values starting with a prefix, dedupe; discovery requests (the index and each child sitemap) obey the same deadline bound, retry bound and save margin as product pages, and the checkpoint records the index's child-sitemap list and which children have been read (`discovery: { children: string[], done: string[] }`), so a continuation resumes discovery without repeating a finished child request; fetch each page 1 s apart, at most `SITEMAP_JSONLD_MAX_PAGES_PER_RUN` pages per `pullProducts` call (default 150, clamped 10–300, env + docs) **and never past the deadline**: each page request's timeout is `min(SHOPIFY_CONNECTOR_REQUEST_TIMEOUT_MS, deadlineMs - SITEMAP_JSONLD_SAVE_MARGIN_MS - now)` (20 s reserved for saving the checkpoint and the hand-off) and the retry loop is bounded the same way: a retry (and its backoff sleep) is attempted only when it, too, fits before the margin, otherwise the page is left unfetched for the next continuation (never counted as done), the loop always fetches at least one page when that remaining time is ≥ 5 s and stops before the next page otherwise, and a `deadlineMs` that leaves less than 5 s on entry makes the pull throw `SitemapJsonLd: worker budget too small to fetch a page` instead of queueing an empty continuation; so slow requests, retries or a raised page limit cannot overrun the worker budget and a 30 s budget still makes progress (`deadlineMs` is required for this connector; the worker passes `invocationStart + INGESTION_WORKER_TIME_BUDGET_MS`), parse every `<script type="application/ld+json">`, take the first object (or `@graph` member) with `@type: "Product"`; record: `externalId` = page URL path, `gtin` = `normalizeGtin(gtin ?? gtin13 ?? gtin12 ?? gtin14)`, `normalized` = `{ brand: brand.name ?? settings.brand, name: parseRetailerTitle(name, brand).shadeName (the parser handles "OPI Nail Lacquer - …" shapes; brand mode keeps the parsed shade name too, because enterprise titles carry the line), productLine, vendorCode: sku, productType: productLine, tags: [], descriptionText, imageUrls: image as string | string[] | ImageObject[], productUrl: url ?? page URL, price: offers.price, currency: offers.priceCurrency, kind: settings.kind }`. The crawl is checkpointed through `catalogCache`, whose contract keeps `load()` / `save()` returning and taking product arrays for the Shopify connectors and gains a separate versioned checkpoint pair `loadCheckpoint(): Promise<{ value: unknown; etag: string | null } | null>`, `saveCheckpoint(value: unknown, etag: string | null): Promise<void>` plus `durable: boolean` ( `lib/ingestion-catalog-cache.ts` reports `durable: true` only when `CONNECTOR_RAW_CONTAINER` is configured and the blob write succeeded, and `loadCatalogWithCache` keeps treating an empty array as a miss). `durable` is established by a preflight, not by an earlier success: when `CONNECTOR_RAW_CONTAINER` is configured, `lib/ingestion-catalog-cache.ts` runs a preflight at creation that writes a separate probe blob (`<snapshot name>.preflight`, never the checkpoint itself, so recreating the cache for a continuation never overwrites a saved checkpoint) and reports `durable: true` only when that write succeeded, so a fresh cache can start its first pull and a storage failure still blocks the crawl. The sitemap connector throws `SitemapJsonLd needs a durable catalog cache (CONNECTOR_RAW_CONTAINER)` before any request when the cache is absent or not durable: a 570-page crawl cannot finish in one invocation and must never restart from zero. Checkpoint value: `{ urls: [{ url, lastmod }], pages: { [url]: jsonld }, complete: boolean, generation: number }`, saved after every call with a **fenced write**: `loadCheckpoint()` returns the blob's ETag with the value, `saveCheckpoint()` writes with `If-Match` on that ETag (a fresh checkpoint uses `If-None-Match: *`), and a precondition failure (a newer continuation already saved) makes the pull throw `SitemapJsonLd checkpoint superseded`, which the worker treats like a lost-ownership stop (no records processed, no continuation queued), so a stale redelivery can never replace newer crawl progress; `generation` increments on every save for the log line. **Crawling is separate from paging:** while `complete` is false, `pullProducts` fetches its page budget, saves, and returns **zero records** with `metadata.catalogComplete: false` and `metadata.crawledPages`/`totalPages`; the worker (`ingestion.ts` page loop) treats `catalogComplete === false` as "call again with the same page number" in exhaustive and non-exhaustive jobs alike (an empty partial result never ends the job); every pull, partial ones included, **checks job ownership (the existing `assertJobOwnership`-style check that today runs after a record chunk) before processing or persisting anything and before the next pull**, so a cancelled job stops crawling; each partial pull **counts as progress against the worker's time budget** and the loop hands off to a continuation (same checkpoint mechanism as today) when the remaining budget is smaller than one page budget's worth of pacing (`SITEMAP_JSONLD_MAX_PAGES_PER_RUN` × 1 s plus the request timeout); `ConnectorPullOptions` gains `deadlineMs?: number` (absolute epoch) that the connector honours by stopping its page loop early and saving the checkpoint. Only once `complete` is true does the connector gate, sort and window the stable catalog like the Shopify connector. JSON-LD `image` values are normalized to URL strings first (a string, an array of strings, an `ImageObject` with `url` or `contentUrl`, or an array of those) into `imageUrls`, and `primaryImageUrl` = the first of them, so the materializer keeps the gallery. Test: a 400-URL sitemap with the limit at 150 takes three calls (two returning no records with `catalogComplete: false`) before the third reports `catalogComplete: true` with the full windowed set; no URL is fetched twice; a cache with `durable: false` makes the pull throw before any fetch; a fresh real `ingestion-catalog-cache` whose preflight write succeeds is durable and one whose write fails is not; recreating the cache for a continuation when a checkpoint is already saved leaves that checkpoint readable; with a 30 s deadline and 400 ms requests at least one page is fetched before the stop; a page whose first attempt fails 3 s before the margin is not retried and stays unfetched in the checkpoint; a deadline 3 s away throws before any fetch; a `deadlineMs` 27 s ahead with a first request that takes 3 s (one page fits before the 20 s margin, a second does not) fetches exactly one page, stops and saves the checkpoint; a sitemap index with three children and a deadline that fits only two child requests saves `discovery.done` with two entries and the next call reads only the third; with the page limit raised to 300 and a stubbed fetch that takes 400 ms per page under a 30 s deadline, the loop stops at the deadline minus the save margin, saves, and the next call resumes from the saved page; the worker test covers a cancelled job stopping after a partial pull and a continuation being queued when the budget is nearly spent; a stale pull whose `save()` hits a precondition failure (the fake cache's ETag moved) throws `checkpoint superseded`, and the worker stops without processing or queueing; a record whose `image` is an `ImageObject` array has `imageUrls` of strings and `primaryImageUrl` = the first.

- [ ] **Step 1: Failing test** — stubbed fetch serving the two fixtures through a fake durable in-memory cache: 3 product records, the OPI record has `gtin` key `4064665004236`, `vendorCode: "99350098453"`, `name` without the "OPI Nail Lacquer -" prefix, one `imageUrls` entry and `primaryImageUrl` equal to it; non-prefix URLs never fetched (assert the fetch log); pages fetched ≥ 1 s apart (fake timers); plus the checkpoint, durability and worker-loop cases listed in Interfaces (the worker's `catalogComplete === false` handling gets its own case in `tests/ingestion-worker-continuation.unit.test.cjs`).
- [ ] **Step 2: Fails. Step 3: Implement. Step 4: Passes.**
- [ ] **Step 5: Docs + commit** — `feat(ingestion): sitemap + JSON-LD connector, OPI registered pending approval`.

### Task 16: WooCommerce Store API connector

**Files:**
- Create: `packages/functions/src/lib/connectors/woocommerce-store.ts`
- Modify: `ingestion.ts` factory; seed rows `PicturePolishWooCommerce` (https://picturepolish.com.au, AUD; Store API answered 200 on 2026-11-08; terms not read: **disabled, pending**), `IlnpWooCommerce` and `KbshimmerWooCommerce` (**disabled**, notes: robots.txt disallows the Store API / Cloudflare challenge; registered so the admin UI shows them as known-blocked, `metadata.blocked: "robots" | "cloudflare"`), migration
- Fixture: `woocommerce-store-sample.json` (hand-written from the Store API shape: `id`, `name`, `permalink`, `sku`, `prices { price, currency_code, currency_minor_unit }`, `images[].src`, `categories[].name`, `tags[].name`, `attributes[].terms[].name`, `description`, `short_description`, `has_options`, `is_in_stock`)
- Test: `packages/functions/tests/woocommerce-store-connector.unit.test.cjs`
- Docs: README, CLAUDE.md sentence

**Interfaces:**
- `class WooCommerceStoreConnector implements ProductConnector`: `GET {base}/wp-json/wc/store/v1/products?per_page=100&page=N` until a page returns fewer than 100 (cap `MAX_SHOPIFY_PAGES`-style 60 pages), 1 s apart, cached through `catalogCache`. A `robots.txt` that disallows `/wp-json/` for `*` makes the pull throw `WooCommerce Store API disallowed by robots.txt` before any product request (fetched once per pull). Record: `externalId` = id, `gtin` = null (the Store API has no GTIN), `normalized` = `{ brand: settings.brand ?? attribute "Brand" term, name: name (parseRetailerTitle in retailer mode), productType: categories[0].name, tags: tags[].name, descriptors: attribute terms + category names, descriptionText: stripped short_description || description, imageUrls: images[].src, primaryImageUrl: images[0].src ?? null, productUrl: permalink, price: price / 10^minor_unit as decimal string, currency: currency_code, kind }`; gate as the Shopify connector (`classifyIngestedProduct` + set regex), with store filters reachable through the same `shopifyStoreProductVerdict(source, product, settings)` map (rename the map's type to `StoreProductFilter` over a platform-neutral `StoreFilterProduct` with `title`, `product_type`, `tags`, `body_html`, `vendor`).

- [ ] **Step 1: Failing test** — 5 fixture products → 3 records (a stamping plate and a "Trio" dropped), price `"12.00"` from `1200` minor units with `currency_minor_unit: 2`, robots stub with `Disallow: /wp-json/` → rejects before any product fetch.
- [ ] **Step 2: Fails. Step 3: Implement. Step 4: Passes.**
- [ ] **Step 5: Docs + commit** — `feat(ingestion): WooCommerce Store API connector`.

### Task 17: Big Cartel connector

**Files:**
- Create: `packages/functions/src/lib/connectors/big-cartel.ts`
- Modify: `ingestion.ts` factory; seed rows `PaintedPolishBigCartel` (subdomain to verify; Painted Polish's own domain answered 404 on 2026-11-08 and sits behind Cloudflare), `PotionPolishBigCartel` (replaces the disabled `PotionPolishShopify`: that row's notes get "superseded by PotionPolishBigCartel", it stays disabled), `ColoresDeCarolBigCartel`, `GlistenAndGlowBigCartel`, `PoetryCowgirlBigCartel`: every row `metadata.subdomain` **and `metadata.brand`** (the maker's name: a record without a brand is rejected, never given the Holo Taco fallback), **disabled, pending** (the owner reads Big Cartel's API License Agreement linked from developers.bigcartel.com/api/v0 and each store's terms; the executor verifies `https://api.bigcartel.com/<subdomain>/products.json` answers with the research User-Agent and records the status in `verification`), migration
- Fixture: `big-cartel-sample.json` (hand-written from the v0 docs: `name`, `permalink`, `url`, `description`, `price`, `default_price`, `status`, `position`, `created_at`, `options[]`, `images[] { url, secure_url, width, height }`, `categories[] { name, permalink }`)
- Test: `packages/functions/tests/big-cartel-connector.unit.test.cjs`
- Docs: README, CLAUDE.md sentence

**Interfaces:**
- `class BigCartelConnector implements ProductConnector`: one `GET https://api.bigcartel.com/{subdomain}/products.json` (no pagination; `limit` unused), `Accept: application/json`, research User-Agent; store currency from `GET …/store.json` once (`currency.code`: the v0 API returns `currency` as an object), overridden by `settings.currency`; `settings.brand` is required (the factory throws `BigCartel source <name> has no metadata.brand` otherwise). Record: `externalId` = permalink, `gtin` null, `normalized` = `{ brand: settings.brand, name (parser in retailer mode), productType: categories[0].name ?? null, tags: categories[].name, descriptors: options[].name + categories, descriptionText: stripped description, imageUrls: images[].secure_url, primaryImageUrl: images[0].secure_url ?? null, productUrl: url resolved against the store URL from store.json (a relative `url` becomes absolute; an absolute one is kept), price: default_price as decimal string, currency, available: status === "active", kind }`; gate as Task 16 plus an explicit mystery rule: a title matching `\b(mystery|grab bag|surprise bag|blind bag)\b` (case-insensitive) is rejected before the category gate, because a Big Cartel category can carry a polish signal (the Task 16 gate gets the same rule in `store-filters/shared.ts` as `MYSTERY_TITLE_REGEX`, used by both connectors).

- [ ] **Step 1: Failing test** — 4 fixture products → 2 records, a `sold-out` status product still kept with `available: false`, a "Mystery Bag" dropped, currency `USD` from the stubbed store.json's `currency.code`, a relative `/product/x` url resolved to `https://<store>/product/x`, and a factory call without `metadata.brand` throws.
- [ ] **Step 2: Fails. Step 3: Implement. Step 4: Passes.**
- [ ] **Step 5: Docs + commit** — `feat(ingestion): Big Cartel connector`.

## Phase F — Closing docs (folded into the last PR of Phase E)

### Task 18: Architecture record and decision log

**Files:**
- Modify: `CLAUDE.md` Architecture Overview (a "Source kinds and resellers" paragraph: `kind`, fill-only adoption, `imagesPermitted`, buy-link priority, `includeGel`, the four connectors and their metadata keys, the protocol registry), Dev Commands (`roster:polish-pickup`), the Completed list
- Modify: `docs/decisions-2026-10.md` (D26: retailer sources and gel scope, with the options from spec §6 and the calls made in this plan's header), `docs/roadmap-2026-10-to-12.md` §4 catalog line (point at the evaluation and this plan), `docs/brand-sources-evaluation-2026-11.md` (a "Status" section at the top listing what each phase registered)
- Run: `docs-sync-checker` agent on the branch diff before the PR

- [ ] **Step 1: Write the paragraphs; run the agent; fix what it lists.**
- [ ] **Step 2: Commit** — `docs: record source kinds, retailer rules and the new connectors`.

---

## Owner checklist (runs alongside the phases)

0. Before the first reseller job: run `docs/queries/ambiguous-listings.sql` on dev and prod; every pair it lists is a product an older run linked to two shades, to be merged in the review queue first.
1. After Phase A merges: email Beyond Polish and Harlow & Co (spec §7); on "no objection" nothing changes (both are enabled, images off); on an images OK set `metadata.imagesPermitted = true` and re-run the job.
2. Email Hypnotic Polish; on a yes, enable (README "Enabling a pending store").
3. Phase C pending group: 20 emails; CND and Barry M after reading their site terms.
4. Polish Pickup: run `npm run roster:polish-pickup -- --json` on the first Saturday of each month; email the makers not yet sources, 10 per batch.
5. Feed URLs from the six indies that already agreed (Task 14 owner step).
6. OPI: find the site terms; email; enable `OpiSitemap` on a yes.
7. Big Cartel: read the API License Agreement; email the five stores.
8. Decide spec §6 decision 3 (gel) when the lacquer catalog is in: flipping `includeGel` on Beyond Polish, DND, Kiara Sky, FUN Lacquer, Manucurist, Olive & June, CND adds the gel lines on the next run.

## Expected yield by phase (from spec §5)

| Phase | New shades (lacquer) | Notes |
|---|---|---|
| B (Harlow + Beyond Polish) | ≈ 4,000 | ILNP, KBShimmer, OPI, Zoya, Essie, CND, Morgan Taylor, Londontown, Ella+Mila, Sundays, Peacci, Lippmann… |
| B (Hypnotic, after OK) | ≈ 250 | Cadillacquer, Cosmic Polish, Cuticula, EUR prices |
| C (clause-free) | ≈ 700 | plus CND / Barry M / Mavala ≈ 370 if their terms allow |
| C (pending, after OKs) | ≈ 500 | |
| D (Polish Pickup, after OK) | ≈ 70 / month | one shade per maker per month; the maker outreach it feeds yields ≈ 300 shades per round of 10 emails (spec S3, half agreeing) |
| E (OPI sitemap, feeds) | GTINs for ≈ 570 OPI shades; barcodes for every feed source | shades mostly overlap Phase B |
| Decision 3 = yes | + ≈ 4,000 gel | |
