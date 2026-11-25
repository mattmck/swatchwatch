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

**2026-11-10, overnight:**

- **Committed and pushed:** retailer images on for Harlow & Co and Beyond Polish (D28, migration
  `20261110130000000`), and the brand and shade-name rules for China Glaze, Le Mini Macaron,
  Starrily, Lights Lacquer and Cracked Polish (migration `20261110140000000`, four title parsers,
  two store filters). Offline over the stored products: China Glaze 72 of 75 under the right brand,
  Le Mini Macaron 42 of 181 (139 gel or LED dropped), Starrily 203, Lights Lacquer 165, Cracked 130.
- **A re-run does not repair shades already filed under the wrong brand** (the product's own
  listing wins and the shade's brand is never updated). In progress: make a brand-store re-run
  self-correcting (move or merge to the right brand, clean the name, retire shades whose product
  the store filter now rejects).
- **Image storage is unbounded per product, and it nearly filled this disk.** Brand stores keep
  every product photo: about 30 per product for Cracked and Bee's Knees, 16,000 images (several
  GB) in two hours locally. `GALLERY_MAX_IMAGES_PER_SHADE` only limits what is linked, not what is
  stored. On dev and prod this is blob storage cost and ingest time (Bee's Knees ran at about 30
  products per 4-minute slice). **Needs a per-product download cap before the dev ingest.**
- **The admin per-source "download images" setting is not read by the worker.**
  `metadata.ingestion.downloadImages` is saved and returned by the settings endpoints, but storage
  is decided by `imagesPermitted` only.
- **Local disk guard:** the Cracked and Bee's Knees jobs were cancelled at 130 of 505 and 80 of 565
  and re-queued with `imagesPermitted: false` set in the local database only (marked
  `localDiskGuard`), so their catalogs complete without more photos. The retailer re-run with
  images waits for disk space (13 GB free; five merged worktrees hold 16 GB).

**2026-11-10, full baseline (176 samples from 87 bottles, `gpt-4o-mini`, after the fixes above):**

- **Catalog after all local runs and corrections:** 43 of 87 bottles are in the catalog (24 before
  the naming fixes). Re-running the stores moved or merged the misfiled shades as predicted (China
  Glaze 18 moved, 50 merged, 3 left; Le Mini Macaron 17 moved, 25 merged; Starrily 20 moved, 58
  renamed) and the backfill retired 142 gel and off-brand shades.

  | In the catalog (96 samples) | n |
  |---|---|
  | Matched correctly | 57 (59%) |
  | Asked, right shade in the list | 2 |
  | Asked, right shade not in the list | 2 |
  | Unmatched | 33 |
  | **Matched wrongly** | **2** |

  | Not in the catalog (80 samples) | n |
  |---|---|
  | Correctly not matched | 77 |
  | **Matched wrongly** | **3** |
  | Create card offered | 72.5% |

- **The five wrong matches are the priority.** "Cinnamon Apple Sangria" matched Potion Polish
  "Cinnamon Cider 2.0"; "Electric Holo" matched "I Scream Holo"; two Starrily box takes whose name
  shows through a window that cuts letters off matched "Hera" and "Serpent's Lair" at name score
  1.00. In each the model picked a name from the brand's shade list and the pick was trusted as a
  match. In progress: a pick alone must never produce a match.
- **Unmatched, by cause:** name not read 19 (Picture Polish 5: the name is on the front label, which
  the flow reads for the brand only; Le Mini Macaron 5; OPI 3; Lights Lacquer 3; Starrily 2; Painted
  Polish 1), name read wrong 6, brand not resolved 7, shade not poolable 4 (toppers and top coats
  are outside the resolver's colour-only pool).
- **Glass colour measured the hand** on several takes (`#F8D5B8`, `#FAD5B8`, `#FEEAB8`).
- **Per brand, matched of in-catalog samples:** KBShimmer 9/10, ILNP 8/10, Bee's Knees 5/6, Cracked
  11/14, Starrily 15/23, Le Mini Macaron 5/10, Lights Lacquer 1/4, Mooncat 1/2, Orly 1/3, Painted
  Polish 1/2, OPI 0/6, Picture Polish 0/6.

**2026-11-10, wrong matches fixed (sticker read v3):**

- **Cause confirmed on the photos:** with the brand's shade list in the prompt, the model returned
  its pick as the "printed" name, so the name match scored 1.0 by itself. The five labels were
  right; the reads were wrong.
- **Rule now:** the sticker is read at high detail without the list first. A pick from the list
  counts only when that independent printed name is complete and agrees with it; an unverified pick
  or a partly hidden name can be offered as a candidate but can never make a match. The front's
  printed name (Picture Polish) makes a candidate, and a bottom that names a different shade than
  the front turns a match into a question. Toppers, top coats and treatments are in the pool.

  | 176 samples | Baseline `gpt-4o-mini` | After `gpt-4o-mini` | After `gpt-5-mini` |
  |---|---|---|---|
  | In catalog (96): matched | 57 | 41 | 53 |
  | Asked, right shade listed | 2 | 28 | 22 |
  | Asked, right shade not listed | 2 | 4 | 9 |
  | Unmatched | 33 | 23 | 12 |
  | Wrong match | 2 | 0 | 0 |
  | Not in catalog (80): correctly not matched | 77 | 80 | 79 |
  | Not in catalog: wrong match | 3 | 0 | 1 |
  | Model calls per bottle | 2.84 | 3.32 | 3.25 |

- **The trade:** no wrong matches on `gpt-4o-mini`, but 16 bottles that used to auto-match are now a
  question with the right shade in the list, because their honest read is garbled or cut short
  ("DARK MUS", "Street Deal" for Sleet Deal). They matched before only through the mechanism that
  caused the wrong matches. Right answer reachable (matched or listed): 59 → 69 of 96 on
  `gpt-4o-mini`, 75 of 96 on `gpt-5-mini`.
- **`gpt-5-mini`'s one wrong match** read "morgana" off a labelled bottle standing behind the one
  being held (Picture Polish "Eventide", not in the catalog). Next: crop the name read to the guide
  region. This is the realistic risk when someone pulls a pile of same-brand bottles.
- **Still open:** the front brand read regressed on two Starrily takes ("Starry"); glass colour
  measures the whole frame, so it picks the hand; the local `__TEST__` brands show up in the brand
  list given to the model.

**2026-11-10, late night:**

- **Image cap (goal 2):** `SOURCE_IMAGE_MAX_PER_PRODUCT` (default 8) bounds downloads per product,
  always keeping the primary image and the one hex detection would choose. It would have skipped
  about 6,840 of 19,400 locally stored images (Cracked 71%, Bee's Knees 80%). The admin per-source
  "download images" and "detect hex" switches are now read by the worker. Owner to add the GitHub
  environment variable `SOURCE_IMAGE_MAX_PER_PRODUCT` in `dev` and `prod`.
- **Reads see the held bottle (sticker read v4, glass v2):** glass colour is measured on the guide
  region only (`quality.guideRegion` from the client, else the centre of the frame): skin-tone
  glass hexes fell from 48 of 269 to 1 of 122, with a rule that keeps real nude polishes. The name
  read reports where the bottle and the name are, and a name off the bottle is dropped. With no
  catalog brand, a one-word name ("AUSTIN", the maker's city) no longer matches by name alone.

  | 176 samples | `gpt-4o-mini` v3 | `gpt-4o-mini` v4 | `gpt-5-mini` v3 | `gpt-5-mini` v4 |
  |---|---|---|---|---|
  | In catalog (96): matched | 41 | 48 | 53 | 55 |
  | Asked, right shade listed | 28 | 24 | 22 | 26 |
  | Asked, right shade not listed | 4 | 6 | 9 | 3 |
  | Unmatched | 23 | 18 | 12 | 12 |
  | Wrong match | 0 | 0 | 0 | 0 |
  | Not in catalog (80): wrong match | 0 | 0 | 1 | 0 |

- **Honest limits:** cropping the name read did not work on the real frames (the background label
  sits inside the guide outline), and `gpt-4o-mini` returns nominal boxes, so the off-bottle check
  is a backstop that mostly helps `gpt-5-mini`. The web client sends `guideRegion` on shutter and auto-shutter bottle photos; mobile and uploaded photos do not send it yet. Cut-off
  names ("DARK MUS") stay questions: no prefix rule was safe with 80 not-in-catalog bottles.
  `gpt-5-mini`'s front brand confidence sits just under the 0.6 threshold on some Picture Polish
  takes.

**2026-11-10, end of the overnight run:**

- **Web sends the guide outline** (`quality.guideRegion`) on shutter and auto-shutter bottle photos,
  mapped through the preview crop; unit-tested, not yet checked on a phone. Mobile draws no outline
  and sends none.
- **Review fixes on PR #508:** the front-named shade always reaches the candidate pool; a capped run
  does not prune after a failed stored-image lookup; the rejected-product backfill rechecks the
  protection flags in its UPDATE.
- **Retailer images are in (locally, one per product):** Harlow & Co and Beyond Polish re-ran with
  images on. 6,127 of 7,020 active local shades now have an image (ILNP 605 of 605, OPI 543 of 543,
  KBShimmer 327 of 327). Only 68 shades have a measured colour, because vision hex detection has
  not been run: that waits on the model and snap choice (step 1.8a), since it is thousands of paid
  calls and has to be repeated on dev.
- **Local-only state to remember:** `imagesPermitted: false` with a `localDiskGuard` note on Cracked,
  Bee's Knees, China Glaze, Le Mini Macaron, Starrily and Lights Lacquer in the local database, and
  the local host runs with `SOURCE_IMAGE_MAX_PER_PRODUCT=1`. Neither is in any migration.

**2026-11-11, matching (shared text matcher, resolver `bottle-v2`, full-size photos):**

- **Shared matcher** (`packages/shared/src/matching/`): normalisation, edit similarity, name ranking
  with a required lead, vendor-code and printed-GTIN helpers, `matchBottleText`. It reproduces the
  Apple Vision spike exactly on the 176 takes (85 of 96 right, 0 wrong, 0 false; 80 of the 85 are
  exact names). `brandNames` keeps brand text ("Stary" on a Starrily bottle) out of the ranking.
- **Resolver `bottle-v2`, the rule after two independent reviews:** only an exact printed bottom/box
  name (or alias) owned by one shade matches on its own. A close name with a lead, an exact front
  name, a vendor code and a near-exact name without a brand are weak signals: each needs the
  measured glass colour within `colorHigh`, otherwise the user is asked with that shade first;
  competing weak signals always ask. A first version let a close name match alone and scored 60 / 66;
  a leave-one-out over the live catalog showed 63 near-twin pairs (Zoya Polly/Lolly, Bee's Knees
  Demon/Lemon) it would have added silently, so it was not kept. With the final rule the same
  leave-one-out adds no wrong shade through any new rule.
- **Eval, final rules** (0 wrong and 0 false-confident in every cell; 96 in catalog, 80 not):

  | Reader | 480 px takes (samples 1–193) | 1920 px takes (samples 194–369) |
  |---|---|---|
  | `gpt-4o-mini` matched | 49 (was 48) | 53 |
  | `gpt-4o-mini` asked with the right shade | 26 | 30 |
  | `gpt-5-mini` matched | 58 (was 55) | 67 |
  | `gpt-5-mini` asked with the right shade | 24 | 24 |
  | `gpt-5-mini` unmatched | 10 | 4 |

- **Why the model path gained little:** the eleven takes the looser version matched are now questions
  with the right shade first, and none can be confirmed by colour because the local catalog has 68
  measured colours (KBShimmer, Cracked, Bee's Knees, Picture Polish: none). Step 1.8 is now what
  turns those questions into matches.
- **Text reader on the full-size export** (576 of 579 staged photos paired by capture time; brand
  known, brand text excluded):

  | Long edge | Right of 96 (exact + close) | Wrong | False of 80 | Barcodes decoded |
  |---|---|---|---|---|
  | 480 upscaled 2.5× | 87 (80 + 7) | 0 | 0 | 15 |
  | 640 | 75 (73 + 2) | 0 | 0 | 10 |
  | 960 | 86 (83 + 3) | 0 | 0 | 22 |
  | 1280 | 84 (81 + 3) | 0 | 0 | 34 |
  | 1920 | 83 (81 + 2) | 0 | 0 | 36 |
  | 4032 | 84 (82 + 2) | 0 | 0 | 34 |

  Resolution is not the limit for the reader; about 1280 px on the long edge is enough and makes
  barcodes readable. Every brand but Starrily is at or near 100%; Starrily's names are on the box and
  get clipped at the box edge. Vendor codes named the right shade in 5 takes.
- **Open, found on the way:** (1) the model's verified closed-set pick counts as verified at
  `nameAgreement` 0.75, which lets near-twins through; requiring an exact name costs no current match
  on either model (owner decision). (2) KBShimmer passed the 400-name closed-list cap (533 shades),
  so the model reads those bottles without a list. (3) Vendor codes never arrive from the model's
  reads; they need a reader that returns every printed line. (4) Three labelled photos have no
  full-size partner and 103 full-size photos were never labelled.
- **Local state to remember:** full-size copies in `~/Pictures/swatchwatch-bottle-eval/2026-11-full`
  (2.7 GB) and a 1920 px copy in `2026-11-1920` (the source of samples 194–369). PR #508 was merged
  before this work was pushed, so these commits sit on the old branch and need their own PR.

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
| 2.7 | **Brands with no source.** Register sources for the photographed brands that have none (Maniology, Moth & Moon, Swamp Gloss, the Polish Pickup makers), each through the same terms check. Swamp Gloss done 2026-11-13 (`SwampGlossShopify`, enabled by the owner's decision; its photographed Lock, Shock & Barrel is no longer listed). | New sources registered |

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
2. **Pending stores: decided.** On 2026-11-10 Matt enabled Picture Polish, Painted Polish and Potion
   Polish without a store OK, after the terms were read (decision D27; progress log, fourth pass).
   Follow-up, separate from the decision: ask the three makers for the record and note each answer
   in the source's `metadata.notes`. Likewise retailer images for Harlow & Co and Beyond Polish
   (decision D28): ask both retailers for the record.
3. **Sessions and worktrees:** archive the finished sessions (#496–#501 and the two classification
   and cleanup ones) and remove the five merged `brand-sources-phase-*` worktrees? Disk has 17 GB
   free.
4. **AI deployments:** which Azure OpenAI deployment should the sticker read use? Local settings
   point everything at `gpt-4o-mini`; #498 added the gpt-5 request shape but no setting uses it yet.
