# Looks Experience Plan (Search Simplification)

**Date:** 2026-02-20
**Author:** Codex (with Matt)  
**Context:** Preserve existing search while adding a new, goal-driven "Looks" experience that recommends nail combos using owned shades first, then suggests purchases to complete the look.

## 1) Intent & Success Criteria
- Answer one question fast: *“What combo will make my nails look awesome for my vibe, and what do I need to buy to finish it?”*
- Keep existing search/color-lab for power users; do not regress it.
- Success metrics (instrument):
  - Time-to-first-look selection (<30s target).
  - % looks completed with owned-only; add-to-cart rate for gap items.
  - Repeat use: saved/reworn looks per user.
  - Drop-off after vibe selection.

## 2) Scope & Non-goals
- In-scope: new `/polishes/looks` (app-shell) page + backend recommendations + saved looks.
- Keep current search canvas under an "Advanced / Color Lab" toggle or separate subroute.
- Non-goals: checkout/payments, inventory purchasing, complex social features.

## 3) User Experience Overview
- **Entry:** Auto-select trending vibe (occasion + mood + finish). Immediately render 3 Look Cards using owned shades when possible.
- **Inputs (left rail):**
  - Occasion (Work, Date, Party, Everyday, Formal)
  - Mood (Soft, Bold, Edgy, Playful)
  - Finish preference (Gloss, Matte, Chrome, Holo, Flake, Sheer)
  - Skin tone preview slider (cool ↔ warm) + nail length/shape presets
  - Toggles: `Owned only`, `Include toppers`, `Advanced / Color Lab` (reveals current color wheel)
- **Outputs (right):** 3 Look Cards with: thumbnail swatch strip, steps (Base, Accent/Tip, Topper), ownership pills (Owned ✓ / Add $), price for missing items, difficulty/time badges, `Wear this`, `Add missing items`, `Share`, `Save`.
- **Detail drawer:** expands a card to show substitutions (owned vs. shop), care notes, and application steps.
- **Advanced Color Lab:** existing canvas moved behind toggle; seeded with current vibe palette to stay consistent.

## 4) Information Architecture
- Route: `(app)/polishes/looks/page.tsx` (client component, uses AppShell).
- Tabs within page: `Looks` (default) | `Shop Completers` | `Advanced Color Lab` (hidden behind toggle or secondary tab).
- Components: `VibeSelector`, `LookCard`, `SubstitutionsSheet`, `ShoppingListModal`, `AdvancedLab` (lazy), `SkinTonePreview`.

## 5) Recommendation Logic (MVP)
- **Palette target:** derive OKLAB center from vibe presets (map per occasion+mood+finish). Use existing `colorDistance` utils.
- **Base selection:**
  - Start with owned polishes sorted by OKLAB distance to target and finish compatibility table.
  - If none within threshold, fall back to catalog (shop suggestions) and mark `isOwned=false`.
- **Accent/Topper:** maximize contrast while staying within harmony bounds; avoid finish clashes (e.g., shimmer-on-shimmer unless intentional rule).
- **Gap fill:** when a step is unowned, pick top 2 catalog matches; expose `Add missing items` CTA.
- **Diversity:** ensure 3 looks vary by finish or hue (enforce min OKLAB distance between look bases).
- **Named templates:** maintain 15–20 prebuilt looks (Glazed Donut, Office Neutral, Soft Chrome, Galaxy Fade, Cyber Violet, Berry Gradient, French Modern, Monochrome Slick). Templates supply defaults when data sparse.

## 6) Data & APIs
### New shared types (packages/shared)
- `Look`, `LookStep`, `LookSource` (owned | catalog | template), `Vibe`, `ShoppingSuggestion`.
- Extend `Polish` with `isOwned`, `priceCents?`, `inventorySource?` (if not already present).

### New endpoint (packages/functions)
- `GET /api/looks`
  - Query: `vibe`, `skinTone`, `nailShape`, `ownedOnly`, `limit=3`, `seed`.
  - Auth: B2C JWT required (reuse `auth.ts`). Dev bypass allowed.
  - Response: `{ looks: Look[], advancedSeed: { palette: string[] } }`.
- Algorithm: SQL pulling user-owned polishes + catalog (non-owned) ranked by OKLAB distance and finish compatibility. Use `pgvector` embeddings of lab values for fast similarity. Templates fallback when user has zero owned.
- Persistence (Phase 2): `user_looks` table for saved looks (`id`, `user_id`, `look_json`, `created_at`, `source`, `vibe`, `telemetry_context`).

### Existing endpoints reused
- `/api/polishes` for ownership + details; add `isOwned` flag in response if missing.

## 7) Web Implementation (apps/web)
- New route file: `src/app/(app)/polishes/looks/page.tsx` (client component).
- Data fetching: `useSuspenseQuery` (React Query?) or fetch-in-client with SWR; hydrate vibe defaults from server (trending presets).
- Components:
  - `VibeSelector` (chips + sliders).
  - `LookCard` displays steps, ownership pills, price sum, actions.
  - `ShoppingListModal` aggregates missing items with links/prices.
  - `SubstitutionsSheet` for swaps (owned vs. shop).
  - `AdvancedLab` lazy-loaded; embeds existing color wheel (current search) with pre-seeded palette.
- State: single source `useLooksState` hook (vibe, toggles, selection, shopping list).
- Feature flag: `NEXT_PUBLIC_FEATURE_LOOKS` to gate route visibility until ready.
- Empty/edge states: no owned polishes → show 3 template looks + "Start your kit" upsell; offline/err → graceful fallback to templates.
- Accessibility: focus order from filters to cards; ensure keyboardable actions and aria labels for toggles; high-contrast badges.

## 8) Mobile Considerations (Expo)
- Reuse logic later: move core recommendation to shared types + API so mobile can call `/api/looks` with same shapes. Not in first sprint; keep layout notes compact.

## 9) Instrumentation
- Frontend events: `vibe_selected`, `look_rendered`, `look_selected`, `add_missing_items_opened`, `advanced_lab_opened`, `owned_only_toggled` (include counts of owned vs. missing).
- Backend metrics: hit rate of owned-only looks, template fallback rate, latency, errors.
- Log payload sizes to avoid over-fetching.

## 10) Rollout Plan
- Phase 0 (today): ship page scaffold with fixtures; feature-flagged; keeps search untouched.
- Phase 1: wire real `/api/looks`; owned vs. shop pills; shopping list modal.
- Phase 2: saved looks persistence + seasonal template updates.
- Phase 3: voice entry (“I need party nails”) routes to prefilled vibe.
- Phase 4: retire legacy search as default, keep Color Lab advanced.

## 11) Risks & Mitigations
- Sparse owned data → template fallback and clear copy.
- Slow recommendations → precompute nightly top looks per vibe, cache in Functions memory/Redis (if added later).
- Pricing/source gaps → allow null price but show “Check price”; make source explicit.
- Visual mismatch → add swatch previews from existing assets; fallback to gradients from hex.

## 12) Task Breakdown (owner → scope)
- **Shared:** add `Look` types + exports; document in `packages/shared/README.md`.
- **Functions:** add `looks.ts` handler; similarity query; feature flag env `LOOKS_ENABLED` (optional); tests + README update.
- **Web:** build new route, components, fixtures; gate via `NEXT_PUBLIC_FEATURE_LOOKS`; wire to API when ready; update `apps/web/README.md` route table when shipped.
- **Data:** optional `look_templates` seed file in migrations; add embeddings for catalog polishes if missing.
- **Docs:** this file; later update route and API docs when code ships.

## 13) Rough Wireframe (text)
- **Desktop layout:**
  - Left rail (280px): Vibe chips grid; sliders; toggles.
  - Right content: 3 Look Cards in a responsive grid. Each card: header with look name + vibe badges; swatch strip; Steps list (Base / Accent / Topper) with ownership pills; CTA row (`Wear this`, `Add missing items`, `Share`, `Save`).
  - Footer strip: Advanced Color Lab toggle → reveals existing canvas below cards.
- **Mobile layout:**
  - Filters collapse into top sheet; cards stack vertically; CTAs stay primary.

## 14) Open Questions
- Source of purchasable catalog: do we treat non-owned polishes from global catalog table or external marketplace? (Assume global `polishes` with `is_public` + price for now.)
- Do we want multi-look “wardrobe” saving now or later? (Proposed Phase 2.)
- Are toppers separate SKUs or same table with `category = topper`? Need schema check before implementation.

## 15) Definition of Done (Phase 1)
- Feature flag on; `/polishes/looks` reachable; renders 3 fixture looks; Owned vs. Add pills render based on user data; `Add missing items` modal sums prices; Advanced Color Lab toggle reveals existing experience seeded with the current vibe palette.
- Lighthouse passes a11y checks for interactive controls.
- Telemetry events fire with anonymized payload.

