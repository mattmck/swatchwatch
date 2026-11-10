# Plan: Rapid Add that works on real bottles, and a catalog big enough to match them (2026-11-10)

Two goals, in this order of importance. Everything else is parked (see "Parked").

1. **Rapid Add and its inventory mode work really well**, measured on Matt's own bottle photos.
2. **Ingestion runs for every vendor we found**, and the admin console makes brands and vendors
   easy to manage, so the catalog holds the bottles Rapid Add is pointed at.

The two goals share one loop: the photos are labelled ground truth, the eval says per bottle whether
it was matched and (when not) which stage failed, and every "not in the catalog" bottle is a line on
the ingestion to-do list. Goal 2 feeds goal 1; goal 1 tells goal 2 what to ingest next.

## Where things stand (checked 2026-11-10)

| Area | State |
|---|---|
| Code | Everything from 6–9 Nov is merged to `dev` (#496–#507): eval failure attribution, gpt-5 request shape, bulk eval importer, AI record/replay, brand-sources phases A–E, the bigint listing fix. `dev` is 14 commits ahead of `main`. Only a Dependabot PR (#495) is open. |
| Local database | Was 14+ migrations behind (last applied: 2026-10-24) with 514 active shades, 0 barcodes, 0 bottle eval samples. None of the brand-sources code had ever run against a database, local or deployed. Backed up, then migrated on 2026-11-10 as step 0 of this plan. |
| Local AI settings | `AZURE_OPENAI_DEPLOYMENT` and `_HEX` are `gpt-4o-mini`; no `_LABEL` deployment, no Document Intelligence, `BOTTLE_CAPTURE_ENABLED` not set. The bottle flow has not been run locally with real AI calls on the current code. |
| Photos, batch 1 (8 Nov) | 121 photos, 26 bottles, labelled in `_classification.csv`: I Scream Nails, ILNP, KBShimmer, ORLY, essie, each under warm and white light. |
| Photos, batch 2 (9 Nov) | 469 photos + 1 clip, unlabelled, sequential. At least 15 brands: Le Mini Macaron, Cracked, Bee's Knees, Picture Polish, Painted Polish, OPI, Starrily, Maniology, Clionadh, Mooncat (with box), Moth & Moon, China Glaze, a Polish Pickup bottle, Swamp Gloss and others. Labelling started 2026-11-10. |
| Catalog vs. photos | Locally only Holo Taco (157) and Mooncat (68) have real coverage. ILNP 3, essie 3, ORLY 1, KBShimmer 0. Almost every photographed bottle is "not in the catalog" until ingestion runs. |
| Admin | No brand list or site list. Sources appear only as a dropdown on Admin Jobs. A design for a "Sources & Brands" tab is drafted (`docs/superpowers/specs/2026-11-10-admin-sources-brands-design.md`, uncommitted on `feat/admin-sources-brands`) and waits on one decision. |

### Photographed brand → where its shades come from

| Brand in the photos | Source | Source state on `dev` |
|---|---|---|
| Le Mini Macaron, Cracked, Bee's Knees, Starrily, Mooncat, China Glaze, ORLY, Lights Lacquer | own Shopify store | enabled, never run locally |
| OPI, essie, Zoya, ORLY, China Glaze, KBShimmer | Beyond Polish (retailer) | enabled, images off, gel off |
| ILNP, KBShimmer, I Scream Nails | Harlow & Co (retailer) | enabled |
| ILNP (EU listings) | Hypnotic Polish (retailer) | pending store OK |
| Picture Polish | `PicturePolishWooCommerce` | pending store OK |
| Painted Polish | `PaintedPolishBigCartel` | pending (Big Cartel licence + store OK) |
| OPI (own site) | `OpiSitemap` | pending (terms to read) |
| Clionadh | `ClionadhShopify` | disabled, storefront password-locked |
| Maniology, Moth & Moon, Swamp Gloss, Polish Pickup makers | none registered | to add |

## Progress log

**2026-11-10, first pass (local stack, `dev` at #507):**

- **Local database:** backed up, then migrated. `npm run migrate` failed its order check
  (`shade-display-oklab` and `look-share` were applied in swapped order on this database); the 11
  pending migrations were applied with `--no-check-order`. Check the deployed dev database for the
  same thing before step 2.5.
- **Batch 2 labelled:** all 469 photos, merged into `_classification.csv` next to the photos. With
  batch 1 that is **87 bottles in 176 takes from 22 brands**, staged for the importer at
  `~/Pictures/swatchwatch-bottle-eval/2026-11`. Five runs were left out because no shade name is
  printed or readable (two essie, one unknown, a Bee's Knees prototype take, Swamp Gloss).
  Medium-confidence names to confirm: Potion Polish "Let's Summon Samhain" and "Moonwell", Sally
  Hansen "Let's Get Digital", "Hyp-nautical", "Reflection Pool" and "Glitter Glam" (read from tiny
  back-label text or matched by barcode), the brand "Phoenix" on the Polish Pickup bottle, and the
  Starrily boxes whose flap window cuts the name off (matched to their bottles by lot number).
- **Harlow & Co ran for the first time:** 1,537 products fetched, 1,279 accepted, as the brand-sources
  plan predicted (≈1,282). Local catalog 514 → 1,790 active shades: ILNP 605, KBShimmer 258, Cirque
  Colors 239, I Scream Nails only 10. Nine more sources queued behind it (Beyond Polish and the
  eight own stores).
- **AI calls work.** The bottle flow ran with real Azure OpenAI calls on `gpt-4o-mini`: 2.9 model
  calls per bottle, about 6 s per bottle, no errors; responses are recorded under `eval/ai-replay/`.
- **First baseline, 20 samples (ILNP and KBShimmer, 10 bottles under warm and white light):**

  | Measure | Value |
  |---|---|
  | Matched correctly | 8 of 18 in-catalog samples (44%) |
  | Asked, with the right shade in the list | 5 (28%) |
  | Unmatched | 5 |
  | Matched wrongly | 1 (a KBShimmer not in the catalog was matched to another shade) |

  | Failure stage | n | What happened |
  |---|---|---|
  | `color_vetoed` | 5 | The name was read perfectly (score 1.00) but the match was downgraded to a question because the glass colour was far from the shade's hex. Every one of these shades has only a `name_hex`, a colour guessed from the shade's name (High Dive → slate blue). A guessed hex must not veto a name match. **First fix.** |
  | `brand_not_in_catalog` / `brand_wrong` | 3 | KBShimmer's front was read as "Hush Hush", "kbs" and "Kiss". |
  | `name_wrong` | 2 | ILNP bottom sticker read as the finish word ("Holographic") or as other text ("DREAMING OF YOU"). |
  | `false_match_not_in_catalog` | 1 | "Sip Back And Relax" is not in the catalog and was matched to shade 732. |

- **Coverage so far:** 9 of the 10 ILNP and KBShimmer bottles are in the catalog after one retailer
  run. None of the five I Scream Nails bottles is: Harlow & Co lists 10 of that brand's shades.

**2026-11-10, second pass:**

- **First fix (step 1.5): a hex guessed from the shade name is no longer colour evidence.** The
  resolver's two colour-distance queries now return NULL when a shade has neither a vendor nor a
  detected hex (`buildMeasuredHexDistanceSql` in `lib/near-hex.ts`), so a guessed colour can neither
  reject nor confirm a match. Unit suite: 3,620 pass, 0 fail. Same 20 samples, re-scored:

  | | Matched correctly | Asked | Unmatched | Matched wrongly |
  |---|---|---|---|---|
  | Before | 9 | 5 | 6 | 0 |
  | After | 15 (75%) | 0 | 5 | 0 |

  The ten ILNP samples replayed the recorded AI answers exactly (5 → 8 matched). KBShimmer's AI
  calls were made again, because Beyond Polish added KBShimmer shades and the sticker read lists the
  brand's shade names, so one KBShimmer sample changed for that reason and not the fix.
- **Label correction:** the "wrong match" in the first pass was right. The catalog spells the shade
  "Sip Back & Relax"; the label said "And", so the importer filed the bottle as not in the catalog.
  Labels must be resolved to shade ids with `&`/`and` and punctuation normalised before import
  (to do for the remaining 67 bottles).
- **What is left on these 20:** three KBShimmer fronts whose brand was read as "Hush Hush", "kbs" and
  "Kiss", and two ILNP bottom stickers read as "Holographic" (the finish line of the sticker) and
  "DREAMING OF YOU". Next in the fix loop.
- **Ingestion:** local catalog at about 3,900 active shades. Le Mini Macaron done (181). Beyond
  Polish, Cracked, Bee's Knees, Starrily, Lights Lacquer, China Glaze, ORLY and Mooncat are still
  working through the queue in 4-minute slices; the image-heavy stores are slow (Bee's Knees about
  30 products per slice).
- **Pending stores: terms read, not enabled.** Matt asked for Picture Polish, Painted Polish and
  Potion Polish to be turned on for real. Reading the terms first (the step their rows were waiting
  on) found:
  - **Picture Polish** (`picturepolish.com.au/terms-conditions/`): site access "does not include the
    right to use any data mining robots or other extraction tools"; no copying or republishing of
    site information without written permission; and "Linking our website is not permitted". Its
    robots.txt does not disallow the Store API. This is an explicit clause, so by decision D2 it
    stays pending until Picture Polish says yes.
  - **Big Cartel API License Agreement** (covers Painted Polish and Potion Polish): displaying a
    store's public listings in an app is a permitted use, but the app may not show anything "more
    than six hours older" than the shop, must delete content once it is no longer public, and may
    not "create a database by downloading and storing the Content" beyond a cache. SwatchWatch
    keeps shades permanently, including discontinued ones, which is the opposite. The stores' own
    terms pages were not found (404 at the usual paths).
  - **What enabling would buy today:** of the nine photographed Painted Polish and Potion Polish
    bottles, only one (Party Fowl) is still listed; the rest are retired limited editions. Painted
    Polish would add 245 single shades, Potion Polish about 30. Both need a store filter first
    (keep "Individual Shades" and strip "(FINAL n BOTTLES)" for Painted Polish; strip
    " - Limited Edition" / " - Magnetic" / " - Last Chance For Now!" for Potion Polish).
  - **Way through:** ask the three makers directly. A maker's written OK covers their own listings,
    and a product list or feed sent by the maker avoids the API licence altogether.
- **Finding for both goals:** a real collection is full of retired limited editions that no store
  lists any more. Catalog coverage will never be complete for it, so the create card (bottle not in
  the catalog → one tap adds it as the user's own shade) is a main path for inventory mode, not an
  edge case.

**2026-11-10, third pass:**

- **Matt's decision: enable Picture Polish, Painted Polish and Potion Polish anyway**, with the
  terms above on record and no store OK claimed. In progress: store filters and shade-name parsers
  for the three, a migration that enables the rows, tests and docs. Picture Polish lists 143
  products (106 single colours; Camelot, Guinevere and Morgana are there, Eventide is not).
- **Where the data lives:** everything so far is in the local Postgres and Azurite containers. The
  deployed dev site has none of it; the same runs are repeated there after a deploy (step 2.5),
  with images and vision hex detection on. Local runs have hex detection off and the two
  retailers have images off, so about 3,000 local shades have no image and no measured colour.
- **Step 2.2 fix list, from the first real runs of stores that were already enabled:**

  | Source | What came out wrong |
  |---|---|
  | `ChinaGlazeShopify` | The store's vendor field is "CG", so 71 shades landed under a new brand "CG" (and 3 under "Flowery") instead of China Glaze; shade names are in capitals ("ALPENGLOW"). |
  | `LeMiniMacaronShopify` | Brand created as "Le Mini Macaron Europe", plus 38 shades under "Camelia Beauty"; names keep the line ("Fleur Bleue - Quick Dry Nail Polish"); 128 of 181 are gel or LED polishes, which should be off. |
  | `StarrilyShopify` | 19 collaboration shades under a separate brand "Starrily Kelli Marissa", named "… By Kelli Marissa". |
  | `LightsLacquerShopify` | One shade under a brand "Lightslacquer.Com". |
  | `CrackedPolishShopify` | Toppers are named "Truly Outrageous Topper"; the bottle says "Truly Outrageous". |

  Each is a per-source brand or title rule. They matter for Rapid Add directly: the resolver looks
  for the bottle's brand first, and "China Glaze" has one shade while "CG" has 71.
- **Coverage so far (ingestion still running):** 24 of 87 bottles resolve to a catalog shade by
  exact name. Not coverable from any registered source: Clionadh (storefront locked), Maniology
  (Beyond Polish lists 48, none of the five photographed), Sally Hansen, Pueen, Moth & Moon, the
  Polish Pickup bottle, most I Scream Nails.
- **Ingestion pace:** one job at a time in 4-minute slices. The image-heavy stores are slow (Bee's
  Knees about 30 products per slice, 565 to go), so the queue needs roughly two more hours.

**2026-11-10, fourth pass:**

- **The three stores are enabled** (decision D27 in `docs/decisions-2026-10.md`): store filters and
  shade-name parsers (`store-filters/picture-polish.ts`, `painted-polish.ts`, `potion-polish.ts`),
  both non-Shopify gates now use the per-source title parsers, migration
  `20261110120000000_enable-picture-painted-potion-polish-sources`, seed, tests (3,649 pass, 0 fail)
  and docs. Offline against the probed listings: Painted Polish keeps 246 of 287, Potion Polish 32
  of 35, Picture Polish 116 of 143. Migration applied locally; the three ingestion jobs are queued
  behind the running ones. Follow-up: six real shades are classed `accessory` by the shared
  charm/stamping word rule ("Gourd Luck Charm", the "Stamped in …" cremes, Picture Polish "Charm").
- **Label model test:** the same 20 samples with `AZURE_OPENAI_DEPLOYMENT_LABEL=gpt-5-mini` scored
  13 matched and 4 asked, against 15 matched with `gpt-4o-mini`. It read "KBShimmer" and "ILNP"
  correctly where `gpt-4o-mini` read "Hush Hush", but several of those reads were not accepted as
  the session brand (the trace has the brand name and no brand id). Not a fair comparison until
  that is understood; it is the next item in the fix loop, together with giving the model the
  catalog's brand names to choose from.
- **KBShimmer product file from Matt** (251 products from kbshimmer.com): 242 are already in the
  catalog through the retailers and 9 are new. Its real value is images (5 to 25 per product) and
  the maker's own product pages: the retailer runs store no images, so KBShimmer shades have no
  measured colour today. Needs a small "product list file" import that feeds the normal
  materialiser; the same path would take any list a maker sends.
- **Not done on request:** getting past Cloudflare or other bot checks with anti-detect browsers.

## Goal 1 — Rapid Add and inventory mode

**Done means:** on the labelled photo set, every bottle that is in the catalog is matched or offered
in a short pick list, nothing is matched wrongly, and a not-in-catalog bottle gets the create card;
and inventory mode can walk a bin of bottles adding the confident ones without a tap each.

| # | Step | Output |
|---|---|---|
| 1.1 | **Label batch 2.** Six agents read all 469 photos into a CSV shaped like batch 1's (photo, bottle run, brand, shade, surface, text read, confidence). Low-confidence rows go to Matt as one short review list. | `_classification.csv` for batch 2 |
| 1.2 | **Photos → eval samples.** A small adapter turns both flat, CSV-labelled folders into the importer's layout (`<Brand> - <Shade>/<take>/<surface>`; Side → `glass`, box faces → `box`, a cap-top name sticker → `bottom`), then `eval:bottle:import`. Each lighting take is its own sample. | ~120 bottle samples in `bottle_eval_sample` |
| 1.3 | **Make every AI call work, and prove it.** One smoke run per call (sticker read, glass colour pick, label OCR parse, vision hex) against the configured deployment, with the deployment name, API version and the raw error printed when one fails. Decide the deployments (`_LABEL`, `_HEX`) and whether Document Intelligence is on. Then one `AI_REPLAY_MODE=record` pass so later eval runs cost nothing and are repeatable. | AI calls green; fixtures in `eval/ai-replay/` |
| 1.4 | **Baseline.** `eval:bottle --verbose` with `BOTTLE_CAPTURE_ENABLED=true`: match rate, ask rate, false-confident count, median time, brand × failure-stage table. Saved under `eval/bottle/results` and summarised in this doc. | Baseline numbers |
| 1.5 | **Fix loop, worst stage first.** One PR per stage fix, each with before/after numbers from the same recorded samples. Likely areas, to be confirmed by 1.4 rather than assumed: brand read off the front, the closed-set name read off the bottom sticker, surfaces the flow does not know (cap top, box end flap), warm light on glass colour, retailer-sourced shade names that carry size or code text. | Match rate up, false-confident at 0 |
| 1.6 | **Per-stage attribution in the product, not only the eval.** The resolver audit that the eval reads is stored on the capture session; surface it in telemetry (`capture.stage_failed` with stage and brand) so real scans report the same stages. | Failure stages visible for live scans |
| 1.7 | **Inventory mode.** Rapid Add mode for going through a bin: a barcode hit or a `matched` verdict adds the bottle at once and moves on; anything weaker (pick list, near-dupe, not in catalog) waits on the shelf for one review pass at the end. Ships only once 1.5 holds false-confident at 0 on the photo set. Web first, then the Expo Add tab. | Inventory mode on web and mobile |

### Step 1.8 — Measured colours (hex detection), added 2026-11-10

Colour can only break a tie between similar names when the shade has a measured hex, so detection
quality and coverage are part of goal 1.

| # | Step | Output |
|---|---|---|
| 1.8a | **Pick the model and strategy with the hex eval.** First run below; repeat on a larger ground-truth set before changing production. | A chosen deployment and snap setting |
| 1.8b | **Grow the ground truth with the admin Hex Labeling tab.** The fixture has 18 cases from two brands and the local database has 0 hand labels. Target: 10 labels per brand for the photographed brands, then `eval:hex:populate -- --source-type manual`. | A fixture of 150+ hand-labelled cases |
| 1.8c | **Give every shade an image.** Retailer sources store no images (decision D26: off for non-brand sources until a written OK), so about 3,000 local shades from Harlow & Co and Beyond Polish can never be measured. Options: turn `imagesPermitted` on for the retailers, or import maker-supplied product lists (the KBShimmer file). | Images for ILNP, KBShimmer, OPI, essie and the other retailer-only brands |
| 1.8d | **Run detection.** Hex detection on for the dev ingest, with the chosen model and snap setting. | Measured colours in the dev catalog |

**First hex eval run (2026-11-10, 18-case fixture, Holo Taco and Mooncat; OKLAB distance to ground
truth, lower is better):**

| Model | Strategy | Median | Within 0.05 | Within 0.10 |
|---|---|---|---|---|
| none (pixels only) | `pixel` | 0.309 | 0% | 6% |
| `gpt-4o-mini` (production today) | `azure-current` | 0.097 | 22% | 56% |
| `gpt-4o-mini` | `azure-blind` | 0.073 | 28% | 67% |
| `gpt-4o-mini` | `blind-snap` | 0.058 | 39% | 67% |
| `gpt-4.1-mini` | `azure-current` | 0.050 | 50% | 78% |
| `gpt-4.1-mini` | `azure-blind` | 0.037 | 72% | 83% |
| `gpt-4.1-mini` | `blind-snap` | 0.040 | 56% | 83% |
| `gpt-5-mini` | `azure-current` | 0.044 | 56% | 83% |
| `gpt-5-mini` | `azure-blind` | 0.047 | 56% | 89% |
| `gpt-5-mini` | `blind-snap` | 0.042 | 56% | 83% |

Reading: snap helps `gpt-4o-mini` clearly (median 0.097 → 0.058). Changing the model helps more:
`gpt-4.1-mini` and `gpt-5-mini` both roughly halve the error of today's production setup, and with
them snap adds little. The two are indistinguishable on 18 cases. No `gpt-5.1` deployment exists on
the experiment account, so it was not run. Eighteen cases from two brands is too few to choose on.

## Goal 2 — Ingestion for every vendor, managed from admin

**Done means:** every registered source has run at least once with its counts recorded, the catalog
holds the brands in the photos, and one admin tab shows every site and brand with its state.

| # | Step | Output |
|---|---|---|
| 2.1 | **Run what is already allowed.** Local first: each enabled source as a dry run (`materializeToInventory: false`, `detectHexFromImage: false`), then for real. Photographed brands first: the eight own-store sources, Harlow & Co, Beyond Polish. Record accepted counts, brands created and every failure per source. | Per-source run table; local catalog of several thousand shades |
| 2.2 | **Fix what the first runs break.** These connectors have only met fixtures. Expect title-parser and brand-alias misses on the retailers; fix them against the run output. | Clean re-runs |
| 2.3 | **Barcodes and coverage.** `backfill:barcodes` after ingestion, then the coverage report: every labelled bottle → in catalog or not, and from which source. | Coverage table; the "ingest next" list |
| 2.4 | **Admin Sources & Brands tab.** Finish the drafted design, then build: Sites table (URL, brand store vs retailer, on/off, permission state, last run, products and shades supplied) and Brands table (shade count, supplying sources, brands we know but cannot ingest and why), with filters, a Turn on/off control and run history. | `/admin?tab=sources` |
| 2.5 | **Deployed dev.** Deploy `dev`, run migrations, repeat 2.1 there. This is the release gate the brand-sources work never passed. | Dev environment catalog matches local |
| 2.6 | **Pending sources (owner).** Permission emails and terms reading from the brand-sources owner checklist, in the order the coverage report gives: Picture Polish, Painted Polish, Hypnotic Polish, OPI, then the 20 clause stores. Each OK is recorded in the admin tab, which is what turns the source on. | Pending list shrinking |
| 2.7 | **Brands with no source.** Register sources for the photographed brands that have none (Maniology, Moth & Moon, Swamp Gloss, the Polish Pickup makers), each through the same terms check. | New sources registered |

## Order of work

1. **Now (running):** local stack on `dev` (backup, migrate, build); batch 2 labelling.
2. **Next, in parallel:** 2.1 ingestion runs for the photographed brands · 1.2 adapter and import · 1.3 AI smoke.
3. **Then:** 1.4 baseline and 2.3 coverage report. These two tables decide everything after.
4. **Then, in parallel:** 1.5 fix loop (lead) · 2.4 admin tab (its own session, already open) · 2.2 connector fixes.
5. **Then:** 1.7 inventory mode · 2.5 deployed dev · 2.6/2.7 as OKs arrive.

## Parked

Not worked on until both goals are met. Their notes stay where they are.

- Bins and display boxes (physical storage model). Its one idea that belongs here, "inventory mode
  auto-adds on a match", is step 1.7.
- Pile / scratchpad for search results.
- Launch radar (releases, trends, swatch videos).
- Polish learning agent, beyond the three pieces of it already merged (#496, #499, #500).

## Decisions for Matt

1. **Admin "Turn on" button:** strict (only stores with no clause or a recorded OK), or allow an
   override with a confirmation that is written to the history? Recommended: allow the override. You
   are the owner, Mooncat and Cupcake are already on without a recorded OK, and the history keeps it
   honest.
2. **Pending stores:** Matt asked on 2026-11-10 for Picture Polish, Painted Polish and Potion Polish
   to be turned on for real. Their terms were then read (progress log, second pass): Picture Polish
   forbids extraction tools, republishing and linking; the Big Cartel API licence forbids keeping a
   database of store content. Not enabled. Decide: email the three makers for their OK (drafts can
   be prepared), or enable anyway with that on record.
3. **Sessions and worktrees:** archive the finished sessions (#496–#501 and the two classification
   and cleanup ones) and remove the five merged `brand-sources-phase-*` worktrees? Disk has 17 GB
   free.
4. **AI deployments:** which Azure OpenAI deployment should the sticker read use? Local settings
   point everything at `gpt-4o-mini`; #498 added the gpt-5 request shape but no setting uses it yet.
