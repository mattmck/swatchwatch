# Web App — `apps/web`

Next.js 16 (App Router) + Tailwind v4 + shadcn/ui.

## Running

```bash
# From repo root
npm run dev:web          # → http://localhost:3000
npm run build:web        # Production build
npm run test --workspace=apps/web   # Web unit tests
```

## Route Structure

```
src/app/
├── (marketing)/
│   ├── layout.tsx                → Marketing layout (branded sticky header, responsive mobile menu, footer)
│   └── page.tsx                  → /           Landing page (hero, features, interactive showcase, testimonials, CTA)
├── (admin)/
│   ├── error.tsx                 → Route-group error boundary (full-screen `RouteError`; the group has no layout)
│   └── admin/
│       ├── page.tsx              → /admin  Unified admin console (tabs: Configuration, Job Runs, Admin Jobs, User Management). Renders with RequireAuth + AppShell at the page level. The active tab lives in `?tab=` (deep-linkable; switching tabs updates it via `history.replaceState`); it is read with `useSearchParams()` inside a `<Suspense>` boundary so the static-export HTML never mismatches the client's first render.
│       └── reference-data/
│           ├── page.tsx          → /admin/reference-data  Legacy redirect → `/admin?tab=configuration`
│           └── components/
│               ├── jobs-tab.tsx  → Job Runs tab (list `/api/reference-admin/jobs`, status/error inspection, filtering)
│               ├── config-tab.tsx → Configuration tab (finish/harmony CRUD + finish-normalization alias CRUD)
│               └── users-tab.tsx → User Management tab (`/api/users-admin` list + `/api/users-admin/merge` repair flow)
├── (app)/
│   ├── layout.tsx                → App layout (AppShell sidebar wrapper)
│   ├── error.tsx                 → Route-group error boundary (renders `RouteError` inside the AppShell; retry = `reset()`)
│   ├── admin/jobs/page.tsx       → /admin/jobs      Legacy route redirect to `/admin?tab=admin-jobs`
│   ├── dashboard/
│   │   ├── page.tsx              → /dashboard       Stats, recent additions (computed from full paginated inventory; "By Finish" counts a multi-finish polish once per finish)
│   │   └── opengraph-image.tsx   → /dashboard OG image route
│   └── polishes/
│       ├── page.tsx              → /polishes         Global polish catalog + personal inventory overlay (server-side paging/filter/sort with URL-synced state; search is debounced 350ms and refetches keep the page mounted, dimming the table instead of swapping in a spinner; tone filter uses a fallback full-fetch path; single All/My Collection scope toggle; detail/edit flows carry `returnTo` context; swatch thumbnails open full image; admins see per-row "Recalc Hex" action)
│       ├── opengraph-image.tsx   → /polishes OG image route
│       ├── new/page.tsx          → /polishes/new     Add polish form (multi-select finish chips built from all reference finish types, so admin-added finishes are selectable; a polish's saved finishes missing from the list stay visible and selected on edit; first selected = primary finish, sent as `finishes` + legacy `finish`)
│       ├── detail/page.tsx       → /polishes/detail  Polish detail view + image preview + OKLCH profile + related shades
│       ├── gaps/page.tsx         → /polishes/gaps    Collection gap map heatmap (8 hue families × 5 lightness bands, missing/thin coverage, next-buy suggestions, deep-link into color search); loads owned rows first, then the shared catalog in the background for "Available To Add"
│       ├── match/
│       │   ├── page.tsx          → /polishes/match   Photo match: choose/drop/take a photo → client-side downscale (`lib/image-downscale.ts`) → `POST /api/polishes/match-image`; shows preview, extracted palette (click a swatch to filter matches to that color), and owned polishes ranked by OKLAB distance with confidence badges
│       │   ├── match-components.tsx → `ImageDropZone` (drag-and-drop + file picker + `capture` camera input), `ImagePreview`, `ExtractedPalette`, `ConfidenceBadge`, `MatchResultsList`
│       │   └── match-utils.ts    → Confidence badge metadata, match % (same 0.5 normalization as search), per-color filtering/counting
│       └── search/page.tsx       → /polishes/search  Color wheel search (two-column layout, collapsible wheel/harmonies, single full-width harmony-only selector with All mode, one-click swatch focus, focus workflow, standardized Brand/Tone/Finish/Availability dropdown filters)
├── global-error.tsx              → Last-resort error boundary for the root layout (own <html>/<body>, inline styles; reports via `trackException`)
├── layout.tsx                    → Root layout (fonts, metadata, AuthProvider → TelemetryProvider — no AppShell)
└── globals.css                   → Tailwind v4 + brand theme tokens + utility classes
```

**Route groups:**
- `(marketing)` — Public pages with branded sticky header + footer
- `(app)` — Authenticated app pages wrapped in `AppShell` (sidebar navigation)
- `(admin)` — Admin-only app routes that render with `RequireAuth` + `AppShell` at the page level

## Brand System

### Theme Tokens

All shadcn theme tokens in `globals.css` are mapped to the SwatchWatch brand palette (pink/purple). The palette source of truth is `packages/shared/src/branding/swatchwatch-brand.ts`.

**Brand palette Tailwind utilities:** `bg-brand-pink`, `text-brand-purple`, `border-brand-lilac`, etc.

### Typography

Inter is loaded via `next/font/google` in `src/app/layout.tsx` and applied globally with `font-sans` through the root `<body>` class.

Static text assets use the same Inter-first fallback stack:
- `public/brand/swatchwatch-wordmark.svg`
- `public/brand/swatchwatch-lockup.svg`
- `public/og-image.svg`

Shared heading scale utilities are defined in `src/app/globals.css` and reused across app routes:
- `heading-page` → page titles (`text-2xl font-bold tracking-tight`)
- `heading-section` → section headings (`text-lg font-semibold tracking-tight`)
- `heading-card` → card titles (`text-base font-medium`)

### Brand Utility Classes

| Class | Effect |
|-------|--------|
| `bg-gradient-brand` | 135deg pink → purple gradient |
| `bg-gradient-brand-soft` | 135deg pink-soft → lilac gradient |
| `bg-gradient-hero` | Hero section gradient (light/dark aware) |
| `text-gradient-brand` | Gradient text (pink → purple) |
| `text-gradient-brand-vertical` | Vertical gradient text |
| `shadow-glow-pink` | Pink glow box-shadow |
| `shadow-glow-purple` | Purple glow box-shadow |
| `shadow-glow-brand` | Combined pink/purple glow |
| `glass` | Frosted glass effect (backdrop-blur, semi-transparent) |
| `marketing-surface` | Shared marketing panel surface (rounded border, card tint, soft brand shadow) |
| `marketing-surface-soft` | Softer accent panel for highlight blocks and active marketing states |
| `marketing-kicker` | Uppercase section label styling for marketing headings |
| `shimmer` | Animated shimmer sweep overlay |

### Brand Components (`src/components/brand/`)

| Component | Purpose |
|-----------|---------|
| `SwatchWatchIcon` | Renders SVG brand icons (monogram, app, swatch, brush) |
| `SwatchWatchSpriteIcon` | Renders symbols from `public/brand/swatchwatch-sprite.svg` for sprite-based icon usage |
| `SwatchWatchWordmark` | Icon + styled "SwatchWatch" text with theme-aware contrast in light/dark modes |
| `SwatchWatchGraphicSet` | All 4 icons in a row |

## Components

### Custom (`src/components/`)

| Component | Purpose |
|-----------|---------|
| `app-shell.tsx` | Sidebar navigation (desktop) + header nav (mobile) with exact active-route matching, branded active-nav pills, logo accent divider, app theme toggle, and `<UserCard>` footer with auth state. A single Admin link (`/admin`) is shown only for admin users & Gap Map and Photo Match routes in primary navigation |
| `auth-provider.tsx` | MSAL provider wrapper with three modes: dev bypass (no MSAL), B2C via MSAL, unconfigured fallback. Manages token lifecycle and stores in module-level `auth-token.ts` |
| `require-auth.tsx` | Route guard for `(app)` routes. Dev bypass → render children; B2C unconfigured → show "Sign in" button; B2C authenticated → render children; unauthenticated → show "Sign in" button |
| `user-card.tsx` | Sidebar footer: displays user initials, name, email, and sign-out button. Conditionally uses `useAuth()` (B2C) or `useDevAuth()` (dev bypass) |
| `marketing-auth-button.tsx` | Header auth button: "Open App" when authenticated, "Sign In" when unauthenticated (B2C), always "Open App" in dev bypass |
| `brand-spinner.tsx` | Branded loading state with animated monogram spinner used across app route fallbacks |
| `error-state.tsx` | Reusable error card with destructive accent styling and optional retry action |
| `route-error.tsx` | `<RouteError error reset boundary />` — shared body of the route-group `error.tsx` boundaries: reports the error with `trackException` (`boundary`, `digest` properties) and renders `ErrorState` with `reset()` as the retry |
| `telemetry-provider.tsx` | Mounted in the root layout inside `AuthProvider`. Starts browser telemetry after hydration and tags it with the internal user id (resolved once per signed-in account via `POST /api/auth/validate`; never the email), clearing it on sign-out. Renders nothing extra when telemetry is off |
| `empty-state.tsx` | Reusable empty-state card with brand icon treatment and optional CTA |
| `marketing-color-showcase.tsx` | Interactive landing-page color harmony demo with mini wheel, connected swatch nodes, and animated suggested set tiles |
| `marketing-theme-toggle.tsx` | Reusable system/light/dark theme selector used in marketing and authenticated app shells |
| `color-dot.tsx` | Colored circle swatch (`sm`/`md`/`lg`) with subtle hover scale micro-interaction |
| `color-wheel.tsx` | Canvas HSL color wheel with hover preview, click selection, owned-shade snap mode, and glow-forward selected marker |
| `finish-badges.tsx` | `<FinishBadges polish finishTypes? max? empty? />` — one branded badge per finish (multi-finish shades show several, overflow collapses into `+N`), falling back to the legacy single `finish`. Pass `finishTypes` (from `useReferenceData()`) to label badges with the reference `displayName`. Used by the polish table, detail page, dashboard recent additions, and color search results |
| `color-search-results.tsx` | Polish list sorted by OKLAB color distance, with branded finish badges, high-contrast focus-state swatch highlights, and harmony interactions (palette selection affects table targeting without mutating focused colors) |
| `private-image.tsx` | `<PrivateImage src alt className? fallback? />` — renders owner-scoped private image ids (a `/api/images/v3.` path that is relative or on the API base URL's origin) by fetching them with the user's bearer token and showing an object URL, since `<img>` cannot send `Authorization`. Public URLs (including catalog `v2.` ids) render as a plain `<img>`; while loading it shows a neutral `aria-busy` placeholder, and on 401/403/error it shows `fallback` or an empty `role="img"` placeholder. Not wired into any page yet: switch image consumers to it when the API starts emitting `v3` ids for user media (#270) |

### shadcn/ui (`src/components/ui/`)

Installed components: `badge`, `button`, `card`, `dialog`, `dropdown-menu`, `input`, `select`, `separator`, `sonner`, `table`.

`button` includes a reusable `brand` variant for gradient CTAs shared across marketing and app surfaces.

`src/components/ui/sonner.tsx` provides the branded toast wrapper mounted in `src/app/layout.tsx`.

Add more with:
```bash
cd apps/web && npx shadcn@latest add <component-name>
```


## Auth System

**Dev Bypass Mode** (`NEXT_PUBLIC_AUTH_DEV_BYPASS=true`):
- Skips MSAL initialization entirely
- `getAuthHeaders()` returns `Bearer dev:1` (or `Bearer dev:2` for admin calls)
- All MSAL-dependent components render fallback/stub states

**B2C Mode** (when `NEXT_PUBLIC_B2C_TENANT` and `NEXT_PUBLIC_B2C_CLIENT_ID` are set):
- MSAL initializes via `PublicClientApplication` in `auth-provider.tsx`
- Login requests include OIDC scopes plus an API scope (`api://<client-id>/access_as_user` by default)
- User signs in → token stored in module-level `auth-token.ts`
- `getAuthHeaders()` reads token and sends it in `Authorization` header
- `<RequireAuth>` guard on `(app)` routes triggers login redirect if unauthenticated
- `<UserCard>` displays user info and sign-out button in sidebar

**Deterministic sign-out:** `useAuth().logout()` calls `logoutRedirect()` with explicit parameters so behavior is consistent in multi-account browser sessions:
- `account` — the active account (`getActiveAccount()`, falling back to the first cached account), so MSAL signs out the specific SwatchWatch session instead of prompting "which account to sign out of"
- `postLogoutRedirectUri` — `window.location.origin + "/"`, returning the user to the app root
- `logoutHint` — sourced from the account's `login_hint` optional claim when present (recommended), falling back to `account.username`, which can let the IdP skip the account picker entirely

This works for both `ciamlogin.com` (External ID) and `b2clogin.com` (legacy B2C) authorities. For the most reliable promptless logout, configure the `login_hint` optional claim on the Entra app registration so it is emitted in the ID token.

**Hooks:**
- `useAuth()` — B2C mode only, calls MSAL hooks (`useMsal`, `useIsAuthenticated`). Returns `{ isAuthenticated, user, role, isAdmin, login, logout }`. Must be inside `<MsalProvider>`
- `useDevAuth()` — Dev bypass stub, safe to call anywhere. Returns stubbed auth state with admin role for local testing
- `useUnconfiguredAuth()` — B2C-unconfigured stub, safe to call anywhere. Returns unauthenticated non-admin state

## Utilities (`src/lib/`)

| File | Exports |
|------|---------|
| `utils.ts` | `cn()` — Tailwind class merging (shadcn standard) |
| `constants.ts` | `FINISHES` (re-export of the shared built-in `CANONICAL_FINISHES` defaults), `finishLabel()`, `finishBadgeClassName()` — fallback finish taxonomy and branded badge styling when reference APIs are unavailable |
| `finish-options.ts` | `buildFinishOptions(finishTypes, extraValues?)`, `knownFinishNames()`, `resolveFinishLabel()` — finish select/chip options and labels built from ALL reference `finish_type` rows (including admin-added, non-built-in types), falling back to `FINISHES` only when reference data is empty; `extraValues` keeps a polish's saved finishes selectable when they are missing from the list |
| `admin-tabs.ts` | `ADMIN_TABS`, `AdminTab`, `getTabFromQuery()` (unknown/missing `?tab=` → `configuration`), `buildAdminTabSearch()` — `/admin` tab ↔ query-string mapping |
| `color-harmonies.ts` | Harmony palette generation + `getHarmonyTypeOptions()` for API-backed harmony option mapping (with fallback constants) |
| `color-utils.ts` | Hex↔HSL↔RGB↔OKLAB↔OKLCH conversions, `colorDistance()`, harmony helpers, undertone breakdown, and `analyzeCollectionGaps()`. The forward OKLAB math (`rgbToOklab`, `hexToOklab`, `oklabDistance`, `colorDistance`, `OKLab`) is re-exported from `swatchwatch-shared` so it matches the Functions API exactly |
| `api.ts` | API client helpers (plus the exported `API_BASE_URL` and `getAuthHeaders()`) including polish CRUD, rapid-add capture calls, ingestion admin methods (`listIngestionJobs`, `runIngestionJob`, `getIngestionJob`), reference-data admin methods (`listAdminJobs`, finish/harmony CRUD, finish-normalization CRUD), user-management admin methods (`listAdminUsers`, `mergeAdminUsers`), public reference lookup methods (`listReferenceFinishTypes`, `listReferenceHarmonyTypes`), and `matchPolishesToImage()` for photo matching |
| `private-image.ts` | `isPrivateImageUrl(url, apiOrigin?)` (true when the path starts with `/api/images/v3.` and the URL is relative or on the origin of `api.ts`'s `API_BASE_URL`; the same path on any other host is treated as public, so the bearer token is never sent there), `usePrivateImage(url)` → `{ status: "idle" \| "loading" \| "ready" \| "denied" \| "error", objectUrl }` — fetches private ids with `getAuthHeaders()` (dev-bypass token included), returns an object URL that is revoked on unmount or url change, and ignores stale responses via `AbortController`. Non-private URLs return `idle` so callers render the plain URL. `loadPrivateImage()` / `classifyPrivateImageResponse()` are the framework-agnostic pieces the hook uses |
| `image-downscale.ts` | `downscaleImageFile()` — browser canvas downscale (longest edge `MATCH_IMAGE_MAX_EDGE` = 640px, JPEG for photos / PNG when the source may have alpha) returning a data URL + dimensions; `computeScaledSize()` / `outputMimeTypeFor()` pure helpers |
| `polish-filters.ts` | `buildBrandOptions()`, `filterPolishesForList()`, `matchesBrandFilter()` — shared catalog/search filter helpers with normalized brand matching |
| `hooks/use-reference-data.ts` | API-backed reference data hook with in-memory + localStorage caching, resilient fallback data, and lookup helpers (`getFinishDisplayName`, `getHarmonyDisplayName`) |
| `msal-config.ts` | `buildMsalConfig()` builder, `LOGIN_SCOPES` constant. Returns `null` if auth env is not configured |
| `auth-token.ts` | Module-level token store: `setAccessToken()`, `getAccessToken()` |
| `telemetry.ts` | Browser Application Insights wrapper mirroring the Functions API: `trackEvent()`, `trackException()`, `setUser(userId)`, `clearUser()`, `initTelemetry()`. Lazy `import()`s `@microsoft/applicationinsights-web` (own chunk, out of the critical bundle) and queues calls until it loads; no-op on the server and without a connection string. Config: auto route tracking, W3C correlation limited to the `NEXT_PUBLIC_API_URL` host, unhandled-rejection tracking, sampling. A telemetry initializer (`redactImageUrlsInitializer`) replaces `/api/images/{id}` ids with `[redacted]` |

## Metadata & Assets

| Asset | Location | Notes |
|-------|----------|-------|
| Favicon (SVG) | `public/brand/swatchwatch-monogram.svg` | Referenced via metadata `icons` config |
| Apple Touch Icon | `public/apple-touch-icon.png` | 180x180 PNG from app icon SVG |
| OG Image | `public/og-image.png` | 1200x630 branded social preview |
| OG Variants | `src/app/(app)/dashboard/opengraph-image.tsx`, `src/app/(app)/polishes/opengraph-image.tsx` | Route-specific social previews for dashboard and collection |
| Manifest | `public/manifest.json` | PWA manifest with brand colors |
| Brand SVGs | `public/brand/` | Monogram, wordmark, lockup, swatch, brush, app icon, sprite sheet |

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `NEXT_PUBLIC_API_URL` | API base URL used by `src/lib/api.ts` |
| `NEXT_PUBLIC_APPLICATIONINSIGHTS_CONNECTION_STRING` | Enables browser telemetry (`src/lib/telemetry.ts`). Unset = no-op (local dev default). Set at build time by `deploy.yml` from the Terraform output `application_insights_connection_string` |
| `NEXT_PUBLIC_APPINSIGHTS_SAMPLING` | Browser telemetry sampling percentage, `(0, 100]`; default `100` |
| `NEXT_PUBLIC_AUTH_DEV_BYPASS` | Dev-only bypass toggle. When `true`, the UI sends `Authorization: Bearer dev:1` on authenticated API calls. Set to `false` for production or to test B2C auth locally |
| `NEXT_PUBLIC_AUTH_DEV_ADMIN_USER_ID` | Optional admin dev bypass user id for admin-only API calls (`/admin/reference-data` and `/admin/jobs` flows; defaults to `2`). Ignored when `NEXT_PUBLIC_AUTH_DEV_BYPASS=false` |
| `NEXT_PUBLIC_B2C_TENANT` | Entra tenant short name (e.g., `myorgdev`). Empty or missing → auth skipped, unconfigured fallback mode. When set with `NEXT_PUBLIC_B2C_CLIENT_ID` → MSAL initialized |
| `NEXT_PUBLIC_B2C_TENANT_ID` | Entra External ID (CIAM) tenant GUID. Required for CIAM tenants: the MSAL authority becomes `https://<tenant>.ciamlogin.com/<tenant-id>` so the metadata issuer (`https://<tenant-id>.ciamlogin.com/<tenant-id>/v2.0`) passes msal-browser 5.x issuer validation. When omitted for a CIAM policy, MSAL is not initialized and the app uses unconfigured-auth mode. Unused for legacy `B2C_1*` policies |
| `NEXT_PUBLIC_B2C_CLIENT_ID` | Entra app registration client ID. Must be set alongside `NEXT_PUBLIC_B2C_TENANT` to enable auth |
| `NEXT_PUBLIC_B2C_API_SCOPE` | Optional API scope(s) for access tokens (space-delimited). Defaults to `api://<NEXT_PUBLIC_B2C_CLIENT_ID>/access_as_user` when unset |
| `NEXT_PUBLIC_B2C_SIGNUP_SIGNIN_POLICY` | Policy/user-flow selector. If it starts with `B2C_1`, the app uses legacy `b2clogin.com` policy authority. Otherwise it uses `ciamlogin.com` authority and sends `p=<value>` query parameter on auth/token requests (for External ID tenants). |

**Note:** When both `NEXT_PUBLIC_B2C_TENANT` and `NEXT_PUBLIC_B2C_CLIENT_ID` are empty, the app runs in **unconfigured mode**: marketing pages work, but `(app)` routes show a "Sign in" prompt that warns the user B2C is not configured.

## Telemetry & Error Boundaries

Browser telemetry goes to the same Application Insights resource as the Functions API (plan: `docs/observability-plan.md`).

- **Off by default.** `src/lib/telemetry.ts` does nothing unless `NEXT_PUBLIC_APPLICATIONINSIGHTS_CONNECTION_STRING` is set at build time. To try it locally, put the dev connection string in `apps/web/.env.local` and restart `next dev`.
- **What's collected:** page views (initial + App Router `pushState` navigations), unhandled errors and promise rejections, `fetch` dependencies, and anything sent through `trackEvent` / `trackException`. Requests to the `NEXT_PUBLIC_API_URL` host carry a W3C `traceparent`, so a browser fetch and the Functions request it hits share one `operation_Id` in **Transaction search**. No other origin gets correlation headers (B2C and blob storage would reject them on preflight).
- **Privacy:** telemetry carries the internal user id only (never the email), and `/api/images/{id}` capability ids are redacted. The SDK sets its default `ai_user` / `ai_session` cookies; whether to keep them (or set `disableCookiesUsage: true` in `buildTelemetryConfig`) is an open decision.
- **Error boundaries:** `(app)/error.tsx` and `(admin)/error.tsx` report via `trackException` and show `ErrorState` with a retry (`reset()` re-renders the segment; the pages fetch client-side, so that refetches too). `app/global-error.tsx` catches root-layout failures. They're all client components, so they work with `output: "export"`.

## Conventions

- **Path alias:** `@/*` maps to `src/*` (configured in `tsconfig.json`)
- **Types:** Import domain types from `swatchwatch-shared`, not local redefinitions
- **Styling:** Tailwind v4 utility classes. CSS variables for theming in `globals.css`. Inline `style` only for dynamic color values (e.g. `backgroundColor: polish.colorHex`)
- **Client components:** Pages with interactivity use `"use client"` directive. Server components used where possible (e.g. `polishes/[id]/page.tsx`)
- **Data:** All pages now use the live API. The old `mock-data.ts` is no longer used.
