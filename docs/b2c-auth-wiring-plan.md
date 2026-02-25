# Wire Azure AD B2C Auth in Web Client

## Context

M0 milestone (Auth + Inventory CRUD + Media Upload) is ~95% complete. The backend has production-ready B2C JWT validation (`packages/functions/src/lib/auth.ts`), but the web client still uses a hardcoded dev bypass (`Bearer dev:<userId>`) for all API calls. This plan wires real B2C authentication into the Next.js web app so it's ready when the B2C tenant is provisioned, while keeping dev bypass working for local development.

**Key constraint:** The app uses `output: "export"` (static SPA). No server-side middleware — all auth is client-side via MSAL Browser.

---

## Files to Create

| File | Purpose |
|------|---------|
| `apps/web/src/lib/msal-config.ts` | MSAL configuration builder from env vars; API scopes constant |
| `apps/web/src/components/auth-provider.tsx` | `AuthProvider` + `useAuth()` hook — three modes: dev bypass, B2C, unconfigured |
| `apps/web/src/components/auth-guard.tsx` | Client-side route guard for `(app)` routes |
| `apps/web/src/components/marketing-auth-buttons.tsx` | Auth-aware Sign In / Open App buttons for marketing header |

## Files to Modify

| File | Changes |
|------|---------|
| `apps/web/package.json` | Add `@azure/msal-browser`, `@azure/msal-react` |
| `apps/web/src/lib/api.ts` | Make `getAuthHeaders()` async, add `registerTokenProvider()` bridge |
| `apps/web/src/app/layout.tsx` | Wrap children with `<AuthProvider>` |
| `apps/web/src/app/(app)/layout.tsx` | Wrap with `<AuthGuard>` |
| `apps/web/src/app/(marketing)/layout.tsx` | Replace hardcoded nav buttons with `<MarketingAuthButtons>` |
| `apps/web/src/components/app-shell.tsx` | Show real user info + sign-out button via `useAuth()` |
| `CLAUDE.md` | Update env vars section, remove auth TODO from Known State |
| `apps/web/README.md` | Add new components + env vars |
| `.env.example` | Add `NEXT_PUBLIC_AZURE_AD_B2C_TENANT`, `NEXT_PUBLIC_AZURE_AD_B2C_CLIENT_ID` |

## Existing Assets to Reuse

- `packages/shared/src/types/user.ts` — `AuthConfig` type (authority, clientId, knownAuthorities, redirectUri, scopes)
- `packages/functions/src/functions/auth.ts` — `GET /api/auth/config` endpoint (returns B2C config JSON)
- `apps/web/src/components/brand-spinner.tsx` — loading state in auth guard
- `lucide-react` `LogOut` icon — for sign-out button in app-shell

---

## Implementation Steps

### 1. Install MSAL packages
```bash
npm install @azure/msal-browser @azure/msal-react --workspace=apps/web
```

### 2. Create `apps/web/src/lib/msal-config.ts`
- `buildMsalConfig()` — returns `Configuration | null` from env vars (`NEXT_PUBLIC_AZURE_AD_B2C_TENANT`, `NEXT_PUBLIC_AZURE_AD_B2C_CLIENT_ID`)
- Returns `null` when B2C isn't configured (graceful degradation)
- `API_SCOPES` constant — `["openid", "profile"]` initially (updated when B2C app registration adds custom API scope)
- Uses `localStorage` cache, `trailingSlash`-aware redirect URI (`window.location.origin + "/"`)
- B2C policy name `B2C_1_signupsignin` (convention)

### 3. Create `apps/web/src/components/auth-provider.tsx`
- Exports `AuthProvider` component and `useAuth()` hook
- `AuthContextValue`: `{ user, isAuthenticated, isLoading, isDevBypass, login, logout, getToken }`
- Three internal provider modes:
  - **DevBypassProvider** — when `NEXT_PUBLIC_AUTH_DEV_BYPASS === "true"`, provides synthetic user, `getToken` returns `"dev:<userId>"`
  - **UnconfiguredProvider** — when `buildMsalConfig()` returns null, provides unauthenticated state with console warning on login
  - **MsalAuthProvider** — wraps `MsalProvider`, handles `handleRedirectPromise()` on mount, listens for LOGIN_SUCCESS/LOGOUT_SUCCESS events, `getToken` calls `acquireTokenSilent` with `acquireTokenRedirect` fallback
- Module-level MSAL singleton (safe for static export SPA)
- Calls `registerTokenProvider(getToken)` from `api.ts` on mount

### 4. Make `getAuthHeaders()` async in `apps/web/src/lib/api.ts`
- Add `registerTokenProvider(fn)` — stores a module-level `_getTokenFn` callback
- `getAuthHeaders()` becomes `async` — checks dev bypass first, then calls `_getTokenFn()` for real token
- Update all ~20 call sites: `getAuthHeaders()` → `await getAuthHeaders()`, spread patterns become `...(await getAuthHeaders())`

### 5. Create `apps/web/src/components/auth-guard.tsx`
- Uses `useAuth()` — if dev bypass, render immediately; if loading, show `<BrandSpinner>`; if not authenticated, call `login()` and show spinner
- No server middleware (impossible with static export)

### 6. Update `apps/web/src/app/layout.tsx`
- Import and wrap `{children}` with `<AuthProvider>`
- Keeps root layout as server component (AuthProvider is a client component child)

### 7. Update `apps/web/src/app/(app)/layout.tsx`
- Wrap `<AppShell>` with `<AuthGuard>`
- Add `"use client"` directive

### 8. Update `apps/web/src/components/app-shell.tsx`
- Import `useAuth` + `LogOut` icon
- Replace hardcoded "SW" / "You" / "Collector workspace" with `user.displayName`, `user.email`, initials
- Replace disabled Settings button with Sign Out button calling `logout()`
- Add `getInitials()` helper

### 9. Create `apps/web/src/components/marketing-auth-buttons.tsx` + update marketing layout
- Client component using `useAuth()` — shows "Sign In" / "Get Started" when unauthenticated, "View Collection" / "Open App" when authenticated
- Update `apps/web/src/app/(marketing)/layout.tsx` — replace the hardcoded `<Link>` buttons in both desktop and mobile nav with `<MarketingAuthButtons>`

### 10. Update env vars + documentation
- `.env.example` — add B2C vars with empty defaults
- `CLAUDE.md` — update env vars table, update Known State to mark auth as wired
- `apps/web/README.md` — add new components and env vars

---

## Verification

1. **Dev bypass still works:** `NEXT_PUBLIC_AUTH_DEV_BYPASS=true` → app loads normally, API calls use `Bearer dev:1`, no MSAL initialization
2. **Unconfigured B2C graceful:** Set `NEXT_PUBLIC_AUTH_DEV_BYPASS=false` with no B2C vars → app loads, marketing pages work, `(app)` routes show unauthenticated state, console warns on login attempt
3. **Build succeeds:** `npm run build:web` completes without errors
4. **Type check passes:** `npm run typecheck` across all workspaces
5. **Lint passes:** `npm run lint`
6. **All existing API calls still work** in dev bypass mode (async getAuthHeaders doesn't break anything)
