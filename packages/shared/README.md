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

### `types/inventory.ts`

Inventory status model (#261). Every `user_inventory_item` row has one status; "untried" is **derived**, never stored.

| Export | Description |
|--------|-------------|
| `POLISH_STATUSES` | `["owned", "wishlist", "destash", "archived"]` — kept equal to the migration's CHECK constraint by `packages/functions/tests/inventory-status.unit.test.cjs` |
| `PolishStatus` | `(typeof POLISH_STATUSES)[number]` |
| `isPolishStatus(value)` | Exact (case-sensitive) type guard |
| `isOwnedStatus(status)` | `status === "owned"` — the single definition of "in the collection" (filters, dashboard, gaps, photo matching) |
| `isUntriedInventory({ status, triedAt })` | Owned and never tried; mirrors the SQL behind `Polish.isUntried` |

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

### `types/user.ts`

| Type | Description |
|------|-------------|
| `User` | User entity (id, email, displayName, avatarUrl, authProvider, timestamps) |
| `AuthProvider` | `"apple" \| "facebook" \| "google" \| "email"` |
| `AuthConfig` | B2C configuration (authority, clientId, knownAuthorities, redirectUri, scopes) |
| `AdminUserListItem` | Admin user-management table row (`userId`, role, linked identities, and activity counts) |
| `AdminUserListResponse` | Admin user list payload wrapper (`users`, `total`) |
| `AdminUserMergeRequest` | Admin payload for duplicate-account repair (`sourceUserId`, `targetUserId`) |
| `AdminUserMergeResponse` | Admin merge result summary (moved row counts + merge status/message) |

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

### `types/ingestion.ts`

| Type | Description |
|------|-------------|
| `IngestionSourceName` | Allowed generated source names for connector ingestion jobs (OpenBeautyFacts, MakeupAPI, HoloTacoShopify, Shopify sources, CosIng, etc.) |
| `ConnectorProtocol` | Connector protocol group: `"HoloTaco" \| "Shopify" \| "OpenBeautyFacts" \| "MakeupAPI" \| "GS1" \| "Custom"` |
| `IngestionJobStatus` | Job lifecycle status: `queued \| running \| succeeded \| failed \| cancelled` |
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
