# Indie Shopify sources — survey, October 2026 (#273, #328)

Survey of the next indie stores for the generic Shopify connector
(`packages/functions/src/lib/connectors/shopify-generic.ts`), run on **2026-10-18**. It re-checks the
2026-10-17 pass recorded in the comment above the indie rows in `docs/seed_data_sources.sql` and adds
five more makers from the collector research (roadmap §2 item 8: "Holo Taco, ILNP, Mooncat, Cirque,
KBShimmer, Emily de Molly, Polish Pickup makers").

**Update 2026-10-19:** the owner reported sign-off from Pahlish, Emily de Molly and Cirque Colors, and they
are enabled by migration `20261019020000000_enable-signed-off-indie-sources` (who and how are not recorded;
the notes say so). Cirque still ingests only about 10 of its 415 products until it has a store filter.
Everything else below is the survey as it stood on 2026-10-18, before that. Enabling a store remains the
owner's call (decision D2 in `docs/decisions-2026-10.md`), after the store's OK is recorded in
`data_source.metadata.notes`.

**Update 2026-10-22 (batch 3):** the owner received written permission by email from Stella
Chroma, Lemming Lacquer and Sweet & Sour Lacquer, the three stores batch 2 named. They are registered
enabled by migration `20261023021845964_add-approved-indie-shopify-sources`, each with a store filter; the
same migration enables Night Owl Lacquer's row where it was still pending. Seven indie stores are enabled
(Night Owl, Pahlish, Emily de Molly, Cirque Colors, Stella Chroma, Lemming Lacquer, Sweet & Sour), which
meets #273's 6–10 store criterion. #273 stays open until its other criteria are met in production: the
first prod ingestion of the new stores (owner, Admin → Admin Jobs), hex detection on their shades, and the
measured increase in active shades (the 247 shades below came from a local run, not prod). Details in
[Batch 3](#batch-3--2026-10-22) below.

## Batch 3 — 2026-10-22

Same method as batch 2 (`/robots.txt`, `/policies/terms-of-service`, then `/products.json?limit=250&page=N`
until a short page, 1 s apart, same User-Agent). Each catalog fits one page. The filter counts run the
connector's own gate from this branch (`classifyIngestedProduct` + store filter + `isBundle`) over the
downloaded products, and the local ingestion (Functions host with dev bypass against the `npm run dev:infra`
Postgres, `exhaustive`, `materializeToInventory` on, `detectHexFromImage` off) confirmed the same accepted
counts end to end.

| Store | Source | Products | Generic gate | Store filter | Approval basis | Terms |
|---|---|---|---|---|---|---|
| Stella Chroma (stellachroma.com) | `StellaChromaShopify` | 81 | 72 (keeps 2 "Complete set" listings, the coat duo, "Mysteries!" and the mystery subscription; drops the cuticle oil, tagged "brush pen") | **68** (`store-filters/stella-chroma.ts`): 63 shades, 2 top coats, 1 base coat, 2 treatments; drops the t-shirt, magnets, gift card, "Rush Processing", "Shipping Protection", the butter balm and a doorbuster-plus-sticker listing | Written permission received by the owner by email, 2026-10-22 | Shopify default template (spider, crawl, or scrape clause); robots.txt Shopify default. www.stellachroma.com/policies/terms-of-service |
| Lemming Lacquer (lemminglacquer.com) | `LemmingLacquerShopify` | 30 | 24 (drops the Multichrome-typed shade, keeps the Polish Pickup mystery grab bag typed "Flakes") | **24** (`store-filters/lemming-lacquer.ts`): 24 shades; drops the 3 collection listings, gift card, magnet and the mystery grab bag | Written permission received by the owner by email, 2026-10-22 | Shopify default template; robots.txt Shopify default. lemminglacquer.com/policies/terms-of-service |
| Sweet & Sour Lacquer (sweetandsourlacquer.com) | `SweetAndSourLacquerShopify` | 169 | 8 (empty `product_type` and no tags on every product: only coats and coat refills by title) | **155** (`store-filters/sweet-and-sour.ts`): 150 shades, 4 base coats, 1 top coat; drops the trio, duo, mystery overpour, 4 coat refills, gift card, magnet, sticker, coozies, tab opener, the clear watermarbling polish and "Supercluster" (no text beyond a restock note) | Written permission received by the owner by email, 2026-10-22 | Shopify default template; robots.txt Shopify default. sweetandsourlacquer.com/policies/terms-of-service |

**Filter notes.** Stella Chroma and Lemming Lacquer filters return `null` for anything they do not
recognise, so the generic gate keeps doing the work it already does well; they only correct its known
misses. Sweet & Sour follows the Pahlish pattern (title blocklist, then the description), with one
addition: a listing with no text beyond the store's screen-colour disclaimer is kept, because the store
lists several shades that way ("Budget Babe", "My Wallet is Crying", …). Stella Chroma's vendor is
"STELLA CHROMA" on every product; `resolveShopifyVendor` now gives an all-caps vendor that spells the
source brand the brand's casing, so the brand is "Stella Chroma". Known losses: Stella Chroma's
"PBE Doorbuster & exclusive sticker - Beach Cruiser" (a shade sold with a sticker; the title would make a
bad shade name) and Sweet & Sour's "Supercluster". Toppers at Sweet & Sour are only named in the
description ("glitter topper"); the #352 text-derived finishes carry `topper` through, so materialization
filed 18 Sweet & Sour and 2 Stella Chroma products as `topper`.

**Night Owl Lacquer.** Decision D2 (2026-10-17) enabled it, and `docs/seed_data_sources.sql` seeds it
enabled, but the row migration `20261017062550000_add-indie-shopify-sources` inserted is disabled with
`pendingApproval`, and no later migration or activation `UPDATE` changed that in the dev database (the
README asked each environment to run it by hand). The batch 3 migration enables that row where it is
still pending and appends the D2 reference to its notes; its Down restores the pending flag on exactly
that row.

**Local ingestion (2026-10-22, dev Postgres).** Dry run (`materializeToInventory: false`): Stella Chroma
68 of 81 accepted, Lemming Lacquer 24 of 30, Sweet & Sour 155 of 169, all 247 stored as
`external_product` rows. Materializing run: **247 new shades** (Stella Chroma 68, Lemming Lacquer 24,
Sweet & Sour 155), 3 new brands, 247 product images and 1,692 additional gallery images stored, no upload
failures, AI hex detection off. Nothing was run against an Azure database; the owner runs the first prod
jobs from Admin → Admin Jobs (with hex detection on, the Week 0 production strategy).

## Batch 2 — 2026-10-19

Second pass for #273, same method (one request each for `/products.json?limit=1` and
`/policies/terms-of-service`, 1 s apart, same User-Agent; full `products.json` only for stores whose
terms allow it or that have already signed off).

**The five named candidates:** no change from the table below. Mooncat and Cupcake Polish are already
enabled sources; ILNP is WooCommerce (products.json 404), KBShimmer is behind a Cloudflare challenge,
Painted Polish is Big Cartel. None can become a `shopify-generic` source.

**Other indie stores checked:** none added. Every store that answers with Shopify `products.json`
and is not in the repo yet has terms that forbid automated access:

| Store | products.json | Terms | Verdict |
|---|---|---|---|
| Stella Chroma (stellachroma.com) | ✅ 200 | Shopify default "spider, crawl, or scrape" | Not added in batch 2: needed written OK (added in batch 3, 2026-10-22) |
| Lemming Lacquer (lemminglacquer.com) | ✅ 200 | Shopify default clause | Not added in batch 2: needed written OK (added in batch 3) |
| Sweet & Sour Lacquer (sweetandsourlacquer.com) | ✅ 200 | Shopify default clause | Not added in batch 2: needed written OK (added in batch 3) |
| Maniology (maniology.com), What's Up Nails (whatsupnails.com) | ✅ 200 | "scrape" clause (stamping brands) | Not added |
| Nails.INC (nailsinc.com) | ✅ 200 | `/pages/terms-conditions`: no copying, reproducing or republishing content without written permission; no commercial use | Not added (also not indie) |
| Ninja Polish (ninjapolish.com) | ✅ 200 | Content may not be reproduced without written consent; multi-brand reseller (`vendor: Various`) | Not added |
| F.U.N Lacquer, Glam Polish, Moon Shine Mani, Dreamland Lacquer | ✅ 200 | Scraping clause (re-checked) | Not added (as on 2026-10-17) |
| Tonic Polish, Bluebird Lacquer | ❌ 401 (password page) | – | Skip |
| Colores de Carol, Glisten & Glow, Masura, Killer Colors | ❌ not Shopify products.json | – | Skip |
| Ethereal Lacquer, Elevation, Cadillacquer, Lollipop Posse, Literary Lacquers, Danglefoot, Different Dimension, Garden Path (old domain), Ever After, Fan Brush, Quixotic, Turtle Tootsie, JReine, Paint Box, Contrary, Moonflower, Harlow & Co, Ellagee, Pipe Dream, Pepper Pot, Grace-full, Black Cat, Jior Couture, Smokey Mountain, Glitter Gal, Chamaeleon, Lily Pad, Polished Gamers, McKF, Rainbow Connection, Oxxi, Tipsy | ❌ no answer at the guessed domain | – | Skip (domains guessed, not verified) |

Great Lakes Lacquer (custom terms, no automated-access clause), Bee's Knees, Kathleen & Co, Sassy Sauce
and Clionadh came up too but are already sources.

**Cirque Colors store filter (follow-up below, done):** `connectors/store-filters/cirque-colors.ts`
keeps **328 of 415** products on 2026-10-19 (293 color, 23 topper, 7 treatment, 4 base coat, 1 top coat by the
rule classifier; the generic gate kept 10). Dropped: 85 sets/duos/trios/bundles/nail-art kits,
tools, charms, stickers, remover, wipes, gift card, free gifts and creator profile pages, plus 2
collection sets with the bundle tag. Cirque tags its coats "Top & Base Coat"; the classifier and the
audit query now read coat wording in the title before the tags, so its top coats are `top_coat`.

**Against +10k:** batch 2 adds about 316 Cirque shades (293 color + 23 toppers) and 12 coats/treatments. The indie Shopify route is close to exhausted
without store agreements; the other routes in `docs/data-sources-research.md` are needed. Batch 3 (below the
2026-10-22 update at the top) adds about 237 shades and 10 coats/treatments from the three stores that gave
written permission.

## How each store was checked

Per store, one request each, with the User-Agent
`SwatchWatch/connector-research (+https://github.com/mattmck/swatchwatch)` and a 1 s pause between
requests: `/robots.txt`, `/policies/terms-of-service`, and `/products.json?limit=250&page=N` until a
page had fewer than 250 products. No other pages were fetched. The polish-filter count runs the
connector's own `isNailPolish` + `isBundle` (the build from this branch) over the downloaded products,
so it is exactly what ingestion would keep. Images were not downloaded.

"Shopify default ToS" means the store uses Shopify's terms template, whose prohibited uses include
"to spam, phish, pharm, pretext, spider, crawl, or scrape". robots.txt never disallowed
`/products.json` on any Shopify store checked.

## Findings

| # | Store | Platform | products.json | Products | Pass polish filter | Terms / robots on automated access | Already in repo? | Recommendation |
|---|---|---|---|---|---|---|---|---|
| 1 | **Pahlish** (pahlish.com) | Shopify | ✅ 200 | 36 | 0 generic, **28 with the new store filter** (#328) | Terms page has no terms text; robots.txt Shopify default | Yes: `PahlishShopify`, seeded disabled, pending | **Ready once the owner says OK.** Ask Pahlish, record the reply, enable |
| 2 | **Emily de Molly** (emilydemolly.com) | Shopify | ✅ 200 | 317 | **246** (nail + stamping polish; 70 stamping plates, gift card dropped) | Shopify default ToS (spider/crawl/scrape clause); robots.txt Shopify default | Added here: `EmilyDeMollyShopify`, disabled, pending | Ask the store for written OK; then enable. Largest clean win |
| 3 | **Cirque Colors** (cirquecolors.com) | Shopify | ✅ 200 | 415 | **10** (`product_type` is the finish/line: Jelly, Magnetic, Crème, Retired Colors…) | Shopify default ToS clause; robots.txt Shopify default | Added here: `CirqueColorsShopify`, disabled, pending | Ask for written OK **and** add a store filter (or wait for the #349 classifier); about 320 single shades once filtered (rough count: finish `product_type` and no set/duo/kit in the title) |
| 4 | Painted Polish (paintedpolish.com) | Big Cartel | ✅ (Big Cartel's own JSON array, not Shopify's) | 287 | n/a (no connector) | No terms page found at the Shopify path; robots.txt allows all | No | Needs a Big Cartel connector first; not a `shopify-generic` source |
| 5 | Mooncat (mooncat.com) | Shopify | ✅ 200 | 318 | 270 | Shopify default ToS clause; robots.txt Shopify default (crawl-delay only for named SEO bots) | Yes: `MooncatShopify`, enabled since before D2 | Already ingesting. The owner may want the store's OK on record too |
| 6 | Cupcake Polish (cupcakepolish.com) | Shopify | ✅ 200 | 165 | 151 | Shopify default ToS clause; robots.txt Shopify default | Yes: `CupcakePolishShopify`, enabled since before D2 | Already ingesting. Same note as Mooncat |
| 7 | ILNP (ilnp.com) | WooCommerce | ❌ 404 | – | – | robots.txt disallows `/wp-json/` and `/wc/store/v1/` (the WooCommerce APIs) | No | Not possible without the store's help (feed or permission) |
| 8 | KBShimmer (kbshimmer.com) | unknown (behind Cloudflare) | ❌ 403 | – | – | Cloudflare challenge on every path, robots.txt included | No | Not possible unless the store allowlists us |
| 9 | Polish Pickup (polishpickup.com) | Shopify | ✅ 200 | 3 | 0 (2 merch, 1 gift card) | Shopify default ToS clause | No | No value: the monthly maker rounds are not in products.json |
| 10 | Supernatural Lacquer (supernaturallacquer.com) | – | ❌ no DNS answer | – | – | – | No | Skip (site unreachable on 2026-10-18) |
| 11 | Girly Bits (girlybitscosmetics.com) | unknown | ❌ 503 | – | – | robots.txt blocks AI crawlers by name; terms and products.json return 503 | No | Skip |
| 12 | Lavish Polish (lavishpolish.com) | not Shopify | ❌ 404 | – | – | robots.txt allows all | No | Skip |
| 13 | Fair Maiden Polish (fairmaidenpolish.com) | – | ❌ 530 (origin error) | – | – | – | No | Skip (site down on 2026-10-18) |

Rows 10–13 and Polish Pickup are the five extra makers. All five turned out unusable, so the
next-best candidates are the stores the 2026-10-17 pass already listed in `docs/seed_data_sources.sql`
(F.U.N Lacquer, Glam Polish, Moon Shine Mani, Dreamland Lacquer, Ethereal Lacquer), which all have the
scraping clause and need a written OK the same way Emily de Molly and Cirque do.

**Against the #273 target (+10k active shades by 19 Dec):** the stores that are reachable at all add
roughly 28 (Pahlish) + 246 (Emily de Molly) + ~320 (Cirque, after a filter) ≈ **600 shades**. Ten
thousand needs either many more stores or a different source type (affiliate feeds, retailer
catalogs: see `docs/data-sources-research.md`).

## Recommended order

1. **Pahlish** — the only candidate whose terms say nothing about automated access, and the filter
   now exists. Owner asks the store, records the answer, enables (steps in
   `packages/functions/README.md` → Connector Ingestion Jobs → "Enabling `PahlishShopify`").
2. **Emily de Molly** — 246 polishes pass the existing filter with no extra code. Needs written OK.
3. **Cirque Colors** — the biggest catalog, but needs both written OK and a store filter.
4. **Painted Polish** — only if a Big Cartel connector is worth building.

ILNP and KBShimmer, the two most-requested indies, can only come in with the store's cooperation.

## Exact `data_source.metadata.notes` text

The rows below are already in `docs/seed_data_sources.sql` (and, for Emily de Molly and Cirque, the
migration `20261019013349049_add-more-indie-shopify-sources`). When the store gives its OK, **append**
this sentence to the row's notes, filled in:

> Acceptable use confirmed by `<name, role>` at `<store>` on `<YYYY-MM-DD>` via `<email/DM/form>`: `<one-line summary of what they agreed to, e.g. "reading products.json daily for catalog data and images">`.

```sql
UPDATE data_source
SET metadata = jsonb_set(metadata, '{notes}', to_jsonb((metadata->>'notes') || ' Acceptable use confirmed by … on … via …: ….'))
WHERE name = '<Source>';
```

### PahlishShopify (seeded; notes updated in this PR)

> Pahlish Shopify store (indie, US). Verified 2026-10-17: /products.json?limit=1 returns 200 with Shopify products (36 listed: current releases only); robots.txt is the Shopify default (products.json not disallowed); /policies/terms-of-service has no terms text, no automated-access clause found. The generic connector polish filter accepts 0 of the 36 products (empty product_type, tags are collection names only); the store-specific filter connectors/store-filters/pahlish.ts (#328) accepts 28 of 36 on 2026-10-18 (single shades; gift card, collection sets, mystery batches, base/top coats and empty boxes dropped). Disabled pending owner approval (roadmap 2026-10-to-12 decision 4); acceptable use not yet confirmed with the store.

### EmilyDeMollyShopify (new)

> Emily de Molly Shopify store (indie, Australia). Verified 2026-10-18: /products.json returns 200 with Shopify products (317 over 2 pages: product_type Nail Polish 234, Stamping Plates 70, Stamping Polish 12, Gift Card 1); the generic connector polish filter accepts 246 (nail and stamping polishes; plates and the gift card dropped). Vendor is Emily de Molly on 313 products and EmilydeMolly on 3. robots.txt is the Shopify default (products.json not disallowed). /policies/terms-of-service is the Shopify default template, whose prohibited uses include: spider, crawl, or scrape. Disabled pending owner approval; enable only after the store gives written OK to read its products.json (record who, when and how here).

### CirqueColorsShopify (new)

> Cirque Colors Shopify store (indie, US). Verified 2026-10-18: /products.json returns 200 with Shopify products (415 over 2 pages). product_type holds finish or line names (Retired Colors 70, Jelly 59, Magnetic 48, Sets 35, Crème 21, Nail Care 13, ...), so the generic connector polish filter accepts only 10 of 415; it needs a store-specific filter (connectors/store-filters/) or the #349 product classifier before ingestion is useful. robots.txt is the Shopify default (products.json not disallowed). /policies/terms-of-service is the Shopify default template, whose prohibited uses include: spider, crawl, or scrape. Disabled pending owner approval; enable only after the store gives written OK to read its products.json (record who, when and how here).

### MooncatShopify and CupcakePolishShopify (already enabled; optional addition)

If the owner wants the same paper trail for the two stores that were enabled before D2, append:

> Re-checked 2026-10-18 (docs/indie-sources-2026-10.md): products.json exposed (Mooncat 318 products, 270 pass the polish filter / Cupcake 165, 151 pass); /policies/terms-of-service is the Shopify default template, whose prohibited uses include: spider, crawl, or scrape. Enabled before decision D2; written OK from the store not on record.

## Follow-ups

- ~~Cirque Colors store filter~~: done 2026-10-19 (`connectors/store-filters/cirque-colors.ts`, batch 2 above).
- ~~Cirque coats tagged "Top & Base Coat" filed as `base_coat`~~: fixed 2026-10-19 (title beats tags).
- Great Lakes Lacquer lists a multi-shade "The Boat Load Bundle" without a bundle tag; the generic
  gate keeps it (26 of 27 products pass). A title-based bundle check would catch it.
- Emily de Molly vendor spelling: 3 products say `EmilydeMolly`; check whether ingestion's brand
  matching merges it with `Emily de Molly` before enabling.
- Big Cartel connector, if Painted Polish is wanted.
- ~~Ask Stella Chroma, Lemming Lacquer and Sweet & Sour for written OK~~: received 2026-10-22, added in batch 3.
