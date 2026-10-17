# Shared Types — `packages/shared`

Shared TypeScript type definitions used across the monorepo. Published as `swatchwatch-shared` in the npm workspace.

## Usage

```ts
import type { Polish, PolishFinish, PolishCreateRequest } from "swatchwatch-shared";
```

The package is automatically linked via npm workspaces — no publishing required.

## Types

### `types/polish.ts`

| Type | Description |
|------|-------------|
| `Polish` | Full polish entity (id, userId, brand, name, independent hex fields, swatch image, optional `sourceImageUrls` gallery, reserved `nailImageUrl` (not populated; see `NailPhoto`), legacy `finish`, multi-finish `finishes`, tags, timestamps, etc.). Detected-hex provenance (migration 20261017024958000_shade-detected-hex-provenance): `detectedHexConfidence` (0–1), `detectedHexMethod` (`vision-direct`, `palette-pick`, `region-crop`, `ensemble`, `client-supplied`, …), `detectedHexModel` (deployment), `detectedHexPromptVersion`, `detectedHexAt`, and `hexAgreement` (OKLAB distance vendorHex ↔ detectedHex, null unless both exist). Inventory status (#261, migration 20261017061336791_inventory-status): `status` (`PolishStatus`, null for catalog-only rows), derived `isUntried` (owned and `triedAt` null), `triedAt`, `lastWornAt`, `wearCount`, `purchasePrice`, `purchaseCurrency`. `colorFamily` (`ColorFamily \| null`, the generated `shade.color_family`; see `color/color-family.ts`). Optional `buyUrl` (#267): the brand's product page from the stored source product URL, validated server-side (absolute http/https, no credentials), absent when none is stored |
| `resolveDisplayHex(polish)` | Display hex with the blind precedence vendor > detected > name (unchanged; used by the web app) |
| `HexReviewItem` / `HexReviewResponse` / `HexReviewSort` | Admin hex-review queue payload (`GET /api/polishes-admin/hex-review`): hexes, provenance, agreement, display hex/source, `flagged`; sorted by `agreement` or `confidence` |
| `PolishFinish` | Built-in finish name, derived as `(typeof CANONICAL_FINISHES)[number]` |
| `FinishName` | `PolishFinish \| (string & {})` — any finish name on API-facing fields (`Polish.finishes`, request `finish`/`finishes`); admits runtime names from admin-managed `finish_type` rows while keeping autocomplete for built-ins |
| `resolvePolishFinishes(polish)` | Finishes to display: `finishes` when non-empty, else `[finish]` (backward compatible) |
| `polishHasFinish(polish, finish)` | Case-insensitive membership check over `resolvePolishFinishes` |
| `PolishCreateRequest` | Required + optional fields for creating a polish (no id/userId/timestamps); accepts `finishes` (replace) and legacy `finish`, plus inventory `status`, `triedAt`, `purchasePrice`, `purchaseCurrency` (`null` clears the last three) |
| `PolishUpdateRequest` | Partial create fields + required `id` |
| `PolishListResponse` | Paginated list: `{ polishes, total, page, pageSize }` |
| `PolishFilters` | Query params: brand/finish/finishes/color/tags/search plus scope/availability/tone, `status` (`PolishStatus[]`), `untried`, `families` (`?family=`, any-of color families), sort, and pagination |
| `Brand` | Canonical brand entity (`brand_id`, `name_canonical`) |
| `Shade` | Canonical shade entity (`shade_id`, `brand_id`, `shade_name_canonical`, `finish`, `finishes`, `collection`, hex columns, `detected_hex_*` provenance, `hex_agreement`, etc.) |
| `CatalogSearchResult` | Single search hit: shade with brand name, `finish`/`finishes`, `colorFamily`, similarity score, and optional `buyUrl` (see `Polish.buyUrl`) |
| `CatalogSearchResponse` | Search response: `{ results, query, total }` |
| `CatalogShadeDetail` | Full shade detail with brand info, aliases, and optional `buyUrl` (see `Polish.buyUrl`) |

**Note:** All frontend pages now use the live API. The mock-data.ts file is no longer used.

### `types/hex-label.ts`

Admin Hex Labeling tool (admin console tab, routes `/api/hex-labels-admin/*`): hand-picked ground-truth hexes stored as `color_training_sample` rows with `source_type = 'manual'` (migration 20261017170047543_hex-ground-truth-labels) and exported by `npm run eval:hex:populate` as `manual` eval cases.

| Type | Description |
|------|-------------|
| `HexLabelSampleMethod` | How the hex was picked: `canvas` (averaged canvas sample), `eyedropper` (native `EyeDropper` API), `manual` (typed) |
| `HEX_LABEL_SAMPLE_SIZES` / `HexLabelSampleSize` | Averaging window sizes the canvas eyedropper offers: `1`, `3`, `5`, `9` px per side |
| `HexLabelSamplePoint` | Where a canvas sample was taken: `x`/`y` normalized 0..1 to the natural image size, `size`, `imageWidth`, `imageHeight` |
| `HexLabelImage` | A catalog product image of a shade: `imageId`, signed proxy `url`, `swatchType`, vendor `sourceUrl` (from `source_image_url`, null when unknown), `isPrimary` |
| `HexLabel` | A saved manual label: `trainingSampleId`, `shadeId`, `hex` (null only when `unreliable`), `unreliable`, `imageId`, `note`, `method`, `samplePoint`, `labeledByUserId`, `labeledAt` |
| `HexLabelQueueItem` | One queued shade: brand/name/finishes, `vendorHex`/`detectedHex`/`nameHex`, `hexAgreement`, detection confidence/method, `flagged` (agreement > MEDIUM), `images`, current `label` |
| `HexLabelQueueFilters` | `GET /api/hex-labels-admin/queue` query: `brand`, `disagreeOnly`, `showLabeled`, `includeWithoutImages`, `cursor`, `pageSize` |
| `HexLabelQueueResponse` | `{ items, nextCursor, total, labeled, pageSize, disagreementThreshold }` (`total`/`labeled` drive the progress bar) |
| `HexLabelRequest` | `POST /api/hex-labels-admin/labels` body: `shadeId`, `hex` (`#RRGGBB`, required unless `unreliable`), `imageId`, `unreliable`, `note`, `method`, `samplePoint` |
| `HexLabelSaveResponse` | `{ label, previous }`; `previous` is the label the save replaced (the client restores it to undo) |
| `HexLabelDeleteResponse` | `{ deleted }` from `DELETE /api/hex-labels-admin/labels/{id}` |

### `types/inventory.ts`

Inventory status model (#261). Every `user_inventory_item` row has one status; "untried" is **derived**, never stored.

| Export | Description |
|--------|-------------|
| `POLISH_STATUSES` | `["owned", "wishlist", "destash", "archived"]` — kept equal to the migration's CHECK constraint by `packages/functions/tests/inventory-status.unit.test.cjs` |
| `PolishStatus` | `(typeof POLISH_STATUSES)[number]` |
| `isPolishStatus(value)` | Exact (case-sensitive) type guard |
| `isOwnedStatus(status)` | `status === "owned"` — the single definition of "in the collection" (filters, dashboard, gaps, photo matching) |
| `isUntriedInventory({ status, triedAt })` | Owned and never tried; mirrors the SQL behind `Polish.isUntried` |
| `ARCHIVE_REASONS` / `ArchiveReason` / `ARCHIVE_REASON_LABELS` / `isArchiveReason(value)` | Why a polish was archived (D5c): `used_up` ("Used up") or `decluttered` ("Gave away"); sent as `archiveReason` and stored as the `inventory_event.event_type` |

### `types/manicure.ts`

Mani log (#269): `/api/manicures` payloads. Logging, editing or deleting a manicure recomputes `wearCount` / `lastWornAt` (and fills an empty `triedAt`) on the caller's inventory rows for its polishes.

| Export | Description |
|--------|-------------|
| `MANICURE_POLISH_ROLES` / `ManicurePolishRole` | `["base", "color", "accent", "topper", "other"]` — kept equal to the migration's CHECK constraint by `packages/functions/tests/manicures.unit.test.cjs` |
| `isManicurePolishRole(value)` | Exact (case-sensitive) type guard |
| `DEFAULT_MANICURE_POLISH_ROLE` | `color` — used when a request omits `role` |
| `MAX_MANICURE_POLISHES` (20), `MAX_MANICURE_NOTES_LENGTH` (2000) | Request limits shared by the API and the web form |
| `Manicure` | `{ id, wornOn (YYYY-MM-DD), notes, photoImageId, photoUrl (owner-scoped v3 or null), polishes, createdAt, updatedAt }` |
| `ManicurePolish` | One polish in a manicure: `shadeId`, the caller's current `inventoryItemId` (null after removal), `role`, `position`, `brand`, `name`, `vendorHex` / `detectedHex` / `nameHex` |
| `ManicurePolishInput` | Request polish reference: `shadeId` or `inventoryItemId` (caller's inventory only) + optional `role` |
| `ManicureCreateRequest` / `ManicureUpdateRequest` | Create (`polishes` required, `wornOn` defaults to today UTC) / partial update (`polishes` replaces the list; `null` clears `notes` / `photoImageId`) |
| `ManicureWearStat` | `{ shadeId, inventoryItemId, wearCount, lastWornAt, triedAt }` after a write |
| `ManicureMutationResponse` / `ManicureDeleteResponse` | Create/update response (`Manicure` + `wearStats`) / delete response (`{ message, id, wearStats }`) |
| `ManicureListResponse` / `ManicureFilters` | `{ manicures, total, page, pageSize }` / `from`, `to`, `shadeId`, `page`, `pageSize` (max 200) |

### `types/polish-import.ts` (CSV import API, #263)

| Type | Description |
|------|-------------|
| `PolishImportCreateRequest` | `POST /api/polish-imports` body: `{ csv, fileName?, mapping?, headerRowIndex? }` |
| `PolishImportSession` | Session: `id`, `fileName`, `status` (`review \| committed`), `delimiter`, `headers`, `headerRowIndex`, `mapping`, `rows`, `counts`, `createdAt`, `expiresAt`, `committedAt`, `result` |
| `PolishImportRow` | One sheet row: `rowNumber` (1-based file line, the row key), `values`, `matchState`, `confidence`, `candidates`, `action`, `shadeId`, `statusChoice` / `archiveReason` (quantity-0 rows, D5b), `warnings`, `errors`, and after commit `outcome` / `outcomeMessage` |
| `PolishImportRowValues` | Parsed cells: `brand`, `name`, canonical `finishes`, optional `quantity`, `purchasePrice`, `purchaseCurrency`, `purchaseDate` (`YYYY-MM-DD`), `status`, `tried`, `triedOn`, `notes` |
| `PolishImportCandidate` | Catalog candidate: `shadeId`, `brand`, `name`, `finishes`, display `hex`, `confidence` (0–1), `inCollection`, `userSubmitted`, `exactMatch` |
| `PolishImportMatchState` | `matched \| ambiguous \| unmatched \| invalid` |
| `PolishImportAction` | `match \| create \| skip \| pending` (pending rows are skipped on commit) |
| `PolishImportDecision` / `PolishImportDecisionsRequest` | Review decisions `{ rowNumber, action?, shadeId?, statusChoice?, archiveReason? }` (at least one of `action` / `statusChoice`) for `PATCH /api/polish-imports/{id}` and commit |
| `PolishImportStatusChoice` | `wishlist \| archived` — review choice for a quantity-0 row without a status cell (stored on the row as `statusChoice` + `archiveReason`); `importRowNeedsStatus(values)` (in `import/polish-import.ts`) tells which rows need one |
| `PolishImportCommitResult` / `PolishImportCommitResponse` | `{ created, updated, skipped, failed, shadesCreated }`; response adds the session and `alreadyCommitted` |
| `PolishImportCounts`, `PolishImportRowOutcome`, `PolishImportSessionStatus` | Supporting unions/counters |

### `import/` (CSV parsing + header detection, shared by web and API)

| Export | Description |
|--------|-------------|
| `parseCsv(text, { delimiter?, maxRecords? })` | RFC 4180-style parser: BOM, quoted fields with `""`, embedded delimiters/newlines, CRLF/LF/CR, Excel `sep=` line, blank records dropped; returns `records`, per-record `lineNumbers`, `delimiter`, `unterminatedQuote`, `truncated` |
| `detectCsvDelimiter(text)` | Picks `,` `;` tab or `\|` by per-line consistency outside quotes |
| `POLISH_IMPORT_FIELDS` / `PolishImportField` / `POLISH_IMPORT_FIELD_LABELS` | `brand, name, finish, quantity, price, currency, purchaseDate, status, tried, notes` |
| `PolishImportColumnMapping` | Field → 0-based column index |
| `detectPolishImportHeader(records)` | Finds the header row in the first 10 records and maps it (case/space/punctuation-insensitive synonyms, camelCase, the collection export's headers; `id`/`hex`/`family` columns ignored); `confident` when brand + name are strong matches |
| `matchImportHeader`, `mapImportHeaderRow`, `normalizeImportHeader`, `validateImportMapping` | Building blocks / mapping validation |
| `parseImportQuantity`, `parseImportPrice`, `parseImportCurrency`, `parseImportDate` (+ `detectImportDateOrder`), `parseImportStatus`, `parseImportTried`, `splitImportFinishes`, `stripFormulaGuard`, `cleanImportText`, `importMatchKey` | Cell parsers (each returns `{ value?, error? }`) and normalization helpers |
| `POLISH_IMPORT_MAX_BYTES` (1 MB), `POLISH_IMPORT_MAX_ROWS` (1000), `POLISH_IMPORT_MAX_COLUMNS` (100), `POLISH_IMPORT_MAX_NOTES_LENGTH`, `POLISH_IMPORT_MAX_NAME_LENGTH` | Limits enforced by the API and pre-checked by the web |

### `types/collection-export.ts`

Collection export (#264), `GET /api/polishes/export`.

| Export | Description |
|--------|-------------|
| `POLISH_CSV_COLUMNS` | The CSV column contract shared with the CSV import (#263): `{ key, header, importField }[]` in file order. Round-trip columns first (`Brand`→`brand`, `Shade name`→`name`, `Finishes`→`finish`, `Quantity`→`quantity`, `Status`→`status`, `Date tried`→`tried`, `Purchase price`→`price`, `Currency`→`currency`, `Purchase date`→`purchaseDate`, `Notes`→`notes`; each header is one the importer recognizes as a strong synonym), then export-only extras with `importField: null` (`Display hex`, `Collection`, `Rating`, `Tags`, `Size`, `Expiration date`, `Last worn`, `Wear count`, `Shade ID`, `Item ID`, `Created at`, `Updated at`) |
| `POLISH_CSV_HEADERS` | Header row (`POLISH_CSV_COLUMNS[].header`) |
| `PolishCsvColumn` / `PolishCsvColumnKey` / `PolishCsvImportField` | Column shape, column keys, and the importer field names a column can feed |
| `POLISH_CSV_LIST_SEPARATOR` | `", "` — joins `Finishes` and `Tags` cells |
| `COLLECTION_EXPORT_VERSION` | `1` — JSON envelope version; bump when a field is removed or changes meaning |
| `COLLECTION_EXPORT_FORMATS` / `CollectionExportFormat` / `isCollectionExportFormat()` | `"csv" \| "json"` |
| `CollectionExportItem` | One exported inventory row: a `Polish` subset (`inventoryItemId`, `shadeId`, `brand`, `name`, `color`, `finishes`, `collection`, `quantity`, `status`, `isUntried`, `triedAt`, `lastWornAt`, `wearCount`, `purchasePrice`, `purchaseCurrency`, `purchaseDate`, `expirationDate`, `size`, `rating`, `notes`, `tags`, the three hexes, `createdAt`, `updatedAt`) plus `displayHex`; no image URLs |
| `CollectionExport` | JSON envelope `{ version: 1, exportedAt, statusFilter, itemCount, items }` |
| `collectionExportFilename(format, at?)` | `swatchwatch-collection-YYYY-MM-DD.<format>` (UTC date) |

### `types/stats.ts`

Collection stats (#271): the `GET /api/stats/collection` payload behind the dashboard panels. Money is never summed across currencies — every amount sits in a per-currency group (`currency: null` = price saved without one).

| Export | Description |
|--------|-------------|
| `COLLECTION_STATS_TOP_BRANDS` (8), `COLLECTION_STATS_MONTHS` (12), `COLLECTION_STATS_MOST_WORN` (10), `COLLECTION_STATS_COST_PER_WEAR_LIST` (5) | List sizes used by the API |
| `SPEND_STATUSES` | `["owned", "destash", "archived"]` — statuses whose purchase price counts as spend (a wishlist price is a target, not money spent) |
| `CollectionStatsResponse` | `{ generatedAt, totals: { byStatus, total }, untried: { owned, untried, percent \| null }, wornVsWaiting: { worn, waiting }, spend, mostWorn, costPerWear: { currencies, pricedUnwornCount } }` |
| `CollectionSpendStats` | `{ currencies: CurrencySpend[], months (YYYY-MM, oldest first), pricedCount, unpricedCount }` |
| `CurrencySpend` | One currency: `currency`, all-time `total` / `itemCount`, `byBrand` (top N + one "Other"), `byMonth` (zero-filled) |
| `SpendByBrandEntry` / `SpendByMonthEntry` | `{ brand, isOther, brandCount, total, itemCount }` / `{ month, total, itemCount, estimatedDateCount }` (`estimatedDateCount` = rows bucketed by `createdAt` because they have no purchase date) |
| `CollectionStatsShade` | Shared entry fields: `inventoryItemId`, `shadeId` (null for a SKU-only row), `brand`, `name`, `vendorHex`, `detectedHex`, `nameHex` |
| `MostWornEntry` | `CollectionStatsShade` + `status`, `wearCount`, `lastWornAt` |
| `CostPerWearEntry` / `CostPerWearCurrency` | `CollectionStatsShade` + `price`, `wearCount`, `costPerWear` / `{ currency, wornCount, pricedUnwornCount, best, worst }` (`worst` never repeats a `best` item) |

### `constants/finishes.ts`

| Export | Description |
|--------|-------------|
| `CANONICAL_FINISHES` | Built-in seeded default finishes — typing + offline fallback, not the runtime authority (`creme`, `sheer`, `jelly`, `shimmer`, `metallic`, `glitter`, `holographic`, `duochrome`, `multichrome`, `flake`, `matte`, `topper`, `magnetic`, `thermal`, `crelly`, `glow`, `other`) in `finish_type.sort_order` order |
| `isCanonicalFinish(value)` | Type guard for exact BUILT-IN names (unaware of finish types added at runtime) |

**Multi-finish contract (#43):** `finishes` is the source of truth for display/filtering; `finish` is the legacy single value kept populated for older consumers (it is the shade's identity key in the DB). At runtime the admin-managed `finish_type` table decides *which* finishes are valid; `CANONICAL_FINISHES` is only the built-in seeded defaults (used for typing and as the fallback when the DB is unavailable) and is kept equal to the seeded `finish_type` rows by `packages/functions/tests/finishes.unit.test.cjs`. Alias spellings (`holo`, `cream`, `flakie`, …) are not listed here — they live in the DB-backed `finish_normalization` table (see `packages/functions/README.md`).

### `constants/outbound-links.ts`

| Export | Description |
|--------|-------------|
| `OUTBOUND_LINK_TARGET` | `"_blank"` — outbound "Buy from brand" links open in a new tab |
| `OUTBOUND_LINK_REL` | `"noopener noreferrer nofollow"` — required `rel` for every outbound buy link (no `window.opener`, no referrer, no endorsement) |

### `color/` (OKLAB math, thresholds, hex reconciliation, color families)

| Export | Description |
|--------|-------------|
| `hexToOklab`, `rgbToOklab`, `oklabDistance`, `colorDistance` | OKLAB conversion and Euclidean distance (black↔white ≈ 1.0, ~0.02 ≈ one JND); shared by web and API |
| `HIGH_CONFIDENCE_MAX_DISTANCE` (0.05), `MEDIUM_CONFIDENCE_MAX_DISTANCE` (0.10), `confidenceForDistance(d)` | Distance buckets used by photo matching and vendor↔detected reconciliation (`color/thresholds.ts`) |
| `normalizeHexColor(value)` | Uppercase `#RRGGBB` or null |
| `computeHexAgreement(vendorHex, detectedHex)` | OKLAB distance rounded to 4 decimals, null unless both hexes are valid; mirrors the Postgres `hex_oklab_distance()` behind `shade.hex_agreement` |
| `resolveDisplayHexDetailed(polish, { vendorHexSuspicious?, disagreementThreshold? })` | Pure reconciliation → `{ hex, source, agreement, flagged, reason }`. Keeps vendor > detected > name by default; flags `disagreement` when vendor and detected differ by more than MEDIUM; when the caller marks the vendor hex suspicious, prefers detected (and flags `vendor-suspicious` if the vendor hex still had to be used). Uses a stored `hexAgreement` when present |
| `COLOR_FAMILIES`, `ColorFamily`, `HexColorFamily`, `isColorFamily(value)` | The 15 color families (#103): `red`, `pink`, `coral`, `orange`, `yellow`, `green`, `teal`, `blue`, `purple`, `nude`, `brown`, `grey`, `black`, `white`, `multichrome` (`color/color-family.ts`) |
| `COLOR_FAMILY_LABELS`, `COLOR_FAMILY_SWATCH_HEX` | Display label and representative chip swatch per family (each swatch classifies into its own family; render `multichrome` as a gradient) |
| `classifyColorFamily(polish)` | Family of a shade: `multichrome` when any of `finishes`/`finish` is a color-shifting finish (`MULTICHROME_FAMILY_FINISHES`: `multichrome`, `chameleon`, `colorshift`/`color shift`/`color-shift`; `duochrome` is binned by hex), otherwise the family of `resolveDisplayHex` (vendor > detected > name); null when that hex is missing/invalid. Mirrors the Postgres `shade_color_family()` behind the generated `shade.color_family` column |
| `classifyHexColorFamily(hex)`, `classifyOklchColorFamily({ L, C, h })`, `hexToOklch(hex)`, `hasMultichromeFinish(polish)` | Building blocks: bin one hex / OKLCH triple (never `multichrome`), OKLCH conversion, finish check |
| `COLOR_FAMILY_THRESHOLDS` | The OKLCH bins. Order: chroma < 0.03 → black (L < 0.30) / white (L ≥ 0.92) / grey; very dark (L < 0.20, C < 0.06) → black; pale tints (L ≥ 0.96, C < 0.06) → white; warm hue 20–100 with L ≥ 0.70 and C ≤ 0.10 → nude; warm hue 30–100 below L 0.70 with C ≤ 0.13 (or very dark from hue 36) → brown; then hue bands: pink 340–20 (dark → red, or purple for 340–350), 20–45 coral when L ≥ 0.68 else red/orange (split at 36), orange 45–80, yellow 80–115 (dark → brown/olive green), green 115–170, teal 170–205, blue 205–290, purple 290–320, 320–340 pink when light and saturated else purple. Changing a value needs a migration that redefines `shade_color_family_from_hex()`; `packages/functions/tests/color-family.unit.test.cjs` checks the SQL constants match |
| `DUPE_LIMITS` | `{ defaultLimit: 5, maxLimit: 20, batchMaxShadeIds: 100 }` for the dupe endpoints (`color/dupes.ts`) |
| `DUPE_FINISH_FAMILIES`, `finishFamily(finish)` | Finish families for dupe compatibility: solid (creme/crelly/jelly/sheer), shimmer (shimmer/metallic/magnetic/duochrome/multichrome), holo, glitter (glitter/flake/topper), matte, thermal, glow; `other` and admin-defined finishes have no family |
| `finishCompatibility(targetFinishes, candidateFinishes)` | `same` (same primary), `compatible` (same family or any shared finish), `different` (known, different families), `unknown` (missing/`other`/unfamilied) |
| `gradeDupe(distance, compatibility)` | `{ colorGrade, grade }`: `confidenceForDistance` (the match-image thresholds), dropped one step for `different` finishes; `grade` null when LOW |
| `prepareDupeShade(shade)`, `prepareDupeCandidates(shades)`, `findDupes(target, candidates)`, `summarizeDupes(id, dupes)`, `compareDupes` | Pure dupe finder: resolve each display hex (`resolveDisplayHexDetailed`) and OKLAB once, then O(N) per target; excludes the target's own id; ordered by grade, finish compatibility, distance, brand/name |

### `types/user.ts`

| Type | Description |
|------|-------------|
| `User` | User entity (id, email, displayName, avatarUrl, authProvider, timestamps) |
| `AuthProvider` | `"apple" \| "facebook" \| "google" \| "email"` |
| `AuthConfig` | B2C configuration (authority, clientId, knownAuthorities, redirectUri, scopes) |
| `AdminUserListItem` | Admin user-management table row (`userId`, role, linked identities, and activity counts) |
| `AdminUserListResponse` | Admin user list payload wrapper (`users`, `total`) |
| `AdminUserMergeRequest` | Admin payload for duplicate-account repair (`sourceUserId`, `targetUserId`) |
| `AdminUserMergeResponse` | Admin merge result summary (moved row counts incl. `mergedManicureRows` + merge status/message) |

### `types/shade-review.ts`

Admin review queue for `user_submitted` shades (`/api/shades-admin/review*`).

| Type | Description |
|------|-------------|
| `ShadeReviewStatus` | Last admin decision on a shade: `"approved" \| "rejected" \| "merged"` (null = not reviewed) |
| `ShadeReviewQueueState` | Queue slice to list: `"pending" \| "rejected"` |
| `ShadeReviewHexes` | Vendor/detected/name hexes plus `displayHex`/`displaySource` |
| `ShadeReviewItem` | One submission: brand, name, finishes, hexes, `createdAt`, `createdByUserId`, `submitterCount`, last review decision, and `candidates` |
| `ShadeReviewMergeCandidate` | An active shade it could merge into: `similarity` (0.7 × name/alias + 0.3 × brand trigram), `nameSimilarity`, `sameBrand`, OKLAB `colorDistance`, `inventoryCount`, `swatchImageUrl` |
| `ShadeReviewListResponse` / `ShadeReviewCandidatesResponse` | Queue page (`items`, `total`, `page`, `pageSize`, `state`) / candidate search result (`shadeId`, `query`, `candidates`) |
| `ShadeReviewApproveRequest` | Optional approve edits (`brand`, `name`, `finishes`, `collection`, `colorName`, `vendorHex`, `nameHex`, `note`) |
| `ShadeReviewMergeRequest` / `ShadeReviewRejectRequest` | `{ targetShadeId, keepNameAsAlias?, note? }` / `{ note? }` |
| `ShadeReviewActionResponse` / `ShadeReviewMergeResponse` | Action result (`status`, `reviewStatus`, `reviewedAt`, `reviewedByUserId`, `message`); merge adds `targetShadeId` and moved/combined inventory, alias, SKU and swatch counts |

### `types/wishlist-share.ts`

Shareable wishlist (#268), behind the server flag `SHAREABLE_WISHLIST_ENABLED` (off by default).

| Type | Description |
|------|-------------|
| `WishlistShareStatus` | Owner view of their link (`GET/POST/DELETE /api/wishlist-share`, `POST /api/wishlist-share/rotate`): `enabled`, `token` (re-derived; null when none or no longer derivable), `path` (`/w/?token=…`), `displayName`, `wishlistCount` (items the public page shows), `hiddenCount` (own `user_submitted` shades kept private), `createdAt`, `rotatedAt` |
| `WishlistShareEnableRequest` | `{ displayName?: string \| null }` — optional public name (≤ 60 chars, no email addresses) |
| `PublicWishlistItem` | Public allowlist entry: `brand`, `name`, `finishes`, `hex` (display hex), `imageUrl` (public catalog image or null) |
| `PublicWishlistResponse` | `GET /api/wishlist/{token}`: `{ displayName, items }` — no ids, email, notes, prices or quantities |
| `wishlistSharePath(token)` | Web path of the public page, `/w/?token=<token>` (static export → query param) |
| `WISHLIST_SHARE_FEATURE_DISABLED_CODE` | `"feature_disabled"` — `code` of the 404 every wishlist-share route returns while the flag is off |
| `WISHLIST_SHARE_DISPLAY_NAME_MAX_LENGTH` | `60` |

### `types/voice.ts`

| Type | Description |
|------|-------------|
| `VoiceProcessRequest` | Audio format declaration (`wav \| webm \| ogg \| mp3`) |
| `ParsedPolishDetails` | AI-extracted fields from voice transcription + confidence score |
| `VoiceProcessResponse` | Parsed result + optional alternative suggestions |
| `VoiceCommand` | Discriminated union: `add \| update \| delete \| search` actions |

### `types/capture.ts`

| Type | Description |
|------|-------------|
| `CaptureStatus` | Capture lifecycle status: `processing \| matched \| needs_question \| unmatched \| cancelled` |
| `CaptureFrameType` | Frame classification: `barcode \| label \| color \| other` |
| `CaptureQuestionType` | Clarifying question type for adaptive flow |
| `CaptureQuestionStatus` | Question status: `open \| answered \| skipped \| expired` |
| `CaptureGuidanceConfig` | Capture guidance contract returned by `/api/capture/start` |
| `CaptureQuestion` | Open question payload used by status/finalize/answer responses |
| `CaptureStartRequest` / `CaptureStartResponse` | Start capture session payloads |
| `CaptureFrameRequest` / `CaptureFrameResponse` | Add frame payloads (`imageId` or `imageBlobUrl`) |
| `CaptureFinalizeResponse` | Finalize response with session status and optional question |
| `CaptureStatusResponse` | Session status payload with confidence/accepted entity/question |
| `CaptureAnswerRequest` / `CaptureAnswerResponse` | Answer question payloads for adaptive loop |
| `CaptureOwnershipRelationship` | Caller's relationship to a matched shade: `owned \| wishlisted \| notOwned` |
| `CaptureOwnership` | `{ relationship, quantity? }` (`quantity` = total owned, only when `owned`) |
| `CaptureCheckOutcome` | Resolver outcome reported by check: `matched \| needs_question \| unmatched` |
| `CaptureCheckCandidate` | Match/candidate with `entityType`, `entityId`, `shadeId`, `display`, `confidence`, `ownership` |
| `CaptureCheckResponse` | `POST /api/capture/{captureId}/check` payload: outcome, confidence, `match?`, `candidates`, `questionKey?`, unchanged session `status` (read-only, never touches inventory) |

### `types/palette.ts`

| Type | Description |
|------|-------------|
| `HarmonyType` | Search harmony selector values: `"similar" \| "complementary" \| "split-complementary" \| "analogous" \| "triadic" \| "tetradic" \| "monochromatic"` |
| `PaletteHarmonyType` | Harmony-only subset excluding `"similar"` |
| `PaletteSuggestion` | Auto-detected harmony result for 2+ anchor colors (`confidence`, `sourceHex`, `targetHexes`, `completionHexes`) |
| `HueFamily` | Gap-analysis hue bins: reds, oranges/corals, yellows/golds, greens, blues/teals, purples/violets, pinks/magentas, neutrals |
| `LightnessBand` | Gap-analysis lightness bins: `dark \| dark-medium \| medium \| medium-light \| light` |
| `CollectionGapCell` | Count per hue/lightness cell |
| `CollectionGapAnalysis` | Structured gap-analysis output (`cells`, `missing`, `underrepresented`) |

### `types/color-match.ts`

| Type | Description |
|------|-------------|
| `MatchConfidence` | `"high" \| "medium" \| "low"` — bucketed OKLAB distance (thresholds in Functions `lib/color-match.ts`) |
| `ExtractedColor` | Dominant image color: uppercase `hex` + pixel `fraction` (0–1) |
| `PolishImageMatchRequest` | Body for `POST /api/polishes/match-image`: `image` (base64 data URL), optional `maxColors` (1–10), `limit` (1–50) |
| `PolishMatch` | `{ polish, matchedColor, distance, confidence }` — one owned polish matched to its closest extracted color |
| `PolishImageMatchResponse` | `{ extractedColors, matches, candidateCount }` |

### `types/dupes.ts` (dupe finder, #265)

| Type | Description |
|------|-------------|
| `FinishCompatibility` | `"same" \| "compatible" \| "different" \| "unknown"` — how two shades' finishes relate (rule in `color/dupes.ts`) |
| `DupeGrade` | `"high" \| "medium"` — grades that count as a dupe (`low` is never returned) |
| `PolishDupe` | One owned dupe: `shadeId`, `brand`, `name`, `finishes`, `displayHex` + `displayHexSource`, OKLAB `distance`, `colorGrade` (distance only), final `grade`, `finishCompatibility` |
| `PolishDupesTarget` | The shade the dupes were computed for: `shadeId`, `displayHex` (null = no usable hex), `displayHexSource`, `finishes` |
| `PolishDupesResponse` | `GET /api/polishes/{id}/dupes`: `{ target, dupes, dupeCount, highCount, candidateCount }` (`dupes` capped by `limit`, counts are not) |
| `PolishDupesBatchRequest` | `POST /api/polishes/dupes` body: `{ shadeIds }` (≤ `DUPE_LIMITS.batchMaxShadeIds`) |
| `PolishDupeHint` | Compact list-row hint: `{ shadeId, best, dupeCount, highCount }` |
| `PolishDupesBatchResponse` | `{ results: Record<shadeId, PolishDupeHint>, candidateCount }`; missing/invisible ids are omitted |

### `types/ingestion.ts`

| Type | Description |
|------|-------------|
| `IngestionSourceName` | Allowed generated source names for connector ingestion jobs (OpenBeautyFacts, MakeupAPI, HoloTacoShopify, Shopify sources, CosIng, etc.) |
| `ConnectorProtocol` | Connector protocol group: `"HoloTaco" \| "Shopify" \| "OpenBeautyFacts" \| "MakeupAPI" \| "GS1" \| "Custom"` |
| `IngestionJobStatus` | Job lifecycle status: `queued \| running \| succeeded \| failed \| cancelled` |
| `IngestionLogLevel` | Job log level: `debug \| info \| warn \| error` |
| `IngestionLogEntry` | One job log line in `metrics.logs`: `{ ts, level, msg, data? }`; the single omission marker also carries `omitted` |
| `IngestionLogOmission` | Roll-up on the marker entry of a bounded job log: `{ count, byLevel, firstTs?, lastTs? }` for the lines dropped between the start of the run and the newest lines |
| `IngestionJobRunRequest` | Request payload for `POST /api/ingestion/jobs` (includes optional `recentDays`, `materializeToInventory`, `detectHexFromImage`, `overwriteDetectedHex`, and `exhaustive` for full-catalog pulls) |
| `BulkIngestionRequest` | Request payload for `POST /api/ingestion/bulk` (`sources: IngestionSourceName[]`, optional `options` for `materializeToInventory`, `detectHexFromImage`, and `overwriteDetectedHex`) |
| `BulkIngestionResponse` | Bulk run response: `{ enqueued: number, jobs: IngestionJobRecord[] }` |
| `IngestionJobRecord` | Ingestion job summary payload (source, status, timestamps, metrics, error) |
| `IngestionJobRunResponse` | Job-trigger response wrapper: `{ job }` |
| `IngestionJobListResponse` | Job list payload: `{ jobs, total }` |

### `types/nail-photo.ts`

| Export | Description |
|--------|-------------|
| `NailPhoto` | Private on-nail photo for one inventory item (#270): `inventoryItemId`, `shadeId`, `imageUrl` (owner-scoped `/api/images/v3.*` URL only, `null` if it cannot be signed; fetch with the bearer token, e.g. web `PrivateImage`), `contentType` (re-encoded, `image/jpeg`), `width`, `height`, `sizeBytes`, `createdAt`, `updatedAt` |
| `NailPhotoResponse` | `GET`/`PUT /api/inventory/{inventoryItemId}/nail-photo` payload: `{ photo: NailPhoto \| null }` |
| `NailPhotoUploadRequest` | `PUT` body: `{ image }` — a base64 data URL |
| `NAIL_PHOTO_ACCEPTED_TYPES` / `NailPhotoUploadType` | Accepted upload types: `image/jpeg`, `image/png`, `image/webp`, `image/heic`, `image/heif` (HEIC only when the server can decode it, else 415) |
| `NAIL_PHOTO_MAX_UPLOAD_BYTES` | Largest decoded upload the API accepts (8 MB) |
| `NAIL_PHOTO_MAX_EDGE` | Longest edge (px) the server stores (2048; larger photos are downscaled) |

### `types/reference.ts`

| Type | Description |
|------|-------------|
| `FinishType` | Reference finish row contract (`finishTypeId`, `name`, `displayName`, `description`, `sortOrder`, audit fields) |
| `HarmonyType` | Reference harmony row contract (`harmonyTypeId`, `name`, `displayName`, `description`, `sortOrder`, audit fields) |
| `FinishTypeCreateRequest` / `FinishTypeUpdateRequest` | Request payloads for admin finish create/update endpoints |
| `FinishTypeInUseResponse` | `409` body of `DELETE /api/reference-admin/finishes/{id}` when the finish type is still in use (`error`, `code: "FINISH_TYPE_IN_USE"`, `finishTypeId`, `name`, `shadeCount`, `normalizationCount`) |
| `FinishTypeUpdateResponse` / `FinishTypeRenameSummary` | `200` body of `PUT /api/reference-admin/finishes/{id}`: the `FinishType` plus `rename` (`previousName`, `shadeCount`, `normalizationCount`, `aliasCreated`) when `name` changed |
| `FinishTypeNameTakenResponse` | `409` body of that `PUT` when another finish type already has the new name, compared case-insensitively (`error`, `code: "FINISH_TYPE_NAME_TAKEN"`, `finishTypeId`, `name`, `requestedName`, `conflictingFinishTypeId?`, `conflictingName?`) |
| `HarmonyTypeCreateRequest` / `HarmonyTypeUpdateRequest` | Request payloads for admin harmony create/update endpoints |
| `FinishNormalization` | Alias mapping row (`sourceValue` → `normalizedFinishName`) with audit fields |
| `FinishNormalizationCreateRequest` / `FinishNormalizationUpdateRequest` | Request payloads for admin finish-normalization create/update endpoints |
| `FinishNormalizationListResponse` | Response wrapper for finish normalization list endpoint |
| `FinishTypeListResponse` | Response wrapper for finish list endpoint |
| `HarmonyTypeListResponse` | Response wrapper for harmony list endpoint |
| `IngestionJob` | Jobs-tab oriented ingestion job row shape (status/timing/error/processed count) |
| `AdminJobsListResponse` | Admin jobs page/list payload wrapper (`jobs`, `total`, `page`, `pageSize`) |

Export note:
- `HarmonyType` is already used by `types/palette.ts` for palette selection values.
- `types/reference.ts` harmony row type is re-exported from package root as `ReferenceHarmonyType`.
- These reference contracts are consumed by the web `use-reference-data` hook for API-backed finish/harmony option loading with fallback support.

## Utilities

### `color/oklab.ts`

Pure, dependency-free OKLAB color math shared by the web app (`apps/web/src/lib/color-utils.ts` re-exports it) and Azure Functions (`packages/functions/src/lib/color-match.ts`), so perceptual distances are identical on client and server. Euclidean OKLAB distance: black↔white ≈ 1.0, ~0.02 ≈ just-noticeable difference.

| Export | Description |
|--------|-------------|
| `OKLab` | `{ L, a, b }` OKLAB coordinates |
| `rgbToOklab(rgb)` | 0–255 sRGB `{ r, g, b }` → OKLAB |
| `hexToOklab(hex)` | `#RRGGBB` / `RRGGBB` → OKLAB |
| `oklabDistance(a, b)` | Euclidean distance between two OKLAB colors |
| `colorDistance(hex1, hex2)` | OKLAB distance between two hex colors |
| `oklabToRgb(oklab)` | OKLAB → 0–255 sRGB `{ r, g, b }` (gamut-clipped per channel) |
| `rgbToHexString(rgb)` | 0–255 sRGB `{ r, g, b }` → uppercase `#RRGGBB` |
| `oklabToHex(oklab)` | OKLAB → uppercase `#RRGGBB` (gamut-clipped) |

Pinned-distance tests in `packages/functions/tests/color-match.unit.test.cjs` and `apps/web/src/lib/color-utils.test.ts` guard against numeric drift.

## Adding New Types

1. Create or edit a file in `src/types/`
2. Re-export from `src/index.ts`:
   ```ts
   export * from "./types/my-new-type";
   ```
3. Build: `npm run build --workspace=packages/shared`
4. Other packages can immediately import the new types

## Build

```bash
npm run build --workspace=packages/shared    # tsc → dist/
npm run typecheck --workspace=packages/shared # tsc --noEmit
```

**Important:** You must build this package before other packages can resolve its types. The `main` and `types` fields in `package.json` point to `dist/`.
