# Plan: Wire polishes CRUD to persist all data in Postgres

## Context

The polishes API handlers in `packages/functions/src/functions/polishes.ts` already execute real SQL via the `db.ts` pool helper. But there are significant data gaps — brand, name, finish, and collection are **not persisted** on create (they're overlaid in JS on the response, then lost). The list endpoint returns all rows with no filtering or pagination. The `expirationDate` field from the `Polish` type has no DB column at all.

The goal: every field the frontend sends should be stored in and read from the database.

## Gaps identified

| Field | On CREATE | On READ | On UPDATE |
|-------|-----------|---------|-----------|
| brand | JS overlay, not persisted | Empty if no shade_id | Not handled |
| name (shade) | JS overlay, not persisted | Empty if no shade_id | Not handled |
| finish | JS overlay, not persisted | Empty if no shade_id | Not handled |
| collection | JS overlay, not persisted | Empty if no shade_id | Not handled |
| expirationDate | No DB column | No DB column | No DB column |
| filtering/search | N/A | All client-side | N/A |
| pagination | N/A | Returns all rows | N/A |

## Changes

### 1. New migration: `004_add_expiration_date.sql`
**File:** `packages/functions/migrations/004_add_expiration_date.sql`

```sql
ALTER TABLE user_inventory_item
  ADD COLUMN IF NOT EXISTS expiration_date DATE;

-- Down Migration
ALTER TABLE user_inventory_item
  DROP COLUMN IF EXISTS expiration_date;
```

### 2. Rewrite `createPolish` to find-or-create brand + shade
**File:** `packages/functions/src/functions/polishes.ts`

Use a transaction (from `db.ts`):
1. `INSERT INTO brand (name_canonical) VALUES ($1) ON CONFLICT (name_canonical) DO NOTHING` then `SELECT brand_id FROM brand WHERE name_canonical = $1`
2. Look up shade: `SELECT shade_id FROM shade WHERE brand_id = $1 AND shade_name_canonical = $2 AND product_line_id IS NULL AND COALESCE(finish, '') = COALESCE($3, '')`. If not found, `INSERT INTO shade (brand_id, shade_name_canonical, finish, collection, status) VALUES (...) RETURNING shade_id`
3. Insert `user_inventory_item` with the resolved `shade_id` — include `expiration_date`
4. Re-fetch via `POLISH_SELECT` — no more JS overlay needed

Why SELECT-then-INSERT for shade: the unique index uses `COALESCE(finish, '')` which makes `ON CONFLICT` impractical with expressions.

### 3. Rewrite `updatePolish` to handle brand/name/finish/collection
**File:** `packages/functions/src/functions/polishes.ts`

If brand/name/finish/collection are in the update body:
1. Find-or-create brand + shade (same logic as create)
2. Update `shade_id` on the inventory item

Always update the user-facing columns (quantity, notes, color, etc.) + `expiration_date`.

### 4. Add `expirationDate` to `POLISH_SELECT`
**File:** `packages/functions/src/functions/polishes.ts`

Add `ui.expiration_date AS "expirationDate"` to the shared SELECT fragment.

### 5. Add server-side filtering, search, sorting, and pagination to `getPolishes`
**File:** `packages/functions/src/functions/polishes.ts`

Parse query params from the request URL:
- `search` — `ILIKE '%term%'` across brand name, shade name, and color_name
- `brand` — exact match on `b.name_canonical`
- `finish` — exact match on `s.finish`
- `tags` — `ui.tags @> $1` (array contains)
- `sortBy` — map `name`→`s.shade_name_canonical`, `brand`→`b.name_canonical`, `createdAt`→`ui.created_at`, `rating`→`ui.rating` (whitelist to prevent injection)
- `sortOrder` — `ASC` or `DESC` (whitelist)
- `page` + `pageSize` — `LIMIT`/`OFFSET` with `COUNT(*) OVER()` for total

### 6. Handle `expirationDate` in create and update request params
**File:** `packages/functions/src/functions/polishes.ts`

Add `body.expirationDate` to the INSERT and UPDATE parameter lists.

## Files touched
1. `packages/functions/migrations/004_add_expiration_date.sql` — new migration
2. `packages/functions/src/functions/polishes.ts` — rewrite CRUD handlers

## Verification
1. `npm run build:functions` — confirm TypeScript compiles
2. With a local Postgres + `DATABASE_URL`:
   - `npm run migrate` — applies migration 004
   - POST `/api/polishes` with `{ brand: "OPI", name: "Test", color: "Red", colorHex: "#FF0000", finish: "cream" }` — verify `brand` and `shade` rows are created in DB, `shade_id` is set on inventory item
   - GET `/api/polishes` — verify brand/name/finish/collection come from DB (not empty)
   - GET `/api/polishes?search=OPI&page=1&pageSize=5` — verify filtered results with pagination
   - PUT `/api/polishes/{id}` with `{ brand: "Essie", name: "New Name" }` — verify shade_id updated
   - GET the same id — confirm updated brand/name
   - DELETE `/api/polishes/{id}` — confirm deletion
