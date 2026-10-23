# Overnight batch 2026-10-23 → 24: plan

_Written 2026-10-23 by the lead session before the batch started. Subagent sessions run on Sonnet 5.5,
one per piece, each on its own worktree cut from `origin/dev` (`8e66589`), PR against `dev`, and each
merges its own PR once CI is green (decision D24 (a)). The release runbook is written at the end of
the night in `docs/overnight-2026-10-23-release-runbook.md`._

## 0. Where the backlog came from

Open issues on 2026-10-23: nine. Four are in **M3 — On the go** (#109 Expo remainder, #105 mobile
half, #313 feature flags, #2 ESM), four in M2 (#322, #325, #326 need the owner, a device or a live
host; #274 retro/docs sweep), #281 observability (phases shipped, waiting on the post-deploy
check). `dev` is 14 commits ahead of `main` (look share, buy prices, nearHex sort, indie batch 3,
APIM removal, env-var docs). So tonight's product work comes from the roadmap and retro
proposals, ranked user-facing first and with camera/barcode adding as the standing priority:

| # | Piece | Why now | Issue |
|---|---|---|---|
| 1 | **Mobile Looks** — the web recommender moved to `packages/shared`, a Looks screen in the Expo app | M3 parity, the web's most visible feature is web-only | #109 |
| 2 | **Mobile manual add** — `/polishes/new` in the Expo app, reached from Rapid Add's "Not in the catalog" and from Search, carrying the scanned barcode so it is learned | barcode adding priority; today a mobile scan of an unknown bottle dead-ends | #109 (#21 remainder) |
| 3 | **Mobile Insights + Export** — collection stats panels (`GET /api/stats/collection`) and CSV/JSON export via the share sheet | M3 parity, data ownership | #109 |
| 4 | **Web Rapid Add shelf mode** — keep a running list of verdicts across scans so a shelf of bottles can be checked in one go | in-aisle use, barcode priority | #21 follow-up |
| 5 | **Feature-flag wrapper (#313, D22)** — `isFeatureEnabled()` in Functions, `GET /api/config/flags`, web hides flagged surfaces without the 404 probe; plus the #322 step-4 chore (eval prompts take finishes from the catalog) | the "third or fourth flag" trigger is met (four flags now) | #313, #322 |
| 6 | **Docs sweep (#274)** — docs vs. shipped behavior across `main..dev`, D20 updated for the M3 milestone that now exists, roadmap §1 and retro "What's left" refreshed | #274 acceptance | #274 |

Not tonight, and why: #2 ESM (deploy-affecting, needs a daytime deploy watch); #105 native on-device
color extraction (needs a native module and a device build to verify); #322 labeling, #325, #326
(owner / device / live host); catalog growth beyond Shopify (owner decision, roadmap §4 "+10k").

## 1. Rules every session follows

- Worktree cut from `origin/dev`; `npm ci` + `npm run build:shared` first (app worktrees have no `node_modules`).
- Signed Conventional Commits, early and often; `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- PR against `dev` with Summary / Test plan / **Decisions needed**. Park any decision with the default
  taken and keep going; never stop the session on a question.
- Merge own PR into `dev` (squash) once CI is green and review threads are answered (D24 (a)). Never `dev → main`.
- Docs updated per the CLAUDE.md "Documentation Maintenance" table in the same PR.
- Shared files between the mobile sessions (1–3): `apps/mobile/src/api/client.ts`,
  `components/home-panel.tsx`, `apps/mobile/README.md`, `packages/shared/src/index.ts` — additive edits
  only, rebase on `origin/dev` before merging.

## 2. For the morning

Collected from the sessions' "Decisions needed" sections into the release runbook. Already known:

- Dependabot PRs #418 and #405 are green but target `main`; merge or retarget (owner).
- #281 can close once the post-deploy correlation check (observability-plan.md "Still to verify") is done.
- #322 labels, #325 device pass, #326 live-host e2e: owner.
