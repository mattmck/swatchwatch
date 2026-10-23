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

Wave 5 (in flight when this was written; see §5): mobile edit of rating / notes / quantity / purchase details,
a browser smoke of the web pages above, wishlist value per currency, and an offline saved copy of the owned
collection on the web PWA.

## 1. Before the release

1. `gh run list --branch dev --limit 3`: Deploy Dev green on the final head.
2. Smoke on dev (web): `/rapid-add` scan two bottles → two shelf entries, Clear shelf; `/polishes/looks` → Skin tone
   control changes the picks, reload keeps it, no Share link controls while the flag is off; `/polishes/detail` of an
   owned polish → wear history after logging a mani; `/manis?shade=…` filter chip; `GET /api/config/flags` answers
   `{ flags: { shareableWishlist: false, shareableLooks: false } }`.
3. Smoke on a phone (Expo dev build against dev): Home → Looks / Gaps / Insights; Collection filter bar; Add tab shelf
   after two scans; "Add manually" for an unknown barcode, then scan it again → "You own this"; Profile → Export opens
   the share sheet; `/import` with a 5-row CSV.

## 2. Release `dev → main`

Same as the 10-19 runbook §2: release PR `chore: release dev → main` with a **merge commit**, Deploy Prod,
`prod` environment has `OPENAI_LOCATION=centralus`, the Terraform plan shows no Azure OpenAI replace, alerts quiet
for 30 minutes. No migrations, no new env vars, no Terraform changes in this batch.

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
- **Yellow seed hex:** a chroma clamp in the shared gaps module (both platforms) is a small follow-up (#429 note).

## 5. Wave 5 (filled in when the sessions report)

_Pending at the time of writing: mobile polish edit, web browser smoke, wishlist value totals, web offline cache._
