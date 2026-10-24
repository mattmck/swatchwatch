# Bottle Flow (Slice A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rapid Add on web and mobile walks a hand-held bottle through front → bottom → glass (plus an optional box) with prompts the server chooses, measures the lacquer color from the glass frame, reads the bottom sticker with the vision model, resolves brand first and shade within brand, remembers a sticky brand hint across bottles, and lets the user create an unknown shade with one tap, all behind `BOTTLE_CAPTURE_ENABLED` (default `false`).

**Architecture:** Every new server piece is a `packages/functions/src/lib/*` module with a pure, unit-tested core (`bottle-flow` prompt planner, `glass-color` palette pick with a deterministic fallback, `sticker-read` closed-set vision read, `brand-resolve` trigram brand matching, `bottle-resolver` scoring bands, `capture-frame-store` + `capture-frame-sweep` retention) that `functions/capture.ts` calls only when `isFeatureEnabled("bottleCapture")`; with the flag off every handler keeps today's code path and today's responses. The resolver's private types and evidence collection move out of `capture.ts` into `lib/capture-evidence.ts` first so the new modules can share them. Frame bytes are stored as private blobs under `{userId}/capture/{captureId}/` for the session's life, released at a terminal state and swept after 24 hours by a new timer. The client contract (`nextFrame`, `suggestedShade`, `brandConflict`, surfaces, sticky hints, the create card) lives in `packages/shared` with a shared client-side flow reducer, so `apps/web/src/lib/rapid-add-flow.ts` and `apps/mobile/src/lib/rapid-add.ts` only add thin wiring and their verdict kinds. `POST /api/polishes` gains `captureId` so the one-tap create marks the session matched and learns the barcode in the same transaction. The `eval:bottle` runner follows the prompts and reports model calls per bottle and a finish-family split.

**Tech Stack:** Azure Functions v4 (Node 22, TS), sharp, Azure OpenAI chat completions via `requestAzureOpenAIChatCompletion`, Postgres `pg_trgm` + stored `shade.oklab_*`, Next.js 16 client components + shadcn/ui, Expo Router + `expo-camera`, node:test (`node --test` for Functions, `tsx --test` for shared/web/mobile), Terraform.

**Spec:** `docs/superpowers/specs/2026-10-23-bottle-recognition-design.md` (§4 UX, §5 Slice A, §9.1 retention, §10 rollout; decisions §11–§12)

**Builds on:** Slice 0 (`docs/superpowers/plans/2026-10-23-bottle-eval-capture.md`, PR mattmck/swatchwatch#459). The Slice A branch was cut from `dev` after #459 merged; the PR targets `dev` (D24). No migration: Slice A uses the existing `capture_session`, `capture_frame`, `image_asset`, `user_shade_barcode` and `shade.oklab_*` columns.

**Calls made in this plan (the spec leaves them open or silent):**
- Frame blob storage (§9.1) is also behind the flag: off, frames keep the `inline://` placeholder exactly as today. The sweep timer runs regardless (it finds nothing while off).
- "Can't see it" is `POST /api/capture/{id}/answer` with a new body field `skipSurface` (no open `capture_question` needed); the response carries the next `nextFrame`.
- There is no cancel route today; an abandoned session is a `processing` session whose frames the 24-hour sweep releases.
- The §5.4 telemetry events are emitted server-side (`trackEvent` in the capture handlers and `polishes.ts`), where every client's flow is visible at once.
- Picking a candidate or tapping Add on the check-first path uses `PUT /api/polishes/{shadeId}` as mobile does today; it does not mark the session or learn the barcode (pre-existing mobile gap, follow-up ticket). Only the one-tap create (`POST /api/polishes` with `captureId`) marks the session.
- Only a hex the server measured from a `color` frame (`quality_json.extracted.source = "glass"`) is color evidence; a client-supplied `quality.hex` is ignored.
- The client flow reducer is shared (`packages/shared/src/capture/bottle-flow.ts`), not duplicated per app.
- Candidate rows show the swatch `hex`, confidence and the new `colorDistance`; the catalog image on candidate and match rows (§4.3) waits for Slice B, which loads catalog images at check time anyway.

## Global Constraints

- `BOTTLE_CAPTURE_ENABLED` is read through `isFeatureEnabled("bottleCapture")` (`packages/functions/src/lib/feature-flags.ts`) at call time; on only for the exact value `true`. Off: no new response keys, no model calls on `color` frames, no blob writes, the resolver returns today's decisions.
- Every capture route stays `withAuth`; every SQL statement is parameterized and bound to the caller's `user_id` (`capture_session.user_id`, `image_asset.owner_id`); candidate queries include another user's `user_submitted` shade never, the caller's own always.
- Rule #224 holds: nothing in a capture writes a shared `shade`; the only shade write is `findOrCreateShade` through `POST /api/polishes`, and a shared `brand` row is inserted only from text the user typed or confirmed (`brandSource !== "read"` or confirmed on the card).
- Every AI step is best effort inside the frame endpoint's existing budgets: OCR 15 s, one chat completion per frame (15 s, `requestAzureOpenAIChatCompletion` retry rules), low-detail images. A failed or unconfigured model never fails the frame; the fallback is today's behavior.
- Frames never get a `v3` proxy id and never appear in any polish, media or share response; model prompts receive frame bytes as data URIs only.
- Thresholds come from `swatchwatch-shared`: `HIGH_CONFIDENCE_MAX_DISTANCE = 0.05`, `MEDIUM_CONFIDENCE_MAX_DISTANCE = 0.1`; the resolver's bands are `0.92` / `0.75` / `0.5` (spec §5.3) in one constant object with tests.
- New env vars go in CLAUDE.md (matching group), `packages/functions/README.md` env table and `packages/functions/local.settings.json.example`; the flag also in `infrastructure/variables.tf`, `main.tf` app settings, `.github/workflows/deploy-infra.yml` and `infrastructure/README.md` like `SHAREABLE_LOOKS_ENABLED`.
- Shared types in `packages/shared/src/types/`, shared pure logic in `packages/shared/src/capture/`, both re-exported from `packages/shared/src/index.ts`; `npm run build:shared` before running Functions or web tests.
- Functions tests: `packages/functions/tests/*.unit.test.cjs` against `dist/`, no database, require interception as in `tests/capture-check.unit.test.cjs` (fake DB keyed on SQL text). Shared / web / mobile tests: `*.test.ts` beside the module (`tsx --test`).
- Docs rows per CLAUDE.md "Documentation Maintenance" are part of the task that adds the thing.
- Commits: Conventional Commits, each ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. **Flag off must be byte-for-byte today's behavior:** no `nextFrame` / `suggestedShade` / `brandConflict` / `brandHint` keys in any response, `inline://` storage URLs, no blob upload, no model call on a `color` frame, identical resolver decisions on the same evidence. Pinned in Task 9 (handler test runs the same fixtures with the flag off and asserts deep equality with a recorded response) and Task 4 (storage).
2. **AI or storage outage mid-session:** Azure OpenAI unconfigured or throwing → a `glass` frame still gets a `palette-top` hex, a `bottom` frame still gets OCR-only evidence, and the frame answers 201; blob storage down → the frame is saved with the `inline://` URL and OCR still runs. Pinned in Tasks 4, 5 and 7.
3. **`captureId` on `POST /api/polishes` that is another user's, unknown or cancelled:** 404 / 404 / 409 and no polish is created (the transaction rolls back). Pinned in Task 10.
4. **The sweep and the terminal-state release must only ever touch capture frames:** nail photos, mani photos, bottle-eval frames and catalog blobs share the container; a row is released only when it is reached through `capture_frame` and its URL is under the owner's `{ownerId}/capture/` prefix; a blob already gone still resets the row. Pinned in Task 4.
5. **The prompt loop must end:** every prompt key is asked at most twice, `maxFrames` (6) stops asking, a user who skips every surface gets `nextFrame: null` (so the client calls `check`), and a `retry_quality` prompt never repeats for a surface that produced evidence. Pinned in Task 9.

---

### Task 1: Shared contract and the feature flag

**Files:**
- Modify: `packages/shared/src/types/capture.ts` (surfaces moved in from `types/bottle-eval.ts`; new types and response fields below)
- Modify: `packages/shared/src/types/bottle-eval.ts` (import `BottleSurface`, `BOTTLE_SURFACES`, `BOTTLE_SURFACE_FRAME_TYPE`, `parseBottleSurface` from `./capture`; stop exporting them)
- Modify: `packages/shared/src/types/polish.ts` (`PolishCreateRequest.captureId?: string`)
- Modify: `packages/shared/src/types/feature-flags.ts` (`FEATURE_FLAG_NAMES` gains `"bottleCapture"`)
- Create: `packages/shared/src/capture/frame-quality.ts`, `packages/shared/src/capture/frame-quality.test.ts` (moved from `apps/web/src/lib/camera.ts`)
- Modify: `apps/web/src/lib/camera.ts` (re-export `FRAME_QUALITY_THRESHOLDS`, `FrameQualityMetrics`, `FrameQualityWarning`, `assessFrameQuality` from `swatchwatch-shared`; `apps/web/src/lib/camera.test.ts` unchanged and passing)
- Modify: `packages/shared/src/index.ts` (`export * from "./capture/frame-quality";`)
- Modify: `packages/functions/src/lib/feature-flags.ts` (`bottleCapture: { env: "BOTTLE_CAPTURE_ENABLED", public: true }`)
- Modify: `infrastructure/variables.tf` (`bottle_capture_enabled`, bool, default `false`), `infrastructure/main.tf` (app setting `BOTTLE_CAPTURE_ENABLED = var.bottle_capture_enabled ? "true" : "false"` next to `SHAREABLE_LOOKS_ENABLED`), `.github/workflows/deploy-infra.yml` (`TF_VAR_bottle_capture_enabled: ${{ vars.BOTTLE_CAPTURE_ENABLED || 'false' }}`), `infrastructure/README.md` (flag list line 97 and the variables table)
- Modify: `packages/functions/local.settings.json.example` (`"BOTTLE_CAPTURE_ENABLED": "false"` in the feature-flag group), `packages/functions/README.md` env table, `CLAUDE.md` (Functions: feature flags; Infra flags list), `packages/shared/README.md` (type catalog rows)

**Interfaces:**
- Produces (shared, `types/capture.ts`):
  ```ts
  export const BOTTLE_SURFACES = ["front", "bottom", "glass", "box"] as const;
  export type BottleSurface = (typeof BOTTLE_SURFACES)[number];
  export const BOTTLE_SURFACE_FRAME_TYPE: Record<BottleSurface, CaptureFrameType>;   // front/bottom/box → label, glass → color
  export function parseBottleSurface(value: unknown): BottleSurface | null;
  export type CaptureFrameRequestReason = "need_brand" | "need_name" | "need_color" | "tie_break" | "retry_quality";
  export interface CaptureFrameRequestSpec { surface: BottleSurface; frameType: CaptureFrameType; prompt: string; hint?: string; reason: CaptureFrameRequestReason; optional: boolean }
  export type CaptureBrandSource = "hint" | "barcode" | "read";
  export interface CaptureBrandRef { brandId: string | null; name: string; source: CaptureBrandSource; confidence?: number }
  export interface CaptureSuggestedShade { brandId: string | null; brandName: string | null; brandSource: CaptureBrandSource | null; shadeName: string | null; hex: string | null; finish: string | null; gtin: string | null }
  export interface CaptureBrandConflict { hinted: CaptureBrandRef; read: CaptureBrandRef }
  export interface CaptureBrandHintEcho { raw: string; brandId: string | null; name: string }   // name = canonical when matched, else raw
  // Added optional fields (absent while the flag is off):
  CaptureStartResponse.brandHint?: CaptureBrandHintEcho; CaptureStartResponse.nextFrame?: CaptureFrameRequestSpec | null;
  CaptureFrameResponse.nextFrame?: CaptureFrameRequestSpec | null;
  CaptureCheckResponse.nextFrame?: CaptureFrameRequestSpec | null; .suggestedShade?: CaptureSuggestedShade; .brandConflict?: CaptureBrandConflict;
  CaptureCheckCandidate.brandId?: string; CaptureCheckCandidate.colorDistance?: number;   // OKLAB glass ↔ display hex, when a glass hex exists
  CaptureStatusResponse.nextFrame?: CaptureFrameRequestSpec | null;
  CaptureAnswerRequest.answer?: unknown (was required); CaptureAnswerRequest.skipSurface?: BottleSurface;
  CaptureAnswerResponse.nextFrame?: CaptureFrameRequestSpec | null;
  ```
- Produces (shared, `capture/frame-quality.ts`): the web's `FRAME_QUALITY_THRESHOLDS = { minBrightness: 0.15, maxBrightness: 0.92, minSharpness: 0.012 }`, `FrameQualityMetrics`, `FrameQualityWarning = "too-dark" | "too-bright" | "blurry"`, `assessFrameQuality(metrics): FrameQualityWarning[]` (unchanged logic), plus
  `export function frameQualityWarningsFromQuality(quality: Record<string, unknown> | null | undefined): FrameQualityWarning[]` — reads numeric `brightness` / `sharpness`; `[]` when either is missing (mobile frames carry none).
- Produces (functions): `FEATURE_FLAGS.bottleCapture`; `GET /api/config/flags` now lists `bottleCapture`.

- [ ] **Step 1: Write the failing tests** — `frame-quality.test.ts`: `assessFrameQuality({ brightness: 0.1, contrast: 0.2, sharpness: 0.05 })` → `["too-dark"]`; `frameQualityWarningsFromQuality({ brightness: 0.5, sharpness: 0.001 })` → `["blurry"]`; `frameQualityWarningsFromQuality({ source: "mobile-camera" })` → `[]`; `frameQualityWarningsFromQuality(null)` → `[]`. In `packages/shared/src/types/bottle-eval.test.ts` keep the existing `BOTTLE_SURFACE_FRAME_TYPE` assertion importing from `../index`. In `packages/functions/tests/feature-flags.unit.test.cjs` (exists; extend): `listPublicFeatureFlags({ BOTTLE_CAPTURE_ENABLED: "true" }).bottleCapture === true`, `"1"` → `false`, unset → `false`.
- [ ] **Step 2: Run** `npm run test --workspace=swatchwatch-shared` → FAIL (module not found); `npm run test --workspace=swatchwatch-functions -- tests/feature-flags.unit.test.cjs` → FAIL
- [ ] **Step 3: Implement** the types, the moves, the flag registry entry and the infra/workflow lines
- [ ] **Step 4: Run** `npm run build:shared && npm run test --workspace=swatchwatch-shared && npm run typecheck && npm run test --workspace=swatchwatch-functions && npm run test --workspace=swatchwatch-web` → all PASS; `cd infrastructure && terraform fmt -check && terraform validate` → clean
- [ ] **Step 5: Docs** (env rows, README type rows: `capture.ts` surfaces / `CaptureFrameRequestSpec` / `CaptureSuggestedShade`; `frame-quality.ts`)
- [ ] **Step 6: Commit** `feat(shared): bottle capture contract and BOTTLE_CAPTURE_ENABLED flag`

---

### Task 2: Shared client flow logic

**Files:**
- Create: `packages/shared/src/capture/bottle-flow.ts`, `bottle-flow.test.ts`
- Create: `packages/shared/src/capture/sticky-hints.ts`, `sticky-hints.test.ts`
- Create: `packages/shared/src/capture/create-card.ts`, `create-card.test.ts`
- Modify: `packages/shared/src/index.ts` (three exports), `packages/shared/README.md`

**Interfaces:**
- Consumes: Task 1 types; `classifyColorFamily` (`color/color-family.ts`); `PolishCreateRequest`.
- Produces (`bottle-flow.ts`):
  ```ts
  export const BOTTLE_DEFAULT_SURFACE_ORDER: readonly BottleSurface[] = ["front", "bottom", "glass"];
  /** Client copy used only before the server has spoken; the server's copy (Task 9) is canonical and a test keeps them equal. */
  export const DEFAULT_SURFACE_PROMPTS: Record<BottleSurface, string> = { front: "Show the front of the bottle", bottom: "Now the bottom", glass: "Turn it so we see the color", box: "Have the box? Show the barcode" };
  export function surfaceFromQuality(quality: Record<string, unknown> | null | undefined): BottleSurface | null;
  export interface BottleFlowClientState { sessionStarted: boolean; nextFrame: CaptureFrameRequestSpec | null; captured: BottleSurface[]; skipped: BottleSurface[]; brandEcho: CaptureBrandHintEcho | null; brandConflict: CaptureBrandConflict | null }
  export const INITIAL_BOTTLE_FLOW_STATE: BottleFlowClientState;
  export type BottleFlowAction =
    | { type: "session_started"; brandHint?: CaptureBrandHintEcho | null; nextFrame?: CaptureFrameRequestSpec | null }
    | { type: "frame_uploaded"; surface: BottleSurface | null; nextFrame?: CaptureFrameRequestSpec | null }
    | { type: "surface_skipped"; surface: BottleSurface; nextFrame?: CaptureFrameRequestSpec | null }
    | { type: "check_received"; nextFrame?: CaptureFrameRequestSpec | null; brandConflict?: CaptureBrandConflict | null }
    | { type: "reset" };
  export function bottleFlowReducer(state: BottleFlowClientState, action: BottleFlowAction): BottleFlowClientState;  // an `undefined` nextFrame in an action means "server sent none" → null
  export interface BottleCameraView { surface: BottleSurface; frameType: CaptureFrameType; prompt: string; hint: string | null; reason: CaptureFrameRequestReason | null; optional: boolean; step: number; total: number }
  /** What the camera screen shows: the server's nextFrame when there is one; before the session starts, the first surface of the local order not yet captured or skipped (["bottom","glass"] when brandKnown, else the default order). null = nothing left to ask → call check. */
  export function deriveBottleCameraView(state: BottleFlowClientState, opts: { brandKnown: boolean }): BottleCameraView | null;
  /** True right after a frame upload when the server asked for nothing more and at least one frame is uploaded. */
  export function shouldAutoCheck(state: BottleFlowClientState, uploadedFrames: number): boolean;
  ```
- Produces (`sticky-hints.ts`):
  ```ts
  export interface StickyHints { brand: string | null; brandCanonical: string | null; brandId: string | null; finish: string | null; collection: string | null }
  export const EMPTY_STICKY_HINTS: StickyHints;
  export const STICKY_HINTS_STORAGE_PREFIX = "swatchwatch.rapid-add.hints";
  export const STICKY_HINT_MAX_LENGTH = 200;
  export function stickyHintsStorageKey(userId: string | null | undefined): string;      // `${prefix}:${userId ?? "anon"}`
  export function parseStickyHints(raw: unknown): StickyHints;                           // JSON string or object; trims, drops >200 chars; anything else → EMPTY
  export function serializeStickyHints(hints: StickyHints): string;
  export function isBatchMode(hints: StickyHints): boolean;                              // brand non-empty
  export function hintsToStartMetadata(hints: StickyHints): { brand?: string; finish?: string; collection?: string };  // brand = brandCanonical ?? brand
  export function withBrandEcho(hints: StickyHints, echo: CaptureBrandHintEcho | null | undefined): StickyHints;   // fills brandCanonical/brandId when echo.brandId
  export function switchBrand(hints: StickyHints, read: CaptureBrandRef): StickyHints;   // brand = brandCanonical = read.name, brandId = read.brandId
  export function batchHeaderLabel(hints: StickyHints): string | null;                   // "Going through: Loud Lacquer", null when not batch mode
  ```
- Produces (`create-card.ts`):
  ```ts
  export interface CreateCardModel { captureId: string; brand: string; brandSource: CaptureBrandSource | null; brandNeedsConfirm: boolean; shadeName: string; hex: string | null; finish: string | null; gtin: string | null }
  /** null when the check matched, when candidates are on screen and the user has not said "None of these", or when there is no suggestedShade. brandNeedsConfirm = brandSource === "read". */
  export function deriveCreateCard(check: Pick<CaptureCheckResponse, "captureId" | "outcome" | "candidates" | "suggestedShade">, opts: { afterNoneOfThese: boolean }): CreateCardModel | null;
  export interface CreateCardEdits { brand: string; shadeName: string; hex: string | null; finish: string | null; brandConfirmed: boolean }
  export function canSubmitCreateCard(card: CreateCardModel, edits: CreateCardEdits): boolean;   // brand and shadeName non-empty after trim; brandNeedsConfirm → brandConfirmed || edits.brand.trim() !== card.brand
  export function createPolishRequestFromCard(card: CreateCardModel, edits: CreateCardEdits, status: "owned" | "wishlist"): PolishCreateRequest;
  // brand/name trimmed, color = classifyColorFamily(hex) ?? "unknown", detectedHex = hex, finishes = finish ? [finish] : undefined, barcode = gtin ?? undefined, captureId, status, quantity = status === "owned" ? 1 : 0
  ```

- [ ] **Step 1: Write the failing tests**
  - `bottle-flow.test.ts`: reducer `session_started` with `nextFrame` undefined → `nextFrame: null`, `sessionStarted: true`; `frame_uploaded` appends the surface once (a second glass frame does not duplicate `captured`); `surface_skipped` adds to `skipped`; `check_received` stores `brandConflict`; `reset` → initial. `deriveBottleCameraView(INITIAL, { brandKnown: false })` → front, step 1 of 3, prompt `DEFAULT_SURFACE_PROMPTS.front`; with `captured: ["front"]` → bottom; `{ brandKnown: true }` → bottom, total 2; `skipped: ["front","bottom","glass"]` before start → null; after start with `nextFrame: null` → null; a server `nextFrame` wins over the local order and keeps its `hint`/`reason`/`optional`. `shouldAutoCheck({ sessionStarted: true, nextFrame: null }, 1)` → true; with 0 frames → false; with a nextFrame → false.
  - `sticky-hints.test.ts`: `parseStickyHints('{"brand":" Loud "}')` → brand `"Loud"`, others null; a 201-char brand → EMPTY; `parseStickyHints(42)` → EMPTY; `hintsToStartMetadata({ brand: "loud", brandCanonical: "Loud Lacquer", … })` → `{ brand: "Loud Lacquer" }` (no undefined keys); `switchBrand` sets all three brand fields; `batchHeaderLabel(EMPTY)` → null; `stickyHintsStorageKey(null)` → `"swatchwatch.rapid-add.hints:anon"`.
  - `create-card.test.ts`: matched → null; `needs_question` with 2 candidates and `afterNoneOfThese: false` → null, `true` → card; `unmatched` with `suggestedShade.brandSource = "read"` → `brandNeedsConfirm: true` and `canSubmitCreateCard` false until `brandConfirmed` or the brand is edited; `createPolishRequestFromCard` → `{ brand, name, color: "pink" (for `#E0457B`), detectedHex: "#E0457B", finishes: ["creme"], barcode: "4006381333931", captureId, status: "owned", quantity: 1 }`; `hex: null` → `color: "unknown"`, no `detectedHex` key.
- [ ] **Step 2: Run** `npm run test --workspace=swatchwatch-shared` → FAIL
- [ ] **Step 3: Implement** the three modules and the index exports
- [ ] **Step 4: Run** `npm run test --workspace=swatchwatch-shared && npm run build:shared` → PASS
- [ ] **Step 5: README rows** (`capture/bottle-flow.ts`, `capture/sticky-hints.ts`, `capture/create-card.ts`)
- [ ] **Step 6: Commit** `feat(shared): bottle flow reducer, sticky hints and create card helpers`

---

### Task 3: Capture evidence module (type move + surfaces)

**Files:**
- Create: `packages/functions/src/lib/capture-evidence.ts`, `packages/functions/src/lib/capture-questions.ts`
- Create: `packages/functions/tests/capture-evidence.unit.test.cjs`
- Modify: `packages/functions/src/functions/capture.ts` (delete the moved declarations, import them; no behavior change)

**Interfaces:**
- Produces (`capture-evidence.ts`, pure; moved verbatim from `capture.ts` unless noted): `CaptureEvidence`, `FrameExtraction`, `FrameExtractionSource`, `CaptureMatchCandidate`, `CaptureQuestionSpec`, `BarcodeMatchVia`, `ResolverDecision`, `ResolverOutcome`, `CaptureFrameEvidenceRow`, `toRecord`, `getStringField`, `extractFrameEvidence`, `collectCaptureEvidence`, with these additions:
  ```ts
  export interface CaptureFrameEvidenceRow { frameType: CaptureFrameType; quality: Record<string, unknown> | null; createdAt?: string }
  export interface CaptureEvidence {
    gtin?: string; gtinFormat?: string; brand?: string; shadeName?: string; finish?: string;            // as today
    brandSource?: "hint" | "read";                 // "hint" when brand came from metadata (hint/answer), "read" when from a frame
    brandRead?: { text: string; confidence: number }; // newest frame-read brand even when a hint exists (Task 8's conflict rule)
    shadeNameListed?: string;                      // closed-set pick (Task 7)
    glassHex?: string; glassHexConfidence?: number; // only from extracted.source === "glass" (Task 5)
    surfaces: Partial<Record<BottleSurface, number>>;  // frames per surface, from quality.surface
    skippedSurfaces: BottleSurface[];              // from metadata.bottle.skipped
  }
  export interface ResolverDecisionBottle { brand: CaptureBrandRef | null; suggestedShade?: CaptureSuggestedShade; brandConflict?: CaptureBrandConflict; tie: boolean; modelCalls: number }
  export type ResolverDecision = (…as today…) & { barcodeVia?: BarcodeMatchVia; bottle?: ResolverDecisionBottle };   // `bottle` set only by the Task 8 resolver
  export function extractFrameEvidence(quality): FrameExtraction | null;  // reads extracted.hex / hexConfidence / shadeNameListed / brandConfidence too; `hex` only when extracted.source === "glass"
  export function collectCaptureEvidence(metadata, frames): CaptureEvidence;  // frames newest first as today; `surfaces` and `skippedSurfaces` always set
  ```
- Produces (`capture-questions.ts`): `buildNeedsFrameQuestion()`, `buildBrandShadeQuestion()`, `buildCandidateQuestion(candidates)`, `serializeQuestionOptions(options)` moved verbatim.

- [ ] **Step 1: Write the failing tests** (`capture-evidence.unit.test.cjs`, requires `dist/lib/capture-evidence.js`):
  - `collectCaptureEvidence({ brand: "OPI" }, [])` → `brand: "OPI"`, `brandSource: "hint"`, `surfaces: {}`, `skippedSurfaces: []`
  - frames `[{ frameType: "label", quality: { surface: "bottom", extracted: { brand: "Holo Taco", brandConfidence: 0.9, shadeName: "Unicorn Skin" } } }]` with empty metadata → `brand: "Holo Taco"`, `brandSource: "read"`, `brandRead: { text: "Holo Taco", confidence: 0.9 }`, `surfaces: { bottom: 1 }`
  - the same frame with metadata `{ brand: "OPI" }` → `brand: "OPI"`, `brandSource: "hint"`, `brandRead.text === "Holo Taco"`
  - a `color` frame `{ surface: "glass", extracted: { hex: "#AA3366", hexConfidence: 0.8, source: "glass" } }` → `glassHex: "#AA3366"`; the same without `source` → no `glassHex`; `{ hex: "#AA3366" }` at the quality root (client-supplied) → no `glassHex`
  - `quality.surface = "cap"` → not counted in `surfaces`
  - metadata `{ bottle: { skipped: ["front"] } }` → `skippedSurfaces: ["front"]`
  - the existing legacy cases: `request_quality` source and `answers.brand_shade` precedence (copy two assertions from `tests/capture-check.unit.test.cjs` fixtures)
- [ ] **Step 2: Run** `npm run test --workspace=swatchwatch-functions -- tests/capture-evidence.unit.test.cjs` → FAIL
- [ ] **Step 3: Move** the declarations, extend them, update `capture.ts` imports
- [ ] **Step 4: Run** the whole suite `npm run test --workspace=swatchwatch-functions` → PASS (`capture-check`, `capture-barcode`, `capture-inventory`, `access-control` unchanged)
- [ ] **Step 5: Commit** `refactor(functions): move capture evidence and question builders into lib`

---

### Task 4: Frame retention — blob storage, release and the sweep timer

**Files:**
- Create: `packages/functions/src/lib/capture-frame-store.ts`, `packages/functions/src/lib/capture-frame-sweep.ts`, `packages/functions/src/functions/capture-frame-sweep.ts`
- Create: `packages/functions/tests/capture-frame-store.unit.test.cjs`, `packages/functions/tests/capture-frame-sweep.unit.test.cjs`
- Modify: `packages/functions/src/functions/capture.ts` (`PreparedImageInput` gains `bytes: Buffer | null; contentType: string | null; extension: string | null`; `addCaptureFrame` stores the blob when the flag is on; `finalizeCapture` and `answerCaptureQuestion` release frames after a terminal commit)
- Modify: `packages/functions/src/index.ts` (`export * from './functions/capture-frame-sweep';`), `packages/functions/local.settings.json.example`, `packages/functions/README.md` (env rows; timer paragraph after `orphan-media-sweep`; route table note on `frame`), `CLAUDE.md` (Functions: storage, image proxy, private media — a "Capture frames" bullet; Private media paragraph), `apps/web/README.md` and `apps/mobile/README.md` (one sentence: frames are kept up to 24 hours)

**Interfaces:**
- Consumes: `uploadBytesToBlob`, `deleteBlobFromStorageUrl`, `isUserMediaStorageUrl`, `storageUrlBlobName`, `userMediaContainer` (`lib/blob-storage.ts`); `isFeatureEnabled` (Task 1); `trackEvent`, `trackException`, `trackMetric`.
- Produces (`capture-frame-store.ts`):
  ```ts
  export const CAPTURE_FRAME_INLINE_PREFIX = "inline://capture/";
  export function inlineCaptureFrameUrl(captureId: string, checksum: string, extension: string): string;   // today's placeholder, unchanged format
  export function captureFrameBlobName(userId: number, captureId: string, checksum: string, extension: string): string;  // `${userId}/capture/${captureId}/${checksum}.${extension}`
  export function isCaptureFrameStorageUrl(storageUrl: unknown, userId: number | string): boolean;  // in userMediaContainer() and blob name starts with `${userId}/capture/`
  export interface StoreCaptureFrameInput { userId: number; captureId: string; bytes: Buffer; contentType: string; checksum: string; extension: string }
  export interface StoreCaptureFrameDeps { upload?: typeof uploadBytesToBlob; connectionString?: string | undefined; warn?: (message: string, error?: unknown) => void }
  /** Blob URL when stored; the inline placeholder when AZURE_STORAGE_CONNECTION is unset or the upload throws (warned, never thrown). */
  export async function storeCaptureFrameBytes(input: StoreCaptureFrameInput, deps?: StoreCaptureFrameDeps): Promise<{ storageUrl: string; stored: boolean }>;
  /** $1 capture_session_id, $2 user_id → frames whose image_asset is the caller's and not inline. */
  export const SELECT_SESSION_FRAME_BLOBS_SQL: string;   // imageId, storageUrl, checksum, captureId
  export const RESET_FRAME_STORAGE_URL_SQL: string;      // UPDATE image_asset SET storage_url = $2 WHERE image_id = $1 AND owner_type = 'user' AND owner_id = $3
  export interface ReleaseDeps { query: typeof query; deleteBlob: (storageUrl: string) => Promise<boolean>; warn?: (message: string, error?: unknown) => void }
  /** After a terminal commit: delete each frame blob and reset its row to the inline placeholder. Best effort; counts only. */
  export async function releaseCaptureFrames(input: { sessionId: number; userId: number; captureId: string }, deps: ReleaseDeps): Promise<{ released: number; blobMissing: number; failed: number }>;
  ```
- Produces (`capture-frame-sweep.ts`):
  ```ts
  export const DEFAULT_CAPTURE_FRAME_SWEEP_SCHEDULE = "0 0 * * * *";   // hourly
  export const CAPTURE_FRAME_SWEEP_LIMITS = { retentionSeconds: { fallback: 86_400, min: 3_600, max: 604_800 }, batchSize: { fallback: 200, min: 1, max: 1_000 }, maxPerRun: { fallback: 2_000, min: 1, max: 20_000 } } as const;
  export interface CaptureFrameSweepConfig { retentionSeconds: number; batchSize: number; maxPerRun: number }
  export function captureFrameSweepSchedule(env?: NodeJS.ProcessEnv): string;           // CAPTURE_FRAME_SWEEP_SCHEDULE
  export function getCaptureFrameSweepConfig(env?: NodeJS.ProcessEnv): CaptureFrameSweepConfig;  // CAPTURE_FRAME_RETENTION_SECONDS, CAPTURE_FRAME_SWEEP_BATCH_SIZE, CAPTURE_FRAME_SWEEP_MAX_PER_RUN, clamped
  /** $1 retention seconds, $2 last image_id, $3 limit: capture_frame → image_asset (owner_type 'user', captured_at older than retention, storage_url NOT LIKE 'inline://%') → capture_session for capture_uuid; ORDER BY ia.image_id. */
  export const SELECT_EXPIRED_CAPTURE_FRAMES_SQL: string;   // imageId, ownerId, storageUrl, checksum, captureId
  export interface CaptureFrameSweepResult { scanned: number; released: number; blobMissing: number; failed: number; skipped: number; truncated: boolean }
  export async function sweepExpiredCaptureFrames(deps: ReleaseDeps & { log?: (message: string) => void }, config: CaptureFrameSweepConfig): Promise<CaptureFrameSweepResult>;
  ```
  Per row: not `isCaptureFrameStorageUrl(storageUrl, ownerId)` → `skipped` (row untouched); delete blob (`false` = 404 → `blobMissing`, still reset); reset the row with `RESET_FRAME_STORAGE_URL_SQL`; a thrown delete → `failed`, row kept for the next run. Never reads or writes `quality_json`.
- Timer (`functions/capture-frame-sweep.ts`): `app.timer("capture-frame-sweep", { schedule: captureFrameSweepSchedule(), runOnStartup: false, handler: runCaptureFrameSweep })`; skips with `capture_frame_sweep.skipped` when `AZURE_STORAGE_CONNECTION` is unset; emits `capture_frame_sweep.completed` (+ one metric per count) or `capture_frame_sweep.failed`, mirroring `functions/orphan-media-sweep.ts`.
- `addCaptureFrame` (flag on, data-URL input): `storeCaptureFrameBytes` with the EXIF-stripped bytes → `image_asset.storage_url` = the blob URL (or the inline placeholder when not stored); a frame transaction that then fails deletes the just-uploaded blob before rethrowing (the `uploadedStorageUrl` pattern of `bottle-eval-admin.ts`), so no blob exists without a row; flag off → inline as today. Terminal release: `finalizeCapture` (matched / unmatched branches) and `answerCaptureQuestion` (candidate_select match; re-resolve matched / unmatched) call `releaseCaptureFrames` after their transaction commits, flag on or off (harmless when no blobs).

- [ ] **Step 1: Write the failing tests**
  - `capture-frame-store.unit.test.cjs` (mock `../lib/blob-storage` with recorders; `userMediaContainer: () => "nail-photos"`, `isUserMediaStorageUrl`/`storageUrlBlobName` for `https://acct.blob.core.windows.net/nail-photos/<name>`):
    - `captureFrameBlobName(7, "1111…", "abc", "jpg") === "7/capture/1111…/abc.jpg"`; `isCaptureFrameStorageUrl(".../nail-photos/7/capture/x/abc.jpg", 7)` → true; `…/7/bottle-eval/…` → false; `…/nail-photos/7/<uuid>.jpg` (a nail photo) → false; another owner → false; `inline://…` → false
    - `storeCaptureFrameBytes` with a connection string → calls `uploadBytesToBlob` with container `nail-photos`, the blob name above, the bytes and content type; returns `{ stored: true }`; without a connection string → `{ storageUrl: inlineCaptureFrameUrl(...), stored: false }` and no upload call (Review Focus 2); upload throws → inline + `warn` called, never throws
    - `releaseCaptureFrames`: query mock returns two frames, one under the prefix and one nail-photo URL (misfiled row): the nail photo is skipped (no delete, no reset); the capture frame's blob is deleted and its row reset with params `[imageId, inlineUrl, userId]`; `deleteBlob` resolving false → `blobMissing: 1` and the row still reset; `deleteBlob` throwing → `failed: 1`, no reset (Review Focus 4)
  - `capture-frame-sweep.unit.test.cjs`: `getCaptureFrameSweepConfig({ CAPTURE_FRAME_RETENTION_SECONDS: "60" })` → `3600`; `"999999999"` → `604800`; unset → `86400`; `captureFrameSweepSchedule({})` → `"0 0 * * * *"`. `sweepExpiredCaptureFrames` over a fake query returning one page of 3 rows (capture frame; bottle-eval URL; capture frame whose blob is gone) → `{ scanned: 3, released: 2, blobMissing: 1, skipped: 1, failed: 0, truncated: false }`, the bottle-eval row untouched; `maxPerRun: 2` → `truncated: true`; the SQL text contains `FROM capture_frame` and `NOT LIKE 'inline://%'`
  - Extend `tests/capture-check.unit.test.cjs`'s fake DB: with `BOTTLE_CAPTURE_ENABLED=true` and a mocked `uploadBytesToBlob`, a data-URL frame inserts `image_asset` with the blob URL; with the flag off the inserted `storage_url` starts with `inline://capture/` and `uploadBytesToBlob` is never called (Review Focus 1); after `finalize` → matched, `deleteBlobFromStorageUrl` is called once per blob frame and the `UPDATE image_asset SET storage_url` statement ran; a frame whose `INSERT INTO capture_frame` throws → 500, and `deleteBlobFromStorageUrl` was called with the blob just uploaded
- [ ] **Step 2: Run** the three test files → FAIL
- [ ] **Step 3: Implement** the two libs, the timer, the `capture.ts` wiring, the index export
- [ ] **Step 4: Run** `npm run test --workspace=swatchwatch-functions` → PASS; manual: `func start` with Azurite, `BOTTLE_CAPTURE_ENABLED=true`, post a data-URL frame (`curl … /api/capture/{id}/frame`) → the `image_asset.storage_url` is an Azurite URL under `1/capture/`; finalize → the row shows `inline://capture/…` again and the blob is gone
- [ ] **Step 5: Docs** (env rows in the three places; README timer paragraph: what is swept, prefix rule, that `quality_json` survives; client READMEs' retention sentence)
- [ ] **Step 6: Commit** `feat(functions): keep capture frames as private blobs for the session with a 24h sweep`

---

### Task 5: Glass color evidence

**Files:**
- Create: `packages/functions/src/lib/glass-color.ts`, `packages/functions/tests/glass-color.unit.test.cjs`
- Modify: `packages/functions/src/functions/capture.ts` (`runFrameAiExtraction` gains a `color` branch behind the flag; `FrameAiExtractionResult` gains `glass?: GlassHexAudit`)

**Interfaces:**
- Consumes: `extractPaletteCandidates`, `renderPaletteComposite`, `parsePaletteChoice`, `PaletteCandidate` (`lib/palette-pick-detection.ts`); `requestAzureOpenAIChatCompletion`, `resolveVisionImageDetail`, `loadDetectionFinishCatalog` (`lib/ai-color-detection.ts`); `resolveAzureOpenAiConfig`; `decodeDataUri` (`lib/detection-image.ts`); `hexToOklab`, `oklabDistance` (shared).
- Produces:
  ```ts
  export const GLASS_HEX_METHOD_PALETTE_PICK = "palette-pick-bottle";
  export const GLASS_HEX_METHOD_FALLBACK = "palette-top";
  export const GLASS_HEX_FALLBACK_CONFIDENCE = 0.3;
  export const GLASS_PROMPT_VERSION = "glass-palette-pick/2026-10-v1";   // bump when the prompt changes
  export const GLASS_FALLBACK_TOP_BY_AREA = 3;
  export const SKIN_TONE_REFERENCE_HEXES: readonly string[] = ["#FFDFC4", "#F0C8A0", "#D9A077", "#B07B52", "#8D5524", "#5C3A1E"];
  export interface GlassHexAudit { candidates: PaletteCandidate[]; choice: string | null; modelCalls: 0 | 1; reason?: string }
  export interface GlassHexResult { hex: string; confidence: number; method: typeof GLASS_HEX_METHOD_PALETTE_PICK | typeof GLASS_HEX_METHOD_FALLBACK; promptVersion: string; audit: GlassHexAudit }
  /** Deterministic: among the top GLASS_FALLBACK_TOP_BY_AREA chips by fraction, the one maximizing min(distance to the nearest SKIN_TONE_REFERENCE_HEXES entry, OKLAB chroma sqrt(a²+b²)); ties → larger fraction, then label order. null for no candidates. */
  export function pickFallbackChip(candidates: readonly PaletteCandidate[]): PaletteCandidate | null;
  export function buildGlassPalettePayload(compositeDataUri: string, candidates: readonly PaletteCandidate[], safePrompt: boolean, imageDetail: VisionImageDetail, finishCatalog?: FinishCatalog): Record<string, unknown>;
  // prompt: the photo is a hand holding a nail polish bottle; choose the ONE chip that is the lacquer seen through the glass, never the cap, label, hand, skin, nails, background or glare; JSON {"choice","confidence","finishes"}; same safe-prompt fallback shape as buildPalettePickPayload
  export interface MeasureGlassHexOptions { finishCatalog?: FinishCatalog; imageDetail?: VisionImageDetail; onLog?: HexDetectionOptions["onLog"]; deploymentEnvKeys?: string[] }
  /** extractPaletteCandidates (palette-pick defaults) → model pick when configured and it answers a valid chip, else pickFallbackChip. null only when no candidates could be measured. Never throws. */
  export async function measureGlassHex(image: Buffer, options?: MeasureGlassHexOptions): Promise<GlassHexResult | null>;
  ```
- Frame handler: flag on, `frameType === "color"`, data-URL input → `measureGlassHex(decodeDataUri(sanitizedImageInput))`; writes `quality_json.extracted = { hex, hexConfidence, hexMethod, hexPromptVersion, source: "glass" }` and `quality_json.ai.glass = audit` (+ `processedAt`); remote-URL input or `null` result → `quality_json.ai.glass = { reason: "no_candidates" | "remote_url" }` and no `extracted.hex`. Flag off → `runFrameAiExtraction` returns `null` for color frames exactly as today.

- [ ] **Step 1: Write the failing tests** (mock `../lib/ai-color-detection` `requestAzureOpenAIChatCompletion`; build 64×64 synthetic PNGs with `sharp` like `tests/palette-pick-detection.unit.test.cjs` does):
  - `pickFallbackChip` on `[A #F0C8A0 0.5 (skin), B #808080 0.3 (grey), C #B4004E 0.15 (magenta), D #0000FF 0.05]` → `C` (D is outside the top three by area); all-skin/grey chips → the greyest-least one is still returned (never null with candidates); `[]` → null; deterministic across two calls with shuffled input order
  - `buildGlassPalettePayload` → `temperature 0`, `response_format json_object`, the user text names every letter, the system text contains "glass" and "cap"; `safePrompt: true` yields the shorter text
  - `measureGlassHex` on a half-skin, half-magenta image with the model answering `{"choice":"B","confidence":0.9}` where B is the magenta chip → `hex === B.hex`, `method palette-pick-bottle`, `audit.modelCalls === 1`; model `provider: "none"` → `method palette-top`, `confidence 0.3`, `modelCalls 0`; model answering an unknown letter → fallback; model throwing → fallback, no throw (Review Focus 2); a 1×1 image → null
  - Handler (`capture-check` fake DB, flag on): a `color` frame inserts `quality_json.extracted.source === "glass"` with a 7-char hex; flag off → the inserted `quality_json` has no `extracted` and `requestAzureOpenAIChatCompletion` was not called (Review Focus 1)
- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement** `glass-color.ts` and the color branch
- [ ] **Step 4: Run** the suite → PASS
- [ ] **Step 5: Commit** `feat(functions): measure the lacquer hex from glass frames`

---

### Task 6: Brand resolution and the sticky-hint echo

**Files:**
- Create: `packages/functions/src/lib/brand-resolve.ts`, `packages/functions/tests/brand-resolve.unit.test.cjs`
- Modify: `packages/functions/src/functions/capture.ts` (`startCapture` resolves `metadata.brand` when the flag is on)

**Interfaces:**
- Consumes: `query` (`lib/db.ts`); Task 1 `CaptureBrandRef`, `CaptureBrandHintEcho`.
- Produces:
  ```ts
  export const BRAND_MATCH_MIN_SIMILARITY = 0.6;
  export const BRAND_SHADE_NAMES_CAP = 400;
  export interface ResolvedBrand { brandId: number; name: string; score: number }
  /** $1 text: best of similarity(name_canonical) and max similarity over brand_alias; prefilter with pg_trgm `%` plus similarity ≥ 0.6; ORDER BY score DESC, brand_id; LIMIT 1. */
  export const RESOLVE_BRAND_SQL: string;
  export async function resolveBrandFromText(text: string, db?: Pick<typeof import("./db"), "query">): Promise<ResolvedBrand | null>;   // trimmed empty → null without a query; score < 0.6 → null
  /** $1 brand_id, $2 user_id: active color shades of the brand (merged_into_shade_id IS NULL, product_category 'color') plus the caller's own user_submitted ones, ORDER BY shade_name_canonical, LIMIT 401. */
  export const SELECT_BRAND_SHADE_NAMES_SQL: string;
  export async function listBrandShadeNames(brandId: number, userId: number, db?): Promise<{ names: string[]; truncated: boolean }>;  // truncated when 401 rows came back (names then trimmed to 400)
  export function toBrandRef(resolved: ResolvedBrand | null, raw: string, source: CaptureBrandSource): CaptureBrandRef;   // unmatched → { brandId: null, name: raw, source }
  export function toBrandHintEcho(resolved: ResolvedBrand | null, raw: string): CaptureBrandHintEcho;
  ```
- `startCapture` (flag on): when `body.metadata.brand` is a non-empty string → `resolveBrandFromText`, stores `metadata.bottle = { brand: CaptureBrandRef (source "hint", raw kept as `raw`), prompts: {}, skipped: [] }` (the raw `metadata.brand` stays for the legacy resolver), responds with `brandHint` and `nextFrame` (Task 9 fills `nextFrame`; until then `null`). Flag off → today's start.

- [ ] **Step 1: Write the failing tests** (`brand-resolve.unit.test.cjs`, query mock):
  - `resolveBrandFromText("  ")` → null, zero queries; `"Loud"` with the mock returning `{ brandId: "3", name: "Loud Lacquer", score: 0.71 }` → `{ brandId: 3, name: "Loud Lacquer", score: 0.71 }`; score `0.59` → null; `RESOLVE_BRAND_SQL` contains `brand_alias` and `similarity(`
  - `listBrandShadeNames` with 401 mock rows → `names.length === 400`, `truncated: true`; 12 rows → `truncated: false`; the SQL binds `$2` for `created_by_user_id`
  - `toBrandRef(null, "Loud", "hint")` → `{ brandId: null, name: "Loud", source: "hint" }`
  - Handler (`capture-check` fake DB): `POST capture/start` with `{ metadata: { brand: "loud" } }`, flag on, brand query returning Loud Lacquer → 201 with `brandHint: { raw: "loud", brandId: "3", name: "Loud Lacquer" }` and the INSERT's metadata param has `bottle.brand.source === "hint"`; no catalog hit → `brandHint.name === "loud"`, `brandId null`; flag off → no `brandHint` key and no brand query (Review Focus 1)
- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run** the suite → PASS
- [ ] **Step 5: Commit** `feat(functions): resolve brand hints and brand reads against the catalog`

---

### Task 7: Vision read of the bottom sticker

**Files:**
- Create: `packages/functions/src/lib/sticker-read.ts`, `packages/functions/tests/sticker-read.unit.test.cjs`
- Modify: `packages/functions/src/functions/capture.ts` (`runFrameAiExtraction` label branch behind the flag)

**Interfaces:**
- Consumes: `requestAzureOpenAIChatCompletion`, `resolveVisionImageDetail`, `parseConfidence` (`lib/ai-color-detection.ts`); `finishNamesForPrompt`, `canonicalizeFinish`, `loadFinishCatalog` (`lib/finishes.ts`); `OcrResult` (`lib/ocr.ts`); `ParsedLabelFields` (`lib/ocr-parser.ts`); Task 6 `listBrandShadeNames`.
- Produces:
  ```ts
  export const STICKER_READ_PROMPT_VERSION = "sticker-read/2026-10-v1";
  export const STICKER_READ_OCR_MIN_CONFIDENCE = 0.4;
  export const STICKER_READ_DEPLOYMENT_ENV_KEYS = ["AZURE_OPENAI_DEPLOYMENT_LABEL", "AZURE_OPENAI_DEPLOYMENT_HEX", "AZURE_OPENAI_DEPLOYMENT"];
  /** Spec §5.2: brand known (closed question), or OCR unusable (null, empty text, or confidence < 0.4). */
  export function shouldVisionRead(input: { brandKnown: boolean; ocr: Pick<OcrResult, "rawText" | "confidence"> | null }): boolean;
  export interface StickerReadInput { imageDataUri: string; surface: BottleSurface | null; brandName: string | null; shadeNames: readonly string[]; finishCatalog?: FinishCatalog; imageDetail?: VisionImageDetail }
  export interface StickerReadResult { brand: string | null; brandConfidence: number | null; printedName: string | null; closestListed: string | null; finish: string | null; gtin: string | null; confidence: number; promptVersion: string; closedSet: boolean; rawContent: string }
  export function buildStickerReadPayload(input: StickerReadInput, safePrompt: boolean): Record<string, unknown>;
  // closedSet = 1 ≤ shadeNames.length ≤ 400: the user text lists the names and asks for printedName, closestListed (exactly one listed name or null), brand, finish (one of finishNamesForPrompt), gtin, confidence 0..1; open read lists no names and asks for closestListed: null. Image detail from resolveVisionImageDetail() unless given.
  export function parseStickerRead(content: string, shadeNames: readonly string[], finishCatalog?: FinishCatalog): Omit<StickerReadResult, "promptVersion" | "closedSet" | "rawContent">;  // closestListed must equal a listed name case-insensitively, else null; finish via canonicalizeFinish
  /** One low-detail call; null when config is missing, content is null, or the call throws (logged). */
  export async function readStickerWithVision(input: StickerReadInput, options?: { onLog?: HexDetectionOptions["onLog"] }): Promise<StickerReadResult | null>;
  export interface MergedLabelExtraction { extracted: Record<string, unknown>; sources: Record<string, "ocr" | "vision"> }
  /** OCR-derived fields (parseLabelText result, confidence = its `confidence`) keep precedence only when their confidence is higher; vision fields otherwise; `shadeNameListed` and `brandConfidence` come from vision only; `extracted.source = "vision"` when any vision field won. */
  export function mergeLabelExtraction(ocr: { fields: Record<string, unknown>; confidence: number } | null, vision: StickerReadResult | null): MergedLabelExtraction;
  ```
- Frame handler (flag on, `label` frame, data-URL input): after today's OCR + `parseLabelText`, compute `brandKnown` (metadata `bottle.brand.brandId`, or `resolveBrandFromText(evidence.brand)` when `evidence.brand` came from a frame) → `shouldVisionRead` → `listBrandShadeNames` (when a brand id) → `readStickerWithVision` → `mergeLabelExtraction`; `quality_json.ai.sticker = { promptVersion, closedSet, listedCount, confidence, modelCalls: 0 | 1 }`. Remote-URL input skips the vision read. Flag off → today's OCR-only path.

- [ ] **Step 1: Write the failing tests**
  - `shouldVisionRead({ brandKnown: true, ocr: { rawText: "x", confidence: 0.9 } })` → true; `{ brandKnown: false, ocr: null }` → true; `{ brandKnown: false, ocr: { rawText: "OPI", confidence: 0.39 } }` → true; `{ brandKnown: false, ocr: { rawText: "OPI", confidence: 0.4 } }` → false
  - `buildStickerReadPayload` with 3 names → user text contains all three and the word "closest"; with 401 names → no name listed and the system text says the list is unavailable; `max_tokens ≤ 300`, `response_format json_object`
  - `parseStickerRead('{"printedName":"unicorn skin","closestListed":"Unicorn Skin","brand":"Holo Taco","finish":"Holo","confidence":0.82}', ["Unicorn Skin", "Linear Holo"])` → `closestListed: "Unicorn Skin"`, `finish: "holographic"` (alias canonicalized), `confidence 0.82`; `closestListed: "Not Listed"` → null; invalid JSON → every field null, confidence 0
  - `mergeLabelExtraction({ fields: { brand: "OPI", shadeName: "Big Apple" }, confidence: 0.9 }, vision with shadeName "Big Apple Red" confidence 0.6)` → `shadeName: "Big Apple"`, `sources.shadeName === "ocr"`; swap the confidences → vision wins and `extracted.source === "vision"`; vision-only `shadeNameListed` always copied
  - `readStickerWithVision` with the chat mock returning `provider: "none"` → null; throwing → null (Review Focus 2)
  - Handler (`capture-check` fake DB, flag on, brand hint Holo Taco resolved, OCR mock confidence 0.9, chat mock returning the JSON above): the inserted `quality_json.extracted.shadeNameListed === "Unicorn Skin"` and `quality_json.ai.sticker.closedSet === true`; flag off → no chat call, `quality_json.ai.sticker` absent (Review Focus 1)
- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run** the suite → PASS
- [ ] **Step 5: Commit** `feat(functions): closed-set vision read of the bottom sticker`

---

### Task 8: Brand-first resolver

**Files:**
- Create: `packages/functions/src/lib/bottle-resolver.ts`, `packages/functions/tests/bottle-resolver.unit.test.cjs`
- Modify: `packages/functions/src/functions/capture.ts` (`resolveFromEvidence` delegates to `resolveBottle` when the flag is on; `resolveShadeCandidates` exported for the no-brand path; `computeCaptureCheck` copies `bottle.suggestedShade` / `brandConflict` and candidate `brandId` into the response; `capture.resolved` telemetry in `checkCapture` and `finalizeCapture`)
- Modify: `packages/functions/README.md` (capture check paragraph: the brand-first rules, bands, `suggestedShade`, `brandConflict`, audit shape)

**Interfaces:**
- Consumes: Task 3 types; Task 6 `resolveBrandFromText`, `toBrandRef`; `buildNearHexDistanceSql` (`lib/near-hex.ts`); `HIGH_CONFIDENCE_MAX_DISTANCE`, `MEDIUM_CONFIDENCE_MAX_DISTANCE`, `hexToOklab` (shared); `buildCandidateQuestion`, `buildBrandShadeQuestion` (Task 3).
- Produces:
  ```ts
  export const BOTTLE_RESOLVER_VERSION = "bottle-v1";
  export const BOTTLE_RESOLVER_THRESHOLDS = { match: 0.92, question: 0.75, createCard: 0.5, colorHigh: HIGH_CONFIDENCE_MAX_DISTANCE, colorMedium: MEDIUM_CONFIDENCE_MAX_DISTANCE, brandRead: 0.6, brandConflict: 0.8, maxCandidates: 5, poolLimit: 50 } as const;
  /** Piecewise linear OKLAB distance → 0–1: [[0, 1], [0.05, 0.75], [0.10, 0.25], [0.30, 0]]; null in → null out. */
  export const COLOR_SCORE_BREAKPOINTS: readonly (readonly [number, number])[];
  export function colorScoreForDistance(distance: number | null): number | null;
  export interface BottleCandidateRow { shadeId: string; brandId: string; brand: string; shadeName: string; nameScore: number | null; colorDistance: number | null }
  export interface ScoredBottleCandidate { shadeId: number; brandId: number; display: string; nameScore: number | null; colorDistance: number | null; colorScore: number | null; score: number; fromConflictBrand: boolean }
  /** nameScore = max(trigram, visionConfidence) for the row whose name equals shadeNameListed (case-insensitive); score = nameScore ?? colorScore ?? 0; sorted nameScore DESC NULLS LAST, colorDistance ASC NULLS LAST, shadeId ASC; fromConflictBrand = brandId !== hintBrandId when hintBrandId is set. */
  export function scoreBottleCandidates(rows: readonly BottleCandidateRow[], input: { shadeNameListed: string | null; visionConfidence: number | null; hintBrandId: number | null }): ScoredBottleCandidate[];
  export type BottleDecision =
    | { kind: "matched"; candidate: ScoredBottleCandidate; confidence: number; method: "name" | "name+color" }
    | { kind: "candidates"; candidates: ScoredBottleCandidate[]; confidence: number; tie: boolean; method: "name" | "color" }
    | { kind: "create_card"; confidence: 0 }
    | { kind: "unmatched"; confidence: number };
  export function decideBottleResolution(scored: readonly ScoredBottleCandidate[], ctx: { nameRead: boolean; brandKnown: boolean }): BottleDecision;
  // top = scored[0]; D = top.colorDistance (null = no glass hex):
  //   none              → brandKnown ? create_card : unmatched(0)
  //   nameScore ≥ 0.92  → D === null || D ≤ 0.10 ? matched("name", conf = nameScore) : candidates("name", tie false)
  //   nameScore ≥ 0.75  → D !== null && D ≤ 0.05 ? matched("name+color", conf = 0.92) : candidates("name")
  //   !nameRead         → D !== null && D ≤ 0.10 ? candidates("color", tie = second candidate also ≤ 0.10, conf = colorScore) : brandKnown ? create_card : unmatched
  //   nameScore ≥ 0.5   → candidates("name", conf = nameScore)
  //   else              → brandKnown ? create_card : unmatched(top.score)
  //   candidates lists are cut to maxCandidates (5).
  export function buildSuggestedShade(evidence: CaptureEvidence, brand: CaptureBrandRef | null): CaptureSuggestedShade;   // shadeName = evidence.shadeName, hex = glassHex, finish, gtin, brand fields from `brand`
  /** $1 brand_id[] (bigint[]), $2 user_id, $3 shade name text or null, $4–$6 glass OKLAB L/a/b or null: shades of those brands (merged_into_shade_id IS NULL, product_category 'color', status 'active' or the caller's own user_submitted), nameScore = similarity(shade_name_canonical, $3), colorDistance from shade.oklab_* via buildNearHexDistanceSql; LIMIT 50. */
  export const BOTTLE_CANDIDATES_SQL: string;
  export interface ResolveBottleDeps { query: typeof query; resolveBrand: typeof resolveBrandFromText; globalCandidates: (evidence: CaptureEvidence) => Promise<CaptureMatchCandidate[]>; colorDistances: (shadeIds: number[], glassHex: string) => Promise<Map<number, number | null>> }
  export interface ResolveBottleContext { userId: number; frameCount: number; hintBrand: CaptureBrandRef | null; barcodeBrand: { brandId: number; name: string } | null; modelCalls: number }
  /** Spec §5.3 steps 2–7 (step 1, the barcode, stays in capture.ts): brand = hint > barcode > brandRead resolved at ≥ 0.6; pool = brand's shades (+ the read brand's when it conflicts with the hint at ≥ 0.8); no brand → globalCandidates re-ranked by colorDistances; returns a ResolverDecision with `bottle` filled and metadataPatch.resolver = { version, step, brand, candidateCount, top5 score components, suggestedShade?, brandConflict?, modelCalls, audit }. */
  export async function resolveBottle(evidence: CaptureEvidence, ctx: ResolveBottleContext, deps: ResolveBottleDeps): Promise<ResolverDecision>;
  ```
  Mapping to `ResolverDecision`: `matched` → `status: "matched"`, `entityType: "shade"`; `candidates` → `status: "needs_question"` with `buildCandidateQuestion`; `create_card` → `status: "unmatched"` with `bottle.suggestedShade`; `unmatched` → today's rule (`buildBrandShadeQuestion` when `!brand || !shadeName`, else `unmatched`). `bottle.suggestedShade` is set on every non-matched decision when `brandKnown` (so "None of these" can show the card). `brandKnown` = hint, barcode brand, or a resolved read; a hint with `brandId: null` still counts as known (raw text on the card) but adds no pool.
- `capture.ts`: `computeCaptureCheck` copies each scored candidate's `brandId` and `colorDistance` onto the `CaptureCheckCandidate`; `resolveFromEvidence` keeps the frame-count and barcode steps, then flag on → `resolveBottle` (with `hintBrand` from `metadata.bottle.brand`, `barcodeBrand` null in Slice A since a barcode hit already matched, `modelCalls` summed from frames' `quality_json.ai.glass/sticker.modelCalls`), flag off → today's trigram path. `check` and `finalize` emit `capture.resolved` `{ captureId, method: "barcode" | "name" | "name+color" | "color" | "create_card" | "unmatched", brandLocked: hintBrand !== null, candidateCount, modelCalls, frames }`.

- [ ] **Step 1: Write the failing tests** (`bottle-resolver.unit.test.cjs`; pure functions with synthetic rows, `resolveBottle` with recorder deps):
  - `colorScoreForDistance(0) === 1`, `(0.05) === 0.75`, `(0.10) === 0.25`, `(0.2) === 0.125`, `(0.5) === 0`, `(null) === null`
  - `scoreBottleCandidates`: the listed-name row gets `nameScore` lifted to `0.85` from trigram `0.4` with `visionConfidence 0.85`; ordering puts a null nameScore after `0.3`; `fromConflictBrand` true only for rows of another brand when `hintBrandId` is set
  - `decideBottleResolution` (spec §5.3 bands, one assertion each): `[{ nameScore 0.95, D 0.03 }]` → matched "name" conf 0.95; `[{ 0.95, D 0.2 }]` → candidates (color beyond MEDIUM never auto-matches); `[{ 0.8, D 0.04 }]` → matched "name+color" conf 0.92; `[{ 0.8, D 0.08 }]` → candidates; `[{ 0.8, D null }]` → candidates; `nameRead false`, `[{ null, 0.04 }, { null, 0.09 }]` → candidates "color", `tie: true`; `[{ null, 0.04 }, { null, 0.2 }]` → tie false; `nameRead false`, `[{ null, 0.15 }]`, brandKnown → create_card; `[{ 0.6, D null }]` → candidates; `[{ 0.4 }]`, brandKnown → create_card; `[{ 0.4 }]`, !brandKnown → unmatched; `[]`, brandKnown → create_card; seven rows → `candidates.length === 5`
  - `resolveBottle`: hint Loud Lacquer (id 3) + read "Holo Taco" at 0.85 resolving to id 7 → `BOTTLE_CANDIDATES_SQL` bound with `[3, 7]`, `bottle.brandConflict = { hinted: { brandId: "3", … }, read: { brandId: "7", confidence: 0.85 } }`; read at 0.7 → pool `[3]`, no conflict; no hint, a read text whose brand lookup scores 0.55 (`resolveBrand` returns null) → `globalCandidates` used, `colorDistances` applied, `bottle.brand === null`; hint with `brandId: null` → `globalCandidates` path and `bottle.suggestedShade.brandName === "loud"`, `brandSource "hint"`; a create_card decision → `status "unmatched"` with `metadataPatch.resolver.suggestedShade` and `step === "create_card"`; every SQL call binds the user id (grep params)
  - Handler (`capture-check` fake DB, flag on): `check` response carries `suggestedShade` on unmatched, `brandConflict` when set, `candidates[0].brandId` and `candidates[0].colorDistance` when a glass hex exists; flag off → neither key, and the recorded response equals today's fixture (Review Focus 1)
- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement** `bottle-resolver.ts`, the delegation and the check/finalize wiring
- [ ] **Step 4: Run** the suite → PASS
- [ ] **Step 5: README** (capture check paragraph)
- [ ] **Step 6: Commit** `feat(functions): brand-first bottle resolver with color confirmation bands`

---

### Task 9: Server-driven prompts (`nextFrame`) and skips

**Files:**
- Create: `packages/functions/src/lib/bottle-flow.ts`, `packages/functions/tests/bottle-flow.unit.test.cjs`, `packages/functions/tests/capture-bottle.unit.test.cjs`
- Modify: `packages/functions/src/functions/capture.ts` (`startCapture`, `addCaptureFrame`, `checkCapture`, `getCaptureStatus`, `answerCaptureQuestion`)
- Modify: `packages/shared/src/capture/bottle-flow.test.ts` (one test asserting `DEFAULT_SURFACE_PROMPTS` equals the server's `SURFACE_PROMPTS`, read from `packages/functions/src/lib/bottle-flow.ts` via a relative import), `packages/functions/README.md` (route table: `frame`, `check`, `status`, `answer` notes; a "Bottle flow" paragraph), `CLAUDE.md` (Architecture: "Bottle recognition" paragraph)

**Interfaces:**
- Consumes: Task 1 types; Task 3 `CaptureEvidence`; Task 8 `BottleDecision` kinds via `ResolverDecision.bottle.tie` and `status`; shared `frameQualityWarningsFromQuality`; `GUIDANCE_CONFIG.maxFrames` (6).
- Produces:
  ```ts
  export const SURFACE_PROMPTS: Record<BottleSurface, string>;   // the four spec §4.1 prompts (the canonical copy)
  export const FRONT_BOX_HINT = "No front label? Show the box barcode instead";
  export const TIE_BREAK_HINTS = ["Tilt it toward the light", "Hold it against something white"] as const;
  export const RETRY_HINTS: Record<FrameQualityWarning, string> = { "too-dark": "Looks dark — move into better light", "too-bright": "Too bright — move out of the glare", blurry: "Looks blurry — hold steady and tap to focus" };
  export const BOTTLE_MAX_PROMPTS_PER_KEY = 2;
  export interface BottleFlowState { prompts: Record<string, number>; skipped: BottleSurface[]; lastRejected: { surface: BottleSurface; warning: FrameQualityWarning } | null }
  export function readBottleFlowState(metadata: Record<string, unknown> | null): BottleFlowState;   // metadata.bottle.{prompts,skipped,lastRejected}, tolerant
  export function promptKey(spec: Pick<CaptureFrameRequestSpec, "surface" | "reason">): string;      // `${surface}:${reason}`
  export type PlanDecision = "matched" | "candidates" | "candidates_tied" | "create_card" | "unmatched" | "none";
  export interface PlanNextFrameInput { state: BottleFlowState; frameCount: number; maxFrames: number; surfaces: Partial<Record<BottleSurface, number>>; brandKnown: boolean; nameRead: boolean; glassHex: boolean; decision: PlanDecision }
  export function planNextFrame(input: PlanNextFrameInput): CaptureFrameRequestSpec | null;
  export function recordPrompt(state: BottleFlowState, spec: CaptureFrameRequestSpec): BottleFlowState;
  export function recordSkip(state: BottleFlowState, surface: BottleSurface): BottleFlowState;
  export function recordRejected(state: BottleFlowState, rejected: BottleFlowState["lastRejected"]): BottleFlowState;
  export function bottleFlowMetadataPatch(state: BottleFlowState, nextFrame: CaptureFrameRequestSpec | null): Record<string, unknown>;   // { bottle: { prompts, skipped, lastRejected, lastNextFrame } }, merged with jsonb || so metadata.bottle.brand is preserved (patch includes brand when present)
  export function decisionForPlan(decision: ResolverDecision): PlanDecision;   // matched → matched; needs_question with candidates → bottle.tie ? candidates_tied : candidates; unmatched with suggestedShade → create_card; else unmatched; none when frameCount 0 and no evidence
  ```
  `planNextFrame`: a candidate spec is skipped when `frameCount >= maxFrames`, `state.prompts[key] >= 2`, or its surface is in `skipped`. Order: (1) `state.lastRejected` whose surface has produced no evidence → same surface, `retry_quality`, hint `RETRY_HINTS[warning]`, `optional: false`; (2) `decision === "matched"` → null; (3) `!brandKnown` → `front` `need_brand` (hint `FRONT_BOX_HINT`), else `box` `need_brand` (`label`); (4) `brandKnown && !nameRead` → `bottom` `need_name`; (5) `decision === "candidates" && !glassHex` → `glass` `need_color`, `optional: true`; (6) `decision === "candidates_tied"` → `glass` `tie_break`, hint `TIE_BREAK_HINTS[min(prompts[key], 1)]`, `optional: true`; (7) no frames and nothing known → default order first uncaptured (front/bottom/glass with reasons need_brand/need_name/need_color); (8) null. `frameType` from `BOTTLE_SURFACE_FRAME_TYPE`.
- Handlers (flag on): `startCapture` → `nextFrame = planNextFrame(initial)` and records it; `addCaptureFrame` → after the frame transaction, `resolveCaptureSession(refreshed)` → `planNextFrame` → one `UPDATE capture_session SET metadata = metadata || $2` with `bottleFlowMetadataPatch` + `{ resolver: decision.metadataPatch.resolver }` → response `nextFrame`; `lastRejected` is set when `frameQualityWarningsFromQuality(body.quality)` is non-empty and this frame added no evidence (no new name/brand/hex); `trackEvent("capture.surface_captured", { captureId, surface, frameType, skipped: false, extracted })`; `checkCapture` and `getCaptureStatus` → `nextFrame` from the current state (check re-plans from its decision; status returns `metadata.bottle.lastNextFrame`); `answerCaptureQuestion` with `skipSurface` (flag on; 400 `skipSurface is not enabled` when off; `answer` still required when `skipSurface` is absent) → `recordSkip`, re-plan, `capture.surface_captured` with `skipped: true`, response `nextFrame`. Flag off → no `nextFrame` key anywhere.

- [ ] **Step 1: Write the failing tests**
  - `bottle-flow.unit.test.cjs` (pure): empty state, no frames → front `need_brand`; `brandKnown` → bottom `need_name`; `brandKnown, nameRead, decision candidates, !glassHex` → glass `need_color` optional; `candidates_tied` first time → hint "Tilt it toward the light", with `prompts["glass:tie_break"] = 1` → "Hold it against something white", `= 2` → null; `decision matched` → null; `lastRejected { bottom, blurry }` with `surfaces.bottom = 1` and `nameRead false` → bottom `retry_quality` with the blurry hint, and with `nameRead true` → not a retry; `frameCount 6` → null; `skipped: ["front"]`, `!brandKnown` → box; all of front/bottom/glass skipped and `!brandKnown` → box, then with box skipped → null (Review Focus 5); `recordPrompt` increments the key; `bottleFlowMetadataPatch` keeps `brand`; `promptKey({ surface: "glass", reason: "tie_break" }) === "glass:tie_break"`
  - `capture-bottle.unit.test.cjs` (handler-level, `capture-check` style fake DB, flag on unless stated): `start` → 201 with `nextFrame.surface === "front"`; with `metadata.brand` resolving → `nextFrame.surface === "bottom"`; a label frame with a read name and a candidate decision → `nextFrame.surface === "glass"`, and the `UPDATE capture_session` param carries `bottle.prompts["glass:need_color"] === 1` and `resolver.version === "bottle-v1"`; a glass frame after that → `nextFrame === null`; `answer` with `{ skipSurface: "bottom" }` → 200, `metadata.bottle.skipped` includes bottom, `capture.surface_captured` tracked with `skipped: true`, and the response `nextFrame.surface !== "bottom"`; `answer` with `{ skipSurface: "cap" }` → 400; `status` → `nextFrame` equals the last planned spec; **flag off**: the same fixture sequence yields responses deep-equal to the recorded today's shapes (`start`, `frame`, `check`, `status`, `answer` with `{ answer: "skip" }`) with no `nextFrame`/`brandHint`/`suggestedShade`/`brandConflict` keys, and `answer` with `{ skipSurface }` alone → 400 `answer is required` (Review Focus 1); a frame whose `quality.surface = "cap"` is accepted as a plain frame (201) and counts in no surface
- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement** `bottle-flow.ts` and the handler wiring
- [ ] **Step 4: Run** `npm run test --workspace=swatchwatch-functions && npm run test --workspace=swatchwatch-shared` → PASS; manual flag-on run against the local host: `start` → front, a label frame (any JPEG) → the response names the next surface
- [ ] **Step 5: Docs** (README route notes + paragraph; CLAUDE.md "Bottle recognition" paragraph covering surfaces, `nextFrame`, glass hex, sticker read, bands, retention, flag)
- [ ] **Step 6: Commit** `feat(functions): server-driven bottle prompts and surface skips`

---

### Task 10: One-tap create with `captureId`

**Files:**
- Create: `packages/functions/src/lib/capture-session.ts`, `packages/functions/tests/polish-create-capture.unit.test.cjs`
- Modify: `packages/functions/src/functions/polishes.ts` (`createPolish`), `packages/functions/README.md` (`POST /api/polishes` row and the "Barcode scans" paragraph), `CLAUDE.md` (Barcodes paragraph: the create path marks the session)

**Interfaces:**
- Consumes: `normalizeGtin`, `rememberUserShadeBarcode`, `NormalizedGtin` (`lib/barcodes.ts`); Task 4 `releaseCaptureFrames`; `UUID_PATTERN` (move `isValidUuid` from `capture.ts` into `capture-session.ts` and import it back).
- Produces:
  ```ts
  export function isValidUuid(value: string): boolean;
  export class CaptureSessionNotFoundError extends Error {}
  export class CaptureSessionStateError extends Error {}   // cancelled
  /** $1 capture_uuid, $2 user_id: id, status, metadata, FOR UPDATE. */
  export const LOCK_CAPTURE_SESSION_SQL: string;
  /** $1 session id: newest frame's extracted gtin (quality_json->'extracted'->>'gtin'). */
  export const SELECT_SESSION_FRAME_GTIN_SQL: string;
  export const MARK_SESSION_CREATED_SHADE_SQL: string;   // status 'matched', top_confidence 1, accepted_entity_type 'shade', accepted_entity_id $2, metadata || {"resolver":{"step":"created_from_capture","createdShadeId":…}}, updated_at now(); $3 user_id
  export const EXPIRE_OPEN_QUESTIONS_SQL: string;
  /** Inside the caller's transaction. Throws CaptureSessionNotFoundError (no row for this caller) or CaptureSessionStateError (cancelled); otherwise marks the session matched whatever its state and returns the session's scanned GTIN (metadata.gtin, else the newest frame's) normalized, or null. */
  export async function markCaptureSessionCreatedShade(client: Pick<PoolClient, "query">, input: { userId: number; captureId: string; shadeId: number }): Promise<{ sessionId: number; gtin: NormalizedGtin | null }>;
  ```
- `createPolish`: `body.captureId` must be a UUID (400 `captureId must be a valid UUID`); inside the existing transaction, after `upsertInventoryItem`, call `markCaptureSessionCreatedShade`; when `scannedBarcode` is null and the session returned a GTIN → `rememberUserShadeBarcode(client, { userId, shadeId, gtin, captureSessionId })`; errors map to 404 `Capture session not found` / 409 `Capture session is cancelled` and roll the transaction back (no polish row). After commit: `releaseCaptureFrames` (best effort) and `trackEvent("capture.shade_created", { captureId, shadeId, hadBarcode: Boolean(gtin) })`. Works flag on or off.

- [ ] **Step 1: Write the failing tests** (`polish-create-capture.unit.test.cjs`, mocking as `tests/polish-create-barcode.unit.test.cjs`, plus `../lib/capture-frame-store` with a `releaseCaptureFrames` recorder):
  - `POST /api/polishes { brand, name, color, captureId }` for the caller's `processing` session → 201; the transaction ran `MARK_SESSION_CREATED_SHADE_SQL` with `[sessionId, shadeId, userId]`, then `releaseCaptureFrames` was called once with the session id after the transaction callback resolved
  - session metadata `{ gtin: "4006381333931" }` and no `body.barcode` → `user_shade_barcode` INSERT with that GTIN and `capture_session_id`; with `body.barcode` present → the body's barcode wins, one INSERT only
  - another user's / unknown capture id → 404 and no `INSERT INTO shade`, no inventory write (Review Focus 3); a `cancelled` session → 409, same; `captureId: "nope"` → 400 before any query
  - a `matched` session (web legacy finalize left it unmatched or matched) → still 201 and re-marked with the new shade
  - without `captureId` → today's behavior (no session query)
- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run** the suite → PASS
- [ ] **Step 5: Docs** (README row + paragraph; CLAUDE.md sentence)
- [ ] **Step 6: Commit** `feat(functions): POST /api/polishes captureId marks the capture session and learns the barcode`

---

### Task 11: Web flow logic

**Files:**
- Modify: `apps/web/src/lib/use-feature-flags.ts` (expose `bottleCapture`), `apps/web/src/lib/rapid-add-flow.ts`, `apps/web/src/lib/rapid-add-flow.test.ts`, `apps/web/src/lib/capture-verdict.ts`, `apps/web/src/lib/capture-verdict.test.ts`
- Create: `apps/web/src/lib/sticky-hints-store.ts`, `apps/web/src/lib/sticky-hints-store.test.ts`
- Modify: `apps/web/src/components/user-card.tsx` (sign-out also calls `clearStickyHints(safeLocalStorage())`)

**Interfaces:**
- Consumes: Task 2 shared helpers; `CaptureCheckResponse`, `CaptureCheckCandidate`.
- Produces (`rapid-add-flow.ts`):
  ```ts
  export interface FrameQualityInput { …; surface?: BottleSurface | null }            // buildFrameQuality adds `surface` when set
  export function buildStartMetadata(input: { barcode: ScannedBarcode | null; hints: { brand?: string; shadeName?: string; finish?: string; collection?: string }; sticky?: StickyHints | null }): Record<string, unknown>;   // sticky brand/finish/collection fill the hint when the per-bottle hint is empty (hintsToStartMetadata)
  export function canCheck(input: { frames: readonly CaptureFrameEntry[]; session: RapidAddSessionState; hasHints: boolean }): boolean;   // same rule as canFinalize but allowed in phase "collecting"
  export type RapidAddBusy = … | "skipping" | "creating";
  ```
- Produces (`capture-verdict.ts`):
  ```ts
  export interface PickVerdict { kind: "pick"; candidates: CaptureCheckCandidate[]; brandConflict: CaptureBrandConflict | null; check: CaptureCheckResponse }
  export interface CreateCardVerdict { kind: "create_card"; card: CreateCardModel; brandConflict: CaptureBrandConflict | null }
  export type CaptureVerdict = … | PickVerdict | CreateCardVerdict;
  /** Bottle sequence (check-first): matched → `checked` (relationship, hex, display, shadeId; gtin may be ""), needs_question with ≥1 candidate → `pick` (≤ 5 with shadeId), else deriveCreateCard(…, { afterNoneOfThese }) → `create_card`, else `add` with the evidence summary. */
  export function verdictFromBottleCheck(check: CaptureCheckResponse, opts: { afterNoneOfThese: boolean; evidence: CaptureEvidenceSummary }): CaptureVerdict;
  ```
- Produces (`sticky-hints-store.ts`): `safeLocalStorage(): Storage | null`, `readStickyHints(storage, userId): StickyHints`, `writeStickyHints(storage, userId, hints): void` (removes the key when `!isBatchMode(hints)` and no finish/collection), `clearStickyHints(storage): void` (every key under the prefix).

- [ ] **Step 1: Write the failing tests**
  - `rapid-add-flow.test.ts`: `buildFrameQuality({ …, surface: "glass" }).surface === "glass"`; omitted → no key; `buildStartMetadata({ barcode: null, hints: {}, sticky: { brand: "loud", brandCanonical: "Loud Lacquer", finish: "creme", … } })` → `brand: "Loud Lacquer"`, `finish: "creme"`; a typed per-bottle brand hint beats the sticky one; `canCheck` false while uploading, true with one uploaded frame
  - `capture-verdict.test.ts`: `verdictFromBottleCheck` matched/owned → `checked` with `relationship "owned"`; needs_question with 3 candidates → `pick` of 3, `brandConflict` copied; needs_question + `afterNoneOfThese: true` + `suggestedShade` → `create_card`; unmatched + `suggestedShade.brandSource "read"` → `create_card` with `brandNeedsConfirm`; unmatched without `suggestedShade` → `add` with evidence
  - `sticky-hints-store.test.ts` (in-memory Storage): round trip; `writeStickyHints` with EMPTY removes the key; `clearStickyHints` removes `swatchwatch.rapid-add.hints:*` and nothing else; a throwing storage never throws
- [ ] **Step 2: Run** `npm run test --workspace=swatchwatch-web` → FAIL
- [ ] **Step 3: Implement** (and the `user-card.tsx` sign-out line)
- [ ] **Step 4: Run** `npm run test --workspace=swatchwatch-web && npm run typecheck --workspace=swatchwatch-web` → PASS (typecheck fails only on `verdict-card.tsx`'s exhaustive switch until Task 12; add the two `case` stubs returning `assertNever`-safe placeholders now so typecheck is clean)
- [ ] **Step 5: Commit** `feat(web): bottle flow state, sticky hints store and check-first verdicts`

---

### Task 12: Web UI — bottle sequence, batch header, create card

**Files:**
- Create: `apps/web/src/components/rapid-add/bottle-prompt-panel.tsx`, `apps/web/src/components/rapid-add/batch-brand-field.tsx`, `apps/web/src/components/rapid-add/create-shade-card.tsx`
- Modify: `apps/web/src/app/rapid-add/page.tsx`, `apps/web/src/components/rapid-add/verdict-card.tsx` (`pick` and `create_card` layouts; `onPick`, `onNoneOfThese`, `onCreate`, `onSwitchBrand` props), `apps/web/src/components/rapid-add/camera-capture.tsx` (reuse Slice 0's `hideFrameTypeOptions`)
- Modify: `apps/web/README.md` (`/rapid-add` line and component rows), `CLAUDE.md` (`/rapid-add` route row)

**Interfaces:**
- Consumes: Task 11; `bottleFlowReducer`, `deriveBottleCameraView`, `shouldAutoCheck`, sticky-hint helpers, `createPolishRequestFromCard`, `canSubmitCreateCard` (Task 2); `checkCapture`, `answerCaptureQuestion({ skipSurface })`, `createPolish`, `updatePolish` (`lib/api.ts`); `useFeatureFlags().bottleCapture`.
- Behavior (layout is the builder's within the page's existing sections):
  1. **Mode:** `bottleCapture` on → the bottle sequence is the default; a "More options" link reveals today's Label / Barcode / Color chips and the legacy finalize path (unchanged). Off → today's page exactly.
  2. **Batch brand field** above the camera: brand input (+ optional finish select and collection input behind "More hints") and Confirm → sticky hints written per user (`writeStickyHints`); header "Going through: <name> · Done" (`batchHeaderLabel`); Done clears them. The start response's `brandHint` updates `brandCanonical` via `withBrandEcho`.
  3. **Prompt panel:** `deriveBottleCameraView` → prompt, hint, "Step n of m", surface chips to jump to any surface, "Can't see it" → `answerCaptureQuestion(captureId, { skipSurface })` (starts the session first when needed) → `surface_skipped`; shutter sends `frameType` and `quality.surface` for the current view; after each upload `frame_uploaded` with the response's `nextFrame`; `shouldAutoCheck` → `checkCapture`; "Find match" (enabled by `canCheck`) → `checkCapture` any time.
  4. **Verdict:** `verdictFromBottleCheck` → `checked` renders as today (Add / ♡ Wishlist via `updatePolish`, no finalize); `pick` renders ≤ 5 rows (name, swatch `hex`, confidence, "Δ color" from `colorDistance` when present, ownership badge, brand name when `brandConflict`) + "None of these" → `verdictFromBottleCheck(check, { afterNoneOfThese: true })`; `create_card` renders `CreateShadeCard` (brand field with "read from the bottle, check it" + Confirm when `brandNeedsConfirm`, name input, hex chip with `<input type="color">`, finish select from `buildFinishOptions`, Add / ♡ Wishlist / Next); Add → `createPolish(createPolishRequestFromCard(card, edits, "owned"))` → `added` verdict; when `brandConflict` is set, a "Switch to <read brand>" button → `switchBrand` on the sticky hints; the `add` verdict (nothing readable) shows the session's frame thumbnails (`FrameStrip`) above its manual-add link, prefilled with any read text.
  5. Telemetry: `rapid_add.verdict` keeps its `kind` property (new kinds included); `rapid_add.bottle_skip` `{ surface }`.
- [ ] **Step 1: Build** the three components and the page wiring; `verdict-card.tsx` gets the two layouts (replacing Task 11's stubs)
- [ ] **Step 2: Run** `npm run lint --workspace=swatchwatch-web && npm run typecheck --workspace=swatchwatch-web && npm run test --workspace=swatchwatch-web` → clean
- [ ] **Step 3: Verify in the browser** (`npm run dev`, Functions with `BOTTLE_CAPTURE_ENABLED=true`, dev bypass): open `/rapid-add`; the prompt reads "Show the front of the bottle"; upload a bottle photo via the fallback → the prompt changes; "Can't see it" moves on; after three frames the verdict appears without a finalize call (check the network panel: `/check`, no `/finalize`); set the brand field to a catalog brand → header shows the canonical name and the first prompt is "Now the bottom"; reload → the header persists; Done clears it; with an unknown shade the create card appears, Add creates it (new row on `/polishes`), and `/status` for that capture shows `matched`; set the flag off and reload → today's chips page
- [ ] **Step 4: Docs** (README `/rapid-add` line, component rows; CLAUDE.md route row)
- [ ] **Step 5: Commit** `feat(web): guided bottle sequence, batch brand header and one-tap create on Rapid Add`

---

### Task 13: Mobile flow logic

**Files:**
- Modify: `apps/mobile/src/api/client.ts` (`getFeatureFlags(): Promise<FeatureFlagsResponse>` — `GET /config/flags`, no auth header)
- Create: `apps/mobile/src/lib/feature-flags.ts`, `apps/mobile/src/lib/feature-flags.test.ts`
- Create: `apps/mobile/src/lib/sticky-hints.ts`, `apps/mobile/src/lib/sticky-hints.test.ts`
- Modify: `apps/mobile/src/lib/rapid-add.ts`, `apps/mobile/src/lib/rapid-add.test.ts`

**Interfaces:**
- Consumes: Task 2 shared helpers; `readCache`, `writeCache` (`lib/api-cache.ts`, scope = user id so `clearApiCache` wipes it on sign-out).
- Produces:
  ```ts
  // feature-flags.ts
  export const FEATURE_FLAGS_CACHE_KEY = "config.flags";
  export const DEFAULT_FLAGS: FeatureFlagsResponse["flags"];   // all false
  export function parseFlags(raw: unknown): FeatureFlagsResponse["flags"];   // unknown keys dropped, non-boolean → false
  export function useFeatureFlags(): FeatureFlagsResponse["flags"];   // cached copy first (scope "shared"), then getFeatureFlags(); DEFAULT_FLAGS on any failure
  // sticky-hints.ts
  export const STICKY_HINTS_CACHE_KEY = "rapid-add.hints";
  export async function readStickyHintsCache(scope: string): Promise<StickyHints>;   // parseStickyHints over readCache
  export async function writeStickyHintsCache(scope: string, hints: StickyHints): Promise<void>;
  // rapid-add.ts
  export interface FrameQualityInput { …; surface?: BottleSurface | null }
  export function buildStartMetadata(input: { barcode: ScannedBarcode | null; hints: CaptureHints; sticky?: StickyHints | null }): Record<string, unknown>;
  export interface CreateVerdict { kind: "create"; card: CreateCardModel; brandConflict: CaptureBrandConflict | null }
  export interface PickVerdict { kind: "pick"; candidates: CaptureCheckCandidate[]; brandConflict?: CaptureBrandConflict | null }
  export type RapidAddVerdict = … | CreateVerdict;
  /** Bottle sequence: matched → verdictForCandidate; needs_question with pickable candidates → pick (brandConflict copied); else deriveCreateCard → create; else not-found. */
  export function deriveBottleVerdict(check: CaptureCheckResponse, opts: { afterNoneOfThese: boolean; gtin?: string }): RapidAddVerdict;
  ```
- [ ] **Step 1: Write the failing tests**
  - `feature-flags.test.ts`: `parseFlags({ bottleCapture: true, nope: true })` → `{ shareableWishlist: false, shareableLooks: false, bottleCapture: true }`; `parseFlags(null)` → `DEFAULT_FLAGS`
  - `sticky-hints.test.ts` (in-memory `KeyValueStore` via `createApiCache`): round trip under `cacheStorageKey(scope, "rapid-add.hints")`; a corrupt entry → `EMPTY_STICKY_HINTS`
  - `rapid-add.test.ts`: `buildFrameQuality` surface; `buildStartMetadata` sticky precedence (typed hint wins); `deriveBottleVerdict` matched → owned/add; 2 candidates → pick with `brandConflict`; `afterNoneOfThese` + `suggestedShade` → `create` with `card.captureId === check.captureId`; unmatched with no `suggestedShade` → `not-found` with gtin
- [ ] **Step 2: Run** `npm run test --workspace=apps/mobile` → FAIL
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run** `npm run test --workspace=apps/mobile && npm run typecheck --workspace=apps/mobile` → PASS (verdict-card's exhaustive switch gets a `create` stub now)
- [ ] **Step 5: Commit** `feat(mobile): feature flags, sticky hints and bottle verdicts for Rapid Add`

---

### Task 14: Mobile UI — bottle sequence and create card

**Files:**
- Modify: `apps/mobile/src/app/(app)/(tabs)/add.tsx`, `apps/mobile/src/components/verdict-card.tsx` (`create` layout; `pick` shows brand when `brandConflict`; props `onCreate(card, edits, status)`, `onSwitchBrand(read)`)
- Create: `apps/mobile/src/components/bottle-prompt.tsx` (prompt banner: prompt, hint, step, surface chips, "Can't see it")
- Modify: `apps/mobile/README.md` (Rapid Add section: bottle sequence, batch mode, create card, retention sentence), `CLAUDE.md` (Mobile app paragraph: one sentence)

**Interfaces:**
- Consumes: Task 13; shared `bottleFlowReducer`, `deriveBottleCameraView`, `shouldAutoCheck`, `canSubmitCreateCard`, `createPolishRequestFromCard`, `switchBrand`, `batchHeaderLabel`; `answerCaptureQuestion`, `createPolish`, `checkCapture` (`api/client.ts`); `useFeatureFlags().bottleCapture`.
- Behavior: flag on → the shutter follows `deriveBottleCameraView` (the Barcode / Label / Color chips move under "More options"; the barcode scanner keeps running and still short-circuits); brand field + "Going through: … · Done" above the camera backed by `readStickyHintsCache` / `writeStickyHintsCache` per user; "Can't see it" → `answerCaptureQuestion(captureId, { skipSurface })`; auto-check when `shouldAutoCheck`; verdicts via `deriveBottleVerdict` + `enrich`; `create` card: brand (confirm when `brandNeedsConfirm`), name, hex (hue chips from `polish-form-fields.tsx` or typed), finish chips, Add / Wishlist / Next → `createPolish(createPolishRequestFromCard(…))` → `added` verdict and `markActed`; "Switch to <brand>" when `brandConflict`; the `not-found` card shows the scan's frame thumbnails (`FrameStrip`) above "Add manually", which carries any read brand / name. `CameraPlaceholder` copy: "Photos are only sent to match this bottle and are kept for up to 24 hours." Flag off → today's tab.
- [ ] **Step 1: Build** the component, the card layout and the tab wiring
- [ ] **Step 2: Run** `npm run lint --workspace=apps/mobile && npm run typecheck --workspace=apps/mobile && npm run test --workspace=apps/mobile` → clean
- [ ] **Step 3: Verify in the simulator** (`npm run dev:mobile`, Functions with `BOTTLE_CAPTURE_ENABLED=true`): the prompt banner shows "Show the front of the bottle"; "Choose a photo" three times follows the prompts and ends on a verdict with no `finalize` in the Functions log; a brand hint survives a tab switch and an app restart, and `Done` clears it; an unknown shade shows the create card and Add opens the new polish; sign out → the hint is gone; flag off → today's tab
- [ ] **Step 4: Docs**
- [ ] **Step 5: Commit** `feat(mobile): guided bottle sequence and one-tap create on the Add tab`

---

### Task 15: Eval runner — adaptive replay and resolver-audit columns

**Files:**
- Modify: `packages/functions/src/eval/bottle/types.ts`, `samples.ts`, `api-client.ts`, `scoring.ts`, `report.ts`, `cli.ts`
- Modify: `packages/functions/tests/bottle-eval-scoring.unit.test.cjs`, `packages/functions/tests/bottle-eval-runner.unit.test.cjs`
- Modify: `packages/functions/README.md` ("Bottle recognition eval" subsection), `packages/functions/src/lib/bottle-eval.ts` (`SAMPLE_COLUMNS_SQL` gains `"finishFamily"` = `finish_type.family` joined on `sh.finishes[1]`, NULL for external samples; `SampleRow.finishFamily: string | null`)

**Interfaces:**
- Consumes: Task 1 `CaptureStartResponse.nextFrame`, `CaptureFrameResponse.nextFrame`; `CaptureStatusResponse.metadata.resolver.modelCalls` (Task 8); `finish_type.family` (joined on the shade's first `finishes` entry), `DUPE_FINISH_FAMILIES` fallback.
- Produces:
  ```ts
  // types.ts
  export interface EvalSample { …; finishFamily: string }                      // finish_type.family of finishes[1], else DUPE_FINISH_FAMILIES, else "unknown" (external samples: "unknown")
  export interface SampleResult { …; finishFamily: string; modelCalls: number | null; promptsFollowed: number; adaptive: boolean; createCard: boolean }
  export interface EvalSummary { …; byFinishFamily: Record<string, Record<Outcome, number>>; modelCalls: { mean: number; median: number; samples: number }; medianFramesNeeded: number; createCardRate: number }
  // api-client.ts
  CaptureApi.start(meta): Promise<{ captureId: string; nextFrame: CaptureFrameRequestSpec | null | undefined }>;
  CaptureApi.frame(id, body): Promise<{ nextFrame: CaptureFrameRequestSpec | null | undefined }>;
  CaptureApi.status(id): Promise<CaptureStatusResponse>;
  // scoring.ts
  export function classifyOutcome(sample, check): Outcome;   // unchanged rules; the resolver-audit columns the spec deferred (model calls, finish family, frames needed, create card) live on SampleResult / EvalSummary beside it
  export function modelCallsFromStatus(status: Pick<CaptureStatusResponse, "metadata">): number | null;   // metadata.resolver.modelCalls when a finite number
  export function summarize(results): EvalSummary;           // + byFinishFamily, modelCalls stats over scored samples with a number, medianFramesNeeded over scored samples, createCardRate = createCard / scored external samples (0 when none)
  // cli.ts
  /** Adaptive when start returns a nextFrame: send the sample's first unsent frame of the requested surface (falling back to the next unsent frame when the surface has none) until nextFrame is null or frames run out; otherwise all frames in position order (today). */
  export async function runSample(api, sample, readFrame?): Promise<SampleResult>;
  ```
  `report.ts`: the summary gains "Model calls per bottle: mean / median", "Median frames needed", "Create card (not in catalog): n%", and a per-finish-family table with the same outcome columns as the brand table; the verbose per-sample table gains `family`, `calls`, `prompts`, `card`.
- [ ] **Step 1: Write the failing tests**
  - scoring: `summarize` over results with families `solid`×2 (`matched_correct`, `asked_has_correct`), `glitter`×1 (`matched_wrong`) → `byFinishFamily.solid.matched_correct === 1`, `byFinishFamily.glitter.matched_wrong === 1`; `modelCalls` `[2, 3, null]` → `mean 2.5`, `median 2.5`, `samples 2`; `medianFramesNeeded` over `frames` `[3, 2, 4]` → 3; `createCardRate` with one external result `createCard: true` → 1; `modelCallsFromStatus({ metadata: { resolver: { modelCalls: 3 } } }) === 3`, missing → null
  - runner (`bottle-eval-runner.unit.test.cjs`, fake `CaptureApi`): start returning `nextFrame { surface: "bottom" }` and a sample with frames `[front, bottom, glass]` → the first frame sent is the bottom one; frame responses `glass` then `null` → exactly 2 frames sent, `promptsFollowed 2`, `adaptive true`, `check` then `status` called once each; start without `nextFrame` → all 3 frames in position order, `adaptive false`, `status` still called; a requested surface the sample lacks → the next unsent frame is sent; `check.suggestedShade` present on an external sample → `createCard: true`
- [ ] **Step 2: Run** the two test files → FAIL
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run** the suite → PASS; then for real with the host up, the flag on and the Slice 0 samples: `ADMIN_BEARER_TOKEN=dev:2 npm run eval:bottle --workspace=swatchwatch-functions -- --verbose` → the report shows model calls, frames needed and the finish-family table; run again with the flag off → `adaptive false` rows and the Slice 0 numbers
- [ ] **Step 5: README** (what the new columns mean; that the flag flips per environment once false confident matches read 0 on the eval set)
- [ ] **Step 6: Commit** `feat(functions): eval:bottle follows server prompts and reports model calls and finish families`

---

### Task 16: Branch check

**Files:**
- Modify: whatever the reviews list; `docs/superpowers/specs/2026-10-23-bottle-recognition-design.md` (add a one-line "Slice A plan: `docs/superpowers/plans/2026-10-23-bottle-flow-slice-a.md`" pointer under §5, and record the §12 calls this plan made under a "Calls made in the Slice A plan" bullet list)

- [ ] **Step 1: Run everything:** `npm run build:shared && npm run lint && npm run typecheck && npm run test` from the root → clean; `npm run test --workspace=apps/mobile` → PASS; `cd infrastructure && terraform fmt -check && terraform validate`
- [ ] **Step 2: Docs check:** run the `docs-sync-checker` subagent on `git diff dev...HEAD` and fix what it lists (CLAUDE.md Completed bullet "Bottle flow Slice A"; env tables; route tables; shared/web/mobile READMEs)
- [ ] **Step 3: Access-control check:** run the `access-control-reviewer` subagent on the same diff (capture session scoping, `captureId` on create, frame store prefix rule, candidate pools excluding other users' `user_submitted` shades); fix findings
- [ ] **Step 4: Flag-off regression:** with `BOTTLE_CAPTURE_ENABLED` unset, run `npm run test:e2e --workspace=swatchwatch-functions` against the local host → PASS (the capture e2e cases are unchanged)
- [ ] **Step 5: Commit** `chore: bottle flow slice A docs and review fixes`, open the PR against `dev` with `Closes` lines for the Slice A issue(s) and a note that the flag stays off until the eval set reads 0 false confident matches
