# Rapid Add — Next Giant Push Plan

Date: 2026-02-10  
Branch baseline: `codex/rapid-add-capture-api-scaffold`  
Related issues: [#20](https://github.com/mattmck/swatchwatch/issues/20), [#21](https://github.com/mattmck/swatchwatch/issues/21)

## Objective

Deliver a durable, production-ready capture finalize pipeline that keeps the current API contract stable while replacing scaffold behavior with staged, auditable processing.

## Current Baseline

Already shipped on branch:
- Dedicated `/rapid-add` web route and manual add split.
- Data URL frame ingestion with validation + checksum.
- Structured frame evidence normalization (`quality_json.extracted`).
- Durable metadata scaffolding:
  - `metadata.pipeline.ingest` progress fields.
  - `metadata.pipeline.finalize` run metadata.
  - stable `metadata.pipeline.status`.
- Deterministic resolver + question flow + inventory creation on match.

## Giant Push Scope

### 1) Durable Finalize Orchestration
- Introduce explicit stage execution in finalize:
  - `queued_ingest` -> `extracting` -> `resolving` -> terminal (`matched|needs_question|unmatched`).
- Ensure stage transitions are persisted atomically.
- Record per-stage timing and outcome details in metadata.

### 2) Evidence Service Boundary
- Move extraction and evidence aggregation into dedicated service helpers.
- Finalize must consume persisted extracted evidence, not ad-hoc request quality hints.
- Keep resolver input deterministic and traceable.

### 3) Idempotency and Concurrency Safety
- Add idempotency key support for finalize.
- Prevent duplicate finalize runs from racing on the same capture session.
- Safe retry semantics for network/client retries.

### 4) Stable Status Contract
- Extend status payload semantics via metadata (without breaking current response shape):
  - current stage, last stage update, terminal reason, evidence summary.
- Ensure frontend can poll for deterministic progress states.

### 5) Test Coverage
- Add/upgrade unit tests for:
  - happy path (high-confidence match),
  - ambiguous path (needs question),
  - no-evidence path,
  - retry/idempotent finalize,
  - concurrent finalize guard behavior.

## Out of Scope (This Push)

- Full OCR/LLM integrations (can remain stubbed/service-injected).
- Mobile camera UX redesign.
- Public media sharing/community swatches.

## Acceptance Criteria

- `POST /api/capture/{id}/finalize` is durable and idempotent.
- `GET /api/capture/{id}/status` reflects stable progress/terminal pipeline states.
- Resolver decisions are auditable via persisted evidence + run metadata.
- Existing client contract (`matched|needs_question|unmatched`) remains unchanged.
- Functions build + tests pass.

## Commit Strategy

1. `refactor(functions): extract capture pipeline/evidence services`
2. `feat(functions): add finalize stage machine + concurrency guard`
3. `feat(functions): add finalize idempotency support`
4. `test(functions): cover staged finalize and retry scenarios`
5. `docs(functions): update capture pipeline behavior`

