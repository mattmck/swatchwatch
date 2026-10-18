import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import {
  type FinishNormalization,
  type FinishNormalizationCreateRequest,
  type FinishNormalizationListResponse,
  type FinishNormalizationUpdateRequest,
  type FinishType,
  type FinishTypeCreateRequest,
  type FinishTypeInUseResponse,
  type FinishTypeListResponse,
  type FinishTypeNameTakenResponse,
  type FinishTypeRenameSummary,
  type FinishTypeUpdateRequest,
  type FinishTypeUpdateResponse,
  type HarmonyTypeCreateRequest,
  type HarmonyTypeListResponse,
  type HarmonyTypeUpdateRequest,
  type AdminJobsListResponse,
  type IngestionJob,
  type ReferenceHarmonyType,
} from "swatchwatch-shared";
import { withAdmin } from "../lib/auth";
import { query, transaction } from "../lib/db";
import { withCors } from "../lib/http";
import { cacheDelete, cacheDeleteByPrefix } from "../lib/cache";
import { normalizeFinishKey, resetFinishAliasCache } from "../lib/finishes";
import { FINISH_FAMILY_INVALID_MESSAGE, parseFinishFamilyField, toFinishFamily } from "../lib/finish-family";

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const VALID_JOB_STATUSES = new Set(["queued", "running", "succeeded", "failed", "cancelled"]);

async function invalidateReferenceCaches(): Promise<void> {
  // In-process finish alias cache (other instances pick up changes within its 5 min TTL).
  resetFinishAliasCache();
  await Promise.all([
    cacheDelete("reference:finishes"),
    cacheDelete("reference:harmonies"),
    cacheDeleteByPrefix("catalog:search:"),
  ]);
}

function parseInteger(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function parsePositiveId(rawId: string | undefined): number | null {
  if (!rawId) return null;
  const id = Number.parseInt(rawId, 10);
  if (!Number.isFinite(id) || id <= 0) return null;
  return id;
}

function hasOwn(value: unknown, key: string): boolean {
  return typeof value === "object" && value !== null && Object.prototype.hasOwnProperty.call(value, key);
}

function getFieldString(
  body: unknown,
  camelKey: string,
  snakeKey: string
): { provided: boolean; value: string | null; invalid: boolean } {
  const hasCamel = hasOwn(body, camelKey);
  const hasSnake = hasOwn(body, snakeKey);
  if (!hasCamel && !hasSnake) {
    return { provided: false, value: null, invalid: false };
  }

  const raw = (body as Record<string, unknown>)[hasCamel ? camelKey : snakeKey];
  if (typeof raw !== "string") {
    return { provided: true, value: null, invalid: true };
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return { provided: true, value: null, invalid: true };
  }

  return { provided: true, value: trimmed, invalid: false };
}

function getOptionalDescription(
  body: unknown,
  camelKey: string,
  snakeKey: string
): { provided: boolean; value: string | null; invalid: boolean } {
  const hasCamel = hasOwn(body, camelKey);
  const hasSnake = hasOwn(body, snakeKey);
  if (!hasCamel && !hasSnake) {
    return { provided: false, value: null, invalid: false };
  }

  const raw = (body as Record<string, unknown>)[hasCamel ? camelKey : snakeKey];
  if (raw === null) {
    return { provided: true, value: null, invalid: false };
  }
  if (typeof raw !== "string") {
    return { provided: true, value: null, invalid: true };
  }

  const trimmed = raw.trim();
  return { provided: true, value: trimmed || null, invalid: false };
}

function getOptionalSortOrder(
  body: unknown
): { provided: boolean; value: number; invalid: boolean } {
  const hasCamel = hasOwn(body, "sortOrder");
  const hasSnake = hasOwn(body, "sort_order");
  if (!hasCamel && !hasSnake) {
    return { provided: false, value: 0, invalid: false };
  }
  const raw = (body as Record<string, unknown>)[hasCamel ? "sortOrder" : "sort_order"];
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    return { provided: true, value: 0, invalid: true };
  }

  return { provided: true, value: raw, invalid: false };
}

function mapFinishTypeRow(row: {
  finishTypeId: number;
  name: string;
  displayName: string;
  description: string | null;
  sortOrder: number;
  family: string | null;
  createdAt: string;
  updatedAt: string;
  updatedByUserId: number | null;
}): FinishType {
  return {
    finishTypeId: row.finishTypeId,
    name: row.name,
    displayName: row.displayName,
    description: row.description || undefined,
    sortOrder: row.sortOrder,
    family: toFinishFamily(row.family),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    updatedByUserId: row.updatedByUserId ?? undefined,
  };
}

function mapHarmonyTypeRow(row: {
  harmonyTypeId: number;
  name: string;
  displayName: string;
  description: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  updatedByUserId: number | null;
}): ReferenceHarmonyType {
  return {
    harmonyTypeId: row.harmonyTypeId,
    name: row.name,
    displayName: row.displayName,
    description: row.description || undefined,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    updatedByUserId: row.updatedByUserId ?? undefined,
  };
}

function mapFinishNormalizationRow(row: {
  finishNormalizationId: number;
  sourceValue: string;
  normalizedFinishName: string;
  createdAt: string;
  updatedAt: string;
  updatedByUserId: number | null;
}): FinishNormalization {
  return {
    finishNormalizationId: row.finishNormalizationId,
    sourceValue: row.sourceValue,
    normalizedFinishName: row.normalizedFinishName,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    updatedByUserId: row.updatedByUserId ?? undefined,
  };
}

async function listAdminFinishes(
  _request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  context.log("GET /api/reference-admin/finishes");

  try {
    const result = await query<{
      finishTypeId: number;
      name: string;
      displayName: string;
      description: string | null;
      sortOrder: number;
      family: string | null;
      createdAt: string;
      updatedAt: string;
      updatedByUserId: number | null;
    }>(
      `SELECT
         finish_type_id AS "finishTypeId",
         name,
         display_name AS "displayName",
         description,
         sort_order AS "sortOrder",
         family,
         created_at::text AS "createdAt",
         updated_at::text AS "updatedAt",
         updated_by_user_id AS "updatedByUserId"
       FROM finish_type
       ORDER BY sort_order ASC, display_name ASC`
    );

    return {
      status: 200,
      jsonBody: { finishTypes: result.rows.map(mapFinishTypeRow) } satisfies FinishTypeListResponse,
    };
  } catch (error) {
    context.error("Error listing admin finishes:", error);
    return {
      status: 500,
      jsonBody: { error: "Failed to list finishes" },
    };
  }
}

async function createFinish(
  request: HttpRequest,
  context: InvocationContext,
  userId: number
): Promise<HttpResponseInit> {
  context.log("POST /api/reference-admin/finishes");

  let body: Partial<FinishTypeCreateRequest> | undefined;
  try {
    body = (await request.json()) as Partial<FinishTypeCreateRequest>;
  } catch {
    return { status: 400, jsonBody: { error: "Request body must be valid JSON" } };
  }

  const nameField = getFieldString(body, "name", "name");
  const displayNameField = getFieldString(body, "displayName", "display_name");
  const descriptionField = getOptionalDescription(body, "description", "description");
  const sortOrderField = getOptionalSortOrder(body);
  const familyField = parseFinishFamilyField(body);

  if (nameField.invalid || displayNameField.invalid) {
    return {
      status: 400,
      jsonBody: { error: "name and displayName (or display_name) are required non-empty strings" },
    };
  }
  if (descriptionField.invalid) {
    return {
      status: 400,
      jsonBody: { error: "description must be a string or null" },
    };
  }
  if (sortOrderField.invalid) {
    return {
      status: 400,
      jsonBody: { error: "sortOrder (or sort_order) must be an integer" },
    };
  }
  if (familyField.invalid) {
    return { status: 400, jsonBody: { error: FINISH_FAMILY_INVALID_MESSAGE } };
  }
  if (!nameField.provided || !displayNameField.provided) {
    return {
      status: 400,
      jsonBody: { error: "name and displayName (or display_name) are required" },
    };
  }

  try {
    const result = await query<{
      finishTypeId: number;
      name: string;
      displayName: string;
      description: string | null;
      sortOrder: number;
      family: string | null;
      createdAt: string;
      updatedAt: string;
      updatedByUserId: number | null;
    }>(
      `INSERT INTO finish_type (
         name,
         display_name,
         description,
         sort_order,
         family,
         updated_at,
         updated_by_user_id
       )
       VALUES ($1, $2, $3, $4, $5, now(), $6)
       RETURNING
         finish_type_id AS "finishTypeId",
         name,
         display_name AS "displayName",
         description,
         sort_order AS "sortOrder",
         family,
         created_at::text AS "createdAt",
         updated_at::text AS "updatedAt",
         updated_by_user_id AS "updatedByUserId"`,
      [
        nameField.value,
        displayNameField.value,
        descriptionField.provided ? descriptionField.value : null,
        sortOrderField.provided ? sortOrderField.value : 0,
        familyField.value,
        userId,
      ]
    );

    await invalidateReferenceCaches();

    return {
      status: 201,
      jsonBody: mapFinishTypeRow(result.rows[0]),
    };
  } catch (error: unknown) {
    context.error("Error creating finish:", error);
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
      return { status: 409, jsonBody: { error: "Finish with that name already exists" } };
    }
    return { status: 500, jsonBody: { error: "Failed to create finish" } };
  }
}

interface FinishTypeRow {
  finishTypeId: number;
  name: string;
  displayName: string;
  description: string | null;
  sortOrder: number;
  family: string | null;
  createdAt: string;
  updatedAt: string;
  updatedByUserId: number | null;
}

const FINISH_TYPE_RETURNING_SQL = `finish_type_id AS "finishTypeId",
         name,
         display_name AS "displayName",
         description,
         sort_order AS "sortOrder",
         family,
         created_at::text AS "createdAt",
         updated_at::text AS "updatedAt",
         updated_by_user_id AS "updatedByUserId"`;

/** SQL twin of `normalizeFinishKey` (lib/finishes.ts): lowercase, collapse whitespace, trim. */
function finishKeySql(expression: string): string {
  return `btrim(regexp_replace(lower(${expression}), '\\s+', ' ', 'g'))`;
}

/** $1 = finish_type_id being renamed, $2 = normalized new name. */
export const FINISH_NAME_CONFLICT_SQL = `SELECT finish_type_id AS "finishTypeId", name
   FROM finish_type
   WHERE finish_type_id <> $1
     AND ${finishKeySql("name")} = $2::text
   ORDER BY finish_type_id
   LIMIT 1`;

/**
 * `column` with every entry whose key equals $1 replaced by $2, in the original order, keeping
 * only the first occurrence of each value (so `{mirror,chrome}` renamed chrome → mirror is `{mirror}`).
 */
function renameFinishArraySql(column: string): string {
  return `ARRAY(
             SELECT d.value
             FROM (
               SELECT CASE WHEN ${finishKeySql("u.value")} = $1::text THEN $2::text ELSE u.value END AS value,
                      min(u.ord) AS first_ord
               FROM unnest(${column}) WITH ORDINALITY AS u(value, ord)
               GROUP BY 1
             ) d
             ORDER BY d.first_ord
           )`;
}

/**
 * Rewrite one finish on every shade: $1 = old finish key, $2 = new finish key.
 *
 * - `finishes` / `detected_finishes`: matching entries (case-insensitive) become the new key.
 * - A shade with an empty `finishes` whose legacy `finish` is the old finish gets
 *   `finishes = {new}` (the 023 backfill rule), so it keeps the finish under its new name.
 * - The legacy `finish` column itself is never written: it is the shade's raw vendor value and
 *   part of the identity/dedup key (`idx_shade_unique`, ingestion shade matching).
 *
 * Shade has no triggers; stored generated columns (e.g. `hex_agreement`) recompute on update.
 * Matching is case-insensitive, so it cannot use `idx_shade_finishes` and scans `shade` once.
 */
export const RENAME_SHADE_FINISHES_SQL = `WITH rewritten AS (
   UPDATE shade s
   SET finishes = CASE
         WHEN cardinality(s.finishes) = 0 AND ${finishKeySql("s.finish")} = $1::text THEN ARRAY[$2::text]
         ELSE ${renameFinishArraySql("s.finishes")}
       END,
       detected_finishes = CASE
         WHEN s.detected_finishes IS NULL THEN NULL
         ELSE ${renameFinishArraySql("s.detected_finishes")}
       END,
       updated_at = now()
   WHERE EXISTS (SELECT 1 FROM unnest(s.finishes) AS f(value) WHERE ${finishKeySql("f.value")} = $1::text)
      OR (cardinality(s.finishes) = 0 AND ${finishKeySql("s.finish")} = $1::text)
      OR EXISTS (SELECT 1 FROM unnest(s.detected_finishes) AS f(value) WHERE ${finishKeySql("f.value")} = $1::text)
   RETURNING s.shade_id
 )
 SELECT count(*)::int AS "shadeCount" FROM rewritten`;

/**
 * Add alias old key → new finish name ($1 = old key, $2 = new `finish_type.name`, $3 = admin
 * user id) unless an alias for that spelling already exists (an alias that pointed at the old
 * name was already repointed by the rename).
 */
export const FINISH_RENAME_ALIAS_SQL = `INSERT INTO finish_normalization (source_value, normalized_finish_name, updated_at, updated_by_user_id)
   SELECT $1::text, $2::text, now(), $3
   WHERE NOT EXISTS (
     SELECT 1 FROM finish_normalization fn WHERE ${finishKeySql("fn.source_value")} = $1::text
   )
   ON CONFLICT (source_value) DO NOTHING
   RETURNING finish_normalization_id`;

/** Message shown in the admin console when a rename target name is already taken. */
export function finishTypeNameTakenMessage(displayName: string, requestedName: string, conflictingName: string): string {
  return `Cannot rename finish "${displayName}" to "${requestedName}": finish type "${conflictingName}" already exists.`;
}

/**
 * PUT a finish type. A `name` change is a RENAME that cascades atomically (one transaction):
 *
 * 1. Lock the row; 409 `FINISH_TYPE_NAME_TAKEN` when another finish type already has the new
 *    name (case-insensitive, whitespace collapsed). A case-only rename of the same row is allowed.
 * 2. Update `finish_type` and repoint `finish_normalization` rows that target the old name in
 *    ONE statement (the FK is not deferrable and has no ON UPDATE CASCADE).
 * 3. When the finish key changes: rewrite `shade.finishes` / `shade.detected_finishes`
 *    (`RENAME_SHADE_FINISHES_SQL`) and add an alias old name → new name
 *    (`FINISH_RENAME_ALIAS_SQL`). The legacy `shade.finish` is left alone because it is the raw
 *    vendor identity/dedup key; rewriting it would make the next ingestion run miss the shade
 *    and insert a duplicate. The alias keeps the old spelling resolving instead.
 *
 * The response carries `rename` counts. Caches are cleared only after a successful commit.
 */
async function updateFinish(
  request: HttpRequest,
  context: InvocationContext,
  userId: number
): Promise<HttpResponseInit> {
  context.log("PUT /api/reference-admin/finishes/{id}");

  const id = parsePositiveId(request.params.id);
  if (!id) {
    return { status: 400, jsonBody: { error: "finish id must be a positive integer" } };
  }

  let body: Partial<FinishTypeUpdateRequest> | undefined;
  try {
    body = (await request.json()) as Partial<FinishTypeUpdateRequest>;
  } catch {
    return { status: 400, jsonBody: { error: "Request body must be valid JSON" } };
  }

  const nameField = getFieldString(body, "name", "name");
  const displayNameField = getFieldString(body, "displayName", "display_name");
  const descriptionField = getOptionalDescription(body, "description", "description");
  const sortOrderField = getOptionalSortOrder(body);
  const familyField = parseFinishFamilyField(body);

  if (nameField.invalid) {
    return { status: 400, jsonBody: { error: "name must be a non-empty string" } };
  }
  if (displayNameField.invalid) {
    return { status: 400, jsonBody: { error: "displayName (or display_name) must be a non-empty string" } };
  }
  if (descriptionField.invalid) {
    return { status: 400, jsonBody: { error: "description must be a string or null" } };
  }
  if (sortOrderField.invalid) {
    return { status: 400, jsonBody: { error: "sortOrder (or sort_order) must be an integer" } };
  }
  if (familyField.invalid) {
    return { status: 400, jsonBody: { error: FINISH_FAMILY_INVALID_MESSAGE } };
  }

  if (
    !nameField.provided &&
    !displayNameField.provided &&
    !descriptionField.provided &&
    !sortOrderField.provided &&
    !familyField.provided
  ) {
    return {
      status: 400,
      jsonBody: {
        error: "At least one of name, displayName/display_name, description, sortOrder/sort_order, family is required",
      },
    };
  }

  const setClauses: string[] = [];
  const params: Array<string | number | null> = [];

  if (nameField.provided) {
    params.push(nameField.value);
    setClauses.push(`name = $${params.length}`);
  }
  if (displayNameField.provided) {
    params.push(displayNameField.value);
    setClauses.push(`display_name = $${params.length}`);
  }
  if (descriptionField.provided) {
    params.push(descriptionField.value);
    setClauses.push(`description = $${params.length}`);
  }
  if (sortOrderField.provided) {
    params.push(sortOrderField.value);
    setClauses.push(`sort_order = $${params.length}`);
  }
  if (familyField.provided) {
    params.push(familyField.value);
    setClauses.push(`family = $${params.length}`);
  }

  params.push(userId);
  const userParam = params.length;
  setClauses.push(`updated_by_user_id = $${userParam}`);
  setClauses.push("updated_at = now()");
  params.push(id);
  const idParam = params.length;

  type UpdateOutcome =
    | { kind: "not_found" }
    | { kind: "name_taken"; body: FinishTypeNameTakenResponse }
    | { kind: "updated"; row: FinishTypeRow; rename?: FinishTypeRenameSummary };

  try {
    const outcome = await transaction<UpdateOutcome>(async (client) => {
      // Lock the row: a concurrent finish_normalization insert pointing at the old name
      // (FOR KEY SHARE) waits for this transaction and then fails its FK check cleanly.
      const current = await client.query<{ finishTypeId: number; name: string; displayName: string | null }>(
        `SELECT finish_type_id AS "finishTypeId", name, display_name AS "displayName"
         FROM finish_type
         WHERE finish_type_id = $1
         FOR UPDATE`,
        [id]
      );
      if (current.rows.length === 0) {
        return { kind: "not_found" };
      }

      const previousName = current.rows[0].name;
      const newName = nameField.provided ? nameField.value : null;

      if (newName === null || newName === previousName) {
        const result = await client.query<FinishTypeRow>(
          `UPDATE finish_type
           SET ${setClauses.join(", ")}
           WHERE finish_type_id = $${idParam}
           RETURNING ${FINISH_TYPE_RETURNING_SQL}`,
          params
        );
        return { kind: "updated", row: result.rows[0] };
      }

      const oldKey = normalizeFinishKey(previousName);
      const newKey = normalizeFinishKey(newName);

      // Another finish type with the same key (any case/spacing) would make two types resolve to
      // one finish. A case-only rename of this same row is fine (it is excluded).
      const conflict = await client.query<{ finishTypeId: number; name: string }>(FINISH_NAME_CONFLICT_SQL, [id, newKey]);
      if (conflict.rows.length > 0) {
        const other = conflict.rows[0];
        return {
          kind: "name_taken",
          body: {
            error: finishTypeNameTakenMessage(current.rows[0].displayName || previousName, newName, other.name),
            code: "FINISH_TYPE_NAME_TAKEN",
            finishTypeId: id,
            name: previousName,
            requestedName: newName,
            conflictingFinishTypeId: other.finishTypeId,
            conflictingName: other.name,
          },
        };
      }

      // finish_normalization.normalized_finish_name references finish_type(name) without
      // ON UPDATE CASCADE and the FK is not deferrable, so the name change and the repoint must
      // happen in ONE statement: the FK check runs at the end of that statement.
      params.push(previousName);
      const oldNameParam = params.length;
      const renamed = await client.query<FinishTypeRow & { normalizationCount: number }>(
        `WITH updated AS (
           UPDATE finish_type
           SET ${setClauses.join(", ")}
           WHERE finish_type_id = $${idParam}
           RETURNING ${FINISH_TYPE_RETURNING_SQL}
         ),
         repointed AS (
           UPDATE finish_normalization fn
           SET normalized_finish_name = updated.name,
               updated_at = now(),
               updated_by_user_id = $${userParam}
           FROM updated
           WHERE fn.normalized_finish_name = $${oldNameParam}
           RETURNING fn.finish_normalization_id
         )
         SELECT updated.*, (SELECT count(*) FROM repointed)::int AS "normalizationCount"
         FROM updated`,
        params
      );
      const { normalizationCount, ...row } = renamed.rows[0];

      let shadeCount = 0;
      let aliasCreated = false;
      if (oldKey !== newKey) {
        // Shades store finish keys, so a case-only rename leaves them as they are.
        const shades = await client.query<{ shadeCount: number }>(RENAME_SHADE_FINISHES_SQL, [oldKey, newKey]);
        shadeCount = Number(shades.rows[0]?.shadeCount) || 0;
        // Keep the old spelling resolving (vendor tags, legacy shade.finish values, other
        // instances' stale caches) unless some alias already claims it.
        const alias = await client.query(FINISH_RENAME_ALIAS_SQL, [oldKey, row.name, userId]);
        aliasCreated = (alias.rowCount ?? alias.rows.length) > 0;
      }

      return {
        kind: "updated",
        row,
        rename: {
          previousName,
          shadeCount,
          normalizationCount: Number(normalizationCount) || 0,
          aliasCreated,
        },
      };
    });

    if (outcome.kind === "not_found") {
      return { status: 404, jsonBody: { error: "Finish not found" } };
    }
    if (outcome.kind === "name_taken") {
      return { status: 409, jsonBody: outcome.body };
    }

    // Only after a successful commit: a refused or failed rename changed nothing.
    await invalidateReferenceCaches();
    if (outcome.rename && outcome.rename.shadeCount > 0) {
      await Promise.all([
        cacheDeleteByPrefix("polishes:list:u:"),
        cacheDeleteByPrefix("polishes:detail:u:"),
        cacheDeleteByPrefix("catalog:shade:id:"),
      ]);
    }

    const responseBody: FinishTypeUpdateResponse = mapFinishTypeRow(outcome.row);
    if (outcome.rename) {
      responseBody.rename = outcome.rename;
    }
    return { status: 200, jsonBody: responseBody };
  } catch (error: unknown) {
    context.error("Error updating finish:", error);
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code === "23505") {
      return {
        status: 409,
        jsonBody: { error: "Finish with that name already exists", code: "FINISH_TYPE_NAME_TAKEN" },
      };
    }
    if (code === "23503") {
      // A finish normalization pointing at the old name appeared mid-rename; nothing was changed.
      return {
        status: 409,
        jsonBody: { error: "A finish normalization for this finish changed during the rename. Try again." },
      };
    }
    return { status: 500, jsonBody: { error: "Failed to update finish" } };
  }
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** Message shown in the admin console when a finish type cannot be deleted because it is in use. */
export function finishTypeInUseMessage(displayName: string, shadeCount: number, normalizationCount: number): string {
  const uses: string[] = [];
  if (shadeCount > 0) uses.push(plural(shadeCount, "shade"));
  if (normalizationCount > 0) uses.push(plural(normalizationCount, "finish normalization"));
  const steps: string[] = [];
  if (shadeCount > 0) steps.push(`remove it from ${shadeCount === 1 ? "that shade" : "those shades"}`);
  if (normalizationCount > 0) steps.push("delete or repoint its normalizations");
  const fix = steps.join(" and ");
  return `Cannot delete finish "${displayName}": it is still used by ${uses.join(" and ")}. ` +
    `${fix.charAt(0).toUpperCase()}${fix.slice(1)} first.`;
}

/**
 * DELETE a finish type, unless it is still in use (#224, decision 2a).
 *
 * A finish type referenced by any shade (`shade.finishes` array or legacy `shade.finish`,
 * compared case-insensitively) or by a `finish_normalization` alias is NOT deleted: the
 * handler answers 409 with the usage counts (`FinishTypeInUseResponse`). Usage check and
 * delete run in one statement so the counts and the decision come from the same snapshot.
 * Caches (including the in-process finish catalog) are only invalidated when a row is
 * actually deleted.
 */
async function deleteFinish(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  context.log("DELETE /api/reference-admin/finishes/{id}");

  const id = parsePositiveId(request.params.id);
  if (!id) {
    return { status: 400, jsonBody: { error: "finish id must be a positive integer" } };
  }

  try {
    const result = await query<{
      finishTypeId: number;
      name: string;
      displayName: string | null;
      shadeCount: number;
      normalizationCount: number;
      deleted: boolean;
    }>(
      `WITH target AS (
         SELECT finish_type_id, name, display_name, lower(btrim(name)) AS finish_key
         FROM finish_type
         WHERE finish_type_id = $1
       ),
       usage AS (
         SELECT
           (SELECT count(*)
              FROM shade s
             WHERE s.finishes @> ARRAY[t.finish_key]::text[]
                OR lower(btrim(s.finish)) = t.finish_key)::int AS shade_count,
           (SELECT count(*)
              FROM finish_normalization fn
             WHERE fn.normalized_finish_name = t.name)::int AS normalization_count
         FROM target t
       ),
       deleted AS (
         DELETE FROM finish_type ft
         USING usage u
         WHERE ft.finish_type_id = $1
           AND u.shade_count = 0
           AND u.normalization_count = 0
         RETURNING ft.finish_type_id
       )
       SELECT t.finish_type_id AS "finishTypeId",
              t.name,
              t.display_name AS "displayName",
              u.shade_count AS "shadeCount",
              u.normalization_count AS "normalizationCount",
              EXISTS (SELECT 1 FROM deleted) AS deleted
       FROM target t
       CROSS JOIN usage u`,
      [id]
    );

    if (result.rows.length === 0) {
      return { status: 404, jsonBody: { error: "Finish not found" } };
    }

    const row = result.rows[0];
    if (!row.deleted) {
      const shadeCount = Number(row.shadeCount) || 0;
      const normalizationCount = Number(row.normalizationCount) || 0;
      const body: FinishTypeInUseResponse = {
        error: finishTypeInUseMessage(row.displayName || row.name, shadeCount, normalizationCount),
        code: "FINISH_TYPE_IN_USE",
        finishTypeId: id,
        name: row.name,
        shadeCount,
        normalizationCount,
      };
      return { status: 409, jsonBody: body };
    }

    await invalidateReferenceCaches();

    return { status: 200, jsonBody: { message: "Finish deleted successfully", finishTypeId: id } };
  } catch (error) {
    context.error("Error deleting finish:", error);
    // A finish_normalization row created concurrently still holds the FK (ON DELETE RESTRICT).
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23503") {
      return { status: 409, jsonBody: { error: "Finish is still referenced by a finish normalization" } };
    }
    return { status: 500, jsonBody: { error: "Failed to delete finish" } };
  }
}

async function listAdminHarmonies(
  _request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  context.log("GET /api/reference-admin/harmonies");

  try {
    const result = await query<{
      harmonyTypeId: number;
      name: string;
      displayName: string;
      description: string | null;
      sortOrder: number;
      createdAt: string;
      updatedAt: string;
      updatedByUserId: number | null;
    }>(
      `SELECT
         harmony_type_id AS "harmonyTypeId",
         name,
         display_name AS "displayName",
         description,
         sort_order AS "sortOrder",
         created_at::text AS "createdAt",
         updated_at::text AS "updatedAt",
         updated_by_user_id AS "updatedByUserId"
       FROM harmony_type
       ORDER BY sort_order ASC, display_name ASC`
    );

    return {
      status: 200,
      jsonBody: { harmonyTypes: result.rows.map(mapHarmonyTypeRow) } satisfies HarmonyTypeListResponse,
    };
  } catch (error) {
    context.error("Error listing admin harmonies:", error);
    return {
      status: 500,
      jsonBody: { error: "Failed to list harmonies" },
    };
  }
}

async function createHarmony(
  request: HttpRequest,
  context: InvocationContext,
  userId: number
): Promise<HttpResponseInit> {
  context.log("POST /api/reference-admin/harmonies");

  let body: Partial<HarmonyTypeCreateRequest> | undefined;
  try {
    body = (await request.json()) as Partial<HarmonyTypeCreateRequest>;
  } catch {
    return { status: 400, jsonBody: { error: "Request body must be valid JSON" } };
  }

  const nameField = getFieldString(body, "name", "name");
  const displayNameField = getFieldString(body, "displayName", "display_name");
  const descriptionField = getOptionalDescription(body, "description", "description");
  const sortOrderField = getOptionalSortOrder(body);

  if (!nameField.provided || !displayNameField.provided || nameField.invalid || displayNameField.invalid) {
    return {
      status: 400,
      jsonBody: { error: "Harmony requires name and display_name/displayName as non-empty strings" },
    };
  }
  if (descriptionField.invalid) {
    return {
      status: 400,
      jsonBody: { error: "description must be a string or null" },
    };
  }
  if (sortOrderField.invalid) {
    return {
      status: 400,
      jsonBody: { error: "sortOrder (or sort_order) must be an integer" },
    };
  }

  try {
    const result = await query<{
      harmonyTypeId: number;
      name: string;
      displayName: string;
      description: string | null;
      sortOrder: number;
      createdAt: string;
      updatedAt: string;
      updatedByUserId: number | null;
    }>(
      `INSERT INTO harmony_type (
         name,
         display_name,
         description,
         sort_order,
         updated_at,
         updated_by_user_id
       )
       VALUES ($1, $2, $3, $4, now(), $5)
       RETURNING
         harmony_type_id AS "harmonyTypeId",
         name,
         display_name AS "displayName",
         description,
         sort_order AS "sortOrder",
         created_at::text AS "createdAt",
         updated_at::text AS "updatedAt",
         updated_by_user_id AS "updatedByUserId"`,
      [
        nameField.value,
        displayNameField.value,
        descriptionField.provided ? descriptionField.value : null,
        sortOrderField.provided ? sortOrderField.value : 0,
        userId,
      ]
    );

    await invalidateReferenceCaches();

    return {
      status: 201,
      jsonBody: mapHarmonyTypeRow(result.rows[0]),
    };
  } catch (error: unknown) {
    context.error("Error creating harmony:", error);
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
      return { status: 409, jsonBody: { error: "Harmony with that name already exists" } };
    }
    return { status: 500, jsonBody: { error: "Failed to create harmony" } };
  }
}

async function updateHarmony(
  request: HttpRequest,
  context: InvocationContext,
  userId: number
): Promise<HttpResponseInit> {
  context.log("PUT /api/reference-admin/harmonies/{id}");

  const id = parsePositiveId(request.params.id);
  if (!id) {
    return { status: 400, jsonBody: { error: "harmony id must be a positive integer" } };
  }

  let body: Partial<HarmonyTypeUpdateRequest> | undefined;
  try {
    body = (await request.json()) as Partial<HarmonyTypeUpdateRequest>;
  } catch {
    return { status: 400, jsonBody: { error: "Request body must be valid JSON" } };
  }

  const nameField = getFieldString(body, "name", "name");
  const displayNameField = getFieldString(body, "displayName", "display_name");
  const descriptionField = getOptionalDescription(body, "description", "description");
  const sortOrderField = getOptionalSortOrder(body);

  if (nameField.invalid || displayNameField.invalid) {
    return {
      status: 400,
      jsonBody: { error: "Harmony requires non-empty strings when updating name/display_name" },
    };
  }
  if (descriptionField.invalid) {
    return {
      status: 400,
      jsonBody: { error: "description must be a string or null" },
    };
  }
  if (sortOrderField.invalid) {
    return {
      status: 400,
      jsonBody: { error: "sortOrder (or sort_order) must be an integer" },
    };
  }
  if (!nameField.provided && !displayNameField.provided && !descriptionField.provided && !sortOrderField.provided) {
    return {
      status: 400,
      jsonBody: { error: "At least one updatable field is required" },
    };
  }

  const setClauses: string[] = [];
  const params: Array<string | number | null> = [];

  if (nameField.provided) {
    params.push(nameField.value);
    setClauses.push(`name = $${params.length}`);
  }
  if (displayNameField.provided) {
    params.push(displayNameField.value);
    setClauses.push(`display_name = $${params.length}`);
  }
  if (descriptionField.provided) {
    params.push(descriptionField.value);
    setClauses.push(`description = $${params.length}`);
  }
  if (sortOrderField.provided) {
    params.push(sortOrderField.value);
    setClauses.push(`sort_order = $${params.length}`);
  }

  params.push(userId);
  setClauses.push(`updated_by_user_id = $${params.length}`);
  setClauses.push("updated_at = now()");
  params.push(id);

  try {
    const result = await query<{
      harmonyTypeId: number;
      name: string;
      displayName: string;
      description: string | null;
      sortOrder: number;
      createdAt: string;
      updatedAt: string;
      updatedByUserId: number | null;
    }>(
      `UPDATE harmony_type
       SET ${setClauses.join(", ")}
       WHERE harmony_type_id = $${params.length}
       RETURNING
         harmony_type_id AS "harmonyTypeId",
         name,
         display_name AS "displayName",
         description,
         sort_order AS "sortOrder",
         created_at::text AS "createdAt",
         updated_at::text AS "updatedAt",
         updated_by_user_id AS "updatedByUserId"`,
      params
    );

    if (result.rows.length === 0) {
      return { status: 404, jsonBody: { error: "Harmony not found" } };
    }

    await invalidateReferenceCaches();

    return { status: 200, jsonBody: mapHarmonyTypeRow(result.rows[0]) };
  } catch (error: unknown) {
    context.error("Error updating harmony:", error);
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
      return { status: 409, jsonBody: { error: "Harmony with that name already exists" } };
    }
    return { status: 500, jsonBody: { error: "Failed to update harmony" } };
  }
}

async function deleteHarmony(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  context.log("DELETE /api/reference-admin/harmonies/{id}");

  const id = parsePositiveId(request.params.id);
  if (!id) {
    return { status: 400, jsonBody: { error: "harmony id must be a positive integer" } };
  }

  try {
    const result = await query<{ harmonyTypeId: number }>(
      `DELETE FROM harmony_type
       WHERE harmony_type_id = $1
       RETURNING harmony_type_id AS "harmonyTypeId"`,
      [id]
    );

    if (result.rows.length === 0) {
      return { status: 404, jsonBody: { error: "Harmony not found" } };
    }

    await invalidateReferenceCaches();

    return { status: 200, jsonBody: { message: "Harmony deleted successfully", harmonyTypeId: id } };
  } catch (error) {
    context.error("Error deleting harmony:", error);
    return { status: 500, jsonBody: { error: "Failed to delete harmony" } };
  }
}

async function listAdminJobs(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  context.log("GET /api/reference-admin/jobs");

  const url = new URL(request.url);
  const page = parseInteger(url.searchParams.get("page"), DEFAULT_PAGE, 1, 100000);
  const pageSize = parseInteger(url.searchParams.get("pageSize"), DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
  const offset = (page - 1) * pageSize;

  const statusFilterRaw = url.searchParams.get("status")?.trim().toLowerCase();
  if (statusFilterRaw && !VALID_JOB_STATUSES.has(statusFilterRaw)) {
    return {
      status: 400,
      jsonBody: {
        error: `Invalid status '${statusFilterRaw}'. Valid values: ${Array.from(VALID_JOB_STATUSES).join(", ")}`,
      },
    };
  }

  try {
    const whereClause = statusFilterRaw ? "WHERE j.status = $1" : "";
    const listParams: Array<string | number> = statusFilterRaw
      ? [statusFilterRaw, pageSize, offset]
      : [pageSize, offset];
    const limitIndex = statusFilterRaw ? 2 : 1;
    const offsetIndex = statusFilterRaw ? 3 : 2;

    const jobsResult = await query<{
      ingestionJobId: number;
      dataSourceId: number;
      dataSourceName: string;
      jobType: string;
      status: IngestionJob["status"];
      startedAt: string;
      completedAt: string | null;
      errorSummary: string | null;
      metricsJson: unknown;
    }>(
      `SELECT
         j.ingestion_job_id AS "ingestionJobId",
         j.data_source_id AS "dataSourceId",
         s.name AS "dataSourceName",
         j.job_type AS "jobType",
         j.status,
         j.started_at::text AS "startedAt",
         j.finished_at::text AS "completedAt",
         j.error AS "errorSummary",
         j.metrics_json AS "metricsJson"
       FROM ingestion_job j
       JOIN data_source s ON s.data_source_id = j.data_source_id
       ${whereClause}
       ORDER BY j.started_at DESC
       LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
      listParams
    );

    const countParams: string[] = statusFilterRaw ? [statusFilterRaw] : [];
    const countResult = await query<{ total: string }>(
      `SELECT COUNT(*) AS total
       FROM ingestion_job j
       ${statusFilterRaw ? "WHERE j.status = $1" : ""}`,
      countParams
    );

    const jobs: IngestionJob[] = jobsResult.rows.map((row) => {
      const metrics = row.metricsJson as Record<string, unknown> | null;
      const recordsProcessedRaw =
        metrics && typeof metrics.recordsProcessed === "number" ? metrics.recordsProcessed : undefined;

      return {
        ingestionJobId: row.ingestionJobId,
        dataSourceId: row.dataSourceId,
        dataSourceName: row.dataSourceName,
        jobType: row.jobType,
        status: row.status,
        startedAt: row.startedAt,
        completedAt: row.completedAt || undefined,
        errorSummary: row.errorSummary || undefined,
        recordsProcessed: recordsProcessedRaw,
      };
    });

    return {
      status: 200,
      jsonBody: {
        jobs,
        total: Number.parseInt(countResult.rows[0]?.total || "0", 10),
        page,
        pageSize,
      } satisfies AdminJobsListResponse,
    };
  } catch (error) {
    context.error("Error listing admin jobs:", error);
    return {
      status: 500,
      jsonBody: { error: "Failed to list admin jobs" },
    };
  }
}

async function listAdminFinishNormalizations(
  _request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  context.log("GET /api/reference-admin/finish-normalizations");

  try {
    const result = await query<{
      finishNormalizationId: number;
      sourceValue: string;
      normalizedFinishName: string;
      createdAt: string;
      updatedAt: string;
      updatedByUserId: number | null;
    }>(
      `SELECT
         finish_normalization_id AS "finishNormalizationId",
         source_value AS "sourceValue",
         normalized_finish_name AS "normalizedFinishName",
         created_at::text AS "createdAt",
         updated_at::text AS "updatedAt",
         updated_by_user_id AS "updatedByUserId"
       FROM finish_normalization
       ORDER BY source_value ASC`
    );

    return {
      status: 200,
      jsonBody: {
        finishNormalizations: result.rows.map(mapFinishNormalizationRow),
      } satisfies FinishNormalizationListResponse,
    };
  } catch (error) {
    context.error("Error listing finish normalizations:", error);
    return {
      status: 500,
      jsonBody: { error: "Failed to list finish normalizations" },
    };
  }
}

async function createFinishNormalization(
  request: HttpRequest,
  context: InvocationContext,
  userId: number
): Promise<HttpResponseInit> {
  context.log("POST /api/reference-admin/finish-normalizations");

  let body: Partial<FinishNormalizationCreateRequest> | undefined;
  try {
    body = (await request.json()) as Partial<FinishNormalizationCreateRequest>;
  } catch {
    return { status: 400, jsonBody: { error: "Request body must be valid JSON" } };
  }

  const sourceField = getFieldString(body, "sourceValue", "source_value");
  const normalizedField = getFieldString(body, "normalizedFinishName", "normalized_finish_name");

  if (!sourceField.provided || sourceField.invalid) {
    return {
      status: 400,
      jsonBody: { error: "sourceValue (or source_value) is required as a non-empty string" },
    };
  }
  if (!normalizedField.provided || normalizedField.invalid) {
    return {
      status: 400,
      jsonBody: { error: "normalizedFinishName (or normalized_finish_name) is required as a non-empty string" },
    };
  }

  try {
    const result = await query<{
      finishNormalizationId: number;
      sourceValue: string;
      normalizedFinishName: string;
      createdAt: string;
      updatedAt: string;
      updatedByUserId: number | null;
    }>(
      `INSERT INTO finish_normalization (
         source_value,
         normalized_finish_name,
         updated_at,
         updated_by_user_id
       )
       VALUES ($1, $2, now(), $3)
       RETURNING
         finish_normalization_id AS "finishNormalizationId",
         source_value AS "sourceValue",
         normalized_finish_name AS "normalizedFinishName",
         created_at::text AS "createdAt",
         updated_at::text AS "updatedAt",
         updated_by_user_id AS "updatedByUserId"`,
      [sourceField.value?.toLowerCase(), normalizedField.value?.toLowerCase(), userId]
    );

    await invalidateReferenceCaches();

    return {
      status: 201,
      jsonBody: mapFinishNormalizationRow(result.rows[0]),
    };
  } catch (error: unknown) {
    context.error("Error creating finish normalization:", error);
    if (typeof error === "object" && error !== null && "code" in error) {
      if (error.code === "23505") {
        return { status: 409, jsonBody: { error: "A normalization for this source value already exists" } };
      }
      if (error.code === "23503") {
        return { status: 400, jsonBody: { error: "normalizedFinishName must match an existing finish type name" } };
      }
    }
    return { status: 500, jsonBody: { error: "Failed to create finish normalization" } };
  }
}

async function updateFinishNormalization(
  request: HttpRequest,
  context: InvocationContext,
  userId: number
): Promise<HttpResponseInit> {
  context.log("PUT /api/reference-admin/finish-normalizations/{id}");

  const id = parsePositiveId(request.params.id);
  if (!id) {
    return { status: 400, jsonBody: { error: "finish normalization id must be a positive integer" } };
  }

  let body: Partial<FinishNormalizationUpdateRequest> | undefined;
  try {
    body = (await request.json()) as Partial<FinishNormalizationUpdateRequest>;
  } catch {
    return { status: 400, jsonBody: { error: "Request body must be valid JSON" } };
  }

  const sourceField = getFieldString(body, "sourceValue", "source_value");
  const normalizedField = getFieldString(body, "normalizedFinishName", "normalized_finish_name");

  if (sourceField.invalid) {
    return { status: 400, jsonBody: { error: "sourceValue/source_value must be a non-empty string" } };
  }
  if (normalizedField.invalid) {
    return { status: 400, jsonBody: { error: "normalizedFinishName/normalized_finish_name must be a non-empty string" } };
  }
  if (!sourceField.provided && !normalizedField.provided) {
    return {
      status: 400,
      jsonBody: { error: "At least one of sourceValue/source_value or normalizedFinishName/normalized_finish_name is required" },
    };
  }

  const setClauses: string[] = [];
  const params: Array<string | number> = [];

  if (sourceField.provided) {
    params.push((sourceField.value || "").toLowerCase());
    setClauses.push(`source_value = $${params.length}`);
  }
  if (normalizedField.provided) {
    params.push((normalizedField.value || "").toLowerCase());
    setClauses.push(`normalized_finish_name = $${params.length}`);
  }
  params.push(userId);
  setClauses.push(`updated_by_user_id = $${params.length}`);
  setClauses.push("updated_at = now()");
  params.push(id);

  try {
    const result = await query<{
      finishNormalizationId: number;
      sourceValue: string;
      normalizedFinishName: string;
      createdAt: string;
      updatedAt: string;
      updatedByUserId: number | null;
    }>(
      `UPDATE finish_normalization
       SET ${setClauses.join(", ")}
       WHERE finish_normalization_id = $${params.length}
       RETURNING
         finish_normalization_id AS "finishNormalizationId",
         source_value AS "sourceValue",
         normalized_finish_name AS "normalizedFinishName",
         created_at::text AS "createdAt",
         updated_at::text AS "updatedAt",
         updated_by_user_id AS "updatedByUserId"`,
      params
    );

    if (result.rows.length === 0) {
      return { status: 404, jsonBody: { error: "Finish normalization not found" } };
    }

    await invalidateReferenceCaches();

    return { status: 200, jsonBody: mapFinishNormalizationRow(result.rows[0]) };
  } catch (error: unknown) {
    context.error("Error updating finish normalization:", error);
    if (typeof error === "object" && error !== null && "code" in error) {
      if (error.code === "23505") {
        return { status: 409, jsonBody: { error: "A normalization for this source value already exists" } };
      }
      if (error.code === "23503") {
        return { status: 400, jsonBody: { error: "normalizedFinishName must match an existing finish type name" } };
      }
    }
    return { status: 500, jsonBody: { error: "Failed to update finish normalization" } };
  }
}

async function deleteFinishNormalization(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  context.log("DELETE /api/reference-admin/finish-normalizations/{id}");

  const id = parsePositiveId(request.params.id);
  if (!id) {
    return { status: 400, jsonBody: { error: "finish normalization id must be a positive integer" } };
  }

  try {
    const result = await query<{ finishNormalizationId: number }>(
      `DELETE FROM finish_normalization
       WHERE finish_normalization_id = $1
       RETURNING finish_normalization_id AS "finishNormalizationId"`,
      [id]
    );

    if (result.rows.length === 0) {
      return { status: 404, jsonBody: { error: "Finish normalization not found" } };
    }

    await invalidateReferenceCaches();

    return { status: 200, jsonBody: { message: "Finish normalization deleted successfully", finishNormalizationId: id } };
  } catch (error) {
    context.error("Error deleting finish normalization:", error);
    return { status: 500, jsonBody: { error: "Failed to delete finish normalization" } };
  }
}

async function adminFinishesCollectionHandler(
  request: HttpRequest,
  context: InvocationContext,
  userId: number
): Promise<HttpResponseInit> {
  const method = request.method?.toUpperCase();
  if (method === "GET") {
    return listAdminFinishes(request, context);
  }
  if (method === "POST") {
    return createFinish(request, context, userId);
  }
  return { status: 405, jsonBody: { error: "Method not allowed" } };
}

async function adminFinishesItemHandler(
  request: HttpRequest,
  context: InvocationContext,
  userId: number
): Promise<HttpResponseInit> {
  const method = request.method?.toUpperCase();
  if (method === "PUT") {
    return updateFinish(request, context, userId);
  }
  if (method === "DELETE") {
    return deleteFinish(request, context);
  }
  return { status: 405, jsonBody: { error: "Method not allowed" } };
}

async function adminHarmoniesCollectionHandler(
  request: HttpRequest,
  context: InvocationContext,
  userId: number
): Promise<HttpResponseInit> {
  const method = request.method?.toUpperCase();
  if (method === "GET") {
    return listAdminHarmonies(request, context);
  }
  if (method === "POST") {
    return createHarmony(request, context, userId);
  }
  return { status: 405, jsonBody: { error: "Method not allowed" } };
}

async function adminHarmoniesItemHandler(
  request: HttpRequest,
  context: InvocationContext,
  userId: number
): Promise<HttpResponseInit> {
  const method = request.method?.toUpperCase();
  if (method === "PUT") {
    return updateHarmony(request, context, userId);
  }
  if (method === "DELETE") {
    return deleteHarmony(request, context);
  }
  return { status: 405, jsonBody: { error: "Method not allowed" } };
}

async function adminJobsHandler(
  request: HttpRequest,
  context: InvocationContext,
  _userId: number
): Promise<HttpResponseInit> {
  const method = request.method?.toUpperCase();
  if (method === "GET") {
    return listAdminJobs(request, context);
  }
  return { status: 405, jsonBody: { error: "Method not allowed" } };
}

async function adminFinishNormalizationsCollectionHandler(
  request: HttpRequest,
  context: InvocationContext,
  userId: number
): Promise<HttpResponseInit> {
  const method = request.method?.toUpperCase();
  if (method === "GET") {
    return listAdminFinishNormalizations(request, context);
  }
  if (method === "POST") {
    return createFinishNormalization(request, context, userId);
  }
  return { status: 405, jsonBody: { error: "Method not allowed" } };
}

async function adminFinishNormalizationsItemHandler(
  request: HttpRequest,
  context: InvocationContext,
  userId: number
): Promise<HttpResponseInit> {
  const method = request.method?.toUpperCase();
  if (method === "PUT") {
    return updateFinishNormalization(request, context, userId);
  }
  if (method === "DELETE") {
    return deleteFinishNormalization(request, context);
  }
  return { status: 405, jsonBody: { error: "Method not allowed" } };
}

app.http("admin-finishes", {
  methods: ["GET", "POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "reference-admin/finishes",
  handler: withCors(withAdmin(adminFinishesCollectionHandler)),
});

app.http("admin-finish-item", {
  methods: ["PUT", "DELETE", "OPTIONS"],
  authLevel: "anonymous",
  route: "reference-admin/finishes/{id}",
  handler: withCors(withAdmin(adminFinishesItemHandler)),
});

app.http("admin-harmonies", {
  methods: ["GET", "POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "reference-admin/harmonies",
  handler: withCors(withAdmin(adminHarmoniesCollectionHandler)),
});

app.http("admin-harmony-item", {
  methods: ["PUT", "DELETE", "OPTIONS"],
  authLevel: "anonymous",
  route: "reference-admin/harmonies/{id}",
  handler: withCors(withAdmin(adminHarmoniesItemHandler)),
});

app.http("admin-jobs", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "reference-admin/jobs",
  handler: withCors(withAdmin(adminJobsHandler)),
});

app.http("admin-finish-normalizations", {
  methods: ["GET", "POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "reference-admin/finish-normalizations",
  handler: withCors(withAdmin(adminFinishNormalizationsCollectionHandler)),
});

app.http("admin-finish-normalization-item", {
  methods: ["PUT", "DELETE", "OPTIONS"],
  authLevel: "anonymous",
  route: "reference-admin/finish-normalizations/{id}",
  handler: withCors(withAdmin(adminFinishNormalizationsItemHandler)),
});
