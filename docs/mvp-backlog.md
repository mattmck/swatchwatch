# Nail Polish App — MVP Implementation Breakdown (v1.1)
_Date: 2026-02-07_

This backlog is organized as **Epics → Capabilities → Stories/Tasks**, optimized to reach a working MVP fast while keeping the system extensible.

---

## Epic 0 — Foundations (Repo, CI/CD, environments)
**Goal:** ship continuously to dev/stage/prod with safe secrets and observability.

### Capabilities
- **0.1 Repo + shared libraries**
- **0.2 CI/CD pipelines**
- **0.3 IaC deployment to Azure**
- **0.4 Observability + alerts**

### Stories / Tasks
- ✅ npm workspaces monorepo:
  - `apps/web` (Next.js), `apps/mobile` (Expo), `packages/functions` (Azure Functions), `packages/shared` (types)
- ✅ Terraform IaC in `infrastructure/` — migrating from Cosmos DB to Azure Database for PostgreSQL Flexible Server
- ✅ Canonical Postgres schema v1.1 in `docs/schema.sql` (pg_trgm + pgvector)
- Add DB migrations via `node-pg-migrate` in `packages/functions/migrations/` + `npm run migrate` script
- Implement env config + feature flags (dev/stg/prod) via Key Vault + app settings
- Add CI/CD pipeline (GitHub Actions): lint → test → deploy IaC → deploy Functions → migrate → smoke test
- Add structured logging + distributed tracing (App Insights)
- Add budgets/alerts + log-based alerts (OCR/LLM error rates, spike detection)

**Definition of Done**
- One-click deploy to **dev**; gated deploy to **stg/prod**
- Metrics dashboard exists (capture success, match rate, latency, AI cost proxy)

---

## Epic 1 — Auth, Accounts, Privacy, and Media Security
**Goal:** users can safely create accounts and store private media.

### Capabilities
- **1.1 Authentication** (Entra ID B2C or equivalent)
- **1.2 Authorization** (per-user access control)
- **1.3 Secure uploads** (SAS tokens, private blobs)
- **1.4 Media processing** (thumbnail/normalize, EXIF stripping)

### Stories / Tasks
- Implement auth for web + mobile (OIDC)
- Add API auth middleware and per-user resource authorization checks
- Create blob containers:
  - `user-media-private`, `thumbs`, `normalized`, `public-swatch` (optional later)
- Implement upload flow:
  - `POST /capture/start` returns short-lived SAS URLs
  - client uploads frames directly to Blob
- Add EXIF stripping and basic validation (size/type limits)
- Implement soft-delete / user delete policies and export endpoint later

**DoD**
- A user cannot access another user’s inventory or media
- Uploads work with no secrets in mobile/web builds

---

## Epic 2 — Core Canonical Data + Inventory
**Goal:** inventory CRUD works and can link to canonical entities.

### Capabilities
- **2.1 Canonical schema** (brand/shade/sku/label docs, etc.)
- **2.2 Inventory schema + APIs**
- **2.3 Minimal admin controls** (internal, for corrections)

### Stories / Tasks
- Apply schema via `node-pg-migrate` (`docs/schema.sql`) + seed sources (`docs/seed_data_sources.sql`)
- Install `pg` + `@types/pg` in `packages/functions`; create `src/lib/db.ts` pool helper
- Align shared types (`packages/shared`) with schema: inventory item links to shade/sku, expand `PolishFinish`
- Implement inventory CRUD in `packages/functions/src/functions/polishes.ts`:
  - `POST /api/polishes` (create inventory item)
  - `GET /api/polishes` (list with search/filter/pagination)
  - `GET /api/polishes/{id}` (single item with shade/brand joins)
  - `PUT /api/polishes/{id}` (update)
  - `DELETE /api/polishes/{id}` (soft delete recommended)
- Implement canonical lookup:
  - `GET /api/catalog/search?q=` (brand/shade trigram search)
  - `GET /api/catalog/shade/{id}`
- Create `apps/web/src/lib/api.ts` — typed fetch wrappers for all endpoints
- Connect web UI collection page to real API (replace mock data imports)
- Add audit logging for user corrections/links

**DoD**
- Users can add/edit/view inventory on web + mobile without capture mode

---

## Epic 3 — Rapid Add: Live Capture Onboarding (Camera + optional audio hint)
**Goal:** fastest possible onboarding, “rotate bottle until matched.”

### Capabilities
- **3.1 Capture session lifecycle APIs**
- **3.2 Mobile live capture UX** (guidance + best-frame selection)
- **3.3 Finalize pipeline** (OCR/parse/match)
- **3.4 One-question loop** (adaptive clarifying questions)

### Stories / Tasks (Backend)
- Implement capture session APIs:
  - `POST /v1/capture/start`
  - `POST /v1/capture/{id}/frame`
  - `POST /v1/capture/{id}/finalize`
  - `GET  /v1/capture/{id}/status`
  - `POST /v1/capture/{id}/answer`
- Durable orchestration: `capture_finalize_orchestrator`
  - Fetch best frames
  - OCR label + attempt barcode decode if not on-device
  - LLM parse (structured extraction)
  - Resolver scoring → matched | needs_question | unmatched
- Persist `capture_session`, `capture_frame`, `capture_question`, `capture_answer`
- Add idempotency keys for finalize + answer endpoints

### Stories / Tasks (Mobile)
- Implement live camera UI:
  - blur/glare/exposure scoring (local)
  - barcode scan attempt (local)
  - prompts: “rotate”, “tilt”, “move closer”
  - auto-capture 2–6 best frames + upload in background
- Optional: speech-to-text button (“say brand + shade”) as a hint
- Confirmation card + “Add another” batch mode

**DoD**
- Median time per bottle: **< 5s** with barcode, **< 10s** without
- User can onboard at least 25 items in one session

---

## Epic 4 — Matching + External Enrichment (MVP)
**Goal:** maximize data coverage quickly while keeping correctness high.

### Capabilities
- **4.1 Deterministic match** (GTIN → SKU)
- **4.2 Fuzzy match** (brand+shade text, aliases)
- **4.3 External lookup connector** (OpenBeautyFacts first)
- **4.4 Provenance logging** (field-level for critical fields)

### Stories / Tasks
- Implement connector interface + caching:
  - `lookup_by_gtin(gtin)`
- OpenBeautyFacts integration:
  - real-time GTIN lookup during capture finalization
  - optional nightly/weekly bulk sync job (ingestion_job)
- Persist raw payloads to `external_product` + normalized subset
- Write `field_provenance` for:
  - `sku.gtin`, `label_document.inci_text` (if found), `shade.name/finish` (if extracted)
- Implement conflict detection (GTIN collisions)

**DoD**
- If GTIN exists and OBF has it, user gets immediate enrichment + provenance

---

## Epic 5 — Ingredients (MVP-light)
**Goal:** show “what’s in it” when available; request label photo when missing.

### Capabilities
- **5.1 Label OCR pipeline**
- **5.2 INCI normalization** (CosIng-backed dictionary)
- **5.3 UX: ask for label photo if missing**

### Stories / Tasks
- OCR label image → extract candidate INCI text
- Normalize to canonical ingredient dictionary + store mapping
- Version label documents (do not overwrite)
- UI: show ingredient list + “source/evidence”

**DoD**
- For at least one brand, ingredient capture works reliably from label photos

---

## Epic 6 — Retail Mode + Affiliate (Early)
**Goal:** prevent duplicate buys + monetize to offset costs.

### Capabilities
- **6.1 Retailer + offer model**
- **6.2 Outbound link endpoint + disclosure**
- **6.3 In-store scan experience**
- **6.4 Analytics (CTR, revenue proxy, duplicate prevention events)**

### Stories / Tasks
- Add “Where to buy” panel on shade/SKU pages (web + mobile)
- Implement `/r/{retailer}/{offer_id}` interstitial:
  - disclosure + click-required
  - click logging (`click_event`)
- Seed 2–4 retailers manually; later integrate Impact/Rakuten APIs
- In-store scan mode:
  - barcode scan → match → own/dupe warning → buy links

**DoD**
- User can scan in-store and quickly see: **own it?** **close dupes?** **buy link**

---

## Epic 7 — Minimal Admin / Ops Console (Highly recommended early)
**Goal:** fix bad data, collisions, and review unmatched items.

### Capabilities
- **7.1 Admin search + entity merge tooling**
- **7.2 Review queue for “unmatched” + user proposals**
- **7.3 Rollback and audit views**

### Stories / Tasks
- Web-only admin console behind role-based auth
- Views:
  - GTIN collisions
  - top unmatched brands/shades
  - OCR failures + samples
- Actions:
  - merge shades, merge SKUs, create alias, mark “do not auto-accept”

**DoD**
- A non-engineer can clean up top issues without DB access

---

## Suggested MVP Milestones (fast path)
- **M0 (Week 1–2):** Auth + inventory CRUD + media upload
- **M1 (Week 3–4):** Rapid Add (camera) + finalize pipeline + 1-question loop
- **M2 (Week 5):** OpenBeautyFacts connector + provenance logging
- **M3 (Week 6):** Retail links + in-store scan mode + disclosure
- **M4 (Week 7+):** Ingredient OCR + basic normalization + admin tools
