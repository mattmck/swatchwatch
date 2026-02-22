# Auth0 Migration Checklist (SwatchWatch)

This is a repo-specific migration checklist to replace Azure AD B2C/Entra B2C auth with Auth0 for web login (email/password + passkeys), while keeping the Azure Functions API and PostgreSQL user model.

## Scope

- In scope:
  - Web auth for `apps/web` (Next.js)
  - JWT validation in `packages/functions`
  - User identity mapping in `app_user.external_id`
  - Shared auth-related types in `packages/shared`
  - Environment/config documentation updates
- Out of scope (phase later):
  - Native mobile auth flow in `apps/mobile`
  - Account linking/merging across multiple identity providers

## Current Baseline (as of Feb 22, 2026)

- Frontend token wiring is not fully implemented yet (`apps/web/src/lib/api.ts` still has a TODO for real auth state).
- Backend auth validation is centralized in one place: `packages/functions/src/lib/auth.ts`.
- Backend auth config endpoint is B2C-specific: `packages/functions/src/functions/auth.ts`.
- Shared `AuthConfig` type is B2C-shaped today: `packages/shared/src/types/user.ts`.

This means migration risk is moderate and mostly isolated.

## Recommended Strategy

- Use Auth0 Universal Login with:
  - Database connection (email/password)
  - Passkeys enabled for that database connection
- Keep API auth model as bearer JWT verification in Functions.
- Keep DB column `app_user.external_id`, but treat it as provider-agnostic (`auth0|...` style subject).

## Phase 0: Auth0 Tenant Setup

- [ ] Create/Auth0 tenant and choose environment naming (`dev`, `prod`).
- [ ] Create a Regular Web Application for Next.js web app.
- [ ] Configure Allowed Callback URLs:
  - [ ] `http://localhost:3000/api/auth/callback`
  - [ ] Production web callback URL
- [ ] Configure Allowed Logout URLs:
  - [ ] `http://localhost:3000`
  - [ ] Production web URL
- [ ] Configure Allowed Web Origins:
  - [ ] `http://localhost:3000`
  - [ ] Production web origin
- [ ] Create/enable database connection for email/password login.
- [ ] Enable passkeys for that database connection.
- [ ] Capture tenant values needed by backend JWT validation:
  - [ ] Auth0 domain
  - [ ] API audience (if using custom API)
  - [ ] Issuer URL

## Phase 1: Backend (Azure Functions) Migration

### 1.1 Environment variables

- [ ] Add Auth0 env vars to `packages/functions/local.settings.json` and docs:
  - [ ] `AUTH0_DOMAIN`
  - [ ] `AUTH0_AUDIENCE`
  - [ ] `AUTH0_ISSUER_BASE_URL` (or derive from domain consistently)
- [ ] Keep `AUTH_DEV_BYPASS` for local development.
- [ ] Mark B2C vars deprecated in docs:
  - [ ] `AZURE_AD_B2C_TENANT`
  - [ ] `AZURE_AD_B2C_CLIENT_ID`

### 1.2 JWT verification logic

- [ ] Update `packages/functions/src/lib/auth.ts`:
  - [ ] Replace B2C JWKS URL + issuer/audience checks with Auth0 equivalents.
  - [ ] Read `sub` claim as primary external ID (instead of B2C `oid`).
  - [ ] Keep email extraction from token when available.
  - [ ] Keep `withAuth` and `withAdmin` wrappers unchanged externally.
- [ ] Confirm `getOrCreateUser()` continues to upsert by `external_id`.
- [ ] Make log messages provider-neutral (avoid B2C-specific text).

### 1.3 Auth config endpoint contract

- [ ] Update `packages/functions/src/functions/auth.ts`:
  - [ ] Replace `getAuthConfig` payload from B2C shape to Auth0 shape used by frontend.
  - [ ] Return 503 if Auth0 config missing.
- [ ] Update route docs in `packages/functions/README.md`.

### 1.4 Tests

- [ ] Update unit tests in `packages/functions/tests/handlers.unit.test.cjs`:
  - [ ] Replace B2C env variable assumptions with Auth0 vars.
  - [ ] Update claim fixtures from `oid` to `sub`.
  - [ ] Keep dev bypass tests intact.
- [ ] Run:
  - [ ] `npm run build:functions`
  - [ ] `npm run test --workspace=packages/functions`

## Phase 2: Shared Types + Contracts

- [ ] Update `packages/shared/src/types/user.ts`:
  - [ ] Replace B2C-specific `AuthConfig` fields with provider-neutral/Auth0-ready fields.
  - [ ] Ensure `AuthProvider` can represent Auth0-backed identity (usually still `email`, `google`, etc.).
- [ ] Re-export any new types in `packages/shared/src/index.ts` (if needed).
- [ ] Update `packages/shared/README.md` type catalog.
- [ ] Build shared package:
  - [ ] `npm run build --workspace=packages/shared`

## Phase 3: Web App (Next.js) Integration

### 3.1 Add Auth0 SDK and auth routes

- [ ] Add Auth0 Next.js SDK dependency in `apps/web`.
- [ ] Add auth route handlers as needed by selected SDK version.
- [ ] Add frontend env vars to `.env.example` and docs:
  - [ ] `AUTH0_SECRET`
  - [ ] `AUTH0_BASE_URL`
  - [ ] `AUTH0_ISSUER_BASE_URL`
  - [ ] `AUTH0_CLIENT_ID`
  - [ ] `AUTH0_CLIENT_SECRET`
  - [ ] `AUTH0_AUDIENCE` (if requesting API access tokens)

### 3.2 Replace placeholder token flow

- [ ] Update `apps/web/src/lib/api.ts`:
  - [ ] Replace `NEXT_PUBLIC_AUTH_DEV_BYPASS`-only header logic with real bearer token retrieval.
  - [ ] Attach Auth0 access token for protected API calls.
  - [ ] Keep catalog endpoints unauthenticated.
- [ ] Add login/logout UI entry points (if not present).
- [ ] Gate protected pages/actions where needed.

### 3.3 UX requirements

- [ ] Verify users can:
  - [ ] Sign up with email/password
  - [ ] Log in with email/password
  - [ ] Use passkey login
  - [ ] Log out cleanly
- [ ] Ensure fallback behavior if passkeys unavailable on device/browser.

## Phase 4: Data + Identity Mapping

- [ ] Confirm `app_user.external_id` stores Auth0 `sub` values (example `auth0|abc...`).
- [ ] Decide whether to preserve existing B2C-linked users:
  - [ ] Option A: start fresh in dev/staging
  - [ ] Option B: map/import users and maintain external ID continuity
- [ ] If migrating existing users, define an explicit mapping/import script and rollback plan.

## Phase 5: Infra and Deployment

- [ ] Update Function App settings in Terraform/ops config for Auth0 vars.
- [ ] Remove B2C settings from active deployment once cutover is complete.
- [ ] Verify CORS and callback/logout URLs in each environment.
- [ ] Deploy in order:
  - [ ] Functions (Auth0 validation ready)
  - [ ] Web (Auth0 login + token forwarding)
- [ ] Smoke test in staging before production cutover.

## Phase 6: Docs and Cleanup

- [ ] Update root `README.md`:
  - [ ] Data flow auth section
  - [ ] Environment variables section
- [ ] Update `packages/functions/README.md` auth section and route table.
- [ ] Update `packages/shared/README.md` auth type descriptions.
- [ ] Update `.github/copilot-instructions.md` auth architecture references.
- [ ] Mirror the same architecture/auth changes to:
  - [ ] `AGENTS.md`
  - [ ] `CLAUDE.md`
  - [ ] `.cursorrules`
  - [ ] `.windsurfrules`
- [ ] Remove obsolete B2C-only code paths once stable.

## Rollout Safety Checklist

- [ ] Keep `AUTH_DEV_BYPASS=true` available for local troubleshooting only.
- [ ] Deploy Auth0 backend validation before requiring frontend Auth0 tokens.
- [ ] Add temporary structured logging for auth failures (issuer, audience mismatch, missing claims).
- [ ] Monitor 401/403 rates during cutover window.
- [ ] Have rollback switch:
  - [ ] Re-deploy previous Functions build
  - [ ] Restore previous web build
  - [ ] Re-enable prior identity config if still maintained

## Acceptance Criteria

- [ ] A new user can complete sign-up/login with email/password and passkey.
- [ ] Protected `/api/polishes*` calls succeed with Auth0 bearer token.
- [ ] Unauthorized requests still return 401 consistently.
- [ ] Existing CRUD functionality remains unchanged after auth cutover.
- [ ] Test suite/build/typecheck pass:
  - [ ] `npm run build --workspace=packages/shared`
  - [ ] `npm run build:functions`
  - [ ] `npm run build:web`
  - [ ] `npm run test --workspaces --if-present`
  - [ ] `npm run typecheck`

