# Week 0 "Land now" — Subagent Execution Plan

_Date: 2026-10-17_
_Roadmap row: `docs/roadmap-2026-10-to-12.md` §1 → **Land now** | PRs #256, #258, #237; #245 flaky test; #227 owner-scoped image ids (security) | Week 0 (20–24 Oct)_
_Scope note: the other Week 0 items (hex-detection decision gate, #224 decisions, closing M0/M1) are **not** in this plan._

---

## 0. Where things actually stand (verified 2026-10-17 04:30 UTC)

The roadmap row was written on 16 Oct. Since then most of it moved:

| Item | Roadmap says | Actual state | Remaining work |
|---|---|---|---|
| PR #256 on-nail image selection | merge | **merged into `dev`** 03:51 UTC (`28d1551`); on `main` since #276 | none |
| PR #258 migration rename | merge | **merged into `dev`** 03:47 UTC (`279f331`); on `main` since #276, prod migrate step ran clean | none |
| PR #237 CodeRabbit fixes | merge | **merged into `dev`** 03:46 UTC (`fb0f8ea`); on `main` since #276 | none |
| dev → main release | cut one | **shipped**: PR #276 merged to `main` as merge commit `6420309`; Deploy Prod green; `dev` fast-forwarded | none |
| #245 flaky tampered-signature test | fix + close | **closed** (fixed by PR #246, hardened in #237, shipped to `main` in #276) | none |
| #227 owner-scoped image ids | fix | **PR #283 open against `dev`** (C2–C7 done; security-review fixes in `04708db`; CI green) | C8: address review, squash-merge to `dev`, second dev → main release, close #227 |
| PR #275 roadmap doc | — | **merged** | none |

**Consequence:** this plan is ~15% release mechanics, ~5% hygiene, ~80% the #227 build. _Status 17 Oct: Tracks A and B are complete (A1–A3, B1); Track C is at C8._

### Facts that shape #227 (read these before touching code)

- `GET /api/images/{id}` (`packages/functions/src/functions/images.ts`) is `authLevel: "anonymous"`, no `withAuth`. Ids are `v2.<b64url(storageUrl)>.<exp base36>.<b64url(HMAC)>` minted by `packages/functions/src/lib/image-proxy.ts`. **They already expire** (default 3 days, day-bucketed). The remaining gap is owner scoping.
- The proxy may only read blobs in `SOURCE_IMAGE_CONTAINER` (default `source-images`) — `defaultReadableContainers()` in `lib/blob-storage.ts`. That container holds **public catalog imagery only**.
- **No private user media is stored in blobs today.** Capture frames are persisted as `image_asset` rows with `storage_url = 'inline://capture/...'` (bytes are not kept), see `capture.ts` ~L349 and ~L1329. Terraform already creates a private `nail-photos` container (`infrastructure/main.tf` L359) that **no code references** and no app setting exposes. `Polish.nailImageUrl` exists in `packages/shared/src/types/polish.ts` L51 but nothing populates it.
- So the #227 gap is **latent today** and becomes real in Sprint 3 with #270 (private nail photo per polish), which explicitly depends on #227. Week 0 must deliver the mechanism and flip the pinned tests, not migrate data.
- Azure OpenAI vision (sync and batch) fetches **catalog** images through this proxy anonymously (`lib/ingestion-repo.ts` ~L366, `INGESTION_AI_IMAGE_PROXY_ORIGIN`). That path must keep working unauthenticated.
- The web app renders proxied URLs with `<img>` / Next `<Image unoptimized>` (`apps/web/src/app/(app)/polishes/page.tsx` ~L718, `polishes/detail/polish-detail-client.tsx` ~L344, `components/color-search-results.tsx` ~L122). `<img>` cannot send `Authorization`. The web keeps the MSAL token in memory (`apps/web/src/lib/auth-token.ts`) and `withCors` already sets `Access-Control-Allow-Credentials: true`. Mobile has no image consumers.
- Pinned tests to flip: `packages/functions/tests/access-control.unit.test.cjs` L1242–L1262, `describe("known gap #227 — …")` (two `it`s). The surrounding `describe("images signed-id (requires #47)")` block (L1142+) mints `PRIVATE_URL` in a `user-uploads` container with `mintId()` and asserts 200 for the positive control — those will need the new owner argument. Test auth is `Bearer dev:<id>` via `invoke(route, { userId })` (L452–L455); `sqlCalls` and `sideEffects.blobReads` record side effects.
- Redis cache keys for polish list and detail already include `userId` (`polishes.ts` L383–L395), so per-user image ids are cache-safe.
- The e2e suite (`tests/access-control.e2e.test.cjs` L419–L461) flips the **first** signature char, not the last, so it is not affected by the #245 bug.

### Decisions already made (do not reopen in subagent threads)

1. **Public catalog images stay anonymous and cacheable.** Any URL inside `SOURCE_IMAGE_CONTAINER` keeps minting `v2` ids exactly as today. Zero change for Azure OpenAI, CDN caching, or existing clients.
2. **Private media gets a new `v3` owner-scoped id**, minted only for URLs **outside** the catalog container, with the owner's `user_id` and a short expiry bound into the HMAC. Serving a `v3` id requires a valid bearer token whose `userId` equals the bound owner; otherwise 401 (no/invalid token) or 403 (other user). Response is `Cache-Control: private, max-age=<min(300, remaining)>` plus `Vary: Authorization`.
3. **No cookies.** The web fetches private images with the bearer header and renders an object URL (small hook). Cookie auth would need CSRF and SameSite work that nothing else in the app needs.
4. **Fail closed at mint time.** Minting a non-catalog URL without an owner throws; `polishes.ts` already turns mint failures into `null` (image omitted).
5. **Container allowlist by scope.** `v2` ids may read only `SOURCE_IMAGE_CONTAINER`. `v3` ids may read only `USER_MEDIA_CONTAINER` (new env, default `nail-photos`). A validly signed id can never cross containers.
6. **Ownership is decided at mint time** from `image_asset.owner_type = 'user' AND owner_id = <caller>`; the read path does no DB lookup beyond authentication.
7. No new migration. No shared-type changes.

### Wire format (contract for C2 → C3 → C5)

```
v3.<b64url(storageUrl)>.<exp base36>.<ownerUserId base36>.<b64url(sig)>
sig = HMAC-SHA256(IMAGE_PROXY_SIGNING_KEY,
                  "swatchwatch:image-proxy:v3:" + exp + ":" + ownerUserId + ":" + storageUrl)
```

- `exp` from `IMAGE_PROXY_PRIVATE_ID_TTL_SECONDS` (default `3600`, clamped 300–86400), bucketed with `bucket = min(ttl, 900)` using the same formula as v2 so ids are stable for a few minutes.
- `decodeImageProxyIdWithExpiry()` returns `{ url, expiresAt, scope: "public" | "private", ownerUserId? }`. Legacy v1 and v2 return `scope: "public"`.
- `encodeImageProxyId(url, { ownerUserId?, nowMs? })`: catalog URL → v2 (owner ignored); non-catalog URL with owner → v3; non-catalog URL without owner → throws `ImageProxyScopeError` (new, extends `Error`).
- `toImageProxyUrl(requestUrl, url, opts?)` and `toImageProxyUrlFromOrigin(origin, url, opts?)` pass `opts` through. Existing two-argument calls keep compiling.
- `isCatalogStorageUrl(url)` moves from `images.ts` (`isCatalogImageUrl`) into `lib/blob-storage.ts` so `image-proxy.ts` can use it without a circular import; `images.ts` re-exports or imports it. Add `userMediaContainer()` next to `defaultReadableContainers()`.

---

## 1. Conventions for every subagent

- **Model/effort:** run subagents on Opus 5.5, effort high (one tier below the lead, per the standing preference). Reviewers (A1, C7) may run on the lead model.
- **Where to run:** this repo's cloud sessions can read but **cannot push** until the Claude GitHub App is installed for the org (or GitHub is reconnected in claude.ai settings). Run implementation packages from bridge/local sessions, which pushed fine today, or install the app first.
- **Branching:** `scripts/agent-worktree.sh <branch>` (branches from `dev`). Names: `fix/227-<slug>`, `chore/<slug>`. Never switch branches in the primary checkout.
- **PRs:** base `dev`, squash merge, conventional-commit title, fill `.github/pull_request_template.md`. Only the final #227 PR carries `Closes #227`. Do not use `--no-verify`; the pre-commit hook runs `npm test`.
- **GitHub API from cloud sessions:** GraphQL is blocked; use `gh api repos/mattmck/swatchwatch/...` (REST). Review threads: `GET /repos/mattmck/swatchwatch/pulls/{n}/ccr/review_threads`.
- **Required checks before reporting done:** `npm run typecheck`, `npm run lint`, `npm run test --workspace=swatchwatch-functions` (plus `--workspace=apps/web` for web changes). Report counts before/after. Baseline on `dev` today: functions ≈ 780 `it()` blocks across 46 files; release PR reported functions 935/935, shared 140/140, web 56/56.
- **Docs are part of the change** (CLAUDE.md "Documentation Maintenance" table). Each package below names its doc files.
- **Report back format:** branch + head SHA, PR URL, files touched, test counts, deviations from this brief, open questions. Nothing else.
- **Don't** put model names in commits/PR bodies; **don't** widen scope (no refactors of unrelated code, no new dependencies).

---

## 2. Work packages

Dependency graph (→ = must finish first):

```
A1 → A2 → A3            (release track, Mon–Tue)
B1 ─────────┘            (feeds A3's #245 closing comment)
C2 ┐
C4 ├→ C3 → C7 → C8      (#227 track; C2/C4/C5/C6-draft run in parallel on Mon)
C5 ┘        ↑
C6 (draft Mon, finalize after C3) ┘
```

Rough sizing is agent-hours of focused work, not wall clock.

### Track A — Ship #256 / #258 / #237 to `main`

#### A1 — Release go/no-go audit of PR #276 (read-only, ~1h) — DONE 17 Oct

**Goal:** a written go/no-go for merging `chore/merge-dev-into-main` with a merge commit.

**Check and record:**
1. `git fetch origin dev main chore/merge-dev-into-main`; confirm `git log origin/chore/merge-dev-into-main..origin/dev` is empty (nothing on `dev` missing from the release). Confirm commits `28d1551`, `279f331`, `fb0f8ea` are ancestors of the release head (`git merge-base --is-ancestor`).
2. `ls packages/functions/migrations` on the release head equals `dev`'s list; `025_add_color_training_sample.sql` is **absent**; `20261017033500000_add-color-training-sample.sql` present and every statement is `IF NOT EXISTS`.
3. `packages/functions/package.json` `migrate` script runs `scripts/forget-renamed-migrations.cjs` before `node-pg-migrate up`; read that script and confirm it deletes exactly the `025_add_color_training_sample` and `20261016040629000_add-color-training-sample` rows and nothing else. `.github/workflows/deploy.yml` L339–L347 runs `npm run migrate` when `DATABASE_URL` is set.
4. PR state via REST: `mergeable: true`; check runs on head all `success`; `ccr/review_threads` all `resolved: true`; CodeRabbit commit status (currently `pending`). If branch protection requires CodeRabbit (API returns 403 for protection, so test by attempting the merge in A2), note the fallback: comment `@coderabbitai review` to trigger a re-run, then wait.
5. `git diff origin/main...origin/chore/merge-dev-into-main -- .github/workflows infrastructure` — confirm no workflow/infra drift (the PR body claims none) so Deploy Prod runs code only.
6. Grep the release diff for any new required env var that Terraform or the deploy workflow does not set (PR body lists `HEX_SNAP_MAX_DISTANCE`, `HEX_EVAL_REGION_CROP_*`, `CORS_ALLOWED_ORIGINS`, `CONNECTOR_RAW_CONTAINER` as having defaults or already set — verify each has a code default).

**Output:** checklist with pass/fail per line, and the exact rollback plan: `git revert -m 1 <merge sha>` on `main` redeploys the previous build; the migration is idempotent and has no data changes, so no DB rollback is needed.

#### A2 — Merge the release and watch prod (~1h, mostly waiting) — DONE 17 Oct (#276 merged as `6420309`, Deploy Prod green, `dev` fast-forwarded, #275 merged)

**Blocked on:** A1 "go", and the human's explicit go-ahead (another session already asked for it).

1. Merge PR #276 with a **merge commit** (`gh pr merge 276 --merge --repo mattmck/swatchwatch`, or the UI). Not squash: `dev` and `main` must share history.
2. Watch `Deploy Prod` (`.github/workflows/deploy-prod.yml`): the `Run database migrations` step must show the forget script deleting the old `pgmigrations` row, then `20261017033500000_add-color-training-sample` applying; a second run would say "No migrations to run".
3. Smoke prod (`https://swatchwatch.app`): sign in, `/polishes` list renders thumbnails (ids are still `v2.`), open a detail page with `sourceImageUrls`, `/admin` loads, `GET /api/images/<id from a list response>` → 200 with `Cache-Control: public`.
4. Fast-forward `dev` to `main`: `git fetch origin main && git push origin origin/main:dev` (must be a fast-forward; if not, stop and report).
5. Merge PR #275 (roadmap doc, docs-only, `mergeable_state: clean`) into `main`, then fast-forward `dev` again.

**Output:** merge SHA, Deploy Prod run URL and conclusion, smoke results, `dev` == `main` confirmation.

#### A3 — Post-release hygiene (~30 min) — DONE 17 Oct (#245 closed, roadmap row rewritten in #278, #227 status posted)

**Blocked on:** A2 and B1.

1. Close #245 with a comment: fixed by #246 (`ebc9ff8`, `tamperSignature` + 400-day sweep) and hardened in #237; reached `main` in the release merge `<sha>`; GitHub did not auto-close because #246 targeted `dev`. Include B1's verification line.
2. Confirm `fix/245-image-proxy-flaky-test`, `fix/236-review-feedback`, `fix/migration-ordering-color-training-sample`, `claude/hex-image-select-774a7c` remote branches are deleted (branch auto-delete is on; delete any stragglers).
3. Post a one-line status on #227 that the build is in progress and link the C-track PR when it exists.
4. Update `docs/roadmap-2026-10-to-12.md` §1 "Land now" row (in a tiny docs PR, or fold into C6) to read: "#256/#258/#237 shipped in release `<sha>`; #245 closed; #227 in PR #___".

### Track B — #245 confirmation

#### B1 — Prove the flake is gone (read-only, ~30 min) — DONE 17 Oct

Runs on Monday in parallel with A1.

1. On `dev`: `grep -rn flipLastChar packages/functions/tests` → none. Read `tests/image-proxy-signing.unit.test.cjs` L75–L85 (`tamperSignature` flips a decoded byte) and L156–L175 (400-day sweep that includes 2026-10-16).
2. Run the file alone with the clock pinned to the bad day and to today: `npm run build:shared && npm run build --workspace=swatchwatch-functions && node --test packages/functions/tests/image-proxy-signing.unit.test.cjs`; then re-run with `Date.now` faked to `2026-10-16T12:00:00Z` (e.g. `node -r ./pin-date.cjs --test …` with a 5-line preload that overrides `Date.now`). Both must pass.
3. Check `tests/access-control.unit.test.cjs` L1234–L1240 and `tests/access-control.e2e.test.cjs` L446–L448 flip the **first** signature character (immune to the padding-bit issue).
4. Run the whole functions suite twice; report counts.

**Output:** the verification paragraph for A3's closing comment.

### Track C — #227 owner-scoped, expiring ids for private media

#### C2 — Library: v3 owner-scoped ids in `lib/image-proxy.ts` (~3h)

**Files:** `packages/functions/src/lib/image-proxy.ts`, `packages/functions/src/lib/blob-storage.ts` (move `isCatalogImageUrl` → `isCatalogStorageUrl`, add `userMediaContainer()`), `packages/functions/src/functions/images.ts` (import the moved helper; no behaviour change in this package), tests `image-proxy-signing.unit.test.cjs`, `image-proxy-expiry.unit.test.cjs`.

**Implement exactly the contract in §0 "Wire format".** Specifics:
- New constants: `PRIVATE_SIGNATURE_CONTEXT = "swatchwatch:image-proxy:v3:"`, `PRIVATE_ID_VERSION_PREFIX = "v3"`, `DEFAULT_PRIVATE_ID_TTL_SECONDS = 3600`, `MIN 300`, `MAX 86400`, `MAX_PRIVATE_BUCKET_SECONDS = 900`.
- `ownerUserId` must be a positive safe integer; encode base36; reject on decode if not `BASE36_PATTERN` or not a positive integer.
- Verify the signature **before** trusting `exp` or `ownerUserId` (same order as v2). Keep `CLOCK_SKEW_SECONDS`.
- `ImageProxyScopeError` for "non-catalog URL minted without an owner". Keep `ImageProxyTokenError` for every decode failure (do not leak which part failed).
- `isCatalogStorageUrl` must keep handling virtual-host and path-style (Azurite) URLs; move its existing tests (`image-proxy-expiry.unit.test.cjs` L166) with it.
- Doc comment at the top of `image-proxy.ts`: add the v3 paragraph.

**Tests to add (unit, no DB):**
- v3 round trip exposes `scope: "private"`, `ownerUserId`, and `expiresAt` within `[ttl, ttl + 900]`.
- Catalog URL + owner → still v2, `scope: "public"`.
- Non-catalog URL without owner → `ImageProxyScopeError`.
- Tampered owner (swap base36 uid), extended exp, swapped URL, wrong key, truncated/garbage signature, `v3` with 4 parts, `v2` with 5 parts → `ImageProxyTokenError`, every time.
- Expired v3 → rejected; expired v3 inside clock skew → accepted.
- `IMAGE_PROXY_PRIVATE_ID_TTL_SECONDS` clamping (299 → 300, 1e6 → 86400, garbage → default).
- Stability inside a 15-minute bucket, change across buckets.
- Day sweep like the #245 test: 400 consecutive days, tamper byte 31, for v3 as well.

**Done when:** typecheck/lint/tests green; `images.ts` compiles unchanged in behaviour; report the exported API so C3/C5 can rely on it.

#### C3 — Route enforcement + flip the pinned tests (~4h)

**Blocked on:** C2 merged into the shared feature branch (stack this PR on C2's branch or merge C2 to `dev` first).

**Files:** `packages/functions/src/functions/images.ts`, `packages/functions/src/functions/polishes.ts` (`withReadableImageUrl`, detail `imagesResult` query), `packages/functions/src/lib/telemetry.ts` (event names only, if a registry exists), tests `access-control.unit.test.cjs`, `access-control.e2e.test.cjs`.

**images.ts:**
1. Decode first. If `scope === "private"`: call `authenticateRequest(request, context)` (from `lib/auth.ts`). `AuthError` → `401 { error: "Unauthorized" }`; `auth.userId !== ownerUserId` → `403 { error: "Forbidden" }`. Emit `trackEvent("image_proxy.private_denied", { reason })` on both. Admins get **no** bypass (keep it simple; add later if an admin review queue needs it).
2. Read the blob with `readBlobFromStorageUrl(storageUrl, { allowedContainers: scope === "private" ? [userMediaContainer()] : defaultReadableContainers() })`.
3. Private responses: `Cache-Control: private, max-age=<min(300, remaining)>` (extend `selectImageCacheControl` with a `scope` input rather than branching inline), plus `Vary: Authorization`. Transforms (`w`, `h`, `fm`) keep working for private images.
4. Route stays `authLevel: "anonymous"` (the public path needs it). Update the handler doc comment.

**polishes.ts:**
5. Extend the detail `imagesResult` SQL to select `ia.owner_type, ia.owner_id`. In `withReadableImageUrl(imageUrl, requestUrl, { ownerUserId? })`: catalog URL → unchanged; non-catalog URL → mint v3 only when `owner_type = 'user' AND owner_id = userId`, else omit (`null`). `withReadableSwatchUrl` (swatch thumbnails) keeps the catalog-only path. Nothing populates `nailImageUrl` yet; leave it.
6. Confirm `lib/ingestion-repo.ts` ~L366 can never hit a non-catalog URL (it mints for `uploadSourceImageToBlob` results) — add a one-line comment, no code change.

**Tests — `access-control.unit.test.cjs`:**
7. Add `CATALOG_URL = "https://swatchwatchacct.blob.core.windows.net/source-images/holotaco/a.png"` and point the existing v2 forgery cases (empty/garbage/wrong-key/transplanted/flipped signature, positive control) at it. Set `SOURCE_IMAGE_CONTAINER`/`USER_MEDIA_CONTAINER` in the block's env setup; `PRIVATE_URL`/`OTHER_URL` move to the `nail-photos` container.
8. `mintId(url, { ownerUserId })` passes the owner through `toImageProxyUrl`. Assert `mintId(PRIVATE_URL)` (no owner) **throws**.
9. Replace the two `known gap #227` tests with a `describe("owner-scoped private ids (#227)")` block: owner token → 200, `blobReads == [PRIVATE_URL]`; attacker token → 403, `blobReads == []`; no header → 401, `blobReads == []`; expired v3 (mint with `nowMs` two hours back) → 403; v3 transplanted onto `OTHER_URL` → 403; v2 id for a `nail-photos` URL is impossible to mint, and a hand-built one with the real key is still refused because the container is not in the v2 allowlist (403, `blobReads == []`); `sqlCalls` may contain the dev-bypass user lookup but nothing else.
10. Keep the comment block honest: delete the "KNOWN GAP" paragraph.

**Tests — `access-control.e2e.test.cjs`:**
11. Add a forged `v3` envelope (random uid, attacker MAC) to the `attempts` map → rejected before blob lookup. Add an owner-scoped positive case guarded by `E2E_PRIVATE_IMAGE_URL` (skip with a diagnostic when unset; dev seed has no private media yet).

**Done when:** full functions suite green; `npm run test:e2e` passes or skips cleanly against a local host; report the exact set of changed assertions.

#### C4 — Storage allowlist, env, Terraform (~1.5h, parallel with C2)

**Files:** `packages/functions/src/lib/blob-storage.ts` (`userMediaContainer()` reads `USER_MEDIA_CONTAINER`, default `nail-photos`, normalised like `SOURCE_IMAGE_CONTAINER`), `packages/functions/local.settings.json.example` (`USER_MEDIA_CONTAINER`, `IMAGE_PROXY_PRIVATE_ID_TTL_SECONDS`), `infrastructure/main.tf` (function app settings: `USER_MEDIA_CONTAINER = azurerm_storage_container.nail_photos.name`; optionally `IMAGE_PROXY_PRIVATE_ID_TTL_SECONDS = "3600"`), `infrastructure/README.md`, `tests/blob-storage.unit.test.cjs`.

- Coordinate the `blob-storage.ts` edit with C2 (C2 moves `isCatalogStorageUrl` into the same file). Simplest: C4 lands first, C2 rebases.
- Unit tests: `readBlobFromStorageUrl(url, { allowedContainers: [userMediaContainer()] })` accepts `nail-photos`, denies `source-images`, honours the env override, path-style included.
- Terraform: run `terraform fmt` and `terraform validate` only (no plan/apply from an agent). Note in the PR that `deploy-infra-*` picks it up and that the code default means nothing breaks if infra lags.

#### C5 — Web: authenticated private image rendering (~2h, parallel; required before #270, acceptable to slip to Sprint 3)

**Files:** `apps/web/src/lib/private-image.ts` (+ `.test.ts`), `apps/web/src/components/private-image.tsx`, `apps/web/README.md`.

- `isPrivateImageUrl(url)`: pathname starts with `/api/images/v3.`.
- `usePrivateImage(url)`: `fetch(url, { headers: getAuthHeaders() })` → `URL.createObjectURL(blob)`; revoke on unmount/url change; on 401/403 return `{ status: "denied" }`, on network error `{ status: "error" }`. Reuse `getAuthHeaders` from `apps/web/src/lib/api.ts` (dev bypass header included).
- `<PrivateImage src alt className …>`: renders a plain `<img>` for public URLs, the hook for private ones, a neutral placeholder while loading/denied. Not wired into any page yet (nothing emits v3 ids until #270); add a Vitest unit test for the URL predicate and the hook's cleanup.
- Doc: components section of `apps/web/README.md`.

#### C6 — Documentation sweep (~1.5h; draft Mon, finalize after C3)

**Files:** `packages/functions/README.md` (L26–L29 test description, L97 route table row, L113 anonymous-routes sentence, L120–L122 image proxy bullets, env table L671–L673), `CLAUDE.md` (Environment Variables: add `USER_MEDIA_CONTAINER`, `IMAGE_PROXY_PRIVATE_ID_TTL_SECONDS`; Completed list: image proxy bullet), `docs/roadmap-2026-10-to-12.md` §1 row (see A3.4), `docs/schema.sql` comment on `image_asset.owner_*` (one line: owner decides private-id scope).

- Replace the `known gap #227` README note with the v3 behaviour: anonymous public ids for catalog blobs, bearer-authenticated owner-scoped ids for `USER_MEDIA_CONTAINER`, status codes, cache headers, the two TTL envs.
- Do not describe anything C3 did not ship; read the final diff first.

#### C7 — Independent security review of the combined #227 diff (~2h, lead model)

Give the reviewer the diff, **not** this plan's conclusions. Ask for: signature-before-trust ordering, timing-safe compares, base64url canonical-encoding check applied to v3, no cross-container read via any id version, no info leak in 401/403 bodies, auth errors not turning into 500s, `Vary`/cache correctness, Redis cache keys still per-user, Azure OpenAI catalog path untouched, legacy v1 window untouched, and adversarial test ideas not already covered. Findings go back to C3 as a checklist; re-review only the fixes.

#### C8 — Land #227 (~1h + CI wait)

1. One PR to `dev`: `fix(functions): owner-scope and expire private-media image ids` with `Closes #227`, PR template filled, test counts, and a short "how to verify on dev" section. Address CodeRabbit/Copilot comments; resolve threads via the `ccr` REST routes.
2. Squash-merge; watch `Deploy Dev`; run `npm run test:e2e` against dev with `E2E_API_BASE` if credentials exist, else the local host.
3. Open the second `dev → main` release of the week (merge commit again), merge after green, watch Deploy Prod, fast-forward `dev`. Confirm `/api/images/<v2 id>` on prod still returns `Cache-Control: public`.
4. Comment on #270 that the owner-scoped proxy is live and name the helper to call.

---

## 3. Schedule (20–24 Oct)

| Day | Release track | #227 track |
|---|---|---|
| Mon 20 | A1 audit → human go-ahead → A2 merge + watch prod; B1 in parallel | C2, C4, C5 start in parallel; C6 drafts |
| Tue 21 | A3 hygiene (close #245, merge #275, roadmap row) | C4 lands; C2 lands; C3 starts |
| Wed 22 | — | C3 finishes; C7 review; fixes |
| Thu 23 | — | C8.1–2: PR to `dev`, bots, merge, Deploy Dev, e2e |
| Fri 24 | C8.3 second release to `main`, close #227 | buffer |

Definition of done for the row: `main` contains #256/#258/#237 and the #227 fix, Deploy Prod green twice, #245 and #227 closed, the `known gap #227` block gone from the test suite and README, and the roadmap row rewritten.

---

## 4. Risks and what to do about them

| Risk | Signal | Response |
|---|---|---|
| CodeRabbit `pending` status blocks the #276 merge | merge button disabled / API 405 | comment `@coderabbitai review`; if protection truly requires it and it does not clear within 30 min, the human can merge as admin — do not bypass from an agent |
| Prod migration: `forget-renamed-migrations.cjs` runs against a DB that applied `025_add_color_training_sample` from #252 | deploy log | expected: row deleted, idempotent migration re-applies. #258 tested this state. If `node-pg-migrate` still errors, redeploy previous `main` (revert merge commit) and debug on a scratch DB |
| C2 and C4 both edit `blob-storage.ts` | merge conflict | land C4 first (small), C2 rebases |
| Flipping the known-gap tests breaks other `describe` blocks that reuse `mintId(PRIVATE_URL)` | test failures in C3 | that's why C3.7 re-points v2 forgery cases at `CATALOG_URL` |
| Private id TTL (1h) shorter than a Redis-cached polish response | stale 403s in UI | detail/list cache TTLs are ~90s; C5's hook treats 403 as "refetch the polish", and C3 should assert `POLISH_DETAIL_CACHE_TTL_SECONDS < private TTL` in a test |
| Terraform change triggers infra deploy with unrelated drift | `deploy-infra-*` plan shows more than one app setting | stop; the code default keeps the feature working without the setting |
| Agents cannot push from cloud sessions | push refused | run from bridge/local sessions or install the Claude GitHub App for the org |
