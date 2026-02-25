import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import {
  type FinishNormalization,
  type FinishNormalizationCreateRequest,
  type FinishNormalizationListResponse,
  type FinishNormalizationUpdateRequest,
  type FinishType,
  type FinishTypeCreateRequest,
  type FinishTypeListResponse,
  type FinishTypeUpdateRequest,
  type HarmonyTypeCreateRequest,
  type HarmonyTypeListResponse,
  type HarmonyTypeUpdateRequest,
  type AdminJobsListResponse,
  type IngestionJob,
  type ReferenceHarmonyType,
} from "swatchwatch-shared";
import { withAdmin } from "../lib/auth";
import { query } from "../lib/db";
import { withCors } from "../lib/http";

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const VALID_JOB_STATUSES = new Set(["queued", "running", "succeeded", "failed", "cancelled"]);

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
      createdAt: string;
      updatedAt: string;
      updatedByUserId: number | null;
    }>(
      `INSERT INTO finish_type (
         name,
         display_name,
         description,
         sort_order,
         updated_at,
         updated_by_user_id
       )
       VALUES ($1, $2, $3, $4, now(), $5)
       RETURNING
         finish_type_id AS "finishTypeId",
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

  if (!nameField.provided && !displayNameField.provided && !descriptionField.provided && !sortOrderField.provided) {
    return {
      status: 400,
      jsonBody: { error: "At least one of name, displayName/display_name, description, sortOrder/sort_order is required" },
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
      finishTypeId: number;
      name: string;
      displayName: string;
      description: string | null;
      sortOrder: number;
      createdAt: string;
      updatedAt: string;
      updatedByUserId: number | null;
    }>(
      `UPDATE finish_type
       SET ${setClauses.join(", ")}
       WHERE finish_type_id = $${params.length}
       RETURNING
         finish_type_id AS "finishTypeId",
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
      return { status: 404, jsonBody: { error: "Finish not found" } };
    }

    return { status: 200, jsonBody: mapFinishTypeRow(result.rows[0]) };
  } catch (error: unknown) {
    context.error("Error updating finish:", error);
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
      return { status: 409, jsonBody: { error: "Finish with that name already exists" } };
    }
    return { status: 500, jsonBody: { error: "Failed to update finish" } };
  }
}

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
    const result = await query<{ finishTypeId: number }>(
      `DELETE FROM finish_type
       WHERE finish_type_id = $1
       RETURNING finish_type_id AS "finishTypeId"`,
      [id]
    );

    if (result.rows.length === 0) {
      return { status: 404, jsonBody: { error: "Finish not found" } };
    }

    return { status: 200, jsonBody: { message: "Finish deleted successfully", finishTypeId: id } };
  } catch (error) {
    context.error("Error deleting finish:", error);
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
