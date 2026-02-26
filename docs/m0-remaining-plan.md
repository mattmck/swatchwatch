# M0 Remaining Work — Implementation Plan

_Date: 2026-02-21_
_Branch baseline: `dev` @ `44b351d`_
_Prior plan: [m0-completion-plan.md](./m0-completion-plan.md) (2026-02-17, mostly executed)_

## Executive Summary

M0 is functionally complete on the backend: all CRUD APIs, auth, blob storage, DB migrations, and the full web UI are wired. The primary blocker is that **Azure Functions deploys with 0 registered functions** — the app builds and deploys clean, but the Azure worker never registers any routes, making the entire backend dead in production. Once that is resolved, there are a handful of security and UX items (per-user authorization enforcement, EXIF stripping, logout UX fix) that complete M0's "done" contract, and a deploy-time simplification (#95 esbuild bundling) that eliminates the class of packaging bugs that have required 5 fix rounds.

---

## Section 1 — Blockers

### B-1: Azure Functions 0-registered-functions (CRITICAL)

**Priority: P0 — nothing works without this.**

**What's happening:** The deploy succeeds, the Azure host reports "Running" with uptime, but `GET /admin/functions` returns `[]` — no routes are registered. The Functions runtime is alive but never loads any handlers. Smoke tests were removed from CI to unblock the deploy workflow; we have no automated signal of whether the API is alive after a deploy.

**Root cause candidates (investigate in this order):**

1. **`WEBSITE_RUN_FROM_PACKAGE` + `main` field mismatch.** The deploy package has `"main": "dist/index.js"` in `package.json`. Azure Functions v4 with the Node.js worker should pick that up as the entry point, but if the worker-bundle that Azure injects at runtime doesn't resolve `dist/index.js` relative to the package root the same way `func start` does locally, nothing loads. Verify that `dist/index.js` exists in the deployed `.deploy/` artifact and that the path matches what Azure expects.

2. **Missing or stale `@azure/functions` in the deployed `node_modules`.** `@azure/functions` is listed as a dependency. At deploy time we run `npm install --omit=dev` in `.deploy/`. If the version installed there does not match what the Azure worker-bundle injects, `app.http()` calls may silently no-op. Check the version deployed vs. what `func start` resolves locally.

3. **Worker IPC / startup timing.** Azure Functions' Node.js worker starts the process, then waits for the worker to signal readiness over a gRPC channel. If module load throws (e.g., a missing env var causes an import-time crash that is swallowed) or takes too long, the worker times out and reports 0 functions. Add a bare `console.log("SwatchWatch functions loading")` as the first line of `dist/index.js` and check the streaming log in the Azure portal to confirm module load begins.

4. **`extensionBundle` version constraint.** `host.json` pins `[4.*, 5.0.0)`. If the Azure host has moved to v5 for the region/SKU, the bundle mismatch may prevent the HTTP trigger binding from registering. Widen to `[4.*, 6.0.0)` as a diagnostic step.

**Investigation steps:**
1. Open the Azure Portal → Function App → Log stream. Redeploy or restart the app. Look for the `SwatchWatch functions loading` log line. If absent, the module is never required — confirms path/packaging issue.
2. In the portal, go to App files → `package.json` and `dist/index.js` to confirm both exist as expected in the run-from-package mount.
3. Compare `node_modules/@azure/functions/package.json` version in the `.deploy` dir locally against the version reported in Azure logs.
4. Try a minimal reproduction: deploy a single file `dist/index.js` that only registers one `app.http()` route and has no other imports. If that works, binary-search which import causes the silent failure.

**Relevant files:**
- `packages/functions/src/index.ts` — entry point, exports all function modules
- `packages/functions/host.json` — extensionBundle version constraint
- `packages/functions/package.json` — `main` field, dependency versions
- `.github/workflows/deploy-dev.yml` — packaging steps (lines 69–101)
- `.github/workflows/deploy-dev.yml` — deploy step (lines 134–139)

**Pitfalls:**
- The tarball packaging in PR #94 is correct for getting `swatchwatch-shared` into the deploy. The 0-functions bug is separate — it predates the tarball fix. Do not conflate the two.
- If an import-time error is the cause, it will not surface in the deploy log — it only appears in the streaming/live log once the worker process starts.
- Do not add `WEBSITE_RUN_FROM_PACKAGE=0` as a workaround permanently; it defeats the cold-start benefit. Use it only to isolate whether the packaging is the cause.

**Complexity: M** (investigation-heavy, fix is likely small once root cause is identified)

---

### B-2: No smoke test in CI — deploy failures are silent

**Priority: P0 — required to know if B-1 is fixed.**

The smoke test was removed from CI to unblock deploys (commit `44b351d`). Without it, every deploy to dev is unverified. This must be restored once B-1 is resolved; keeping it out permanently means broken deploys will not be caught.

**What to do:**
Add a smoke test step back to `deploy-dev.yml` after the Functions deploy step. Use a 20-second sleep to allow the host to finish cold-start, then hit `GET /api/auth/config` (requires no auth, no DB) as a lightweight liveness check, and `GET /api/polishes?pageSize=1` with a dev Bearer token as a DB connectivity check.

```yaml
- name: Smoke test functions
  run: |
    sleep 20
    CONFIG_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
      "https://swatchwatch-dev-func-j5jij0be.azurewebsites.net/api/auth/config")
    if [ "$CONFIG_STATUS" != "200" ]; then
      echo "::error::Smoke test failed: GET /api/auth/config returned HTTP $CONFIG_STATUS"
      exit 1
    fi
    POLISH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
      -H "Authorization: Bearer dev:1" \
      "https://swatchwatch-dev-func-j5jij0be.azurewebsites.net/api/polishes?pageSize=1")
    if [ "$POLISH_STATUS" != "200" ]; then
      echo "::error::Smoke test failed: GET /api/polishes returned HTTP $POLISH_STATUS"
      exit 1
    fi
    echo "Smoke test passed"
```

**Relevant files:**
- `.github/workflows/deploy-dev.yml` — add after line 139

**Pitfalls:**
- The 20-second sleep is a rough heuristic. Cold-starts on the Consumption plan can take 30–60 seconds. If smoke tests are flaky, increase to 45 seconds or retry the curl up to 3 times before failing.
- `AUTH_DEV_BYPASS` must be set in Azure App Settings for the dev Bearer token to work.

**Complexity: S**

---

## Section 2 — High Value, Low Effort

### H-1: Enforce per-user access control on all API endpoints (Issue #47)

**Priority: P1 — M0 security requirement.**

**What's needed:** All inventory and media endpoints must filter by the authenticated user's ID. Today `withAuth` correctly identifies the user, but the SQL queries in `polishes.ts` may return data for any user if the caller supplies a different ID. The auth user ID must be injected into every `WHERE` clause — users must never see or modify another user's inventory rows.

**Key checks:**
- `GET /api/polishes` — confirm `WHERE ui.user_id = $userId` is enforced in SQL (not just client-filtered)
- `PUT /api/polishes/{id}` and `DELETE /api/polishes/{id}` — confirm the update/delete includes `AND user_id = $userId` so a user cannot mutate another user's rows by guessing an ID
- `GET /api/polishes/{id}` — same
- Blob SAS URL generation — confirm SAS tokens are scoped and cannot be reused across users

**Relevant files:**
- `packages/functions/src/functions/polishes.ts` — all handlers
- `packages/functions/src/lib/auth.ts` — `authenticateRequest` returns `userId`
- `packages/functions/src/lib/blob-storage.ts` — SAS generation

**Pitfalls:**
- `polishes.ts` uses a shared `POLISH_SELECT` fragment that already passes `$1::text AS "userId"`. Verify that the WHERE clause in list/detail queries correctly uses the authenticated user's ID as the filter, not just as a return column.
- Soft-delete is deferred (M1), but hard deletes must still be user-scoped.

**Complexity: S** (read + verify, small SQL patch if missing)

---

### H-2: EXIF stripping and upload validation for media uploads (Issue #46)

**Priority: P1 — M0 privacy requirement.**

**What's needed:** Strip GPS/EXIF metadata from all uploaded images before they are written to blob storage. The prior plan (m0-completion-plan.md Phase 3) has the full implementation steps. `sharp` is already in `packages/functions/package.json`. The dynamic import guard for the cross-platform binary issue is already in place (per the issue #85 notes). This just needs to be wired.

**Steps:**
1. Create `packages/functions/src/lib/image-sanitize.ts` with `stripExif(buffer: Buffer): Promise<Buffer>` using `sharp(buf).rotate().toBuffer()`.
2. Call it in `uploadSourceImageToBlob()` in `blob-storage.ts` after the buffer is created, before checksum and upload.
3. Call it in the capture frame handler in `capture.ts` after the base64 buffer decode.
4. Add `validateImageUpload(contentType, sizeBytes)` in `blob-storage.ts` and apply it at both entry points (URL-sourced uploads and direct frame uploads).

**Relevant files:**
- `packages/functions/src/lib/blob-storage.ts`
- `packages/functions/src/functions/capture.ts`
- `packages/functions/package.json` — `sharp` already present

**Pitfalls:**
- `sharp` binary platform: the `sharp` package was made a dynamic import to avoid crashing when the darwin-arm64 binary is in `node_modules` and the Azure runtime is linux-x64. The dynamic import pattern must be preserved in `image-sanitize.ts` (i.e., `const sharp = await import("sharp")`). A static top-level `import sharp from "sharp"` will fail on Azure if the binary platform is wrong.
- On failure, `stripExif` must fall back to the original buffer (never reject the upload — just warn). This is the correct graceful degradation.

**Complexity: S** (implementation is straightforward, 2–3 hours)

---

### H-3: Deterministic logout fix (Issue #71)

**Priority: P1 — live bug in dev.swatchwatch.app.**

**What's happening:** `logoutRedirect()` is called without an explicit account parameter. In multi-Microsoft-account browser sessions, MSAL prompts the user to choose which account to log out of, creating a confusing UX. A `MeControl_*.js` TypeError also appears in the console.

**Fix:**
In `apps/web/src/hooks/use-auth.ts`, update the `logout` function in `B2CUserCard` / `useAuth` to pass explicit parameters:

```ts
const logout = () => {
  const account = instance.getActiveAccount() ?? accounts[0];
  instance.logoutRedirect({
    account,
    postLogoutRedirectUri: window.location.origin + "/",
    ...(account?.idTokenClaims?.login_hint
      ? { logoutHint: account.idTokenClaims.login_hint as string }
      : {}),
  });
};
```

**Relevant files:**
- `apps/web/src/hooks/use-auth.ts` — `useAuth()` hook's `logout` function
- `apps/web/README.md` — update auth notes if present

**Pitfalls:**
- `login_hint` as an optional claim requires the Entra External ID app registration to emit it. The fix works without it (falls back to account-picker for the active account only, not all Microsoft accounts). The `logoutHint` line is a progressive enhancement.
- Keep compatible with both `ciamlogin.com` (Entra External ID) and `b2clogin.com` authority modes.

**Complexity: S** (5-line change + docs update)

---

### H-4: Migration scripts renamed to dated filenames (Issue #55)

**Priority: P2 — tooling correctness.**

**What's needed:** `node-pg-migrate` expects dated filenames (`YYYYMMDDHHMM_description.sql`). Current migrations use numeric-only names (`001_initial.sql`, etc.). Rename them to the dated convention.

**Relevant files:**
- `packages/functions/migrations/` — all existing `.sql` files

**Pitfalls:**
- Rename-only operation. The migration tool tracks applied migrations by filename in the `pgmigrations` table. After renaming, the already-applied migrations in dev/prod will appear as unapplied unless the `pgmigrations` table rows are also updated to match the new names. Plan for a one-time SQL update to the `pgmigrations` table in each environment, or reset the dev DB after the rename.
- Do this before new migrations are added so the naming is consistent from here forward.

**Complexity: S**

---

### H-5: Restore `applicationinsights` telemetry (already in package.json)

**Priority: P2 — observability.**

`applicationinsights` is already in `packages/functions/package.json`. A `telemetry.ts` lib already exists (referenced in `polishes.ts` imports). The `APPLICATIONINSIGHTS_CONNECTION_STRING` env var is listed in `local.settings.json` documentation. This just needs to be confirmed as wired end-to-end and the App Insights resource in Azure connected.

**What to verify:**
1. `packages/functions/src/lib/telemetry.ts` initializes `appInsights.setup(connectionString)` conditionally on the env var.
2. The App Insights connection string is set in Azure App Settings for the dev function app.
3. Key events (`polish.created`, `capture.finalized`, `auth.success/failure`) are being tracked.

**Relevant files:**
- `packages/functions/src/lib/telemetry.ts`
- `packages/functions/local.settings.json`
- `.github/workflows/deploy-dev.yml` — check if `APPLICATIONINSIGHTS_CONNECTION_STRING` is in the `az functionapp config appsettings set` call

**Complexity: S** (verify + one setting in deploy workflow)

---

## Section 3 — High Value, Higher Effort

### M-1: esbuild/tsup bundling for functions (Issue #95)

**Priority: P2 — eliminates an entire class of deploy bugs.**

**What's needed:** Bundle `swatchwatch-shared` directly into the functions `dist/` output using `tsup` or `esbuild`, so the deploy artifact is self-contained without any workspace symlink or tarball dependency.

**Why it matters:** The current tarball approach (PR #94) is correct and working, but the deploy step does significant packaging work (pack, rewrite `package.json`, `npm install`, symlink guardrail). Five rounds of fixes have gone into this flow. Bundling eliminates the problem at its source.

**Implementation sketch:**
1. Add `tsup` as a dev dependency in `packages/functions`.
2. Create `packages/functions/tsup.config.ts`:
   ```ts
   import { defineConfig } from "tsup";
   export default defineConfig({
     entry: ["src/index.ts"],
     format: ["cjs"],
     target: "node20",
     external: ["@azure/functions", "sharp", "pg", "applicationinsights"],
     bundle: true,
     splitting: false,
     sourcemap: true,
     outDir: "dist",
   });
   ```
3. Replace `"build": "tsc"` with `"build": "tsup"` in `packages/functions/package.json`.
4. Verify `func start` still works locally with the bundled output (`func start` uses `main: dist/index.js`).
5. Simplify `deploy-dev.yml` packaging: remove the tarball pack, rewrite, and guardrail steps. The deploy dir becomes just `dist/` + `host.json` + production `node_modules` (external deps only — `sharp`, `pg`, etc.).

**Relevant files:**
- `packages/functions/package.json`
- `packages/functions/tsconfig.json`
- `.github/workflows/deploy-dev.yml` — packaging steps (lines 69–101)
- `packages/shared/package.json`

**Pitfalls:**
- Azure Functions v4 with the Node.js worker expects multiple `app.http()` registrations. `tsup` with a single entry point and `splitting: false` should produce one CJS file that registers all routes at load time — this is correct for v4.
- Mark `@azure/functions` as external (Azure injects this at runtime via the worker bundle). Bundling it in will create a version mismatch. Same for `sharp` (native binary), `pg` (native addons), and `applicationinsights`.
- Test locally with `func start` before deploying. The Azure Functions CLI uses `main` from `package.json` to find the entry point, which still points to `dist/index.js`.
- `node-pg-migrate` is a dev dependency used only for migrations — it does not need to be bundled or deployed.
- This should be done after B-1 is diagnosed, not before — bundling may change the module loading behavior in ways that make B-1 harder to isolate if done simultaneously.

**Complexity: M** (2–4 hours + careful testing)

---

### M-2: Server-backed polish search and pagination (Issue #26)

**Priority: P2 — scalability, but usable now with client-side filtering for small collections.**

**What's needed:** `/polishes` page and `/polishes/search` color wheel currently load the full dataset on mount and filter client-side. For large collections (1000+ items), this becomes unusable.

**What to do:**
- `GET /api/polishes` already accepts `pageSize` and `page` in SQL. Expose `availability`, `includeAll`, and `view=colors` query params from the handler.
- `apps/web/src/lib/api.ts` — forward filter flags, support `AbortController`.
- `/polishes` page — debounce search input, send query params to API, render paginated results.
- `/polishes/search` — stream color data in pages via the same endpoint, stop double-loading.
- Consider a shared `usePolishQuery` hook so both views reuse the same fetch logic.

**Relevant files:**
- `packages/functions/src/functions/polishes.ts`
- `apps/web/src/lib/api.ts`
- `apps/web/src/app/(app)/polishes/page.tsx`
- `apps/web/src/app/(app)/polishes/search/page.tsx`

**Complexity: M** (full stack, 4–8 hours)

---

### M-3: Blob container provisioning (Issue #48)

**Priority: P2 — infrastructure correctness.**

**What's needed:** Provision and confirm `user-media-private`, `thumbs`, `normalized`, and optionally `public-swatch` containers in Azure Blob Storage with private access enforcement.

**What to verify:**
1. Check `infrastructure/main.tf` — are these containers defined?
2. If not, add `azurerm_storage_container` resources for each.
3. Confirm `public_access` is set to `"private"` for `user-media-private` and `thumbs`.
4. The `blob-storage.ts` code references container names from env vars (`SOURCE_IMAGE_CONTAINER`). Verify the env var values match the provisioned container names.

**Relevant files:**
- `infrastructure/main.tf`
- `packages/functions/local.settings.json`
- `infrastructure/README.md` — update resource table

**Complexity: S–M** (depends on current Terraform state)

---

### M-4: Shared types alignment with canonical schema (Issue #50)

**Priority: P3.**

**What's needed:** Audit `packages/shared/src/types/` against `docs/schema.sql` for any mismatches. The `polishes.ts` function file still has a local `Polish` interface noted in `CLAUDE.md` as a known duplicate — new code imports from `swatchwatch-shared`, but the old local definition should be removed.

**Relevant files:**
- `packages/shared/src/types/`
- `packages/functions/src/functions/polishes.ts` — check for local type duplication
- `docs/schema.sql`

**Complexity: S**

---

## Section 4 — Post-M0 (M1+)

These items are explicitly out of scope for M0. Do not start them until M0 acceptance criteria are met.

| Item | Issue | Milestone | Notes |
|------|-------|-----------|-------|
| Admin user management (list users, password reset, editable settings) | #45 | M1 | Needs B2C admin API integration |
| Multi-finish shades from tags | #43 | M1 | Schema + API + UI change |
| Real camera/frame ingestion (Rapid Add) | #21 | M1 | Mobile + web camera UX |
| Durable capture finalize pipeline (OCR + parse + resolver) | #20 | M1 | Azure Durable Functions or equivalent |
| Color theory harmonies (OKLCH, 6+ harmony types) | #4 | M1–M2 | Large feature, culori library |
| OpenAI optional/configurable in Terraform | #37 | M1 | Already partially done, checklist items in #44 |
| ESM migration (monorepo to native ES modules) | #2 | M1–M2 | High-risk, do after B-1 is stable |
| Deprecated npm dependencies cleanup | #1 | M1 | `rimraf`, `inflight`, `glob`, `node-domexception` |
| Server-backed search/pagination (if M0 collections stay small) | #26 | M1 | Move up if collections grow |
| End-to-end cross-user access test | #53 | M1 | Automated test, not manual |
| Voice processing (currently a stub) | — | M1 | Azure Speech + OpenAI wired |
| Mobile app (Expo/RN) | — | M1 | Not started |
| Gated deploy to staging/production | — | M1 | After dev is stable |
| Soft-delete for polishes | — | M1 | Currently hard delete |
| User data export / GDPR delete | — | M4 | |
| Budget/alert dashboards | — | M4 | |

---

## Execution Order

```
B-1  Diagnose + fix 0-functions (Azure)     ██████████████████  ~1–2 days  ← FIRST
B-2  Restore smoke test in CI               ██                  ~30 min    ← do when B-1 is confirmed
H-1  Per-user API authorization             ████                ~2 hours
H-2  EXIF stripping + upload validation     ████                ~2 hours
H-3  Deterministic logout fix               █                   ~30 min
H-4  Migration filename convention          ██                  ~1 hour
H-5  App Insights wiring verify             █                   ~30 min
M-1  esbuild/tsup bundling (#95)            ████████            ~4 hours   (do after B-1 resolved)
M-2  Server-backed search/pagination        ████████████        ~6 hours
M-3  Blob container provisioning            ████                ~2 hours
M-4  Shared types audit                     ██                  ~1 hour
```

Total remaining M0 work: ~3–5 days depending on B-1 complexity.

---

## M0 "Done When" Criteria

- [ ] `GET /admin/functions` on the deployed dev function app returns a non-empty list of registered routes
- [ ] Smoke test passes in CI after every deploy to `dev` branch
- [ ] A user cannot access or modify another user's inventory or media via the API (verified by inspection of SQL WHERE clauses)
- [ ] Uploaded images have EXIF/GPS metadata stripped before blob storage
- [ ] Uploads outside allowed size/type (>5MB, non-image MIME) are rejected with a 400
- [ ] Sign-out from the web app works without an account picker prompt in a multi-Microsoft-account browser session
- [ ] `npm run dev:functions` works locally (local dev workflow unaffected by any deploy changes)
- [ ] `npm run build` produces a clean, type-error-free build across all workspaces
- [ ] All M0 DB migrations (001–009) apply cleanly from a fresh database via `npm run migrate`
- [ ] Key events (polish created, capture finalized, auth success/failure) appear in Application Insights for the dev environment
- [ ] Auth dev bypass (`AUTH_DEV_BYPASS=true`) works for local dev and can be toggled off in Azure App Settings without a code change

## Out of Scope (explicitly deferred)

- Voice input (Azure Speech + OpenAI parsing) — M1
- Real camera capture (Rapid Add) — M1
- Mobile app — M1
- Gated stg/prod deploy — M1
- Soft-delete for polishes — M1
- ESM migration (#2) — M1–M2 (high-risk, do when dev is stable)
- Deprecated dependency cleanup (#1) — M1
- User data export / GDPR — M4
