# M0 Completion Plan — Auth + Inventory CRUD + Media Upload

_Date: 2026-02-17_
_Branch baseline: `dev` @ `d7f6345`_
_Milestone definition: [mvp-backlog.md](./mvp-backlog.md) — "M0 (Week 1–2): Auth + inventory CRUD + media upload"_

## Current State

M0 is ~90-95% complete. What's shipped:

- 9 DB migrations via `node-pg-migrate` (schema, seed data, admin roles)
- `packages/functions/src/lib/db.ts` — Postgres pool helper with transactions
- `packages/functions/src/lib/auth.ts` — dual-mode auth (dev bypass + B2C JWT via `jose`)
- `packages/functions/src/functions/auth.ts` — `POST /api/auth/validate`, `GET /api/auth/config`
- `packages/functions/src/functions/polishes.ts` — full CRUD: `GET/POST/PUT/DELETE /api/polishes`
- `packages/functions/src/functions/catalog.ts` — `GET /api/catalog/search`, `GET /api/catalog/shade/{id}`
- `packages/functions/src/functions/capture.ts` — capture/rapid-add flow with resolver + question loop
- `packages/functions/src/lib/blob-storage.ts` — blob upload + SAS URL generation
- `packages/functions/src/lib/http.ts` — CORS middleware
- Web app: all pages connected to real API (dashboard, polishes list/detail/new, search, rapid-add, admin/jobs)
- CI pipeline (`ci.yml`) + dev deploy (`deploy-dev.yml`)
- Shared types in `packages/shared` aligned with schema

## What Remains

Seven phases, in priority order. Each phase includes exact file paths, line numbers, code snippets, and pitfalls to avoid.

---

## Phase 1: Web B2C Auth Integration

**Goal:** Users sign in via Azure AD B2C. App acquires a real JWT and sends it to the API. Dev bypass still works for local dev.

### Pitfalls from a prior failed attempt

A previous implementation attempt had these bugs — avoid them:

1. **Double import of `PublicClientApplication`** — imported once as a type and once as a value in the same file, causing a TS error. Pick one.
2. **MSAL hooks called outside MsalProvider** — `useIsAuthenticated()`, `useMsal()`, `useAccount()` from `@azure/msal-react` **throw** if there is no `<MsalProvider>` ancestor. In dev bypass mode there is no `MsalProvider`, so calling these hooks crashes the app. The hooks must be conditionally rendered inside a component that is only mounted when MSAL is active.
3. **Overly complex API wrapper** — creating a `useApi()` hook that wraps every API function in `useCallback` with an `accessToken` param creates a huge parallel surface. Instead, use a **module-level token variable** that `getAuthHeaders()` reads automatically. Components set the token; API functions don't need signature changes.

### Step 1.1: Install MSAL packages

```bash
cd apps/web && npm install @azure/msal-browser @azure/msal-react
```

This adds two dependencies to `apps/web/package.json`. Verify with `npm ls @azure/msal-browser`.

### Step 1.2: Create `apps/web/src/lib/auth-config.ts`

**New file.** MSAL configuration loader.

```ts
import { LogLevel, type Configuration } from "@azure/msal-browser";

/**
 * Build MSAL configuration from environment variables.
 * Returns null if B2C is not configured (dev bypass mode).
 */
export function buildMsalConfig(): Configuration | null {
  const tenant = process.env.NEXT_PUBLIC_B2C_TENANT;
  const clientId = process.env.NEXT_PUBLIC_B2C_CLIENT_ID;
  const policy =
    process.env.NEXT_PUBLIC_B2C_SIGNUP_SIGNIN_POLICY || "B2C_1_signupsignin";

  if (!tenant || !clientId) {
    return null;
  }

  return {
    auth: {
      clientId,
      authority: `https://${tenant}.b2clogin.com/${tenant}.onmicrosoft.com/${policy}`,
      knownAuthorities: [`${tenant}.b2clogin.com`],
      redirectUri: typeof window !== "undefined" ? window.location.origin : "/",
      navigateToLoginRequestUrl: true,
    },
    cache: {
      cacheLocation: "localStorage",
      storeAuthStateInCookie: false,
    },
    system: {
      loggerOptions: {
        loggerCallback: (_level: LogLevel, message: string) => {
          if (
            _level === LogLevel.Error ||
            _level === LogLevel.Warning
          ) {
            console.warn(`[MSAL] ${message}`);
          }
        },
      },
    },
  };
}

/** Scopes used for login and token acquisition. */
export const LOGIN_SCOPES = ["openid", "profile", "offline_access"];
```

**Key points:**
- Returns `null` when env vars are missing — caller uses this to decide dev bypass vs MSAL
- Does NOT import `PublicClientApplication` — that happens in the provider
- Only uses the `type` import for `Configuration`, and the value import for `LogLevel`

### Step 1.3: Create `apps/web/src/lib/auth-token.ts`

**New file.** Module-level token store. This is the simplest way to thread the access token to `getAuthHeaders()` without changing every API function signature.

```ts
/**
 * Module-level access token store.
 * Set by the AuthProvider when MSAL acquires a token.
 * Read by getAuthHeaders() in api.ts.
 */
let _accessToken: string | null = null;

export function setAccessToken(token: string | null): void {
  _accessToken = token;
}

export function getAccessToken(): string | null {
  return _accessToken;
}
```

### Step 1.4: Update `apps/web/src/lib/api.ts` — `getAuthHeaders()`

**File:** `apps/web/src/lib/api.ts`
**Lines:** 33-42

Replace the existing `getAuthHeaders` function:

```ts
// BEFORE (lines 33-42):
function getAuthHeaders(options?: { admin?: boolean }): Record<string, string> {
  if (process.env.NEXT_PUBLIC_AUTH_DEV_BYPASS === "true") {
    const devUserId = options?.admin
      ? process.env.NEXT_PUBLIC_AUTH_DEV_ADMIN_USER_ID || "2"
      : "1";
    return { Authorization: `Bearer dev:${devUserId}` };
  }
  // TODO: read real token from auth state once B2C is wired up
  return {};
}

// AFTER:
import { getAccessToken } from "./auth-token";

function getAuthHeaders(options?: { admin?: boolean }): Record<string, string> {
  if (process.env.NEXT_PUBLIC_AUTH_DEV_BYPASS === "true") {
    const devUserId = options?.admin
      ? process.env.NEXT_PUBLIC_AUTH_DEV_ADMIN_USER_ID || "2"
      : "1";
    return { Authorization: `Bearer dev:${devUserId}` };
  }

  const token = getAccessToken();
  if (token) {
    return { Authorization: `Bearer ${token}` };
  }

  return {};
}
```

**Key point:** Add the `import { getAccessToken }` at the top of the file (after the swatchwatch-shared imports, before the `API_BASE_URL` const). No other functions in api.ts need changes — they all call `getAuthHeaders()` internally.

### Step 1.5: Create `apps/web/src/components/auth-provider.tsx`

**New file.** Client component wrapping children with MSAL when B2C is configured.

```tsx
"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { MsalProvider } from "@azure/msal-react";
import { PublicClientApplication, EventType } from "@azure/msal-browser";
import { buildMsalConfig, LOGIN_SCOPES } from "@/lib/auth-config";
import { setAccessToken } from "@/lib/auth-token";

export function AuthProvider({ children }: { children: ReactNode }) {
  const msalConfig = useMemo(() => buildMsalConfig(), []);

  // No B2C config → dev bypass mode. Render children directly, no MsalProvider.
  if (!msalConfig) {
    return <>{children}</>;
  }

  return <MsalAuthProvider config={msalConfig}>{children}</MsalAuthProvider>;
}

/**
 * Inner component that is ONLY rendered when MSAL is configured.
 * This is critical: MSAL hooks can only be used inside <MsalProvider>.
 * By splitting this into a separate component from the dev-bypass path,
 * we guarantee the hooks are never called without a provider ancestor.
 */
function MsalAuthProvider({
  config,
  children,
}: {
  config: NonNullable<ReturnType<typeof buildMsalConfig>>;
  children: ReactNode;
}) {
  const msalInstance = useMemo(() => {
    const instance = new PublicClientApplication(config);
    return instance;
  }, [config]);

  const [isInitialized, setIsInitialized] = useState(false);

  useEffect(() => {
    const init = async () => {
      await msalInstance.initialize();

      // If returning from a redirect, handle the response
      const response = await msalInstance.handleRedirectPromise();
      if (response?.accessToken) {
        setAccessToken(response.accessToken);
      }

      // Set active account if one exists
      const accounts = msalInstance.getAllAccounts();
      if (accounts.length > 0 && !msalInstance.getActiveAccount()) {
        msalInstance.setActiveAccount(accounts[0]);
      }

      // Acquire token silently for the active account
      const activeAccount = msalInstance.getActiveAccount();
      if (activeAccount) {
        try {
          const result = await msalInstance.acquireTokenSilent({
            scopes: LOGIN_SCOPES,
            account: activeAccount,
          });
          setAccessToken(result.accessToken);
        } catch {
          // Token expired or unavailable — user will need to log in again
          setAccessToken(null);
        }
      }

      // Listen for future token events
      msalInstance.addEventCallback((event) => {
        if (
          event.eventType === EventType.LOGIN_SUCCESS ||
          event.eventType === EventType.ACQUIRE_TOKEN_SUCCESS
        ) {
          const payload = event.payload as { accessToken?: string; account?: unknown } | null;
          if (payload?.accessToken) {
            setAccessToken(payload.accessToken);
          }
          if (payload?.account) {
            msalInstance.setActiveAccount(payload.account as any);
          }
        }
        if (event.eventType === EventType.LOGOUT_SUCCESS) {
          setAccessToken(null);
        }
      });

      setIsInitialized(true);
    };

    init().catch((err) => {
      console.error("MSAL initialization failed:", err);
      setIsInitialized(true); // Unblock rendering even on error
    });
  }, [msalInstance]);

  if (!isInitialized) {
    return null; // Or a loading spinner — brief flash during MSAL init
  }

  return <MsalProvider instance={msalInstance}>{children}</MsalProvider>;
}
```

**Key design decisions:**
- `AuthProvider` checks `buildMsalConfig()` — returns `null` → render children directly (dev bypass)
- `MsalAuthProvider` is a separate component so MSAL hooks are only ever rendered inside `<MsalProvider>`
- Token is pushed to the module-level store via `setAccessToken()` — no need for React context for the token itself
- Event listener keeps the token fresh on re-auth
- `handleRedirectPromise()` handles the B2C redirect flow on page load

### Step 1.6: Create `apps/web/src/hooks/use-auth.ts`

**New file.** Client hook for auth state in UI components (sidebar, marketing header, etc.).

```ts
"use client";

import { useMsal, useIsAuthenticated } from "@azure/msal-react";
import { LOGIN_SCOPES } from "@/lib/auth-config";

export interface AuthUser {
  name: string;
  email?: string;
}

export interface UseAuthReturn {
  isAuthenticated: boolean;
  user: AuthUser | null;
  login: () => void;
  logout: () => void;
}

/**
 * IMPORTANT: This hook must ONLY be used inside components that are
 * rendered within <MsalProvider> — i.e., only when B2C auth is active.
 *
 * For dev bypass mode, use useDevAuth() instead.
 * The AppShell and marketing header should check
 * process.env.NEXT_PUBLIC_AUTH_DEV_BYPASS and conditionally render
 * the appropriate component.
 */
export function useAuth(): UseAuthReturn {
  const { instance, accounts } = useMsal();
  const isAuthenticated = useIsAuthenticated();

  const account = accounts[0] ?? null;

  const user: AuthUser | null = account
    ? {
        name: account.name || account.username || "User",
        email: account.username || undefined,
      }
    : null;

  const login = () => {
    instance.loginRedirect({ scopes: LOGIN_SCOPES });
  };

  const logout = () => {
    instance.logoutRedirect();
  };

  return { isAuthenticated, user, login, logout };
}

/**
 * Stub auth state for dev bypass mode.
 * No MSAL hooks — safe to call anywhere.
 */
export function useDevAuth(): UseAuthReturn {
  return {
    isAuthenticated: true,
    user: { name: "Dev User", email: "dev@swatchwatch.app" },
    login: () => {},
    logout: () => {},
  };
}
```

**Key points:**
- Two separate hooks: `useAuth()` (calls MSAL hooks, must be inside MsalProvider) and `useDevAuth()` (no MSAL hooks, safe anywhere)
- Components that need auth state must conditionally pick which hook to use based on `NEXT_PUBLIC_AUTH_DEV_BYPASS`
- This avoids the pitfall of calling MSAL hooks outside a provider

### Step 1.7: Wire AuthProvider into root layout

**File:** `apps/web/src/app/layout.tsx`
**Lines:** 1-4 (imports) and 90-95 (body content)

Add import at line 4:
```ts
import { AuthProvider } from "@/components/auth-provider";
```

Wrap body children (lines 90-95):
```tsx
// BEFORE:
<body className={`${inter.variable} ${jetbrainsMono.variable} font-sans antialiased`}>
  {children}
  <Toaster richColors closeButton />
</body>

// AFTER:
<body className={`${inter.variable} ${jetbrainsMono.variable} font-sans antialiased`}>
  <AuthProvider>
    {children}
    <Toaster richColors closeButton />
  </AuthProvider>
</body>
```

### Step 1.8: Add `RequireAuth` guard for app routes

**New file:** `apps/web/src/components/require-auth.tsx`

```tsx
"use client";

import { type ReactNode } from "react";
import { useIsAuthenticated, useMsal } from "@azure/msal-react";
import { LOGIN_SCOPES } from "@/lib/auth-config";
import { Button } from "@/components/ui/button";

const IS_DEV_BYPASS = process.env.NEXT_PUBLIC_AUTH_DEV_BYPASS === "true";

export function RequireAuth({ children }: { children: ReactNode }) {
  // Dev bypass — always render children
  if (IS_DEV_BYPASS) {
    return <>{children}</>;
  }

  return <B2CGuard>{children}</B2CGuard>;
}

/**
 * Only rendered when B2C is active — safe to call MSAL hooks.
 */
function B2CGuard({ children }: { children: ReactNode }) {
  const isAuthenticated = useIsAuthenticated();
  const { instance } = useMsal();

  if (isAuthenticated) {
    return <>{children}</>;
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="text-center space-y-4">
        <h1 className="text-2xl font-bold">Sign in to SwatchWatch</h1>
        <p className="text-muted-foreground">
          You need to sign in to access your collection.
        </p>
        <Button
          variant="brand"
          onClick={() => instance.loginRedirect({ scopes: LOGIN_SCOPES })}
        >
          Sign In
        </Button>
      </div>
    </div>
  );
}
```

**Key point:** Same pattern as the auth provider — dev bypass checks happen at the top level with a static env var check, MSAL hooks are isolated in a separate component that only renders when B2C is active.

### Step 1.9: Wire RequireAuth into app layout

**File:** `apps/web/src/app/(app)/layout.tsx`

Currently (10 lines):
```tsx
import { AppShell } from "@/components/app-shell";

export default function AppLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return <AppShell>{children}</AppShell>;
}
```

Change to:
```tsx
import { AppShell } from "@/components/app-shell";
import { RequireAuth } from "@/components/require-auth";

export default function AppLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <RequireAuth>
      <AppShell>{children}</AppShell>
    </RequireAuth>
  );
}
```

### Step 1.10: Add env vars to deploy workflow

**File:** `.github/workflows/deploy-dev.yml`

When B2C is ready for the dev environment, add these env vars to the `deploy-web` job's `env:` block (lines 39-42):

```yaml
env:
  NEXT_PUBLIC_API_URL: 'https://swatchwatch-dev-func-j5jij0be.azurewebsites.net/api'
  NEXT_PUBLIC_B2C_TENANT: ${{ secrets.B2C_TENANT }}
  NEXT_PUBLIC_B2C_CLIENT_ID: ${{ secrets.B2C_CLIENT_ID }}
  # Remove NEXT_PUBLIC_AUTH_DEV_BYPASS once B2C secrets are configured:
  NEXT_PUBLIC_AUTH_DEV_BYPASS: 'true'
```

**Do not remove `NEXT_PUBLIC_AUTH_DEV_BYPASS` yet** — it stays until B2C secrets are populated in the GitHub environment. When ready to cut over, remove the `NEXT_PUBLIC_AUTH_DEV_BYPASS` line and the `AUTH_DEV_BYPASS` step (lines 115-121).

---

## Phase 2: Logout + User Identity UI

**Goal:** Sidebar shows user name/email and a working Sign Out button.

### Step 2.1: Create `UserCard` client component

**New file:** `apps/web/src/components/user-card.tsx`

This component replaces the hardcoded sidebar footer. It conditionally uses MSAL hooks.

```tsx
"use client";

import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth, useDevAuth } from "@/hooks/use-auth";

const IS_DEV_BYPASS = process.env.NEXT_PUBLIC_AUTH_DEV_BYPASS === "true";

function getInitials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

export function UserCard() {
  if (IS_DEV_BYPASS) {
    return <DevUserCard />;
  }
  return <B2CUserCard />;
}

function DevUserCard() {
  const { user } = useDevAuth();
  return <UserCardInner name={user?.name ?? "Dev"} email={user?.email} />;
}

function B2CUserCard() {
  const { user, logout, isAuthenticated } = useAuth();

  if (!isAuthenticated || !user) {
    return null;
  }

  return <UserCardInner name={user.name} email={user.email} onSignOut={logout} />;
}

function UserCardInner({
  name,
  email,
  onSignOut,
}: {
  name: string;
  email?: string;
  onSignOut?: () => void;
}) {
  return (
    <div className="rounded-xl border border-brand-purple/20 bg-card/80 p-3 shadow-[0_10px_24px_rgba(66,16,126,0.1)]">
      <div className="flex items-center gap-2.5">
        <span className="inline-flex size-9 items-center justify-center rounded-full bg-gradient-brand text-xs font-semibold text-white shadow-glow-brand">
          {getInitials(name)}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-foreground">{name}</p>
          {email && (
            <p className="truncate text-xs text-muted-foreground">{email}</p>
          )}
        </div>
      </div>
      {onSignOut && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-3 w-full justify-start"
          onClick={onSignOut}
        >
          <LogOut className="size-3.5" />
          Sign Out
        </Button>
      )}
    </div>
  );
}
```

### Step 2.2: Update AppShell to use UserCard

**File:** `apps/web/src/components/app-shell.tsx`

Replace the hardcoded sidebar footer (lines 74-96). Remove the `Settings` import from lucide-react (line 5).

**Current code to replace (lines 74-96):**
```tsx
<div className="mt-auto border-t border-border/70 p-3">
  <div className="rounded-xl border border-brand-purple/20 bg-card/80 p-3 shadow-[0_10px_24px_rgba(66,16,126,0.1)]">
    <div className="flex items-center gap-2.5">
      <span className="inline-flex size-9 items-center justify-center rounded-full bg-gradient-brand text-xs font-semibold text-white shadow-glow-brand">
        SW
      </span>
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-foreground">You</p>
        <p className="truncate text-xs text-muted-foreground">Collector workspace</p>
      </div>
    </div>
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="mt-3 w-full justify-start"
      disabled
    >
      <Settings className="size-3.5" />
      Settings (Soon)
    </Button>
  </div>
</div>
```

**Replace with:**
```tsx
<div className="mt-auto border-t border-border/70 p-3">
  <UserCard />
</div>
```

**Add import at top of file:**
```ts
import { UserCard } from "@/components/user-card";
```

**Update lucide-react import (line 5)** — remove `Settings` from the import list:
```ts
// BEFORE:
import { LayoutDashboard, Sparkles, Search, PlusCircle, Settings, ShieldCheck } from "lucide-react";
// AFTER:
import { LayoutDashboard, Sparkles, Search, PlusCircle, ShieldCheck } from "lucide-react";
```

### Step 2.3: Add Sign In button to marketing header

**File:** `apps/web/src/app/(marketing)/layout.tsx`

This is a server component. Since we can't use hooks in a server component, create a small client component for the sign-in button.

**New file:** `apps/web/src/components/marketing-auth-button.tsx`

```tsx
"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useAuth, useDevAuth } from "@/hooks/use-auth";

const IS_DEV_BYPASS = process.env.NEXT_PUBLIC_AUTH_DEV_BYPASS === "true";

export function MarketingAuthButton() {
  if (IS_DEV_BYPASS) {
    return <DevButton />;
  }
  return <B2CButton />;
}

function DevButton() {
  return (
    <Button asChild variant="brand">
      <Link href="/dashboard">Open App</Link>
    </Button>
  );
}

function B2CButton() {
  const { isAuthenticated, login } = useAuth();

  if (isAuthenticated) {
    return (
      <Button asChild variant="brand">
        <Link href="/dashboard">Open App</Link>
      </Button>
    );
  }

  return (
    <Button variant="brand" onClick={login}>
      Sign In
    </Button>
  );
}
```

Then update the marketing layout to use this component:

**File:** `apps/web/src/app/(marketing)/layout.tsx`

Add import:
```ts
import { MarketingAuthButton } from "@/components/marketing-auth-button";
```

Replace both "Open App" buttons (desktop line 46-48, mobile line 70-72):

Desktop (line 46-48):
```tsx
// BEFORE:
<Button asChild variant="brand">
  <Link href="/dashboard">Open App</Link>
</Button>
// AFTER:
<MarketingAuthButton />
```

Mobile dropdown (line 70-72):
```tsx
// BEFORE:
<DropdownMenuItem asChild>
  <Link href="/dashboard">Open App</Link>
</DropdownMenuItem>
// AFTER (keep as simple link — dropdown context is awkward for login):
<DropdownMenuItem asChild>
  <Link href="/dashboard">Open App</Link>
</DropdownMenuItem>
```

Leave the mobile dropdown unchanged — it always links to `/dashboard`, and the `RequireAuth` guard will handle unauthenticated users when they land there.

---

## Phase 3: EXIF Stripping on Media Upload

**Goal:** Strip EXIF/GPS metadata from user images before blob storage (Epic 1.4 privacy requirement).

### Step 3.1: Install `sharp`

```bash
cd packages/functions && npm install sharp
```

`sharp` is the standard Node.js image processing library. It handles EXIF stripping natively via its pipeline.

### Step 3.2: Create `packages/functions/src/lib/image-sanitize.ts`

**New file.**

```ts
import sharp from "sharp";

/**
 * Strip EXIF/GPS metadata from an image buffer.
 * Auto-rotates based on EXIF orientation, then removes all metadata.
 * Returns the clean buffer. On error, returns the original buffer unchanged.
 */
export async function stripExif(imageBuffer: Buffer): Promise<Buffer> {
  try {
    return await sharp(imageBuffer)
      .rotate() // auto-orient from EXIF, then strip metadata
      .toBuffer();
  } catch (error) {
    console.warn("[image-sanitize] Failed to strip EXIF, using original:", error);
    return imageBuffer;
  }
}
```

That's it — `sharp(buf).rotate().toBuffer()` auto-orients based on EXIF orientation tag, then the output has all EXIF data stripped.

### Step 3.3: Integrate into `packages/functions/src/lib/blob-storage.ts`

**File:** `packages/functions/src/lib/blob-storage.ts`

In `uploadSourceImageToBlob()`, after downloading the image and creating the buffer (line 346):

**Add import at top of file (line 1):**
```ts
import { stripExif } from "./image-sanitize";
```

**After line 346 (`const bytes = Buffer.from(arrayBuffer);`)**, add:
```ts
// Strip EXIF/GPS metadata for privacy
const cleanBytes = await stripExif(bytes);
```

Then replace all subsequent references to `bytes` with `cleanBytes` in this function:
- Line 347: `if (cleanBytes.length === 0)` (edge case — stripExif returns original on error so this won't change behavior)
- Line 351: `const checksumSha256 = createHash("sha256").update(cleanBytes).digest("hex");`
- Line 352: `` const imageBase64DataUri = `data:${contentType};base64,${cleanBytes.toString("base64")}`; ``
- Line 366: `sizeBytes: cleanBytes.length,`
- Line 375: `` console.log(`[blob-storage] Image downloaded: ${cleanBytes.length} bytes, ...`); ``
- Line 404: `"Content-Length": String(cleanBytes.length),`
- Line 405-406: pass `cleanBytes` as the body
- Line 420: `sizeBytes: cleanBytes.length,`

### Step 3.4: Integrate into capture frame upload

**File:** `packages/functions/src/functions/capture.ts`

Find the section where data URL frames are decoded to buffers for upload. After the base64 decode produces a `Buffer`, call `stripExif()` on it before generating the checksum and uploading. Add the import:

```ts
import { stripExif } from "../lib/image-sanitize";
```

Look for the pattern where `Buffer.from(base64Data, "base64")` is called, and add `await stripExif(buffer)` immediately after.

---

## Phase 4: Deploy Smoke Test

**Goal:** Verify the dev environment is healthy after each deploy.

### Step 4.1: Add smoke test step to deploy workflow

**File:** `.github/workflows/deploy-dev.yml`

Add after the "Deploy to Azure Functions" step (after line 113), before the AUTH_DEV_BYPASS step:

```yaml
    - name: Smoke test
      run: |
        sleep 10
        STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
          -H "Authorization: Bearer dev:1" \
          "$API_URL/polishes?pageSize=1")
        if [ "$STATUS" != "200" ]; then
          echo "::error::Smoke test failed: GET /api/polishes returned HTTP $STATUS"
          exit 1
        fi
        echo "Smoke test passed: HTTP $STATUS"
      env:
        API_URL: https://swatchwatch-dev-func-j5jij0be.azurewebsites.net/api
```

This validates: Functions runtime is up, auth middleware works, database connectivity is healthy, polishes handler can execute a query.

---

## Phase 5: Structured Logging (App Insights)

**Goal:** Functions emit structured traces and metrics to Application Insights.

### Step 5.1: Install App Insights SDK

```bash
cd packages/functions && npm install applicationinsights
```

### Step 5.2: Create `packages/functions/src/lib/telemetry.ts`

**New file.**

```ts
import appInsights from "applicationinsights";

const connectionString = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;

if (connectionString) {
  appInsights
    .setup(connectionString)
    .setAutoCollectRequests(false) // Azure Functions handles this
    .setAutoCollectDependencies(true)
    .start();
}

const client = connectionString ? appInsights.defaultClient : null;

export function trackEvent(
  name: string,
  properties?: Record<string, string>
): void {
  client?.trackEvent({ name, properties });
}

export function trackMetric(name: string, value: number): void {
  client?.trackMetric({ name, value });
}
```

### Step 5.3: Instrument key endpoints

Add `trackEvent` / `trackMetric` calls to:

| File | Location | Event |
|------|----------|-------|
| `polishes.ts` | After successful `createPolish` | `trackEvent("polish.created", { brand })` |
| `capture.ts` | After resolver completes in finalize | `trackEvent("capture.finalized", { outcome, confidence })` |
| `catalog.ts` | After search query | `trackEvent("catalog.search", { resultCount })` |
| `auth.ts` (lib) | In `authenticateRequest` success/failure | `trackEvent("auth.success", { method })` / `trackEvent("auth.failure", { error })` |

### Step 5.4: Add env var to local settings

**File:** `packages/functions/local.settings.json`

Add to the `Values` object:
```json
"APPLICATIONINSIGHTS_CONNECTION_STRING": ""
```

Empty string = no-op for local dev.

---

## Phase 6: Upload Validation Hardening

**Goal:** Consistent upload validation across all entry points.

### Step 6.1: Add validation function to blob-storage.ts

**File:** `packages/functions/src/lib/blob-storage.ts`

Add after the existing constants (after line 5):

```ts
export const UPLOAD_LIMITS = {
  maxSizeBytes: 5 * 1024 * 1024,
  allowedMimeTypes: new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/heic",
  ]),
} as const;

export function validateImageUpload(
  contentType: string,
  sizeBytes: number
): void {
  const normalizedType = contentType.split(";")[0].trim().toLowerCase();
  if (!UPLOAD_LIMITS.allowedMimeTypes.has(normalizedType)) {
    throw new Error(
      `Unsupported image type: ${normalizedType}. Allowed: ${[...UPLOAD_LIMITS.allowedMimeTypes].join(", ")}`
    );
  }
  if (sizeBytes > UPLOAD_LIMITS.maxSizeBytes) {
    throw new Error(
      `Image too large: ${(sizeBytes / (1024 * 1024)).toFixed(1)}MB exceeds ${UPLOAD_LIMITS.maxSizeBytes / (1024 * 1024)}MB limit`
    );
  }
}
```

### Step 6.2: Apply validation

- In `uploadSourceImageToBlob()` (blob-storage.ts): call `validateImageUpload(contentType, cleanBytes.length)` after EXIF stripping
- In capture frame handler (capture.ts): replace the inline `MAX_CAPTURE_IMAGE_BYTES` check with `validateImageUpload()` from blob-storage, importing both the function and `UPLOAD_LIMITS`

---

## Phase 7: Stale TODO Cleanup

**Goal:** Update passed-deadline TODOs to reference this plan.

### Step 7.1: Update deploy workflow TODOs

**File:** `.github/workflows/deploy-dev.yml`

Line 41:
```yaml
# BEFORE:
# TODO(2026-02-11): Remove once dev B2C auth flow is wired in the web app.
# AFTER:
# TODO: Remove NEXT_PUBLIC_AUTH_DEV_BYPASS once B2C secrets are configured in the dev environment.
```

Lines 115-117:
```yaml
# BEFORE:
- name: TEMP enable auth dev bypass (remove after dev B2C wiring)
  run: |
    # TODO(2026-02-11): Remove AUTH_DEV_BYPASS once dev B2C auth is fully wired end-to-end.
# AFTER:
- name: TEMP enable auth dev bypass (remove after dev B2C wiring)
  run: |
    # TODO: Remove AUTH_DEV_BYPASS once dev B2C auth is fully wired end-to-end.
```

---

## Execution Order

```
Phase 1 (B2C Auth)         ████████████████  ~1 day     ← biggest gap
Phase 2 (Logout UI)        ██████            ~2 hours   ← pairs with Phase 1
Phase 3 (EXIF strip)       ██████            ~2 hours   ← isolated, privacy req
Phase 4 (Smoke test)       ██                ~30 min    ← CI hardening
Phase 5 (Structured logs)  ████████          ~3 hours   ← cross-cutting
Phase 6 (Upload validation)██                ~30 min    ← small refactor
Phase 7 (TODO cleanup)     █                 ~15 min    ← housekeeping
```

Total: ~2 days

## Definition of Done (M0)

- [ ] Web app users can sign in via Azure AD B2C (or dev bypass for local dev)
- [ ] A user cannot access another user's inventory or media
- [ ] Users can add/edit/view/delete polishes on web
- [ ] Media uploads work without secrets in client builds (SAS tokens from API)
- [ ] Uploaded images have EXIF/GPS metadata stripped
- [ ] Deploy to dev is one-click (CI green, smoke test passes)
- [ ] Key endpoints emit structured telemetry to App Insights
- [ ] Auth dev bypass can be toggled off without code changes

## Out of Scope (deferred to M1+)

- Voice input (`voice.ts` stubs) → M1
- Mobile app auth → M1
- Gated deploy to stg/prod → M1
- Soft-delete for polishes → M1
- Budget/alert dashboards → M4
- User data export / GDPR delete → M4
