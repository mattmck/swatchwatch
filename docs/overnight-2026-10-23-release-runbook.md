# Overnight batch 2026-10-23 → 24: release runbook

_Written by the lead session during the night of 2026-10-23. Plan: [overnight-2026-10-23-plan.md](overnight-2026-10-23-plan.md).
Everything below is for the owner; nothing was run against Azure overnight beyond the automatic Deploy Dev on each merge._

## 0. What the batch is

Every piece ran as its own Sonnet session on a worktree cut from `origin/dev`, opened a PR against `dev`,
and squash-merged it once CI was green (decision D24 (a)). **No new migrations.** Deploy Dev was green on
every merge checked (last confirmed `9c5b03d`; the run for the final head is listed in §1).

| PR | Issue | What a user gets |
|---|---|---|
| [#420](https://github.com/mattmck/swatchwatch/pull/420) | #274 | Docs sweep against `dev`; D20 records the **M3 — On the go** milestone; roadmap §1 and retro refreshed |
| [#421](https://github.com/mattmck/swatchwatch/pull/421) | #313 (D22) | `isFeatureEnabled()` wrapper over the four env flags, `GET /api/config/flags` (public flags only), web `useFeatureFlags()` so the wishlist share card and Looks "Share link" render only when the flag is on |
| [#428](https://github.com/mattmck/swatchwatch/pull/428) | #322 step 4 | Hex-eval prompts (`palette-pick`, `region-crop`) list finishes from the finish catalog with the `CANONICAL_FINISHES` fallback |
| [#426](https://github.com/mattmck/swatchwatch/pull/426) | #21 follow-up | **Web Rapid Add shelf mode:** a running verdict list across scans (own it / wishlist / near-dupe / new / not found), counts strip, Clear shelf, duplicate GTIN flagged in place, per-user sessionStorage |
| [#423](https://github.com/mattmck/swatchwatch/pull/423) | #109 | **Mobile Looks:** the recommender moved to `packages/shared` (web re-exports), Expo `/looks` with vibes, three cards, Shuffle, Save, Saved list, Wear this |
| [#427](https://github.com/mattmck/swatchwatch/pull/427) | — | **Wear history** panel on the web and mobile detail pages; `/manis?shade=` filter |
| [#429](https://github.com/mattmck/swatchwatch/pull/429) | #109 | **Mobile gaps heatmap** `/gaps`, gap rules moved to shared |
| [#425](https://github.com/mattmck/swatchwatch/pull/425) | #109 | **Mobile Insights** (`GET /api/stats/collection` panels) and **Export** CSV/JSON through the share sheet (Profile + Insights) |
| [#431](https://github.com/mattmck/swatchwatch/pull/431) | #109 | **Mobile Rapid Add shelf mode** (AsyncStorage, 7 days / 100 entries) |
| [#430](https://github.com/mattmck/swatchwatch/pull/430) | #109 | **Mobile Collection filters:** family, Category, Untried, sort, deep links with the web's param names |
| [#424](https://github.com/mattmck/swatchwatch/pull/424) | #109 (#21) | **Mobile manual add** `/polishes/new` from Rapid Add "Not in the catalog" and empty Search; sends the scanned barcode so it is learned; offers the already-owned polish on a brand + name match |
| [#432](https://github.com/mattmck/swatchwatch/pull/432) | #109 | **Mobile CSV import wizard** `/import` over `/api/polish-imports` |
| [#433](https://github.com/mattmck/swatchwatch/pull/433) | #109 | **Mobile getting-started checklist** and empty states; onboarding rules moved to shared |
| [#434](https://github.com/mattmck/swatchwatch/pull/434) | Looks follow-up | **Skin tone** (undertone + depth) as a soft scoring term in the shared recommender, controls on web (`?undertone=&depth=`) and mobile |
| [#435](https://github.com/mattmck/swatchwatch/pull/435) | #109 | iOS simulator smoke of every mobile screen above, light and dark: no defects; screenshots + README notes |

Waves 5 and 6 ran as background subagents (the app refused new sessions over Remote Control):

| PR | Issue | What a user gets |
|---|---|---|
| [#436](https://github.com/mattmck/swatchwatch/pull/436) | #109 | **Mobile Edit details** sheet: rating, notes, bottles, purchase price + currency + date |
| [#441](https://github.com/mattmck/swatchwatch/pull/441) | #109 / #224 | `Polish.ownSubmitted`; `PUT /api/polishes/{id}` clears `rating` / `purchaseDate` with `null`; mobile edits brand/name/finishes/color of the caller's own private shade; the web edit form now really clears a rating |
| [#445](https://github.com/mattmck/swatchwatch/pull/445) | #224 | **In-place rename** of an own private shade (id and history kept); 409 `shade_identity_taken` on a collision, shown inline on mobile |
| [#437](https://github.com/mattmck/swatchwatch/pull/437) | #267 | **Wishlist value** per currency (`sumListPrices` in shared): web Wishlist view header + dashboard tile, mobile Wishlist preset + Insights panel |
| [#439](https://github.com/mattmck/swatchwatch/pull/439) | — | **Web offline saved copy** of My Collection and owned detail pages (localStorage, per account, 7 days), banner + disabled write actions, network-caused token renewal failures no longer bounce to sign-in |
| [#444](https://github.com/mattmck/swatchwatch/pull/444) | — | **Service worker** precaching the app shell (`out/sw.js` built by `apps/web/scripts/build-sw.mjs`, production only, never caches `/api/*`); "Update available" toast |
| [#442](https://github.com/mattmck/swatchwatch/pull/442) | #265 | **Near-dupe verdict on the web Rapid Add card** ("New to you — but close", Add anyway / Wishlist instead / Cancel) with `dupe.warning_*` events, `surface = rapid_add` |
| [#443](https://github.com/mattmck/swatchwatch/pull/443) | #109 | **Mobile Looks wave 2:** per-step Swap, Details sheet, Add missing items (buy links + prices, ♡ through the guard, per-currency subtotals, Copy list), Copy look; Looks detail helpers moved to shared |
| [#440](https://github.com/mattmck/swatchwatch/pull/440) | — | Gap-cell seed hexes clamped into sRGB gamut (`packages/shared/src/color/gamut.ts`); dark yellow no longer reads as orange |
| [#438](https://github.com/mattmck/swatchwatch/pull/438) | — | First browser smoke of the web pages: fixed duplicate React keys that hid the wear history panel when a polish id equalled its inventory id |

Also merged into `dev` tonight by the owner's other sessions: [#419](https://github.com/mattmck/swatchwatch/pull/419)
(sideways barcodes in the zxing fallback) and [#422](https://github.com/mattmck/swatchwatch/pull/422) (pooled blob
storage connections, `BLOB_STORAGE_MAX_CONNECTIONS`). `dev` is 41 commits ahead of `main` (`a9c2d0a`), Deploy Dev green.

## 1. Before the release

1. `gh run list --branch dev --limit 3`: Deploy Dev green on the final head (green on `a9c2d0a` at 14:00Z).
2. Smoke on dev (web): `/rapid-add` scan two bottles → two shelf entries, Clear shelf; `/polishes/looks` → Skin tone
   control changes the picks, reload keeps it, no Share link controls while the flag is off; `/polishes/detail` of an
   owned polish → wear history after logging a mani; `/manis?shade=…` filter chip; `GET /api/config/flags` answers
   `{ flags: { shareableWishlist: false, shareableLooks: false } }`; Wishlist view shows the value line; stop the
   API (or go offline) → `/polishes` shows the saved copy banner; the installed PWA opens cold without a connection.
3. Smoke on a phone (Expo dev build against dev): Home → Looks / Gaps / Insights; Collection filter bar; Add tab shelf
   after two scans; "Add manually" for an unknown barcode, then scan it again → "You own this"; Profile → Export opens
   the share sheet; `/import` with a 5-row CSV.

## 2. Release `dev → main`

Same as the 10-19 runbook §2: release PR `chore: release dev → main` with a **merge commit**, Deploy Prod,
`prod` environment has `OPENAI_LOCATION=centralus`, the Terraform plan shows no Azure OpenAI replace, alerts quiet
for 30 minutes. No migrations, no Terraform changes. One new optional env var from #422, `BLOB_STORAGE_MAX_CONNECTIONS` (documented, default applies when unset).

After the release, close by hand with a comment naming the PR (closing keywords only fire on `main`): **#313**
(#421). Leave open: #109 (mobile remainder: native color extraction #105, device verification), #322 (steps 1–3 need
hand labels), #274 (owner retro sections), #325, #326, #281.

## 3. Decisions taken as the recommendation (say so if you want any changed)

Collected verbatim from the PR bodies, grouped. Each was the default the session took; nothing waits on you.

**Product rules, both platforms**
- Shelf mode (#426, #431): Add / Wishlist from the shelf skip the add guard (the near-dupe chip warns up front);
  "I bought another" sets quantity = known + 1 (2 when unknown); the chip keeps the verdict the bottle had when
  scanned and later actions show as a second chip; web shelf is per tab (sessionStorage), mobile keeps it 7 days /
  100 entries; the web verdict card itself still has no near-dupe verdict (only the shelf shows it).
- Skin tone (#434): stored on the saved look's vibe snapshot (optional field); weights 0.04 undertone, 0.02 depth,
  arcs cool 250°–30° and warm 30°–120° are first guesses to tune from `looks.generated`; choosing one axis sets the
  other to "no preference"; the mobile preference lives in the api-cache (cleared on sign-out, lapses after 7 days).
- Wear history (#427): panel only for owned/destash polishes; no `mani.history_opened` telemetry.
- Feature flags (#421): the batch flag keeps accepting `1`/`yes`/`on`; the other three need exactly `true`.
- Eval prompts (#428): the region-crop list lost its trailing "…" and now equals `finishNamesForPrompt()`, so eval
  scores may shift slightly against old runs.

**Mobile parity choices**
- Manual add (#424): color optional, no black default (the web sends `#000000`); wishlist sends no quantity;
  Rapid Add prefill comes from typed hints, not OCR (the check endpoint returns no OCR text); the Search query becomes
  the shade name; collection/size/price/tags fields left out; Collection refresh via an in-process event; the local
  dev DB keeps test shade 525 "Manual Add Test — Overnight Teal 109" (delete if in the way); commits carry the
  `Claude Opus 5.5` trailer (the model that ran).
- Looks (#423): saved looks are server-only (no offline pending list); per-step Swap, Details drawer, shopping
  list, Copy/Share and Color Lab not ported; no Looks link from the detail screen; seed/vibe are screen state with a
  random initial seed.
- Insights/export (#425): worn-vs-waiting is a bar, not a ring; spend-by-month shows a month on tap; Insights header
  Export exports every status (status filter only on the Profile card); temp files cleared after the share sheet on
  iOS and at sign-out on Android; stats refetch on focus rather than on write.
- Gaps (#429): the dark yellow seed hex clips toward orange on both platforms (a real chroma clamp is a small
  follow-up); mobile empty state below 5 owned color polishes (web: 0); only Home links to Gaps.
- Filters (#430): sort = recently added, brand, name, finish, rating (no last-worn / wear-count sort in the API);
  Accessory chip only when selected; fixed sort direction.
- Import (#432): no "search the catalog for another match" on a review row (server candidates ≤ 5, add-as-private,
  skip); xlsx refused with a hint; Android picker accepts any file type and checks the extension after.
- Onboarding (#433): dismissal not synced with the web; Looks empty state on zero owned color polishes.

**Waves 5 and 6**
- Edit details (#436, #441, #445): zero bottles stays with the existing "used up" action (editor keeps ≥ 1); date is
  typed `YYYY-MM-DD` (no dependency-free picker in SDK 57); price clears together with its currency; a saved color on
  an own shade can be changed but not cleared (fill-only API); rename collision is exact brand + name + legacy finish,
  case-sensitive; a 409 offers no "use the existing shade" action yet; an admin approving/merging the shade mid-request
  gives a fail-closed 500; commits on #436 carry the `Claude Opus 5.5` trailer.
- Wishlist value (#437): list prices only, unpriced rows counted; the dashboard tile now fetches all wishlist rows
  (paged 250) instead of a one-row count; mobile Collection header omits the "N polishes" prefix.
- Offline (#439): only the first page of `status=owned` per filter set (max 6 sets) plus visited owned details are
  saved, in localStorage with a 1.5M-character budget (IndexedDB if you want the whole collection); "unreachable" =
  network error, 502/503/504 or `navigator.onLine === false` (a 500 still shows the error); cache keyed by the MSAL
  `homeAccountId`; wiped on explicit sign-out or another account signing in, not on silent expiry.
- Service worker (#444): pages outside the precache list (`/admin`, `/l/`, `/w/`, marketing) fall back to the
  `/polishes/` shell offline; navigations are network-first with a 5 s timeout; `/sw.js` served `no-cache` via
  `staticwebapp.config.json`.
- Rapid Add near-dupe (#442): no "don't warn again" checkbox on the card (it honours the flag set elsewhere); the scan
  holds in "Checking…" up to 2 s so Add can't be tapped before the warning; Cancel is the relabelled Scan next.
- Mobile Looks wave 2 (#443): Copy look omits the web's vibe/seed link (no `EXPO_PUBLIC_SITE_URL`); Swap applies owned
  alternatives only (catalog shades are "To buy"); Swap/Details/shopping list on fresh looks only, not Saved.
- Gamut (#440): the gaps grid's "yellows-golds" hue (52°) is brown/nude in product-family terms; moving it to a true
  yellow (~100°) is a separate grid change.

**Docs (#420)**
- The sweep assumed the 10-19 issues were closed by hand after #411 (they closed 2026-10-22 23:55Z, before #411
  merged); #281 kept without a milestone; the M3 text says #117 closed 2026-10-23 without a reason.

## 4. One-time owner actions

- **Device pass** (#325 and the M3 items): Rapid Add shelf + manual add, Looks, Gaps, Insights export share sheet
  and the import picker on a real iPhone and Android phone; the simulator pass (#435) covered rendering, not camera,
  share sheet delivery or the document picker.
- **Skin-tone weights:** read `looks.generated` by `undertone` / `depth` after a week and tune the constants in the
  shared recommender.
- **Dependabot:** #418 and #405 are green but target `main`; merge after the release or retarget to `dev`.
- **#281:** close once the post-deploy correlation check in `docs/observability-plan.md` ("Still to verify") is done.
- **Worktrees:** the app-created worktrees under `.claude/worktrees/` for tonight's branches can be removed
  (`git worktree list`); each branch is merged.
- ~~**Yellow seed hex**~~: done in #440.
- **Docker Desktop hung** on this Mac during the closing smokes (Postgres `ECONNRESET`); one agent killed and restarted
  it (Postgres left running), another had already fallen back to Homebrew Postgres 17 on 5432: it installed `pgvector`
  via brew and left a `swatchsmoke` database. Drop that DB if unwanted (`dropdb swatchsmoke`).
- **Local dev DB leftovers:** test shade 525 (#424), private shades 528–531 created by a temporary dev user 99 (now
  deleted) during the simulator smoke; harmless, delete if in the way.
- **Minor mobile observations from the simulator smoke, not fixed** (file as one issue or ignore): "Shopping list
  copied." toast shows behind the open sheet; "Archive (used up)" has no confirmation; a stale "Details saved." banner
  survives a deep link to another polish; an own shade's chosen hex is labelled "Vendor" on detail; the wishlist value
  line stays when a text filter yields 0 rows; the Swap sheet offered a top coat as a Base substitute; the dark-mode
  progress strip outlines are faint; the getting-started card and the empty state both say "Build your collection";
  the Scan step never ticks after visiting the Add tab.
- **Web:** the admin-only "Sip ground-truth hex" panel stays enabled while the saved copy is shown offline (every other
  write action is disabled); decide whether admin tools should follow the same rule.
- **Shelf counts semantics** (#426 decision 4): the counts strip reports what each bottle was when scanned, so after
  "Wishlist instead" it still reads "0 wishlist · 1 new · 1 near-dupe"; confirm that is the reading you want.

## 5. Verification done overnight

- **iOS simulator, pass 1** (#435): every mobile screen from waves 1–4, light and dark, no defects.
- **Browser, pass 1** (#438): every web page from waves 1–4 at 1280 px light and 390 px dark; one defect fixed (duplicate
  React keys hid the wear history panel).
- **Browser, pass 2:** wishlist totals, offline saved copy and recovery on `/polishes` and `/polishes/detail`, rating
  cleared via `null`, the near-dupe card end to end with a stubbed scanner (Wishlist instead saved), the service worker
  cold start from a served `out/`, no console errors on the other pages. Not exercised: MSAL token renewal under dev
  bypass, the "Update available" toast (needs a second deploy), the 390 px light / 1280 px dark cross.
- **iOS simulator, pass 2:** Edit details (save, Clear, own-shade rename and the 409 inline), manual add from Rapid Add
  and from Search, Looks skin tone / Swap / Details / Copy look, CSV import end to end (Added 4, Skipped 1, New private 1;
  re-import Updated 4), Insights Wishlist panel, Export share sheet, getting-started card with a fresh dev user. The
  "missing wishlist value line" from the aborted run was not reproducible (stale Metro + hung Docker). Not exercised:
  Looks buy link / ♡ (no generated look had a catalog gap), a full light-mode pass, Android.
- **Docs-sync check** over `main...origin/dev`: eight small gaps, fixed in the docs PR that carries this runbook.
- **Not verified anywhere:** a real phone (camera scan, share sheet delivery, document picker), Android.
