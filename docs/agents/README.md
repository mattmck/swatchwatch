# Agent topic files

Index of the detailed agent instructions that `CLAUDE.md` points to. Read the matching file before you change code in its area.

| File | Covers |
|---|---|
| [`catalog-finishes-and-categories.md`](catalog-finishes-and-categories.md) | Finishes (catalog, #224 write rule, families, product text) and product categories (D23). |
| [`color.md`](color.md) | Color families, color-distance sort, estimated hexes, shared color utilities. |
| [`hexes-and-images.md`](hexes-and-images.md) | Shade hexes and provenance, snap step, hex labels / promotion, catalog thumbnails and galleries. |
| [`inventory-and-wear.md`](inventory-and-wear.md) | Inventory status rules, wear stats, collection stats, wishlist value. |
| [`capture-barcodes-bottle.md`](capture-barcodes-bottle.md) | Barcodes and the guided bottle recognition flow. |
| [`ingestion-sources.md`](ingestion-sources.md) | Data sources, connectors, retailer / feed write rules, listing freshness, buy links, MakeupAPI, brand-store correction. |
| [`private-media-and-sharing.md`](private-media-and-sharing.md) | Private user media, capture frames, shareable wishlist and looks. |
| [`mobile-app.md`](mobile-app.md) | The Expo app in `apps/mobile`. |
| [`auth-telemetry-backups.md`](auth-telemetry-backups.md) | Auth and admin user management, telemetry and alerts, backups. |
| [`web-routes.md`](web-routes.md) | Full web route table with behaviour notes, route groups. |
| [`completed-work.md`](completed-work.md) | What has shipped (the completed list). |
| [`environment-variables.md`](environment-variables.md) | Every environment variable, by group. |
| [`dev-commands.md`](dev-commands.md) | Every npm script, including evals, backfills and dedupes. |

## Other documentation files

Documentation files listed here instead of in `CLAUDE.md` to keep it short (plans, specs, runbooks, retros, evaluations, queries):

- `docs/admin-password-reset.md` — #45 password-reset decision record: sign-in method model, tested Entra behavior, rejected Graph options, open tenant issues
- `docs/queries/m2-metrics.sql` — weekly read-only M2 success-metrics query (D19; definitions in `docs/observability-plan.md`)
- `docs/mvp-backlog.md` — epics, capabilities, stories, and milestone timeline
- `docs/indie-sources-2026-10.md` — #273/#328 indie Shopify store survey: per-store products.json, polish-filter counts, terms/robots findings, recommended order and the `data_source.metadata.notes` text for each
- `docs/brand-sources-evaluation-2026-11.md` — November 2026 evaluation of the brands not ingested yet (majors, boutique indies, the Polish Pickup maker roster, multi-brand retailers, affiliate feeds, open data) with a 113-domain storefront probe, measured retailer catalogs (Beyond Polish, Harlow & Co, Hypnotic Polish) and the ingestion strategies S1–S8, recommended order and owner decisions
- `docs/superpowers/specs/2026-11-10-admin-sources-brands-design.md` — admin Sources tab design (store permission record, brand ingest profiles, `/api/sources-admin`, `/api/brands-admin`)
- `docs/overnight-2026-10-18-release-runbook.md` — release runbook for the 2026-10-18 overnight batch (#370–#383): merge order, migrations, post-deploy steps
- `docs/overnight-2026-10-19-release-runbook.md` — release runbook for the 2026-10-19 overnight batch (#388–#399): release steps, open PRs, decisions taken, issues to close by hand
- `docs/overnight-2026-10-23-plan.md` — plan for the 2026-10-23 overnight batch (six parallel sessions, incl. the #274 docs sweep)
- `docs/overnight-2026-10-23-release-runbook.md` — release runbook for the 2026-10-23 overnight batch, written at the end of that batch
- `docs/looks-experience-plan.md` — Looks plan (2026-02) with a status section on what shipped client-side and what is not built yet
- `docs/plan-catalog-hygiene.md` — #347/#348/#349 catalog hygiene plan behind D23 (product categories, non-polish cleanup)
- `docs/superpowers/specs/2026-10-24-multi-color-shades-design.md` — plan (not built) for thermal / magnetic / multichrome shades with 2–4 color stops rendered as a gradient, kept additive to the single display hex
- `docs/roadmap-2026-10-to-12.md` — Oct–Dec 2026 roadmap: research, the four M2 sprints with status lines, §4 success metrics, §5 deferrals, §6 decisions
- `docs/retro-m2.md` — M2 retro (#274): what shipped in release #340, #365, #411 and the `dev` work after them, the M2 / M3 open sets, decisions, §4 metric readings, open issues, Q1 candidates
- `docs/azure-iac-bom.md` — per-environment Azure resource bill of materials
