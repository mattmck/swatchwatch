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
│   └── admin/
│       ├── page.tsx              → /admin  Unified admin console (tabs: Configuration, Job Runs, Admin Jobs)
│       └── reference-data/
│           ├── page.tsx          → /admin/reference-data  Legacy route redirect to `/admin?tab=configuration`
│           └── components/
│               ├── jobs-tab.tsx  → Jobs tab (list `/api/reference-admin/jobs`, status/error inspection, filtering)
│               └── config-tab.tsx → Configuration tab (finish/harmony CRUD + finish-normalization alias CRUD)
├── (app)/
│   ├── layout.tsx                → App layout (AppShell sidebar wrapper)
│   ├── admin/jobs/page.tsx       → /admin/jobs      Legacy route redirect to `/admin?tab=admin-jobs`
│   ├── dashboard/
│   │   ├── page.tsx              → /dashboard       Stats, recent additions (computed from full paginated inventory)
│   │   └── opengraph-image.tsx   → /dashboard OG image route
│   └── polishes/
│       ├── page.tsx              → /polishes         Global polish catalog + personal inventory overlay (hydrates all API pages for client-side search/filter + sortable headers; single All/My Collection scope toggle; persists page/filter/sort state in URL query params for back-navigation restore; detail/edit flows carry `returnTo` context; swatch thumbnails open full image; admins see per-row "Recalc Hex" action)
│       ├── opengraph-image.tsx   → /polishes OG image route
│       ├── new/page.tsx          → /polishes/new     Add polish form
│       ├── detail/page.tsx       → /polishes/detail  Polish detail view + image preview + OKLCH profile + related shades
│       ├── gaps/page.tsx         → /polishes/gaps    Collection gap map heatmap (8 hue families × 5 lightness bands, missing/thin coverage, next-buy suggestions, deep-link into color search)
│       └── search/page.tsx       → /polishes/search  Color wheel search (two-column layout, collapsible wheel/harmonies, single full-width harmony-only selector with All mode, one-click swatch focus, focus workflow, standardized Brand/Tone/Finish/Availability dropdown filters)
├── layout.tsx                    → Root layout (fonts, metadata — no AppShell)
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
| `app-shell.tsx` | Sidebar navigation (desktop) + header nav (mobile) with exact active-route matching, branded active-nav pills, logo accent divider, app theme toggle, and `<UserCard>` footer with auth state. A single Admin link (`/admin`) is shown only for admin users & Gap Map route in primary navigation |
| `auth-provider.tsx` | MSAL provider wrapper with three modes: dev bypass (no MSAL), B2C via MSAL, unconfigured fallback. Manages token lifecycle and stores in module-level `auth-token.ts` |
| `require-auth.tsx` | Route guard for `(app)` routes. Dev bypass → render children; B2C unconfigured → show "Sign in" button; B2C authenticated → render children; unauthenticated → show "Sign in" button |
| `user-card.tsx` | Sidebar footer: displays user initials, name, email, and sign-out button. Conditionally uses `useAuth()` (B2C) or `useDevAuth()` (dev bypass) |
| `marketing-auth-button.tsx` | Header auth button: "Open App" when authenticated, "Sign In" when unauthenticated (B2C), always "Open App" in dev bypass |
| `brand-spinner.tsx` | Branded loading state with animated monogram spinner used across app route fallbacks |
| `error-state.tsx` | Reusable error card with destructive accent styling and optional retry action |
| `empty-state.tsx` | Reusable empty-state card with brand icon treatment and optional CTA |
| `marketing-color-showcase.tsx` | Interactive landing-page color harmony demo with mini wheel, connected swatch nodes, and animated suggested set tiles |
| `marketing-theme-toggle.tsx` | Reusable system/light/dark theme selector used in marketing and authenticated app shells |
| `color-dot.tsx` | Colored circle swatch (`sm`/`md`/`lg`) with subtle hover scale micro-interaction |
| `color-wheel.tsx` | Canvas HSL color wheel with hover preview, click selection, owned-shade snap mode, and glow-forward selected marker |
| `color-search-results.tsx` | Polish list sorted by OKLAB color distance, with branded finish badges, high-contrast focus-state swatch highlights, and harmony interactions (palette selection affects table targeting without mutating focused colors) |

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

**Hooks:**
- `useAuth()` — B2C mode only, calls MSAL hooks (`useMsal`, `useIsAuthenticated`). Returns `{ isAuthenticated, user, role, isAdmin, login, logout }`. Must be inside `<MsalProvider>`
- `useDevAuth()` — Dev bypass stub, safe to call anywhere. Returns stubbed auth state with admin role for local testing
- `useUnconfiguredAuth()` — B2C-unconfigured stub, safe to call anywhere. Returns unauthenticated non-admin state

## Utilities (`src/lib/`)

| File | Exports |
|------|---------|
| `utils.ts` | `cn()` — Tailwind class merging (shadcn standard) |
| `constants.ts` | `FINISHES`, `finishLabel()`, `finishBadgeClassName()` — fallback finish taxonomy and branded badge styling when reference APIs are unavailable |
| `color-harmonies.ts` | Harmony palette generation + `getHarmonyTypeOptions()` for API-backed harmony option mapping (with fallback constants) |
| `color-utils.ts` | Hex↔HSL↔RGB↔OKLAB↔OKLCH conversions, `colorDistance()`, harmony helpers, undertone breakdown, and `analyzeCollectionGaps()` |
| `api.ts` | API client helpers including polish CRUD, rapid-add capture calls, ingestion admin methods (`listIngestionJobs`, `runIngestionJob`, `getIngestionJob`), reference-data admin methods (`listAdminJobs`, finish/harmony CRUD, finish-normalization CRUD), and public reference lookup methods (`listReferenceFinishTypes`, `listReferenceHarmonyTypes`) |
| `polish-filters.ts` | `buildBrandOptions()`, `filterPolishesForList()`, `matchesBrandFilter()` — shared catalog/search filter helpers with normalized brand matching |
| `hooks/use-reference-data.ts` | API-backed reference data hook with in-memory + localStorage caching, resilient fallback data, and lookup helpers (`getFinishDisplayName`, `getHarmonyDisplayName`) |
| `msal-config.ts` | `buildMsalConfig()` builder, `LOGIN_SCOPES` constant. Returns `null` if auth env is not configured |
| `auth-token.ts` | Module-level token store: `setAccessToken()`, `getAccessToken()` |

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
| `NEXT_PUBLIC_AUTH_DEV_BYPASS` | Dev-only bypass toggle. When `true`, the UI sends `Authorization: Bearer dev:1` on authenticated API calls. Set to `false` for production or to test B2C auth locally |
| `NEXT_PUBLIC_AUTH_DEV_ADMIN_USER_ID` | Optional admin dev bypass user id for admin-only API calls (`/admin/reference-data` and `/admin/jobs` flows; defaults to `2`). Ignored when `NEXT_PUBLIC_AUTH_DEV_BYPASS=false` |
| `NEXT_PUBLIC_B2C_TENANT` | Entra tenant short name (e.g., `myorgdev`). Empty or missing → auth skipped, unconfigured fallback mode. When set with `NEXT_PUBLIC_B2C_CLIENT_ID` → MSAL initialized |
| `NEXT_PUBLIC_B2C_CLIENT_ID` | Entra app registration client ID. Must be set alongside `NEXT_PUBLIC_B2C_TENANT` to enable auth |
| `NEXT_PUBLIC_B2C_API_SCOPE` | Optional API scope(s) for access tokens (space-delimited). Defaults to `api://<NEXT_PUBLIC_B2C_CLIENT_ID>/access_as_user` when unset |
| `NEXT_PUBLIC_B2C_SIGNUP_SIGNIN_POLICY` | Policy/user-flow selector. If it starts with `B2C_1`, the app uses legacy `b2clogin.com` policy authority. Otherwise it uses `ciamlogin.com` authority and sends `p=<value>` query parameter on auth/token requests (for External ID tenants). |

**Note:** When both `NEXT_PUBLIC_B2C_TENANT` and `NEXT_PUBLIC_B2C_CLIENT_ID` are empty, the app runs in **unconfigured mode**: marketing pages work, but `(app)` routes show a "Sign in" prompt that warns the user B2C is not configured.

## Conventions

- **Path alias:** `@/*` maps to `src/*` (configured in `tsconfig.json`)
- **Types:** Import domain types from `swatchwatch-shared`, not local redefinitions
- **Styling:** Tailwind v4 utility classes. CSS variables for theming in `globals.css`. Inline `style` only for dynamic color values (e.g. `backgroundColor: polish.colorHex`)
- **Client components:** Pages with interactivity use `"use client"` directive. Server components used where possible (e.g. `polishes/[id]/page.tsx`)
- **Data:** All pages now use the live API. The old `mock-data.ts` is no longer used.
