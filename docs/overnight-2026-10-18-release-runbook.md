# Overnight batch 2026-10-18 → 19: release runbook

_Written 2026-10-19 by the overnight lead session. Everything below is for the owner; nothing in it was run against Azure overnight._

## 0. What the batch is

Ten PRs, built in parallel off `dev`, merged **one by one in the order below**. Each PR branch was
pushed forward so it already contains the PRs before it, with the cross-branch conflicts resolved
once (the same resolutions were verified together: build, typecheck, lint and every unit suite).
So each PR is mergeable the moment the previous one lands, with no manual conflict step.

Order: **#371 → #375 → #374 → #373 → #372 → #370 → #377 → #376 → #378 → #379.**
Merge each with **Create a merge commit** (not squash), so the branch histories stay connected
(see #365 for why a squash diverged `dev` and `main` last time). Until a PR's predecessors merge,
its "Files changed" tab also shows their changes; it shrinks to its own once they land. #378 and
#379 are stacked on #370 and #376: GitHub retargets them to `dev` when their base branch is
deleted on merge.

| PR | What a user gets |
|---|---|
| [#375](https://github.com/mattmck/swatchwatch/pull/375) | Barcode scans match the catalog: `barcode` rows at ingest + backfill, resolver fallback through `external_product.gtin`, decoded value sent as frame evidence, unknown-barcode path, per-user learned barcodes, GTIN normalization |
| [#374](https://github.com/mattmck/swatchwatch/pull/374) | #348: list page / filters / sort survive detail → back; `returnTo` on every detail link; gaps and color search state in the URL |
| [#370](https://github.com/mattmck/swatchwatch/pull/370) + [#378](https://github.com/mattmck/swatchwatch/pull/378) | `/polishes/looks`: vibe → three looks from owned shades, swap / shuffle / wear / save; shopping list with buy links, detail drawer, copy-to-share |
| [#373](https://github.com/mattmck/swatchwatch/pull/373) | #105: per-color matches, scope / finish / family filters, wishlist and own from results, skin and background chips hidden by default |
| [#377](https://github.com/mattmck/swatchwatch/pull/377) | #349 + #347: `shade.product_category`, classifier, dry-run backfill, accessory exclusion, category-aware dupes / search / gaps / stats / Pick for me, decision D23 |
| [#372](https://github.com/mattmck/swatchwatch/pull/372) | Getting-started checklist on the dashboard and honest empty states |
| [#376](https://github.com/mattmck/swatchwatch/pull/376) + [#379](https://github.com/mattmck/swatchwatch/pull/379) | Expo app: auth, API client, Collection / Detail / Search / Profile, native barcode Rapid Add (check-first), Match, home panel with Pick for me, mani log, offline cache, Mobile CI job |
| [#371](https://github.com/mattmck/swatchwatch/pull/371) | #328: Pahlish store filter; Pahlish, Emily de Molly and Cirque Colors enabled (sign-offs noted in `data_source.metadata.notes`; who and how were not recorded); survey in `docs/indie-sources-2026-10.md` |

Five migrations ship with it and run in the deploy pipeline (`npm run migrate` step):
`20261019011858000_shade-product-category`,
`20261019013349049_add-more-indie-shopify-sources`,
`20261019020000000_enable-signed-off-indie-sources`, `20261019020500000_user-look`,
`20261019030000000_barcode-provenance-and-user-barcodes`. Every shade starts as `color` and no
barcode rows exist until the backfills in §3 run, so the deploy itself changes no catalog data.
(The product-category migration was later renamed to `20261022190729000_shade-product-category`: it
reached `dev` after the later-dated migrations had already run there, so `node-pg-migrate` refused to
run it out of order and every Deploy Dev failed from 2026-10-20.)

## 1. Merge to `dev` and verify the dev deploy

1. Merge the ten PRs in the order above, each with **Create a merge commit**.
2. Each merge pushes `dev` and triggers **Deploy Dev** (`.github/workflows/deploy-dev.yml`). Watch it:

   ```bash
   gh run list --workflow=deploy-dev.yml --limit 1
   ```

   then `gh run watch <id>`. Green means: migrations applied, Functions and web deployed to
   https://dev.swatchwatch.app.
3. Smoke on dev (5 minutes): sign in → dashboard shows the getting-started card for a fresh user
   → `/polishes` page 3 with a filter → detail → back keeps page 3 → `/polishes/looks` renders
   three looks → `/rapid-add` "Upload photo" with any EAN-13 image gives a verdict (fallback
   through `external_product.gtin` works before the backfill) → `/admin?tab=review-queue` shows
   the Product categories panel.

## 2. Release `dev → main` and verify prod

1. Open the release PR the usual way (`chore: release dev → main`, base `main`, head `dev`), listing
   the ten PRs above; merge it with a **merge commit**.
2. The push to `main` triggers **Deploy Prod** (`deploy-prod.yml`). Unlike the ten PRs, the
   `dev → main` diff **does** include infrastructure files: #380 (already on `dev`) changed
   `infrastructure/main.tf`, `variables.tf`, `.github/workflows/deploy-infra.yml` and
   `infrastructure/README.md` (Azure OpenAI region guard). So the infra job runs a real Terraform
   plan. Before releasing, confirm the `prod` GitHub environment has `OPENAI_LOCATION=centralus`
   (the committed callers already pass `centralus`). While it runs, check the **Validate Azure OpenAI
   region** and **Guard against Azure OpenAI account replacement** steps pass, and that the plan
   shows no `azurerm_cognitive_account` / `azurerm_cognitive_deployment` delete or replace. If the
   guard fails, stop and do not set `allow_openai_replace`. Watch:

   ```bash
   gh run list --workflow=deploy-prod.yml --limit 1
   ```

3. Check the prod alerts stay quiet for 30 minutes (API 5xx, exception spike, availability tests) and
   repeat the dev smoke list on https://swatchwatch.app.

## 3. Backfills (dev first, then prod)

Both are admin jobs with a dry run that writes a report and changes nothing. Get an admin bearer
token from the web app (DevTools → Network → any `/api` request → `Authorization`), then load it
into your shell without typing it on a command line, so it stays out of shell history and `ps`:

```bash
read -rs ADMIN_BEARER_TOKEN && export ADMIN_BEARER_TOKEN   # paste the token, press Enter
export API_BASE_URL=https://<dev-function-app>.azurewebsites.net/api
```

(For prod, set `API_BASE_URL` to the prod Function App in a fresh shell.) The commands below read
both from the environment.

### 3a. Product categories (#377, plan Phase 6)

1. Baseline audit on dev: `psql "$DEV_DATABASE_URL" -f docs/queries/catalog-hygiene-audit.sql > audit-dev-before.txt` (section 4b has user ids; keep the file local).
2. Dry run:

   ```bash
   npm run backfill:product-category --workspace=swatchwatch-functions -- --out dev-dry-run.json
   ```

   (or Admin → Review Queue → Product categories → "Dry run backfill").
3. Review `categoryChanges` samples, `topperByTagOnly` (fix wrong ones with the sticky Category
   control), `heldAccessories` (never auto-excluded; decide per shade), `topperHexCandidates`.
4. Apply: the same command with `--write`, plus `--clear-topper-hex` if the candidates look right.
   Keep the printed `runId`; every change is in `shade_category_change` under it (undo rules in #377).
5. Re-run the audit and diff against step 1: section 5 empty, section 1 matches the report.
6. Prod: baseline audit → (after §2) dry run → compare with dev's report → apply → re-audit. Then
   watch `dupe.warning_shown` on light shades drop.

### 3b. Barcodes (#375)

1. Dry run on dev:

   ```bash
   npm run backfill:barcodes --workspace=swatchwatch-functions
   ```

   Read totals, conflicts (a GTIN two shades claim: first wins, nothing overwritten) and ambiguous
   products (skipped).
2. Apply with `--write`; resume with the printed `--after <id>` if it stops. Idempotent.
3. Prod: same two steps after §2. Scans already work before this through the `external_product.gtin`
   fallback; the backfill makes them a direct `barcode` hit.

## 4. One-time owner actions

- **Mobile sign-in:** register the redirect URI `swatchwatch://auth` on the web app's registration
  in the External ID tenant (Authentication → Add a platform → Mobile and desktop applications), for
  each tenant you want to sign in from. No new registration or secret (public client + PKCE).
  Until then the app runs in dev-bypass against a local API.
- **Xcode:** install it (then `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`) to
  run the simulator checks in `apps/mobile/README.md`; the overnight verification used the Expo web
  preview only.
- **Document Intelligence in prod:** confirm `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT` / `_KEY` are set,
  or the label-photo leg of an unknown barcode falls back to the brand/shade question.
- **Indie stores:** Pahlish, Emily de Molly and Cirque Colors are enabled by migration; run their
  first ingestion from Admin → Admin Jobs and check `ingestion.job_failed` stays quiet.

## 5. Decisions taken as the recommendation (say so if you want any changed)

| # | Decision | Taken as |
|---|---|---|
| 1 | GTIN claimed by two shades | job-log warning only, no review tab yet |
| 2 | Promote learned barcodes to the shared catalog | later, with a threshold |
| 3 | D-A..D-E (category model, accessories excluded not deleted, topper-vs-topper dupes, no vision hex on toppers, ingest coats and treatments) | recorded as D23 in `docs/decisions-2026-10.md` |
| 4 | Mobile Rapid Add checks first, adds on tap (web adds on match) | keep; consider moving web to check-first |
| 5 | Root `package.json` override pinning React 19.2.3 | keep until web, mobile and `next` agree |
| 6 | Expo SDK 57 | keep |
| 7 | expo-auth-session (PKCE) instead of MSAL React Native | keep |
| 8 | Store photo-match palettes (hexes + ids, never the image) for save / share | yes, opt-in, owner-scoped; not built yet |
| 9 | Nude / tan chips hidden by default under the skin rule | keep; tune from `match.image_processed.hiddenColorCount` |
| 10 | Looks page unflagged; `GET /api/looks` = saved looks | keep |
| 11 | Gap Map "Explore seed color" opens Similar mode; breadcrumb names its destination | keep |
| 12 | `/polishes` rows as cards on phones | yes, own PR after this lands |
| 13 | Dashboard "+ Add Polish" while the checklist shows | keep, maybe rename "Add by hand" |

## 6. Not done overnight

- Anything on Azure (§1–§4 are yours).
- #322 hex gate (needs your hand labels), #325 real-device Rapid Add, #326 nail-photo e2e,
  #321 hex promote (admin-only, deprioritized for user-facing work), #274 retro.
- Follow-ups the sessions named: on-device color extraction native modules (#109), EAS build
  profiles, a topper-specific vision prompt, category on user-created polishes, photo-match history.
