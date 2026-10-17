---
name: add-endpoint
description: Scaffold a new Azure Functions v4 HTTP endpoint in SwatchWatch with withCors/withAuth (or withAdmin), user_id-scoped SQL, a unit test, and the README route-table row.
argument-hint: <METHOD> <route> [admin]
disable-model-invocation: true
---

# Add an API endpoint

Arguments: `$ARGUMENTS` — HTTP method, route (e.g. `GET polishes/{id}/notes`), and optionally `admin`. If anything is ambiguous, ask before writing code.

## Conventions (from CLAUDE.md and `packages/functions/src/functions/polishes.ts`)

- One feature area per file in `packages/functions/src/functions/`. Add to an existing file when the area exists; otherwise create a file **and** add `export * from './functions/<file>';` to `packages/functions/src/index.ts`.
- Handler signature: `(request: HttpRequest, context: InvocationContext, userId: number) => Promise<HttpResponseInit>`.
- Register at module scope:
  ```ts
  app.http("<area>-<action>", {
    methods: ["GET", "OPTIONS"],
    authLevel: "anonymous",
    route: "<route>",
    handler: withCors(withAuth(handlerFn)), // withAdmin for admin/ops routes
  });
  ```
  Always include `"OPTIONS"` in `methods` and wrap with `withCors`.
- **Authorization is mandatory.** User-data routes use `withAuth`; admin/ops routes use `withAdmin`. Never `userId` from the request body/query.
- **Every SQL statement touching user data filters on the authenticated `userId`** (`WHERE … AND user_id = $n`). Shared tables (shades) are fill-only for users. Use parameterized queries (`query()` / `transaction()` from `../lib/db`); never interpolate input.
- Validate ids (`parseInt`, `> 0`) and return 400 for bad input, 404 for "not found *for this user*", and `internalServerError(context, error, "<message>", "<area>.<action>")` for unexpected failures.
- Domain types live in `packages/shared/src/types/` and are re-exported from `packages/shared/src/index.ts`; do not redefine them locally.
- Invalidate caches (`cacheDelete*`) when mutating cached data; emit `trackEvent` for notable events.

## Steps

1. Add/extend shared request/response types in `packages/shared` (rebuild with `npm run build:shared`).
2. Write the handler and registration.
3. Add a unit test in `packages/functions/tests/` (`<area>.unit.test.cjs`, `node:test`; copy the require-interception mocking style from `handlers.unit.test.cjs`). Cover: registered methods (`expectMethods`), 401 without auth, validation 400, the happy path, and **cross-user isolation** (another user's data → 404/empty).
4. Update docs in the same change: `packages/functions/README.md` route table, `packages/shared/README.md` for new types, and CLAUDE.md if a new env var or architectural rule appears.
5. Verify:
   ```bash
   npm run build:functions      # builds shared + tsc for functions (no separate typecheck/lint script there)
   npm run test --workspace=swatchwatch-functions
   ```
6. Report results. Do not commit unless asked.
