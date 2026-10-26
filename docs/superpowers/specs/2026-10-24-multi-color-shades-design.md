# Multi-color shades (thermal, magnetic, multichrome): design plan

Status: **plan only, nothing built** (2026-10-24). Companion to the Hex Labeling type/finish pills
(PR for `PUT /api/shades-admin/{id}/finishes`), which made it possible to *tag* a shade as
thermal or magnetic. This plan covers *storing and showing* its second (and third…) color.

## 1. The problem

Every shade has exactly one color today: `resolveDisplayHex` picks vendor > detected > name, and
everything downstream (swatches, color family, OKLAB sort, dupes, gaps, Looks, photo match,
export, share pages) consumes that one hex. Some polishes are honestly two or more colors:

| Kind | What the colors are | Typical count | Natural rendering |
|---|---|---|---|
| Thermal | cold state, warm state (sometimes a middle) | 2–3 | linear gradient (cold at the tip, warm at the base, like on a nail) |
| Magnetic / cat eye | base, pulled shimmer line | 2 | base fill with a soft band of the line color |
| Duochrome / multichrome | the shift colors by viewing angle | 2–4 | multi-stop linear (or conic) gradient |
| Ombre / gradient sets (rare) | ends of the gradient | 2 | linear gradient |

## 2. How much would blow up?

**If the single hex were replaced by a list: a lot.** Measured in this repo:

- `resolveDisplayHex` / `displayHex` callers: ~43 files across Functions, web and mobile.
- Three STORED GENERATED columns and SQL functions take one hex: `hex_agreement`
  (vendor ↔ detected), `color_family` (`shade_color_family()`), `oklab_l/a/b` (the `nearHex` sort).
  Each has a unit test pinning SQL to the shared TypeScript rule.
- The color rules in `packages/shared/src/color/` (families, dupes, gaps, harmonies, Pair it,
  hex reconciliation) all take one hex per shade.
- Contracts with an outside reader: the CSV export (`POLISH_CSV_COLUMNS`, `Display hex`),
  the export JSON envelope, public wishlist/look share payloads, mobile AsyncStorage caches.
- ~22 web and ~24 mobile files paint a swatch with a plain `backgroundColor`.

**If the extra colors are additive: almost nothing blows up.** Keep the existing hexes exactly as
they are, so the primary color is still the one every consumer already uses. Store the extra
colors next to it, and let each surface opt in. A shade without extra colors behaves exactly as
today. That is the recommendation.

## 3. Recommended data model

A child table, not a JSON column on `shade`, because search needs to rank by "closest of any
state". A per-row STORED GENERATED OKLAB column can be indexed and `min()`-ed, and JSON cannot.

```sql
CREATE TABLE shade_color_stop (
  shade_color_stop_id BIGSERIAL PRIMARY KEY,
  shade_id   BIGINT NOT NULL REFERENCES shade(shade_id) ON DELETE CASCADE,
  position   SMALLINT NOT NULL CHECK (position BETWEEN 0 AND 3),  -- 0..n-1, gradient order
  hex        TEXT NOT NULL CHECK (hex ~ '^#[0-9A-F]{6}$'),
  role       TEXT NOT NULL CHECK (role IN ('cold','warm','mid','base','flash','shift')),
  offset_pct SMALLINT CHECK (offset_pct BETWEEN 0 AND 100),  -- optional gradient stop; NULL = evenly spaced
  source     TEXT NOT NULL CHECK (source IN ('manual_label','vendor','ai')),
  label_id   BIGINT REFERENCES color_training_sample(training_sample_id) ON DELETE SET NULL,
  set_by_user_id BIGINT REFERENCES app_user(user_id) ON DELETE SET NULL,
  oklab_l DOUBLE PRECISION GENERATED ALWAYS AS ((hex_to_oklab(hex))[1]) STORED,  -- same fn as shade.oklab_*
  oklab_a DOUBLE PRECISION GENERATED ALWAYS AS ((hex_to_oklab(hex))[2]) STORED,
  oklab_b DOUBLE PRECISION GENERATED ALWAYS AS ((hex_to_oklab(hex))[3]) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (shade_id, position)
);
ALTER TABLE shade ADD COLUMN color_kind TEXT NOT NULL DEFAULT 'solid'
  CHECK (color_kind IN ('solid','thermal','magnetic','multichrome','gradient'));
ALTER TABLE shade ADD COLUMN color_kind_source TEXT NOT NULL DEFAULT 'rule'
  CHECK (color_kind_source IN ('rule','admin'));
```

Rules:
- A shade has either no stops or **2–4** stops. One stop is never stored (that is just the normal
  hex).
- `color_kind` and the stops are separate. Any kind may have **no stops**: a thermal shade whose
  colors nobody has labeled yet renders and matches on its primary hex like a solid one, with
  only the kind glyph. A `solid` shade never has stops. So setting a kind from finishes never
  needs stops to exist, and it never fails a commit.
- When a shade has stops, their roles must fit its kind, with exact counts:
  - thermal: one `cold` and one `warm`, plus at most one `mid` (2–3 stops)
  - magnetic: one `base` and one `flash` (2 stops)
  - multichrome / gradient: 2–4 `shift` stops

  Stops render and match in `position` order, so an incomplete or repeated set never has to be
  guessed at.
- Offsets are all-or-none per shade: either every stop's `offset_pct` is NULL (evenly spaced), or
  every stop has one and they are nondecreasing by `position`.
- The row CHECKs above cover a single stop. The set rules (the counts and roles above, positions
  `0..n-1` with no gaps, all-or-none nondecreasing offsets) span rows, so they are enforced in the
  database by a `DEFERRABLE INITIALLY DEFERRED` constraint trigger on `shade_color_stop` and on
  `shade.color_kind`, checked at commit. Direct SQL or a future path that breaks them fails at
  commit.
- A shade's stops all come from one source. Every write goes through one helper that replaces the
  whole set in one transaction, and it never replaces `manual_label` stops with another source:
  - Promote colors and Undo (admin) may replace any set.
  - The later AI path may write only a shade that has no stops or only `ai` stops. A shade with
    `manual_label` stops is skipped and logged, and those rows and their `label_id`s stay.
- `color_kind` defaults from finishes (`thermal`, `magnetic`, `multichrome`/`duochrome` finish →
  that kind) but can be set by an admin; it drives rendering and which roles are valid. The
  migration backfills it from `shade.finishes` (and the legacy `finish`), and ingestion and the
  finish backfills keep it in step with the finishes. When a shade's finishes map to more than one
  kind, the rule picks thermal > magnetic > multichrome (the effect the bottle is sold on), and an
  admin can change it. An admin choice sets `color_kind_source = 'admin'`,
  which no backfill or ingest changes (the same sticky rule as `product_category_source` and
  `finishes_source`).
- The rule path (migration backfill, ingestion, finish backfills) changes `color_kind` only on a
  shade **with no stops**. A shade that has stops keeps its kind until an admin changes it, and an
  admin kind change goes through the stop-set helper, which writes the new kind and the new (or
  empty) stop set in the same transaction. Stops can therefore never be left with roles of a
  different kind, and a routine backfill never aborts on the deferred check.
- The **primary hex stays the shade's display hex** (vendor > detected > name, unchanged). For a
  thermal shade, we recommend the primary be the room-temperature (warm) state the bottle shows.
  Stops never write `vendor_hex` / `detected_hex`, so `hex_agreement`, `color_family` and the
  existing OKLAB columns do not change.
- Ingestion never writes stops in phase 1 (sources: admin labels only), and later never
  overwrites `manual_label` stops (same D12 rule as the vendor hex).
- API: polish/catalog responses gain optional `colorKind` and `colorStops: { hex, role, offset? }[]`
  (omitted when solid), and a `nearHex` row gains optional `colorDistanceRole` (the stop role that
  gave `colorDistance`; omitted when the primary hex was closest), so old clients ignore them. Ties
  are broken deterministically: the primary hex wins a tie with any stop (no role), and between
  stops the lowest `position` wins. The SQL and TS parity tests cover both ties. All three fields
  go on the shared `Polish` type in `packages/shared/src/types/polish.ts`. They are never sent for
  another user's private `user_submitted` shade (same visibility as the shade).

## 4. Rendering ("the two form a gradient")

One pure helper in `packages/shared/src/color/swatch-fill.ts`:
`swatchFill(primaryHex, colorKind, stops) → { kind: 'solid', hex } | { kind: 'linear', angle, stops } | { kind: 'band', base, band }`.

- Web: `swatchBackground(fill)` → a CSS `background` string (`linear-gradient(135deg, …)`; magnetic
  = base plus a blurred band via a second gradient layer). Adopt it in the shared swatch pieces
  first (`SwatchThumbnail` fallbacks, color search results, detail page hero, wishlist/look rows),
  then the rest as touched. Anything not migrated keeps showing the primary hex, which is correct.
- Mobile: React Native has no CSS gradients, so add `expo-linear-gradient` (Expo SDK package, no
  native config) and a `<SwatchFill>` component.
- A small "thermal" / "magnetic" glyph on the swatch tells people why it is two-toned.

## 5. Matching and rules (opt in, per surface)

| Surface | Change | Notes |
|---|---|---|
| Color search / `nearHex` | rank by min distance over primary **and** stops | `LEFT JOIN LATERAL (SELECT min(dist) FROM shade_color_stop …)`; `colorDistance` is the closest state's distance and `colorDistanceRole` names its role. The min-over-states distance replaces the distance *within* each `NEAR_HEX_TIER_SQL` tier: measured before estimated still comes first, so a close stop never lifts an estimated shade above a measured one. |
| Photo match | same min-over-states | a photo of a cold thermal nail should find it |
| Dupes | two thermals are dupes only if **both** states are close (pair stops by role); a thermal vs a solid compares the solid to the closest state and drops one grade | extend `gradeDupe` with an optional stops argument; keep the solid path byte-identical |
| Color family / gaps / Looks / Pick for me | primary only (unchanged) | a later option: count a thermal in both families' gap cells |
| CSV/JSON export | add `Color kind` and `Color stops` (`#AAAAAA cold; #BBBBBB warm`) at the end; import ignores them | appending columns keeps re-import working (`importField: null`) |
| Share pages | allowlist gains `colorStops` for public catalog shades only | same rule as the current hex |

## 6. Phases

1. **Data + labeling (≈1 session).** Migration above. Hex Labeling: a "Color kind" pill row
   (Solid / Thermal / Magnetic / Multichrome / Gradient, so an ombre shade can be labeled too)
   and, for non-solid kinds, sip 2–4 points with a role
   chip each (the eyedropper already returns a sample point per click). Labels store the stops in
   `color_training_sample.label_meta.stops` (the label's own `hex` stays the primary), and a
   "Promote colors" action (like Promote to vendor hex: confirm, audit row, Undo) copies them to
   `shade_color_stop` with `source = 'manual_label'`. The eval export keeps scoring the primary.
2. **Display (≈1 session).** `swatchFill` + web `swatchBackground` + mobile `expo-linear-gradient`,
   responses carry `colorKind` / `colorStops`, adopt in the main swatch surfaces.
3. **Matching (≈1 session).** `nearHex`, photo match and dupes as in §5, behind unit tests that
   keep the solid path unchanged (the existing SQL ↔ TS parity tests extend to stops).
4. **AI (later, eval first).** A vision prompt variant that returns stops for shades tagged
   thermal/multichrome (bump `PROMPT_VERSION`), written as `source = 'ai'` and never over
   `manual_label` stops; only after phase 1 labels give ground truth to score it against.

## 7. Open questions

1. Magnetic: is the pulled line a real second color you want to search by, or decoration
   (render-only, excluded from matching)? The plan treats it as matchable but easy to switch off.
2. Thermal primary: room-temperature (warm) state as the primary, cold as the stop? (Recommended,
   since vendor photos usually show the warm state.)
3. Rendering: smooth diagonal gradient (recommended) or a hard split swatch (cheaper, clearer at
   16 px thumbnails)? `swatchFill` can do both; this is a default.
4. Do thermal shades belong to two color families for gaps/filters, or only the primary's?
