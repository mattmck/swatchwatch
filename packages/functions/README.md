# Azure Functions — `packages/functions`

Azure Functions v4 HTTP API (Node 20, TypeScript).

## Running Locally

```bash
# From repo root
npm run dev:functions    # Starts func host on http://localhost:7071

# Or for debugging (VS Code):
# Press F5 → "Attach to Node Functions" (builds, watches, starts with --inspect on port 9229)
```

Requires **Azure Functions Core Tools v4** (`npm i -g azure-functions-core-tools@4`).

## API Routes

| Method | Route | Handler | File | Status |
|--------|-------|---------|------|--------|
| `GET` | `/api/polishes/{id?}` | `getPolishes` | `polishes.ts` | ✅ Live |
| `POST` | `/api/polishes` | `createPolish` | `polishes.ts` | ✅ Live |
| `PUT` | `/api/polishes/{id}` | `updatePolish` | `polishes.ts` | ✅ Live |
| `DELETE` | `/api/polishes/{id}` | `deletePolish` | `polishes.ts` | ✅ Live |
| `POST` | `/api/auth/validate` | `validateToken` | `auth.ts` | ⬜ Stub (501) |
| `GET` | `/api/auth/config` | `getAuthConfig` | `auth.ts` | ✅ Working |
| `POST` | `/api/voice` | `processVoiceInput` | `voice.ts` | ⬜ Stub |


All handlers return `Promise<HttpResponseInit>` and accept `(request: HttpRequest, context: InvocationContext)`.

## Migrations & Seed Data

See `migrations/002_add_user_facing_columns.sql` (adds color, hex, rating, tags, size, updated_at) and `003_seed_dev_data.sql` (inserts brands, shades, demo user, and 20 inventory items).

## Adding a New Function

1. Create `src/functions/my-feature.ts`
2. Define handler(s):
   ```ts
   import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";

   async function myHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
     // implementation
   }

   app.http("my-feature", {
     methods: ["GET"],
     authLevel: "anonymous",
     route: "my-feature/{id?}",
     handler: myHandler,
   });
   ```
3. Import types from `swatchwatch-shared` — **do not** redefine domain types locally


## Known Issues

- JWT validation returns 501 — Azure AD B2C JWKS verification not implemented
- Voice handler stubs Speech-to-text and OpenAI parsing


## Environment Variables

Defined in `local.settings.json` (git-ignored values). See the root README for the full list. For production, secrets are injected via Key Vault references.

## Build

```bash
npm run build --workspace=packages/functions   # tsc → dist/
npm run watch --workspace=packages/functions   # tsc -w (used by debug task)
```

Output goes to `dist/`. The `host.json` and `local.settings.json` stay at package root.
