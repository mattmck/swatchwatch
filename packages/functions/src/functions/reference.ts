import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import {
  FinishTypeListResponse,
  HarmonyTypeListResponse,
  type FinishType,
  type ReferenceHarmonyType,
} from "swatchwatch-shared";
import { query } from "../lib/db";
import { withCors } from "../lib/http";
import { cacheGetJson, cacheSetJson } from "../lib/cache";

const REFERENCE_CACHE_CONTROL = "public, max-age=300, stale-while-revalidate=900";
const REFERENCE_CACHE_TTL_SECONDS = 900;
const REFERENCE_FINISHES_CACHE_KEY = "reference:finishes";
const REFERENCE_HARMONIES_CACHE_KEY = "reference:harmonies";

const REFERENCE_CACHE_HEADERS = {
  "Cache-Control": REFERENCE_CACHE_CONTROL,
};

async function getReferenceFinishes(
  _request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  context.log("GET /api/reference/finishes");

  try {
    const cachedResponse = await cacheGetJson<FinishTypeListResponse>(REFERENCE_FINISHES_CACHE_KEY);
    if (cachedResponse) {
      return {
        status: 200,
        headers: REFERENCE_CACHE_HEADERS,
        jsonBody: cachedResponse,
      };
    }

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

    const finishTypes: FinishType[] = result.rows.map((row) => ({
      finishTypeId: row.finishTypeId,
      name: row.name,
      displayName: row.displayName,
      description: row.description || undefined,
      sortOrder: row.sortOrder,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      updatedByUserId: row.updatedByUserId ?? undefined,
    }));

    const responseBody = { finishTypes } satisfies FinishTypeListResponse;
    await cacheSetJson(REFERENCE_FINISHES_CACHE_KEY, responseBody, REFERENCE_CACHE_TTL_SECONDS);

    return {
      status: 200,
      headers: REFERENCE_CACHE_HEADERS,
      jsonBody: responseBody,
    };
  } catch (error) {
    context.error("Error listing reference finishes:", error);
    return {
      status: 500,
      jsonBody: { error: "Failed to list reference finishes" },
    };
  }
}

async function getReferenceHarmonies(
  _request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  context.log("GET /api/reference/harmonies");

  try {
    const cachedResponse = await cacheGetJson<HarmonyTypeListResponse>(REFERENCE_HARMONIES_CACHE_KEY);
    if (cachedResponse) {
      return {
        status: 200,
        headers: REFERENCE_CACHE_HEADERS,
        jsonBody: cachedResponse,
      };
    }

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

    const harmonyTypes: ReferenceHarmonyType[] = result.rows.map((row) => ({
      harmonyTypeId: row.harmonyTypeId,
      name: row.name,
      displayName: row.displayName,
      description: row.description || undefined,
      sortOrder: row.sortOrder,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      updatedByUserId: row.updatedByUserId ?? undefined,
    }));

    const responseBody = { harmonyTypes } satisfies HarmonyTypeListResponse;
    await cacheSetJson(REFERENCE_HARMONIES_CACHE_KEY, responseBody, REFERENCE_CACHE_TTL_SECONDS);

    return {
      status: 200,
      headers: REFERENCE_CACHE_HEADERS,
      jsonBody: responseBody,
    };
  } catch (error) {
    context.error("Error listing reference harmonies:", error);
    return {
      status: 500,
      jsonBody: { error: "Failed to list reference harmonies" },
    };
  }
}

app.http("reference-finishes", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "reference/finishes",
  handler: withCors(getReferenceFinishes),
});

app.http("reference-harmonies", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "reference/harmonies",
  handler: withCors(getReferenceHarmonies),
});
