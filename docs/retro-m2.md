# M2 retro — "Collector's companion"

_Skeleton drafted 2026-10-17, right after release #340. Tracking issue: #274. The sections marked
TODO are for the owner to write._

## What shipped

Release [#340](https://github.com/mattmck/swatchwatch/pull/340) promoted `dev` to `main` on
2026-10-17. It shipped every Sprint 1–4 item in
[roadmap-2026-10-to-12.md](roadmap-2026-10-to-12.md) §3. Each sprint in the roadmap has a status
line listing its PRs. In short:

| Area | PRs |
|---|---|
| Week 0: multi-finish decisions, finish-type rename, decision log | #288, #306, #331 |
| Sprint 1, "Know what you own": inventory status and rules, collection UI, CSV import/export, color family filter, CI tests, M2 metrics | #291, #334, #296, #304, #300, #336, #293, #301, #337 |
| Sprint 2, "Don't buy it twice": dupe finder, add guard, camera Rapid Add, check-only capture, PWA icons, buy link, shareable wishlist (flagged off) | #297, #303, #294, #307, #310, #335, #289, #305 |
| Sprint 3, "Wear it": mani log, wear history, HEIC/mani photos, private nail photo, stats, Pick for me | #302, #338, #339, #299, #309, #308 |
| Sprint 4, "Grow the catalog, harden": indie Shopify sources, admin review queue, ingestion logs, hex labeling tool, prod alerts, CI/CodeQL hardening | #292, #333, #295, #298, #290, #311, #312, #332, #341, #342, #343 |

The release has 12 new DB migrations (deploy notes are in the #340 body). It was squash-merged,
which is not the merge commit that the #340 description asked for. So PRs that targeted `dev`
show up on `main` as one commit, and the housekeeping pass after the release had to close their
issues by hand.

After #340, work kept landing on `dev`:

| Area | PRs |
|---|---|
| Post-release follow-ups (10-18), released to `main` in [#365](https://github.com/mattmck/swatchwatch/pull/365) on 2026-10-19 with a merge commit: hex snap (flagged), orphan media sweep, finish families, admin user management, product text for finishes, catalog thumbnails, gallery dedupe, CIAM service principal, backups, CodeQL fix | #344, #345, #346, #353, #354, #355, #356, #357, #358, #359, #360, #362, #363, #364, #366, #367, #368, #369 |
| Overnight batch 10-18 (merged 2026-10-20; [runbook](overnight-2026-10-18-release-runbook.md)): Pahlish store filter, barcode scan matching, back-navigation state, photo-match filters and wishlist, getting-started checklist, Looks page and its shopping list / share / drawer, product categories and non-polish cleanup (D23), Expo app foundation and wave 2, OpenAI region guard, phone card layout for `/polishes`, app-shell header overflow | #371, #375, #374, #373, #372, #370, #378, #377, #376, #379, #380, #382, #383 |
| Overnight batch 10-19 (merged 2026-10-20; [runbook](overnight-2026-10-19-release-runbook.md)): Cirque Colors store filter and indie batch 2 survey, promote manual hex labels to `vendor_hex` (D12), Looks toppers toggle and Color Lab links, mobile nail photo / photo match parity / mani photos, mobile By color search / Pair it / Goes with | #388, #391, #392, #396, #399 |

The two overnight batches are on `dev` only until the next `dev → main` release. Their issues
(#328, #105 web half, #348, #349, #347, #321, #386, #385) stay open until then and need closing
by hand, as after #340. #399 (mobile color search, harmonies and Pair it, #384) merged on 2026-10-20
and #397 (phone layout sweep, #387) on 2026-10-22, so #384 and #387 are in that list too.

## What we decided

The decisions for this batch (D1–D24) are in [decisions-2026-10.md](decisions-2026-10.md):
product rules (inventory status D5, spend D6, merges D7, wear data D8, nail photos D9, dupes D10,
#224 outcomes D11, hex labels D12, buy links D13), feature enablement (public wishlist D1, indie
stores D2, PWA before Expo D3, hex freeze D4), observability (D14–D17) and process (one release
D18, metrics D19, milestones D20, owners D21, feature flags D22). Two came later: product
categories D23 (2026-10-18), and D24 (2026-10-19), which started the Expo app and the Looks page
early (superseding D3's January start and the roadmap §5 Looks deferral), set the overnight
merge-to-`dev` rule, and recorded mobile Rapid Add as check-first and the React 19.2.3 / Expo SDK
57 pins. An **M3 — On the go** milestone is proposed under D20, not decided.

## Metrics

Targets are in roadmap §4. How each one is read: the weekly read-only query
[`docs/queries/m2-metrics.sql`](queries/m2-metrics.sql), plus the browser dupe funnel in App
Insights (KQL in [observability-plan.md](observability-plan.md), "M2 success metrics").

| Metric | Target by 19 Dec | Source | Reading |
|---|---|---|---|
| Time from signup to 20 polishes in collection (import path) | < 5 min | `m2-metrics.sql` (signup cohort, 20th row, `via_import`) | Not readable yet: needs users |
| Dupe warnings shown → user cancels or wishlists instead | tracked; > 20% | App Insights `dupe.warning_shown` / `dupe.warning_outcome` | Not readable yet: needs users |
| Share of owned polishes with a status other than default | > 60% of active users | `m2-metrics.sql` (`status_adoption_share`: share of active users with at least one non-default row; the row-level share is `avg_non_default_share` / `median_non_default_share`) | Not readable yet: needs users |
| Manis logged per active user per week | ≥ 1 | `m2-metrics.sql` (`manis_per_active_user`) | Not readable yet: needs users |
| Catalog shades (active) | +10k via indie sources | `m2-metrics.sql` (`active_shades`, `active_shades_added`) | Total catalog growth is readable now from prod (TODO: record the 2026-10-17 baseline and the current count). Indie-source attribution is not available: the query counts all active shades by `created_at`, not by source. More stores are pending in #273 / #328 |
| Detected-hex HIGH-confidence share | frozen at Week 0 baseline or better | hex eval harness (`npm run eval:hex`) | Not readable yet: needs the hand-labeled ground truth from #322 (D4) |

TODO: paste the first weekly `m2-metrics.sql` row here once prod has active users.

## What went well

TODO (owner)

## What didn't

TODO (owner)

## What's left

These issues were still open after release #340. The roadmap §1 "Remaining for M2" list has
the current set (updated 2026-10-20): since then #45, #319 and #320 closed with release #365, and
#105 (web half), #321 and #328 merged to `dev` and close with the next release. The list below is
the post-#340 snapshot.

- #45 admin user management (the review-queue half shipped in #298)
- #105 image-to-polish matching, web/API gaps only (the mobile items moved to #109)
- #273 more indie Shopify sources, and #328 the Pahlish product filter
- #319 orphaned `image_asset` / blob sweep
- #320 optional family on finish types for dupe grading
- #321 promote a hand-labeled hex to `vendor_hex`, with provenance
- #322 hand-label ground truth, then run the hex detection gate
- #325 Rapid Add on real iOS / Android devices
- #326 nail-photo end-to-end against a live host
- #313 feature-flag mechanism (D22)
- #274 this retro and the docs sweep

## Q1 candidates

- **Expo app** — #109, the Q1 headline (D3). It now also holds the native remainders of #21 and #105. _Started early on 2026-10-19 (D24): #376, #379, #396 merged; the remaining waves are the Q1 work._
- **Looks** — [looks-experience-plan.md](looks-experience-plan.md). "Pick for me" (#308) is the wedge; decide on the full page with usage data. _The page shipped client-side in #370, #378 and #392 (D24); the plan's status section lists what is not built yet._
- **ESM migration** — #2, pair it with the Expo toolchain work.
- **Redis** — #117, only if share-page rate limiting or catalog-search caching becomes measurable.
- ~~**APIM OpenAI gateway** — #158 / #228: finish it infra-only or remove the `AZURE_OPENAI_USE_GATEWAY` path.~~ _Removed on 2026-10-23 ([D25](decisions-2026-10.md#d25--azure-openai-apim-gateway-removed-2026-10-23)); both issues closed as won't-do._
- **Feature flags** — #313: env vars until the third or fourth flag, or until per-user targeting is needed (D22).

TODO (owner): rank these for the Q1 plan.

**Proposal (docs sweep, 2026-10-20; not decided):** an ordering given what has shipped since:

1. **Mobile waves**: the remaining #109 items, native color extraction for photo match (#105's
   mobile half) and verification on real iOS / Android devices.
2. **Looks follow-ups**: a skin-tone model that changes the recommendations, prices on the
   shopping list, a server-side share link.
3. **Catalog growth**: #273 store approvals (PR #388 lists the stores to ask), more stores, or a
   non-Shopify route for the +10k target.
4. **ESM**: #2, together with the Expo toolchain work.
5. **Redis #117**: only if a need becomes measurable. _(APIM #158 / #228 dropped, D25.)_
