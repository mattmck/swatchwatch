# M1 Remaining Work — Detailed Implementation Plan

_Date: 2026-02-17_
_Milestone: M1 — Rapid Add (camera) + finalize pipeline + 1-question loop_
_Scope: Epic 3 from `docs/mvp-backlog.md`_

---

## Current State Summary

The following M1 work is **already done**:

- Capture session CRUD APIs (`packages/functions/src/functions/capture.ts`): start, frame, finalize, status, answer — all 5 endpoints registered and working
- Deterministic resolver: barcode/GTIN lookup via `barcode` table + shade similarity via `pg_trgm` on `shade.shade_name_canonical`
- DB schema for capture tables: `capture_session`, `capture_frame`, `capture_question`, `capture_answer` (in `docs/schema.sql` and applied via migrations)
- Shared types for capture flow (`packages/shared/src/types/capture.ts`): `CaptureStatus`, `CaptureQuestion`, `CaptureStartRequest/Response`, etc.
- Web API client wrappers (`apps/web/src/lib/api.ts`): `startCapture`, `addCaptureFrame`, `addCaptureFrameFromFile`, `finalizeCapture`, `getCaptureStatus`, `answerCaptureQuestion`
- Web rapid-add page (`apps/web/src/app/rapid-add/page.tsx`): file-based frame upload, text match hints, question/answer UI, polling, status display
- Match → auto-upsert into `user_inventory_item` (via `addToInventoryFromMatch()`)
- 3 question types: needs-frame, brand/shade free-text, candidate-select
- Answer handling with candidate selection, brand/shade normalization, and skip

---

## Remaining Stories (17 stories, ordered by dependency)

Each story below includes:
- **What** — description of the change
- **Why** — which M1 requirement it satisfies
- **Where** — exact file paths to create/modify
- **How** — step-by-step implementation instructions
- **Acceptance criteria** — what "done" looks like

---

### Story 1: Server-Side OCR via Azure AI Document Intelligence

**What:** Add a helper module that calls Azure AI Document Intelligence (or Azure AI Vision) to extract text from a capture frame image.

**Why:** The finalize pipeline currently relies entirely on evidence the client sends in `quality_json`. The server needs to independently extract label text (brand, shade name, finish) from frame images to enable the "rotate bottle until matched" flow without manual text hints.

**Where:**
- **Create:** `packages/functions/src/lib/ocr.ts`
- **Modify:** `packages/functions/package.json` (new env vars documented)

**How:**

1. Create `packages/functions/src/lib/ocr.ts` with this structure:

```ts
// ocr.ts — Azure AI Document Intelligence integration
// Env vars: AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT, AZURE_DOCUMENT_INTELLIGENCE_KEY

export interface OcrResult {
  rawText: string;            // full extracted text
  lines: OcrLine[];           // individual lines with bounding boxes
  confidence: number;         // overall confidence 0..1
  provider: string;           // "azure-document-intelligence"
}

export interface OcrLine {
  text: string;
  confidence: number;
  boundingBox?: number[];     // [x1,y1,x2,y2,...] polygon
}

export async function extractTextFromImage(
  imageInput: string  // HTTPS URL or base64 data URL
): Promise<OcrResult | null>
```

2. Implementation details:
   - Read `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT` and `AZURE_DOCUMENT_INTELLIGENCE_KEY` from `process.env`
   - If either env var is missing, log a warning and return `null` (graceful degradation, same pattern as `blob-storage.ts`)
   - Use the **REST API** directly via `fetch` (no SDK — matches existing pattern in `ai-color-detection.ts`):
     - `POST {endpoint}/documentintelligence/documentModels/prebuilt-read:analyze?api-version=2024-11-30`
     - Set headers: `Ocp-Apim-Subscription-Key: {key}`, `Content-Type: application/json`
     - Body: `{ "urlSource": url }` for HTTPS URLs, or `{ "base64Source": payload }` for data URLs
   - Poll the operation URL (from `Operation-Location` header) until complete (max 30s, poll every 1s)
   - Parse the `analyzeResult.content` field (full text) and `analyzeResult.pages[].lines[]` (individual lines)
   - Return `OcrResult` with aggregated text and per-line confidence
   - Handle errors: 429 (rate limit) → retry with backoff (1 attempt), 4xx/5xx → log and return `null`

3. Add env var placeholders to `packages/functions/local.settings.json`:
   ```json
   "AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT": "",
   "AZURE_DOCUMENT_INTELLIGENCE_KEY": ""
   ```

**Acceptance criteria:**
- `extractTextFromImage("https://some-blob-url/label.jpg")` returns `OcrResult` with extracted text
- Returns `null` when env vars are missing (no crash)
- Returns `null` on API errors (graceful degradation)
- Handles both HTTPS URLs and base64 data URLs

---

### Story 2: LLM Structured Extraction from OCR Text

**What:** Add a helper that takes raw OCR text and uses Azure OpenAI to extract structured polish fields (brand, shade name, finish, collection, GTIN if visible).

**Why:** OCR produces raw text from label images. We need structured fields to feed into the resolver. The existing `ai-color-detection.ts` shows the Azure OpenAI call pattern.

**Where:**
- **Create:** `packages/functions/src/lib/ocr-parser.ts`

**How:**

1. Create `packages/functions/src/lib/ocr-parser.ts`:

```ts
export interface ParsedLabelFields {
  brand: string | null;
  shadeName: string | null;
  finish: string | null;
  collection: string | null;
  gtin: string | null;
  sizeMl: number | null;
  confidence: number;  // 0..1
  rawFields: Record<string, unknown>;  // full LLM response for audit
}

export async function parseLabelText(
  rawText: string,
  hints?: { brand?: string; shadeName?: string; finish?: string }
): Promise<ParsedLabelFields | null>
```

2. Implementation details:
   - Read `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_KEY`, and a new env var `AZURE_OPENAI_DEPLOYMENT_LABEL` (or reuse `AZURE_OPENAI_DEPLOYMENT_HEX` if deployment supports it) from `process.env`
   - If missing, return `null`
   - Call Azure OpenAI Chat Completions API via `fetch`:
     - `POST {endpoint}/openai/deployments/{deployment}/chat/completions?api-version=2024-06-01`
     - System prompt: "You are a nail polish label reader. Given OCR text from a nail polish bottle label, extract the following fields as JSON: brand, shadeName, finish (one of: creme, shimmer, glitter, metallic, matte, jelly, holographic, holo, duochrome, multichrome, flake, topper, sheer), collection, gtin (if a barcode number is visible), sizeMl. Return ONLY valid JSON. If a field cannot be determined, set it to null."
     - User prompt: `"OCR text:\n{rawText}\n\nHints: {JSON.stringify(hints)}"`
     - Set `response_format: { type: "json_object" }` (structured output)
     - `temperature: 0.1`, `max_tokens: 500`
   - Parse the JSON response, validate field types, return `ParsedLabelFields`
   - Handle errors same as `ai-color-detection.ts` (retry on 429, return null on failure)

3. Add env var to `local.settings.json`:
   ```json
   "AZURE_OPENAI_DEPLOYMENT_LABEL": ""
   ```
   (May share the same deployment as hex detection if using a capable model like GPT-4o)

**Acceptance criteria:**
- Given OCR text "OPI\nBig Apple Red\nNail Lacquer\n15ml", returns `{ brand: "OPI", shadeName: "Big Apple Red", finish: null, sizeMl: 15, ... }`
- Returns `null` when env vars missing
- Includes `rawFields` for full audit trail

---

### Story 3: Server-Side Barcode Decode from Frame Images

**What:** Add a helper that attempts to decode barcodes (EAN-13, UPC-A, Code 128) from capture frame images server-side.

**Why:** Currently barcode decoding only works if the client sends the decoded GTIN in `quality_json.extracted.gtin`. The server should independently attempt barcode detection from uploaded barcode-type frames.

**Where:**
- **Create:** `packages/functions/src/lib/barcode-decode.ts`
- **Modify:** `packages/functions/package.json` (add dependency)

**How:**

1. Install `zxing-wasm` (or `@aspect-build/barcodes` or `jsqr` + `sharp`):
   ```bash
   cd packages/functions && npm install zxing-wasm
   ```
   Alternative: Use Azure AI Vision's barcode detection capability via the same Document Intelligence endpoint (it detects barcodes automatically). If using Document Intelligence, this can be extracted from the OCR result in Story 1 instead of a separate call.

2. **Preferred approach — extract from Document Intelligence result:**
   - Modify `ocr.ts` to also return detected barcodes from the `analyzeResult.documents` or `analyzeResult.pages[].barcodes[]` fields
   - Add to `OcrResult`:
     ```ts
     barcodes: { value: string; kind: string; confidence: number }[];
     ```

3. **Fallback approach — standalone barcode decoding:**
   - Create `packages/functions/src/lib/barcode-decode.ts`:
     ```ts
     export interface BarcodeResult {
       gtin: string;
       format: string;        // "EAN_13" | "UPC_A" | "CODE_128" | ...
       confidence: number;
     }

     export async function decodeBarcodeFromImage(
       imageInput: string  // HTTPS URL or base64 data URL
     ): Promise<BarcodeResult | null>
     ```
   - Download the image bytes (fetch for HTTPS, Buffer.from for base64)
   - Use `zxing-wasm` to decode
   - Normalize GTIN (strip leading zeros for UPC-A → EAN-13 conversion)

**Acceptance criteria:**
- Given an image containing a barcode, returns the decoded GTIN string
- Returns `null` if no barcode found or image is unreadable
- Handles both HTTPS URLs and data URLs

---

### Story 4: Integrate OCR + LLM + Barcode into Finalize Pipeline

**What:** Wire the OCR, LLM parser, and barcode decoder into the `resolveCaptureSession()` function so that finalize automatically processes uploaded frames.

**Why:** This is the core M1 deliverable — the "finalize pipeline" that processes captured evidence, extracts structured fields via AI, and feeds them into the deterministic resolver.

**Where:**
- **Modify:** `packages/functions/src/functions/capture.ts`

**How:**

1. Add imports at top of `capture.ts`:
   ```ts
   import { extractTextFromImage } from "../lib/ocr";
   import { parseLabelText } from "../lib/ocr-parser";
   // If using standalone barcode decode:
   import { decodeBarcodeFromImage } from "../lib/barcode-decode";
   ```

2. Create a new function `runFrameProcessingPipeline()` in `capture.ts`:
   ```ts
   interface PipelineResult {
     gtin?: string;
     brand?: string;
     shadeName?: string;
     finish?: string;
     collection?: string;
     ocrRawText?: string;
     ocrConfidence?: number;
     llmConfidence?: number;
     barcodeFormat?: string;
   }

   async function runFrameProcessingPipeline(
     sessionId: number,
     metadata: Record<string, unknown> | null
   ): Promise<PipelineResult>
   ```

3. Implementation of `runFrameProcessingPipeline()`:
   - Query all `capture_frame` rows for this session:
     ```sql
     SELECT cf.frame_type, cf.quality_json, ia.storage_url
     FROM capture_frame cf
     JOIN image_asset ia ON cf.image_id = ia.image_id
     WHERE cf.capture_session_id = $1
     ORDER BY cf.created_at ASC
     ```
   - For each frame with `frame_type = 'barcode'`:
     - If `quality_json.extracted.gtin` already exists, use it
     - Otherwise call `decodeBarcodeFromImage(storage_url)` (or extract from OCR result)
     - If GTIN found, set `result.gtin`
   - For each frame with `frame_type = 'label'`:
     - Call `extractTextFromImage(storage_url)` to get OCR text
     - Call `parseLabelText(ocrText, { brand: metadata?.brand, ... })` to get structured fields
     - Merge parsed fields into result (prefer highest-confidence values)
   - For data URL images (inline://capture/...), resolve the inline image by looking up the data URL from the request — **OR** store the base64 data in `image_asset.storage_url` during frame upload. Currently `storage_url` stores `inline://capture/{id}/{checksum}.{ext}` for data URLs, which is NOT a fetchable URL. Two options:
     - **Option A (recommended):** During `addCaptureFrame`, when the image is a data URL, upload it to Azure Blob Storage via `uploadSourceImageToBlob()` from `blob-storage.ts` and store the blob URL in `storage_url` instead of the inline reference. This makes images accessible to the OCR service.
     - **Option B:** Store the raw data URL in a new column or in `quality_json.dataUrl` and pass it directly to OCR (as base64Source).
   - Return the merged `PipelineResult`

4. Modify `resolveCaptureSession()` to call `runFrameProcessingPipeline()`:
   - Before the existing `collectCaptureEvidence()` call, run the pipeline:
     ```ts
     const pipelineResult = await runFrameProcessingPipeline(session.id, session.metadata);
     ```
   - Merge pipeline results into the evidence:
     ```ts
     if (pipelineResult.gtin && !evidence.gtin) evidence.gtin = pipelineResult.gtin;
     if (pipelineResult.brand && !evidence.brand) evidence.brand = pipelineResult.brand;
     // etc.
     ```
   - Update resolver audit to include pipeline results:
     ```ts
     const resolverAudit = {
       version: "deterministic-v1.1",
       frameCount: frames.length,
       pipelineResults: pipelineResult,
       // ... existing fields
     };
     ```

5. Handle `inline://` storage URLs:
   - In `addCaptureFrame()`, when `storageUrl` starts with `inline://`, attempt to upload the raw image bytes to blob storage:
     ```ts
     if (normalizedImage && normalizedImage.storageUrl.startsWith("inline://")) {
       try {
         const blobUrl = await uploadSourceImageToBlob(body.imageBlobUrl, captureId);
         if (blobUrl !== body.imageBlobUrl) {
           normalizedImage.storageUrl = blobUrl;
         }
       } catch (e) {
         // Keep inline:// URL as fallback — pipeline will skip OCR for this frame
       }
     }
     ```
   - Import `uploadSourceImageToBlob` from `../lib/blob-storage`

**Acceptance criteria:**
- When a user uploads a label photo and finalizes, the server runs OCR on the image and extracts brand/shade/finish
- When a user uploads a barcode photo and finalizes, the server decodes the GTIN
- Pipeline results are merged into resolver evidence alongside client-provided hints
- Pipeline results are logged in `metadata.pipeline` for audit
- If OCR/LLM services are unavailable, finalize still works using existing text-based evidence (graceful degradation)
- `inline://` URLs are uploaded to blob storage when `AZURE_STORAGE_CONNECTION` is configured

---

### Story 5: Re-Resolve After Non-Selection Answers

**What:** When a user answers a non-candidate-select question (e.g., provides brand/shade via free text), re-run the resolver to attempt a match with the new evidence.

**Why:** Currently, when a user answers a `brand_shade` question, the answer is stored in `metadata.answers` and session status is set back to `processing`, but `resolveCaptureSession()` is never called again. The user has to manually click "Finalize" again. After answering, the system should automatically re-resolve.

**Where:**
- **Modify:** `packages/functions/src/functions/capture.ts` — `answerCaptureQuestion()` handler

**How:**

1. In the `answerCaptureQuestion()` handler, after storing the answer and when the question is NOT `candidate_select` and the answer is NOT `"skip"`, re-run the resolver:

```ts
// After the transaction that stores the answer...
if (openQuestion.key !== "candidate_select" && body.answer !== "skip") {
  // Reload session with updated metadata
  const updatedSession = await getCaptureSession(captureId, userId);
  if (updatedSession) {
    const reResolveRunId = randomUUID();
    const reResolveStartedAt = new Date().toISOString();
    const outcome = await resolveCaptureSession(updatedSession);
    const metadataPatch = withFinalizeAuditPatch(
      updatedSession.metadata,
      outcome.metadataPatch,
      outcome.status,
      reResolveRunId,
      reResolveStartedAt
    );

    if (outcome.status === "matched") {
      await transaction(async (client) => {
        const inventoryItemId = await addToInventoryFromMatch(
          client, userId, outcome.entityType, outcome.entityId
        );
        await client.query(
          `UPDATE capture_session
           SET status = 'matched', top_confidence = $2,
               accepted_entity_type = $3, accepted_entity_id = $4,
               metadata = COALESCE(metadata, '{}'::jsonb) || $5::jsonb
                 || jsonb_build_object('inventoryItemId', $6),
               updated_at = now()
           WHERE capture_session_id = $1`,
          [updatedSession.id, outcome.confidence, outcome.entityType,
           outcome.entityId, metadataPatch, inventoryItemId]
        );
        await client.query(
          `UPDATE capture_question SET status = 'expired'
           WHERE capture_session_id = $1 AND status = 'open'`,
          [updatedSession.id]
        );
      });
      updatedStatus = "matched";
    } else if (outcome.status === "needs_question") {
      // Insert new question, update session
      await transaction(async (client) => {
        await client.query(
          `UPDATE capture_question SET status = 'expired'
           WHERE capture_session_id = $1 AND status = 'open'`,
          [updatedSession.id]
        );
        await client.query(
          `INSERT INTO capture_question
             (capture_session_id, question_key, prompt, question_type, options_json, status)
           VALUES ($1, $2, $3, $4, $5::jsonb, 'open')`,
          [updatedSession.id, outcome.question.key, outcome.question.prompt,
           outcome.question.type, outcome.question.options ?? null]
        );
        await client.query(
          `UPDATE capture_session
           SET status = 'needs_question', top_confidence = $2,
               metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
               updated_at = now()
           WHERE capture_session_id = $1`,
          [updatedSession.id, outcome.confidence, metadataPatch]
        );
      });
      updatedStatus = "needs_question";
    } else {
      // unmatched
      await query(
        `UPDATE capture_session
         SET status = 'unmatched', top_confidence = $2,
             metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
             updated_at = now()
         WHERE capture_session_id = $1`,
        [updatedSession.id, outcome.confidence, metadataPatch]
      );
      updatedStatus = "unmatched";
    }
  }
}
```

2. Reload the open question for the response:
   ```ts
   const nextQuestion = await getOpenQuestion(session.id);
   ```

**Acceptance criteria:**
- After answering a `brand_shade` question with "OPI - Big Apple Red", resolver re-runs and attempts matching against the catalog
- If match is found (>=0.92), status transitions to `matched` and inventory item is created
- If close matches found (0.75-0.92), a new `candidate_select` question is generated
- If no match found, status becomes `unmatched`
- Skip answers do NOT trigger re-resolution

---

### Story 6: Match Explanation Payload

**What:** Add a `matchExplanation` field to capture status responses showing why the system matched (or didn't match) and what signals were used.

**Why:** Section 14.4 and 15.6 of the implementation guide require explainability — "Always return a 'why' breakdown: which signals contributed and by how much."

**Where:**
- **Modify:** `packages/shared/src/types/capture.ts` — add `MatchExplanation` type
- **Modify:** `packages/functions/src/functions/capture.ts` — populate explanation in resolver

**How:**

1. Add types to `packages/shared/src/types/capture.ts`:
   ```ts
   export interface MatchExplanation {
     status: "accepted" | "needs_confirm" | "unmatched";
     accepted?: {
       entityType: "shade" | "sku";
       entityId: number;
       display: string;
       confidence: number;
     };
     candidates?: MatchCandidate[];
     why?: {
       barcodeMatch: boolean;
       nameSimilarity: number;
       finishMatch: number;
       ocrConfidence: number;
       pipelineUsed: string[];   // e.g. ["barcode_decode", "ocr", "llm_parse"]
     };
     nextBestActions?: string[];  // e.g. ["scan_barcode", "add_finish", "upload_label_photo"]
   }

   export interface MatchCandidate {
     entityType: "shade" | "sku";
     entityId: number;
     display: string;
     confidence: number;
   }
   ```

2. Add `matchExplanation?: MatchExplanation` to `CaptureStatusResponse` in the shared types.

3. In `capture.ts`, build the explanation in `resolveCaptureSession()` and include it in the `metadataPatch`:
   ```ts
   metadataPatch: {
     resolver: { ... },
     matchExplanation: {
       status: "needs_confirm",
       candidates: shadeCandidates.map(c => ({
         entityType: c.entityType,
         entityId: c.entityId,
         display: c.display,
         confidence: c.confidence,
       })),
       why: {
         barcodeMatch: Boolean(evidence.gtin),
         nameSimilarity: topCandidate?.confidence ?? 0,
         finishMatch: evidence.finish ? 1 : 0,
         ocrConfidence: pipelineResult?.ocrConfidence ?? 0,
         pipelineUsed: usedPipelines,
       },
       nextBestActions: computeNextBestActions(evidence),
     },
   }
   ```

4. In `getCaptureStatus()`, extract `matchExplanation` from `session.metadata` and include it in the response.

5. Add a helper `computeNextBestActions()`:
   ```ts
   function computeNextBestActions(evidence: CaptureEvidence): string[] {
     const actions: string[] = [];
     if (!evidence.gtin) actions.push("scan_barcode");
     if (!evidence.finish) actions.push("add_finish");
     if (!evidence.brand || !evidence.shadeName) actions.push("upload_label_photo");
     return actions;
   }
   ```

**Acceptance criteria:**
- `GET /api/capture/{id}/status` response includes `matchExplanation` when available
- Explanation shows which signals were used and their values
- `nextBestActions` suggests the lowest-friction next step

---

### Story 7: Finish Agreement Scoring in Resolver

**What:** Enhance the shade resolver to also consider finish agreement when scoring candidates, boosting confidence when finish matches and reducing it when finish conflicts.

**Why:** The backlog (Section 15.4) specifies `FieldAgreement: finish/line/collection agreement (0..1)` as a scoring signal. Currently the resolver only uses `pg_trgm` shade name similarity.

**Where:**
- **Modify:** `packages/functions/src/functions/capture.ts` — `resolveShadeCandidates()`

**How:**

1. Update the SQL queries in `resolveShadeCandidates()` to also return shade finish:
   ```sql
   SELECT
     s.shade_id::text AS "shadeId",
     b.name_canonical AS brand,
     s.shade_name_canonical AS "shadeName",
     s.finish AS "shadeFinish",
     similarity(s.shade_name_canonical, $2) AS score
   FROM shade s
   JOIN brand b ON s.brand_id = b.brand_id
   WHERE ...
   ```

2. After fetching candidates, adjust the score:
   ```ts
   return result.rows.map((row) => {
     let adjustedScore = Math.max(0, Math.min(1, row.score));

     // Finish agreement scoring
     if (evidence.finish && row.shadeFinish) {
       const finishMatch = normalizeFinish(evidence.finish) === normalizeFinish(row.shadeFinish);
       if (finishMatch) {
         adjustedScore = Math.min(1, adjustedScore + 0.05);  // small boost
       } else {
         adjustedScore = Math.max(0, adjustedScore - 0.10);  // larger penalty
       }
     }

     return {
       entityType: "shade" as const,
       entityId: parseInt(row.shadeId, 10),
       display: `${row.brand} — ${row.shadeName}` + (row.shadeFinish ? ` (${row.shadeFinish})` : ""),
       confidence: adjustedScore,
     };
   });
   ```

3. Add `normalizeFinish()` helper:
   ```ts
   function normalizeFinish(finish: string): string {
     return finish.toLowerCase().trim().replace(/\s+/g, " ");
   }
   ```

4. Re-sort candidates by adjusted score after the adjustments.

**Acceptance criteria:**
- When user provides finish hint "creme" and candidate has finish "creme", score increases
- When user provides finish "shimmer" but candidate is "creme", score decreases
- Candidate display includes finish in parentheses: "OPI — Big Apple Red (creme)"

---

### Story 8: Voice Processing — Azure Speech-to-Text

**What:** Replace the stub in `voice.ts` with a real Azure Speech-to-Text call.

**Why:** M1 includes "optional audio hint" — speech-to-text button to say brand + shade as a hint. `voice.ts` is a complete stub (returns empty transcription).

**Where:**
- **Modify:** `packages/functions/src/functions/voice.ts`

**How:**

1. Implement the speech-to-text call using Azure Speech SDK REST API (no SDK install needed — use `fetch`):

```ts
async function transcribeAudio(audioBuffer: ArrayBuffer): Promise<string> {
  const speechKey = process.env.AZURE_SPEECH_KEY;
  const speechRegion = process.env.AZURE_SPEECH_REGION;

  if (!speechKey || !speechRegion) {
    throw new Error("Azure Speech credentials not configured");
  }

  const response = await fetch(
    `https://${speechRegion}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-US`,
    {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": speechKey,
        "Content-Type": "audio/wav",  // or detect from content-type header
        "Accept": "application/json",
      },
      body: audioBuffer,
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Speech-to-text failed: ${response.status} ${errorText}`);
  }

  const result = await response.json();
  return result.DisplayText || result.Text || "";
}
```

2. Replace the TODO in `processVoiceInput`:
```ts
const transcription = await transcribeAudio(audioData);
```

3. Add `withAuth` to the voice endpoint (currently missing):
```ts
app.http("voice-process", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "voice",
  handler: withCors(withAuth(processVoiceInput)),
});
```

**Acceptance criteria:**
- `POST /api/voice` with audio data returns a transcription string
- Returns 500 with clear error when `AZURE_SPEECH_KEY` is missing
- Supports WAV and WebM audio formats

---

### Story 9: Voice Processing — LLM Parse Transcription to Polish Details

**What:** After transcription, send the text to Azure OpenAI to extract structured polish details (brand, shade name, finish).

**Why:** The transcription "I have OPI Big Apple Red in creme finish" needs to be parsed into structured fields.

**Where:**
- **Modify:** `packages/functions/src/functions/voice.ts`
- **Reuse:** `packages/functions/src/lib/ocr-parser.ts` (the `parseLabelText` function from Story 2 can be reused, or a variant)

**How:**

1. After transcription, call the LLM parser:
```ts
import { parseLabelText } from "../lib/ocr-parser";

// After transcription...
const parsed = await parseLabelText(transcription);

const parsedDetails: ParsedPolishDetails = {
  brand: parsed?.brand ?? null,
  name: parsed?.shadeName ?? null,
  color: null,
  finish: parsed?.finish ?? null,
  collection: parsed?.collection ?? null,
  quantity: null,
  confidence: parsed?.confidence ?? 0,
};
```

2. Alternatively, if the voice-specific prompt should differ from label OCR parsing, create a dedicated function `parseVoiceTranscription()` in `ocr-parser.ts` with a system prompt tuned for spoken polish descriptions rather than label text.

**Acceptance criteria:**
- `POST /api/voice` with audio saying "Holo Taco Red Velvet crushed holo" returns parsed details: `{ brand: "Holo Taco", name: "Red Velvet", finish: "crushed holo", confidence: 0.9 }`
- Confidence reflects parsing quality
- Graceful degradation if OpenAI is unavailable (returns empty parsed details)

---

### Story 10: SAS Upload URL Generation

**What:** Generate short-lived Azure Blob Storage SAS upload URLs in the `capture/start` endpoint so clients can upload images directly to blob storage instead of sending base64 data URLs through the API.

**Why:** The `CaptureStartResponse.uploadUrls` field currently returns `[]`. Direct blob upload reduces API payload size (no base64 encoding overhead), enables larger images, and is required for the mobile app (where large payloads over cellular are problematic).

**Where:**
- **Modify:** `packages/functions/src/lib/blob-storage.ts` — add SAS generation function
- **Modify:** `packages/functions/src/functions/capture.ts` — call SAS generation in `startCapture()`

**How:**

1. Add SAS URL generation to `blob-storage.ts`:
```ts
import { createHmac } from "crypto";

export interface SasUploadUrl {
  uploadUrl: string;       // full URL with SAS token
  blobPath: string;        // container/path for reference
  expiresAt: string;       // ISO timestamp
}

export function generateSasUploadUrls(
  captureId: string,
  count: number = 6
): SasUploadUrl[]
```

2. Implementation:
   - Parse `AZURE_STORAGE_CONNECTION` for account name and key (reuse existing parsing logic in `blob-storage.ts`)
   - For each of `count` URLs, generate a unique blob name: `captures/{captureId}/{uuid}.{format}`
   - Compute SAS token manually (reuse HMAC pattern from existing `makeAuthHeader`):
     - Permissions: `cw` (create + write)
     - Expiry: 30 minutes from now
     - Service: blob
     - Resource type: blob
   - Return array of `SasUploadUrl` objects
   - If storage connection is not configured, return empty array (graceful degradation)

3. In `startCapture()`, call `generateSasUploadUrls()`:
```ts
const uploadUrls = generateSasUploadUrls(captureId, GUIDANCE_CONFIG.maxFrames);

const response: CaptureStartResponse = {
  captureId: result.rows[0].captureId,
  status: result.rows[0].status,
  uploadUrls: uploadUrls.map(u => u.uploadUrl),
  guidanceConfig: { ... },
};
```

**Acceptance criteria:**
- `POST /api/capture/start` returns `uploadUrls` array with 6 pre-signed URLs
- Each URL allows a PUT request to upload an image blob without additional auth
- URLs expire after 30 minutes
- When `AZURE_STORAGE_CONNECTION` is not set, returns empty array (no crash)

---

### Story 11: EXIF Stripping on Uploaded Images

**What:** Strip EXIF/metadata from uploaded images before storing them in blob storage.

**Why:** Section 1.4 of Epic 1 requires EXIF stripping for privacy. Nail/hand photos may contain GPS coordinates, camera model, timestamps, and other PII.

**Where:**
- **Modify:** `packages/functions/src/lib/blob-storage.ts`
- **Modify:** `packages/functions/package.json` (add dependency)

**How:**

1. Install `sharp`:
   ```bash
   cd packages/functions && npm install sharp
   ```
   (Note: `sharp` is the standard Node.js image processing library. It handles EXIF stripping efficiently.)

2. Add an `stripExif` function to `blob-storage.ts`:
   ```ts
   import sharp from "sharp";

   export async function stripExifFromBuffer(imageBuffer: Buffer): Promise<Buffer> {
     return sharp(imageBuffer)
       .rotate()          // auto-rotate based on EXIF orientation before stripping
       .withMetadata({})  // strip all EXIF data
       .toBuffer();
   }
   ```

3. In `uploadSourceImageToBlob()`, after downloading the image bytes and before uploading to blob:
   ```ts
   // Strip EXIF data for privacy
   let cleanBytes: Buffer;
   try {
     cleanBytes = await stripExifFromBuffer(Buffer.from(bytes));
   } catch {
     cleanBytes = Buffer.from(bytes);  // If sharp fails, use original
   }
   ```

4. In `capture.ts` `addCaptureFrame()`, when processing data URL images, strip EXIF before computing checksum:
   ```ts
   const rawBytes = Buffer.from(payload, "base64");
   const bytes = await stripExifFromBuffer(rawBytes);
   ```

**Acceptance criteria:**
- Uploaded images have EXIF data removed (no GPS, no camera info)
- Image orientation is preserved (auto-rotate before stripping)
- If `sharp` fails on a given image, the original bytes are used (no crash)

---

### Story 12: Web Rapid Add — Live Camera Capture

**What:** Replace the file-input-only capture UI with a live camera view using the browser's `navigator.mediaDevices.getUserMedia` API.

**Why:** M1 requires "rotate bottle until matched" UX. The current rapid-add page uses `<input type="file" capture="environment">` which opens the OS camera app. A live camera view allows real-time guidance and auto-capture of best frames.

**Where:**
- **Create:** `apps/web/src/components/camera-capture.tsx`
- **Modify:** `apps/web/src/app/rapid-add/page.tsx`

**How:**

1. Create `apps/web/src/components/camera-capture.tsx`:
   - Component props:
     ```ts
     interface CameraCaptureProps {
       onFrameCaptured: (frame: { blob: Blob; dataUrl: string; frameType: FrameType }) => void;
       onError: (error: string) => void;
       isActive: boolean;
     }
     ```
   - Implementation:
     - Use `useRef` for `<video>` and `<canvas>` elements
     - `useEffect` to request camera: `navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } } })`
     - Draw video frame to canvas on capture button press
     - Convert canvas to blob: `canvas.toBlob(callback, "image/jpeg", 0.85)`
     - Also convert to data URL: `canvas.toDataURL("image/jpeg", 0.85)`
     - Show camera preview in a `<video autoPlay playsInline muted>` element
     - Include a manual capture button (large circular button)
     - Include a close/stop button
     - Clean up: stop all tracks on unmount

2. Add a "Use Camera" button to `rapid-add/page.tsx` that toggles camera mode:
   ```tsx
   const [cameraActive, setCameraActive] = useState(false);

   // In JSX:
   {cameraActive ? (
     <CameraCapture
       isActive={cameraActive}
       onFrameCaptured={async (frame) => {
         if (!captureId) return;
         await addCaptureFrameFromFile(captureId, {
           frameType: frame.frameType,
           file: new File([frame.blob], "capture.jpg", { type: "image/jpeg" }),
           quality: { source: "web-camera" },
         });
       }}
       onError={(err) => setCaptureError(err)}
     />
   ) : (
     // Existing file input UI
   )}
   ```

3. Style the camera view:
   - Full-width video preview with rounded corners
   - Overlay with frame type selector (barcode/label/color tabs)
   - Large capture button (centered bottom)
   - Close button (top-right)

**Acceptance criteria:**
- User can tap "Use Camera" to open live camera preview
- Camera uses rear-facing camera on mobile devices
- User can capture a frame which is sent to the API
- Camera stream stops when user closes it or navigates away
- Falls back gracefully if camera permission is denied (shows error + keeps file input)

---

### Story 13: Web Rapid Add — On-Device Barcode Scanning

**What:** Add client-side barcode detection from the live camera feed using a JavaScript barcode library.

**Why:** M1 requires barcode-first matching. On-device scanning gives instant results without a server round-trip. The decoded GTIN should be sent as evidence in the frame's `quality_json`.

**Where:**
- **Create:** `apps/web/src/lib/barcode-scanner.ts`
- **Modify:** `apps/web/src/components/camera-capture.tsx`
- **Modify:** `apps/web/package.json` (add dependency)

**How:**

1. Install a barcode scanning library:
   ```bash
   cd apps/web && npm install @aspect-build/barcodes
   ```
   Or use the `BarcodeDetector` Web API (available in Chrome/Edge, polyfill for Safari/Firefox):
   ```bash
   cd apps/web && npm install barcode-detector
   ```

2. Create `apps/web/src/lib/barcode-scanner.ts`:
   ```ts
   export interface BarcodeScanResult {
     gtin: string;
     format: string;
   }

   export async function scanBarcodeFromCanvas(
     canvas: HTMLCanvasElement
   ): Promise<BarcodeScanResult | null> {
     // Use BarcodeDetector API
     if (!("BarcodeDetector" in window)) {
       // Load polyfill
       const { BarcodeDetector } = await import("barcode-detector");
       window.BarcodeDetector = BarcodeDetector;
     }

     const detector = new BarcodeDetector({
       formats: ["ean_13", "upc_a", "ean_8", "code_128"],
     });

     const barcodes = await detector.detect(canvas);
     if (barcodes.length === 0) return null;

     return {
       gtin: barcodes[0].rawValue,
       format: barcodes[0].format,
     };
   }
   ```

3. In `camera-capture.tsx`, run barcode scanning continuously on the video feed:
   ```ts
   useEffect(() => {
     if (!isActive) return;
     let cancelled = false;

     const scanLoop = async () => {
       while (!cancelled) {
         const canvas = canvasRef.current;
         const video = videoRef.current;
         if (canvas && video && video.readyState >= 2) {
           canvas.width = video.videoWidth;
           canvas.height = video.videoHeight;
           const ctx = canvas.getContext("2d")!;
           ctx.drawImage(video, 0, 0);

           const result = await scanBarcodeFromCanvas(canvas);
           if (result && !cancelled) {
             onBarcodeDetected(result);  // new callback prop
           }
         }
         await new Promise(r => setTimeout(r, 500));  // scan every 500ms
       }
     };

     scanLoop();
     return () => { cancelled = true; };
   }, [isActive]);
   ```

4. When barcode is detected:
   - Auto-capture a frame with `frameType: "barcode"` and include the decoded GTIN in quality:
     ```ts
     quality: {
       source: "web-barcode-detector",
       extracted: { gtin: result.gtin },
       barcodeFormat: result.format,
     }
     ```
   - Show a visual indicator (green checkmark overlay on camera preview)
   - Optionally auto-finalize if barcode is detected (since barcode matches are deterministic)

**Acceptance criteria:**
- Live camera continuously scans for barcodes (every 500ms)
- When EAN-13 or UPC-A barcode detected, GTIN is extracted and sent as frame evidence
- Visual indicator shows barcode was detected
- Works on Chrome, Edge, and Safari (via polyfill if needed)

---

### Story 14: Web Rapid Add — Capture Guidance UX

**What:** Add real-time visual guidance during the capture session: progress indicators, text prompts, and status feedback.

**Why:** M1 requires "progress indicators fill as evidence is collected: Barcode, Label text, Confidence" and prompts like "rotate", "tilt", "move closer".

**Where:**
- **Create:** `apps/web/src/components/capture-progress.tsx`
- **Modify:** `apps/web/src/app/rapid-add/page.tsx`

**How:**

1. Create `apps/web/src/components/capture-progress.tsx`:
   ```ts
   interface CaptureProgressProps {
     hasBarcode: boolean;
     hasLabelText: boolean;
     hasColorFrame: boolean;
     confidence: number | null;
     status: CaptureStatus | null;
     framesUploaded: number;
   }
   ```
   - Render a horizontal progress bar with 3 segments:
     - Barcode: green checkmark when detected, gray circle when not
     - Label: green checkmark when at least 1 label frame uploaded, gray when not
     - Confidence: percentage bar (green when >=92%, yellow when 75-92%, red when <75%)
   - Show text prompts based on state:
     - No frames: "Point camera at the bottle barcode"
     - Barcode found: "Barcode detected! Now show the label"
     - Label found: "Got it! Tap Finalize to match"
     - Low confidence: "Try rotating the bottle for a clearer label"
   - Use Tailwind classes for styling, consistent with existing components

2. Integrate into `rapid-add/page.tsx`:
   - Track evidence state from capture metadata:
     ```ts
     const hasBarcode = Boolean(captureMetadata?.pipeline?.ingest?.frameTypeCounts?.barcode);
     const hasLabelText = Boolean(captureMetadata?.pipeline?.ingest?.frameTypeCounts?.label);
     const confidence = captureMetadata?.pipeline?.finalize?.topConfidence ?? null;
     ```
   - Render `<CaptureProgress>` between the camera view and the session state card

**Acceptance criteria:**
- Progress bar shows 3 evidence segments with visual status
- Text prompts update based on what evidence has been collected
- Confidence percentage is shown after finalize attempt
- Styling matches existing component patterns

---

### Story 15: Web Rapid Add — Batch Mode ("Add Another")

**What:** After successfully matching and adding a polish, show a confirmation card with an "Add Another" button that resets the session for the next bottle.

**Why:** M1 requires "Add another batch mode" so users can onboard 25+ items in one session. The current page requires a manual page reload to start a new capture.

**Where:**
- **Modify:** `apps/web/src/app/rapid-add/page.tsx`

**How:**

1. Add a `sessionCount` state and a `resetForNextCapture()` function:
   ```ts
   const [sessionCount, setSessionCount] = useState(0);
   const [lastMatchDisplay, setLastMatchDisplay] = useState<string | null>(null);

   function resetForNextCapture() {
     setCaptureId(null);
     setCaptureStatus(null);
     setCaptureQuestion(null);
     setCaptureMetadata(null);
     setCaptureFrameFile(null);
     setCaptureBusy(false);
     setCaptureError(null);
     setCaptureAnswerInput("");
     setSessionCount((c) => c + 1);
   }
   ```

2. Show a confirmation card when status is "matched":
   ```tsx
   {captureStatus === "matched" && (
     <Card className="border-green-500/30 bg-green-50/50 dark:bg-green-950/20">
       <CardContent className="flex items-center justify-between py-4">
         <div>
           <p className="font-medium text-green-700 dark:text-green-400">
             Added to collection!
           </p>
           <p className="text-sm text-muted-foreground">
             Session #{sessionCount + 1} complete
           </p>
         </div>
         <div className="flex gap-2">
           <Button onClick={() => router.push(`/polishes/detail?id=${matchedInventoryId}`)}>
             View
           </Button>
           <Button variant="outline" onClick={resetForNextCapture}>
             Add Another
           </Button>
         </div>
       </CardContent>
     </Card>
   )}
   ```

3. Show session count in the page header when > 0:
   ```tsx
   {sessionCount > 0 && (
     <span className="text-sm text-muted-foreground">
       {sessionCount} added this session
     </span>
   )}
   ```

**Acceptance criteria:**
- After a match, green confirmation card shows with "View" and "Add Another" buttons
- "Add Another" resets all capture state and allows starting a new session immediately
- Session counter shows how many items were added in the current page visit
- Camera stays active between captures (if camera mode is enabled)

---

### Story 16: On-Device Image Quality Scoring (Web)

**What:** Add basic client-side image quality assessment for captured frames — blur detection, exposure check, and glare detection.

**Why:** M1 requires on-device "blur/glare/exposure scoring" and prompts like "Too much glare—tilt slightly." Quality scoring helps select the best frames and provides user feedback.

**Where:**
- **Create:** `apps/web/src/lib/image-quality.ts`
- **Modify:** `apps/web/src/components/camera-capture.tsx`

**How:**

1. Create `apps/web/src/lib/image-quality.ts`:
   ```ts
   export interface ImageQualityScore {
     blur: number;       // 0 = sharp, 1 = very blurry
     exposure: number;   // 0 = underexposed, 0.5 = good, 1 = overexposed
     glare: number;      // 0 = no glare, 1 = severe glare
     overall: number;    // 0 = poor, 1 = excellent
     feedback?: string;  // human-readable suggestion
   }

   export function assessImageQuality(
     canvas: HTMLCanvasElement
   ): ImageQualityScore
   ```

2. Implementation:
   - **Blur detection:** Compute Laplacian variance on grayscale image data. Low variance = blurry.
     ```ts
     const imageData = ctx.getImageData(0, 0, width, height);
     const gray = toGrayscale(imageData);
     const laplacianVariance = computeLaplacianVariance(gray, width, height);
     const blur = Math.max(0, 1 - laplacianVariance / 500);  // normalize
     ```
   - **Exposure:** Compute mean luminance. Too low = underexposed, too high = overexposed.
     ```ts
     const meanLuminance = gray.reduce((a, b) => a + b, 0) / gray.length;
     const exposure = meanLuminance / 255;  // 0-1, ideal around 0.4-0.6
     ```
   - **Glare:** Count pixels with luminance > 250. High percentage = glare.
     ```ts
     const brightPixels = gray.filter(v => v > 250).length;
     const glare = Math.min(1, (brightPixels / gray.length) * 10);
     ```
   - **Overall:** `overall = (1 - blur) * 0.4 + (1 - Math.abs(exposure - 0.5) * 2) * 0.3 + (1 - glare) * 0.3`
   - **Feedback:**
     - blur > 0.6: "Hold steady — image is blurry"
     - exposure < 0.2: "Too dark — move to better lighting"
     - exposure > 0.8: "Too bright — move away from direct light"
     - glare > 0.3: "Glare detected — tilt slightly"

3. In `camera-capture.tsx`, run quality assessment after each capture:
   ```ts
   const quality = assessImageQuality(canvas);
   if (quality.feedback) {
     setFeedbackMessage(quality.feedback);
   }
   // Include in frame quality
   onFrameCaptured({
     blob,
     dataUrl,
     frameType,
     quality: { ...quality, source: "web-quality-scorer" },
   });
   ```

4. Display feedback message as an overlay on the camera preview (semi-transparent banner at bottom).

**Acceptance criteria:**
- Blur, exposure, and glare scores are computed client-side
- Feedback messages appear as overlay text on camera preview
- Quality scores are sent to the server in `quality_json`
- Quality assessment runs in < 50ms per frame (no visible lag)

---

### Story 17: Mobile App — Rapid Add Foundation (Expo)

**What:** Build the initial mobile Rapid Add screen with camera, barcode scanning, and API integration.

**Why:** M1 specifies "Mobile live capture UX" as a core deliverable. The mobile app is currently an empty Expo scaffold.

**Where:**
- **Modify:** `apps/mobile/package.json` (add dependencies)
- **Create:** `apps/mobile/src/` directory structure
- **Create:** `apps/mobile/src/screens/RapidAddScreen.tsx`
- **Create:** `apps/mobile/src/lib/api.ts`
- **Modify:** `apps/mobile/App.tsx` (add navigation)

**How:**

1. Install required dependencies:
   ```bash
   cd apps/mobile
   npx expo install expo-camera expo-barcode-scanner expo-image-picker expo-file-system
   npx expo install @react-navigation/native @react-navigation/native-stack
   npx expo install react-native-screens react-native-safe-area-context
   ```

2. Create directory structure:
   ```
   apps/mobile/src/
     screens/
       RapidAddScreen.tsx
       HomeScreen.tsx
     lib/
       api.ts
     components/
       CaptureCamera.tsx
       CaptureProgress.tsx
   ```

3. Create `apps/mobile/src/lib/api.ts`:
   - Port the fetch wrappers from `apps/web/src/lib/api.ts`
   - Change `API_BASE_URL` to read from Expo config or env:
     ```ts
     import Constants from "expo-constants";
     const API_BASE_URL = Constants.expoConfig?.extra?.apiUrl || "http://localhost:7071/api";
     ```
   - Include the same capture endpoints: `startCapture`, `addCaptureFrame`, `finalizeCapture`, `getCaptureStatus`, `answerCaptureQuestion`
   - For frame upload, send base64 data URL (same format the backend accepts)

4. Create `apps/mobile/src/screens/RapidAddScreen.tsx`:
   - Use `expo-camera` for live camera preview
   - Use `expo-barcode-scanner` for continuous barcode scanning
   - On barcode detected:
     - Auto-capture frame
     - Send to API with GTIN in quality
     - Auto-finalize
   - Manual capture button for label/color frames
   - Question/answer UI (TextInput + buttons)
   - Confirmation card with "Add Another" button
   - Status polling (same pattern as web)

5. Create `apps/mobile/src/components/CaptureCamera.tsx`:
   - Wrap `expo-camera` with:
     - Barcode scanning overlay
     - Quality feedback text
     - Capture button
     - Frame type selector (barcode/label/color)

6. Update `App.tsx` to use React Navigation:
   ```tsx
   import { NavigationContainer } from "@react-navigation/native";
   import { createNativeStackNavigator } from "@react-navigation/native-stack";
   import HomeScreen from "./src/screens/HomeScreen";
   import RapidAddScreen from "./src/screens/RapidAddScreen";

   const Stack = createNativeStackNavigator();

   export default function App() {
     return (
       <NavigationContainer>
         <Stack.Navigator>
           <Stack.Screen name="Home" component={HomeScreen} />
           <Stack.Screen name="RapidAdd" component={RapidAddScreen} />
         </Stack.Navigator>
       </NavigationContainer>
     );
   }
   ```

7. Create `apps/mobile/src/screens/HomeScreen.tsx`:
   - Simple screen with "Rapid Add" button that navigates to RapidAddScreen
   - Will be expanded with inventory list in future milestones

**Acceptance criteria:**
- Mobile app launches with a home screen and "Rapid Add" button
- Rapid Add screen opens camera with barcode scanning
- Barcode detected → GTIN sent to API → auto-finalize → match result shown
- Manual frame capture works for label/color photos
- Question/answer flow works (candidate selection, text input, skip)
- "Add Another" resets for next bottle
- Works on iOS simulator and Android emulator

---

## Dependency Graph

```
Story 1 (OCR) ──┐
Story 2 (LLM) ──┼──→ Story 4 (Integrate into Finalize) ──→ Story 5 (Re-resolve after answer)
Story 3 (Barcode)┘                                           │
                                                              ↓
                                                        Story 6 (Match Explanation)
                                                              │
                                                        Story 7 (Finish Scoring)

Story 8 (Voice STT) ──→ Story 9 (Voice LLM Parse)

Story 10 (SAS URLs) ─── standalone, no deps
Story 11 (EXIF Strip) ── standalone, no deps

Story 12 (Web Camera) ──→ Story 13 (Web Barcode) ──→ Story 14 (Guidance UX)
                                                          │
                                                    Story 15 (Batch Mode)
                                                          │
                                                    Story 16 (Quality Scoring)

Story 17 (Mobile) ─── depends on Stories 1-7 being deployed (backend ready)
```

## Suggested Implementation Order

| Phase | Stories | Rationale |
|-------|---------|-----------|
| **Phase A: Backend Pipeline** | 1, 2, 3, 4, 5 | Core finalize pipeline — biggest M1 value |
| **Phase B: Backend Polish** | 6, 7, 8, 9, 10, 11 | Explanations, scoring, voice, uploads, privacy |
| **Phase C: Web UX** | 12, 13, 14, 15, 16 | Transform web rapid-add into "live capture" experience |
| **Phase D: Mobile** | 17 | Mobile app with camera capture |

## Environment Variables to Add

| Variable | Used By | Required? |
|----------|---------|-----------|
| `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT` | Story 1 (ocr.ts) | No — graceful degradation |
| `AZURE_DOCUMENT_INTELLIGENCE_KEY` | Story 1 (ocr.ts) | No — graceful degradation |
| `AZURE_OPENAI_DEPLOYMENT_LABEL` | Story 2 (ocr-parser.ts) | No — can reuse `AZURE_OPENAI_DEPLOYMENT_HEX` |

## Infrastructure Changes Needed

| Resource | Terraform Addition | Story |
|----------|-------------------|-------|
| Azure AI Document Intelligence | `azurerm_cognitive_account.document_intelligence` (kind = "FormRecognizer") | Story 1 |
| Azure OpenAI (label parsing deployment) | May reuse existing GPT-4o deployment, or add new deployment | Story 2 |

Add to `infrastructure/main.tf`:
```hcl
resource "azurerm_cognitive_account" "document_intelligence" {
  count               = var.enable_document_intelligence ? 1 : 0
  name                = "${local.base_name}-docint-${random_string.suffix.result}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  kind                = "FormRecognizer"
  sku_name            = "S0"
}
```

## Documentation Updates Required

Per CLAUDE.md "Documentation Maintenance" policy, update these files alongside implementation:

| Change | Update |
|--------|--------|
| New env vars (Document Intelligence, label deployment) | `CLAUDE.md` Environment Variables section + `packages/functions/README.md` |
| New lib modules (ocr.ts, ocr-parser.ts, barcode-decode.ts) | `packages/functions/README.md` |
| New web components (camera-capture, capture-progress) | `apps/web/README.md` components section |
| New mobile screens | `apps/mobile/README.md` (create if needed) |
| Infrastructure additions | `infrastructure/README.md` resource table |
| Updated shared types (MatchExplanation) | `packages/shared/README.md` type catalog |
| Rapid-add route enhancements | Web App Routes table in `CLAUDE.md` |

## Success Metrics (from backlog)

- Median time per bottle: **< 5s** with barcode, **< 10s** without
- User can onboard at least **25 items** in one session (batch mode)
- Auto-match rate: **> 70%** for common brands
- False-match rate: **< 1%**
