# Bottle recognition: label first, then turn it

Date: 2026-10-23
Status: draft for review
Scope: web Rapid Add (`/rapid-add`), Expo Add tab, capture API, ingestion, Terraform

## 1. Intent

Someone holds a nail polish bottle up to the camera, shows the front, turns it to the
bottom, then shows the glass, and SwatchWatch says what it is and whether they own it.
Today's Rapid Add only works when a barcode scans or the front label reads cleanly. Owner's
framing: *"some of the labels are hard to see on the bottles"*, so an unreadable label is the
normal case, not the edge case.

What identifies a bottle, in the owner's words:

- The vendor's logo and typography on the bottle and the box say the **brand**.
- The **bottom** of the bottle usually carries a sticker with the **shade name**, less often
  a barcode, sometimes the vendor name.
- The **box**, when there is one, has the barcode, ingredient claims (10-free, 8-free) and
  the vendor typography.
- The actual **color** is rarely printed anywhere. The lacquer seen through the glass is
  the evidence.

So the problem is brand first, then shade within brand, with each surface narrowing the
next step. The catalog's own product images (2,095 in dev, 415 of 484 color shades have at
least one) identify the brand from a front frame and confirm a final pick.

## 2. Goals, non-goals, anti-goals

**Goals**

1. A hand-held bottle with a worn or tiny label resolves to brand + shade in one guided
   sequence of three frames (front, bottom, glass), plus an optional box frame.
2. **Batch mode:** a sticky brand hint ("I'm going through my Loud polishes") persists
   across bottles until the user says Done, and makes every bottle a closed question.
3. When the shade is not in the catalog, the verdict card is prefilled from what was read
   (brand, sticker name, glass color, finish) and **one tap** adds it as the user's private
   shade. No stop-and-ask.
4. Ships on **web and mobile together**, sharing the pure flow logic in `packages/shared`.
5. The server **drives the prompts**: after each frame it says what it still needs
   ("show the bottom", "tilt it toward the light"), so the sequence adapts to what has
   been learned instead of a fixed order.
6. Four pieces that each ship alone: (0) an admin capture tab that builds the eval set,
   (A) surfaces + color evidence + brand-first resolver + batch mode, (B) catalog
   confirm, (C) visual retrieval with embeddings.

**Non-goals**

- Ingredient / INCI capture from the box (backlog epic 5 stays separate).
- Keeping user frames to grow the catalog or train anything. Frames stay private capture
  assets, kept only for the session's life (§9.1). A later decision may revisit this.
- New catalog sources. Coverage is what it is (seven brands in dev); "we don't know this
  one" must be a good outcome.
- Shelf or multi-bottle scenes. One bottle per session.

**Anti-goals** (would make this a failure even if it "works")

- A confident wrong match. Asking with three candidates beats a wrong "you own it".
- Any write to a shared catalog shade from a capture. Rule #224 holds: catalog color and
  finish are written only when the request creates the shade.
- Blocking ingestion or the frame endpoint on an AI service outage. Every AI step is best
  effort with the current behavior as the fallback.
- Storing anything derived from a user frame (embedding, crop) outside the session's own
  `capture_frame.quality_json`, or keeping frame bytes beyond the session (§9.1).

## 3. Constraints and existing pieces to build on

- Capture API: `capture/start`, `/frame`, `/check` (read-only), `/finalize`, `/status`,
  `/answer` in `packages/functions/src/functions/capture.ts`. Frames are tagged
  `barcode | label | color | other`, max 6 per session (`guidanceConfig.maxFrames`).
  Label and barcode frames run Document Intelligence OCR, then `parseLabelText`
  (`lib/ocr-parser.ts`). **Color frames are stored and never used.**
- Resolver (`resolveFromEvidence`): barcode → trigram name match (≥ 0.92 match, ≥ 0.75
  candidate question) → ask for brand and shade. Audit in `metadata.resolver`.
- Session start metadata already carries `brand`, `shadeName`, `finish`, `collection`
  hints (`buildStartMetadata` on web; mobile mirrors it), consumed by
  `collectCaptureEvidence` and passed to the label parser.
- Mobile is check-first: nothing is written until the user taps Add (`POST …/check`,
  then `PUT /api/polishes/{shadeId}` or `finalize`). Web finalizes with undo.
- Color tooling already in `packages/functions/src/lib/`: `dominant-color.ts`,
  `palette-pick-detection.ts` (pixels measure, the model picks the chip; unit tested,
  not wired to any write path), `region-color.ts` (`RegionKind` includes `bottle`),
  `near-hex.ts` (OKLAB ranking on stored `shade.oklab_*`), shared dupe / match-image
  HIGH and MEDIUM thresholds.
- Vision model access: `requestAzureOpenAIChatCompletion` in `ai-color-detection.ts`,
  low-detail images by default (~85 tokens each), `AZURE_OPENAI_DEPLOYMENT_LABEL` chain.
- Catalog images: `swatch` rows over `image_asset` (owner_type `source`), reachable as
  bytes via `loadDetectionImageBytes` (`lib/detection-image.ts`) or as public `v2` proxy
  URLs. Perceptual fingerprints (`perceptual_hash`, `thumb_fingerprint`) are a
  near-duplicate tool; they do **not** match a phone photo and are not used here.
- The schema reserved `color_features.embedding vector(512)` with an ivfflat index. It is
  empty, but `protectedSwatchSql` treats any swatch with a `color_features` row as
  protected from gallery pruning, so embeddings do **not** go there (see §6.3).
- Static web export, Functions consumption plan (keep every added call inside the frame
  endpoint's existing timeouts: OCR 15 s, model 15 s).
- Azure OpenAI account region is immutable and guarded in Deploy Infra; nothing here
  touches `azurerm_cognitive_account.openai`.
- Feature flags are on only for the exact value `true`; new env vars go in CLAUDE.md,
  the Functions README table and `local.settings.json.example`.

## 4. The user experience (both clients)

### 4.1 Guided surfaces, driven by the server

Rapid Add gains a **bottle flow** that replaces the free "Barcode / Label / Color" chips
as the default path (the chips remain available as "More options"). The surfaces and
what each answers:

| Surface | Prompt | Frame sent | What it answers |
|---|---|---|---|
| front | "Show the front of the bottle" | `label`, `quality.surface = "front"` | brand (logo, typography), sometimes shade |
| bottom | "Now the bottom" | `label`, `quality.surface = "bottom"` | shade name sticker, sometimes a barcode |
| glass | "Turn it so we see the color" | `color`, `quality.surface = "glass"` | lacquer hex |
| box | "Have the box? Show the barcode" | `barcode` or `label`, `quality.surface = "box"` | GTIN, brand |

**The next prompt comes from the server.** Every frame response (and `check`) may carry
a `nextFrame` request, a new question kind beside today's `needs_question`:

```ts
interface CaptureFrameRequestSpec {
  surface: "front" | "bottom" | "glass" | "box";
  frameType: CaptureFrameType;          // what to tag the frame
  prompt: string;                       // "Show the bottom sticker"
  hint?: string;                        // "Tilt it toward the light", "Hold it against something white"
  reason: "need_brand" | "need_name" | "need_color" | "tie_break" | "retry_quality";
  optional: boolean;                    // true when the resolver could already answer
}
```

The resolver picks it from what it still lacks, in this order: no brand → `front`
(`box` as the alternative); brand but no name → `bottom`; name candidates that only
differ by color → `glass`; two shades still within the MEDIUM distance after a glass
frame → `glass` again with a `tie_break` hint ("tilt it toward the light", then "hold it
against something white"); a frame the quality checks rejected (blur, too dark) →
the same surface with `retry_quality`. After `maxFrames` (6) or when a prompt has been
asked twice without the evidence improving, the resolver stops asking and the card shows
the candidates. With nothing known yet the order is front, bottom, glass, so a user who
never reads the prompts still gets the fixed sequence.

Rules:

- A barcode decoded on device at any step short-circuits as today (one round trip,
  `check` in the frame response). If it matches, the flow ends.
- Every prompt is skippable ("Can't see it"); the client sends the skip as an answer so
  the resolver asks for something else instead of repeating it.
- In batch mode the brand is known, so the first prompt is already "show the bottom".
- When the response carries no `nextFrame` (or the user taps "Find match" early) **both
  clients call `check`**
  and show the verdict card; nothing is written until a tap. The web's bottle sequence
  therefore moves to check-first like mobile (today's web `finalize` adds the match at
  once and bumps `quantity` for an owned polish, which in batch mode would add an extra
  bottle for every polish already owned). The legacy chip path on the web keeps
  `finalize` + undo until it is removed.
- The surface type, the `nextFrame` spec and the default order live in `packages/shared`
  so both clients render the same flow; the prompt copy is server-side so it can change
  without an app release. Frame types stay the four existing values; the surface is a
  `quality` field, so no API contract breaks.

### 4.2 Batch mode (sticky hints)

- A **brand** field above the camera. Typing "Loud" and confirming sets batch mode: the
  header shows "Going through: Loud Lacquer · Done". The hint is fuzzy; the server resolves
  it to a brand row with the same trigram matching used for shade names and echoes the
  canonical name back in the start response's metadata so the header can show it.
- The hint is sent as the session start `brand` metadata on every new session until
  Done. Persisted per user on the device (web `localStorage`, mobile AsyncStorage, keyed
  by user id and wiped on sign-out like the other caches). Nothing server-side remembers it.
- Optional sticky **finish** and **collection** work the same way. **Shade name** hints
  stay per bottle (they change every time) and are an escape hatch, not routine.
- In batch mode step 1 ("front") is still offered but marked optional, since the brand is
  already known.

### 4.3 Verdict card endings

| Ending | Card | Tap |
|---|---|---|
| Matched, owned | "You own this" + swatch, catalog image | Next |
| Matched, not owned | brand, shade, swatch, confidence, catalog image | Add / ♡ Wishlist / Next |
| A few candidates | up to 5 rows (catalog image, name, swatch, color distance) + "None of these" | pick one → Add |
| Brand known, shade unknown | prefilled new shade: brand (locked or read), name as read from the sticker (editable), hex from the glass (editable chip), finish | **Add** creates the private shade and the inventory row in one call; Next skips |
| Nothing readable | "Couldn't read this one" + the three thumbnails + brand/shade text fields | Add manually (`/polishes/new` prefilled) |

The one-tap create goes through the existing `POST /api/polishes` path (brand name,
shade name, finishes, `detectedHex` from the glass, scanned barcode if any, plus a new
optional `captureId`). With `captureId` the server, in the same transaction, marks the
caller's own capture session `matched` with `accepted_entity_id` = the new shade
(whatever state the session was in: never finalized on mobile, `unmatched` on web) and
learns the barcode in `user_shade_barcode` as a manual add does today. The shade is
`user_submitted` and private until an admin approves it in the review queue. A bad read
is fixed later on the detail page, never in the loop.

**Brand not in the catalog.** `POST /api/polishes` already inserts a shared `brand` row
for a name it has not seen, and that stays the rule, but only for text the user typed or
confirmed:

- A sticky hint that resolves to no catalog brand still enables batch mode with the raw
  text; the card's brand field is prefilled with it and editable.
- A brand that came only from OCR or the vision read (no hint, no barcode) is shown in
  the brand field marked "read from the bottle, check it" and the field must be
  confirmed (tap or edit) before Add is enabled. Model text alone never creates a
  shared brand row.
- `suggestedShade.brandSource` (`hint | barcode | read`) tells the clients which rule
  applies.

## 5. Slice A: surfaces, color evidence, brand-first resolver, batch mode

Slice A plan: `docs/superpowers/plans/2026-10-23-bottle-flow-slice-a.md`.

Calls made in the Slice A plan:
- Frame blob storage (§9.1) is also behind the flag: off, frames keep the `inline://` placeholder exactly as today. The sweep timer runs regardless (it finds nothing while off).
- "Can't see it" is `POST /api/capture/{id}/answer` with a new body field `skipSurface` (no open `capture_question` needed); the response carries the next `nextFrame`.
- There is no cancel route today; an abandoned session is a `processing` session whose frames the 24-hour sweep releases.
- The §5.4 telemetry events are emitted server-side (`trackEvent` in the capture handlers and `polishes.ts`), where every client's flow is visible at once.
- Picking a candidate or tapping Add on the check-first path uses `PUT /api/polishes/{shadeId}` as mobile does today; it does not mark the session or learn the barcode (pre-existing mobile gap, follow-up ticket). Only the one-tap create (`POST /api/polishes` with `captureId`) marks the session.
- Only a hex the server measured from a `color` frame (`quality_json.extracted.source = "glass"`) is color evidence; a client-supplied `quality.hex` is ignored.
- The client flow reducer is shared (`packages/shared/src/capture/bottle-flow.ts`), not duplicated per app.
- Candidate rows show the swatch `hex`, confidence and the new `colorDistance`; the catalog image on candidate and match rows (§4.3) waits for Slice B, which loads catalog images at check time anyway.

Ships without new infrastructure.

### 5.1 Color evidence from the glass frame

On a `color` frame the server measures a lacquer hex and stores it in
`quality_json.extracted.hex` with `hexConfidence` and `hexMethod`:

1. `extractPaletteCandidates` on the frame (8–12 merged chips).
2. `renderPaletteComposite` + one low-detail model call asking which chip is the lacquer
   inside the bottle (not the cap, label, hand or background). This is the existing
   palette-pick module with a bottle-specific prompt; `hexMethod = "palette-pick-bottle"`.
3. If the model is unavailable or declines, fall back to the chip that is farthest from
   skin tones and neutral greys among the top three by area, `hexMethod = "palette-top"`,
   confidence 0.3. The builder may replace this heuristic; it only has to be deterministic.

Hand-held frames are dominated by skin and background, so plain dominant color is not
acceptable as the primary method.

### 5.2 Reading the bottom sticker

Document Intelligence OCR stays as it is for every label frame. In addition, a label frame
gets a **direct vision read** by the chat model when either applies:

- a brand is known (hint, barcode, or a front-frame read), so the question is closed:
  the prompt lists that brand's active shade names (the largest brand today has 155;
  cap the list at 400 names and fall back to open reading above that), and asks for the
  printed name, the closest list entry, and a confidence; or
- OCR returned no usable text (empty or confidence < 0.4).

Result fields merge into `quality_json.extracted` with `source: "vision"`, and OCR-derived
fields keep precedence only when their confidence is higher. One low-detail call per
label frame; the model prompt lists finishes from `finishNamesForPrompt(loadFinishCatalog())`
like the other prompts.

### 5.3 Brand-first resolver

`resolveFromEvidence` becomes:

1. **Barcode** as today.
2. **Brand**: hint (already resolved to a brand id at session start) > barcode's brand >
   vision/OCR brand read (resolved by trigram against `brand.name_canonical` and aliases,
   accept ≥ 0.6). Unresolved → brand unknown.
3. **Candidates within brand** (brand known): every active shade of the brand (plus the
   caller's own `user_submitted` shades of that brand), scored by
   - name similarity to the sticker read (trigram, 0–1) when a name was read,
   - color distance between the glass hex and the display hex (OKLAB, via the stored
     `shade.oklab_*`), mapped to 0–1 with the shared HIGH/MEDIUM thresholds,
   - combined so that **color confirms or breaks ties but never sinks a name read**
     (hand-held glass hexes are noisy and glitter/holo display hexes match poorly):
     - name ≥ 0.92: auto-match as today, unless the color distance is beyond MEDIUM,
       in which case it becomes the candidate question (never the create card);
     - name 0.75–0.92: color within HIGH lifts it to a match, otherwise the candidate
       question;
     - no name read: rank by color alone, always the candidate question, never a match
       (Slice B may confirm it);
     - ranking inside each band is by name, then color distance.
     The bands and thresholds are constants in one place with unit tests.
4. **Candidates without a brand**: today's global trigram query on the name read, then
   color re-rank of those rows. (Slice C adds visual retrieval here.)
5. Decision thresholds stay 0.92 / 0.75. A score below 0.75 with a known brand ends
   with the **candidate list** (up to 5, "None of these") when the best candidate scores
   ≥ 0.5, else with the **create card** directly. "None of these" leads to the create
   card. The create card never appears while a plausible catalog candidate is on screen,
   to keep private duplicates of catalog shades out of the review queue.
6. New terminal shape for the unknown-shade ending: `status: "unmatched"` with
   `metadata.resolver.suggestedShade = { brandId, brandName, brandSource, shadeName,
   hex, finish, gtin }` so both clients can prefill the create card. `check` returns the
   same object.
7. **Hint vs. camera conflict**: the sticky brand hint ranks first, but when a front
   or box read resolves to a *different* catalog brand with confidence ≥ 0.8, that brand's
   shades join the candidate pool with the same scoring and the result carries
   `metadata.resolver.brandConflict = { hinted, read }`. The card shows which brand the
   match belongs to and a one-tap "Switch to <brand>" that updates the sticky hint. The
   hint is never silently overridden and never silently kept.

Audit: every step writes to `metadata.resolver.audit` (brand source, candidate count,
score components of the top 5) so `/status` explains the verdict.

### 5.4 Shared client logic

- `packages/shared`: the surface type, `CaptureFrameRequestSpec` (`nextFrame`) on the
  frame/check/status responses, the default surface order, the `suggestedShade` type,
  and a pure helper that turns a `nextFrame` plus the client's frame list into what the
  camera screen shows (prompt, hint, skip).
- Web `lib/rapid-add-flow.ts` and mobile `lib/rapid-add.ts` gain the sequence state, the
  sticky-hint store and the create-card derivation; both get node tests.
- Telemetry: `capture.surface_captured` (surface, skipped), `capture.resolved`
  (method: barcode / name / name+color / color / vision-confirm / retrieval / unmatched,
  brand_locked bool), `capture.shade_created`.

## 6. Slice B: catalog confirm

Runs after Slice A's resolver whenever the leading candidate did **not** come from a
barcode and either (a) its score is between the question and match thresholds, or
(b) it would auto-match on name+color but the second candidate is within 0.05 of it.

- Build one chat completion: the session's front/bottom/glass frames (up to 3, low detail)
  followed by up to 5 candidates, each as the shade's primary catalog image
  (`swatch_type = 'source_product'`, bytes via `loadDetectionImageBytes` as a data URI so
  it works against Azurite and in prod alike) labeled A–E. Ask: which candidate is the
  same product as the bottle in the photos, or NONE, with a confidence.
- Confirmed with confidence ≥ 0.8 → matched (`method: vision-confirm`). NONE or low
  confidence → candidate question (or unmatched when only one candidate). The letter, its
  confidence and the candidate order go in the resolver audit.
- Cost: one call per capture, ~8 low-detail images. Flag `CAPTURE_VISUAL_CONFIRM_ENABLED`
  (default `false`; Terraform variable + GitHub variable like the other flags) so it can be
  measured on dev before prod.
- Candidates without a catalog image fall back to a solid chip of their display hex,
  labeled as such in the prompt.

## 7. Slice C: visual retrieval with embeddings

For the case with no barcode, no hint and nothing readable: identify the brand (and get
shade candidates) from how the bottle looks.

### 7.1 Provider decision

Azure AI Vision "multimodal embeddings" (Image Analysis 4.0) is **deprecated**: retirement
2028-09-25, and Microsoft's migration page asked customers to transition by 2026-09-25,
which has passed. It is also unavailable in `centralus` (prod's OpenAI region). Building on
it now is wrong.

Microsoft's named replacement for image embeddings is **Cohere Embed v4 in Microsoft
Foundry** (multimodal, serverless pay-as-you-go, selectable dimensions including 512, which
is what the schema reserved). SigLIP is the other named option but would need self-hosting.
Decision: **Cohere Embed v4 via a Foundry serverless deployment**, behind a small provider
interface (`lib/image-embedding.ts`: `embedImage(bytes) → Float32Array`, `model`, `dims`)
so the provider can be swapped without touching callers.

Pricing seen on third-party aggregators conflicts (text $0.12 per 1M input tokens; one
listing shows an image SKU at $0.47 per 1M). At either rate a backfill of a few thousand
catalog images is under $10 and a capture adds one embedding; the builder confirms the
meter in the Azure portal when provisioning and records it in the Functions README.

Region: the Foundry resource is independent of the OpenAI account; create it in the
environment's Azure region that offers the model (verify at provisioning; dev `eastus` is
expected to). It is a new `azurerm` / `azapi` resource in Terraform, never a change to
`azurerm_cognitive_account.openai`, so the Deploy Infra replacement guard is untouched.

### 7.2 Storage

New table (migration), **not** `color_features`:

```sql
CREATE TABLE image_embedding (
  image_id    BIGINT PRIMARY KEY REFERENCES image_asset(image_id) ON DELETE CASCADE,
  model       TEXT NOT NULL,            -- e.g. 'cohere-embed-v4-0'
  dims        SMALLINT NOT NULL,        -- 512
  embedding   vector(512) NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_image_embedding_hnsw ON image_embedding USING hnsw (embedding vector_cosine_ops);
```

Only `owner_type = 'source'` images are ever embedded. User frames are embedded at query
time and the vector is discarded. HNSW rather than ivfflat because the set is small and
grows continuously (ivfflat needs retraining as rows arrive).

### 7.3 Population

- Ingestion: after `uploadSourceImageToBlob`, compute and store the embedding, best
  effort (a failure logs to the job log and leaves the row absent; it never fails the
  product).
- Backfill: `POST /api/images-admin/embeddings/backfill` (`withAdmin`, batched, `after`
  cursor, dry run by default) and `npm run backfill:image-embeddings`, the same pattern as
  the variants backfill. Re-run with `--model` when the provider changes; rows of another
  model are replaced.

### 7.4 Query

`retrieveByImage(frameBytes, k = 30)`: embed the front frame, nearest neighbours by cosine,
join `swatch → shade → brand` (active, color category, not merged). Then:

- **Brand vote:** similarity-weighted votes per brand over the neighbours; accept the top
  brand when its share ≥ 0.6 and the margin to the second ≥ 0.2. This feeds resolver step 2
  when no other brand evidence exists.
- **Shade candidates:** the top shades by best-neighbour similarity enter resolver step 3
  as candidates with a `visual` score component (starting weight 0.3 beside name and
  color). Visual similarity alone never auto-matches, since same-brand shades share a
  bottle mold; Slice B confirms or the candidate question asks.

Flag `VISUAL_RETRIEVAL_ENABLED` (default `false`); env `IMAGE_EMBEDDING_ENDPOINT`,
`IMAGE_EMBEDDING_KEY`, `IMAGE_EMBEDDING_MODEL`, `IMAGE_EMBEDDING_DIMS`. Unset → no-ops,
resolver behaves as Slice A+B.

## 8. Slice 0: admin capture tab and the eval set

Built **first**, so the owner can shoot bottles while A, B and C are being built. The
eval set is a *scoring* set, not training data: nothing learns from it; the resolver is
run over it and its answers compared with the owner's labels.

### 8.1 Admin capture tab

A new admin console tab, `?tab=bottle-eval`, beside Hex Labeling, reusing the Rapid Add
camera and frame uploader:

1. Pick the truth first: catalog search for the shade, or "Not in catalog" with a typed
   brand and shade name.
2. Shoot front, bottom, glass (and box if there is one) with the same prompts users get.
   Any number of extra frames (different lighting, angles) is allowed and encouraged.
3. Save. The photos go to the private user-media container (`USER_MEDIA_CONTAINER`) under
   `{adminUserId}/bottle-eval/{sampleId}/`, linked by foreign key so the orphan sweep never
   touches them and served only as owner-scoped `v3` thumbnails to the admin who shot them
   (plan decision: no new container, proxy path or Terraform). One `bottle_eval_sample` row
   per bottle records the label; `bottle_eval_frame` rows record the frames:

```sql
CREATE TABLE bottle_eval_sample (
  sample_id          BIGSERIAL PRIMARY KEY,
  shade_id           BIGINT REFERENCES shade(shade_id) ON DELETE SET NULL,  -- NULL = not in catalog
  brand_text         TEXT,            -- typed when not in catalog (snapshot of the catalog names otherwise)
  shade_text         TEXT,
  notes              TEXT,
  created_by_user_id BIGINT NOT NULL REFERENCES app_user(user_id) ON DELETE CASCADE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE bottle_eval_frame (
  frame_id   BIGSERIAL PRIMARY KEY,
  sample_id  BIGINT NOT NULL REFERENCES bottle_eval_sample(sample_id) ON DELETE CASCADE,
  image_id   BIGINT NOT NULL UNIQUE REFERENCES image_asset(image_id) ON DELETE CASCADE,
  surface    TEXT NOT NULL,          -- front|bottom|glass|box
  frame_type TEXT NOT NULL,          -- barcode|label|color|other
  position   SMALLINT NOT NULL
);
```

Routes: `GET/POST /api/bottle-eval-admin/samples`, `DELETE …/samples/{id}`,
`POST/DELETE …/samples/{id}/frames[/{frameId}]` (one frame per request), all `withAdmin`,
uploads re-encoded with the nail-photo sanitizer (EXIF stripped). The tab lists samples
with thumbnails and lets the admin delete or re-shoot one. A sample is never used by the
live resolver. Implementation plan: `docs/superpowers/plans/2026-10-23-bottle-eval-capture.md`.

### 8.2 The eval

`npm run eval:bottle --workspace=swatchwatch-functions` (needs Postgres + the storage
account) runs the resolver over every sample as if the frames had arrived through the
capture API, per slice and flag combination, and reports: match rate, candidate-question
rate, **false confident matches** (must be 0), median resolver time per bottle, model
calls per bottle, and the same split by brand and by finish family. It also replays the
adaptive prompts and reports how many frames each bottle needed.

Targets from backlog epic 3: < 10 s per bottle without a barcode. Dupe / match-image
thresholds are reused, not re-tuned here. Twenty catalog bottles plus five not in the
catalog is enough to start; more arrive whenever a bottle is in hand.

## 9. Security, privacy, access control

### 9.1 Frame retention (owner's decision)

Today the capture API discards frame bytes after OCR and stores an `inline://`
placeholder as `image_asset.storage_url`. Slice B needs the frames at `check` time and
Slice C needs the front frame to embed, so from Slice A on:

- Every frame's sanitized bytes (EXIF already stripped) are written to
  `USER_MEDIA_CONTAINER` under `{userId}/capture/{captureId}/{sha}.{ext}` and the
  `image_asset` row points at that blob (`owner_type = 'user'`, `owner_id = userId`, as
  for nail photos). The row is reachable only through the owner's capture session; it is
  never given a `v3` proxy id and never appears in any polish or media response.
- **Deleted at a terminal state:** when the session becomes `matched`, `unmatched` or
  `cancelled` (finalize, an accepted `check` through the create path, an answer that
  ends the session, or an explicit cancel), the handler deletes the session's blobs in
  the same request after the DB transaction commits, and sets `storage_url` back to the
  `inline://` placeholder so the `capture_frame` rows and their `quality_json` audit
  survive without bytes.
- **Swept after 24 h regardless:** a `capture-frame-sweep` timer (NCRONTAB,
  `CAPTURE_FRAME_SWEEP_SCHEDULE`, default hourly) deletes the blobs of every frame whose
  `image_asset.captured_at` is older than `CAPTURE_FRAME_RETENTION_SECONDS` (default
  `86400`, clamped 3600–604800) and resets its `storage_url` the same way, terminal or
  not. Only blobs under the owner's `{userId}/capture/` prefix are ever deleted.
- The existing orphan-media sweep is unchanged; a capture frame is referenced by
  `capture_frame`, so it is never an orphan.
- Neither sweep nor delete touches `quality_json`; the extracted evidence and the glass
  hex are what remain.

This stays inside the promise the mobile app makes today ("Photos are only sent to match
this bottle"); the README copy on both clients says frames are kept up to 24 hours.

- Every new route is `withAuth` / `withAdmin`; all capture reads stay scoped to the
  session's `user_id`; candidate queries exclude other users' `user_submitted` shades.
- User frames remain `owner_type = 'user'` assets reachable only through the session.
  No frame bytes, crops or vectors are written anywhere else. Model prompts receive frame
  bytes as data URIs, never a public URL to private media.
- Catalog images sent to the model are the same public images the batch pipeline sends.
- The batch-mode hint is a client preference, cleared on sign-out.

## 10. Documentation and rollout

- CLAUDE.md: Architecture Overview (a "Bottle recognition" paragraph), Environment
  Variables (new flags and `IMAGE_EMBEDDING_*`), Web App Routes row for `/rapid-add`,
  Dev Commands (`backfill:image-embeddings`, `eval:bottle`). Functions README route table
  and env table, `local.settings.json.example`, `apps/web/README.md`,
  `apps/mobile/README.md`, `packages/shared/README.md`, `infrastructure/README.md`,
  `docs/schema.sql`.
- One PR per slice into `dev` (D24), in the order 0, A, B, C. Slice A ships behind
  `BOTTLE_CAPTURE_ENABLED` (default `false`): off, the capture API, resolver and both
  clients behave exactly as today; on, the bottle flow, server-driven prompts, glass
  color, vision sticker read, brand-first scoring, batch mode and one-tap create are
  live. The flag flips per environment once the eval set reads clean. Slices B and C have
  their own flags (§6, §7) and are turned on the same way via Deploy Infra variables.

## 11. Decisions made in this design (owner's)

- Labels are usually hard to read; shape and color must carry it. Build A, B and C.
- Frames are kept as private blobs for the life of the capture session, deleted at a
  terminal state and swept after 24 hours regardless.
- Eval photos are shot through an admin capture tab into private blob storage, never
  committed to git; Slice A ships behind a default-off flag until the eval set exists.
- The admin capture tab is built first.
- The server prompts the user what to show next (rotate, tilt, show the bottom), adapting
  to what it has learned, instead of a fixed order.
- Surfaces: front (brand), bottom (shade sticker), glass (color), optional box.
- Sticky brand/finish/collection hints as batch mode with an explicit Done; shade hints
  per bottle.
- Unknown shade under a known brand: prefilled card, one tap to create, never stop and ask.
- Web and mobile together.

## 12. Calls made by the author (change freely)

- Keep the four frame types; surface is a `quality` field.
- Palette-pick (model chooses the measured chip) for the glass hex, with a deterministic
  fallback.
- Direct vision read of label frames in addition to OCR, closed-set when the brand is known.
- Color confirms or breaks ties and never sinks a name read (§5.3 bands); color-only and
  visual-only never auto-match; the create card never shows while a plausible candidate is
  on screen.
- Both clients use `check` for the bottle sequence (web moves to check-first there).
- Shared brand rows come only from typed or confirmed text, never from model text alone.
- A conflicting high-confidence brand read joins the candidate pool and is flagged on
  the card; the hint is never silently overridden or kept.
- Cohere Embed v4 on Foundry serverless, 512 dims, new `image_embedding` table with HNSW,
  provider behind an interface.
- Slice B and C behind default-off flags; Slice A gated by the eval set instead.
- Batch-mode hint stored on the device only.
- The `nextFrame` request shape and the resolver's asking order in §4.1; prompts repeat
  at most twice; prompt copy lives server-side.
- Eval samples in their own tables (`bottle_eval_sample`, `bottle_eval_frame`), not in
  `color_training_sample`, since a sample has several frames and may be "not in catalog";
  the frames live in `USER_MEDIA_CONTAINER` under `{adminUserId}/bottle-eval/` (§8.1), not
  in a container of their own.

## 13. Left to the builder

- Exact prompts, JSON shapes and retry behavior of the two new model calls (follow
  `ai-color-detection.ts` conventions, bump a version constant when a prompt changes).
- The skin/neutral fallback heuristic in §5.1 and the brand-alias matching in §5.3.
- Terraform resource type for the Foundry serverless deployment (`azurerm` if it exists in
  ~4.50, else `azapi`), with the manual bootstrap documented in `infrastructure/README.md`.
- UI layout of the prompts and the verdict card on each client, within each app's
  existing components (`verdict-card.tsx`, the web Rapid Add page), and the admin tab's
  layout within the admin console's tab pattern.
- The quality checks that produce `retry_quality` (the web already has frame quality
  warnings in `lib/camera.ts`; reuse their thresholds).
- Test fixtures for the resolver unit tests (synthetic evidence) separate from the photo
  eval set.
