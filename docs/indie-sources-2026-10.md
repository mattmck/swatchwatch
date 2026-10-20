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

- Cirque Colors store filter (`connectors/store-filters/cirque.ts`): keep finish/line `product_type`s,
  drop Sets, Nail Care, Nail Art, Tools, Base Coat, Duo, Collection Set. Or fold into the #349 classifier.
- Emily de Molly vendor spelling: 3 products say `EmilydeMolly`; check whether ingestion's brand
  matching merges it with `Emily de Molly` before enabling.
- Big Cartel connector, if Painted Polish is wanted.
