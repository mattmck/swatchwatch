# Overnight batch 2026-10-19 → 20: release runbook

_Written 2026-10-22 by the overnight lead session. Everything below is for the owner; nothing in it was run against Azure overnight._

## 0. What the batch is

Six pieces, built in parallel off `dev` after the 10-18 batch had merged, each on its own
worktree. Unlike the 10-18 batch, each session **merged its own PR into `dev` as a squash** once
CI was green and review threads were handled (decision D24 (a)). Five are in `dev`; one is green
and waiting for you (§1).

| PR | Issue | What a user gets |
|---|---|---|
| [#388](https://github.com/mattmck/swatchwatch/pull/388) | #273 | Cirque Colors store filter (328 of 415 products accepted, was 10) and the indie source batch 2 survey (`docs/indie-sources-2026-10.md`); no new store added, every remaining Shopify candidate's terms forbid automated access |
| [#391](https://github.com/mattmck/swatchwatch/pull/391) | #321 (D12) | Admin "Promote to vendor hex" on a manual hex label, with provenance columns, audit rows, Undo and an ingestion guard that never replaces a promoted value |
| [#392](https://github.com/mattmck/swatchwatch/pull/392) | #386 | Looks: `Include toppers` switch (`toppers=0` in the URL only when off), Color Lab link from cards, drawer and saved looks into `/polishes/search` with a back link, `looks.color_lab_opened` telemetry |
| [#396](https://github.com/mattmck/swatchwatch/pull/396) | #385 | Expo app: private nail photo on polish detail (camera or library, replace, delete), photo match parity with the web (scope and palette chips, per-color groups, add / wishlist through the add guard), optional mani photo; private `v3` media held in memory only |
| [#399](https://github.com/mattmck/swatchwatch/pull/399) | #384 | Expo app: Search tab "By color" (hue strip + lightness, family chips, owned-first ranking, catalog toggle, `?hex=` deep link), "Pair it" on the Home pick card, "Goes with" on polish detail; harmony and Pair it rules moved to `packages/shared/src/color/` with the web re-exporting them |
| [#397](https://github.com/mattmck/swatchwatch/pull/397) | #387 | Phone layout sweep: 14 per-route fixes at 375 and 390 px, light and dark (touch targets via `pointer-coarse:`, dialog height cap, gaps heatmap columns). **Open, green, not merged** |

One migration ships with it: `20261020024540860_shade-vendor-hex-provenance` (#391). It adds
nullable provenance columns and backfills `vendor_hex_source = 'vendor'` for rows that already
have a vendor hex; no catalog value changes.

Also opened during the night, by other sessions, and still open on 2026-10-22 (all green):
[#389](https://github.com/mattmck/swatchwatch/pull/389) (mobile pagination fix, has a CodeRabbit
"changes requested"), [#390](https://github.com/mattmck/swatchwatch/pull/390) (Looks add-guard
return link), [#394](https://github.com/mattmck/swatchwatch/pull/394) and
[#398](https://github.com/mattmck/swatchwatch/pull/398) (guard migrations so rolling back the two
indie-source migrations never deletes a pre-existing `data_source` row; they are different
migrations but touch the same README and test file, so merge one, then re-run CI on the other),
and [#395](https://github.com/mattmck/swatchwatch/pull/395) (console errors on refresh, #393;
**targets `main`**, retarget it to `dev` or merge it after the release).

## 1. Finish merging to `dev`

1. Merge #397 (`gh pr merge 397 --squash --delete-branch`): its session's permission mode would not
   let it merge. Then #390, #394, #398 (re-run CI on the second), #389 after reading the CodeRabbit
   thread, and decide where #395 goes.
2. Each merge triggers **Deploy Dev**. Watch the last one:

   ```bash
   gh run list --workflow=deploy-dev.yml --limit 1
   ```

3. Smoke on dev: sign in → `/admin?tab=hex-labeling` → pick a labeled shade → "Promote to vendor
   hex" → the detail page shows the promoted value with the manual hint → Undo restores it;
   `/polishes/looks` → toggle "Include toppers" off → no topper steps → "Color Lab" opens search
   seeded with the look's colors and "Back to Looks" returns to the same vibe; any app route at
   375 px has no horizontal scroll.

## 2. Release `dev → main` and verify prod

Same procedure as the 10-18 runbook §2: release PR `chore: release dev → main` with a **merge
commit**, Deploy Prod, confirm the `prod` environment has `OPENAI_LOCATION=centralus` and the
Terraform plan shows no Azure OpenAI replace, alerts quiet for 30 minutes. The 10-18 batch's
backfills (product categories, barcodes; its runbook §3) still apply and have not been run.

After the release, close by hand with a comment naming the PR (closing keywords only fire on
`main`): #328, #105 (web half; the mobile half is in #109), #348, #349, #347, #321, #386, #385,
#384, and #387 once #397 is in.

## 3. One-time owner actions

- **Indie stores:** PR #388's survey names the stores whose terms have the Shopify "spider, crawl,
  or scrape" clause. Ask Stella Chroma, Lemming Lacquer and Sweet & Sour for written OK first; each
  is then added disabled with the agreement in `data_source.metadata.notes` (D2). Without
  agreements, indie Shopify is nearly exhausted (this batch adds about 316 shades), so the roadmap
  §4 "+10k" target needs a non-Shopify route.
- **Milestone:** name the Q1 milestone (proposal `M3 — On the go`, D20) and move #109, #384, #385,
  #386, #2, #117, #313 into it; #384–#386 carry `plan-me` until then.
- **Device checks:** the Expo features (#396, #399) were verified with the Expo web preview and
  unit tests only; camera and library pickers and native image rendering need an iOS or Android
  run (#325 covers Rapid Add; add nail photo, mani photo and By color to that pass).
- **Worktree leftover:** `.claude/worktrees/agent-a579e9fd162752e1e` still holds the local branch
  `feat/384-mobile-color` from the first #384 attempt; its work is all in #399. Remove it with
  `git worktree remove --force` and delete the branch.
- **Docker:** during the disk-full incident Docker's disk went read-only and the phone sweep
  session restarted Docker Desktop; the dev Postgres and Azurite data were intact (267 shades). Its
  reclaimable image and build cache (about 9 GB) was never pruned.

## 4. Decisions taken as the recommendation (say so if you want any changed)

| # | PR | Decision | Taken as |
|---|---|---|---|
| 1 | #388 | Shopify default anti-scraping clause | counts as "forbids"; no store added without a written OK |
| 2 | #388 | The +10k catalog target | needs a non-Shopify route (retailer or affiliate feeds, `docs/data-sources-research.md`) |
| 3 | #391 | Display precedence for a promoted vendor hex | unchanged (vendor > detected > name already wins) |
| 4 | #391 | Expose `vendorHexSource` to users | admin-only for now |
| 5 | #391 | Undo after re-ingest | restores the current vendor value (`vendor_hex_previous` keeps tracking ingests) |
| 6 | #392 | Toppers default | on; URL carries `toppers=0` only when off, so old share links keep their looks |
| 7 | #392 | Flake vibe with toppers off | topper dropped, Flake only re-ranks templates (alternative: disable the switch under Flake) |
| 8 | #392 | Color Lab | a link to `/polishes/search` with a back link, not an embedded wheel |
| 9 | #392 | Still parked | skin-tone input that feeds recommendations, nail shape, prices, server share link, feature flag |
| 10 | #396 | Mani photo source | camera and library |
| 11 | #396 | Nail photo in Collection rows | detail page only (no per-row private fetch) |
| 12 | #396 | Offline mani cache | drops `photoUrl`, so no private-media reference is written to disk |
| 13 | #399 | Catalog "By color" ranking | ranks one page of 250 rows per family on the device; follow-up: server-side `?nearHex=` sort on `GET /api/polishes` |
| 14 | #399 | Hue picker | 12-stop strip + lightness steps, no `react-native-svg` dependency |
| 15 | #397 | Touch targets | grow under `pointer-coarse:` only; desktop keeps compact controls |
| 16 | lead | Overnight sessions merge their own PRs into `dev` when green | recorded as D24 (a) |
| 17 | lead | Disk full mid-run | removed four merged, clean, idle worktrees and the npm cache on the owner's choice; nothing else |

## 5. Not done overnight

- Anything on Azure (§1–§3 are yours), and the 10-18 backfills.
- #322 hex gate (needs your hand labels), #325 real-device Rapid Add, #326 nail-photo e2e on a
  live host.
- Follow-ups the sessions named: server-side color-distance sort for catalog By color (#399),
  native on-device color extraction for photo match (#109), store agreements (#388), a
  `looks.toppers_toggled` event if the `includeToppers` property on `looks.generated` is not enough.
- The first #384 attempt and the #385 attempt were stopped by the disk filling up; both were
  redone and merged. The docs sweep agent hit the usage limit after pushing its branch; the lead
  finished it in this PR.
