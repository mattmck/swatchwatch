# Dev Commands

Covers the npm scripts an agent runs by hand (dev, build, test, migrations, evals, backfills, dedupes), with the dependency preflight and debugging notes, and lists the remaining manifest scripts under "Other scripts in the manifests" at the end. CLAUDE.md keeps only the everyday commands.

```bash
# From repo root — all use npm workspaces
npm run setup            # Install workspace dependencies (npm ci)
npm run setup:worktree   # Ready a new worktree: copy .env + local.settings.json from the primary checkout, npm ci if needed, build shared types (scripts/worktree-setup.sh)
npm run dev              # Shared types + Functions + web (parallel)
npm run dev:infra        # Start local Postgres + Azurite containers
npm run dev:web          # Next.js dev server (port 3000)
npm run dev:mobile       # Build shared types, then Expo start (apps/mobile; copy .env.example → .env.local)
npm run dev:functions    # Functions TypeScript watch + func host
npm run dev:shared       # Watch-build packages/shared only
npm run build            # Build all workspaces (shared → web → functions)
npm run build:shared     # Build shared types only
npm run build:web        # Build shared types + Next.js production build + out/sw.js (PWA service worker precache, apps/web/scripts/build-sw.mjs)
npm run build:functions  # Build shared types + TypeScript compile for functions
npm run lint             # ESLint across all workspaces
npm run typecheck        # tsc --noEmit across all workspaces
npm run migrate          # Run Postgres migrations (local.settings.json values override the shell env; then DATABASE_URL if set, else PG*)
npm run migrate:down     # Roll back last migration
npm run sync:design-tokens  # Regenerate packages/shared/src/constants/design-tokens.ts (hex light/dark palettes for mobile) from apps/web/src/app/globals.css; `-- --check` fails on drift (CI)
npm run generate:pwa-icons  # Regenerate PWA/apple-touch PNG icons in apps/web/public from the brand SVG (sharp; commit the PNGs)
npm run generate:types   # Regenerate the SupportedConnectorSource type from docs/seed_data_sources.sql
npm run lint --workspace=apps/mobile                 # Mobile ESLint (eslint-config-expo); typecheck: npm run typecheck --workspace=apps/mobile
npm run test --workspace=apps/mobile                 # Mobile unit tests (node:test via tsx: Rapid Add state, status rules)
npm run test --workspace=swatchwatch-functions      # Functions unit tests (no DB; includes access-control isolation tests)
npm run test --workspace=swatchwatch-shared         # Shared unit tests (color harmonies, Pair it; node:test via tsx)
npm run test:e2e --workspace=swatchwatch-functions  # E2E API + cross-user access-control tests against a running local host (skips if unreachable)
npm run eval:hex --workspace=swatchwatch-functions -- --strategy pixel            # Hex-detection ground-truth eval (strategies: azure-current, azure-blind, pixel, region-crop, palette-pick, image-select, image-select-ai, blind-snap, image-select-ai-snap, ensemble; `--list-strategies` for all; Azure ones skip without config; region-crop knobs: HEX_EVAL_REGION_CROP_MODE/CELLS/DETAIL)
npm run eval:bottle --workspace=swatchwatch-functions -- --verbose            # Bottle recognition eval: replays bottle eval samples through the capture API (start → frames → read-only check; never finalize) and scores them (matched/asked/unmatched/rejected; Slice A baseline); API_BASE_URL, ADMIN_BEARER_TOKEN, PG*, AZURE_STORAGE_CONNECTION; report in eval/bottle/results; prints the host's AI_REPLAY_MODE (run the host with AI_REPLAY_MODE=replay to score on recorded AI responses, no Azure spend)
npm run eval:bottle:import --workspace=swatchwatch-functions -- --dir <folder> --dry-run   # Bulk-import bottle eval samples from a folder per bottle ("<Brand> - <Shade>", front/bottom/glass/box photos or clips, take subfolders) via the admin API; exact catalog match or external label, labels.csv overrides, sharpest clip frame via ffmpeg (--frames-per-clip n), idempotent per-take .bottle-eval-import.json (--reset), --require-catalog; API_BASE_URL, ADMIN_BEARER_TOKEN
npm run backfill:image-variants --workspace=swatchwatch-functions -- --after 0  # Generate missing catalog thumbnail variants in batches via POST /api/images-admin/variants/backfill (API_BASE_URL, ADMIN_BEARER_TOKEN; idempotent, resumable)
npm run backfill:barcodes --workspace=swatchwatch-functions -- --after 0           # Build catalog barcode rows from stored connector products (GTIN + variant barcodes → shade) via POST /api/barcodes-admin/backfill; dry run unless --write (API_BASE_URL, ADMIN_BEARER_TOKEN; idempotent, --after resumes)
npm run roster:polish-pickup --workspace=swatchwatch-functions -- --json  # List Polish Pickup's vendors (one GET of its products.json, same User-Agent as the connector) with the registered data_source each matches in docs/seed_data_sources.sql (name without its protocol suffix or metadata.brand, case/punctuation-insensitive; no database); without --json prints `vendor  count  source|-` lines, monthly maker-outreach list
npm run dedupe:makeupapi-shades --workspace=swatchwatch-functions -- --out report.json  # Merge duplicate MakeupAPI shades (copies inside MakeupAPI, and copies of a brand-store shade) and delete unused MakeupAPI-only shades via POST /api/shades-admin/makeupapi-dedupe/backfill; dry run unless --write (API_BASE_URL, ADMIN_BEARER_TOKEN; idempotent, --after resumes)
npm run backfill:brand-store-rejected --workspace=swatchwatch-functions -- --sources LeMiniMacaronShopify  # Exclude active shades whose every listing is a brand-store product the store's current gate rejects (gel while includeGel is off, another vendor's items) via POST /api/shades-admin/brand-store-rejected/backfill; dry run unless --write (API_BASE_URL, ADMIN_BEARER_TOKEN; idempotent, --after resumes)
npm run backfill:imported-wishlist --workspace=swatchwatch-functions             # Remove the untouched wishlist rows old ingestion runs added for the admin who ran them via POST /api/inventory-admin/imported-wishlist/backfill; dry run unless --write (API_BASE_URL, ADMIN_BEARER_TOKEN; idempotent, --after resumes); then run backfill:product-category so unheld accessories are excluded
npm run dedupe:gallery-images --workspace=swatchwatch-functions -- --shade 294   # Unlink gallery images that duplicate another image of the shade (perceptual match) via POST /api/images-admin/gallery-dedupe; dry run unless --write (API_BASE_URL, ADMIN_BEARER_TOKEN; idempotent, --after resumes)
npm run remove:source-images --workspace=swatchwatch-functions -- --source <name> [--write]   # Remove a disabled data source's catalog images (store asked us to stop using its pictures: swatches unlinked, image_asset rows, blobs and variants deleted; hex-labeled / color_features images kept, shared blobs stay) via POST /api/images-admin/source-images/remove; 409 while the source is enabled; dry run unless --write (API_BASE_URL, ADMIN_BEARER_TOKEN; idempotent, --after resumes)
npm run eval:hex:populate --workspace=swatchwatch-functions -- --dry-run         # Fill color_training_sample from shades with real vendor hexes and export a fixture (needs Postgres); `--source-type manual` exports only admin hand labels
npm run backfill:product-category --workspace=swatchwatch-functions -- --out report.json  # Re-classify shade product categories via POST /api/shades-admin/product-category/backfill and save the report (#349; dry run unless --write, --clear-topper-hex also clears suspicious topper detected hexes; API_BASE_URL, ADMIN_BEARER_TOKEN)
npm run backfill:product-text --workspace=swatchwatch-functions                  # Recompute normalized_json descriptionText/descriptors from raw_json and report empty-finish coverage (#352; dry run by default, `--write [--fill-finishes]` applies; needs Postgres)
npm run backfill:product-price --workspace=swatchwatch-functions                 # Recompute product price/currency (buy link list price) from raw_json; Shopify currency from data_source.metadata.currency, earlier ingests or the shop's /meta.json (--no-fetch-currency skips it); dry run unless --write; needs Postgres
```

**Important:** `dev`, `dev:web`, `dev:functions`, and `dev:shared` run a dependency preflight and
print `npm run setup` if workspace dependencies are missing.

If you run web/functions separately without the watcher flow, build `packages/shared` first:
```bash
npm run build:shared
```

**Azure Functions debugging:** Use the VS Code launch config "Attach to Node Functions" which runs the `func: host start` task (builds, watches, starts func on port 9229).

## Other scripts in the manifests

Scripts that exist in a `package.json` but are not in the list above, mostly because another script or a tool calls them:

```bash
npm test                                             # Root: every workspace's test script (the husky pre-commit hook runs the suites)
npm run test --workspace=apps/web                    # Web unit tests (node:test via tsx)
npm run test --workspace=swatchwatch-devtools        # Repo checks, incl. the documentation tests (CLAUDE.md size, docs/agents paths)
npm run typecheck --workspace=swatchwatch-shared     # Per-workspace typecheck (also mobile); the root typecheck runs them all
npm run start --workspace=apps/web                   # next start (the app deploys as a static export, so rarely needed)
npm run android|ios|web --workspace=apps/mobile      # expo run:android / expo run:ios / expo start --web
npm run migrate:create --workspace=swatchwatch-functions -- <name>   # New migration file; prefer the /create-migration skill, which also updates docs/schema.sql
npm run start --workspace=swatchwatch-functions      # func start (dev:functions runs it together with the watcher)
npm run watch --workspace=swatchwatch-functions      # tsc -w (also packages/shared, via dev:shared)
npm run build:deploy --workspace=swatchwatch-functions   # esbuild bundle used by the deploy workflow
npm run pack --workspace=swatchwatch-functions       # func pack → dist/functions.zip (manual packaging; the deploy workflow uses build:deploy)
```

Lifecycle hooks, never run by hand: root `prepare` (installs husky), `predev:check` (the dependency preflight), Functions `pretest` (builds shared and Functions before the tests), web `predev` / `prebuild` (copy the MSAL redirect bridge).
