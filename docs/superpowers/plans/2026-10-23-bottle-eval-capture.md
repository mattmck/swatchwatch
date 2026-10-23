# Bottle Eval Capture (Slice 0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin console tab where the owner labels a bottle, shoots its front, bottom, glass and box with the Rapid Add camera, and saves the photos as a private eval sample; plus an `eval:bottle` runner that replays every sample through the live capture API and scores the answers.

**Architecture:** Two new tables (`bottle_eval_sample`, `bottle_eval_frame`) hang off `image_asset` rows stored in the existing private user-media container under `{adminUserId}/bottle-eval/…`, uploaded one frame at a time through admin-only routes in a new `bottle-eval-admin.ts` function, re-encoded with the nail-photo sanitizer and served back only as owner-scoped `v3` image URLs. The web tab is a small state machine (label → shots → saved) over the existing `CameraCapture` component. The eval runner reads samples from Postgres, pulls frame bytes from blob storage and drives `capture/start → frame → check` against a running host, so today's text-only resolver gets a baseline before Slice A changes it.

**Tech Stack:** Azure Functions v4 (Node 22, TS), node-pg-migrate SQL, sharp (via `lib/nail-photo-image`), Next.js 16 client components, shadcn/ui, node:test.

**Spec:** `docs/superpowers/specs/2026-10-23-bottle-recognition-design.md` (§8 Slice 0; §9 privacy)

**Deviation from the spec, decided here:** §8.1 says a separate `BOTTLE_EVAL_CONTAINER`. This plan stores eval frames in `USER_MEDIA_CONTAINER` under the `{adminUserId}/bottle-eval/` prefix instead. Reason: the tab needs thumbnails, and the owner-scoped `v3` proxy already serves that container to its owner only; a separate container would need a new serving path, a Terraform container, a backup policy and a sweep rule for no privacy gain. The frames are linked by a foreign key (`bottle_eval_frame.image_id`), so the orphan-media sweep never touches them. The spec is updated in the same commit as this plan.

## Global Constraints

- Every new route is `withAdmin` (`packages/functions/src/lib/auth.ts`); every SQL statement is parameterized and, where a sample is addressed, bound to `created_by_user_id = <caller>` for frame URLs.
- Uploads go through `parseNailPhotoDataUrl` + `normalizeNailPhoto` (`lib/nail-photo-image.ts`): EXIF/GPS stripped, JPEG, longest edge `NAIL_PHOTO_MAX_EDGE` (2048), limit `NAIL_PHOTO_MAX_UPLOAD_BYTES` (8 MB), body read with `readBodyCapped` capped at `MAX_PHOTO_REQUEST_BODY_BYTES`.
- Responses never carry raw blob URLs or public `v2` ids for eval frames; only `v3` ids minted for the caller when `owner_id = caller`, else `null`. Responses are `Cache-Control: private, no-store`.
- Migrations: new file sorts after `20261023021845964_add-approved-indie-shopify-sources.sql`; `-- Up Migration` / `-- Down Migration`, `BEGIN; … COMMIT;`, idempotent; `docs/schema.sql` updated in the same task.
- Shared types live in `packages/shared/src/types/` and are re-exported from `packages/shared/src/index.ts`.
- Web: client components under `apps/web/src/app/(admin)/admin/reference-data/components/`, API calls in `apps/web/src/lib/api.ts`, pure logic in `apps/web/src/lib/*.ts` with `*.test.ts` beside it (`tsx --test`).
- Functions tests: `packages/functions/tests/*.unit.test.cjs`, `node --test`, no database (require interception as in `tests/admin-users.unit.test.cjs`).
- Nothing in this slice changes the capture API, the resolver, or any user-facing route.
- Docs rows per CLAUDE.md "Documentation Maintenance" are part of the task that adds the thing.
- Commits: Conventional Commits, each ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. **A second sample for the same shade** (the owner re-shoots a bottle in different light): must be accepted and listed as its own row, never merged or rejected. Pinned in Task 3.
2. **A non-admin, or another admin, hitting the routes:** a user gets 403 before any body is read; another admin sees the sample but every `imageUrl` is `null`. Pinned in Task 3.
3. **An undecodable or HEIC-only upload:** the frame route answers 415 and the sample keeps its other frames; nothing is stored for the bad frame. Pinned in Task 3.
4. **Delete when a blob is already gone or storage is down:** the rows are deleted, the missing blob is logged, the response is still 204. Pinned in Task 3.
5. **Eval run against an unreachable host or a sample with no frames:** the runner exits non-zero with a clear message before any report is written; a frameless sample is skipped and counted, not crashed on. Pinned in Task 6.

---

### Task 1: Shared types and validation

**Files:**
- Create: `packages/shared/src/types/bottle-eval.ts`
- Create: `packages/shared/src/types/bottle-eval.test.ts`
- Modify: `packages/shared/src/index.ts` (add `export * from "./types/bottle-eval";` after the `nail-photo` line)
- Modify: `packages/shared/README.md` (type catalog row)

**Interfaces:**
- Produces:
  ```ts
  export const BOTTLE_SURFACES = ["front", "bottom", "glass", "box"] as const;
  export type BottleSurface = (typeof BOTTLE_SURFACES)[number];
  /** Frame type the capture API gets for each surface (front/bottom/box → label, glass → color). */
  export const BOTTLE_SURFACE_FRAME_TYPE: Record<BottleSurface, CaptureFrameType>;
  export const BOTTLE_EVAL_MAX_FRAMES = 12;
  export const BOTTLE_EVAL_MAX_TEXT_LENGTH = 200;   // brandText, shadeText
  export const BOTTLE_EVAL_MAX_NOTES_LENGTH = 1000;

  export interface BottleEvalSampleRequest {       // POST /api/bottle-eval-admin/samples
    shadeId?: string;                              // catalog shade, or
    brandText?: string; shadeText?: string;        // not in catalog (both required then)
    notes?: string;
  }
  export interface BottleEvalFrameRequest {        // POST …/samples/{id}/frames
    surface: BottleSurface;
    image: string;                                 // data:<type>;base64,…
  }
  export interface BottleEvalFrame {
    frameId: string; surface: BottleSurface; frameType: CaptureFrameType;
    imageUrl: string | null;                       // owner-scoped v3 URL, null for non-owners
    width: number | null; height: number | null; sizeBytes: number | null; createdAt: string;
  }
  export interface BottleEvalSample {
    sampleId: string;
    shadeId: string | null; brand: string; shadeName: string; inCatalog: boolean;
    notes: string | null; frames: BottleEvalFrame[];
    createdByUserId: string; createdAt: string;
  }
  export interface BottleEvalSampleResponse { sample: BottleEvalSample }
  export interface BottleEvalSampleListResponse { samples: BottleEvalSample[]; total: number; nextCursor: string | null }

  export type BottleEvalSampleInput =
    | { kind: "catalog"; shadeId: string; notes: string | null }
    | { kind: "external"; brandText: string; shadeText: string; notes: string | null };
  /** Pure: trims, enforces lengths and the shadeId-xor-text rule. Throws `BottleEvalValidationError(message)`. */
  export function validateBottleEvalSampleInput(body: unknown): BottleEvalSampleInput;
  export function parseBottleSurface(value: unknown): BottleSurface | null;
  export class BottleEvalValidationError extends Error {}
  ```

- [ ] **Step 1: Write the failing tests** in `bottle-eval.test.ts` (node:test, `assert/strict`):
  - `validateBottleEvalSampleInput({ shadeId: " 42 " })` → `{ kind: "catalog", shadeId: "42", notes: null }`
  - `validateBottleEvalSampleInput({ brandText: "Loud Lacquer", shadeText: "Howl", notes: "x" })` → `{ kind: "external", … }`
  - throws `BottleEvalValidationError` for: `{}`; `{ shadeId: "42", brandText: "a", shadeText: "b" }`; `{ shadeId: "abc" }`; `{ brandText: "a" }` (missing shadeText); brandText of 201 chars; notes of 1001 chars; `null`; `"string"`
  - `parseBottleSurface("glass")` → `"glass"`; `"GLASS"`, `"cap"`, `1`, `null` → `null`
  - `BOTTLE_SURFACE_FRAME_TYPE` equals `{ front: "label", bottom: "label", glass: "color", box: "label" }`
- [ ] **Step 2: Run** `npm run test --workspace=swatchwatch-shared` → FAIL (module not found)
- [ ] **Step 3: Implement** `bottle-eval.ts` with the interfaces above; add the index export
- [ ] **Step 4: Run** `npm run test --workspace=swatchwatch-shared` → PASS; `npm run build:shared` → clean
- [ ] **Step 5: README row** in `packages/shared/README.md` type catalog: `bottle-eval.ts` — surfaces, sample/frame request and response types, `validateBottleEvalSampleInput`
- [ ] **Step 6: Commit** `feat(shared): bottle eval sample types and validation`

---

### Task 2: Migration and schema

**Files:**
- Create: `packages/functions/migrations/<UTC timestamp>_bottle-eval-samples.sql` (generate with `npm run migrate:create --workspace=swatchwatch-functions -- bottle-eval-samples`; confirm it sorts last)
- Modify: `docs/schema.sql` (new block directly after `color_training_sample`, same comment style)

**Interfaces:**
- Produces the tables every later task queries:
  ```sql
  CREATE TABLE IF NOT EXISTS bottle_eval_sample (
    sample_id          BIGSERIAL PRIMARY KEY,
    shade_id           BIGINT REFERENCES shade(shade_id) ON DELETE SET NULL,  -- NULL = not in catalog
    brand_text         TEXT,                     -- typed when not in catalog (and kept as a snapshot otherwise)
    shade_text         TEXT,
    notes              TEXT,
    created_by_user_id BIGINT NOT NULL REFERENCES app_user(user_id) ON DELETE CASCADE,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT bottle_eval_sample_label CHECK (shade_id IS NOT NULL OR (brand_text IS NOT NULL AND shade_text IS NOT NULL))
  );
  CREATE TABLE IF NOT EXISTS bottle_eval_frame (
    frame_id     BIGSERIAL PRIMARY KEY,
    sample_id    BIGINT NOT NULL REFERENCES bottle_eval_sample(sample_id) ON DELETE CASCADE,
    image_id     BIGINT NOT NULL UNIQUE REFERENCES image_asset(image_id) ON DELETE CASCADE,
    surface      TEXT NOT NULL CHECK (surface IN ('front','bottom','glass','box')),
    frame_type   TEXT NOT NULL CHECK (frame_type IN ('barcode','label','color','other')),
    position     SMALLINT NOT NULL,              -- shooting order within the sample
    content_type TEXT NOT NULL,
    width        INTEGER, height INTEGER, size_bytes INTEGER,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_bottle_eval_frame_sample ON bottle_eval_frame (sample_id, position);
  CREATE INDEX IF NOT EXISTS idx_bottle_eval_sample_created ON bottle_eval_sample (created_at DESC, sample_id DESC);
  ```
  Down drops the two tables (frame first). The FK on `image_id` is what keeps the orphan-media sweep (`pg_constraint` discovery) away from eval frames.

- [ ] **Step 1: Generate the file**, write Up/Down in the house style, leading comment pointing at spec §8.1 and this plan
- [ ] **Step 2: Apply up → down → up** against the local DB (`npm run dev:infra` first):
  `npm run migrate --workspace=swatchwatch-functions && npm run migrate:down --workspace=swatchwatch-functions && npm run migrate --workspace=swatchwatch-functions` → each prints the migration name, no errors
- [ ] **Step 3: Update `docs/schema.sql`** with the same DDL and a comment: "Admin bottle-eval samples (spec docs/superpowers/specs/2026-10-23-bottle-recognition-design.md §8): private frames in USER_MEDIA_CONTAINER under `{userId}/bottle-eval/`; never read by the live resolver."
- [ ] **Step 4: Run** `npm run test --workspace=swatchwatch-functions` → PASS (nothing uses the tables yet; proves the build)
- [ ] **Step 5: Commit** `feat(functions): bottle eval sample tables`

---

### Task 3: Admin routes

**Files:**
- Create: `packages/functions/src/lib/bottle-eval.ts` (pure helpers + SQL text)
- Create: `packages/functions/src/functions/bottle-eval-admin.ts` (routes)
- Create: `packages/functions/tests/bottle-eval-admin.unit.test.cjs`
- Modify: `packages/functions/src/index.ts` (import the new function module where the others are imported)
- Modify: `packages/functions/README.md` (route table rows + a short "Bottle eval samples" subsection under the admin sections, after "Product categories")

**Interfaces:**
- Consumes: Task 1 types; `withAdmin(handler(request, context, adminUserId))`; `readBodyCapped`, `MAX_PHOTO_REQUEST_BODY_BYTES` (`lib/nail-photo-upload.ts`); `parseNailPhotoDataUrl`, `normalizeNailPhoto`, `NailPhotoInputError` (`lib/nail-photo-image.ts`); `uploadBytesToBlob`, `userMediaContainer`, `deleteBlobFromStorageUrl` (`lib/blob-storage.ts`); `toImageProxyUrl(request.url, storageUrl, { scope: "private", ownerUserId })` (`lib/image-proxy.ts`, same options the nail-photo route passes); `query`, `transaction` (`lib/db.ts`); `trackEvent`.
- Produces (lib, all pure except the two `async`):
  ```ts
  export const BOTTLE_EVAL_PAGE_SIZE = 25;            // list page, max 100
  export function bottleEvalBlobName(adminUserId: number, sampleId: number): string; // `${adminUserId}/bottle-eval/${sampleId}/${randomUUID()}.jpg`
  export function isBottleEvalStorageUrl(storageUrl: string, adminUserId: number): boolean; // under that prefix in userMediaContainer()
  export interface ParsedFrameBody { surface: BottleSurface; image: string }
  /** `{ image, surface }`; 400 on a bad surface, same 411/413 rules as readPhotoUploadBody. */
  export async function readBottleEvalFrameBody(request: HttpRequest): Promise<ParsedFrameBody>;
  export function parseListQuery(url: URL): { after: number | null; limit: number };  // limit clamped 1–100
  export interface SampleRow { sampleId: string; shadeId: string | null; brand: string; shadeName: string; notes: string | null; createdByUserId: string; createdAt: string | Date }
  export interface FrameRow { frameId: string; sampleId: string; surface: BottleSurface; frameType: CaptureFrameType; storageUrl: string; ownerId: string; width: number | null; height: number | null; sizeBytes: number | null; createdAt: string | Date }
  /** Rows → BottleEvalSample[] (frames grouped by sampleId, in input order); `mint` returns null for frames the caller does not own. */
  export function toBottleEvalSamples(rows: SampleRow[], frames: FrameRow[], mint: (storageUrl: string, ownerId: number) => string | null): BottleEvalSample[];
  ```
- Routes (all `withCors(withAdmin(…))`, `authLevel: "anonymous"`):
  | Name | Method | Route | Behavior |
  |---|---|---|---|
  | `bottle-eval-admin-samples` | GET | `bottle-eval-admin/samples` | keyset list newest first (`?after=<sampleId>&limit=`), frames in `position` order, `total` = count of all samples; brand/name from `shade`+`brand` for catalog samples, from `brand_text`/`shade_text` otherwise |
  | same | POST | `bottle-eval-admin/samples` | body `BottleEvalSampleRequest` → 201 `{ sample }` with `frames: []`; catalog `shadeId` must exist and not be `merged` (404 otherwise); `brand_text`/`shade_text` are also filled with the catalog names as a snapshot |
  | `bottle-eval-admin-sample` | DELETE | `bottle-eval-admin/samples/{id}` | 204 (idempotent): in one transaction read the frames' storage URLs and delete the sample (cascade); after commit delete each blob with `allowedContainers: [userMediaContainer()]`, best effort (log + `bottle_eval.blob_delete_failed`) |
  | `bottle-eval-admin-frames` | POST | `bottle-eval-admin/samples/{id}/frames` | body `BottleEvalFrameRequest` → 201 `{ sample }` (whole sample, updated); 404 unknown sample; 409 when the sample already has `BOTTLE_EVAL_MAX_FRAMES`; 415/413 from the sanitizer; blob first (`uploadBytesToBlob`, container `userMediaContainer()`, name `bottleEvalBlobName`), then `image_asset` (`owner_type 'user'`, `owner_id` = caller, `copyright_status 'user_uploaded'`, `captured_at now()`) + `bottle_eval_frame` (`position` = max+1) in one transaction under `SELECT … FOR UPDATE` of the sample; a failed DB write deletes the uploaded blob |
  | `bottle-eval-admin-frame` | DELETE | `bottle-eval-admin/samples/{id}/frames/{frameId}` | 204 (idempotent); deletes `bottle_eval_frame` and its `image_asset` row, then the blob best effort |
  Any admin may list, create and delete any sample (it is shared ground truth); only the frame's `owner_id` gets a non-null `imageUrl`. 503 `{ error: "Photo storage is not configured" }` when `AZURE_STORAGE_CONNECTION` is unset, before any decode.

- [ ] **Step 1: Write the failing tests** (require interception as in `tests/admin-users.unit.test.cjs`: mock `@azure/functions` to capture routes, mock `../lib/db`, mock `../lib/blob-storage` with `uploadBytesToBlob`/`deleteBlobFromStorageUrl` recorders and `userMediaContainer: () => "nail-photos"`, mock `../lib/nail-photo-image` to return a fixed 10×10 JPEG for a valid data URL and throw `NailPhotoInputError(…, 415)` for `data:image/heic;…`; set `process.env.AZURE_STORAGE_CONNECTION` to a dummy value):
  - `registers all four routes with withAdmin` — a request whose role is `user` gets 403 on each route and the db mock records zero statements (Review Focus 2)
  - `POST samples creates a catalog sample` — db mock answers the shade lookup with `{ shadeId: 42, brand: "Holo Taco", shadeName: "Unicorn Skin", merged: false }`, INSERT returns `sample_id 7`; response 201, `sample.inCatalog === true`, `sample.frames` empty, INSERT params include `[42, "Holo Taco", "Unicorn Skin", null, ADMIN]`
  - `POST samples twice for the same shade creates two rows` — two calls, two INSERTs, both 201 (Review Focus 1)
  - `POST samples rejects a merged or unknown shade with 404` and `rejects a body with both shadeId and text with 400`
  - `POST frames stores blob then rows` — order of calls: `uploadBytesToBlob` (container `nail-photos`, blobName matches `/^5\/bottle-eval\/7\/[0-9a-f-]{36}\.jpg$/` for admin 5, sample 7) → transaction with `INSERT INTO image_asset` (`owner_type 'user'`, owner 5) → `INSERT INTO bottle_eval_frame` (surface `glass`, frame_type `color`, position 1); response 201 with one frame whose `imageUrl` starts with `/api/images/v3.` (or the absolute form the mint helper yields)
  - `POST frames with a HEIC body answers 415 and stores nothing` (Review Focus 3)
  - `POST frames at the cap answers 409` — db says the sample has 12 frames
  - `GET samples hides other admins' frame urls` — frames owned by admin 9, caller is 5 → `imageUrl === null`, sample still listed (Review Focus 2)
  - `DELETE sample answers 204 and tolerates a failing blob delete` — `deleteBlobFromStorageUrl` rejects; rows deleted (the DELETE statement ran), response 204 (Review Focus 4)
  - `without AZURE_STORAGE_CONNECTION POST frames answers 503 before decoding` — the nail-photo-image mock is not called
- [ ] **Step 2: Run** `npm run test --workspace=swatchwatch-functions -- tests/bottle-eval-admin.unit.test.cjs` → FAIL (module not found)
- [ ] **Step 3: Implement** `lib/bottle-eval.ts` then `functions/bottle-eval-admin.ts`; register the import in `src/index.ts`
- [ ] **Step 4: Run** the test file → PASS; then the whole suite `npm run test --workspace=swatchwatch-functions` → PASS (the access-control test's route inventory, if it enumerates files, needs the new module listed as admin-only)
- [ ] **Step 5: Manual check** against the local host: `func start` running, `curl -X POST -H "Authorization: Bearer dev:2" -H "Content-Type: application/json" -d '{"brandText":"Test","shadeText":"One"}' http://localhost:7071/api/bottle-eval-admin/samples` → 201 JSON; `Bearer dev:1` → 403
- [ ] **Step 6: README** route rows (five lines in the admin block of the route table, status "✅ Live (admin-only)") and the subsection: storage path, sanitizer, owner-only `v3` URLs, FK keeps the sweep away, "never read by the live resolver"
- [ ] **Step 7: Commit** `feat(functions): admin bottle eval sample routes`

---

### Task 4: Web API client and tab state

**Files:**
- Modify: `apps/web/src/lib/api.ts` (four functions after the hex-label block)
- Create: `apps/web/src/lib/bottle-eval.ts`
- Create: `apps/web/src/lib/bottle-eval.test.ts`
- Modify: `apps/web/src/lib/admin-tabs.ts` (`"bottle-eval"` appended to `ADMIN_TABS`)

**Interfaces:**
- Consumes: Task 1 types; `API_BASE_URL`, `getAuthHeaders`, `handleResponse` (`api.ts`); `CaptureFrameType`.
- Produces (api.ts):
  ```ts
  export async function listBottleEvalSamples(params?: { after?: string; limit?: number }): Promise<BottleEvalSampleListResponse>;
  export async function createBottleEvalSample(body: BottleEvalSampleRequest): Promise<BottleEvalSampleResponse>;   // POST, 201
  export async function addBottleEvalFrame(sampleId: string, body: BottleEvalFrameRequest): Promise<BottleEvalSampleResponse>;
  export async function deleteBottleEvalSample(sampleId: string): Promise<void>;
  export async function deleteBottleEvalFrame(sampleId: string, frameId: string): Promise<void>;   // DELETE answers 204; the tab drops the frame locally
  ```
- Produces (`lib/bottle-eval.ts`, pure):
  ```ts
  export type BottleEvalLabel = { kind: "catalog"; shadeId: string; brand: string; shadeName: string } | { kind: "external"; brandText: string; shadeText: string };
  /** Shooting order and prompts shown in the tab; box is optional. */
  export const BOTTLE_EVAL_SHOTS: readonly { surface: BottleSurface; prompt: string; optional: boolean }[] = [
    { surface: "front",  prompt: "Show the front of the bottle", optional: false },
    { surface: "bottom", prompt: "Now the bottom",                optional: false },
    { surface: "glass",  prompt: "Turn it so we see the color",  optional: false },
    { surface: "box",    prompt: "Have the box? Show the barcode", optional: true },
  ];
  export interface ShotEntry { localId: string; surface: BottleSurface; dataUrl: string; status: "uploading" | "uploaded" | "failed"; frameId?: string; error?: string }
  export interface BottleEvalSessionState { phase: "label" | "shooting" | "saved"; label: BottleEvalLabel | null; sampleId: string | null; shots: ShotEntry[]; notes: string }
  export const INITIAL_BOTTLE_EVAL_STATE: BottleEvalSessionState;
  export type BottleEvalAction =
    | { type: "label_chosen"; label: BottleEvalLabel }
    | { type: "sample_created"; sampleId: string }
    | { type: "shot_added"; shot: Pick<ShotEntry, "localId" | "surface" | "dataUrl"> }
    | { type: "shot_uploaded"; localId: string; frameId: string }
    | { type: "shot_failed"; localId: string; error: string }
    | { type: "shot_removed"; localId: string }
    | { type: "notes_changed"; notes: string }
    | { type: "finished" }
    | { type: "reset" };
  export function bottleEvalReducer(state: BottleEvalSessionState, action: BottleEvalAction): BottleEvalSessionState;
  /** First shot in BOTTLE_EVAL_SHOTS with no uploaded/uploading entry; null when every non-optional one is done and box is done or skipped. */
  export function nextShot(state: BottleEvalSessionState, skipped: ReadonlySet<BottleSurface>): (typeof BOTTLE_EVAL_SHOTS)[number] | null;
  export function canFinish(state: BottleEvalSessionState): boolean;   // sampleId set, ≥1 uploaded, none uploading
  export function frameTypeForSurface(surface: BottleSurface): CaptureFrameType;  // BOTTLE_SURFACE_FRAME_TYPE
  ```

- [ ] **Step 1: Write the failing tests** in `bottle-eval.test.ts`:
  - `nextShot` on a fresh shooting state → `front`; after front and bottom uploaded → `glass`; after glass → `box`; with `box` skipped → `null`; with all four uploaded → `null`
  - `shot_added` past `BOTTLE_EVAL_MAX_FRAMES` (12) is ignored (state unchanged)
  - `shot_removed` only removes a `failed` entry (an uploaded one stays, since it is on the server)
  - `canFinish`: false while any shot is `uploading`, false with zero uploaded, true with one uploaded and `sampleId`
  - `finished` moves to `saved`; `reset` returns `INITIAL_BOTTLE_EVAL_STATE`
  - `frameTypeForSurface("glass") === "color"`, `("box") === "label"`
  - `getTabFromQuery("bottle-eval") === "bottle-eval"` (import from `admin-tabs`)
- [ ] **Step 2: Run** `npm run test --workspace=swatchwatch-web` → FAIL
- [ ] **Step 3: Implement** `lib/bottle-eval.ts`, the `admin-tabs.ts` entry, the four `api.ts` functions (POST/DELETE with `getAuthHeaders()`, JSON bodies, `handleResponse`; `deleteBottleEvalSample` resolves on 204)
- [ ] **Step 4: Run** `npm run test --workspace=swatchwatch-web` → PASS; `npm run typecheck --workspace=swatchwatch-web` → clean
- [ ] **Step 5: Commit** `feat(web): bottle eval api client and tab state`

---

### Task 5: Admin tab UI

**Files:**
- Create: `apps/web/src/app/(admin)/admin/reference-data/components/bottle-eval-tab.tsx`
- Modify: `apps/web/src/app/(admin)/admin/page.tsx` (trigger "Bottle Eval" after Hex Labeling; `<TabsPrimitive.Content value="bottle-eval">`)
- Modify: `apps/web/src/components/rapid-add/camera-capture.tsx` (new optional prop `hideFrameTypeOptions?: boolean`, default false; when true the Label/Barcode/Color chips are not rendered)
- Modify: `apps/web/README.md` (route tree line for `/admin` tab list, the `bottle-eval-tab.tsx` line under components, and a short "Admin Bottle Eval tab" section after "Admin Hex Labeling tab")
- Modify: `CLAUDE.md` (`/admin` row: add "Bottle Eval"; a bullet in Completed)

**Interfaces:**
- Consumes: Task 4 state and API functions; `CameraCapture` (`scanBarcodes={false}`, `captureDisabled`, `frameType={frameTypeForSurface(current.surface)}`, `onFrameTypeChange={() => {}}`, `hideFrameTypeOptions`, `onCapture`); `captureFrameFromFile` is already inside `CameraCapture`'s upload fallback; `FrameStrip` (`frames`, `onRetry`, `onRemove`) for the shot thumbnails (map `ShotEntry` to its `CaptureFrameEntry` shape: `frameType` from the surface, `quality: {}`); `searchCatalog(q, 8)`; `PrivateImage` for saved-sample thumbnails; `toast` from `sonner`; shadcn `Button`, `Input`, `Card`.
- Behavior to build (the layout is the builder's, within the admin console's patterns):
  1. **Label step:** a search box over `searchCatalog` (300 ms debounce, 8 results: brand, name, finishes), click → `label_chosen`; or a "Not in catalog" toggle revealing brand + shade inputs and a Continue button. Choosing a label calls `createBottleEvalSample` at once and dispatches `sample_created` (toast on failure, stay on the label step).
  2. **Shooting step:** header shows the label and the current prompt from `nextShot`; `CameraCapture` with the frame type for the current surface; each capture dispatches `shot_added` and calls `addBottleEvalFrame` (dispatch `shot_uploaded` / `shot_failed`); "Can't see it" adds the surface to the local `skipped` set; extra shots of any surface are allowed via four small surface chips below the prompt (they set the current surface by hand); the notes field lives on the label step (there is no notes-update route; notes travel with `createBottleEvalSample`); "Finish" enabled by `canFinish` → `finished`; "Discard" calls `deleteBottleEvalSample` then `reset`.
  3. **Saved step:** "Saved N frames for <brand> <shade>" and a "Shoot another" button (`reset`).
  4. **Recent samples list** under the capture card: `listBottleEvalSamples` (25 newest, "Load more" with `after`), each row with brand, shade, "not in catalog" badge, frame thumbnails (`PrivateImage`, 64 px, surface letter overlay; `imageUrl === null` renders a grey placeholder "another admin's photo"), created date, and a Delete button with `window.confirm`. Refreshes after Finish and Delete.
  - Telemetry (`trackEvent` from `@/lib/telemetry`): `bottle_eval.sample_created` ({ inCatalog }), `bottle_eval.frame_added` ({ surface }), `bottle_eval.sample_deleted`.
- [ ] **Step 1: Add `hideFrameTypeOptions`** to `CameraCapture` and run `npm run typecheck --workspace=swatchwatch-web` → clean (the Rapid Add page is unchanged)
- [ ] **Step 2: Build the tab** and register it in `admin-tabs.ts` (done in Task 4) and `page.tsx`
- [ ] **Step 3: Run** `npm run lint --workspace=swatchwatch-web && npm run typecheck --workspace=swatchwatch-web` → clean
- [ ] **Step 4: Verify in the browser** (`npm run dev` with dev bypass admin user 2): open `/admin?tab=bottle-eval`; pick a catalog shade, shoot three frames from the photo-upload fallback (any JPEGs), Finish; the sample appears in the list with three thumbnails; reload the page: thumbnails still render (v3 fetch); Delete removes it. Switch `NEXT_PUBLIC_AUTH_DEV_ADMIN_USER_ID` to another admin id (or sign in as one) and confirm the sample is listed with placeholders instead of photos.
- [ ] **Step 5: Docs** (README tree line, component line, section; CLAUDE.md row and Completed bullet)
- [ ] **Step 6: Commit** `feat(web): admin bottle eval capture tab`

---

### Task 6: Eval runner

**Files:**
- Create: `packages/functions/src/eval/bottle/types.ts`, `samples.ts`, `api-client.ts`, `scoring.ts`, `report.ts`, `cli.ts`
- Create: `packages/functions/tests/bottle-eval-scoring.unit.test.cjs`
- Modify: `packages/functions/package.json` (`"eval:bottle": "npm run build --workspace=swatchwatch-shared && npm run build && node dist/eval/bottle/cli.js"`)
- Modify: `packages/functions/.gitignore` or the root `.gitignore` (wherever `eval/hex/results` is ignored: add `eval/bottle/results`)
- Modify: `packages/functions/README.md` (a "Bottle recognition eval" subsection after "Hex detection evaluation harness"; env table rows under "Admin scripts" noting `eval:bottle` reads `API_BASE_URL`, `ADMIN_BEARER_TOKEN`, `PG*`, `AZURE_STORAGE_CONNECTION`), `CLAUDE.md` Dev Commands line, root `README.md` if it lists eval commands

**Interfaces:**
- Consumes: `loadLocalSettings`, `FUNCTIONS_ROOT` (`eval/hex/env.ts`); `query`, `closePool` (`lib/db.ts`); `readBlobFromStorageUrl(url, { allowedContainers: [userMediaContainer()] })`; the capture API over HTTP (`POST /api/capture/start`, `POST /api/capture/{id}/frame` with `{ imageBlobUrl: "data:image/jpeg;base64,…", frameType, quality: { surface } }`, `POST /api/capture/{id}/check`); shared `CaptureCheckResponse`.
- Produces:
  ```ts
  // types.ts
  export interface EvalSample { sampleId: number; shadeId: number | null; brand: string; shadeName: string; frames: { frameId: number; surface: BottleSurface; frameType: CaptureFrameType; storageUrl: string }[] }
  export type Outcome = "matched_correct" | "matched_wrong" | "asked_has_correct" | "asked_no_correct" | "unmatched" | "rejected_correct" | "skipped_no_frames" | "error";
  export interface SampleResult { sampleId: number; brand: string; shadeName: string; inCatalog: boolean; outcome: Outcome; status: string; topEntityId: number | null; candidateIds: number[]; frames: number; ms: number; error?: string }
  export interface EvalSummary { samples: number; byOutcome: Record<Outcome, number>; matchRate: number; askRate: number; falseConfident: number; medianMs: number; byBrand: Record<string, Record<Outcome, number>> }
  // samples.ts
  export async function loadEvalSamples(opts: { limit: number | null; only: string | null }): Promise<EvalSample[]>;   // newest first, frames by position
  // api-client.ts
  export interface CaptureApi { start(meta: Record<string, unknown>): Promise<string>; frame(id: string, body: { imageBlobUrl: string; frameType: CaptureFrameType; quality: Record<string, unknown> }): Promise<void>; check(id: string): Promise<CaptureCheckResponse> }
  export function createCaptureApi(baseUrl: string, bearer: string): CaptureApi;    // throws EvalConfigError when either is empty
  export async function assertApiReachable(api: CaptureApi): Promise<void>;         // GET `${baseUrl}/reference/finishes` 200, else throws with the URL
  // scoring.ts (pure)
  export function classifyOutcome(sample: Pick<EvalSample, "shadeId">, check: Pick<CaptureCheckResponse, "status" | "entityId" | "candidates">): Outcome;
  export function summarize(results: SampleResult[]): EvalSummary;
  // report.ts
  export function formatSummary(summary: EvalSummary, results: SampleResult[], verbose: boolean): string;
  export function writeReportJson(dir: string, summary: EvalSummary, results: SampleResult[]): string;  // path written, `bottle-<ISO>.json`
  ```
  Not measured in this slice: model calls per bottle and the per-finish-family split (both need the resolver audit that Slice A adds to `metadata.resolver`; the runner records `frames` and `ms` now and gains those columns then).
  `classifyOutcome` rules: catalog sample + `matched` + `entityId === shadeId` → `matched_correct`; catalog + `matched` + other id → `matched_wrong`; catalog + `needs_question` + shadeId among `candidates[].entityId` → `asked_has_correct`, else `asked_no_correct`; catalog + `unmatched` → `unmatched`; external sample (`shadeId === null`) + `matched` → `matched_wrong`; external + `needs_question`/`unmatched` → `rejected_correct`. `falseConfident` = count of `matched_wrong`. `matchRate` = `matched_correct / catalog samples`; `askRate` = asked outcomes / catalog samples.
  CLI: `--limit <n>`, `--only <text>` (brand or shade substring), `--verbose`, `--results-dir`, `--help`; prints the summary table (outcome counts, rates, median ms, per brand) and the JSON path; exit code 1 on config/reachability errors or any `error` outcome, 0 otherwise. Each session is started with metadata `{ source: "bottle-eval", sampleId }` so the rows are recognizable; `check` is read-only, so nothing is added to the admin's collection.

- [ ] **Step 1: Write the failing tests** in `bottle-eval-scoring.unit.test.cjs` (requires `dist/eval/bottle/scoring.js`):
  - the six `classifyOutcome` rules above, one assertion each, plus `skipped_no_frames` is never produced by `classifyOutcome` (it is set by the CLI for frameless samples)
  - `summarize` over four results (2 `matched_correct`, 1 `matched_wrong`, 1 `rejected_correct` external) → `matchRate 2/3`, `falseConfident 1`, `byBrand` keyed by brand
  - `summarize([])` → zero rates, no division error
- [ ] **Step 2: Run** `npm run test --workspace=swatchwatch-functions -- tests/bottle-eval-scoring.unit.test.cjs` → FAIL
- [ ] **Step 3: Implement** the six modules and the script; frames are sent as `data:` URLs (`readBlobFromStorageUrl` → base64) in `position` order; a sample with zero frames is recorded as `skipped_no_frames` without any API call (Review Focus 5)
- [ ] **Step 4: Run** the scoring test → PASS; full suite → PASS
- [ ] **Step 5: Run it for real** with the host up and at least one sample from Task 5: `API_BASE_URL=http://localhost:7071/api ADMIN_BEARER_TOKEN=dev:2 npm run eval:bottle --workspace=swatchwatch-functions -- --verbose` → a table with one row and a JSON path; then with the host stopped → exit 1 and a message naming the URL, no JSON written (Review Focus 5)
- [ ] **Step 6: Docs** (README subsection with the command, what the outcomes mean, that today's numbers are the Slice A baseline; CLAUDE.md Dev Commands line; `.gitignore` entry)
- [ ] **Step 7: Commit** `feat(functions): bottle recognition eval runner`

---

### Task 7: Spec sync and branch check

**Files:**
- Modify: `docs/superpowers/specs/2026-10-23-bottle-recognition-design.md` §8.1 (storage sentence: user-media container under `{adminUserId}/bottle-eval/`, FK-linked, owner-scoped `v3` thumbnails; drop `BOTTLE_EVAL_CONTAINER`) — if this plan's commit already made the edit, verify only.

- [ ] **Step 1: Run everything:** `npm run lint && npm run typecheck && npm run test` from the root → all clean
- [ ] **Step 2: Docs check:** run the `docs-sync-checker` subagent on `git diff dev...HEAD` and fix anything it lists
- [ ] **Step 3: Access-control check:** run the `access-control-reviewer` subagent on the same diff; fix findings
- [ ] **Step 4: Commit** any fixes `chore: bottle eval docs and review fixes`
