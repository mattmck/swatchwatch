# Stytch Migration Checklist (SwatchWatch)

This is a repo-specific migration checklist to replace Azure AD B2C/Entra B2C auth with Stytch for web login (email/password + passkeys + social login), while keeping the Azure Functions API and PostgreSQL user model.

## Scope

- In scope:
  - Web auth for `apps/web` (Next.js)
  - JWT/session token validation in `packages/functions`
  - User identity mapping in `app_user.external_id`
  - Shared auth-related types in `packages/shared`
  - Environment/config documentation updates
- Out of scope (phase later):
  - Native mobile auth flow in `apps/mobile`
  - Account linking/merging across multiple identity providers

## Current Baseline (as of Feb 22, 2026)

- Frontend token wiring is not fully implemented yet (`apps/web/src/lib/api.ts` has TODOs for real auth state).
- Backend auth validation is centralized in one place: `packages/functions/src/lib/auth.ts`.
- Backend auth config endpoint is B2C-specific: `packages/functions/src/functions/auth.ts`.
- Shared `AuthConfig` type is B2C-shaped today: `packages/shared/src/types/user.ts`.

This means migration risk is moderate and mostly isolated.

## Recommended Strategy

- Use Stytch Consumer authentication with:
  - Email + password
  - Passkeys (WebAuthn)
  - OAuth social providers: Google, Facebook, Apple, GitHub
- Keep API auth model as bearer JWT/session token verification in Functions.
- Keep DB column `app_user.external_id`, but treat it as provider-agnostic.

## Phase 0: Stytch Workspace Setup

- [ ] Create Stytch workspace(s): `dev`, `prod` (recommended separation).
- [ ] Create application/project config for web app.
- [ ] Configure redirect/callback URLs:
  - [ ] `http://localhost:3000`
  - [ ] Production web URL(s)
- [ ] Enable email/password and passkeys.
- [ ] Enable OAuth social providers:
  - [ ] Google
  - [ ] Facebook
  - [ ] Apple
  - [ ] GitHub
- [ ] Configure each social provider app with dev/prod callback URLs.
- [ ] Capture values needed by backend validation:
  - [ ] `project_id`
  - [ ] `secret` (server-side only)
  - [ ] public token/key for frontend SDK

## Phase 1: Backend (Azure Functions) Migration

### 1.1 Environment variables

- [ ] Add Stytch env vars to `packages/functions/local.settings.json` and docs:
  - [ ] `STYTCH_PROJECT_ID`
  - [ ] `STYTCH_SECRET`
- [ ] Keep `AUTH_DEV_BYPASS` for local development.
- [ ] Mark B2C vars deprecated in docs:
  - [ ] `AZURE_AD_B2C_TENANT`
  - [ ] `AZURE_AD_B2C_CLIENT_ID`

### 1.2 Token/session verification logic

- [ ] Update `packages/functions/src/lib/auth.ts`:
  - [ ] Replace B2C JWT validation with Stytch token/session validation.
  - [ ] Extract stable external subject for user mapping (Stytch user/session subject).
  - [ ] Keep email extraction when available.
  - [ ] Keep `withAuth` and `withAdmin` wrappers unchanged externally.
- [ ] Confirm `getOrCreateUser()` continues to upsert by `external_id`.
- [ ] Make logs provider-neutral (avoid B2C-specific text).

### 1.3 Auth config endpoint contract

- [ ] Update `packages/functions/src/functions/auth.ts`:
  - [ ] Replace B2C config payload with Stytch-ready config used by frontend.
  - [ ] Return 503 if auth config missing.
- [ ] Update route docs in `packages/functions/README.md`.

### 1.4 Tests

- [ ] Update unit tests in `packages/functions/tests/handlers.unit.test.cjs`:
  - [ ] Replace B2C env assumptions with Stytch vars.
  - [ ] Update claim/session fixtures to Stytch response shape.
  - [ ] Keep dev bypass tests intact.
- [ ] Run:
  - [ ] `npm run build:functions`
  - [ ] `npm run test --workspace=packages/functions`

## Phase 2: Shared Types + Contracts

- [ ] Update `packages/shared/src/types/user.ts`:
  - [ ] Replace B2C-specific `AuthConfig` fields with provider-neutral/Stytch-ready fields.
  - [ ] Ensure `AuthProvider` includes `email`, `google`, `facebook`, `apple`, `github`.
- [ ] Re-export any new types in `packages/shared/src/index.ts` (if needed).
- [ ] Update `packages/shared/README.md` type catalog.
- [ ] Build shared package:
  - [ ] `npm run build --workspace=packages/shared`

## Phase 3: Web App (Next.js) Integration

### 3.1 Add Stytch SDK and client/server plumbing

- [ ] Add Stytch SDK dependency in `apps/web`.
- [ ] Add server-side verification path for protected API token issuance/forwarding.
- [ ] Add frontend env vars to `.env.example` and docs:
  - [ ] `NEXT_PUBLIC_STYTCH_PUBLIC_TOKEN`
  - [ ] Any required project/env identifiers

### 3.2 Replace placeholder token flow

- [ ] Update `apps/web/src/lib/api.ts`:
  - [ ] Replace `NEXT_PUBLIC_AUTH_DEV_BYPASS`-only header logic with real auth token/session forwarding.
  - [ ] Attach auth token for protected API calls.
  - [ ] Keep catalog endpoints unauthenticated.
- [ ] Add login/logout UI entry points (if not present).
- [ ] Add social login entry points/buttons:
  - [ ] Continue with Google
  - [ ] Continue with Facebook
  - [ ] Continue with Apple
  - [ ] Continue with GitHub
- [ ] Gate protected pages/actions where needed.

### 3.3 UX requirements

- [ ] Verify users can:
  - [ ] Sign up with email/password
  - [ ] Log in with email/password
  - [ ] Use passkey login
  - [ ] Log in with Google
  - [ ] Log in with Facebook
  - [ ] Log in with Apple
  - [ ] Log in with GitHub
  - [ ] Log out cleanly
- [ ] Ensure fallback behavior if passkeys unavailable on device/browser.

## Phase 4: Data + Identity Mapping

- [ ] Confirm `app_user.external_id` stores Stytch stable user identifier.
- [ ] Decide whether to preserve existing B2C-linked users:
  - [ ] Option A: start fresh in dev/staging
  - [ ] Option B: map/import users and maintain identity continuity
- [ ] If migrating existing users, define an explicit mapping/import script and rollback plan.

## Phase 5: Infra and Deployment

- [ ] Update Function App settings in Terraform/ops config for Stytch vars.
- [ ] Remove B2C settings from active deployment once cutover is complete.
- [ ] Verify CORS and callback URLs per environment.
- [ ] Deploy in order:
  - [ ] Functions (Stytch validation ready)
  - [ ] Web (Stytch login + token forwarding)
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
- [ ] Deploy backend validation before requiring frontend tokens.
- [ ] Add temporary structured logging for auth failures.
- [ ] Monitor 401/403 rates during cutover window.
- [ ] Have rollback switch:
  - [ ] Re-deploy previous Functions build
  - [ ] Restore previous web build
  - [ ] Re-enable prior identity config if still maintained

## Acceptance Criteria

- [ ] A new user can complete sign-up/login with:
  - [ ] Email/password
  - [ ] Passkey
  - [ ] Google
  - [ ] Facebook
  - [ ] Apple
  - [ ] GitHub
- [ ] Protected `/api/polishes*` calls succeed with authenticated token/session.
- [ ] Unauthorized requests still return 401 consistently.
- [ ] Existing CRUD functionality remains unchanged after auth cutover.
- [ ] Test suite/build/typecheck pass:
  - [ ] `npm run build --workspace=packages/shared`
  - [ ] `npm run build:functions`
  - [ ] `npm run build:web`
  - [ ] `npm run test --workspaces --if-present`
  - [ ] `npm run typecheck`
