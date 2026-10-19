# SwatchWatch — Decision Log, Oct 2026

_Opened 2026-10-17, while the Sprint 1–4 PR batch (#288–#311) merges._

This file collects the decisions that have to be made before work continues. They come from the
[roadmap](roadmap-2026-10-to-12.md) §6, the [observability plan](observability-plan.md)
"Open decisions", and the "Decisions made" / "Open issues" sections in PR descriptions.

**Status values:** `Proposed` (the recommendation, not yet agreed) · `Decided` · `Deferred` (with a ticket).
When a decision is made, set its status, fill in **Decision** and **Date**, and leave the
recommendation in place for the record.

## Summary

| ID | Topic | Status | Blocks |
|----|-------|--------|--------|
| D1 | Public wishlist pages | Decided | Turning on #305 |
| D2 | Which indie stores to enable first | Decided | Turning on #292 sources |
| D3 | Mobile: PWA or Expo | Decided | Q4 scope |
| D4 | Hex detection gate and freeze | Decided | The hex baseline metric |
| D5 | Inventory status rules: defaults, zero, running out (D5a–c) | Decided | #304 vs #291 consistency, the − button |
| D6 | What counts as spend | Decided | #309 stats |
| D7 | Status rule when merging shades | Decided | #298 |
| D8 | Rules for wear data | Decided | #302 |
| D9 | Private nail photo rules and orphan cleanup | Decided | #299 follow-up |
| D10 | Dupe matching when a finish is unknown | Decided | #297 |
| D11 | Record the #224 multi-finish outcomes | Decided | #288, #306 |
| D12 | Can manual hex labels feed `vendor_hex`? | Decided | #311 |
| D13 | Buy link when there's no URL, and http links | Decided | #289 |
| D14 | Browser telemetry cookies | Decided | Observability Phase 3 |
| D15 | App Insights daily caps | Decided | Observability Phase 3 |
| D16 | Alert email and scope | Decided | Observability Phase 3 |
| D17 | Observability issue numbering | Decided | Phase 3 branch name |
| D18 | How to release this batch | Decided (revised: one release) | Promoting `dev` to `main` |
| D19 | Tracking the success metrics | Decided | Roadmap §4 metrics |
| D20 | Milestones | Decided | Housekeeping |
| D21 | Owners for follow-ups | Decided | Follow-up work |
| D22 | How feature flags work | Deferred ([#313](https://github.com/mattmck/swatchwatch/issues/313)) | Nothing yet |
| D23 | Product categories and non-polish cleanup | Decided | #349, #347 |

---

## A. Feature enablement

### D1 — Public wishlist pages
- **Context:** #305 builds signed, revocable, read-only pages at `/w/{token}`. They ship switched off behind
  `SHAREABLE_WISHLIST_ENABLED`, which is off by default. Turning them on means setting the GitHub variable and running Deploy Infra.
  The Functions host request telemetry logs the path, which includes the token; only operators can see it.
- **Options:** (a) yes, opt-in per user · (b) yes, but after Black Friday · (c) no
- **Recommendation:** (a). Gift season is the reason to build this. Note in `packages/functions/README.md`
  that the token is logged.
- **Decision:** Yes, opt-in per user. Switch on `SHAREABLE_WISHLIST_ENABLED` once #305 and the inventory status rules (#314, PR #334) are in prod, so running out no longer moves a polish onto a wishlist that may be public.
- **Accepted risk:** the share token is part of the request path (`/api/wishlist/{token}`), so it appears in the Functions host's own request telemetry, the same way image proxy ids do today. Only operators can see it, and the token can be revoked. Host-side redaction isn't built.
- **Date:** 2026-10-17

### D2 — Which indie stores to enable first
- **Context:** #292 registers Night Owl Lacquer and Pahlish, both switched off. Night Owl: `products.json` is public, robots.txt
  allows it, no scraping clause in its terms, and 233 of 250 products pass the filter. Pahlish: its terms page is empty and 0 of 36 products
  pass the generic filter.
- **Options:** (a) Night Owl only · (b) neither until each owner says OK · (c) both, after a Pahlish filter
- **Recommendation:** (a). Record the approval basis in `data_source.metadata.notes`. List the next 4–8 stores
  (ILNP, Mooncat, Cirque, KBShimmer, Emily de Molly, Painted Polish, Cupcake) in priority order.
- **Decision:** Night Owl Lacquer only. Hold Pahlish until it has a store-specific filter.
- **Date:** 2026-10-17

### D3 — Mobile: PWA or Expo
- **Context:** roadmap §6.1. #294 delivers camera capture in the mobile browser and defers the mobile half of #21 to #109.
- **Options:** (a) PWA through December, Expo in January · (b) start Expo now, giving up most of Sprint 4
- **Recommendation:** (a).
- **Decision:** PWA-first through December; Expo (#109) starts in January.
- **Date:** 2026-10-17

### D4 — Hex detection gate and freeze
- **Context:** roadmap §6.3. The two-day gate hasn't run yet. #311 adds hand-labeled ground truth; the last
  eval run had only 18 cases.
- **Options:** (a) run the gate now with whatever #311 labels exist, then freeze · (b) skip it and record today's baseline ·
  (c) keep tuning · (d) **freeze tuning now; hand-label ground truth with the #311 eyedropper first, then run the gate
  once the labeled set is large enough**
- **Recommendation:** (d). With 18 cases the gate can't tell the strategies apart, so a decision made now would be noise.
  - **Until the gate runs:** production keeps the current strategy (`azure-current`), and there's no tuning work.
  - **Labeled set to aim for:** about 100–150 shades, spread across finishes (creme, jelly, shimmer, holo, multichrome,
    glitter, metallic) and at least 8–10 brands. The eval reports HIGH/MEDIUM share per brand and per finish, so a thin
    category won't produce a usable number.
  - **How to label:** sample a flat, unlit area of the polish, not a highlight, shadow or the cap. The labeler records the
    sample point, so labels can be audited later.
  - **Then:** run the five strategies against the labeled set (`npm run eval:hex -- --source-type manual`). Pick by
    HIGH-confidence share × cost, wire the winner into ingestion, and record the baseline HIGH share in roadmap §4.
  - **Depends on:** #311 merging. Roadmap §4's "frozen at Week 0 baseline" target becomes "baseline from the gate".
- **Decision:** Option (d). Stop tuning now. Hand-label polish colors with the #311 color sip admin tool, then run the gate on that labeled set.
- **Date:** 2026-10-17
- **Ticket:** [#322](https://github.com/mattmck/swatchwatch/issues/322)

## B. Product rules

### D5 — Inventory status rules: defaults, zero quantity, running out
- **Context:**
  - `POST /api/polishes` means "add to my collection". It attaches an existing catalog shade (by `shadeId`), or matches
    brand + name, or creates a private `user_submitted` shade. Then it upserts the caller's inventory row.
  - `defaultStatusForNewItem` only applies when a request creates a new inventory row and sends no `status`.
    Quantity > 0 gives `owned`; quantity 0 or missing gives `wishlist`.
  - No current screen hits that default. The add form sends `owned`, quantity 1. The +/− controls send an explicit
    status. Capture finalize sets `owned` in SQL.
  - In the web app (`quantityChangeUpdate`), pressing − on the last bottle of an owned polish sets `wishlist`. That copies
    the pre-#291 meaning, where `quantity <= 0` *was* the wishlist; nobody decided it as a product rule. The API itself
    doesn't infer status on update.
  - #304 (CSV import) makes a row with no status `owned`, or `wishlist` when quantity is 0.
  - Collector spreadsheets use 0 for both "want it" and "used it up".

#### D5a — New row with no status and no quantity
- **Options:** (a) `owned` everywhere (API and import) · (b) `wishlist`, as the API does today; import changes to match
- **Recommendation:** (a). "Add to my collection" with no details means you have it. Today's UI doesn't change, and
  quantity 0 from an old client still means what it did.
- **Decision:** Owned everywhere. Change `defaultStatusForNewItem` so no quantity gives `owned`; quantity 0 still gives `wishlist` for old clients.
- **Date:** 2026-10-17
- **Ticket:** [#314](https://github.com/mattmck/swatchwatch/issues/314)

#### D5b — Quantity 0 in an imported sheet with no status column
- **Options:** (a) leave the row undecided in the #304 review step, with bulk actions "wishlist" and "archived" plus a
  reason · (b) `wishlist` (as built) · (c) `archived`
- **Recommendation:** (a). Don't guess between "want it" and "used it up".
- **Decision:** Ask during review. Quantity-0 rows with no status stay undecided in the #304 review step, with bulk wishlist and archived-with-reason actions.
- **Date:** 2026-10-17
- **Ticket:** [#315](https://github.com/mattmck/swatchwatch/issues/315)

#### D5c — Running out (the − button on the last bottle, or quantity set to 0 in the edit form)
- **Options:** (a) **archive, then ask why**: the − archives at once (still one tap) and a toast offers
  *Used up · Gave away · Undo*. The reason is optional and defaults to used up; Undo restores owned with 1 bottle.
  Nothing goes to the wishlist on its own; **Rebuy** on an archived polish is a separate, deliberate action ·
  (b) wishlist, as built
- **Recommendation:** (a). Running out rarely means wanting it again, and with #305 the wishlist can become a public
  gift list.
  - The reason is stored as an `inventory_event` row (the table already exists, and the `event_type` comment lists
    `used`/`sold`/`decluttered`). No migration is needed.
  - Use a type distinct from the mani log's `used` (#302), such as `used_up`, so "wore it" and "finished it" stay separate.
  - The same rule and reasons apply to archived rows from import (D5b).
- **Decision:** Archive, then ask why. − on the last bottle archives with a Used up / Gave away / Undo toast; the reason is stored as an `inventory_event`; Rebuy is a separate action. Nothing goes to the wishlist automatically.
- **Date:** 2026-10-17
- **Ticket:** [#314](https://github.com/mattmck/swatchwatch/issues/314)

### D6 — What counts as spend
- **Context:** #309 counts only `owned`, `destash` and `archived` rows. It leaves out wishlist prices and doesn't multiply
  `purchase_price` by quantity.
- **Options:** (a) keep as built (price is per row) · (b) multiply by quantity
- **Recommendation:** (a), and document that `purchase_price` is the total paid for the row. Import (#304)
  and the add form should use the same meaning.
- **Decision:** Price per row, as built. `purchase_price` is the total paid for the row; spend counts owned, destash and archived rows.
- **Date:** 2026-10-17

### D7 — Status rule when merging shades
- **Context:** #298 combines duplicate inventory rows: the merge target wins and fills empty fields from the merged
  row. Since #291 a status rule is needed.
- **Options:** (a) the higher status wins: `owned` > `destash` > `wishlist` > `archived` · (b) the target always wins
- **Recommendation:** (a). A merge should never quietly change a polish someone owns into a wishlist item. It's one more case in
  `inventoryCombineExpression`.
- **Decision:** Higher status wins: owned > destash > wishlist > archived. One more case in `inventoryCombineExpression` (#298).
- **Date:** 2026-10-17
- **Ticket:** [#316](https://github.com/mattmck/swatchwatch/issues/316)

### D8 — Rules for wear data
- **Context:** #302 stores history by `shade_id`. `tried_at` is set from the earliest wear and never cleared.
  Wear dates are stored as midnight UTC of the user's local date. Deleting a polish drops its `used` events (the stats come back
  if it's re-added).
- **Options:** (a) accept all of these · (b) keep `inventory_event(used)` when an inventory row is deleted
- **Recommendation:** (a) for now. Revisit (b) if the history of archived or deleted polishes turns out to matter.
- **Decision:** Keep wear events when an inventory row is deleted (#302 follow-up). The other wear rules stay as built.
- **Date:** 2026-10-17
- **Ticket:** [#317](https://github.com/mattmck/swatchwatch/issues/317)

### D9 — Private nail photo rules and orphan cleanup
- **Context:** #299 allows one photo per inventory item, always re-encodes uploads, and returns 415 for HEIC files the bundled libvips
  can't decode. Cascade deletes outside the API leave `image_asset` rows and blobs behind.
- **Options:** (a) accept, and open a ticket for an orphan sweep job · (b) accept, plus convert HEIC on the client before upload ·
  (c) allow several photos per item
- **Recommendation:** (a) + (b). iPhones save HEIC by default, so converting on the client avoids a confusing 415.
- **Decision:** Convert HEIC to JPEG in the browser before upload, and ticket a sweep job for orphaned `image_asset` rows and blobs.
- **Date:** 2026-10-17
- **Tickets:** [#318](https://github.com/mattmck/swatchwatch/issues/318) (HEIC), [#319](https://github.com/mattmck/swatchwatch/issues/319) (orphan sweep)

### D10 — Dupe matching when a finish is unknown
- **Context:** #297 doesn't penalize unknown finishes. Finishes created in the admin UI have no family, so they always grade
  `unknown` against built-in finishes.
- **Options:** (a) accept, and add an optional `family` field to `finish_type` in the admin UI later · (b) penalize unknown finishes
- **Recommendation:** (a). Missing a likely dupe is worse than flagging an extra one.
- **Decision:** Accept as built (unknown finishes are not penalized). Later, add an optional `family` field to `finish_type` in the admin UI.
- **Date:** 2026-10-17
- **Ticket:** [#320](https://github.com/mattmck/swatchwatch/issues/320)

### D11 — Record the #224 multi-finish outcomes
- **Context:** The roadmap's Week 0 recommendations, implemented in #288 and #306:
  - **1b:** a user's `finishes` and color fields write to the catalog only when the request creates the shade. Owners can
    still correct their own private `user_submitted` shades.
  - **2a:** deleting a `finish_type` that's in use returns 409 with a usage count. Alias rows also block the delete.
  - **3:** the AI prompt's finish list comes from `loadFinishCatalog()` and leaves out `other`.
  - Renaming a finish type cascades to `shade.finishes` and aliases in one transaction. The legacy `shade.finish`
    is not rewritten, because it's part of the dedup key.
- **Recommendation:** Mark these Decided and close #224 when #288 and #306 merge. The eval-only hard-coded finish lists
  are left for the hex gate (D4).
- **Decision:** Yes, as built in #288/#306. Close #224 when both merge. The finish lists hard-coded in eval prompts wait for the hex gate (D4).
- **Date:** 2026-10-17

### D12 — Can manual hex labels feed `vendor_hex`?
- **Context:** #311 allows one hand label per shade. Labels are `approved` and exported by default. There's no "also set as vendor
  hex" option, because `vendor_hex` has no provenance columns.
- **Options:** (a) labels stay eval-only · (b) add an opt-in "promote to vendor hex", with provenance columns
- **Recommendation:** (a) for now. Revisit after D4, when labels are known to be reliable.
- **Decision:** Opt-in promote. Add a "promote to vendor hex" admin action (off by default), plus provenance columns on `vendor_hex` so promoted values can be told apart from vendor data.
- **Date:** 2026-10-17
- **Ticket:** [#321](https://github.com/mattmck/swatchwatch/issues/321)

### D13 — Buy link when there's no URL, and http links
- **Context:** #289 leaves out `buyUrl` when there's no valid URL, and keeps `http` URLs as they are.
- **Options:** (a) accept · (b) rewrite `http` to `https`
- **Recommendation:** (a). Rewriting can break a link the store never served over https.
- **Decision:** Accept as built: omit `buyUrl` when there is no valid URL, and keep http links unchanged.
- **Date:** 2026-10-17

## C. Observability Phase 3

### D14 — Browser telemetry cookies
- **Context:** the browser SDK sets `ai_user` and `ai_session` cookies. There's no consent banner.
- **Options:** (a) keep the cookies, no banner · (b) `disableCookiesUsage: true`; user and session counts become approximate · (c) add a
  consent banner
- **Recommendation:** (b) until there's a decision on a banner. Errors, traces and correlation still work, and it avoids
  consent questions for EU visitors.
- **Decision:** Keep the cookies, no consent banner. Known risk: EU ePrivacy rules generally expect consent for non-essential analytics cookies. Revisit if EU traffic grows or a banner is added for other reasons.
- **Date:** 2026-10-17

### D15 — App Insights daily caps
- **Options:** (a) 1 GB/day dev, 5 GB/day prod · (b) other
- **Recommendation:** (a), with the D16 alert firing when a cap is hit.
- **Decision:** Lower caps: 0.5 GB/day dev, 2 GB/day prod, instead of option (a)'s 1 GB/day dev and 5 GB/day prod, with a cap-hit alert (D16). Phase 3 (#332) lowered the `appinsights_daily_cap_gb` defaults from #282's 5 prod / 1 otherwise.
- **Date:** 2026-10-17

### D16 — Alert email and scope
- **Options:** (a) prod only · (b) prod and dev
- **Recommendation:** (a). Needs the email address.
- **Decision:** Prod only (`alerts_enabled=false` in dev). The action group emails the owner's address, set through `var.alert_email`, not committed in tfvars.
- **Date:** 2026-10-17

### D17 — Observability issue numbering
- **Options:** (a) one tracking issue for Phase 3 · (b) one issue per alert
- **Recommendation:** (a), so the branch can be `feat/<issue#>-observability-alerts`.
- **Decision:** One tracking issue for Phase 3: the existing #281 (it already covers alerts); branch `feat/281-observability-alerts`.
- **Date:** 2026-10-17
- **Ticket:** [#281](https://github.com/mattmck/swatchwatch/issues/281)

## D. Process

### D18 — How to release this batch
- **Context:** about 20 PRs, several with migrations, all landing on `dev`.
- **Options:** (a) one release, after a full migrate up/down on a fresh dev DB · (b) releases by sprint
  (Sprint 1+2 before Black Friday, 3+4 after)
- **Recommendation:** (b). Black Friday is 27 Nov, and dupe finder, Rapid Add and the wishlist need to be live before it. Shipping in smaller pieces
  keeps one bad migration from blocking everything.
- **Decision:** Release by sprint. Sprint 1+2 (collection, import/export, color family, dupes, add guard, Rapid Add, buy link, wishlist) before Black Friday (27 Nov); Sprint 3+4 after.
- **Date:** 2026-10-17
- **Revised 2026-10-17:** one release (option (a)). By the time the batch was ready, Sprint 3 and 4 work (#308, #309, #311,
  #338, #339) had already merged into `dev`, so releasing by sprint would have meant cherry-picking. The release carries
  12 new migrations (11 on `dev` plus #338's), so the option (a) safeguards apply: migrate up and down on a fresh database
  before prod, then smoke-test dev. The pre-release checklist is on #274.

### D19 — Tracking the success metrics
- **Context:** roadmap §4 said to set up tracking in Sprint 1. No PR does it.
- **Options:** (a) App Insights custom events from the web app (`dupe.warning_shown`, `dupe.warning_outcome`,
  `mani.logged`, `import.completed`) · (b) compute them from Postgres in a weekly query · (c) skip
- **Recommendation:** (a) for the dupe-warning funnel, which only exists in the browser, plus (b) for status adoption and manis per week, which are
  already in the DB.
- **Decision:** App Insights browser events for the dupe-warning funnel (`dupe.warning_shown`, `dupe.warning_outcome`), plus a weekly Postgres query for status adoption, manis per week and time to 20 polishes.
- **Date:** 2026-10-17
- **Ticket:** [#323](https://github.com/mattmck/swatchwatch/issues/323)

### D20 — Milestones
- **Recommendation:** close M0 and M1, open **M2 — Collector's companion**, and move the Sprint 1–4 issues into it.
- **Decision:** Yes. Already done: M0 and M1 are closed, and M2 — Collector's companion holds the Sprint 1–4 issues and these follow-ups.
- **Date:** 2026-10-17

### D21 — Owners for follow-ups
Open follow-ups taken from the PR descriptions. Give each one an owner and a ticket, or mark it "won't do".

- **Decision:** File one GitHub issue per follow-up, owned by the repo owner, and link each in the table below. Skip any already covered by an open PR.
- **Date:** 2026-10-17

| Follow-up | From | Owner | Ticket |
|---|---|---|---|
| A capture check that doesn't change inventory, used by the add guard and Rapid Add | #294, #303 | owner | Covered by open PRs #307, #310 |
| PNG install icons (192/512) so Chrome shows the install prompt | #294 | owner | [#324](https://github.com/mattmck/swatchwatch/issues/324) |
| Test camera capture on a real phone | #294 | owner | [#325](https://github.com/mattmck/swatchwatch/issues/325) |
| Run blob delete and upload end-to-end against a live host | #299 | owner | [#326](https://github.com/mattmck/swatchwatch/issues/326) |
| Nail-photo upload in the mani form | #302 | owner | [#327](https://github.com/mattmck/swatchwatch/issues/327) |
| Sweep for orphaned `image_asset` rows and blobs | #299, D9 | owner | [#319](https://github.com/mattmck/swatchwatch/issues/319) |
| HEIC → JPEG conversion in the browser | #299, D9 | owner | [#318](https://github.com/mattmck/swatchwatch/issues/318) |
| Store-specific product filter for Pahlish | #292, D2 | owner | [#328](https://github.com/mattmck/swatchwatch/issues/328) |
| Shared `POLISH_CSV_COLUMNS` for import headers | #304 | owner | [#329](https://github.com/mattmck/swatchwatch/issues/329) |
| Dupe hint badges flickering on refetch | #297 | owner | [#330](https://github.com/mattmck/swatchwatch/issues/330) |
| Inventory status rules (D5a, D5c) | D5 | owner | [#314](https://github.com/mattmck/swatchwatch/issues/314) |
| Import: quantity-0 rows undecided (D5b) | D5 | owner | [#315](https://github.com/mattmck/swatchwatch/issues/315) |
| Higher status wins on merge | D7 | owner | [#316](https://github.com/mattmck/swatchwatch/issues/316) |
| Keep wear events on delete | D8 | owner | [#317](https://github.com/mattmck/swatchwatch/issues/317) |
| Finish type family | D10 | owner | [#320](https://github.com/mattmck/swatchwatch/issues/320) |
| Promote hand label to vendor hex | D12 | owner | [#321](https://github.com/mattmck/swatchwatch/issues/321) |
| Label ground truth, then run the hex gate | D4 | owner | [#322](https://github.com/mattmck/swatchwatch/issues/322) |
| Instrument M2 success metrics | D19 | owner | [#323](https://github.com/mattmck/swatchwatch/issues/323) |
| Feature-flag mechanism | D22 | owner | [#313](https://github.com/mattmck/swatchwatch/issues/313) |

### Actions after merge (no ticket needed)
- **D1:** ✅ Done. Once #305 and #314 (PR #334) were released to prod, `SHAREABLE_WISHLIST_ENABLED` was set to `true` in the prod GitHub environment. Deploy Infra Prod run 39087542550 applied it on 2026-10-18 at 01:45 UTC, and prod `/api/wishlist-share` now answers 401 instead of 404 `feature_disabled`.
- **D2:** `NightOwlLacquerShopify` was removed from `SHOPIFY_SOURCES_PENDING_APPROVAL` in #333 (released in #340). The owner still needs to enable its prod `data_source` row and run its first job (tracked under #273).
- **D11:** close #224 once #288 and #306 merge.
- **D14–D16:** implement in Phase 3 under #281: keep the cookies; 0.5 GB/2 GB caps; prod-only alerts to `var.alert_email`.
- **D18:** cut one `dev → main` release before 27 Nov, following the pre-release checklist on #274.

### D22 — How feature flags work
- **Status:** Deferred, see [#313](https://github.com/mattmck/swatchwatch/issues/313). Env vars for now; revisit
  at the third or fourth flag, or when per-user targeting is needed.

## E. Catalog hygiene

### D23 — Product categories and non-polish cleanup
- **Status:** Decided
- **Context:** owner accepted the plan's recommendations for the overnight build; revisit on PR review.
  Plan: [plan-catalog-hygiene.md](plan-catalog-hygiene.md) §3. Issues [#349](https://github.com/mattmck/swatchwatch/issues/349), [#347](https://github.com/mattmck/swatchwatch/issues/347).
- **Decision:**
  - **D-A (model):** option (a), a column on `shade`: `product_category` (`color | topper | top_coat | base_coat | treatment | accessory`, default `color`) plus `product_category_source` (`rule | admin`). Topper is a category; its finishes describe the particles, and the `topper` finish keeps setting the category at ingestion.
  - **D-B (accessories):** option (a), classify as `accessory` and set the new shade status `excluded` when nobody holds the shade. Held ones are listed for admin review and stay visible to their holders. Nothing is hard-deleted.
  - **D-C (surfaces):** the plan's recommended table as written (collection table all categories with accessories for holders only; catalog search everything but accessories; color search, gaps and photo match color only; dupes color vs color and topper vs topper; Pick for me color main picks with an optional topper pairing; stats with coats/treatments in spend only and accessories out; mani log role prefill from the category).
  - **D-D (topper hexes):** recommended option, no vision hex detection on toppers (or any non-color category); toppers show a neutral swatch with finish chips; `vendor_hex` is kept; `detected_hex` is cleared on toppers only by the backfill's explicit flag, with the old value and provenance recorded so it can be undone.
  - **D-E (coats and treatments at ingestion):** stop dropping treatment, primer and bond products; ingest them as `base_coat` / `top_coat` / `treatment`. True accessories are still skipped.
- **Date:** 2026-10-18

