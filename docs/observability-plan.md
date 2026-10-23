# Observability Plan — Application Insights for Functions + Web

**Status:** Phase 1 implemented (#282), Phase 2 implemented (#285), Phase 3 implemented (#281, 2026-10-17)
**Goal:** Datadog-style visibility using what Azure already gives us: backend APM, browser errors/RUM, one trace from a click in the web app through the Functions API to Postgres/Azure OpenAI, and alerts when things break.
**Out of scope:** Mobile (Expo) telemetry, which needs a separate decision (App Insights JS vs Sentry). Datadog/Sentry are also out of scope.

## Where we are today

| Area | State |
|---|---|
| Terraform | ✅ `azurerm_log_analytics_workspace.main` (30-day retention) + workspace-based `azurerm_application_insights.main`; Function App wired via `site_config.application_insights_connection_string`; Azure OpenAI diagnostics → same workspace |
| Functions host | ✅ Request telemetry from the Functions host; `host.json` `logging.logLevel` at Information, sampling on with Requests/Exceptions/Traces excluded (traces since #226, so ingestion log lines are never sampled away) |
| Functions worker | ✅ `src/lib/telemetry.ts` uses `applicationinsights@3` for `trackEvent`/`trackMetric`/`trackException`, used across auth, cache, capture, catalog, polishes, AI detection, and `internalServerError()` |
| Worker correlation | ⚠️ Phase 1 binds worker telemetry to the host request context (distro `preInvocation` hook); post-deploy KQL validation still pending |
| Worker init order | ✅ `src/index.ts` imports `./lib/telemetry` before the function modules, so the SDK starts before `pg` loads (previously `lib/auth` loaded `pg` first) |
| CORS | ✅ Default `CORS_ALLOWED_HEADERS` includes `traceparent`, `tracestate`, `Request-Id`, `Request-Context`; `Request-Context` is exposed. ⚠️ App Service platform CORS preflight still needs post-deploy validation |
| Web | ✅ (Phase 2) Lazy-loaded browser SDK in `src/lib/telemetry.ts`, `TelemetryProvider`, `error.tsx` / `global-error.tsx` boundaries; ⚠️ browser ↔ Functions `operation_Id` correlation still needs post-deploy validation. Static export (`output: "export"`) means config is `NEXT_PUBLIC_*` at **build** time (set in `deploy.yml`), not SWA app settings |
| Alerts | ✅ (Phase 3, prod only) Action group → `alert_email`; API 5xx, exception spike (server + browser), ingestion job failed, daily cap hit; availability tests for the web home page and `GET /api/reference/finishes` |
| Cost guard | ✅ `appinsights_daily_cap_gb` caps App Insights and Log Analytics daily ingestion (2 GB prod, 0.5 GB otherwise by default, D15), with an alert when the cap is hit |

## Phase 1 — Backend hygiene + correlation (PR 1) — implemented

> **As built (differs from the original plan below):**
> - **No new package.** `applicationinsights@3` runs on `@azure/monitor-opentelemetry`, whose trace handler already registers an Azure Functions `preInvocation` hook binding each invocation to the host's `traceparent` (`traces/azureFnHook.js`), and its `trackEvent`/`trackException` emit OTel log records against the active context. `@azure/functions-opentelemetry-instrumentation` was rejected: it also sets `WorkerOpenTelemetryEnabled`, which reroutes every `context.log` line through the worker, more change than correlation needs. The fix is init order only: `src/index.ts` imports `./lib/telemetry` first.
> - **Exception auto-collection stays off.** The host already records failed invocations with their exception, and `internalServerError()` calls `trackException`, so enabling it would duplicate rows.
> - **`host.json`:** the old `logLevel` block sat under `logging.applicationInsights`, which isn't where the v2 schema reads it, so the `"Trace"` levels were most likely ignored. It now lives at `logging.logLevel` (Information), with `excludedTypes: "Request;Exception"` for sampling. (#226 later added `Trace`: adaptive sampling kept only a third to a half of the trace lines during busy ingestion runs, and the daily cap below bounds the cost.)
> - **No `CORS_ALLOWED_HEADERS` app setting in Terraform.** The code default now includes the correlation headers, so a duplicate list in Terraform would only drift.
> - Caps: `appinsights_daily_cap_gb` (null → 5 prod / 1 otherwise) on both App Insights and the workspace. `application_insights_key` removed; `application_insights_connection_string` output (sensitive) added.
> - **Still to verify after deploy:** correlation KQL below, and that App Service **platform** CORS (`site_config.cors`) lets `traceparent` through on preflight.

1. **Cut log volume** (`packages/functions/host.json`)
   - `logLevel.default` → `"Information"`, `"Host.Aggregator"` → `"Information"`, keep `"Function"` at `"Information"` (ingestion debugging can raise it per-env via app setting `AzureFunctionsJobHost__logging__logLevel__Function`).
   - `samplingSettings.excludedTypes: "Request;Exception"` so failures and request counts are never sampled away.
   - Fix the mixed tab/space indentation while there.
2. **Start telemetry before anything else**
   - New `src/instrumentation.ts`: registers `AzureFunctionsInstrumentation` (from `@azure/functions-opentelemetry-instrumentation`) and initializes the SDK. `src/index.ts` imports it **first**.
   - `telemetry.ts` keeps its public API (`trackEvent`/`trackMetric`/`trackException`) so no callers change; it just reads the client the instrumentation module set up.
   - Turn on `setAutoCollectExceptions(true)` so uncaught worker exceptions are captured (still never crashes on init failure).
3. **Correlation spike, then commit to one path**
   - **Path A (preferred, smallest diff):** keep `applicationinsights@3` (which is built on the Azure Monitor OpenTelemetry distro) + add `AzureFunctionsInstrumentation` so the active context comes from the host's `traceparent`.
   - **Verify:** run against dev App Insights, hit `POST /api/polishes` and a forced 500, then in Log Analytics:
     ```kql
     union AppRequests, AppDependencies, AppExceptions, AppEvents
     | where TimeGenerated > ago(15m)
     | summarize types = make_set(Type), n = count() by OperationId
     ```
     Each request's `OperationId` should include its `pg` dependency, any `trackException`, and custom events. Also check for duplicate request rows (host + worker).
   - **Path B (fallback):** if A doesn't correlate or duplicates requests, move `telemetry.ts` onto `@azure/monitor-opentelemetry` directly (`useAzureMonitor`), mapping `trackMetric` → OTel meter, `trackException` → `span.recordException` + log, and `trackEvent` → Azure Monitor custom events. Same public API either way.
   - **Bundling:** `build:deploy` uses esbuild. Add the new packages to `--external` (require-hook instrumentation breaks when bundled), and confirm `pg` stays external (it is).
4. **Allow correlation headers through CORS**
   - `src/lib/http.ts` default `ALLOW_HEADERS` → `Content-Type, Authorization, traceparent, tracestate, Request-Id, Request-Context`; also set `Access-Control-Expose-Headers: Request-Context`.
   - Terraform: set `CORS_ALLOWED_HEADERS` to match. Check that the **platform** CORS in `site_config.cors` passes these headers on preflight (test with `curl -X OPTIONS` and `Access-Control-Request-Headers: traceparent`).
5. **Terraform cost guard + outputs** (`infrastructure/main.tf`, `outputs.tf`)
   - `azurerm_application_insights.main.daily_data_cap_in_gb` (new var `appinsights_daily_cap_gb`, default `1` dev / `5` prod) and `azurerm_log_analytics_workspace.main.daily_quota_gb`.
   - Drop `application_insights_key` from `site_config` (ikey-only ingestion is retired; the connection string is enough).
   - New output `application_insights_connection_string` (sensitive) for the web build.

**Tests:** existing functions unit tests stub `../lib/telemetry` and keep working. Add a unit test that `http.ts` allows `traceparent` on preflight, and that `instrumentation.ts` is a no-op without a connection string.

## Phase 2 — Browser telemetry + error boundaries (PR 2) — implemented

> **As built (differs from the original plan below):**
> - **No `@microsoft/applicationinsights-react-js`.** Its `ReactPlugin` only adds route tracking via a `history` object (App Router is covered by `enableAutoRouteTracking`) and `AppInsightsErrorBoundary`, which Next's `error.tsx` replaces; it would also pull `history` in as a peer. Only `@microsoft/applicationinsights-web@3.4.5` (pinned) was added.
> - **Correlation allow-list.** `enableCorsCorrelation` is on only when `NEXT_PUBLIC_API_URL` is absolute, and `correlationHeaderDomains` is just that host (with its port, e.g. `localhost:7071`). With CORS correlation on and no allow-list, the SDK would send `traceparent` to every origin, and B2C/blob would reject it on preflight. A relative API URL is same-origin and gets the headers anyway.
> - **Internal user id.** MSAL accounts only carry the B2C subject and email, so `TelemetryProvider` calls `POST /api/auth/validate` (new `getCurrentUserId()` in `lib/api.ts`) once per signed-in account and passes `userId` to `setAuthenticatedUserContext`. It's held in memory only (no `ai_authUser` cookie), so each full page load re-resolves it.
> - **Queueing.** Calls made before the SDK chunk loads (including from `global-error.tsx`, which can fire before the provider's effect) are queued (max 100) and replayed; `trackException` starts the load itself if needed.
> - **Redaction** runs as a telemetry initializer over `baseData`, `baseData.properties`, `data` and `tags` string fields (dependency `name`/`target`/`data`, page view `uri`/`refUri`, custom properties).
> - **Error boundaries use `reset()`**, not Next 16.3's `retry()`: pages are client components that fetch in effects, so re-rendering refetches and no RSC refresh is needed. `RouteError` (`components/route-error.tsx`) is the shared body.
> - **Connection string is not `::add-mask::`ed.** The runner drops job outputs that contain a masked value ("Skip output … since it may contain secret"), so masking in `resolve-infra-outputs` would hand `deploy-web` an empty string. The value is public in the shipped bundle anyway. A missing Terraform output logs a warning and leaves telemetry off. `NEXT_PUBLIC_APPINSIGHTS_SAMPLING` comes from a GitHub environment variable.
> - **Still to verify after deploy:** the manual check below (browser `exceptions` row; fetch dependency sharing `operation_Id` with the Functions request). Cookies remain the SDK default pending open decision 1.


1. **Dependencies** (`apps/web`): `@microsoft/applicationinsights-web` + `@microsoft/applicationinsights-react-js` (for `ReactPlugin` and `AppInsightsErrorBoundary`).
2. **`src/lib/telemetry.ts`** (client-only, mirrors the Functions API)
   - Lazily `import()`s the SDK after hydration so it stays out of the critical bundle (protects LCP on the marketing page).
   - No-op on the server and when `NEXT_PUBLIC_APPLICATIONINSIGHTS_CONNECTION_STRING` is unset (local dev default).
   - Exports `trackEvent`, `trackException`, `setUser(userId)`, `clearUser()`.
   - Config: `enableAutoRouteTracking: true` (App Router uses `pushState`), `enableCorsCorrelation: true`, `correlationHeaderDomains: [<API host from NEXT_PUBLIC_API_URL>]`, `distributedTracingMode: W3C`, `enableUnhandledPromiseRejectionTracking: true`, `samplingPercentage` from `NEXT_PUBLIC_APPINSIGHTS_SAMPLING` (default 100).
   - Telemetry initializer that redacts `/api/images/{id}` paths: those ids are HMAC-signed capabilities and shouldn't sit in telemetry for 30 days.
3. **`src/components/telemetry-provider.tsx`** (`"use client"`), mounted in `app/layout.tsx` inside `AuthProvider`; calls `setUser` with the internal user id (never email) on sign-in, `clearUser` on sign-out.
4. **Error boundaries** (new)
   - `app/global-error.tsx`: last-resort boundary, reports to telemetry, renders a minimal page.
   - `app/(app)/error.tsx` and `app/(admin)/error.tsx`: report + render the existing `ErrorState` with a retry (`reset()`).
5. **Build wiring** (`.github/workflows/deploy.yml`)
   - `resolve-infra-outputs` also reads `application_insights_connection_string` (masked with `::add-mask::`) and passes it as `NEXT_PUBLIC_APPLICATIONINSIGHTS_CONNECTION_STRING` to the web build step. The connection string is public by design once shipped to browsers.
6. **Optional business events:** `polish.added_from_rapid_add`, `match.photo_submitted`, `search.color_wheel_used`. Only if useful; page views + errors are the core.

**Tests:** a `telemetry.test.ts` covering the no-op path and the image-URL redaction initializer. Manual verify: dev build with the connection string, throw from a test button, then confirm a browser `exceptions` row and a fetch dependency sharing `operation_Id` with the matching Functions request in **Transaction search**.

## Phase 3 — Alerts + availability (PR 3) — implemented

> **As built (differs from the original plan below):**
> - **Gating:** `alerts_enabled` (null → `true` prod, `false` otherwise) gates the action group, every alert rule **and** the availability tests (standard tests are billed per run, so dev gets none). `deploy-infra.yml` passes `TF_VAR_alerts_enabled` (`ALERTS_ENABLED` variable, else prod-only) and `TF_VAR_alert_email` (`ALERT_EMAIL` secret, else variable). An empty email still creates the rules (they show in the portal) and a `check` block warns on plan.
> - **API alert is 5xx-only:** `requests/failed` filtered to `request/resultCode` starting with `5`, > `alert_api_5xx_threshold` (5) in 5 min, evaluated every minute. Unfiltered `requests/failed` also counts 401/404s, which would page on normal traffic. Each 5xx code is its own series.
> - **Exception spike** is one workspace-scoped log alert over `AppExceptions`: `ClientType == "Browser"` → browser, everything else → server, each with its own threshold (server > 10, browser > 25 in 15 min) and split by the `ClientKind` dimension.
> - **Ingestion failures:** there was no ingestion telemetry to alert on, so `markIngestionJobFailed()` now emits an `ingestion.job_failed` custom event (`jobId`, error truncated to 500 chars). Every failure path (worker, AI batch poller, admin API) goes through it. Alert: any such event in 15 min.
> - **Daily cap:** the workspace logs `OverQuota` to `_LogOperation` (exempt from the cap) when its cap stops ingestion; a log alert on that covers D15. App Insights uses the same cap value and keeps its built-in cap emails.
> - **Availability:** two `azurerm_application_insights_standard_web_test`s (web home page on the custom domain, `GET /api/reference/finishes`) from 3 US locations every 5 min, expecting 200 and an SSL cert valid 7+ days; each has a metric alert that fires when 2+ locations fail. No `/api/health` endpoint was added.
> - Severities: availability and API 5xx are sev 1; exceptions, ingestion and daily cap are sev 2. All alerts auto-resolve.
> - **Owner to do:** set `ALERT_EMAIL` on the `prod` GitHub environment, then deploy infra; confirm the action group's confirmation email arrives.

All in Terraform, gated by `var.alerts_enabled` (default `true` prod, `false` dev):

| Alert | Resource | Signal |
|---|---|---|
| Action group | `azurerm_monitor_action_group.main` | email to `var.alert_email` |
| API failure rate | `azurerm_monitor_metric_alert` | App Insights `requests/failed` > N in 5 min |
| Exception spike (server + browser) | `azurerm_monitor_scheduled_query_rules_alert_v2` | `AppExceptions` count by `ClientType` over 15 min |
| Ingestion job failures | scheduled query alert | `ingestion_job` failure events or exceptions tagged `component=ingestion` |
| Availability | `azurerm_application_insights_standard_web_test` | web home page + a cheap API GET (e.g. `/api/reference/finishes`); no `/api/health` exists, could add one |
| Daily cap hit | `azurerm_monitor_activity_log_alert` / built-in cap notification | know when telemetry stops flowing |

Dashboards: start with the built-in **Failures**, **Performance**, **Application Map**, and **Users/Sessions** blades. Add a Workbook only if we find ourselves rerunning the same KQL.

## M2 success metrics (D19, #323)

Roadmap §4 (`docs/roadmap-2026-10-to-12.md`) metrics are measured two ways (decision D19): the dupe-warning funnel with browser custom events, because it only exists in the browser, and everything else with a weekly read-only Postgres query, because it is already in the DB.

**Browser events** (`apps/web/src/lib/metrics-events.ts`, through `trackEvent`, so they are off without a connection string). They carry counts and enum values only; the user is the internal id from `setUser`.

| Event | When | Properties |
|---|---|---|
| `dupe.warning_shown` | the add guard dialog opens with owned near-dupes, or the Rapid Add verdict card turns into "New to you — but close" | `surface` (`add_form` = adding to the collection, `wishlist` = adding to the wishlist, `rapid_add` = Rapid Add verdict card), `dupeCount`, `bestGrade` (`HIGH` / `MEDIUM`); add-guard extras: `page` (`polishes-list` / `color-search` / `photo-match` / `polish-form-create` / `polish-form-edit` / `looks` = ♡ on a Looks shopping-list step, `rapid-add` = the verdict card; the card sends `intent = own`, `via` = `button` / `scan_next` (Cancel) / `dupe_link`), `intent`, `shade` (catalog id or `new`), `verdict`, `highCount`, `bestFinishCompatibility`, `bestDistance` |
| `dupe.warning_outcome` | the user answers the dialog | the same, plus `outcome` = `cancel` / `wishlist_instead` / `add_anyway`, `via` (`button` / `dismiss` / `dupe_link`), `suppressed` |
| `mani.logged` | a new mani is saved (not edits) | `polishCount`, `via` (`quick` = one-tap button, `form`) |
| `import.completed` | a CSV import commits (a retried commit of the same session is not counted again) | `rowsCommitted` (= `created` + `updated`), `created`, `updated`, `skipped`, `failed`, `shadesCreated` |
| `looks.generated` | `/polishes/looks` shows a set of looks: first render, a vibe change, or Shuffle (once per URL state, after any catalog gap fill) | `occasion`, `mood`, `finish` (`any` when unset), `ownedOnly`, `includeToppers` (#386; `false` = the Include toppers switch is off), `undertone` (`cool`/`neutral`/`warm`, `none` when no skin tone is chosen), `depth` (`fair`…`deep`, `none`), `trigger` (`shuffle` = the Shuffle button; `vibe` = first render, a vibe change, or Back/Forward), `lookCount`, `ownedSteps`, `missingSteps`, `fullyOwnedLooks`, `ownedCount` (owned polishes considered), `shortfall` (fewer than 3 looks fit), `templates` (comma list of look template ids, e.g. `french-modern`) |
| `looks.wear_clicked` | "Wear this" on a look card or a saved look (opens the mani-log dialog prefilled with its owned polishes and roles; a saved mani still emits `mani.logged`) | `template`, `surface` (`card` / `saved`, #386), `position` (0-based card, or position in the Saved list), `ownedSteps`, `missingSteps`, `swapped` (any step swapped first) |
| `looks.color_lab_opened` | A look's "Color Lab" link to `/polishes/search` (#386) | `template`, `surface` (`card` / `drawer` / `saved`), `position`, `ownedSteps`, `missingSteps` |
| `onboarding.step_clicked` | a new user taps a way in: a row of the dashboard getting-started checklist, or the action of an empty state that needs a collection first | `step` (`import` / `scan` / `search`), `surface` (`dashboard_checklist`, `dashboard_stats_empty`, `polishes_empty` (empty My Collection), `manis_empty`, `gaps_empty`, `match_empty`), `ownedCount` (owned polishes at the time; 0 for every empty-state surface) |
| `match.image_processed` | `/polishes/match` shows results for a photo (#105): a new photo, a focused area, or a scope/finish/family change (also when served from the in-memory cache) | `trigger` (`upload` incl. drag-and-drop / `camera` / `region` / `filters`), `scope` (`owned` / `wishlist` / `catalog`), `finishFiltered`, `familyFilterCount`, `extractedColorCount`, `hiddenColorCount` (background/skin hidden by default), `candidateCount`, `matchCount` / `highCount` / `mediumCount` (flat list over the active colors), `cached`, `durationMs` (request round trip; absent when cached) |
| `match.result_action` | the user acts on a match row | `action` (`open` = detail link, `wishlist`, `remove_wishlist`, `own`, `status` (other menu status), `tried`, `quantity`), `scope`, `view` (`colors` / `list`), `confidence` of the row, `rank` (1-based in its list), `fromStatus` (`none` for a catalog-only shade). Wishlist/own from a row also goes through the add guard, so it can produce `dupe.warning_*` with `page = photo-match` |
| `collection.offline_shown` | the API was unreachable and a saved copy of the owned collection was shown instead (`/polishes` My Collection or an owned polish's detail page); once per saved copy, not per retry | `surface` (`list` / `detail`), `age` (age of the saved copy: `lt_1h` / `lt_1d` / `lt_3d` / `lt_7d`). Counts and enums only |
| `pwa.sw_installed` | the PWA service worker finished its first install (app shell precached; production builds only) | none |
| `pwa.sw_updated` | a new service worker is waiting and the "Update available" toast was shown (a new deploy reached an installed PWA) | none |
| `rapid_add.shelf_action` | Rapid Add shelf mode (#21): a quick action on a shelf entry, Clear shelf, or a repeat scan of a barcode already on the shelf | `action` (`add` / `wishlist` / `bought_another` / `manual` = Add manually link / `clear` / `repeat_scan`), `shelfSize` (entries on the shelf at the time), `verdict` of the entry when scanned (`owned` / `wishlist` / `near_dupe` / `new` / `not_found`; absent for `clear`) |

The `looks.*` events back the Looks plan's success metrics (`docs/looks-experience-plan.md` §1): owned-only completion (`fullyOwnedLooks` / `lookCount`), drop-off after a vibe (generated without a later `wear_clicked`), and repeat use. Time-to-first-look is not measured yet.

These replace the add guard's earlier `add_guard.shown` / `add_guard.choice` events; `add_guard.check_failed` stays. Rapid Add's verdict card emits the same two events with `surface = rapid_add` when a scanned barcode matches a shade the user doesn't own but owns HIGH/MEDIUM near-dupes of (`withNearDupes` in `lib/capture-verdict.ts`): `warning_shown` when the card appears, `warning_outcome` once per verdict (Add anyway = `add_anyway`, Wishlist instead = `wishlist_instead`, Cancel or a dupe link = `cancel`). The dupe lookup also honours the add guard's "don't warn again this session" flag and reports a failed or slow lookup as `add_guard.check_failed` (`page = rapid-add`).

Dupe funnel (target: > 20% of warnings end in `cancel` or `wishlist_instead`). `itemCount` keeps the numbers right under sampling. A warning closed by leaving the page has no outcome, so `answered` can be lower than `shown`.

```kusto
customEvents
| where timestamp > ago(7d)
| where name in ("dupe.warning_shown", "dupe.warning_outcome")
| extend surface = tostring(customDimensions.surface), outcome = tostring(customDimensions.outcome)
| summarize
    shown = sumif(itemCount, name == "dupe.warning_shown"),
    answered = sumif(itemCount, name == "dupe.warning_outcome"),
    avoided = sumif(itemCount, name == "dupe.warning_outcome" and outcome in ("cancel", "wishlist_instead")),
    add_anyway = sumif(itemCount, name == "dupe.warning_outcome" and outcome == "add_anyway")
    by surface
| extend avoided_pct = round(100.0 * avoided / shown, 1)
```

Use `bin(timestamp, 1d)` in the `by` clause for a daily trend, or `tostring(customDimensions.bestGrade)` to split HIGH from MEDIUM warnings.

**Weekly query:** `docs/queries/m2-metrics.sql` (`psql "$DATABASE_URL" -f docs/queries/m2-metrics.sql`) returns one row for the 7 days ending now (edit `params` to re-run an earlier week). An **active user** is anyone with a write in the window: an inventory row created or updated, a mani logged, or an import committed.

| Column(s) | Meaning | Target |
|---|---|---|
| `status_adoption_share` (`status_adopters` / `active_users`) | share of active users with at least one inventory row whose status isn't the default `owned`, or that is marked tried (untried is derived from `tried_at`). `avg_` / `median_non_default_share` show how much of each collection that covers | > 60% |
| `manis_per_active_user` (`manis_logged` / `active_users`) | manis created in the window (by `created_at`, whatever their `worn_on`) per active user; `users_logging_manis` counts the users behind them | ≥ 1 |
| `median_minutes_to_20`, `median_minutes_to_20_via_import` | for users who signed up in the last 28 days (`cohort_signups`), the time from `app_user.created_at` to their 20th non-wishlist inventory row (rows, not bottles); `cohort_reached_20` users got there. "Via import" = a committed CSV import by then | < 5 min (import path) |
| `active_shades`, `active_shades_added` | catalog shades with `status = 'active'` that aren't merged, and how many were created this week | +10k by 19 Dec |

Photo match (#105): result rate and what people do with matches.

```kusto
customEvents
| where timestamp > ago(7d)
| where name in ("match.image_processed", "match.result_action")
| extend scope = tostring(customDimensions.scope), action = tostring(customDimensions.action)
| summarize
    photos = sumif(itemCount, name == "match.image_processed" and tostring(customDimensions.trigger) in ("upload", "camera")),
    with_close_match = sumif(itemCount, name == "match.image_processed" and toint(customDimensions.highCount) > 0),
    opened = sumif(itemCount, action == "open"),
    wishlisted = sumif(itemCount, action == "wishlist"),
    owned = sumif(itemCount, action == "own"),
    p50_ms = percentile(todouble(customDimensions.durationMs), 50)
    by scope
```

`mani.logged` and `import.completed` in App Insights are a cross-check for the DB numbers (and show the one-tap vs. form split, which the DB doesn't record).

`onboarding.step_clicked` explains the time-to-20 number: which way in new users pick, and from where. Pair it with `median_minutes_to_20` from the weekly query.

```kusto
customEvents
| where timestamp > ago(7d) and name == "onboarding.step_clicked"
| extend step = tostring(customDimensions.step), surface = tostring(customDimensions.surface)
| summarize clicks = sum(itemCount), users = dcount(user_AuthenticatedId) by step, surface
| order by clicks desc
```

## Docs to update (per CLAUDE.md)

- `CLAUDE.md` env vars: `NEXT_PUBLIC_APPLICATIONINSIGHTS_CONNECTION_STRING`, `NEXT_PUBLIC_APPINSIGHTS_SAMPLING`, `CORS_ALLOWED_HEADERS` (and the Architecture Overview line on telemetry).
- `packages/functions/README.md`: telemetry section (init order, correlation, CORS headers).
- `apps/web/README.md`: telemetry provider + error boundaries.
- `infrastructure/README.md`: new variables, outputs, alert resources.
- `packages/functions/local.settings.json.example`: confirm `APPLICATIONINSIGHTS_CONNECTION_STRING` is present.

## Decisions (resolved 2026-10-17)

All four are decided. Full context is in [decisions-2026-10.md](decisions-2026-10.md), D14–D17. Phase 3 (#332) implements them.

1. **Cookies / consent** (D14): ✅ Keep the `ai_user` / `ai_session` cookies, with no consent banner. Known risk: EU ePrivacy rules generally expect consent for analytics cookies; revisit if EU traffic grows.
2. **Daily caps** (D15): ✅ 0.5 GB/day dev, 2 GB/day prod, with a cap-hit alert. Phase 3 lowered the Phase 1 `appinsights_daily_cap_gb` defaults (previously 5 prod / 1 otherwise).
3. **Alert email** (D16): ✅ Prod only (`alerts_enabled` defaults to `false` outside prod), emailing `var.alert_email` from the `ALERT_EMAIL` GitHub secret; the address is not committed in tfvars.
4. **Issue numbers** (D17): ✅ One tracking issue, #281.
