# Observability Plan — Application Insights for Functions + Web

**Status:** Phase 1 implemented (#282), Phase 2 implemented (#285); Phase 3 proposed (2026-10-17)
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
| Alerts | ❌ None (only App Insights' default smart detection) |
| Cost guard | ✅ `appinsights_daily_cap_gb` caps App Insights and Log Analytics daily ingestion (5 GB prod, 1 GB otherwise by default) |

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

## Phase 3 — Alerts + availability (PR 3)

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

## Docs to update (per CLAUDE.md)

- `CLAUDE.md` env vars: `NEXT_PUBLIC_APPLICATIONINSIGHTS_CONNECTION_STRING`, `NEXT_PUBLIC_APPINSIGHTS_SAMPLING`, `CORS_ALLOWED_HEADERS` (and the Architecture Overview line on telemetry).
- `packages/functions/README.md`: telemetry section (init order, correlation, CORS headers).
- `apps/web/README.md`: telemetry provider + error boundaries.
- `infrastructure/README.md`: new variables, outputs, alert resources.
- `packages/functions/local.settings.json.example`: confirm `APPLICATIONINSIGHTS_CONNECTION_STRING` is present.

## Open decisions

1. **Cookies / consent:** the browser SDK sets `ai_user` / `ai_session` cookies. Either keep them (needed for Users/Sessions analytics) or set `disableCookiesUsage: true` (errors + traces still work, user counts get fuzzy). Is a consent banner planned?
2. **Daily caps:** 1 GB/day dev, 5 GB/day prod. OK?
3. **Alert email:** which address, and prod only or dev too?
4. **Issue numbers:** branches should follow `feat/<issue#>-…`, so open one tracking issue or one per phase?
