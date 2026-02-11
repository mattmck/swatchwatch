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
| `Polish` | Full polish entity (id, userId, brand, name, color, colorHex, finish, tags, timestamps, etc.) |
| `PolishFinish` | Union of finish types: `"cream" \| "shimmer" \| "glitter" \| "metallic" \| "matte" \| "jelly" \| "holographic" \| "duochrome" \| "multichrome" \| "flake" \| "topper" \| "sheer" \| "other"` |
| `PolishCreateRequest` | Required + optional fields for creating a polish (no id/userId/timestamps) |
| `PolishUpdateRequest` | Partial create fields + required `id` |
| `PolishListResponse` | Paginated list: `{ polishes, total, page, pageSize }` |
| `PolishFilters` | Query params: brand, finish, color, tags, search, sort, pagination |
| `Brand` | Canonical brand entity (`brand_id`, `name_canonical`) |
| `Shade` | Canonical shade entity (`shade_id`, `brand_id`, `shade_name_canonical`, `finish`, `collection`, etc.) |
| `CatalogSearchResult` | Single search hit: shade with brand name and similarity score |
| `CatalogSearchResponse` | Search response: `{ results, query, total }` |
| `CatalogShadeDetail` | Full shade detail with brand info and aliases |

**Note:** All frontend pages now use the live API. The mock-data.ts file is no longer used.

### `types/user.ts`

| Type | Description |
|------|-------------|
| `User` | User entity (id, email, displayName, avatarUrl, authProvider, timestamps) |
| `AuthProvider` | `"apple" \| "facebook" \| "google" \| "email"` |
| `AuthConfig` | B2C configuration (authority, clientId, knownAuthorities, redirectUri, scopes) |

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
| `LightnessBand` | Gap-analysis lightness bins: `dark \| medium \| light` |
| `CollectionGapCell` | Count per hue/lightness cell |
| `CollectionGapAnalysis` | Structured gap-analysis output (`cells`, `missing`, `underrepresented`) |

### `types/ingestion.ts`

| Type | Description |
|------|-------------|
| `IngestionSourceName` | Allowed source names for connector ingestion jobs (OpenBeautyFacts, MakeupAPI, CosIng, etc.) |
| `IngestionJobStatus` | Job lifecycle status: `running \| succeeded \| failed \| cancelled` |
| `IngestionJobRunRequest` | Request payload for `POST /api/ingestion/jobs` (includes optional `materializeToInventory`) |
| `IngestionJobRecord` | Ingestion job summary payload (source, status, timestamps, metrics, error) |
| `IngestionJobRunResponse` | Job-trigger response wrapper: `{ job }` |
| `IngestionJobListResponse` | Job list payload: `{ jobs, total }` |

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
