Nail Polish Knowledge Graph

Implementation Guide: Data Model, Matching Strategy, Swatches, and Inventory-Driven Contributions


Version: 1.0   |   Date: 2026-02-06   |   Audience: Implementing agent (backend + data + ML)


# 1. Goals and Non-Goals

Primary goals (in order):

- High-quality shade catalog: brand, line, shade names, finishes, collections, swatches, dupes/similarity.
- Ingredients and label facts with provenance + versioning (formulas change).
- UPC/GTIN/barcodes and basic product attributes for sellable items (SKUs).
- User inventory tracking; user actions can propose new canonical data or vetted edits with confidence.
- Matches evolve as more data arrives (active learning + evidence graph).
Non-goals (initially):

- Perfect global coverage for every limited edition polish on day one.
- Redistributing copyrighted swatch images without explicit rights (support link-only and user-owned uploads).
- Real-time sales popularity (requires paid syndicated data).
# 2. Key Concepts and Entities

Keep identities separate:

- Shade: the color concept (what people talk about).
- SKU: the sellable item (size/region/bundle).
- Label/Formula: ingredient list + claims for a SKU at a point in time.
- Swatch: visual evidence tied to a shade (preferred) or SKU (fallback).
Primary join key when present is GTIN/UPC (barcode), which maps best to SKU, not always shade.

# 3. System Architecture (Recommended)

- Backend API (single source of truth): canonical DB + matching resolver + caching.
- Ingestion workers: pull from upstream sources (open datasets, partners) and refresh periodically.
- User contribution pipeline: inventory adds and edits create proposals; auto-apply only with strong evidence.
- Search: trigram + full-text for names; vector similarity for swatches/dupes.
- Storage: object store for user-owned images; keep link-only for restricted sources.
Principle: clients never call third-party sources directly; backend federates, normalizes, caches, and enforces terms.


# 4. ER Diagram (Logical)

Text-based ER diagram (main tables):

```

[brand] 1---n [product_line] 1---n [shade] 1---n [swatch] n---1 [image_asset]
   \                      \              \
    \                      \              n---n [shade_alias]
     \                      \
      n---n [brand_alias]     1---n [sku] 1---n [barcode]
                               |
                               1---n [label_document] 1---n [label_ingredient] n---1 [ingredient]
                               |
                               1---n [label_claim] n---1 [claim]

[source] 1---n [source_record] 1---n [match_candidate] 1---n [match_decision]
[source_record] 1---n [entity_link] (to canonical entities, with evidence/confidence)

[app_user] 1---n [user_inventory_item] n---1 [sku] (nullable) / n---1 [shade] (nullable)
[app_user] 1---n [user_submission] 1---n [proposal_patch] (staged canonical changes)
```

# 5. Data Model (Canonical Schema)

Store raw upstream payloads and normalize into canonical tables. Version ingredient lists. Keep provenance everywhere.

## 5.1 Table Overview

| Area | Tables | Purpose (short) |
| --- | --- | --- |
| Provenance | source, source_record | Origin, license, raw JSON; reprocessing. |
| Catalog | brand, *_alias, product_line, shade, sku, barcode | Shade/SKU graph; barcode joins. |
| Labels | label_document, ingredient, label_ingredient, claim, label_claim | Versioned INCI + claims. |
| Media | image_asset, swatch, color_features | Swatches + normalized chips + embeddings. |
| Matching | entity_link, match_candidate, match_decision | Resolver evidence + learning loop. |
| Users/Inventory | app_user, user_inventory_item, inventory_event | Personal inventory + audit trail. |
| Contrib | user_submission, submission_*, proposal_patch | Staged adds/edits with confidence. |


# 6. Matching and Identity Resolution (Evolving)

Matching is a resolver service that maps source/user records to canonical entities. It stores evidence and decisions, and it improves over time via active learning.

## 6.1 Deterministic Matching (High Precision)

- GTIN/UPC present: map barcode.gtin -> sku_id. If conflict: create a collision case for review (do not overwrite).
- Exact normalization: brand/product_line/shade canonicalization using curated + learned aliases.
- Hard keys (when present): (brand_id, product_line_id, shade_name_normalized, finish).
## 6.2 Fuzzy Text Matching (Shade-centric)

Used when barcodes are absent (common in shade catalogs).

- Candidate generation: filter by brand (required unless unknown), then product_line; then trigram search over shade_name.
- Feature scoring (0..1): shade_name similarity, finish match, collection similarity, year distance, product_line match strength.
- Decision thresholds: >=0.92 auto-accept, 0.75-0.92 propose for user/mod review, <0.75 keep unlinked.
Recommended implementation: Postgres pg_trgm (similarity / % operator) + small rule-based normalizer.

```

-- Example: shade candidates (brand constrained)
SELECT shade_id, shade_name_canonical,
       similarity(shade_name_canonical, :q) AS s
FROM shade
WHERE brand_id = :brand_id
  AND (product_line_id = :line_id OR :line_id IS NULL)
  AND shade_name_canonical % :q
ORDER BY s DESC
LIMIT 20;
```

## 6.3 Image-assisted Matching (Swatches)

- Compute normalized swatch chips and embeddings (vector).
- Use pgvector ANN search to find visually similar swatches; combine with text score.
- Total score example: 0.55 * text + 0.30 * embedding_sim + 0.15 * color_distance_score.
```

-- Example: nearest neighbors for dupes (cosine distance)
SELECT s.shade_id, sw.swatch_id,
       1 - (cf.embedding <=> :query_embedding) AS embedding_sim
FROM color_features cf
JOIN swatch sw ON sw.swatch_id = cf.swatch_id
JOIN shade s ON s.shade_id = sw.shade_id
ORDER BY cf.embedding <=> :query_embedding
LIMIT 25;
```

## 6.4 Evidence Graph and Learning Loop

- Every accepted/rejected match becomes a labeled example (train a lightweight model to tune weights).
- Alias learning: repeated confirmations promote aliases (with cooldown and rollback).
- Graph reinforcement: confirmed barcode->SKU->Shade boosts future matching confidence.
- Multi-source corroboration: independent agreement increases auto-apply confidence for proposed patches.
# 7. User Inventory and Contribution Pipeline

Users track personal inventory. Adding a polish triggers matching immediately. New facts and edits flow through proposals that can auto-apply only when 'probably accurate'.

## 7.1 Inventory Model (User-owned)

- Inventory items are user-owned records; they may link to canonical SKU and/or Shade.
- Inventory supports purchase info, condition, quantity, notes, usage, and lifecycle (sold/decluttered).
- Inventory actions create events (audit trail) and may generate canonical proposals (opt-in).
## 7.2 Add Flow (Always Attempt a Match)

Inputs: barcode scan, manual brand+shade, photos (bottle/label/swatch), or import list.

1. If barcode provided: lookup barcode.gtin. If found, link SKU (and Shade if known). If not found, stage new SKU and enrich from upstream + user media.

2. If brand+shade provided: fuzzy match to Shade; show top candidates with match explanations; allow user confirm/create new.

3. If photos provided: run OCR for label + brand/shade text; run swatch extraction for nail/swatch photos; generate additional match candidates.

## 7.3 “Probably Accurate” Canonical Updates

Canonical data is curated. User edits become proposals with evidence and confidence.

Confidence signals (examples):

  - Barcode scan present (strong).
  - High OCR quality + clear label photo (strong).
  - Multiple users submit the same fact independently (strong).
  - User trust score (history of accepted contributions).
  - Consistency with existing canonical data (no contradictions).
Auto-apply policy (example):

  - Auto-apply if confidence >= 0.97 and (user_trust >= 0.8 OR corroborated_by >= 2 independent sources/users).
  - Otherwise queue for moderation/review.
Always store evidence (photos, extracted text, upstream ids) with the proposal.

## 7.4 Canonical Conflict Handling

- Barcode collision: two SKUs claim same GTIN. Create a collision case; do not auto-merge.
- Shade ambiguity: generic names ('Cherry Red') require stricter thresholds; prefer user-confirmed + swatch evidence.
- Reformulation: store a new label_document with effective dates; never overwrite historical INCI.
## 7.5 User Trust Scoring (Optional)

- Initialize low; increase with accepted contributions; decrease with rejected or reverted ones.
- Track trust by domain: barcodes, names/aliases, ingredient OCR.
- Trust never bypasses licensing restrictions.
# 8. Swatch Ingestion and AI Pipeline

Store originals, generate normalized chips, and compute features for search and dupes.

## 8.1 Asset Handling

- Store originals in object storage; record checksum (sha256) for dedupe.
- Generate thumbnails and a normalized derivative (cropped chip) for comparison.
- Copyright: user uploads are user-owned; external images should be link-only unless licensed.
## 8.2 Normalization Pipeline (Deterministic + ML)

1. Validate image (type/size). Sanitize metadata. Store original.

2. Identify swatch region (MVP: heuristic crop + optional manual crop UI; next: segmentation for nail photos).

3. Color normalization (white balance + exposure normalization; store parameters).

4. Compute features (avg RGB, CIELAB, dominant hex; HSV; sparkle/shimmer heuristics).

5. Compute embedding (vision model embedding for similarity/dupes).

6. Quality scoring (blur/exposure/glare/background); flag low-quality.

7. Persist swatch + color_features + derived normalized image.

## 8.3 AI Roadmap

- Finish classification (creme/jelly/shimmer/holo/glitter) from normalized chips.
- Dupe search: kNN over embeddings + constrained by finish; explain with color delta (Delta E).
- Ingredient OCR + INCI parsing from label photos; always show extracted text + confidence + original label image.
- Active learning: use user confirmations to refine thresholds and retrain lightweight models.

# 9. API Contracts (Representative)

Backend provides a unified API. Upstream integrations are server-side only.

## 9.1 Lookup and Search

```

GET /v1/lookup/barcode/{gtin}
  -> { sku, shade?, labels[], images[], match_explanations[] }

GET /v1/search/shades?q=...&brand=...&finish=...&limit=...
  -> { results: [ {shade, top_swatch, similarity_meta} ] }

GET /v1/shades/{shade_id}
GET /v1/skus/{sku_id}
```

## 9.2 Inventory

```

POST /v1/inventory/items
  body: { gtin?, brand?, product_line?, shade_name?, photos[] , notes? }
  -> { inventory_item,
       canonical_match: {status, candidates[], accepted?},
       proposals_created[] }

GET /v1/inventory/items?user=me
PATCH /v1/inventory/items/{id}
```

## 9.3 Contributions / Proposals

```

GET /v1/proposals?status=pending
POST /v1/proposals/{id}/decide  body: { accept|reject, notes? }
```


# 10. Postgres Schema

A full DDL file is included separately as `docs/schema.sql`. This section shows the key extensions and the most important tables for matching (shade, sku, barcode, swatch, entity_link).

```

-- Extensions
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;

-- Key tables (excerpt)
CREATE TABLE shade (...);
CREATE TABLE sku (...);
CREATE TABLE barcode (... UNIQUE(gtin) ...);
CREATE TABLE swatch (...);
CREATE TABLE color_features (... embedding vector(512) ...);
CREATE TABLE entity_link (... confidence, evidence_json ...);

-- Recommended indexes
CREATE INDEX idx_shade_name_trgm ON shade USING GIN (shade_name_canonical gin_trgm_ops);
CREATE INDEX idx_swatch_embedding ON color_features USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
```

# 11. Matching Resolver (Add-to-Inventory) Pseudocode

```

function addInventoryItem(user_input):
  inventory_item = create inventory_item (unlinked)
  submission = create user_submission(type='add_polish', source_context=user_input)

  if user_input.gtin:
    sku = find sku by barcode.gtin
    if sku exists:
      link inventory_item.sku_id = sku.id
      if sku.shade_id exists: link inventory_item.shade_id
      return {status:'accepted', sku, shade?}
    else:
      stage new SKU record; enqueue enrichment (upstream lookup + OCR if photos)
      candidates = generateSkuCandidates(user_input)
      return {status:'needs_confirm', candidates}

  candidates = generateShadeCandidates(user_input)
  if candidates.top.score >= AUTO_ACCEPT_THRESHOLD:
    link inventory_item.shade_id = candidates.top.id
    return {status:'accepted', shade=candidates.top}
  else:
    return {status:'needs_confirm', candidates}

  if photos:
    swatch = runSwatchPipeline(photos)  # normalization + features + embedding
    ocr = runLabelOCR(photos)
    create proposal_patches from extracted facts with evidence + confidence
```

# 12. Operational Notes

- Caching: cache barcode lookups and upstream calls; refresh asynchronously; track last_seen.
- Moderation: review queue for low-confidence proposals and barcode collisions; support rollback.
- Auditability: never mutate without an audit trail (proposal decisions + provenance).
- Privacy: user inventory private by default; user media sharing is explicit and revocable.
- Safety: sanitize uploads; rate-limit submissions; store minimal PII.
# 13. Suggested Milestones

- M1: Canonical DB + barcode lookup + inventory CRUD + user uploads (manual linking).
- M2: Fuzzy shade search + match candidates + user confirmation UX; proposal pipeline.
- M3: Swatch normalization + embeddings + dupe search; label OCR ingestion to versioned label_document.
- M4: Active learning loop (weight tuning), trust scoring, multi-source corroboration, moderation UI.

# 14. User-Facing Matching UX and Private Media

Users should be able to add an item to their inventory using natural language (e.g., “Holo Taco’s Red Velvet polish”). The system attempts to match to canonical data first; if it cannot match confidently, it asks for the minimum additional detail needed (barcode, finish/line, or photos).

## 14.1 Text-first add flow

- Parse + normalize: brand candidate(s), shade/product phrase, optional finish/line hints.
- Generate candidates: constrain by brand, then product line, then shade name (trigram/token similarity + aliases).
- Score + decide: auto-accept high-confidence matches; otherwise present top candidates with explanations; allow “create new” as a pending proposal.
## 14.2 When matching confidence is low, ask for details (least friction first)

- Pick the closest match from the top candidates (fastest).
- Add finish/line (“crushed holo”, “creme”, etc.).
- Scan barcode (best for SKU + ingredients).
- Upload bottle/label photo (OCR ingredients + verify).
- Upload swatch or nail photo (visual matching / dupe search).
## 14.3 Media storage and privacy rules

- All uploaded images are stored as user-owned media by default (tied to the user’s inventory/submission).
- Nail photos default to PRIVATE and are not used to improve the global catalog unless the user explicitly opts in.
- Swatch photos may be opt-in to contribute to the catalog. Only contributed (opt-in) swatches become globally searchable and can be linked to canonical shade_id.
- Embeddings/features can be computed server-side for matching. For private images, keep embeddings private (or enforce strict ACLs) to prevent cross-user leakage.
- Always display provenance and “why we matched” explanations, especially when AI was used (text similarity, barcode evidence, image similarity).
## 14.4 Match explanation payload (example)

```

{
  "status": "accepted|needs_confirm|unmatched",
  "accepted": { "entity_type": "shade|sku", "id": 123, "confidence": 0.94 },
  "candidates": [
    {
      "entity_type": "shade",
      "id": 123,
      "display": "Holo Taco — Red Velvet (Crushed Holo)",
      "confidence": 0.86,
      "why": {
        "brand_match": true,
        "name_similarity": 0.82,
        "finish_match": 1.0,
        "image_similarity": 0.0,
        "barcode_match": false
      }
    }
  ],
  "next_best_actions": ["scan_barcode", "add_finish", "upload_label_photo"]
}
```


# 15. AI-Assisted Matching (Resolver Design)

Use AI as one signal in a deterministic resolver—not as a single decision-maker. The resolver must remain explainable, auditable, and safe: it should always be able to show why it matched, and it should never silently overwrite canonical truth.

## 15.1 Pipeline Overview

- 1) Candidate generation (fast, deterministic): database search constrained by brand/product_line; barcode lookup when present.
- 2) AI-assisted parsing + enrichment: extract structured fields from user text; OCR label photos; compute swatch embeddings/features.
- 3) Scoring: combine text similarity, structured feature agreement, image similarity, barcode evidence, and provenance signals.
- 4) Decision policy: auto-accept only above high threshold; otherwise present candidates + next-best-actions; allow 'create new' proposal.
## 15.2 AI Components and Responsibilities

- LLM text parser: turns free-form user input into structured fields (brand, shade_name, finish, product_line, intent).
- Vision embeddings: represent swatch/nail/bottle images for similarity search and dupe discovery.
- Color science features: CIELAB averages + Delta E; sparkle/shimmer heuristics to reduce false dupes.
- OCR + INCI normalizer: extract ingredient lists and normalize to canonical INCI ingredient entities; extract claims with confidence.
- Learning loop: use accepted/rejected match decisions to tune weights and thresholds (lightweight model recommended).
## 15.3 Contracts (What the AI Returns)

LLM parsing contract (example):

```

{
  "intent": "add_inventory|search|add_swatch|add_label",
  "brand": { "value": "Holo Taco", "confidence": 0.98 },
  "shade_name": { "value": "Red Velvet", "confidence": 0.90 },
  "product_line": { "value": null, "confidence": 0.00 },
  "finish": { "value": "crushed holo", "confidence": 0.55 },
  "hints": { "size_ml": null, "country_market": null },
  "raw": "holo taco's red velvet polish"
}
```

Vision scoring contract (example):

```

{
  "image_id": 9912,
  "embedding_dim": 512,
  "quality": { "blur": 0.08, "glare": 0.12, "exposure": 0.74, "score": 0.83 },
  "color": {
    "avg_lab": [52.1, 43.0, 22.2],
    "dominant_hex": "#9b1f2a"
  },
  "nearest_swatches": [
    { "swatch_id": 1201, "shade_id": 123, "cosine_sim": 0.88, "delta_e": 3.2 },
    { "swatch_id": 3310, "shade_id": 555, "cosine_sim": 0.86, "delta_e": 4.1 }
  ]
}
```

## 15.4 Scoring Model (How Confidence is Computed)

Compute a final match probability from independent signals. Start with a rule-based weighted sum, then learn weights from decisions.

- TextScore: trigram similarity on shade name + token overlap + alias hits (0..1).
- FieldAgreement: finish/line/collection agreement (0..1).
- ImageScore: max(cosine similarity) adjusted by image quality and Delta E (0..1).
- BarcodeEvidence: 1.0 if GTIN matches canonical SKU; otherwise 0.0 (do not guess).
- ProvenanceBonus: corroboration from multiple sources/users (+), conflicts (-).
Example scoring formula (starter):

```

total =
  0.55 * TextScore +
  0.15 * FieldAgreement +
  0.25 * ImageScore +
  0.05 * ProvenanceBonus

-- Override rules:
if BarcodeEvidence == 1.0:
  total = 1.0
if conflict_detected (e.g., GTIN collision):
  total = min(total, 0.60) and require review
```

## 15.5 Decision Thresholds and UX

Suggested thresholds (tune per brand/category):

- Auto-accept: total >= 0.92 AND no conflicts AND (not a generic shade name OR strong corroboration).
- Needs confirmation: 0.75 <= total < 0.92 (show top 3–10 candidates with explanations).
- Unmatched: total < 0.75 (ask for minimal additional detail).
Next-best-actions when not auto-accepted (least friction first):

- Pick closest candidate from the list.
- Add finish/line hint.
- Scan barcode (best for SKU + ingredients).
- Upload bottle/label photo (OCR verification).
- Upload swatch/nail photo (visual match/dupes).
## 15.6 Explainability Requirements

- Always return a 'why' breakdown: which signals contributed and by how much.
- Always provide provenance: which sources and timestamps informed the suggestion.
- Never hide AI uncertainty: show confidence and a human-friendly explanation.
Match explanation response (example):

```

{
  "status": "needs_confirm",
  "candidates": [
    {
      "entity_type": "shade",
      "id": 123,
      "display": "Holo Taco — Red Velvet (Crushed Holo)",
      "confidence": 0.86,
      "why": {
        "text_score": 0.82,
        "field_agreement": 0.65,
        "image_score": 0.00,
        "barcode_evidence": 0.00,
        "provenance_bonus": 0.05
      }
    }
  ],
  "next_best_actions": ["add_finish", "scan_barcode", "upload_label_photo"]
}
```

## 15.7 Learning Loop (Matches Improve Over Time)

- Persist every user choice: accepted candidate, rejected candidates, and any manual corrections.
- Train a lightweight classifier (logistic regression / gradient boosted trees) using score_breakdown features to predict P(match).
- Update alias tables from repeated confirmations (with cooldown + rollback).
- Use graph reinforcement: confirmed SKU↔Shade links boost future matches involving those nodes.
- Monitor drift: if a brand reuses shade names or changes formulas, raise thresholds and require more evidence.
## 15.8 Privacy and Safety for AI Matching

- Private-by-default: nail photos and inventory media stay private unless user opts into sharing/contributing.
- Embeddings for private images must be protected by ACLs; do not use them for cross-user search unless explicitly shared.
- Avoid storing unnecessary PII in image metadata; sanitize uploads and strip EXIF by default (store only needed fields).
- Rate-limit and abuse-protect OCR/LLM endpoints; store provenance of extracted text and confidence.
## 15.9 Implementation Checklist (MVP)

- Implement deterministic candidate generation (brand/line constrained pg_trgm search; GTIN lookup).
- Add LLM parsing endpoint returning structured JSON with per-field confidence.
- Add swatch pipeline producing embeddings + CIELAB features; implement pgvector ANN search.
- Implement score_breakdown storage and match_decision logging.
- Implement decision policy + match explanations in API responses.

# 16. Adaptive Clarifying Questions (Inventory Add UX)

When a user adds a polish to their inventory, the assistant should proactively ask the smallest set of questions needed to (a) find the correct canonical match and (b) fill missing critical data (barcode/SKU attributes, ingredients, swatches). To the user, this should feel natural—like the assistant is being careful and helpful—not like a form.

## 16.1 Principles

- Minimize friction: ask 1 question at a time; stop as soon as confidence is high enough.
- Maximize information gain: ask the question that best separates the top candidates or fills a required missing field.
- Be honest but lightweight: phrases like “Quick check to make sure I have the right one…” feel natural and transparent.
- Offer skip paths: let users proceed with an “Unknown/Skip” option and keep the inventory item linked as pending.
- Respect privacy: nail photos are private by default; explicitly ask before using/sharing them for catalog improvements.
## 16.2 Triggers (When to Ask Questions)

- No canonical match found (unmatched) OR top candidate confidence below threshold.
- Multiple plausible matches with close scores (ambiguity).
- Critical fields missing for the linked entity: missing GTIN/SKU, missing ingredients/label document, missing finish/line, missing size/market.
- Conflict detected (e.g., barcode collision, contradictory size/market) — require review/confirmation.
## 16.3 Question Selection Strategy (Information Gain)

Maintain a candidate set and choose the next question that most reduces uncertainty.

```

Inputs:
  candidates = [ {id, score, fields...}, ... ]  # top N matches
  missing_required = [gtin?, size_ml?, country_market?, inci?, ...]
  user_context = { has_camera?, wants_to_contribute?, ... }

Pick next question:
  if user provided GTIN: resolve deterministically (no questions unless conflict)
  else if candidates.size == 0:
      ask for barcode OR label photo OR brand confirmation
  else if top_score >= AUTO_ACCEPT and gap_to_second >= GAP_THRESHOLD and no missing_required:
      accept match; optionally ask opt-in contribution questions
  else:
      compute which attribute (finish/line/size/collection) best partitions candidates
      ask about that attribute (multiple choice if possible)
  if missing_required includes ingredients:
      ask for barcode scan OR label photo (lowest friction first)
```

## 16.4 Suggested Question Bank (Copy-ready)

- Disambiguation (text): “Quick check—do you mean **Red Velvet** the *crushed holo* or a *creme* version (if any)?”
- Brand confirmation: “Just to confirm, is the brand **Holo Taco**?”
- Finish/line: “Do you know the finish (creme, shimmer, holo, glitter, jelly)?”
- Barcode (best): “If you can, scan the barcode—then I can pull the exact product details and ingredients.”
- Bottle/label photo: “Want to snap a photo of the ingredient label? I can read it and save the INCI list.”
- Size/market: “What size is the bottle (e.g., 12ml) and where did you buy it (US/UK/EU)?”
- Set vs single: “Is this a single polish or part of a set/bundle?”
- Swatch/nail photo (optional): “If you’d like, you can add a swatch or nail photo—helps with dupes and visual search.” (PRIVATE by default)
- Catalog contribution opt-in: “Want to share this swatch with the community catalog? You can keep it private too.”
## 16.5 How It Should Feel (Example Dialog)

```

User: "holo taco's red velvet polish"
Assistant: "Got it. Quick check to make sure I match the right one—do you know if it's the crushed holo formula?"
User: "yeah crushed holo"
Assistant: "Perfect. I’m matching that to Holo Taco — Red Velvet (Crushed Holo). If you can scan the barcode, I can also pull the exact ingredients—want to do that now? (You can skip.)"
User: "skip"
Assistant: "No problem. Added to your inventory. If you ever add a label photo later, I’ll fill in the ingredient list automatically."
```

## 16.6 Data + API Shape (for Implementation)

```

# Backend returns one question at a time (or none if accepted)
{
  "inventory_item_id": 777,
  "match": { "status": "needs_confirm", "top_confidence": 0.84, "candidates": [...] },
  "question": {
    "id": "finish",
    "prompt": "Quick check—what finish is it?",
    "type": "single_select",
    "options": ["creme", "jelly", "shimmer", "crushed holo", "glitter", "not sure"],
    "why": "This will disambiguate 3 close matches",
    "can_skip": true
  }
}
```

## 16.7 Guardrails

- Never fabricate missing facts; ask or leave unknown.
- Never auto-share a user’s nail photo; default private; explicit opt-in for any catalog contribution.
- When asking for images, say what it’s for (“to read ingredients”, “to improve matching”) and allow skip.
- Prefer barcode for SKU/ingredients; prefer swatches for shade similarity/dupes.

# 17. Live Capture Onboarding Mode (Fast Collection Add)

Goal: let users onboard large collections quickly by using the camera (and optional audio) to capture enough evidence to match a polish, with minimal typing. UX feels like “just rotate the bottle until it’s recognized.”

## 17.1 User Experience (Happy Path)

- User taps **Rapid Add**.
- Camera opens with guidance: “Slowly rotate the bottle.”
- Progress indicators fill as evidence is collected: Barcode ✓, Label text %, Confidence %.
- App auto-captures best frames; user does not have to press a shutter.
- Once match confidence is high: show confirmation card and **Add** (and optionally “Add another”).
## 17.2 Why This Works (Evidence Order)

- 1) Barcode/GTIN → deterministic SKU match (fastest, highest confidence).
- 2) Label OCR (brand + shade name + finish keywords) → fuzzy match to canonical Shade.
- 3) Audio hint (spoken brand/shade) → narrows candidates and reduces OCR dependence.
- 4) Visual similarity (optional swatch/bottle contents) → helps when names are generic or OCR fails.
## 17.3 Architecture Principle: “Live” UX without Full Video Streaming

Treat it as live guidance on-device. Upload only a small set of “best frames” (or a short 2–3s clip when needed). This reduces bandwidth and improves privacy while preserving the “live scan” feel.

- On-device: continuous quality checks + region detection + barcode attempts + UI guidance.
- Server-side: heavy OCR + entity resolution + provenance + caching + question selection.
## 17.4 Capture State Machine (MVP)

```

States:
  SEARCH_BARCODE -> SEARCH_LABEL -> CONFIRM_EVIDENCE -> MATCHED | NEEDS_QUESTION | UNMATCHED

Transitions (examples):
  SEARCH_BARCODE: if gtin decoded -> MATCHED (or CONFIRM_EVIDENCE if conflict)
  SEARCH_LABEL: if high-quality label frames gathered -> CONFIRM_EVIDENCE
  CONFIRM_EVIDENCE: run OCR + parse + resolver
    if confidence >= auto_accept and no missing critical -> MATCHED
    else if candidates exist -> NEEDS_QUESTION
    else -> UNMATCHED
```

## 17.5 On-Device Capture Guidance (What the User Sees)

- Real-time prompts: “Too much glare—tilt slightly”, “Move closer”, “Rotate to barcode side.”
- A capture ring / progress bar showing: Barcode, Label, Confidence.
- Auto-freeze when enough evidence is collected; show a quick confirmation card.
- Batch mode: after add, return immediately to camera for next bottle.
## 17.6 Data Captured (Minimum Set)

- Best barcode frame (or decoded GTIN if available).
- 2–6 best label frames (front label + shade name area).
- Optional: 1 frame that best shows polish color/finish.
- Optional: short audio transcript (brand + shade) used as a hint.
- All captured media is user-owned and private by default.
## 17.7 When It Can’t Match Confidently (Adaptive Questions)

- Ask only 1 question at a time that maximizes information gain (finish, confirm brand, barcode, label photo).
- Keep tone natural: “Quick check to make sure I’ve got the right one…”
- If missing ingredients/label: prefer barcode scan or label photo request.
- Always allow skip; keep inventory item pending/unlinked until later.

# 18. Azure-First, Serverless-Heavy Reference Architecture

This section describes a practical Azure implementation that minimizes server management. Core idea: API + workflows on Azure Functions, media in Blob Storage, AI via managed Azure AI services, and search via a managed vector/hybrid search service or DB-native vector functions.

## 18.1 Core Azure Services (Suggested)

- API Layer: **Azure API Management** in front of **Azure Functions** (HTTP triggers).
- Workflows: **Durable Functions** for long-running ingestion (OCR, matching, enrichment) and “question/answer” loops.
- Queue/Eventing: **Azure Service Bus** and/or **Event Grid** for async fan-out (new media uploaded, new capture session finalized).
- Media Storage: **Azure Blob Storage** (original images/video snippets, thumbnails, normalized swatches).
- Relational Canonical Store: **Azure Database for PostgreSQL (Flexible Server)** or **Azure SQL / SQL Managed Instance**.
- Search/Index: **Azure AI Search** for full-text + vector + hybrid search (optional, highly effective).
- Observability: **Application Insights** + distributed tracing.
## 18.2 AI Services on Azure (Managed)

- Speech-to-text (optional): **Azure AI Speech** to transcribe “brand + shade” while scanning.
- OCR: **Azure AI Vision** or **Azure AI Document Intelligence** for label text extraction.
- LLM parsing + dialog: **Azure OpenAI** for structured extraction and natural clarifying questions.
- Embeddings: **Azure OpenAI embeddings** or a vision embedding model hosted on **Azure AI / ML** (managed).
## 18.3 Data Stores and Vector Search Options

- Option A (simple): Postgres + pg_trgm + pgvector in Azure Database for PostgreSQL; keep it all in one DB.
- Option B (managed search): Azure AI Search for hybrid (keyword+vector) shade search and dupe search; canonical data stays in Postgres/SQL.
- Option C (SQL-native vectors): Azure SQL / SQL Managed Instance with vector features for embeddings + vector index (useful if you standardize on SQL).
For MVP, Option A is fastest to wire up end-to-end; Option B scales search quality with less custom search code.

## 18.4 Serverless Workflows (Durable Functions) You’ll Want

```

Orchestration examples:
  - capture_finalize_orchestrator(capture_id)
      1) fetch best frames from Blob
      2) run OCR (Vision / Document Intelligence)
      3) run LLM parse (structured extraction)
      4) run resolver candidate generation + scoring
      5) if MATCHED -> create inventory item linked to canonical entities
      6) if NEEDS_QUESTION -> persist question + wait for external event (answer)
      7) if UNMATCHED -> create pending record + ask for barcode/label

  - swatch_pipeline_orchestrator(image_id)
      normalize -> features -> embedding -> store -> update search index
```


# 19. MVP Implementation Plan (Working Onboarding + Inventory)

MVP definition: users can rapidly onboard their collection using camera (with optional audio hints), add items to their personal inventory, and the system will (a) match to canonical entries when possible and (b) ask minimal clarifying questions when it cannot. Images are stored private-by-default.

## 19.1 MVP Scope (Ship This First)

- Rapid Add capture UI: rotate bottle, progress indicators, auto-capture best frames.
- Barcode-first matching: decode GTIN if present; fallback to label OCR + fuzzy shade match.
- Adaptive single-question loop when uncertain or when critical data is missing (barcode/finish).
- Inventory CRUD: list/search user inventory; basic fields (qty, notes).
- Media storage: user-owned images in Blob; private by default.
- Audit: log match decisions (accepted/rejected) for learning later.
## 19.2 MVP Backend Endpoints (Representative)

```

POST /v1/capture/start
  -> { capture_id, upload_urls[], guidance_config }

POST /v1/capture/{capture_id}/frame
  body: { image_blob_url, frame_type: 'barcode|label|color', device_quality_metrics }
  -> { received: true }

POST /v1/capture/{capture_id}/finalize
  -> { status: 'processing' }

GET /v1/capture/{capture_id}/status
  -> { status: 'matched|needs_question|unmatched|processing', match?, question? }

POST /v1/capture/{capture_id}/answer
  body: { question_id, answer }
  -> { status, match?, next_question? }

POST /v1/inventory/items
GET  /v1/inventory/items
```

## 19.3 MVP Data Additions (Capture Sessions)

```

New tables (minimal):
  capture_session(capture_id, user_id, status, created_at, updated_at, top_confidence, accepted_entity_type, accepted_entity_id)
  capture_frame(frame_id, capture_id, image_id, frame_type, quality_json, created_at)
  capture_question(question_id, capture_id, prompt, type, options_json, status, created_at)
  capture_answer(answer_id, question_id, answer_json, created_at)
```

## 19.4 Build Plan (Serverless Azure)

- Step 0: Provision Azure resources: Blob Storage, Functions, Durable Functions storage, API Management, Postgres (or SQL), Application Insights.
- Step 1: Implement canonical DB + inventory CRUD + basic resolver (barcode lookup + pg_trgm shade search).
- Step 2: Implement Rapid Add capture session APIs + Blob uploads; persist frames and session state.
- Step 3: Durable Function finalize workflow: OCR → parse → candidates → decide match OR ask question.
- Step 4: Client UI: live camera guidance + auto-capture best frames; show confirmation; handle question prompts.
- Step 5: Security + privacy: auth, signed upload URLs, private containers, explicit opt-in for catalog contributions.
- Step 6: Instrumentation: tracing and metrics for capture success rate, avg time per bottle, question rate, match accuracy.
## 19.5 MVP Success Metrics

- Median time per bottle added: < 5 seconds (barcode present) / < 10 seconds (no barcode).
- Auto-match rate: > 70% for common brands; question-needed rate declines over time.
- User drop-off during onboarding: < 10% after first successful add.
- False-match rate: < 1% (opt for more questions over wrong matches).
## 19.6 Post-MVP Enhancements (Next)

- Optional speech: “Say brand + shade” to reduce OCR dependence.
- Swatch pipeline: normalized chips + embeddings + dupe search; opt-in shared swatches.
- Ingredient capture: label OCR to INCI normalization + versioned label_document.
- Active learning: use accept/reject decisions to tune scoring weights automatically.

# 20. Multi-Environment Azure Layout (Dev / Stage / Prod)

This section describes a practical way to run separate environments (dev, stage, prod) with clean separation, repeatable deployment (IaC), least-privilege access, and cost controls. The goal is to avoid re-architecting later.

## 20.1 Environment Strategy (Recommended)

- Use **one Azure subscription per environment** if you can (best isolation). If not, use one subscription with **separate resource groups per environment** and strict RBAC.
- Keep data strictly separated: **no prod data** in dev/stage by default.
- Use identical topology across environments; change only sizing and quotas.
- All resources are deployed via IaC (Bicep/Terraform) and parameterized by environment name.
## 20.2 Resource Group Layout

- Pattern A (preferred): subscription-per-env with consistent RG names.
- Pattern B (single subscription): RG-per-env with consistent naming and tags.
Example RG structure (per environment):

```

rg-np-{env}-core      # Functions, APIM, Durable, monitoring, Key Vault
rg-np-{env}-data      # Postgres/SQL, private endpoints, backups
rg-np-{env}-media     # Storage accounts (Blob), CDN config if used
rg-np-{env}-edge      # Front Door, WAF policies, DNS
rg-np-{env}-ops       # Cost mgmt artifacts, alerts, dashboards, runbooks
Where {env} ∈ {dev|stg|prod}
```

## 20.3 Naming Conventions and Tagging

- Use deterministic names so you can find/automate everything.
- Include region and environment in resource names; avoid random suffixes except where required.
Example naming scheme:

```

{app}={np}
{env}={dev|stg|prod}
{region}={eus|wus2|...}

Storage:   stnp{env}{region}01
Functions: func-np-{env}-{region}-api
Durable:   func-np-{env}-{region}-worker
Postgres:  pg-np-{env}-{region}01
KeyVault:  kv-np-{env}-{region}01
FrontDoor: afd-np-{env}
APIM:      apim-np-{env}
AI Search: srch-np-{env}-{region}
```

Recommended tags (enforced via policy):

- app=np
- env=dev|stg|prod
- owner=team-or-person
- cost_center=...
- data_class=public|internal|private
- lifecycle=mvp|prod|deprecated
## 20.4 Networking and Private Access (Practical Options)

Start simple for MVP, but design so you can tighten security without rewrites. There are two common patterns.

- **Option A (MVP-simple):** public endpoints for Postgres/Blob with strict firewall rules, IP allowlists, and TLS. Fastest to ship.
- **Option B (recommended for prod):** VNet integration + **Private Endpoints** for Postgres and Blob, with public access disabled.
- Front Door remains public; it routes to your API; backend resources can stay private.
## 20.5 Identity, RBAC, and Secrets

- Use **Managed Identities** for Functions and workers; no connection strings in code.
- Store secrets in **Key Vault**; restrict access by identity and environment.
- Separate identities per environment to prevent accidental prod access.
Example RBAC model:

```

Roles (per environment):
  - np-{env}-readers: read-only to resources + logs
  - np-{env}-devops: deploy rights (Contributor) scoped to rg-np-{env}-*
  - np-{env}-data-admin: elevated rights only to data RG (break-glass)
  - np-{env}-app-mi: managed identity used by Functions (no human membership)

Typical permissions:
  - app-mi -> Key Vault Secrets User (kv-np-{env}-*)
  - app-mi -> Storage Blob Data Contributor (stnp{env}*)
  - app-mi -> DB connect via passwordless or key-vaulted creds
```

## 20.6 Cost Controls: Budgets, Alerts, and Quotas

- Create **Azure Budgets** per environment (subscription or RG), with alerts at 50/80/100%.
- Set hard limits where possible: OpenAI quotas, Vision/Doc Intelligence throughput, Function concurrency.
- Storage lifecycle rules: tier old media, delete orphan uploads, cap free-tier retention for non-opt-in media.
- Dev/stage: use lower SKUs, short retention, and scheduled scale-down where supported.
Budget example (per env):

```

Budget: np-{env}-monthly
Scope: subscription (preferred) or rg-np-{env}-*
Thresholds: 50%, 80%, 100%
Alert actions: email + webhook to ops channel
```

## 20.7 Policies and Guardrails (Recommended)

- Azure Policy to enforce tags, deny public blob containers in prod, require HTTPS/TLS, require diagnostic settings to Log Analytics/App Insights.
- Production-only guardrails: disallow resource deletion without approval; enable soft delete for Key Vault; enable DB backups and PITR.
- Use resource locks in prod on critical resources (DB, storage, Key Vault).
## 20.8 CI/CD and Environment Promotion

- Use IaC + parameter files per environment; deploy dev on every merge; deploy stage/prod via approvals.
- Functions: use deployment slots where applicable; stage → prod via slot swap (or blue/green with Front Door).
- Database migrations: apply automatically in dev; apply in stage/prod via gated pipeline step.
- Seed data: use environment-specific seed sets; never seed prod from dev.
Example pipeline stages:

```

1) Lint/Test (backend + mobile/web)
2) Deploy IaC (dev)
3) Deploy API/Workers (dev) + run migrations (dev)
4) Integration tests (dev)
5) Deploy IaC (stg) [approval]
6) Deploy API/Workers (stg) + run migrations (stg)
7) Smoke tests (stg)
8) Deploy IaC (prod) [approval]
9) Deploy API/Workers (prod) + run migrations (prod) + warm-up
10) Monitor + rollback plan
```

## 20.9 Runbook Basics (Minimum)

- Operational dashboards: capture success rate, avg time per bottle, match rate, question rate, OCR/LLM error rate, cost per add.
- On-call checklist: how to disable expensive features (audio/vision), how to throttle requests, how to pause catalog contributions.
- Backup/restore drill: verify DB restore + blob recovery procedures at least quarterly (prod).

# 21. Additional Considerations and Post‑MVP Roadmap

## 21.1 Non‑Obvious Considerations (Plan Early)

- Data rights/licensing: shade catalogs and official swatch images are often copyrighted. Design for link-only and user-owned uploads unless you have explicit rights.
- Privacy: nail/hand photos are personal media. Default private, explicit opt-in for sharing, easy delete/export.
- AI cost controls: OCR/embeddings can be expensive. Prefer on-device guidance, upload best frames only, cache aggressively, and set quotas/budgets.
- Moderation + rollback: user contributions to canonical data need proposals, review, and reversible changes.
- Internationalization: labels, sizes, and market SKUs differ. Model market/region and allow multiple label versions per SKU.
- Accessibility: voice input, large text, and simple confirmation UX improves onboarding success.
- Security: signed upload URLs (SAS), rate limiting, malware scanning/validation, EXIF stripping, and least-privilege RBAC.
- Data drift: brands re-use shade names and reformulate. Preserve history (label_document versions) and monitor for changes.
## 21.2 Post‑MVP Feature Buckets (High Impact)

- Dupe engine: visually similar shades using swatch embeddings + finish classification + Delta E; explain why.
- Batch onboarding: table-scan mode (multiple bottles), bulk photo uploads, CSV import, receipt import.
- Ingredient intelligence: filters (“without X”), formula change tracking, claims vs label evidence.
- Vibe search: natural language queries (“warm terracotta jelly”), palette builder from outfit photo, undertone filters.
- Collection insights: usage analytics, duplicates detection, gaps, reminders (separating, thinning).
- Community (opt-in): shared swatches with quality scoring, votes on accuracy, curated lists; requires moderation.
- Release timeline: track collections, discontinued status, limited editions; optional restock notifications later.
- AR try-on (later): nail segmentation + finish rendering; high effort but marquee.
## 21.3 Roadmap Phases (Suggested)

| Phase | Theme | What ships | Depends on | Primary KPI |
| --- | --- | --- | --- | --- |
| MVP (now) | Rapid onboarding + inventory | Live capture add, barcode/OCR match, 1-question loop, private media, inventory CRUD | Core schema + resolver + storage + Durable Functions | Time per bottle; match accuracy; drop-off |
| P1 | Swatch pipeline + dupes | Normalized swatches, embeddings, dupe search, finish classification (basic) | Media pipeline + pgvector/AI Search | Engagement; searches/session |
| P2 | Ingredient capture | Label OCR → INCI normalization, claims extraction, ingredient filters | OCR pipeline + ingredient ontology | Search conversions; repeat usage |
| P3 | Batch onboarding | Table scan, CSV import, bulk photo ingest, dedupe assistant | Stable matching + background jobs | Items added/hour; retention |
| P4 | Discovery + vibe search | Palette builder, vibe queries, outfit photo palette, recommendations | Swatches + embeddings + good catalog coverage | Discovery usage; saves |
| P5 | Community + moderation | Opt-in shared swatches, quality scoring, votes, curated lists | Moderation tooling + trust scoring | UCG contribution rate; quality |
| P6 | AR try-on | Try-on rendering with finish realism | Strong swatch/finish models + segmentation | Feature adoption; retention lift |


## 21.4 Feature Design Notes (So They Fit the Model)

- Dupe engine attaches to Shade + Swatch and uses color_features.embedding + finish tags; results are explainable via Delta E + similarity.
- Ingredient intelligence attaches to LabelDocument versions; always preserve provenance and effective dates; never overwrite historical lists.
- Community swatches are just Swatch records with visibility=public and quality_score; moderation can accept/reject proposals similarly to other canonical patches.
- Batch onboarding uses the same capture_session model, but with multi-item sessions (one session → N items).
- Vibe search can be built as hybrid retrieval over shade text + embeddings (and optional AI Search).
## 21.5 Cost and Safety Guardrails for Post‑MVP

- Run expensive AI steps only when needed (e.g., OCR only after quality threshold met; embeddings once per new swatch).
- Add per-user and per-day limits for heavy operations; use feature flags to disable audio/vision under cost pressure.
- Maintain a clear privacy model: private media stays private; public sharing always opt-in; allow per-asset revocation.
- Moderation and rollback: every public contribution must be reversible; keep audit logs for all decisions.

# 22. Retail Mode and Affiliate Monetization (Early Priority)

Retail integration is a strong early feature because it directly prevents duplicate purchases (high user value) and provides a natural monetization path via affiliate programs. The key is to implement this in a way that is transparent (FTC disclosure), compliant with affiliate policies, and privacy-safe.

## 22.1 User Experiences to Ship Early

- **In-store scan mode (mobile):** scan barcode → show match/confidence → “You own this / close dupes” → “Open at retailer”.
- **Where to buy (all clients):** canonical shade/SKU page shows supported retailers with outbound links.
- **Price snapshot (optional early):** show “last seen price range” with timestamp (avoid claiming real-time unless sourced).
- **Don’t-buy-duplicates:** warn if user already owns the item or has very close dupes.
## 22.2 Affiliate Programs: How to Approach

Start with a small number of major retailers via affiliate networks so you don’t have to negotiate individually. Examples: Sephora publicly notes it partners with Rakuten for its affiliate program, and Ulta lists an Impact program. Many retailers also operate direct affiliate programs.

- Prefer **network product feeds / deep link APIs** (Rakuten Deep Links API; Impact deeplinking) over scraping.
- Use **one outbound-link service** (your backend) to standardize click logging, UTM parameters, and fallback behavior—but ensure the user always performs a deliberate click (no auto-redirect).
- Add a clear disclosure near any “Buy” link/button and in a dedicated disclosures page.
## 22.3 Compliance and Policy Guardrails (Must-Haves)

- FTC: disclosures must be clear and conspicuous when you have a material connection (affiliate links).
- Amazon Associates: do not auto-redirect users to Amazon without an affirmative click; avoid behavior that could be interpreted as intercepting/redirecting traffic.
- App store: physical-goods outbound links are generally acceptable, but keep monetization transparent and avoid deceptive UI.
## 22.4 Link Architecture (Web + iOS + Android)

- **Mobile deep linking:** if the retailer app is installed, open the product page in-app; otherwise open web.
- **Universal links / app links:** for your own app, so retailer clickouts can return to you (optional).
- **Outbound link endpoint:** `/r/{retailer}/{offer_id}` returns a branded interstitial with disclosure and a single ‘Open’ button (recommended for compliance + clarity), then navigates to the network tracking link.
## 22.5 Data Model Additions (Minimal)

```

retailer(retailer_id, name, country_codes, supports_deeplink, app_uri_scheme?, homepage_url)
affiliate_program(program_id, retailer_id, network, publisher_account_id, status, terms_notes)
retailer_offer(offer_id, retailer_id, canonical_entity_type, canonical_entity_id, product_url, tracking_template, last_verified_at)
offer_price_snapshot(snapshot_id, offer_id, price, currency, captured_at, source)
click_event(click_id, user_id?, offer_id, platform, created_at, session_id, inventory_context?)
disclosure_config(env, disclosure_text, last_updated_at)
```

## 22.6 MVP Implementation Steps (Retail Early)

- Step 1: Add **retailer + offer** tables and a “Where to buy” panel in the UI (web + mobile).
- Step 2: Implement outbound link endpoint `/r/...` with click logging and visible disclosure.
- Step 3: Seed 2–4 retailers manually (no feeds yet). Use deep links when you have stable product URLs; otherwise use retailer search URLs.
- Step 4: Add **in-store scan mode**: barcode decode on-device → backend match → show own/dupe warnings → buy links.
- Step 5: Integrate one affiliate network API (Rakuten/Impact) to generate valid deep links at scale; then expand retailers.
- Step 6 (optional): add price snapshots via affiliate product feeds; label as ‘last seen’ with timestamp.
## 22.7 Cost Reality Check (How This Pays for Azure)

- Affiliate revenue can offset infrastructure, but it’s conversion-dependent. Treat it as **a strong early monetization channel**, not the only plan.
- Keep AI costs under control: barcode-first, best-frame uploads, caching OCR results per SKU, and quotas/budgets per environment.
- If needed later, add a subscription tier for power features (advanced dupes, analytics, batch imports) while keeping basic inventory free.
## 22.8 Measurement (What to Track)

- Click-through rate (CTR) on buy links and scan mode outcomes (matched vs question vs unmatched).
- Duplicate-prevention events (how often you saved a user from rebuying).
- Revenue per active user (affiliate) vs AI cost per active user.
- Retailer coverage: % of catalog with at least one offer link.

# 23. Deploy Pipeline (Current Implementation)

This section documents how the current `deploy-dev.yml` GitHub Actions workflow deploys `packages/functions` and the known issues as of 2026-02.

## 23.1 Workspace Dependency: Tarball Packaging

The `packages/shared` package is a workspace dependency of `packages/functions`. When deploying with `WEBSITE_RUN_FROM_PACKAGE`, Azure mounts the uploaded zip as a read-only filesystem. npm workspace `file:` directory references resolve to symlinks at install time, and those symlinks do not work reliably within the mounted package.

The fix (landed in PR #94, commit `d89b1bd`): pack `packages/shared` as a self-contained `.tgz` tarball using `npm pack`, rewrite the `swatchwatch-shared` entry in `packages/functions/package.json` to point to the tarball path, then run `npm install --omit=dev` inside the deploy directory. A guardrail check verifies the installed path is a real directory rather than a symlink before the zip is uploaded.

This requires `"files": ["dist/"]` in `packages/shared/package.json` so the compiled JS is included in the tarball. Without this field, `.gitignore` rules exclude `dist/` from the packed output, making the tarball unusable.

## 23.2 Settings Ordering: appsettings Before Deploy

In the previous workflow layout, `az functionapp config appsettings set` ran after the `Azure/functions-action` deploy step. This caused the function host to cold-start twice: once immediately after deploy with potentially stale settings, and again after the settings update. The workflow now runs `appsettings set` before `Deploy to Azure Functions`, limiting the cold-start to one restart with the correct configuration.

## 23.3 sharp: Dynamic Import

`packages/functions/src/lib/blob-storage.ts` previously imported `sharp` at the top level. If the `sharp` native binary is not present for the current platform (for example, when the linux-x64 prebuilt variant is missing after a cross-platform build), the top-level import throws and prevents the entire worker from starting — registering zero functions.

The fix: `sharp` is now imported with `await import("sharp")` inside the function body (lazy/dynamic import). If `sharp` fails to load at runtime, the function logs a warning and continues with the original unprocessed image bytes. This means a missing binary causes degraded behavior (no metadata stripping) rather than a full startup failure.

## 23.4 Known Issue: 0 Functions Registered After Deploy (Issue #96)

After a successful deploy, the Azure Functions host reports state Running, extensionBundle 4.28.0 loads, and processUptime shows the host has been up for several minutes — but `GET /admin/functions` returns an empty array. No functions are registered.

All module-level code loads cleanly in local testing. The root cause is still under investigation. Two leading hypotheses:

- Worker IPC handshake timing: the `@azure/functions-core` module is injected by the Azure worker bundle at runtime (not present in `node_modules`). If the IPC channel between the host and the Node worker is not established before the worker exits its initialization phase, function registrations may be lost silently.
- Path resolution: despite the tarball packaging fix, some module resolution edge case under `WEBSITE_RUN_FROM_PACKAGE` may prevent `app.http()` calls from reaching the host.

Issue #95 (bundle `packages/shared` via esbuild/tsup into a single file) would eliminate workspace resolution entirely and would serve as a diagnostic step: if bundling resolves the issue, path resolution was the cause.

API smoke tests have been removed from `deploy-dev.yml` temporarily because the 0-functions condition makes them always fail, blocking all CI. They will be restored once issue #96 is resolved.
