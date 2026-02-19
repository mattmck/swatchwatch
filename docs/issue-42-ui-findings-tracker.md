# Issue #42 UI Findings Tracker

Source: GitHub issue "Tonight: UI issues log (pre-M0)" (#42) text provided in chat on 2026-02-19.

This tracker captures the findings visible in that shared issue text and maps them to implementation status in `dev`.

## Status Legend
- `Done` = implemented and merged to `dev`
- `Pending` = not implemented yet
- `Verify` = likely implemented but should be explicitly validated in UI

## Findings

| ID | Route | Severity | Finding | Status | Notes / References |
|---|---|---|---|---|---|
| 1 | `/polishes` | medium | Add first/last and +/-5 page jump pagination controls | Done | Implemented in pagination updates merged via #60 / #62 |
| 2 | `/polishes` | medium | Add rows-per-page selector (25/50/100 etc.) | Done | Implemented in pagination UI and page state via #60 / #62 |
| 3 | `/polishes` quantity update | high | 500 on upsert due missing unique conflict target | Done | DB unique constraint fix merged via #60 / #62 |
| 4 | `/polishes` admin UX | medium | Admin-only per-row hex recalculation action with feedback | Done | UI action merged in #63; backend endpoint merged via #61 |
| 5 | `/polishes` back navigation | medium | Preserve page/list context when returning from detail/edit | Done | Implemented in `feat/42-ui-final-slice`: list state now persists in URL query params (page, pageSize, filters, sort) |
| 6 | `/polishes` action alignment | low | Add button alignment inconsistent with quantity controls | Verify | Current action cell is right-aligned; confirm visual consistency in latest UI |
| 7 | `/polishes` table headers | high | Image column header missing/misaligned | Done | Fixed in #60 / #62 |
| 8 | `/polishes` finish/collection overflow | medium | Keep single-line pills, ellipsis, hover reveal full set | Pending | Needs tooltip/popover pattern and stable row height |
| 9 | `/polishes` + `/polishes/search` filters | medium | Standardize dropdown fields/options (include brand) | Pending | Requested consistency across both routes |
| 10 | `/polishes` + `/polishes/search` collection toggle | medium | Replace dual buttons with clearer All/My Collection model | Pending | Candidate for shared reusable filter bar |

## Notes
- The issue page excerpt indicated "15 remaining items" not fully included in the pasted text.
- If additional findings exist in the full issue thread, append them here before implementation.
- 2026-02-19: CI lint follow-up in `fix/42-no-img-lint` migrated three swatch-image call sites to `next/image` with `unoptimized` for static-export compatibility and dynamic external URLs.
