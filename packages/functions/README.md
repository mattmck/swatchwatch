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
| `GET` | `/api/polishes/{id?}` | `getPolishes` | `polishes.ts` | ⬜ Stub |
| `POST` | `/api/polishes` | `createPolish` | `polishes.ts` | ⬜ Stub |
| `PUT` | `/api/polishes/{id}` | `updatePolish` | `polishes.ts` | ⬜ Stub |
| `DELETE` | `/api/polishes/{id}` | `deletePolish` | `polishes.ts` | ⬜ Stub |
| `POST` | `/api/auth/validate` | `validateToken` | `auth.ts` | ⬜ Stub (501) |
| `GET` | `/api/auth/config` | `getAuthConfig` | `auth.ts` | ✅ Working |
| `POST` | `/api/voice` | `processVoiceInput` | `voice.ts` | ⬜ Stub |

All handlers return `Promise<HttpResponseInit>` and accept `(request: HttpRequest, context: InvocationContext)`.

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
3. Import types from `polish-inventory-shared` — **do not** redefine domain types locally

## Known Issues

- `polishes.ts` defines a local `Polish` interface that duplicates `packages/shared` — new code should import from `polish-inventory-shared` instead
- All CRUD handlers return placeholder responses — Cosmos DB SDK client not yet wired
- JWT validation returns 501 — Azure AD B2C JWKS verification not implemented
- Voice handler stubs Speech-to-text and OpenAI parsing

## Environment Variables

Defined in `local.settings.json` (git-ignored values). See the root README for the full list.

## Build

```bash
npm run build --workspace=packages/functions   # tsc → dist/
npm run watch --workspace=packages/functions   # tsc -w (used by debug task)
```

Output goes to `dist/`. The `host.json` and `local.settings.json` stay at package root.
