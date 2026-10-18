/**
 * Mani log helpers (issue #269): request validation (pure, unit-tested directly) and the SQL
 * that keeps inventory wear stats and `inventory_event(used)` rows in step with the
 * `manicure` / `manicure_polish` tables.
 *
 * Wear stats are DERIVED from the mani log, never incremented/decremented:
 * - `wear_count`   = number of the user's manicures that include the shade
 * - `last_worn_at` = latest `worn_on` of those manicures (midnight UTC), NULL when none
 * - `tried_at`     = filled from the earliest `worn_on` only when it is NULL; never cleared
 * `recomputeWearStats` rewrites them for the affected shades after every create/edit/delete,
 * so an edit that moves a date or swaps a polish, or a delete, cannot drift the counters.
 */
import type { PoolClient } from "pg";
import {
  DEFAULT_MANICURE_POLISH_ROLE,
  MANICURE_POLISH_ROLES,
  MAX_MANICURE_NOTES_LENGTH,
  MAX_MANICURE_POLISHES,
  isManicurePolishRole,
  type ManicurePolishRole,
  type ManicureWearStat,
} from "swatchwatch-shared";

/** Invalid client input (400) or a reference the caller may not use (404). */
export class ManicureRequestError extends Error {
  constructor(
    public readonly status: 400 | 404,
    message: string
  ) {
    super(message);
    this.name = "ManicureRequestError";
  }
}

const badRequest = (message: string) => new ManicureRequestError(400, message);

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DIGITS_RE = /^\d+$/;
/** Earliest accepted `worn_on`. */
export const MIN_WORN_ON = "1900-01-01";
const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MANICURE_PAGE_SIZE = 50;
export const MAX_MANICURE_PAGE_SIZE = 200;

/** `YYYY-MM-DD` of `now` in UTC. */
export function todayUtcIsoDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Strict positive id: a safe integer > 0, given as a number or an all-digit string
 * (`parseInt("12abc")` would accept garbage).
 */
export function parsePositiveId(value: unknown, name: string): number {
  let parsed: number;
  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "string" && DIGITS_RE.test(value.trim())) {
    parsed = Number(value.trim());
  } else {
    throw badRequest(`${name} must be a positive integer`);
  }
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw badRequest(`${name} must be a positive integer`);
  }
  return parsed;
}

/**
 * Validate a calendar date `YYYY-MM-DD` (rejects impossible dates such as 2026-02-30).
 * `latest` (inclusive) caps future dates; a day of slack over UTC "today" covers every timezone.
 */
export function parseIsoDate(value: unknown, name: string, latest?: string): string {
  if (typeof value !== "string" || !ISO_DATE_RE.test(value.trim())) {
    throw badRequest(`${name} must be a date in YYYY-MM-DD format`);
  }
  const trimmed = value.trim();
  const parsed = new Date(`${trimmed}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== trimmed) {
    throw badRequest(`${name} is not a valid date`);
  }
  if (trimmed < MIN_WORN_ON) {
    throw badRequest(`${name} must be on or after ${MIN_WORN_ON}`);
  }
  if (latest && trimmed > latest) {
    throw badRequest(`${name} cannot be in the future`);
  }
  return trimmed;
}

/** Latest accepted `wornOn`: tomorrow in UTC (the user's local "today" in any timezone). */
export function latestWornOn(now: Date = new Date()): string {
  return todayUtcIsoDate(new Date(now.getTime() + DAY_MS));
}

/** One validated polish reference (exactly one of `shadeId` / `inventoryItemId`). */
export interface ManicurePolishRef {
  shadeId?: number;
  inventoryItemId?: number;
  role: ManicurePolishRole;
}

export interface ParsedManicureBody {
  wornOn: string | undefined;
  /** `undefined` = not sent (keep), `null` = clear. */
  notes: string | null | undefined;
  /** `undefined` = not sent (keep), `null` = clear. */
  photoImageId: number | null | undefined;
  /** `undefined` = not sent (keep the list on update). */
  polishes: ManicurePolishRef[] | undefined;
}

function parseNotes(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== "string") throw badRequest("notes must be a string");
  const trimmed = value.trim();
  if (trimmed.length > MAX_MANICURE_NOTES_LENGTH) {
    throw badRequest(`notes must be at most ${MAX_MANICURE_NOTES_LENGTH} characters`);
  }
  return trimmed.length > 0 ? trimmed : null;
}

function parsePolishes(value: unknown): ManicurePolishRef[] {
  if (!Array.isArray(value)) throw badRequest("polishes must be an array");
  if (value.length === 0) throw badRequest("polishes must include at least one polish");
  if (value.length > MAX_MANICURE_POLISHES) {
    throw badRequest(`polishes can include at most ${MAX_MANICURE_POLISHES} entries`);
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw badRequest(`polishes[${index}] must be an object`);
    }
    const source = entry as Record<string, unknown>;
    const hasShade = source.shadeId !== undefined && source.shadeId !== null;
    const hasItem = source.inventoryItemId !== undefined && source.inventoryItemId !== null;
    if (hasShade === hasItem) {
      throw badRequest(`polishes[${index}] needs exactly one of shadeId or inventoryItemId`);
    }
    const role = source.role === undefined || source.role === null ? DEFAULT_MANICURE_POLISH_ROLE : source.role;
    if (!isManicurePolishRole(role)) {
      throw badRequest(`polishes[${index}].role must be one of: ${MANICURE_POLISH_ROLES.join(", ")}`);
    }
    return hasShade
      ? { shadeId: parsePositiveId(source.shadeId, `polishes[${index}].shadeId`), role }
      : { inventoryItemId: parsePositiveId(source.inventoryItemId, `polishes[${index}].inventoryItemId`), role };
  });
}

/**
 * Validate a create (`mode: "create"`, `polishes` required, `wornOn` defaults to today UTC) or
 * update (`mode: "update"`, every field optional) body.
 * @throws ManicureRequestError (400) on any invalid value.
 */
export function parseManicureBody(
  body: unknown,
  mode: "create" | "update",
  now: Date = new Date()
): ParsedManicureBody {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw badRequest("Request body must be a JSON object");
  }
  const source = body as Record<string, unknown>;

  let wornOn: string | undefined;
  if (source.wornOn !== undefined && source.wornOn !== null) {
    wornOn = parseIsoDate(source.wornOn, "wornOn", latestWornOn(now));
  } else if (source.wornOn === null) {
    throw badRequest("wornOn cannot be null");
  } else if (mode === "create") {
    wornOn = todayUtcIsoDate(now);
  }

  const photoImageId =
    source.photoImageId === undefined || source.photoImageId === null
      ? (source.photoImageId as null | undefined)
      : parsePositiveId(source.photoImageId, "photoImageId");

  let polishes: ManicurePolishRef[] | undefined;
  if (source.polishes !== undefined) {
    polishes = parsePolishes(source.polishes);
  } else if (mode === "create") {
    throw badRequest("polishes is required");
  }

  const parsed: ParsedManicureBody = {
    wornOn,
    notes: parseNotes(source.notes),
    photoImageId,
    polishes,
  };
  if (
    mode === "update" &&
    parsed.wornOn === undefined &&
    parsed.notes === undefined &&
    parsed.photoImageId === undefined &&
    parsed.polishes === undefined
  ) {
    throw badRequest("Nothing to update: send wornOn, notes, photoImageId or polishes");
  }
  return parsed;
}

export interface ManicureListQuery {
  from: string | null;
  to: string | null;
  shadeId: number | null;
  page: number;
  pageSize: number;
}

function parsePagingParam(value: string | null, name: string, fallback: number, max?: number): number {
  if (value === null || value.trim() === "") return fallback;
  const parsed = parsePositiveId(value, name);
  return max ? Math.min(parsed, max) : parsed;
}

/**
 * Parse `GET /api/manicures` query params: `from` / `to` (inclusive `YYYY-MM-DD`), `shadeId`,
 * `page` (default 1) and `pageSize` (default 50, capped at 200).
 * @throws ManicureRequestError (400) on invalid values or `from` after `to`.
 */
export function parseManicureListQuery(params: URLSearchParams): ManicureListQuery {
  const fromParam = params.get("from");
  const toParam = params.get("to");
  const shadeParam = params.get("shadeId");
  const from = fromParam ? parseIsoDate(fromParam, "from") : null;
  const to = toParam ? parseIsoDate(toParam, "to") : null;
  if (from && to && from > to) {
    throw badRequest("from must be on or before to");
  }
  return {
    from,
    to,
    shadeId: shadeParam ? parsePositiveId(shadeParam, "shadeId") : null,
    page: parsePagingParam(params.get("page"), "page", 1),
    pageSize: parsePagingParam(params.get("pageSize"), "pageSize", DEFAULT_MANICURE_PAGE_SIZE, MAX_MANICURE_PAGE_SIZE),
  };
}

/** A polish reference resolved to a shade, with its position (array order). */
export interface ResolvedManicurePolish {
  shadeId: number;
  role: ManicurePolishRole;
  position: number;
}

/**
 * Resolve request polish refs against the caller's inventory (`user_inventory_item` rows of
 * `userId` only). `keepShadeIds` are shades already on the manicure being edited: they stay
 * referenceable by `shadeId` even if the caller has since removed them from the collection.
 *
 * @throws ManicureRequestError 404 when a ref is not in the caller's inventory (another user's
 *   item, an unknown id, or a catalog shade the caller does not hold — the same answer for all,
 *   so other users' data never leaks), 400 on a duplicate shade + role pair.
 */
export async function resolveManicurePolishes(
  client: PoolClient,
  userId: number,
  refs: ManicurePolishRef[],
  keepShadeIds: ReadonlySet<number> = new Set()
): Promise<ResolvedManicurePolish[]> {
  const shadeIds = refs.flatMap((ref) => (ref.shadeId !== undefined ? [ref.shadeId] : []));
  const itemIds = refs.flatMap((ref) => (ref.inventoryItemId !== undefined ? [ref.inventoryItemId] : []));

  const owned = await client.query<{ inventoryItemId: string; shadeId: string }>(
    `SELECT inventory_item_id::text AS "inventoryItemId", shade_id::text AS "shadeId"
     FROM user_inventory_item
     WHERE user_id = $1
       AND shade_id IS NOT NULL
       AND (shade_id = ANY($2::bigint[]) OR inventory_item_id = ANY($3::bigint[]))`,
    [userId, shadeIds, itemIds]
  );
  const ownedShades = new Set(owned.rows.map((row) => Number(row.shadeId)));
  const shadeByItem = new Map(owned.rows.map((row) => [Number(row.inventoryItemId), Number(row.shadeId)]));

  const seen = new Set<string>();
  return refs.map((ref, position) => {
    let shadeId: number | undefined;
    if (ref.shadeId !== undefined) {
      if (ownedShades.has(ref.shadeId) || keepShadeIds.has(ref.shadeId)) shadeId = ref.shadeId;
    } else if (ref.inventoryItemId !== undefined) {
      shadeId = shadeByItem.get(ref.inventoryItemId);
    }
    if (shadeId === undefined) {
      throw new ManicureRequestError(
        404,
        `polishes[${position}] is not in your collection`
      );
    }
    const key = `${shadeId}:${ref.role}`;
    if (seen.has(key)) {
      throw badRequest(`polishes[${position}] repeats a polish with the same role`);
    }
    seen.add(key);
    return { shadeId, role: ref.role, position };
  });
}

/**
 * Lock the caller's inventory rows for `shadeIds` (in id order, so concurrent writers cannot
 * deadlock). Held until commit: a concurrent mani-log write for the same polish waits here, and
 * its recomputation (a later statement, so a fresh READ COMMITTED snapshot) sees this one's rows.
 */
export async function lockInventoryRows(client: PoolClient, userId: number, shadeIds: number[]): Promise<void> {
  if (shadeIds.length === 0) return;
  await client.query(
    `SELECT inventory_item_id
     FROM user_inventory_item
     WHERE user_id = $1 AND shade_id = ANY($2::bigint[])
     ORDER BY inventory_item_id
     FOR UPDATE`,
    [userId, shadeIds]
  );
}

/** Replace a manicure's polish rows (caller has verified the manicure belongs to the user). */
export async function replaceManicurePolishes(
  client: PoolClient,
  manicureId: number,
  polishes: ResolvedManicurePolish[],
  { deleteExisting }: { deleteExisting: boolean }
): Promise<void> {
  if (deleteExisting) {
    await client.query(`DELETE FROM manicure_polish WHERE manicure_id = $1`, [manicureId]);
  }
  await client.query(
    `INSERT INTO manicure_polish (manicure_id, shade_id, role, position)
     SELECT $1, p.shade_id, p.role, p.position
     FROM unnest($2::bigint[], $3::text[], $4::int[]) AS p(shade_id, role, position)`,
    [
      manicureId,
      polishes.map((p) => p.shadeId),
      polishes.map((p) => p.role),
      polishes.map((p) => p.position),
    ]
  );
}

interface WearStatRow {
  shadeId: string;
  inventoryItemId: string;
  wearCount: number | string;
  lastWornAt: Date | string | null;
  triedAt: Date | string | null;
}

function toIso(value: Date | string | null): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

/**
 * Re-attach the caller's detached `inventory_event` rows (left by deleting a polish from the
 * collection, D8 / #317) for `shadeIds` to their current inventory row for the same shade.
 * A no-op for shades the caller does not hold.
 */
export async function reattachInventoryEvents(client: PoolClient, userId: number, shadeIds: number[]): Promise<void> {
  if (shadeIds.length === 0) return;
  await client.query(
    `UPDATE inventory_event ie
     SET inventory_item_id = ui.inventory_item_id
     FROM user_inventory_item ui
     WHERE ie.user_id = $1
       AND ie.inventory_item_id IS NULL
       AND ie.shade_id = ANY($2::bigint[])
       AND ui.user_id = $1
       AND ui.shade_id = ie.shade_id`,
    [userId, shadeIds]
  );
}

/**
 * Recompute wear stats for the caller's inventory rows of `shadeIds` from the mani log (see the
 * file comment), after re-attaching their detached events (`reattachInventoryEvents`, so a
 * re-added polish gets its history back). `fillTriedAt: false` leaves `tried_at` alone (used by
 * the polishes API, where the user may have just cleared it on purpose). Returns the new stats
 * of every row it touched; shades the caller has no inventory row for are skipped.
 */
export async function recomputeWearStats(
  client: PoolClient,
  userId: number,
  shadeIds: number[],
  { fillTriedAt = true }: { fillTriedAt?: boolean } = {}
): Promise<ManicureWearStat[]> {
  const unique = Array.from(new Set(shadeIds));
  if (unique.length === 0) return [];
  await reattachInventoryEvents(client, userId, unique);
  const result = await client.query<WearStatRow>(
    `WITH target AS (
       SELECT DISTINCT unnest($2::bigint[]) AS shade_id
     ),
     wear AS (
       SELECT mp.shade_id,
              COUNT(DISTINCT m.manicure_id)::int AS wear_count,
              MAX(m.worn_on) AS last_worn_on,
              MIN(m.worn_on) AS first_worn_on
       FROM manicure m
       JOIN manicure_polish mp ON mp.manicure_id = m.manicure_id
       WHERE m.user_id = $1
         AND mp.shade_id = ANY($2::bigint[])
       GROUP BY mp.shade_id
     )
     UPDATE user_inventory_item ui
     SET wear_count   = COALESCE(w.wear_count, 0),
         last_worn_at = w.last_worn_on::timestamp AT TIME ZONE 'UTC',
         tried_at     = CASE
                          WHEN $3::boolean THEN COALESCE(ui.tried_at, w.first_worn_on::timestamp AT TIME ZONE 'UTC')
                          ELSE ui.tried_at
                        END,
         updated_at   = now()
     FROM target t
     LEFT JOIN wear w ON w.shade_id = t.shade_id
     WHERE ui.user_id = $1
       AND ui.shade_id = t.shade_id
     RETURNING ui.shade_id::text AS "shadeId",
               ui.inventory_item_id::text AS "inventoryItemId",
               ui.wear_count AS "wearCount",
               ui.last_worn_at AS "lastWornAt",
               ui.tried_at AS "triedAt"`,
    [userId, unique, fillTriedAt]
  );
  return result.rows
    .map((row) => ({
      shadeId: row.shadeId,
      inventoryItemId: row.inventoryItemId,
      wearCount: Number(row.wearCount),
      lastWornAt: toIso(row.lastWornAt),
      triedAt: toIso(row.triedAt),
    }))
    .sort((a, b) => Number(a.shadeId) - Number(b.shadeId));
}

/**
 * Bring the manicure's `inventory_event(used)` rows in line with its current polishes: one event
 * per shade (payload: `wornOn`, `roles`), attached to the caller's inventory row for that shade,
 * or detached (`inventory_item_id` NULL) when the polish is no longer in the collection (D8,
 * #317). Events of shades no longer on the manicure are deleted, remaining ones get the current
 * payload and inventory row, and new shades get a new event (so an event keeps its original
 * `created_at` across edits). Deleting the manicure removes its events through
 * `inventory_event.manicure_id ON DELETE CASCADE`.
 */
export async function syncManicureEvents(client: PoolClient, userId: number, manicureId: number): Promise<void> {
  const current = `
    SELECT mp.shade_id,
           ui.inventory_item_id,
           jsonb_build_object(
             'source', 'manicure',
             'manicureId', m.manicure_id::text,
             'wornOn', to_char(m.worn_on, 'YYYY-MM-DD'),
             'roles', jsonb_agg(DISTINCT mp.role ORDER BY mp.role)
           ) AS payload
    FROM manicure m
    JOIN manicure_polish mp ON mp.manicure_id = m.manicure_id
    LEFT JOIN user_inventory_item ui ON ui.user_id = m.user_id AND ui.shade_id = mp.shade_id
    WHERE m.manicure_id = $2 AND m.user_id = $1
    GROUP BY mp.shade_id, ui.inventory_item_id, m.manicure_id, m.worn_on`;

  await client.query(
    `DELETE FROM inventory_event ie
     WHERE ie.manicure_id = $2
       AND ie.user_id = $1
       AND ie.event_type = 'used'
       AND (ie.shade_id IS NULL OR ie.shade_id NOT IN (SELECT c.shade_id FROM (${current}) c))`,
    [userId, manicureId]
  );
  await client.query(
    `UPDATE inventory_event ie
     SET event_payload = c.payload,
         inventory_item_id = c.inventory_item_id
     FROM (${current}) c
     WHERE ie.manicure_id = $2
       AND ie.user_id = $1
       AND ie.event_type = 'used'
       AND ie.shade_id = c.shade_id`,
    [userId, manicureId]
  );
  await client.query(
    `INSERT INTO inventory_event (inventory_item_id, user_id, shade_id, event_type, event_payload, manicure_id)
     SELECT c.inventory_item_id, $1, c.shade_id, 'used', c.payload, $2
     FROM (${current}) c
     WHERE NOT EXISTS (
       SELECT 1 FROM inventory_event ie
       WHERE ie.manicure_id = $2
         AND ie.user_id = $1
         AND ie.event_type = 'used'
         AND ie.shade_id = c.shade_id
     )`,
    [userId, manicureId]
  );
}
