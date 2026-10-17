# SwatchWatch — Roadmap, 20 Oct → 19 Dec 2026

_Drafted 2026-10-16. Theme: **from catalog engine to collector's companion.**_

## 1. Where we are

The last eight months built the engine: prod is live at swatchwatch.app, auth and
per-user access control are done (#47, #53), the Shopify/OBF/MakeupAPI ingestion
pipeline survives long runs (#225), hex detection has provenance, batch mode and an
evaluation harness (#252–#259), and the web app has color search, a gaps heatmap,
photo → polish matching (#105) and an admin console.

What a collector actually gets today is: a catalog table with an "owned" quantity,
a rating, notes, and strong color tooling. The last two weeks of commits were almost
entirely hex-detection quality, which is now good enough to stop tuning and start
spending.

**Open items, triaged** (17 open issues, 2 milestones):

| Bucket | Issues | Call |
|---|---|---|
| Land now | ✅ 17 Oct: #256, #258, #237 shipped to `main` in release #276 (Deploy Prod green, migration rename applied cleanly); #245 closed (fixed by #246, hardened in #237). Remaining: #227 owner-scoped image ids (security) | Week 0 |
| Decide + do | #224 multi-finish follow-ups (3 decisions) | Week 0 |
| Fold into this roadmap | #21 camera capture (web half), #103 color taxonomy, #104 LacquerTracker research (site is dead — closed; findings harvested into §2 and the color-family filter), #45 admin users (remaining bits), #226 ingestion logs | Sprints 1–4 |
| Defer to 2027 | #109 Expo scaffold, #2 ESM migration, #117 Redis, #158/#228 APIM gateway, #102 (superseded by `finish_type` admin) | See §5 |

Hygiene: `dev` and `main` are level since release #276 (17 Oct); the M0 and M1 milestones are stale
(49 of 54 closed) and should be closed in favor of a new **M2 — Collector's companion**.

## 2. What nail polish nerds want (research)

Looked at the current tracker apps (LacquerStash, NailPal, Polish Index, Lacquergram,
Nail Polish Rack, the now-dead Lacquer Tracker) plus long-running collector
spreadsheets. The same asks recur everywhere:

1. **"Did I already buy this?"** — duplicate buying is the #1 stated pain in every
   app's pitch. Existing apps catch *exact* duplicates only; NailPal's own blog admits
   look-alike detection is the gap. SwatchWatch has OKLAB distance, detected hex and
   finishes — nobody is better placed to answer "you own two near-dupes of this."
2. **Statuses, not just a count** — owned / wishlist (ISO) / **untried** / destash /
   archived (used up, decluttered). "UT?" is the oldest column in collector
   spreadsheets. Today SwatchWatch has none of these; "wishlist" = `quantity <= 0`.
3. **Mani log / wear history** — log a manicure (date, polishes, photo) → auto-mark
   tried, last worn, wear count. LacquerStash's "mani diary" is its headline feature;
   spreadsheets count "worn vs waiting."
4. **Import + export** — collectors arrive with a spreadsheet; they fear apps that die
   with their data (Lacquer Tracker went dark in early 2025 and its users are
   homeless). LacquerStash imports CSV/PDF; Polish Index exports its catalog.
5. **In-store check** — barcode/label scan → own it? close dupe? on the wishlist?
   The whole point is to use it *in the aisle*, and the next two months are Black
   Friday, indie restocks and Polish Pickup's Nov/Dec rounds.
6. **Private swatch photos** — bottle shots lie for cremes, jellies and shimmers;
   collectors want their own on-nail photo per polish, private by default.
7. **Stats** — spend by brand/month, untried %, cost per wear, most-worn, a "random
   pick" (Lacquer Tracker's most-loved feature).
8. **Indie catalog breadth** — the enthusiast community is indie-heavy (Holo Taco,
   ILNP, Mooncat, Cirque, KBShimmer, Emily de Molly, Polish Pickup makers). Our
   generic Shopify connector makes each new store cheap.
9. **Shareable wishlist** — a read-only link for gift season. Keep it opt-in.
10. **Color-family + finish browsing** — "browse reds / browse holos" is table stakes
    in Polish Index and Lacquer Tracker; we have the hue data but no family filter.

Things they *don't* ask for first: social feeds, forums, affiliate storefronts,
ingredient databases. Those stay out of this window.

## 3. The plan — four sprints

Dates assume one builder plus agents, two-week sprints, Thanksgiving week short.
Each sprint ships to `dev` continuously and promotes to `main` at sprint end.

### Week 0 — Stabilize and decide (20–24 Oct)

- ✅ Merge #256, #258, #237; cut a `dev → main` release (#276, 17 Oct); close #245.
- Fix #227: owner-scope and expire private-media image ids; flip the `known gap #227`
  assertions in `tests/access-control.unit.test.cjs`, update the matching note in
  `packages/functions/README.md`, and keep anonymous, cacheable access for public
  catalog images.
- **Hex detection decision gate (2 days, hard stop):** run the eval across
  `azure-current`, `pixel`, `region-crop`, `palette-pick`, `ensemble`; pick the
  production strategy by HIGH-confidence share × cost; wire it into ingestion; stop
  tuning until a new fixture set exists.
- Record and implement the three #224 decisions. Recommended: (1b) user `finishes`
  write to the catalog only when the request *creates* the shade, same rule for color
  fields; (2a) block deleting an in-use `finish_type` with a 409 + usage count;
  (3) build the AI finish prompt list from `loadFinishCatalog()`.
- Close M0/M1; open **M2 — Collector's companion** with the issues below.

### Sprint 1 — "Know what you own" (27 Oct – 7 Nov)

Goal: a real collection model and a painless way in and out.

- **Inventory status** — migration adding `user_inventory_item.status`
  (`owned | wishlist | destash | archived`), `tried_at`, `last_worn_at`,
  `wear_count`, surfacing the existing `purchase_price`/`purchase_currency`.
  Replace the `quantity <= 0` wishlist hack. Shared `Polish` type gains
  `status`, `isUntried`, `purchasePrice`, `wearCount`, `lastWornAt`.
- **Collection UI** — status chips and quick actions on the table (♡ wishlist,
  ✓ own, "untried" badge), filters for status/untried, dashboard tiles for wishlist
  count and untried %.
- **CSV / spreadsheet import** — upload CSV (brand, name, finish, qty, price, date,
  status, notes); fuzzy-match rows to the catalog with `pg_trgm`; a review step
  where unmatched rows become `user_submitted` shades or get re-matched; idempotent
  re-import. Target: 200-row sheet in under two minutes.
- **Export** — CSV and JSON of the user's collection (data ownership, and it's cheap).
- **Color family filter** (#103 lite) — derive family (red, pink, coral, orange,
  yellow, green, teal, blue, purple, nude, brown, grey, black, white, multichrome)
  from OKLAB hue/chroma/lightness bins; expose as a filter on `/polishes` and the
  catalog. Closes #103; this is the color-taxonomy harvest from the #104 research
  (#104 itself is closed, the site is gone).

### Sprint 2 — "Don't buy it twice" (10–21 Nov, before Black Friday on 27 Nov)

Goal: the in-aisle answer.

- **Dupe finder** — `GET /api/polishes/{id}/dupes`: nearest owned shades by OKLAB
  distance with finish compatibility, graded with the same HIGH/MEDIUM thresholds
  as match-image. Surface on the detail page ("You own 2 close dupes"), as a column
  hint on catalog rows, and on the wishlist.
- **Add guard** — adding or wishlisting a near-dupe shows the dupes first.
- **Web Rapid Add with a real camera** (#21, web half) — `getUserMedia` capture,
  on-device barcode via `BarcodeDetector` with a zxing fallback, frame → existing
  capture API → verdict card: *own it / near-dupe / on wishlist / add*. Mobile-web
  install prompt for the existing PWA manifest so it lives on the home screen.
- **"Buy from brand" link** on catalog/wishlist rows from the stored `source_product`
  URL. Free now; the hook for affiliate later.
- **Shareable wishlist** (opt-in) — signed, revocable public read-only page at
  `/w/{token}`; no auth, no PII beyond display name. Rate-limit by token.
  Built in #268 behind `SHAREABLE_WISHLIST_ENABLED` (off), pending decision 2 in §6; the static
  export serves it at `/w/?token=…`.

### Sprint 3 — "Wear it" (24 Nov – 5 Dec, short week)

Goal: the collection changes because you used it.

- **Mani log** — `manicure` table (user, date, polishes[] with role base/accent/
  topper, photo, notes); logging one sets `tried_at`, bumps `wear_count`, updates
  `last_worn_at`, and writes `inventory_event(used)`. `/manis` page with a calendar
  strip and a one-tap "log today's mani" from any polish.
- **Private nail photo per polish** — upload through the existing `image_asset` +
  EXIF strip + signed proxy; shown beside vendor/detected swatches on the detail page.
- **Stats** — dashboard panels for spend by brand/month, untried %, most-worn,
  cost per wear, "worn vs waiting" ring. **Pick for me:** random owned polish biased
  to untried and to the current gap heatmap; optional "pair it" using harmonies.
  This is the seed of the Looks plan without building the Looks page.

### Sprint 4 — "Grow the catalog, harden" (8–19 Dec)

Goal: more indie coverage, and the ops to absorb user-created data.

- **Indie Shopify sources** — add 6–10 stores through `shopify-generic` (candidates:
  ILNP, Mooncat, Cirque Colors, KBShimmer, Emily de Molly, Painted Polish, Cupcake
  Polish, Dam Nail Polish is in already). Verify `products.json` is exposed and
  confirm it's acceptable use per store before adding; capture that per source in
  `data_source.notes`.
- **Admin review queue** — list `user_submitted` shades from import/add flows;
  approve → `active`, or merge into an existing shade (reassigning inventory rows).
  Finishes the remaining half of #45's "editable" admin surface.
- **Ingestion observability** (#226) — whole-run logs per job.
- Release, docs sweep, and a short retro feeding the Q1 plan (mobile, Looks).

## 4. Success metrics (instrument in Sprint 1, read at end)

| Metric | Target by 19 Dec |
|---|---|
| Time from signup to 20 polishes in collection (import path) | < 5 min |
| Dupe warnings shown → user cancels or wishlists instead | tracked; > 20% |
| Share of owned polishes with a status other than default | > 60% of active users |
| Manis logged per active user per week | ≥ 1 |
| Catalog shades (active) | +10k via indie sources |
| Detected-hex HIGH-confidence share | frozen at Week 0 baseline or better |

How each number is read (decision D19, #323): the dupe-warning funnel from the browser events
`dupe.warning_shown` / `dupe.warning_outcome`, the rest from the weekly query
`docs/queries/m2-metrics.sql`. Definitions and the funnel KQL are in
`docs/observability-plan.md` ("M2 success metrics"). The detected-hex share comes from the hex
eval harness (`npm run eval:hex`).

## 5. Deferred, and why

- **Native Expo app (#109)** — the biggest single item on the list and the blank
  template it is today needs a full sprint just to reach parity. For the holiday
  window a mobile-web PWA with real camera capture gets 80% of the in-store value.
  Recommend starting it in January as the Q1 headline.
- **Looks experience** — keep the plan; ship "Pick for me" in Sprint 3 as the
  wedge and decide on the full page in Q1 with usage data.
- **Ingredients / clean-beauty flags (Epic 5)**, **retail/affiliate (Epic 6)** — real
  asks, but behind the collector basics. The "Buy from brand" link is the cheap hook.
- **Redis (#117)** — no concrete need yet; revisit if share-page rate limiting or
  catalog-search caching becomes measurable.
- **APIM OpenAI gateway (#228/#158)** — either finish it infra-only or delete the
  `AZURE_OPENAI_USE_GATEWAY` path so the 404 trap can't recur. No product value in
  this window.
- **ESM migration (#2)** — pure debt; pair it with the Expo work when the toolchain
  gets touched anyway.

## 6. Decisions needed

1. **Mobile:** PWA-first through December (recommended) vs. start the Expo scaffold
   now at the cost of roughly Sprint 4.
2. **Sharing:** opt-in public wishlist pages — yes/no. Everything else stays
   private-by-default.
3. **Hex detection freeze:** agree to the two-day gate in Week 0.
4. **Indie source list:** which stores first — you know the community better.

## 7. Sources

- [LacquerStash — features](https://lacquerstash.app/) (mani diary, ISOs, destash, untrieds, import, spend)
- [NailPal blog — "Is there an app to track your nail polish collection?"](https://nailpal.app/blog/is-there-an-app-to-track-nail-polish-collection) (duplicate buying, export, exact-only dupe check)
- [Polish Index](https://polishindex.app/) (22k catalog, dupe finder, color/finish browse, catalog export)
- [Lacquergram — App Store](https://apps.apple.com/us/app/lacquergram/id1441313103) (inventory, wishlist, destash)
- [Nail Polish Rack — Google Play](https://play.google.com/store/apps/details?id=com.antiapps.polishRack2) (wishlist, swap list, barcode entry, last-worn export)
- [Lacquer Tracker — store listing history](https://chrome-stats.com/d/com.lacquertracker.webview?hl=en) (unpublished 2025)
- [Pretty Girl Science — "Spreadsheets: Know Your Stash"](https://www.prettygirlscience.com/2014/06/spreadsheets-know-your-stash.html) (the "UT?" untried column)
- [Teri Wells — collection tracker spreadsheet](https://teriwells.com/products/nail-polish-collection-tracker) (worn vs. waiting counts)
- [Mom Who Works — organization for the nail polish obsessed](https://momwhoworks.wordpress.com/2013/04/15/organization-for-the-nail-polish-obsessed/) (typical columns)
- [Cosmetic Sanctuary — Polish Pickup coverage](https://cosmeticsanctuary.com/?p=52594) (monthly indie pre-order window)
- [lacquer-log (self-hosted)](https://github.com/chelming/lacquer-log) (data-ownership demand)
