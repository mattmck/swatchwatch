# CodeRabbit Findings Tracking (`dev`)

Generated on: 2026-02-21  
Target baseline: `origin/dev@d89b1bd`  
Source: repo-wide scan of `@coderabbitai[bot]` PR issue comments, review comments, and review summaries.

## Status Summary

- `not_fixed`: 26
- `fixed`: 12
- `duplicate_non_actionable`: 4

## Outstanding Items (`not_fixed`)

| # | PR | File | Evidence | Finding |
|---|---|---|---|---|
| 1 | #84 | `apps/web/README.md` | `apps/web/README.md:39` | **Small doc clarity: detail route likely needs the `id` query param.** |
| 2 | #79 | `packages/shared/README.md` | `packages/shared/README.md:20; packages/shared/src/types/polish.ts:41` | **README needs syncing with the actual type! ** |
| 3 | #77 | `packages/functions/src/lib/ai-color-detection.ts` | `packages/functions/src/lib/ai-color-detection.ts:120; apps/web/src/lib/constants.ts:3` | **Heads up: FINISH_CANONICAL includes finishes not in web constants** |
| 4 | #66 | `apps/web/src/components/app-shell.tsx` | `apps/web/src/components/app-shell.tsx:34; no matching test file` | (No explicit summary text in source review; docs/tests follow-up remains open.) |
| 5 | #23 | `packages/functions/src/functions/capture.ts` | `packages/functions/src/functions/capture.ts:1147` | **Short-circuit finalize when the session already needs a question.** |
| 6 | #23 | `packages/functions/src/functions/capture.ts` | `packages/functions/src/functions/capture.ts:1006; packages/functions/src/functions/capture.ts:1296` | **Avoid exposing internal error details to clients.** |
| 7 | #19 | `apps/web/src/components/color-wheel.tsx` | `apps/web/src/components/color-wheel.tsx:22` | **Fix prop JSDoc - `lightness` is a number, not an HSL object.** |
| 8 | #19 | `apps/web/src/components/quantity-controls.tsx` | `apps/web/src/components/quantity-controls.tsx:31; apps/web/src/components/quantity-controls.tsx:35` | **Icon swap + fixed-width alignment look solid, but add aria-labels to icon-only buttons for accessibility.** |
| 9 | #19 | `apps/web/src/components/quantity-controls.tsx` | `find apps/web/src -name "*quantity-controls*.test.ts" (none)` | **Add unit coverage for the new control states.** |
| 10 | #19 | `apps/web/src/components/quantity-controls.tsx` | `apps/web/src/components/quantity-controls.tsx:31; apps/web/src/components/quantity-controls.tsx:35` | **Add accessible labels for icon-only buttons.** |
| 11 | #19 | `apps/web/src/lib/color-utils.ts` | `apps/web/src/lib/color-utils.ts:377; apps/web/src/lib/color-utils.ts:398` | **avgPerCell calculation may be inaccurate if input contains invalid hex values.** |
| 12 | #19 | `scripts/agent-worktree.sh` | `scripts/agent-worktree.sh:36` | **Example (path with spaces):** |
| 13 | #13 | `.env.example` | `.env.example:5` | **Server auth validation gates dev bypass - defaulting to `false` recommended for defense in depth.** |
| 14 | #13 | `apps/web/src/components/color-search-results.tsx` | `apps/web/src/components/color-search-results.tsx:82; apps/web/src/components/color-search-results.tsx:128` | **Use buttons for interactive swatches with proper keyboard accessibility.** |
| 15 | #13 | `apps/web/src/components/harmony-palette.tsx` | `find apps/web/src -name "*harmony-palette*.test.ts" (none)` | **Add unit tests for HarmonyPalette component.** |
| 16 | #13 | `apps/web/src/components/harmony-palette.tsx` | `apps/web/src/components/harmony-palette.tsx:39; apps/web/src/components/harmony-palette.tsx:64` | **Replace clickable divs with buttons for keyboard and screen reader accessibility.** |
| 17 | #13 | `apps/web/src/lib/api.ts` | `apps/web/src/lib/api.ts:51` | **Guard dev-bypass auth headers to prevent accidental production bypass.** |
| 18 | #13 | `apps/web/src/lib/color-utils.ts` | `apps/web/src/lib/color-utils.ts:174; apps/web/src/lib/color-utils.ts:180` | **Gamut check is ineffective due to pre-clamping in `oklabToRgb`.** |
| 19 | #13 | `infrastructure/gh-secrets.sh` | `infrastructure/gh-secrets.sh:2; infrastructure/gh-secrets.sh:28` | **`set -e` exits before your friendly missing-output message.** |
| 20 | #13 | `packages/functions/migrations/006_add_user_external_id.sql` | `packages/functions/migrations/006_add_user_external_id.sql:17` | **Guard the dev seed update to avoid clobbering production users.** |
| 21 | #13 | `.husky/generate-commit-msg.sh` | `.husky/generate-commit-msg.sh:50` | **Add curl timeouts to avoid hanging the commit hook.** |
| 22 | #13 | `.husky/README.md` | `.husky/README.md:45` | **Add a fence language to satisfy markdownlint (MD040).** |
| 23 | #13 | `apps/web/src/lib/color-harmonies.ts` | `find apps/web/src -name "*color-harmonies*.test.ts" (none)` | **Add unit tests for harmony scoring helpers.** |
| 24 | #13 | `apps/web/src/lib/color-utils.ts` | `apps/web/src/lib/color-utils.test.ts:1` | **Add unit tests for undertone and gap analysis helpers.** |
| 25 | #83 | `apps/web/src/app/(app)/polishes/page.tsx` | `apps/web/src/lib/recalc-hex-flow.test.ts:20` | **Add unit coverage for the expanded recalc-hex UI flow.** |
| 26 | #23 | `apps/web/src/components/quantity-controls.tsx` | `find apps/web/src -name "*quantity-controls*.test.ts" (none)` | **Add unit tests for QuantityControls.** |

## Notes

- This is a working backlog doc intended for a tracking issue.
- Some entries are near-duplicates from separate review comments; they are intentionally preserved here for traceability.
- Re-run the audit after each merge to keep counts current.
