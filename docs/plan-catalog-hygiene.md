# Catalog hygiene plan — non-polish products, product categories, back navigation

_Drafted 2026-10-18. Covers [#347](https://github.com/mattmck/swatchwatch/issues/347),
[#348](https://github.com/mattmck/swatchwatch/issues/348) and
[#349](https://github.com/mattmck/swatchwatch/issues/349). Status: **proposed**, decisions in §3 need the owner._

## 1. The problems

- **#347: non-polish products in the catalog.** Buffers, charms, stamping plates, magnets and
  cuticle pushers show up as polishes. The June filter (#183/#184) only checks Shopify product
  type and tags, misses several words, doesn't cover the Holo Taco connector's own filter, and
  never removed rows that were already ingested.
- **#349: no product category.** Toppers, top coats, base coats and treatments are treated as
  color polishes or dropped at ingestion. Two effects matter most:
  - **Dupe inflation.** The dupe finder compares toppers with color polishes and only drops the
    grade one step for a different finish, so a near-white topper counts as a near-dupe of a
    white creme.
  - **Wrong hexes.** Hex detection prefers the on-nail photo (#256). For a topper that photo
    shows it layered over another polish, so `detected_hex` can be the base color, not the topper.
- **#348: back navigation loses list state.** `/polishes` resets to page 1 on return because the
  page-clamp effect runs before the first fetch. Most other links into the detail page don't pass
  `returnTo`, and gaps and color search keep their state only in memory.

## 2. Measure first: the audit query

`docs/queries/catalog-hygiene-audit.sql` classifies every unmerged shade into `color`,
`topper`, `top_coat`, `base_coat`, `treatment` or `accessory`. It uses the shade name plus each
linked source product's title, product type and tags, and reports:

1. Shades per category: active, with a detected hex, held in someone's inventory, users holding.
2. Non-color shades per data source, which shows where the filter leaks.
3. Toppers by color family and hex source.
4. **Dupe exposure:** near-dupe pairs (HIGH ≤ 0.05, MEDIUM ≤ 0.10 OKLAB) inside each user's owned
   collection where at least one side isn't a color polish (topper vs color, topper vs topper,
   and so on), each pair counted once, split by the color side's family. This sizes how many
   false warnings are possible today. It doesn't read the dupe finder's output. Adding categories
   leaves it unchanged, but clearing topper hexes (D-D) moves or removes those toppers' pairs,
   so it's compared before and after the backfill (see Phase 6).
5. Toppers whose detected hex looks like a base color (far from the vendor hex, or saturated
   with no vendor hex).
4b. Every pair behind section 4, one row each, for the Phase 6 before/after diff. It contains
   internal user ids, so it stays in a local file and isn't posted.
6. Ten sample rows per category, to check for false positives before trusting the counts.

It runs in one transaction that ends in `ROLLBACK`. Its only write is a session temp table,
after which the transaction is switched to read-only.

```bash
psql "$DATABASE_URL" -f docs/queries/catalog-hygiene-audit.sql
```

**Dev first, prod last.** The Azure dev database holds the same connectors' real ingested data,
so it is where the heuristics get tuned and every backfill is rehearsed. Prod is only audited
once the dev results look right, and only changed after the same steps have run cleanly on dev
(see §4). If a Postgres firewall doesn't allow your IP, use the Azure portal query editor (paste
the file) rather than opening the firewall. Post the output on #347 and #349, except section 4b.

### What the local dry run already shows (dev seed data, 267 shades)

| Category | Shades | Held in inventory |
|---|---|---|
| color | 240 | 216 |
| topper | 21 | 21 |
| accessory | 4 | 4 |
| base_coat | 2 | 2 |

- All four accessories are Mooncat items (magnetic wand, horseshoe magnet, nail file, cuticle
  pusher) with product types "Nail Tools" and "Cuticle Pushers". **Product type is the strongest
  signal**, and the filter should lean on it.
- **Tags are noisy.** Holo Taco tags a magnetic polish `magnetic-wand` (a wand ships with it), and
  tags some ordinary polishes `toppers`. Accessories therefore need to be decided without tags,
  from the shade name, color name, title and product type. Topper-by-tag needs a review step.
- Holo Taco sells flakie toppers under product type **"Top Coat"**, so "top coat" wording alone
  can't mean top coat. An explicit topper finish or tag must win.
- Holo Taco's base coats ("Quick-Dry Base", "Sticky Base") are in the catalog as color polishes.
  One even has product type "Nail Polish".

The real numbers will come from the Azure dev database, then prod. The point of the local run is that the heuristics need a
human-reviewed sample before any bulk change.

## 3. Decisions needed

### D-A. How to model the category (#349)

| Option | Shape | For | Against |
|---|---|---|---|
| **(a) Column on `shade` (recommended)** | `shade.product_category text NOT NULL DEFAULT 'color'`, CHECK in `color, topper, top_coat, base_coat, treatment, accessory`, plus `product_category_source` (`rule` / `admin`) | One field every surface can filter on. Admin overrides survive re-ingestion. A cheap migration with a backfill from the classifier | One more column; the classifier must be good |
| (b) Keep "topper" as a finish and add coat finishes | Reuse `finish_type` | No schema change | Mixes "what it looks like" with "what it's for". A glitter topper needs both `glitter` and `topper`, and dupe logic stays tangled |
| (c) Separate `product_type` lookup table | Admin-managed like `finish_type` | Flexible | Over-built for six values that drive code paths |

Recommendation: **(a)**. Topper becomes a category, and its finishes describe the particles
(glitter, flake, holo). The `topper` finish stays as an alias that sets the category on ingestion,
so existing tags keep working.

### D-B. What happens to accessories (#347)

- **(a) Recommended:** classify them as `accessory` and set `status = 'excluded'` (new status
  value). They disappear from catalog search, color search, dupes, gaps and Pick for me. Users who
  already hold one keep seeing it in their collection, the same way `user_submitted` shades work
  for holders. Nothing is hard-deleted.
- (b) Hard-delete rows nobody holds. This is irreversible and loses the audit trail. No.

### D-C. Which surfaces see which categories

Recommended defaults:

| Surface | color | topper | top/base coat, treatment | accessory |
|---|---|---|---|---|
| Collection table, import/export | ✓ | ✓ | ✓ | holders only |
| Catalog search | ✓ | ✓ | ✓ | ✗ |
| Color search, gaps, photo match | ✓ | ✗ | ✗ | ✗ |
| Dupe finder / add guard | ✓ vs color | topper vs topper only | ✗ | ✗ |
| Pick for me | ✓ (pair-it may suggest a topper) | ✗ as main pick | ✗ | ✗ |
| Stats (spend, untried, cost per wear) | ✓ | ✓ | spend only | ✗ |
| Hex detection | ✓ | particles only, see D-D | ✗ | ✗ |
| Mani log role prefill | color | topper | base / top | ✗ |

### D-D. Topper hexes

- **Recommended:** don't run vision hex detection on toppers. Show finish chips and a neutral
  "topper" swatch instead of a color. Keep `vendor_hex` when the vendor gives one (it usually
  describes the particles). Clear `detected_hex` on toppers flagged by audit section 5, using the
  provenance columns so it can be undone.
- Alternative: a topper-specific vision prompt ("describe the particle color, ignore the base").
  That's worth an eval run later (#322 harness), but not a blocker.

### D-E. Base coats and treatments at ingestion

Stop dropping `treatment`, `primer` and `bond` products once the category exists. Ingest them as
`base_coat` or `treatment` so collectors can track them. Keep dropping true accessories.

## 4. Sequencing

```
Phase 0  Audit in dev; tune the classifier on its samples ──┐
Phase 1  #348 back navigation (independent, web only)      │  parallel
Phase 2  Decide D-A … D-E (owner)                         ◄┘
Phase 3  #349 schema + classifier + backfill — dry run, then apply, on dev
Phase 4  #347 stricter ingestion filter + accessory exclusion — on dev
Phase 5  #349 surfaces: dupes, search, gaps, Pick for me, stats, hex detection
Phase 6  Verify on dev (re-run audit) → prod: audit baseline, release, backfill, re-audit
```

**Phase 0 — Audit dev (half a day).** Run the query on the Azure dev database. Eyeball the
section 6 samples per category and adjust the regexes until false positives are rare; if dev's
catalog is thinner than prod's for a source, run that source's ingestion on dev first so the
samples cover it. Record the counts on #347 and #349. These are the dev baseline for Phase 6.

**Phase 1 — #348 (1–2 days, can start now).**
1. Gate the page clamp in `apps/web/src/app/(app)/polishes/page.tsx` on `hasLoaded`, and add a
   test that mounting with `?page=5` keeps page 5 until data arrives.
2. Add a `detailHref(id, returnTo?)` helper, defaulting `returnTo` to the current path and query,
   and use it for every link to `/polishes/detail` (dashboard, gaps, match, color search, Pick for
   me, stats panels, dupe links, verdict card, related polishes).
3. Move gaps and color search state into the URL using the `polish-list-url.ts` pattern.

**Phase 3 — #349 model (2–3 days).**
1. Migration via `/create-migration`: `product_category` + `product_category_source`, the
   `excluded` status, and an index on `(product_category, status)`.
2. Move the classifier into `packages/functions/src/lib/product-category.ts`. The audit query is
   its reference: the TypeScript version applies the same rules in the same order, and its unit
   tests are built from the audit's reviewed samples. The rules, first match wins:
   1. **accessory** when the shade name, color name, source title or product type (never tags)
      names a tool or accessory;
   2. **topper** when the shade's finishes say topper, or the word topper appears anywhere,
      tags included, so it beats coat wording;
   3. **base_coat**, **top_coat**, **treatment** from the shade name, color name, source title,
      product type or tags;
   4. **color** otherwise.

   If the classifier needs a different precedence (for example trusting product type over the
   title when they conflict), change the audit query first and re-review its samples, so the
   two never disagree.
3. Backfill as an admin job with a **dry-run mode** that writes a report instead of updating.
   Dry-run on dev, review the report, apply on dev. Admin override in the Review Queue (or a small Category control on the shade) sets
   `product_category_source = 'admin'`, which re-ingestion never overwrites.
4. Shared types: `ProductCategory` in `packages/shared`, `Polish.productCategory`.

**Phase 4 — #347 filter and exclusion (1–2 days).**
1. Ingestion calls the classifier instead of `isNailPolish`. Accessories are skipped. Coats and
   treatments are ingested with their category. Holo Taco uses the same code path.
2. The backfill sets `status = 'excluded'` on accessories nobody holds, and lists held ones for
   admin review.
3. Hex detection skips every category except `color` (toppers too, per D-D).

**Phase 5 — #349 surfaces (2–3 days).** Apply the D-C table: filters in catalog search, color
search, gaps, match-image, Pick for me and stats; a topper-only path in the dupe finder; mani log
role prefill.

**Phase 6 — Verify on dev, then prod.**
1. Save the full audit output on dev **before** the backfill. After it, re-run and compare:
   - Section 5 should be empty, and section 1 should match the backfill report.
   - Diff section 4b, the full pair listing, not section 4's totals, which are grouped and
     truncated. Section 4b holds internal user ids, so keep it in a local file rather than on
     an issue.
   - Section 4 measures hex distances between owned shades, so category changes alone don't
     alter it. Clearing a topper's `detected_hex` (D-D) does: if that hex was its display hex,
     the topper's pairs move to a different distance or grade, or drop out when no other hex
     is left. Every pair that changed must belong to a topper whose hex the backfill cleared;
     any other change means the backfill touched something it shouldn't have.
   - Section 4 stays an exposure measure, not the success check.
2. Check the dupe finder itself on dev. Take the pairs section 4 listed before the fix. For a
   color shade, `GET /api/polishes/{id}/dupes` must no longer return its topper, coat or
   treatment partners. For a topper, it must return only other toppers. The same rules need
   unit tests in the shared dupe code, so CI keeps them.
3. Only then: run the audit on prod as its baseline, ship the release (the migration adds the
   columns), run the backfill on prod in dry-run mode, compare its report with dev's, apply, and
   re-run the audit.
4. Watch the dupe-warning funnel (`dupe.warning_shown`) for a fall in warnings on white and light
   shades.

## 5. Risks

| Risk | Mitigation |
|---|---|
| The classifier misfiles real polishes (a polish named "Base Camp", a shade called "Gold Plate") | Accessory rules read only the shade name, color name, source title and product type (never tags), with word boundaries. Every backfill is dry-run first and sampled. Admin override is sticky |
| Users lose a shade they track | Never exclude held shades automatically; hide from discovery only |
| Vendors reuse product types loosely (Holo Taco's "Top Coat" toppers) | Topper evidence wins over coat wording; per-source overrides in `data_source.metadata` if needed |
| Toppers vanish from Pick for me / color search and users miss them | Catalog search and the collection table still show them; pair-it can suggest a topper |
| Dupe-funnel metric shifts for reasons other than this change | Read it against the Phase 0 baseline and the date of the Phase 5 release |

## 6. Out of scope

- A topper-specific vision prompt (follow-up eval under #322).
- Multi-category shades (a "base + top" 2-in-1): classify as `top_coat` for now.
- Retail/affiliate surfacing of accessories.
