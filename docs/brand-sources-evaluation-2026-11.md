# Polish brands beyond the indie Shopify stores — evaluation and ingestion strategies (November 2026)

Evaluation of the nail polish brands SwatchWatch does not ingest yet (mass-market and professional
majors, boutique indies, Polish Pickup makers) and of the routes that could bring them in. Written on
**2026-11-08** as the follow-up to [indie-sources-2026-10.md](indie-sources-2026-10.md) (batches 1–3,
#273/#328), which closed with "the indie Shopify route is close to exhausted without store agreements;
the other routes are needed", and to the catalog target in
[roadmap-2026-10-to-12.md](roadmap-2026-10-to-12.md) §4 (+10k active shades). Companion:
[data-sources-research.md](data-sources-research.md) (APIs, barcode, ingredient and retail data, Feb 2026).

Every number below was measured on 2026-11-08 with the method in [§8](#8-method) unless it cites a source.
Nothing was ingested; no store was contacted; nothing in the database changed.

## 1. Summary

1. **The four biggest majors are not reachable from their own sites with the connectors we have.** OPI, essie,
   Sally Hansen and Zoya run custom or enterprise platforms (OPI on a sitemap + JSON-LD product
   pages, essie on Sitecore, Zoya on Art of Beauty's own storefront, Sally Hansen on line pages
   without per-shade pages). Thirty-three of the other brands probed *are* Shopify stores with `products.json`
   open. Their terms split three ways: the Shopify default clause (no spidering, crawling or
   scraping: Dazzle Dry, Sundays, DND, JINsoon, Tenoverten, Nailberry, Glam Polish, Nail Hoot, Moon
   Shine Mani, FUN Lacquer, Anchor & Heart), a custom clause of their own (butter LONDON, Ella+Mila,
   Kiara Sky, Pacifica, Static Nails, Revlon, Modelones, Dreamland, Ethereal), or **no
   automated-access clause at all** (Deborah Lippmann, Londontown, Côte, Manucurist, Olive & June,
   Piggy Paint, wet n wild, Alchemy Lacquers, Penelope Luz, Noodles; CND and Barry M have no terms
   page at the Shopify path, and Mavala's answered 500, so those three are unknown, not clear). The last group can be enabled the way Night Owl was (decision D2:
   record the basis, enable, ask for the record). See [§3.1](#31-mass-market-and-professional-majors)
   and appendix A.
2. **The two most-requested indies, ILNP and KBShimmer, stay closed at the source** (ILNP is
   WooCommerce with the Store API disallowed in robots.txt; KBShimmer is WordPress behind a
   Cloudflare challenge), **but both are fully listed by resellers whose storefronts are open**:
   Harlow & Co (Canada) lists 605 ILNP and 260 KBShimmer products, Beyond Polish (US) 233 KBShimmer,
   Hypnotic Polish (EU) 308 ILNP. See [§3.4](#34-multi-brand-resellers).
3. **One reseller, Beyond Polish, is the single largest catalog found: 17,508 products from 103
   vendors**, of which the generic ingestion gate accepts 9,395 and the lacquer-typed subset is
   **4,138 listings (4,022 color shades)** from OPI (1,160 lacquer-line listings), Zoya (262),
   Orly (255), Cirque (244), KBShimmer (223), Morgan Taylor (205), CND (159), Ella+Mila (142),
   Londontown (141), essie (118), China Glaze (102), Color Club (80), butter LONDON (66) and more.
   Its terms of service are its own text with **no automated-access clause** (the only "harvesting"
   sentence is about other users' personal data), and its robots.txt is the Shopify default.
   Beyond Polish also publishes list prices and brand product pages, which feed #267 buy links, but
   **no barcodes** in `products.json`. It is the largest single contribution found: about 2,350 new
   lacquer shades (a quarter of the +10k target), or about 6,350 with the gel lines.
4. **Polish Pickup is the live roster of the indie scene**: its November 2026 shop (open while this
   was written) lists 92 products from **76 makers**, 20 of which are already SwatchWatch sources.
   The store's own `products.json` is only useful with a store filter (`product_type` is `PPU`/`IPU`,
   so the generic gate accepts 5 of 92), and its terms carry the Shopify clause. Its value is the
   maker list for outreach, not its catalog. See [§3.3](#33-indie-makers-the-polish-pickup-roster).
5. **Retailer affiliate feeds (Sephora via Rakuten, Ulta, Sally Beauty) remain the only route to
   the majors with GTINs, prices and images in one structured file**, at the cost of an affiliate
   application per retailer and advertiser approval. Nothing new was learned that changes the Feb
   2026 assessment in `data-sources-research.md` §5, except that Amazon's PA-API is deprecated in
   favour of the Creators API (Associates account required). See [§3.5](#35-retailers-via-affiliate-feeds).
6. **Open and community data stay small or closed**: Open Beauty Facts has 137 products in its
   nail-polishes category; Lacquer Tracker is live with "over 17,000 nail polish colors, tools, and
   accessories" and no API or export. See [§3.6](#36-open-and-community-data).

**Recommendation (owner decision, see [§6](#6-decisions-for-the-owner)):** ask Beyond Polish and Harlow &
Co for a written OK (both have terms without a scraping clause, so the ask is a courtesy and a
paper trail, not a legal necessity), build a *reseller* mode for the generic Shopify connector
(vendor → brand, title → line + shade + code, set tags → skip, no catalog images without the
reseller's OK), and use the Polish Pickup roster to batch the next indie outreach. That order
gets about 3,000 new lacquer shades from two sources (30% of the target; lacquer-only reaches about
5,200 by the end of Q1 and passes 10k only with the gel lines or 60+ more indie permissions), brings in
ILNP and KBShimmer without their cooperation, and
keeps every major's own storefront untouched. The affiliate route is the follow-up for GTINs and
retail prices, not the first move.

## 2. Where the catalog stands

- **Enabled sources today** (`docs/seed_data_sources.sql` and the migrations through
  `20261023021845964`): Holo Taco (own connector) and 30 Shopify stores through `shopify-generic`
  (Mooncat, Dam, Orly, Bee's Knees, Great Lakes, Kathleen & Co, Prism Parade, Sassy Sauce, Color
  Club, Rogue, Red Eyed, Cupcake, Loud Babbs, Paint It Pretty, China Glaze, Le Mini Macaron, Cracked,
  Olive Ave, Lights, Zombie Claw, Starrily, Tyler Strinkets, Drunk Fairy, Night Owl, Pahlish, Emily
  de Molly, Cirque Colors, Stella Chroma, Lemming Lacquer, Sweet & Sour), plus OpenBeautyFacts and the
  non-catalog rows (ManualEntry, UserCapture, CosIng, the two affiliate placeholders). Disabled:
  MakeupAPI (frozen 2015 data), Clionadh and Garden Path (password-locked), Roylalee (empty),
  Potion Polish (moved to Big Cartel), GS1, openFDA.
- **Majors already covered through their own Shopify stores:** Orly (`OrlyShopify`), China Glaze
  (`ChinaGlazeShopify`), Color Club, Le Mini Macaron. All four were enabled before decision D2 with
  no written OK on record (same as Mooncat and Cupcake).
- **Catalog size:** not measured here. The dev Postgres was not running during this evaluation and
  the production count needs the Admin console; `docs/retro-m2.md` still carries the TODO to
  record the 2026-10-17 baseline. The batch-3 local run added 247 shades; batch 2 about 316 Cirque
  shades; the roadmap target is +10k active shades by 19 Dec 2026.
- **What the pipeline already does well:** one connector per Shopify store, per-store filters for
  stores whose `product_type` is unusable, product-category classification, text-derived finishes,
  thumbnails, galleries, buy links with list price, barcode rows from variant barcodes, AI hex
  detection. A new source that is a Shopify store costs a `data_source` row, optionally a store
  filter, and the owner's approval step. Anything that is not Shopify needs a new connector.

## 3. The landscape, tier by tier

### 3.1 Mass-market and professional majors

Owners and shade counts are from public sources; platform, feed and terms were probed on 2026-11-08
(§8). "Shopify clause" = the Shopify default terms template, whose prohibited uses include
"to spam, phish, pharm, pretext, spider, crawl, or scrape", the wording the indie survey treated as a
blocker without a written OK.

| Brand | Owner | Lacquer catalog (public claims / observed) | Own site: platform and feed | Terms / robots | Also sold by | Verdict |
|---|---|---|---|---|---|---|
| **OPI** | Wella | Sitemap lists 411 `nail-lacquer-*`, 162 `infinite-shine-*`, 232 dip product URLs (1,524 product URLs in all); retail sources quote 200–250 current lacquer shades | Custom (not Shopify); `sitemap.xml` is a flat URL list; product pages carry JSON-LD `Product` with `gtin` and `sku` (e.g. GTIN 4064665004236) | robots.txt allows `/`, disallows `/en-us` and `*bvstate=`; terms page not found at `/terms-of-use` | Beyond Polish (1,160 lacquer-line listings: 493 Nail Lacquer, 315 Infinite Shine, plus GelColor/dip), Sally Beauty, Ulta, Amazon | Reseller route first; a sitemap + JSON-LD connector is technically easy but needs OPI's OK |
| **essie** | L'Oréal | Site sitemap lists 156 `nail-polish/enamel/<family>/<shade>` pages; the brand claims "over 1,000 shades" historically | Sitecore site; robots disallows `*/api/*`, `*color-family=*`, `*finish=*`; terms page is JS-rendered (could not be read) | — | Beyond Polish (118 lacquer listings), Ulta, Target, Amazon | Reseller route; own site not worth a connector |
| **Sally Hansen** | Coty | Line pages (Pure, Xtreme Wear, Miracle Gel, Insta-Dri…) list shades inside the page; no per-shade URLs in the 143-URL sitemap, no JSON-LD | Custom; `/en-us/` tree | robots allows `/` | Ulta, Walgreens, Amazon; not at Beyond Polish | Retail affiliate feed only (drugstore brand) |
| **Zoya** | Art of Beauty | ~400 shades (press) | `zoya.com` → `zoya.artofbeauty.com`, Art of Beauty's own storefront; sitemap lists category/collection pages, not shades | robots allows most; no terms clause found | Beyond Polish (262 lacquer listings), Ulta | Reseller route |
| **CND** (Vinylux, Shellac) | Revlon | Vinylux lacquer line | **Shopify**, `products.json` open; 117 products, `product_type` empty on 111 (Shellac and Vinylux mixed) | No terms page at `/policies/terms-of-service` (404); robots allows | Beyond Polish (159 lacquer-typed listings), Sally Beauty | Ask CND for the record; needs a store filter (empty types); or reseller route |
| **Orly** | Orly | enabled source already | Shopify | — | Beyond Polish (255) | Done |
| **China Glaze** | AII | enabled source already | Shopify | — | Beyond Polish (102) | Done |
| **Color Club** | Forsythe | enabled source already | Shopify | — | Beyond Polish (80), Harlow & Co (61) | Done |
| **butter LONDON** | Astral Brands | 41 "Nail Polish" products on the first page (185 products, cosmetics too) | **Shopify**, `products.json` open | **Own clause**: no "software robots, spiders, crawlers, or similar data gathering" | Beyond Polish (66) | Reseller route; written OK needed for the brand store |
| **Deborah Lippmann** | — | 25 "Nail Polish" + 14 sets + 7 treatments (54 products) | **Shopify**, `products.json` open | **No automated-access clause** (6,300-char terms) | Beyond Polish (38 across two vendor spellings) | Enable like Night Owl (ask for the record) |
| **Londontown** | — | 68 "Nail Color" + 65 gels + 39 sets on the first page (250+ products) | **Shopify**, `products.json` open | **No automated-access clause** | Beyond Polish (141) | Enable like Night Owl; store filter for sets/gels |
| **Ella+Mila** | — | 162 "Nail Polishes" on the first page (250+ products) | **Shopify**, `products.json` open | **Own clause**: automated access only for search engines that honour robots.txt | Beyond Polish (142) | Reseller route; written OK for the brand store |
| **Morgan Taylor** (lacquer sister of Gelish) | Nail Alliance | ~200 shades | gelish.com custom (no feed); morgantaylor.com did not answer | — | Beyond Polish (205) | Reseller route only |
| **Dazzle Dry** (83 lacquers + 61 minis on page 1), **Sundays** (94 products, types empty), **JINsoon** (135, 15 typed), **Tenoverten** (28 polishes) | various | 30–150 each | **Shopify** open | Shopify clause | Beyond Polish carries Sundays (49) | Written OK round (S2) |
| **Côte** (66 "Nail Polishes"), **Olive & June** (28 polish + 20 gel + press-ons), **Piggy Paint** (24 polishes), **Manucurist** (68 Green vernis, FR) | various | 25–70 each | **Shopify** open | **No automated-access clause** | — | Enable like Night Owl (ask for the record); small catalogs |
| **Static Nails** (70 "Liquid Glass Lacquer"), **Pacifica** (polish inside a 250+ cosmetics catalog), **Revlon** (makeup store; polish not on page 1), **wet n wild** (no clause; polish not on page 1), **Pear Nova**, **Mischo** (no answer) | various | 20–70 polish each | Shopify open (Static Nails, Pacifica, Revlon, wet n wild) | Static Nails, Pacifica, Revlon: own "robots, spiders, crawlers" clause; wet n wild none | Beyond Polish carries Static Nails (33) | Low priority: small polish share of a cosmetics store |
| **Barry M** (UK: 106 "Nail Paint" on page 1 of 250+, no terms page at the Shopify path), **Nailberry** (71 L'Oxygéné, Shopify clause), **Mavala** (19 polishes; terms page answered 500, so its terms are unknown), **Nails.INC** (Shopify, terms forbid copying: Oct survey), **Ciaté** (custom site), **Essence** (Shopify, `products.json` answers HTML), **KIKO** (Shopify, `products.json` 404) | various | 20–300 each | mixed (appendix A) | mixed | European retailers | Europe is a second phase; Barry M and Mavala are the easy ones |
| **Sinful Colors**, **Maybelline** (drugstore) | Revlon, L'Oréal | 30–100 each | corporate sites, no feeds (Sinful Colors `products.json` 404) | — | Walgreens, Target, Amazon | Affiliate / barcode-learning only |
| **DND**, **Kiara Sky**, **Gelish/Harmony**, **Madam Glam**, **Aprés**, **The GelBottle**, **Daily Charme**, **Kokoist** (gel systems) | various | 300–1,000 each | DND: Shopify open | — | Beyond Polish (5,577 gel listings in all) | **Scope question**: gel polish is not in the catalog today (see §6, decision 3) |

### 3.2 Boutique and indie-major brands

| Brand | Own store | Status | Reseller coverage (listings, 2026-11-08) |
|---|---|---|---|
| **ILNP** | WooCommerce, `/wp-json/` and `/wc/store/v1/` disallowed in robots.txt; wholesale page exists | Closed at the source (survey batch 2) | Harlow & Co **605** (573 color), Hypnotic Polish **308**, Beyond Polish 0 |
| **KBShimmer** | WordPress, Cloudflare challenge on every path | Closed at the source | Harlow & Co **260**, Beyond Polish **233** (217 color), Hypnotic 110, Polish Pickup (3 this month) |
| **Holo Taco** | Shopify, own connector | Enabled | — |
| **Mooncat** (Live Love Polish redirects here) | Shopify | Enabled | Hypnotic 3 |
| **Cirque Colors** | Shopify + store filter | Enabled | Beyond Polish 244, Harlow 238, Hypnotic 201 |
| **Emily de Molly** (AU) | Shopify | Enabled | Hypnotic 58, Harlow 40 |
| **Cadillacquer** (DE) | `cadillacquer.com` did not answer (DNS/TLS) on 2026-11-08 | Unreachable | Hypnotic **40** |
| **Clionadh** (CA) | Shopify, password-locked | Registered, disabled | Polish Pickup (1) |
| **Painted Polish** | Big Cartel in Oct; `products.json` 404 now (platform may have changed, appendix) | Not a source | Polish Pickup (1) |
| **Polished for Days**, **Cuticula**, **Cosmic Polish**, **Starrily**, **Bee's Knees**, **Glisten & Glow** | Starrily, Bee's Knees enabled; others see appendix | mixed | Harlow: Polished for Days 59; Hypnotic: Cuticula 68, Cosmic 73, Bee's Knees 49, Starrily 49, Glisten & Glow 9 |
| **Girly Bits**, **Fair Maiden**, **Tonic**, **Bluebird**, **Baroness X** | Tonic/Bluebird/Baroness X: Shopify password page (401); Girly Bits 503; Fair Maiden 530 (survey) | Unreachable | Baroness X: Polish Pickup (2) |
| **Picture Polish**, **Femme Fatale**, **Celestial**, **Powder Perfect**, **Glam Polish** (AU) | appendix | — | Hypnotic: Picture Polish 1; Harlow: 2 |
| **Masura**, **Dance Legend** (RU) | appendix | — | Hypnotic: Masura 1 |

### 3.3 Indie makers: the Polish Pickup roster

Polish Pickup (polishpickup.com, Shopify) is the monthly indie pre-order shop (first Friday to Monday
of each month; the November 2026 "Antiques & Oddities" round was open on 2026-11-08). Its
`products.json` listed **92 products from 76 vendors** (70 `PPU`, 16 `IPU` "Indie Pickup", 4
merchandise, 1 hand & nail, 1 gift card). The generic gate accepts **5 of 92** (only coats and a
treatment, because `product_type` is `PPU`/`IPU` and the tags do not say polish), so the shop itself
needs a store filter before it is a usable source, and its terms carry the Shopify clause. Even then
it only ever lists this month's products: one shade per maker per month, gone when the window closes.
Its value is the **roster**:

- **Already sources (20 of 76):** enabled: Bee's Knees, Cracked Polish, Cupcake Polish, Dam Nail
  Polish, Emily de Molly, Kathleen & Co, Lemming Lacquer, Night Owl Lacquer, Pahlish, Paint it Pretty
  Polish, Prism Parade, Red Eyed Lacquer, Rogue Lacquer, Sassy Sauce Polish, Stella Chroma, Sweet &
  Sour Lacquer, Zombie Claw (17); registered but disabled: Clionadh, Garden Path Lacquers, Royla Lee
  (Roylalee).
- **Known from the October survey, blocked or declined so far:** Painted Polish, Glisten & Glow,
  Colores de Carol (Big Cartel behind Cloudflare), Moon Shine Mani and Dreamland Lacquer (Shopify,
  open, scraping clause in Oct), KBShimmer, Baroness X (password page), Cadillacquer (site down).
- **New names worth a look (not in the repo, not surveyed before):** 1422 Designs, Ahmya Cosmetics,
  Alchemy Lacquers (Shopify open, appendix), All Mixed Up Lacquers, Arcana Lacquer, BCB Lacquers,
  Beaux Rêves Lacquer, Broken Pixel Polish, By Dany Vianna, Cameo Colours Lacquers, Chamaeleon Nails,
  Cuticula, Danglefoot Nail Polish, DRK Nails, Envy Lacquer, Fancy Gloss, Haunted Polish, Hearts &
  Promises, Hit the Bottle Polishes, Humble Bee, Indie by Patty Lopes, Jen & Berries, Jior Couture,
  Lumen, Lurid Lacquer, LynBDesigns, ManMade by J&S, MJ Lacquer, Monarch Lacquer, Moth & Moon, Nailed
  It, Nothing Basic, Off the Hook Creations, Paradox, Penelope Luz, Phoenix, PI Colors, Pinnacle
  Polish, Polished For Days, Psyche Minerals, Raven Lacquer, Ribbits (decals), Sassy Cats Lacquer,
  sylvanclaw, Unicorn Magic Skincare (not polish), Vibrant Scents (coats).

Most of these makers are small (20–150 shades) and most run Shopify stores with the default terms.
The October experience (three written permissions from one email round) says the ask works; the
roster is the mailing list. Expected yield at the October rate of about half the makers agreeing:
40 emails → ~20 makers × ~60 shades ≈ **1,200 shades**, in return for 40 emails and 10–20 store
filters. That is an eighth of the target for a lot of handling, which is why it is strategy S3 and
not S1.

### 3.4 Multi-brand resellers

Resellers are the finding of this evaluation. One Shopify storefront, one `data_source` row, and the
`vendor` field names the brand.

| Reseller | Country / currency | Platform | Products (pages) | Vendors | Generic gate accepts | Headline brands (accepted listings) | Terms | Verdict |
|---|---|---|---|---|---|---|---|---|
| **Beyond Polish** (beyondpolish.com) | US / USD | Shopify, `products.json` open, 71 pages of 250 | **17,508** | **103** | 9,395 (4,138 on lacquer-typed products: 4,022 color + coats) | OPI 1,857 (1,160 lacquer-line), DND 714, Kiara Sky 527, CND 470, Madam Glam 451, Harmony 373, Orly 285, Zoya 267, Cirque 248, KBShimmer 233, Morgan Taylor 210, Londontown 158, essie 149, Ella+Mila 145, Color Club 116, Loud Lacquer 108, China Glaze 108, butter LONDON 79, Cracked 57, Sundays 53, Lippmann 45, Static Nails 38 | **Own terms, no automated-access clause** (only "harvesting personal data from other users"); robots.txt Shopify default (`/products/` allowed, `products.json` not disallowed) | **Best single source.** Needs a reseller store filter (§4, S1); **registered (Task 7)** |
| **Harlow & Co** (harlowandco.org; the `.ca` domain redirects) | Canada / CAD | Shopify, 7 pages | **1,537** | 22 | **1,282** | ILNP 605, KBShimmer 260, Cirque 238, Color Club 61, Polished for Days 59, Emily de Molly 40, I Scream Nails 10 | **Own short terms (4,900 chars), no automated-access clause** | **Second source: ILNP + KBShimmer.** `product_type` is clean ("Nail Polish"); the generic gate already works; **registered (Task 6)** |
| **Hypnotic Polish** (hypnoticpolish.com) | EU / EUR (Bancontact, iDEAL) | Shopify, 4 pages | 998 | 16 | 977 | ILNP 308, Cirque 201, KBShimmer 110, Cosmic Polish 73, Cuticula 68, Emily de Molly 58, Bee's Knees 49, Starrily 49, Cadillacquer 40 | Shopify clause | Third: needs a written OK; adds Cadillacquer, Cosmic, Cuticula and EUR prices. **Registered pending (Task 8):** disabled, `pendingApproval`, store filter and fixture in place; the owner's email (spec §7) is the next action |
| **Ninja Polish** (ninjapolish.com) | US | Shopify | 126 | 11 (`Various`, `My Online Shop`, Messy Mansion, DRK Nails…) | — | mostly stamping | No clause, but terms say no reproduction without consent (survey) | Low value |
| **Color4Nails** (color4nails.com) | US | behind Cloudflare challenge (403) | — | — | — | ILNP, KBShimmer, indies (reputation) | — | Unreachable |
| **Nail Polish Canada** (nailpolishcanada.com) | — | no DNS answer | — | — | — | — | — | Gone |
| **Rainbow Connection** (rainbowconnection.co.uk) | — | domain for sale | — | — | — | — | — | Gone |
| **Sally Beauty**, **Ulta**, **Sephora** | US | enterprise | — | — | — | OPI, essie, Zoya, CND, Orly, Sally Hansen… | affiliate programs | §3.5 |

What a reseller record looks like (Beyond Polish, OPI): title `OPI Nail Lacquer - No Room for the
Blues 0.5 oz - #NLB83`, `product_type: Nail Lacquer`, vendor `OPI`, tags `Blue`, `Creme`, `OPI Nail
Lacquer`, `Discontinued`, `Size: 0.5 oz`, `Group: …`, one variant with SKU `OPIL-NLB83` and price,
three images, **no barcode**. Zoya: a 12-piece collection is one product (`Zoya - Sonnet Fall
Collection`, tag `Nail Set`, 14 images) that the current set rule does not catch because the title has
" - " parts. So the reseller filter has to: split the title into brand line, shade name and vendor
code; drop `Nail Set` / `TIER COMBO` products; keep `Discontinued` ones (collectors own them); and
decide what to do with gel lines (§6).

### 3.5 Retailers via affiliate feeds

Unchanged in substance from `data-sources-research.md` §5, with these 2026-11-08 checks:

- **Sephora** runs its program on Rakuten Advertising (its affiliate page says so). Rakuten's product
  feed spec is the Google product feed format: `id`, `title`, `description`, `link`, `image_link`
  (600×600 min), `price`, `brand`, **`gtin` required** (UPC-12 in North America). Access is two-step:
  Rakuten approves the publisher for feeds, then each advertiser approves the publisher. Delivery
  formats are CSV/TSV (zip/gz).
- **Ulta**: its affiliate page was behind a maintenance placeholder; secondary sources disagree on
  the network (Rakuten vs Impact). **Sally Beauty**: its `/affiliate-program/` page is gone (410).
  Both need a direct enquiry.
- **Amazon**: PA-API 5 "has been deprecated and is being replaced by the Creators API" (Amazon's
  own notice); access needs an Associates account and the separate API agreement; secondary sources
  describe a minimum-sales rule. Beauty catalog data is reachable only that way.
- **Beyond Polish** itself is on FlexOffers / Rakuten / Sovrn (Feb research), so its feed is also
  available the affiliate way, *with* GTINs if the feed follows the Google spec. That is the way to
  get the barcodes its `products.json` lacks.

What the affiliate route gives that nothing else does: GTINs for the majors (the barcode scanner
today resolves only what connectors and users have learned), retail prices, and a sanctioned link.
What it costs: an affiliate account per network, disclosure in the UI (`applyAffiliateParams()` is
the hook, #267 kept it empty on purpose), per-advertiser approval that a pre-launch app may not get,
and a feed-file connector (CSV, not JSON). Roadmap §2 explicitly keeps affiliate storefronts out of
the Oct–Dec window; this evaluation agrees it is the second phase.

### 3.6 Open and community data

| Source | 2026-11-08 state | Use |
|---|---|---|
| Open Beauty Facts | `category/nail-polishes` holds **137** products; API and dumps are open (ODbL) | Barcode → name for the few it has; contribute back the GTINs users teach us (ODbL share-alike only applies to the OBF data itself) |
| Lacquer Tracker | Live; "over 17,000 nail polish colors, tools, and accessories"; no API, no export | Not a source. The roadmap's "went dark in early 2025" note is wrong as of today; it is up and accepting sign-ups |
| Temptalia, Cosmetic Sanctuary and other swatch blogs | Editorial; Cosmetic Sanctuary covers every Polish Pickup round with maker lists | Reference and outreach research only |
| User capture (`UserCapture`) | Every unknown barcode a user scans is learned privately (`user_shade_barcode`); user-created shades go through the admin review queue | Already the long-tail route; the review queue is the promotion path |
| GS1 / UPCitemdb / Barcode Lookup | Unchanged (Feb research): 100 lookups/day free tiers | Enrichment on demand, not bulk |
| Wikidata, FDA MoCRA, EWG | No shade-level data (Wikidata), no public API (MoCRA), no API (EWG) | Not catalog sources |

## 4. Ingestion strategies

Each strategy says what it needs from the code, what it needs from people, what it yields against
the +10k target, and what can go wrong.

### S1 — Reseller mode for the generic Shopify connector (Beyond Polish, Harlow & Co)

**What.** Ingest a multi-brand Shopify store as one `data_source`, with the product's `vendor` as
the brand (the connector already does this: `resolveShopifyVendor` falls back to the source brand only
when the vendor is a placeholder) and a *reseller* store filter in `connectors/store-filters/`.

**Code.**
- A `beyond-polish.ts` store filter: keep `product_type` in {Nail Lacquer, Gel & Lacquer Polish,
  Lacquer & Dip, Gel, Lacquer & Dip} (and Gel Polish only if decision 3 says gel is in scope); drop
  tags `Nail Set`, `TIER COMBO`, `Kit`, and every non-polish `product_type` (Hair, Body & Skin,
  Rings…); a title parser for `Brand - Line - Shade size - #CODE` (vendor code into
  `external_product.normalized_json` and a shade alias, so a scanned OPI bottle whose label says
  NLB83 can match by code); `Discontinued` kept, flagged in `normalized_json`.
- A `harlow-and-co.ts` filter is optional: its `product_type` is "Nail Polish" on 1,281 products
  and the generic gate already accepts 1,282 of 1,537.
- Catalog size: `fetchAllProducts` in `shopify-generic.ts` stops after `MAX_SHOPIFY_PAGES` = 30 pages
  of 250, and Beyond Polish has 71. The limit becomes an env setting with a per-source override
  (`data_source.metadata.maxPages`) before the first run; otherwise an exhaustive job silently drops
  the last 10,000 products before filtering.
- Shade identity: the same shade will arrive from Beyond Polish *and* from the brand's own store
  (Orly, China Glaze, Color Club, Cirque, Cracked, KBShimmer via Harlow). Materialization matches a
  shade on brand + name **+ `finish` + `collection`** (the first `finish:` tag and the first
  `collection:` tag), so a reseller record with different tags creates a second shade even when the
  title is clean. A reseller source therefore needs (a) the title parser for the name, (b) empty
  `finish` / `collection` on its records, and (c) a fallback match on brand + name alone that adopts
  the brand store's shade (link the listing, fill only empty data, never overwrite). Run the dedupe
  audit after the first ingest.
- Images: reseller product photos are often the brand's own press shots, but the reseller's OK is
  needed before storing them. The materializer has no image switch today (it prepares and uploads
  source images even with hex detection off), so a source-level `imagesPermitted` setting that skips
  image preparation entirely is a prerequisite, built and tested before the first reseller run; until
  the OK is on record the shade carries `name_hex` only (display shows "Estimated color"). The
  reseller's OK can include images; the brand's cannot be assumed.
- Buy links: `productUrl` goes to the reseller, not the brand. `selectBuyFromBrandLink` picks one
  product deterministically; add a source-priority rule (brand store before reseller) so an Orly
  shade keeps its orly.com link.
- Prices: `pickShopifyVariantPrice` and the store currency logic already work (USD at Beyond
  Polish, CAD at Harlow, EUR at Hypnotic); per-currency totals already exist (#267, #437).

**People.** One email each to Beyond Polish and Harlow & Co (template in §7). Their terms do not
forbid it; the email is the paper trail decision D2 asks for.

**Yield.** Beyond Polish lacquer-typed: ~3,070 color shades (OPI ~800 across Nail Lacquer and
Infinite Shine, Zoya ~260, Orly ~250, Morgan Taylor ~200, CND ~150, Londontown ~140, Ella+Mila ~140,
essie ~120, China Glaze ~100, Color Club ~80, butter LONDON ~65, Sundays ~50, Loud Lacquer ~100,
KBShimmer ~220, Cirque ~240, Cracked ~45, Lippmann ~40, Static Nails ~25, Peacci ~45) minus the overlap
with existing sources (Orly ~250, China Glaze ~100, Color Club ~80, Cirque ~240, Cracked ~45 ≈ 715; Loud
Lacquer is not Loud Babbs) ≈ **2,350 new shades**; with gel in scope another ~4,000. Harlow & Co, counting
KBShimmer once (at Beyond Polish): ILNP ~570 color + Polished for Days ~55 + I Scream Nails ~10 ≈ **635
new**. Together **~3,000 new lacquer shades from two sources**, 30% of the target, or 70% with gel.

**Risks.** Title noise and duplicates (mitigated by the parser and the audit); reseller stock churn
(Beyond Polish lists `Discontinued` and `CLEARANCE`, which is a feature for collectors); a reseller
asking us to stop (then disable the source: the catalog rows and listings stay, and disabling alone keeps
its stored images; they are removed by the admin job `POST /api/images-admin/source-images/remove`, run as
`npm run remove:source-images -- --source <name> --write` or from the admin Backfills tab, "Remove a
source's images", which refuses an enabled source and keeps hex-labeled images); gel lines flooding color search if decision 3 is "no" and the filter is wrong.

### S2 — Brand stores on Shopify: enable the clause-free ones, ask the others

**What.** The probe (appendix A) found 33 brand stores with `products.json` open. Split them by terms:

- **No automated-access clause** (enable the way Night Owl was enabled under D2, and email for the
  record): Deborah Lippmann (25 polishes), Londontown (68 + gels), Côte (66), Manucurist (68, FR),
  Olive & June (28 + gel), Piggy Paint (24), wet n wild (polish share unknown), and the indies
  Alchemy Lacquers (198 "Nail Lacquer"), Penelope Luz (216 products, types empty), Noodles (57).
  CND (117, types empty) and Barry M (106 "Nail Paint" on page 1) have no terms page at the Shopify
  path, and Mavala's (19 polishes) answered 500: their terms are unknown, so they wait for the
  owner to read the site terms (or for a written OK) before activation.
- **Shopify default clause** (written OK first, as in October): Dazzle Dry, Sundays, JINsoon,
  Tenoverten, Nailberry, DND (gel), Glam Polish (AU), Nail Hoot, Moon Shine Mani, FUN Lacquer,
  Anchor & Heart.
- **Own clause forbidding robots/spiders/crawlers** (written OK, lower odds): butter LONDON,
  Ella+Mila, Kiara Sky (gel), Static Nails, Pacifica, Revlon, Modelones, Dreamland, Ethereal.

**Code.** A `data_source` row each; store filters where `product_type` is empty or odd (CND,
Sundays, JINsoon, Penelope Luz, Noodles, Moon Shine Mani, Nail Hoot, Glam Polish) and where sets,
gels or cosmetics share the catalog (Londontown, Olive & June, Pacifica, Revlon, wet n wild).

**People.** One email per brand. Majors answer slowly or not at all (a legal or marketing team, not
an owner); expect 20–30% from them versus three of three from the indie round.

**Yield.** Clause-free group ≈ **700 shades** (Londontown ~70, Côte ~66, Manucurist ~68, Lippmann
~25, Olive & June ~28, Piggy Paint ~24, Alchemy ~200, Penelope Luz ~150, Noodles ~57) plus CND
(~150 Vinylux), Barry M (~200) and Mavala (~19) if their terms allow; clause group ≈ **500** (Dazzle Dry ~140,
Sundays ~90, JINsoon ~115, Tenoverten ~28, Nailberry ~70, Glam Polish ~185, Nail Hoot ~128, Moon
Shine ~199 → the last three overlap Polish Pickup makers). Most of the majors here are also at
Beyond Polish, so S2 is as much about brand-direct images and buy links as about shades.

### S3 — Polish Pickup roster outreach (indie long tail)

**What.** Use the 76-maker roster (§3.3; refreshed each month from `polishpickup.com/products.json`,
one request) as the outreach list, 10 makers per batch, with the survey method (robots, terms,
`products.json?limit=1`) before each email. Register approved stores in
`SHOPIFY_SOURCES_PENDING_APPROVAL` as today.

**Code.** A `polish-pickup.ts` store filter if the shop itself is wanted as a source (keep `PPU`/`IPU`
unless the title says scrub, wax, lotion, decals, sticker, magnet; vendor is the maker): it adds this
month's ~70 shades and, over a year, ~800, with the maker as brand. Worth doing only once the makers
themselves say yes, since each shade also appears in the maker's own store.

**Yield.** ~1,200 shades over four rounds of 10 emails if half the makers agree (~300 per round).
Only the first round, and the December Polish Pickup window, fall before 19 Dec; rounds 2–4 are
Q1 2027 work.

### S4 — Sitemap + JSON-LD connector for brand sites without a feed (OPI, and any brand on a
custom platform)

**What.** A connector that reads `sitemap.xml`, filters product URLs by prefix (`/products/nail-lacquer-`,
`/products/infinite-shine-`), fetches each page and parses the JSON-LD `Product` (name, brand, sku,
**gtin**, image, offers). OPI's pages carry exactly this. The same connector would serve any brand
that publishes JSON-LD, which is most enterprise sites (essie does not: Sitecore with the API paths
disallowed).

**Code.** New connector (`sitemap-jsonld.ts`, ~400 lines on the pattern of `shopify-generic.ts`),
per-source URL prefixes in `data_source.metadata`, 1 request per product per run (OPI: ~570
lacquer pages; cache by `lastmod`).

**People.** OPI's OK. Its terms page was not found at the usual path, so the terms are unknown; a page
crawl of a Wella brand without an OK is the one thing this evaluation would not do.

**Yield.** OPI ~570 lacquer shades **with GTINs**; the GTIN is the reason to want this even though
Beyond Polish has the shades.

### S5 — WooCommerce Store API and Big Cartel connectors

**What.** `GET /wp-json/wc/store/v1/products` is public by default on WooCommerce (name, permalink,
prices, images, sku, `has_options`; filter by category/tag) and Big Cartel's read-only v0 API
(`api.bigcartel.com/{subdomain}/products.json`: name, permalink, price, images, options, categories,
no auth, deprecated but stable) covers Big Cartel stores.

**Findings.** Nothing in the probe makes either worth building yet: ILNP and KBShimmer disallow or
block the Store API; the Big Cartel indies found (Painted Polish, Potion Polish, Colores de Carol) are
small, and Painted Polish's `products.json` answered 404 on 2026-11-08 (platform change?). Build a
WooCommerce connector only when a brand with a Woo store says yes (the appendix lists which probed
domains answered the Store API).

### S6 — Affiliate product feeds (Rakuten, Impact, Amazon Creators API)

**What.** A feed-file connector (CSV/TSV in Google product feed format: `id`, `title`, `brand`,
`gtin`, `image_link`, `link`, `price`, `availability`) fed from the networks' catalog downloads;
`applyAffiliateParams()` populated; affiliate disclosure in `BuyFromBrandLink`.

**People.** Affiliate accounts (Rakuten for Sephora and Beyond Polish; Ulta and Sally Beauty to be
asked which network); each advertiser approves the publisher; a pre-launch app with no traffic may
be declined. Amazon needs an Associates account and the Creators API agreement.

**Yield.** The majors with **GTINs and retail prices** (OPI, essie, Zoya, Sally Hansen, CND, Orly at
Sally Beauty/Ulta; prestige brands at Sephora: Chanel, Dior, Gucci, Tom Ford, Hermès are *only*
reachable this way). Shade counts overlap S1; the new information is barcodes and prices.

**When.** Phase 2 (Q1 2027), consistent with roadmap §2 and §5.

### S7 — Brand-supplied feeds ("send us your Google Shopping feed")

**What.** Every Shopify, WooCommerce, Wix and Squarespace store can export a Google Merchant feed
(the same format S6 reads). Asking a brand for its feed URL is platform-independent, needs no
scraping consent discussion, and comes with `gtin`, `brand`, `color`, `image_link`, `price` and
`item_group_id`. Build the S6 feed connector once and both routes use it.

**People.** The same email as S2 with one extra sentence. The brands most likely to say yes are the
indies that already said yes (ask them for the feed to get barcodes: Stella Chroma, Lemming, Sweet &
Sour, Pahlish, Emily de Molly, Cirque).

**Yield.** No new shades over S1–S3, but GTINs for every participating brand, which is what the
in-aisle barcode scan (roadmap item 5) needs most.

### S8 — User-driven growth and Open Beauty Facts

Already built: private barcode learning, user-submitted shades with the review queue. Two cheap
additions: (a) promote a `user_submitted` shade with ≥ N distinct owners automatically to the review
queue's top; (b) push learned GTIN → brand/name pairs to Open Beauty Facts (ODbL, write API with an
account), so the next scan of a drugstore bottle resolves for everyone. Yield is slow but it is the
only route to the drugstore brands (Sally Hansen, Revlon, wet n wild, Sinful Colors) without affiliate
feeds.

### Strategies considered and set aside

- **Scraping brand sites without an OK**: not done in October, not proposed now.
- **Temptalia / Lacquer Tracker data**: single-operator and community sites with no data licence.
- **Third-party scraper APIs (Apify, Bright Data, Oxylabs) for Sephora/Ulta**: pay-per-record
  copies of retailer catalogs whose terms forbid it; the affiliate feed is the sanctioned version.
- **MakeupAPI**: frozen 2015 data, already disabled (migration 20261026045216957).

## 5. Recommended order and expected yield

| Step | Strategy | Owner action | Engineering | Expected new shades | Cumulative |
|---|---|---|---|---|---|
| 1 | S1 Harlow & Co | Email for the record; enable | seed row in `docs/seed_data_sources.sql` + `npm run generate:types` (the ingestion API only accepts generated `SUPPORTED_SOURCES`) + migration + `SHOPIFY_SOURCE_BASE_URLS`; the reseller prerequisites above (page limit, identity fallback, `imagesPermitted`); run; audit duplicates | ~635 (ILNP 570, PfD 55, I Scream Nails 10; KBShimmer counted at Beyond Polish) | 635 |
| 2 | S1 Beyond Polish (lacquer lines) | Email for the record (ask about images and whether a feed with GTINs is available); enable | reseller store filter + title parser + buy-link source priority; `storeImages` off until the OK says images | ~2,350 (3,070 lacquer-typed minus ~715 already held from Orly, China Glaze, Color Club, Cirque, Cracked) | ~2,985 |
| 3 | S3 Polish Pickup round 1 (10 makers, ~5 yes) | 10 emails from the roster | 2–5 store filters | ~300 | ~3,285 |
| 4 | S2 clause-free brand stores (Lippmann, Londontown, Côte, Manucurist, Olive & June, Piggy Paint, Alchemy, Penelope Luz, Noodles; CND, Barry M and Mavala after a terms check) + S7 feed ask | 12 emails for the record; enable | rows + ~6 store filters; feed connector (shared with S6) | ~700 (≈ 535 new beyond S1: Londontown and Lippmann are also at Beyond Polish) | ~3,820 |
| 4b | S2 clause group (Dazzle Dry, Sundays, JINsoon, Tenoverten, Nailberry, Glam Polish, Nail Hoot, Moon Shine, FUN, Anchor & Heart) | 10 emails, wait for written OK | rows + filters | ~500 | ~4,320 |
| 5 | Decision 3: gel lines at Beyond Polish | decide | filter switch | +4,000 if yes | ~8,320 |
| 6 | S3 rounds 2–4 (Q1 2027: one round per Polish Pickup month) | 30 emails | filters | ~900 | ~9,220 |
| 7 | S6 affiliate feeds (Q1) | Rakuten/Impact accounts, advertiser approvals | feed connector, disclosure | GTINs + prices for the majors; prestige brands | — |

By 19 Dec (steps 1–4b, assuming the clause-group replies arrive in time) the plan lands near 4,300
new lacquer shades, about 8,300 with the gel decision. Lacquer-only reaches about 5,200 by the end of
Q1 once the outreach rounds land; the affiliate feeds add barcodes and prices, not shades. The
lacquer-only +10k therefore needs decision 3 (gel) or 60+ more indie permissions (or further
retailers), neither of which fits by December. The 19 Dec target was set when the indie route was
the only one; the honest read is that the resellers get the catalog to where it matters for users
(the majors collectors actually own) in two sources.

## 6. Decisions for the owner

1. **Reseller sources (S1).** Approve asking Beyond Polish and Harlow & Co, and ingesting with
   images off (the new `imagesPermitted` setting) on a plain "no objection" and images on only on an explicit OK. Their terms do
   not require the ask; D2 does.
2. **Buy-link priority.** When a shade has a brand-store listing and a reseller listing, the brand
   store wins the buy link (recommended); otherwise the newest `last_seen_at` wins as today.
3. **Gel polish in scope?** Beyond Polish's 5,577 gel listings (OPI GelColor 647, DND, Kiara Sky,
   Gelish, Madam Glam, Aprés, The GelBottle) would double the catalog. The data model has no
   lacquer/gel distinction (`product_category` is about product kind, finishes about look). Options:
   (a) out of scope, filter them out (recommended for now: the collector research in roadmap §2 is
   lacquer-centric, and gel shades would pollute dupes and color search for lacquer collectors);
   (b) in scope with a new `shade.system` column (`lacquer | gel | dip`) and a filter chip; (c) in
   scope as a finish family. (b) is the right shape if ever; it is a migration plus UI on three
   surfaces and is not December work.
4. **Discontinued listings.** Keep (recommended: collectors own them; Beyond Polish marks them with a
   tag, store the flag in `normalized_json` for a future "discontinued" badge) or drop.
5. **Affiliate programme.** Whether to open Rakuten/Impact accounts in Q1 (needed for S6; implies
   the disclosure UI and `applyAffiliateParams`). Roadmap §6 decision 5 territory.
6. **Polish Pickup as a source of its own** (one shade per maker per month) or roster only.

## 7. Outreach template (reseller and brand)

Subject: *SwatchWatch — reading your product catalog for a nail polish collection app*

> Hi <name>, I run SwatchWatch, a free collection manager for nail polish collectors (web and iOS,
> github.com/mattmck/swatchwatch). We help people see what they own, avoid buying dupes, and find
> where to buy a shade — every shade links back to the store that sells it, with no affiliate
> parameters. I'd like to read your public product listing (`<store>/products.json`, about once a
> day, a few hundred requests, identified as `SwatchWatch/connector-ingestion`) to list the brands
> and shades you carry, with your listing as the "buy" link and your list price. Two questions:
> (1) is that OK with you, and (2) may we show your product photos as the shade's picture (credited
> and linked), or should we show only a color swatch? If you have a Google Shopping / Merchant feed
> URL with barcodes, that is even better than products.json for us. We'll stop at any time on request.
> Thanks, Matt

Record the reply in `data_source.metadata.notes` with the sentence the October survey prescribes
("Acceptable use confirmed by <name, role> at <store> on <date> via <email>: <summary>") and the image
answer separately (`"imagesPermitted": true|false`).

## 8. Method

- **Probe (appendix A):** for each of 113 domains, four requests 1 s apart with the User-Agent
  `SwatchWatch/connector-research (+https://github.com/mattmck/swatchwatch)`: `/products.json?limit=1`
  (Shopify), `/wp-json/wc/store/v1/products?per_page=1` (WooCommerce Store API), `/` (platform
  fingerprint from markup and headers: Shopify CDN paths, `wp-content`, Big Cartel, Squarespace, Wix,
  Magento, Salesforce Commerce Cloud, BigCommerce, Cloudflare challenge), `/robots.txt`. Terms pages
  were read only for stores that answered Shopify JSON, and for the four resellers, by downloading
  `/policies/terms-of-service` once and searching the text for spider / crawl / scrape / robot /
  automated / data mining. A few domains were probed twice because an earlier run of the script was
  not stopped before the second started.
- **Catalog pulls:** the full `products.json` (250 per page, 1.5 s apart) was downloaded for Beyond
  Polish (71 pages), Harlow & Co (7), Hypnotic Polish (4) and Polish Pickup (1), then run through
  this branch's `classifyIngestedProduct` + `isBundle` (the generic connector's gate, no store filter)
  from the worktree source with `tsx`. Images were not downloaded. No other store's catalog was
  pulled in full.
- **Sitemaps:** `opi.com/sitemap.xml` (1,898 URLs, 1,524 under `/products/`), essie's child sitemap
  (395 URLs), `sallyhansen.com/sitemap.xml` (143), Zoya's (category pages). One OPI product page was
  fetched to confirm JSON-LD.
- **Web research:** market reports (no reliable brand-share figures; the market-level estimates
  disagree), Rakuten's product feed specification, Amazon's PA-API deprecation notice, Open Beauty
  Facts' category API, Lacquer Tracker's home page, Polish Pickup's shop, Cosmetic Sanctuary's round
  coverage, WooCommerce and Big Cartel API docs.
- **Not done:** no store was contacted; no database was written; the dev Postgres was down so no
  current catalog counts are included; the probe's "Shopify clause" column for brands not yet checked
  was measured for the 33 open Shopify brand stores (appendix A, "Terms" column), not assumed.

## Appendix A — Storefront probe, 2026-11-08

113 domains, four requests each (method in §8). "Shopify, products.json open" means the first page of
`/products.json` answered with Shopify product JSON. The Terms column is filled only for the 33 open
Shopify brand stores that are not sources yet and for the resellers; "Shopify clause" is the default
template's "spider, crawl, or scrape" wording, "custom clause" quotes the store's own sentence, and
"no automated-access clause found" means the terms text was read and none of spider / crawl / scrape /
robot / automated / data mining appeared. The products column is the first page of 250 with the top
`product_type` values, so a brand selling cosmetics shows those too. Domains were guessed from the
brand name; "no answer" can mean a wrong guess, not a dead brand.

| Domain | Tier | Platform / feed | Terms (automated access) | products.json page 1 (product_type) | Note |
|---|---|---|---|---|---|
| barrym.com | major | Shopify, products.json open | terms page 404 | 250 (first page): Nail Paint 106; Lip Liner 19; Glitter and Jewels 15; Lip Paint 14; Eyeliner 9; E |  |
| bornprettystore.com | major | custom (products.json answers HTML) | — | — |  |
| butterlondon.com | major | Shopify, products.json open | custom clause: …use software robots, spiders, crawlers, or similar data gatheri | 185: Nail Polish 41; Lipstick 21; (empty) 11; Lip Gloss 9; Custom Bundle 8; Nail Stre |  |
| ciatelondon.com | major | custom (products.json answers HTML) | — | — |  |
| cnd.com | major | Shopify, products.json open | terms page 404 | 117: (empty) 111; Gel Polish 6 |  |
| coteshop.co | major | Shopify, products.json open | no automated-access clause found | 129: Nail Polishes 66; gift set 11; lip shine 9; treatment 8; body 8; Nail Polish Set |  |
| dazzledry.com | major | Shopify, products.json open | Shopify clause | 250 (first page): Nail Lacquer 83; (empty) 75; Mini Lacquer 61; Mini Flight 10; Mini Nail Lacquer  |  |
| dearsundays.com | major | Shopify, products.json open | Shopify clause | 94: (empty) 89; Custom Bundle 3; Gift Cards 1; Nail Polishes 1 |  |
| deborahlippmann.com | major | Shopify, products.json open | no automated-access clause found | 54: Nail Polish 25; Set 14; Treatment 7; Tools 5; (empty) 3 |  |
| dndgel.com | major | Shopify, products.json open | Shopify clause | 250 (first page): (empty) 239; nondiscount 11 |  |
| ellamila.com | major | Shopify, products.json open | custom clause: …robots.txt file); Accessing or attempting to acces | 250 (first page): Nail Polishes 162; (empty) 44; Nail Sticker 29; Cuticle Cream & Oil 6; Nail Poli |  |
| essence.eu | major | Shopify, products.json 200 | — | — |  |
| essie.com | major | Sitecore; `products.json` 404; sitemap lists 156 enamel shade pages (§3.1) | terms page JS-rendered, not read | — |  |
| gelish.com | major | custom site, no feed found | — | — |  |
| jinsoon.com | major | Shopify, products.json open | Shopify clause | 135: (empty) 115; Nail Polishes 15; Gift Cards 4; tool 1 |  |
| kiarasky.com | major | Shopify, products.json open | custom clause: …use software robots, spiders, crawlers, or similar data gatheri | 250 (first page): HF Gel Polish 149; Fixed Bundle 34; Gel Extensions 34; SERVICE 14; KS Discount 8 |  |
| kikocosmetics.com | major | Shopify, products.json 404 | — | — |  |
| kokistnails.com | major | no answer (DNS/TLS/timeout) | — | — |  |
| lechatnails.com | major | WooCommerce, Store API 500 | — | — |  |
| londontownusa.com | major | Shopify, products.json open | no automated-access clause found | 250 (first page): Nail Color 68; Gels 65; Sets 39; Nail Care 30; Tools 27; Lip Care 6 |  |
| manucurist.com | major | Shopify, products.json open | no automated-access clause found | 250 (first page): Vernis à ongles Green™ 68; Semi-permanent LED Green Flash™ 59; Soins 36; Active  |  |
| mavala.com | major | Shopify, products.json open | terms page 500 | 150: Nail Care 34; Skincare 27; Make-Up 26; Instruments 19; Nail Polish 19; Accessori |  |
| mischobeauty.com | major | no answer (DNS/TLS/timeout) | — | — |  |
| modelones.com | major | Shopify, products.json open | custom clause: …harvest, scrape, crawl or collect information about other u | 250 (first page): PL 212; Gel Polish Set 8; press on nails 5; Top&Base Coat 5; LP1 5; Nail Tools 4 |  |
| morgantaylor.com | major | no answer (DNS/TLS/timeout) | — | — |  |
| nailberry.co.uk | major | Shopify, products.json open | Shopify clause | 133: L'Oxygene 71; Outlet 13; BioGlow 11; Gifts sets 7; Base Coat - Top coat 7; Shop  |  |
| nailsinc.com | major | Shopify, products.json open | — | — | not added: terms forbid copying (Oct survey) |
| oliveandjune.com | major | Shopify, products.json open | no automated-access clause found | 250 (first page): Press-On 51; Tab Press-On 30; Nail Polish 28; Pressies 22; Gel Polish 20; Dip Po |  |
| opi.com | major | custom platform; flat sitemap, JSON-LD `Product` with `gtin` on product pages (§3.1) | terms page not found at `/terms-of-use` | — | S4 candidate |
| orosa.com | major | no answer (DNS/TLS/timeout) | — | — |  |
| pacificabeauty.com | major | Shopify, products.json open | custom clause: …use software robots, spiders, crawlers, or similar data gatheri | 250 (first page): Skin Care 60; Perfume 46; Makeup 33; Haircare 32; Custom Bundle 29; Bundles 19 |  |
| pearnova.com | major | no answer (DNS/TLS/timeout) | — | — |  |
| piggypaint.com | major | Shopify, products.json open | no automated-access clause found | 250 (first page): (empty) 110; Nail Art Kits & Accessories 92; Nail Polishes 24; Wholesale 12; Gif |  |
| revlon.com | major | Shopify, products.json open | custom clause: …You may not use any “deep link,” “page-scrape,” “robot,” “spider” or other automatic devi | 147: Tweezers 11; Eyeliner 8; Eye Shadow 7; Foundation 7; Eyebrow 7; Lipstick 7 |  |
| sallyhansen.com | major | custom; 143-URL sitemap of line pages, no per-shade pages (§3.1) | — | — |  |
| sinfulcolors.com | major | custom site, no feed found | — | — |  |
| smithandcult.com | major | custom (products.json answers HTML) | — | — |  |
| staticnails.com | major | Shopify, products.json open | custom clause: …use software robots, spiders, crawlers, or similar data gatheri | 250 (first page): Reusable Pop-On Manicures® 97; Liquid Glass Lacquer 70; 5-in-1 Rapid Growth Nail |  |
| sundaysnailpolish.com | major | no answer (DNS/TLS/timeout) | — | — |  |
| tenoverten.com | major | Shopify, products.json open | Shopify clause | 79: Nail Polishes 28; Treatment 13; Set 9; Tool 9; Foundation 4; Trio 3 |  |
| wetnwildbeauty.com | major | Shopify, products.json open | no automated-access clause found | 250 (first page): Lip Gloss 39; Foundations & Concealers 31; Lipsticks 28; Lip Oils 18; Blushes &  |  |
| zoya.com | major | → zoya.artofbeauty.com, Art of Beauty's own storefront; sitemap of category pages (§3.1) | — | — |  |
| beyondpolish.com | reseller | Shopify, products.json open | own terms, no clause (§3.4) | — |  |
| color4nails.com | reseller | Cloudflare challenge (403) | — | — |  |
| harlowandco.ca | reseller | no answer; the store is harlowandco.org (Shopify, open) | own terms, no clause (§3.4) | 1,537 products, 22 vendors (§3.4) | → harlowandco.org |
| hypnoticpolish.com | reseller | Shopify, products.json open | Shopify clause (§3.4) | — |  |
| livelovepolish.com | reseller | redirects to mooncat.com (Shopify) | — | — | → mooncat.com (enabled source) |
| nailpolishcanada.com | reseller | no answer (DNS/TLS/timeout) | — | — |  |
| ninjapolish.com | reseller | Shopify, products.json open | no clause; no reproduction without consent (§3.4) | — |  |
| rainbowconnection.co.uk | reseller | custom site, no feed found | — | — |  |
| sallybeauty.com | reseller | Salesforce Commerce Cloud; affiliate page gone (410) (§3.5) | — | — |  |
| sephora.com | reseller | 403 to our User-Agent (Akamai); affiliate feed via Rakuten (§3.5) | — | — |  |
| ulta.com | reseller | custom (products.json answers HTML) | — | — |  |
| alchemylacquers.com | indie | Shopify, products.json open | no automated-access clause found | 228: Nail Lacquer 198; (empty) 30 |  |
| anchorandheartlacquer.com | indie | Shopify, products.json open | Shopify clause | 25: Hand Care 8; Top coat 7; Nail Polish 5; Base Coat 4; Body Care 1 |  |
| baronessx.com | indie | Shopify, password page (401) | — | — |  |
| blackdahlialacquer.com | indie | no answer (DNS/TLS/timeout) | — | — |  |
| bluebirdlacquer.com | indie | Shopify, password page (401) | — | — |  |
| blushlacquers.com | indie | custom site, no feed found | — | — |  |
| cadillacquer.com | indie | no answer (DNS/TLS/timeout) | — | — |  |
| celestialcosmetics.com.au | indie | no answer (DNS/TLS/timeout) | — | — |  |
| cirquecolors.com | indie | Shopify, products.json open | — | — | CirqueColorsShopify (enabled) |
| coloresdecarol.com | indie | Big Cartel (products.json 404) | — | — |  |
| cuticula.com | indie | custom site, no feed found | — | — |  |
| dancelegend.com | indie | no answer (DNS/TLS/timeout) | — | — |  |
| darlingdivapolish.com | indie | no answer (DNS/TLS/timeout) | — | — |  |
| delushpolish.com | indie | no answer (DNS/TLS/timeout) | — | — |  |
| differentdimension.com | indie | custom (products.json answers HTML) | — | — |  |
| dreamlandlacquer.com | indie | Shopify, products.json open | custom clause: …use any robot, spider, scraping, data gathering and extrac | 72: Nail Polishes 50; (empty) 11; Whimsy Wares 8; Accessories 3 |  |
| elevationpolish.com | indie | no answer (DNS/TLS/timeout) | — | — |  |
| enchantedpolish.com | indie | custom (products.json answers HTML) | — | — |  |
| ethereallacquer.com | indie | Shopify, products.json open | custom clause: …use any robot, spider, scraping, data gathering and extrac | 9: (empty) 9 |  |
| fairmaidenpolish.com | indie | custom / unknown (home 404) | — | — |  |
| fancygloss.com | indie | no answer (DNS/TLS/timeout) | — | — |  |
| femmefatalecosmetics.com.au | indie | WooCommerce, Store API 200 | — | — |  |
| funlacquer.com | indie | Shopify, products.json open | Shopify clause | 250 (first page): NAIL POLISH 88; GEL POLISH 84; Water Bottles 18; HOLO POWDER 15; NAIL STUD 9; Mo |  |
| garden-path-lacquers.com | indie | no answer (DNS/TLS/timeout) | — | — |  |
| girlybitscosmetics.com | indie | Cloudflare challenge (BigCommerce) | — | — |  |
| glampolish.com.au | indie | Shopify, products.json open | Shopify clause | 250 (first page): (empty) 185; What's New? 65 |  |
| glistenandglow.com | indie | Big Cartel (products.json 404) | — | — |  |
| grlfrndpolish.com | indie | no answer (DNS/TLS/timeout) | — | — |  |
| holotaco.com | indie | Shopify, products.json open | — | — | HoloTacoShopify (enabled) |
| ilnp.com | indie | WooCommerce; the Store API answered 200, but robots.txt disallows `/wp-json/` and `/wc/store/v1/` (Oct survey) | — | — | reach via Harlow & Co / Hypnotic (§3.2) |
| jreine.com | indie | no answer (DNS/TLS/timeout) | — | — |  |
| kbshimmer.com | indie | WordPress behind a Cloudflare challenge (403 on every path) | — | — | reach via Harlow & Co / Beyond Polish (§3.2) |
| kineticsnails.com | indie | no answer (DNS/TLS/timeout) | — | — |  |
| lilypadlacquer.com | indie | no answer (DNS/TLS/timeout) | — | — |  |
| lollipopposse.com | indie | no answer (DNS/TLS/timeout) | — | — |  |
| loveangelinepolish.com | indie | no answer (DNS/TLS/timeout) | — | — |  |
| lucky13lacquer.com | indie | custom (products.json answers HTML) | — | — |  |
| lynnderella.com | indie | no answer (DNS/TLS/timeout) | — | — |  |
| masura.ru | indie | custom site, no feed found | — | — |  |
| mooncat.com | indie | Shopify, products.json open | — | — | MooncatShopify (enabled) |
| moonshinemani.com | indie | Shopify, products.json open | Shopify clause | 199: (empty) 199 |  |
| nailhoot.com | indie | Shopify, products.json open | Shopify clause | 230: (empty) 128; Bath and Beauty 92; Books 6; Merch 4 |  |
| nailland.com | indie | no answer (DNS/TLS/timeout) | — | — |  |
| ninezerolacquer.com | indie | custom / unknown (home 409) | — | — |  |
| noodlesnailpolish.com | indie | Shopify, products.json open | no automated-access clause found | 57: (empty) 57 |  |
| octopuspartynaillacquer.com | indie | no answer (DNS/TLS/timeout) | — | — |  |
| paintedpolish.com | indie | Big Cartel (products.json 404) | — | — |  |
| penelopeluz.com | indie | Shopify, products.json open | no automated-access clause found | 216: (empty) 216 |  |
| picturepolish.com.au | indie | WooCommerce, Store API 200 | — | — |  |
| pipedreampolish.com | indie | no answer (DNS/TLS/timeout) | — | — |  |
| poetrycowgirlnailpolish.com | indie | Big Cartel (products.json 404) | — | — |  |
| polishedfordays.com | indie | Wix (no public feed) | — | — | 59 listings at Harlow & Co |
| powderperfect.com | indie | custom site, no feed found | — | — |  |
| quixoticpolish.com | indie | no answer (DNS/TLS/timeout) | — | — |  |
| sayuripolish.com | indie | no answer (DNS/TLS/timeout) | — | — |  |
| seventhheavenlacquers.com | indie | no answer (DNS/TLS/timeout) | — | — |  |
| tonicpolish.com | indie | Shopify, password page (401) | — | — |  |
| vapidlacquer.com | indie | custom (products.json answers HTML) | — | — |  |
| wildflowerlacquer.com | indie | Wix | — | — |  |
| wonderbeautyproducts.com | indie | BigCommerce | — | — |  |

