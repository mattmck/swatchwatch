import { DUPE_LIMITS, type DupeShade } from "swatchwatch-shared";
import { query } from "./db";

/**
 * Data access + request parsing for the dupe finder (issue #265). The grading rule itself is
 * pure and lives in swatchwatch-shared (`color/dupes.ts`) so the web app can reuse it.
 */

export class DupesInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DupesInputError";
  }
}

/** Columns shared by the target and candidate queries (alias `s` = shade, `b` = brand). */
const DUPE_SHADE_COLUMNS = `
    s.shade_id::text                             AS "shadeId",
    COALESCE(b.name_canonical, '')               AS brand,
    COALESCE(s.shade_name_canonical, '')         AS name,
    s.vendor_hex                                 AS "vendorHex",
    s.detected_hex                               AS "detectedHex",
    s.name_hex                                   AS "nameHex",
    s.hex_agreement::float8                      AS "hexAgreement",
    COALESCE(NULLIF(s.finish, ''), s.finishes[1], '') AS finish,
    COALESCE(s.finishes, ARRAY[]::text[])        AS finishes`;

export type DupeShadeRow = DupeShade & { shadeId: string };

/**
 * The caller's owned shades with any hex: the dupe candidate pool. One query per request
 * (single or batch); OKLAB math runs in TypeScript over these rows.
 *
 * "Owned" is `user_inventory_item.status = 'owned'` (issue #261); wishlist, destash and
 * archived rows are never dupes. Scoped by `ui.user_id = $1`, so another user's inventory
 * can never enter the pool. Owned shades are always visible to their owner, so no extra
 * `user_submitted` visibility check is needed.
 */
export async function loadOwnedDupeShades(userId: number): Promise<DupeShadeRow[]> {
  const result = await query<DupeShadeRow>(
    `SELECT
${DUPE_SHADE_COLUMNS}
     FROM user_inventory_item ui
     JOIN shade s ON s.shade_id = ui.shade_id
     LEFT JOIN brand b ON b.brand_id = s.brand_id
     WHERE ui.user_id = $1
       AND ui.status = 'owned'
       AND (s.vendor_hex IS NOT NULL OR s.detected_hex IS NOT NULL OR s.name_hex IS NOT NULL)`,
    [userId]
  );
  return result.rows;
}

/**
 * Target shades the caller may see (same rule as the polish detail route: everything except
 * another user's private `user_submitted` shade). Ids that are missing or invisible are simply
 * absent from the result, so callers answer 404 / omit them without leaking existence.
 */
export async function loadVisibleDupeTargets(userId: number, shadeIds: number[]): Promise<DupeShadeRow[]> {
  if (shadeIds.length === 0) return [];
  const result = await query<DupeShadeRow>(
    `SELECT
${DUPE_SHADE_COLUMNS}
     FROM shade s
     LEFT JOIN brand b ON b.brand_id = s.brand_id
     WHERE s.shade_id = ANY($2::bigint[])
       AND (
         s.status <> 'user_submitted'
         OR s.created_by_user_id = $1
         OR EXISTS (
           SELECT 1 FROM user_inventory_item ui
           WHERE ui.shade_id = s.shade_id AND ui.user_id = $1
         )
       )`,
    [userId, shadeIds]
  );
  return result.rows;
}

const MAX_SHADE_ID = Number.MAX_SAFE_INTEGER;

/** Parse a shade id (number or numeric string) into a positive integer, or null. */
export function parseShadeId(value: unknown): number | null {
  let parsed: number;
  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "string" && /^\s*\d+\s*$/.test(value)) {
    parsed = Number(value.trim());
  } else {
    return null;
  }
  return Number.isInteger(parsed) && parsed > 0 && parsed <= MAX_SHADE_ID ? parsed : null;
}

/** Parse `?limit=` for `GET /api/polishes/{id}/dupes` (1–maxLimit, default defaultLimit). */
export function parseDupesLimit(value: string | null | undefined): number {
  if (value === null || value === undefined || value.trim() === "") return DUPE_LIMITS.defaultLimit;
  if (!/^\d+$/.test(value.trim())) {
    throw new DupesInputError("limit must be an integer");
  }
  const parsed = Number(value.trim());
  if (parsed < 1 || parsed > DUPE_LIMITS.maxLimit) {
    throw new DupesInputError(`limit must be between 1 and ${DUPE_LIMITS.maxLimit}`);
  }
  return parsed;
}

/**
 * Validate a `POST /api/polishes/dupes` body: `{ shadeIds: [...] }` with positive integer ids
 * (numbers or numeric strings), de-duplicated, at most `DUPE_LIMITS.batchMaxShadeIds`.
 * Order is preserved.
 */
export function parseDupesBatchRequest(body: unknown): number[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new DupesInputError("Request body must be a JSON object");
  }
  const { shadeIds } = body as Record<string, unknown>;
  if (!Array.isArray(shadeIds)) {
    throw new DupesInputError("shadeIds must be an array of shade ids");
  }
  const unique: number[] = [];
  const seen = new Set<number>();
  for (const raw of shadeIds) {
    const id = parseShadeId(raw);
    if (id === null) {
      throw new DupesInputError("shadeIds must contain positive integer shade ids");
    }
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }
  if (unique.length > DUPE_LIMITS.batchMaxShadeIds) {
    throw new DupesInputError(`shadeIds may contain at most ${DUPE_LIMITS.batchMaxShadeIds} ids`);
  }
  return unique;
}
