# Shared Types — `packages/shared`

Shared TypeScript type definitions used across the monorepo. Published as `swatchwatch-shared` in the npm workspace.

## Usage

```ts
import type { Polish, PolishFinish, PolishCreateRequest } from "swatchwatch-shared";
```

The package is automatically linked via npm workspaces — no publishing required.

## Types

### `types/polish.ts`

| Type | Description |
|------|-------------|
| `Polish` | Full polish entity (id, userId, brand, name, color, colorHex, finish, tags, timestamps, etc.) |
| `PolishFinish` | Union of finish types: `"cream" \| "shimmer" \| "glitter" \| "metallic" \| "matte" \| "jelly" \| "holographic" \| "duochrome" \| "multichrome" \| "flake" \| "topper" \| "sheer" \| "other"` |
| `PolishCreateRequest` | Required + optional fields for creating a polish (no id/userId/timestamps) |
| `PolishUpdateRequest` | Partial create fields + required `id` |
| `PolishListResponse` | Paginated list: `{ polishes, total, page, pageSize }` |
| `PolishFilters` | Query params: brand, finish, color, tags, search, sort, pagination |

### `types/user.ts`

| Type | Description |
|------|-------------|
| `User` | User entity (id, email, displayName, avatarUrl, authProvider, timestamps) |
| `AuthProvider` | `"apple" \| "facebook" \| "google" \| "email"` |
| `AuthConfig` | B2C configuration (authority, clientId, knownAuthorities, redirectUri, scopes) |

### `types/voice.ts`

| Type | Description |
|------|-------------|
| `VoiceProcessRequest` | Audio format declaration (`wav \| webm \| ogg \| mp3`) |
| `ParsedPolishDetails` | AI-extracted fields from voice transcription + confidence score |
| `VoiceProcessResponse` | Parsed result + optional alternative suggestions |
| `VoiceCommand` | Discriminated union: `add \| update \| delete \| search` actions |

## Adding New Types

1. Create or edit a file in `src/types/`
2. Re-export from `src/index.ts`:
   ```ts
   export * from "./types/my-new-type";
   ```
3. Build: `npm run build --workspace=packages/shared`
4. Other packages can immediately import the new types

## Build

```bash
npm run build --workspace=packages/shared    # tsc → dist/
npm run typecheck --workspace=packages/shared # tsc --noEmit
```

**Important:** You must build this package before other packages can resolve its types. The `main` and `types` fields in `package.json` point to `dist/`.
