# Sprint M1 — Prod Launch & Platform Hardening
_Started: 2026-02-25_

This sprint delivers production deployment, platform hardening, and lays the groundwork for the mobile client. Items are ordered by dependency (deploy before prod, identity before prod user testing, etc.).

---

## Sprint Goals

1. Get a clean `main` branch and production environment live at `swatchwatch.app`
2. Harden the ingestion pipeline with bulk-run and raw-data persistence
3. Fix the identity/account-merge problem before prod user acquisition
4. Start the mobile app on the same cadence as web
5. Fix the lightness slider regression on the color wheel

---

## Items

### #1 — Merge `dev` → `main`
**Status:** 🔲 Not started
**Type:** Chore / Release
_No GitHub issue — this is a workflow step._

19 commits on `dev` not yet on `main`. Merge via PR, squash if appropriate. This unblocks the prod deployment issue below.

**Checklist:**
- [ ] Open PR: `dev` → `main`
- [ ] CI green on the PR
- [ ] Squash-merge with conventional commit message
- [ ] Tag `v0.1.0` on main post-merge

---

### #2 — Prod Deployment (Parameterize CI Workflows)
**Status:** 🔲 Not started
**GitHub:** #106
**Labels:** chore, infra, web, functions
**Depends on:** #1 (merge)

Refactor `deploy-dev.yml` and `deploy-infra-dev.yml` into reusable parameterized workflows. Add `deploy-prod.yml` that triggers on push to `main`.

**Key work:**
- Extract hardcoded resource names; derive from `terraform output` after init
- Create `prod` GitHub environment with prod secrets/vars
- Provision `swatchwatch-prod-rg` and all resources in Terraform (new workspace or `TF_VAR_environment=prod`)
- Wire custom domain `swatchwatch.app` to the prod Static Web App
- Smoke tests hit the correct environment URL

**Checklist:**
- [ ] `deploy.yml` (reusable, env param)
- [ ] `deploy-infra.yml` (reusable, env param)
- [ ] `deploy-dev.yml` calls reusable workflow with `env: dev`
- [ ] `deploy-prod.yml` calls reusable workflow with `env: prod`, triggers on push to `main`
- [ ] `prod` GitHub environment created with all required secrets/vars
- [ ] First prod infra apply succeeds
- [ ] First prod app deploy succeeds
- [ ] `swatchwatch.app` resolves to prod Static Web App

---

### #3 — Bulk Ingestion Runner
**Status:** 🔲 Not started
**GitHub:** #107
**Labels:** feature, web, functions, shared

Admin console bulk-run mode: select connector protocols and/or individual sources, configure options (materialize, replace hex, AI detection), exhaust all pages.

**Key work:**
- Add `ConnectorProtocol` enum to `packages/shared` and map each `SupportedConnectorSource` to its protocol
- New `POST /api/ingestion/bulk` endpoint
- Worker exhaustive paging mode (`exhaustive: true`)
- Admin UI: grouped source checkboxes, run options, bulk run button

**Checklist:**
- [ ] `ConnectorProtocol` type in `packages/shared`
- [ ] Source → protocol lookup map
- [ ] `POST /api/ingestion/bulk` endpoint
- [ ] Worker: exhaustive paging loop
- [ ] Admin UI: protocol groups + individual source selection
- [ ] Run options: materialize, replace hex, AI detection
- [ ] Docs updated

---

### #4 — Persist Raw Connector Payloads
**Status:** 🔲 Not started
**GitHub:** #108
**Labels:** feature, functions, infra

Save raw JSON from each connector page pull to blob storage for reprocessing and future model training.

**Key work:**
- `connector-raw` blob container in Terraform
- `connector_raw_snapshots` DB table + migration
- Worker: upload gzipped raw payload after each `pullProducts()` call
- Admin: snapshot count + last capture date per source

**Checklist:**
- [ ] `connector-raw` container in Terraform
- [ ] `connector_raw_snapshots` migration
- [ ] Worker saves blob + DB row per page
- [ ] `RAW_SNAPSHOT_CONTAINER` env var in `local.settings.json.example`
- [ ] Admin surfaces snapshot stats

---

### #5 — Mobile App Scaffold
**Status:** 🔲 Not started
**GitHub:** #109
**Labels:** chore, mobile

Establish mobile-side architecture parity: auth, API client, navigation, first real screen. Develop mobile in parallel with web going forward.

**Key work:**
- MSAL React Native against same B2C tenant
- Typed API client using `swatchwatch-shared`
- Expo Router with `(app)` / `(marketing)` route groups
- Polish list + detail screens (real API data, skeleton UI)
- CI: type-check + lint for mobile

**Checklist:**
- [ ] MSAL auth works on iOS simulator (dev bypass)
- [ ] Polish list loads from live API
- [ ] Tab bar: Collection, Search, Add, Profile
- [ ] `npm run dev:mobile` works from root
- [ ] CI checks green for mobile

---

### #6 — Merge External Identities by Email
**Status:** 🔲 Not started
**GitHub:** #110
**Labels:** feature, functions, shared

Prevent duplicate accounts when users sign in with multiple providers. One account per email; multiple linked external identities.

**Key work:**
- `user_external_identities` table (migration)
- Update auth middleware in `packages/functions/src/lib/auth.ts` for lookup → link → create flow
- Admin `POST /api/admin/users/merge` endpoint for manual merges
- B2C policy must include email claim (document)

**Checklist:**
- [ ] `user_external_identities` migration
- [ ] Auth middleware uses new flow
- [ ] Second-provider sign-in links to existing account
- [ ] Admin merge endpoint
- [ ] Docs updated

---

### #7 — Fix Lightness Slider on Color Wheel
**Status:** 🔲 Not started
**GitHub:** #111
**Labels:** bug, web

The vertical lightness slider next to the color wheel is not rendering. Replace the CSS rotation trick with a CSS-native vertical range approach.

**Key work:**
- Replace `-rotate-90` Tailwind class with `writing-mode: vertical-lr` + `direction: rtl` (or equivalent)
- Fix container sizing to match visual dimensions
- Verify across Chrome, Safari, Firefox, and mobile touch

**Checklist:**
- [ ] Slider visible as vertical control
- [ ] Dragging updates lightness + re-renders wheel
- [ ] Cross-browser verified
- [ ] Mobile touch works

---

## Dependency Order

```
#1 Merge dev→main
    └─► #2 Prod deploy
            └─► (prod goes live)
#3 Bulk ingestion runner
#4 Persist raw payloads   (can ship with or before #3)
#5 Mobile scaffold        (parallel track)
#6 Identity merge         (should ship before prod user acquisition)
#7 Lightness slider fix   (quick win, any time)
```

---

## Progress Tracker

| # | Title | GH Issue | Status |
|---|-------|----------|--------|
| 1 | Merge dev → main | — | 🔲 |
| 2 | Prod deployment | #106 | 🔲 |
| 3 | Bulk ingestion runner | #107 | 🔲 |
| 4 | Persist raw payloads | #108 | 🔲 |
| 5 | Mobile scaffold | #109 | 🔲 |
| 6 | Identity merge by email | #110 | 🔲 |
| 7 | Fix lightness slider | #111 | 🔲 |
