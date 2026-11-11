import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type {
  AdminBrandCreateResponse,
  AdminBrandListItem,
  AdminBrandListResponse,
  AdminBrandProfileRequest,
} from "swatchwatch-shared";
import { withAdmin } from "../lib/auth";
import { query, transaction } from "../lib/db";
import { withCors } from "../lib/http";
import { internalServerError } from "../lib/errors";
import { trackEvent } from "../lib/telemetry";
import { recordAdminAuditEvent } from "../lib/admin-users";
import {
  BRANDS_ADMIN_SOURCES_SQL,
  BRAND_DUPLICATE_SQL,
  PROFILE_FIELDS,
  brandsAdminBrandsSql,
  brandsAdminLinksSql,
  buildBrandList,
  normalizeBrandName,
  parseBrandProfileRequest,
  type BrandRow,
  type BrandSourceLinkRow,
  type SourceRow,
} from "../lib/brands-admin";

/**
 * Admin Sources tab, Brands view (all routes `withAdmin`).
 *
 * GET /api/brands-admin                   — every brand with shade counts, own stores, retailers and ingest profile
 * POST /api/brands-admin                  — add a brand (409 brand_exists on a name or alias match) with an optional profile
 * PUT /api/brands-admin/{id}/profile      — update a brand's ingest profile (missing key keeps, null clears)
 */

const MAX_NAME_LENGTH = 200;

type ProfileValues = Record<(typeof PROFILE_FIELDS)[number], string | number | null>;

const PROFILE_COLUMNS: Record<(typeof PROFILE_FIELDS)[number], string> = {
  websiteUrl: "website_url",
  platform: "platform",
  blocker: "blocker",
  notes: "notes",
  ownDataSourceId: "own_data_source_id",
};

class Rejected extends Error {
  constructor(readonly status: number, readonly payload: Record<string, unknown>) {
    super("rejected");
  }
}

function parseBrandId(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** One code path for list and single-brand reads: the three queries feed `buildBrandList`. */
async function loadBrands(brandId?: number): Promise<AdminBrandListItem[]> {
  const params = brandId === undefined ? [] : [brandId];
  const [brands, sources, links] = await Promise.all([
    query<BrandRow>(brandsAdminBrandsSql(brandId !== undefined), params),
    query<SourceRow>(BRANDS_ADMIN_SOURCES_SQL, []),
    query<BrandSourceLinkRow>(brandsAdminLinksSql(brandId !== undefined), params),
  ]);
  return buildBrandList({ brands: brands.rows, sources: sources.rows, links: links.rows });
}

type TxClient = { query: <T = unknown>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> };

async function ensureDataSourceExists(client: TxClient, id: number): Promise<void> {
  const found = await client.query(`SELECT data_source_id FROM data_source WHERE data_source_id = $1`, [id]);
  if (found.rows.length === 0) {
    throw new Rejected(400, { error: "ownDataSourceId does not match a data source" });
  }
}

/** Upsert the profile with the merged values; returns the changed fields as `{ from, to }`. */
async function writeProfile(
  client: TxClient,
  adminUserId: number,
  brandId: number,
  stored: ProfileValues,
  req: AdminBrandProfileRequest
): Promise<Record<string, { from: unknown; to: unknown }>> {
  const next: ProfileValues = { ...stored };
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const field of PROFILE_FIELDS) {
    if (!(field in req)) continue;
    const to = (req[field] ?? null) as string | number | null;
    if (to !== stored[field]) changes[field] = { from: stored[field], to };
    next[field] = to;
  }
  if (Object.keys(changes).length === 0) return changes;

  await client.query(
    `INSERT INTO brand_ingest_profile
       (brand_id, ${PROFILE_FIELDS.map((f) => PROFILE_COLUMNS[f]).join(", ")}, updated_by_user_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (brand_id) DO UPDATE SET
       ${PROFILE_FIELDS.map((f) => `${PROFILE_COLUMNS[f]} = EXCLUDED.${PROFILE_COLUMNS[f]}`).join(",\n       ")},
       updated_by_user_id = EXCLUDED.updated_by_user_id,
       updated_at = now()`,
    [brandId, ...PROFILE_FIELDS.map((f) => next[f]), adminUserId]
  );
  return changes;
}

const EMPTY_PROFILE: ProfileValues = {
  websiteUrl: null,
  platform: null,
  blocker: null,
  notes: null,
  ownDataSourceId: null,
};

async function listBrands(context: InvocationContext): Promise<HttpResponseInit> {
  context.log("GET /api/brands-admin");
  try {
    const body: AdminBrandListResponse = { brands: await loadBrands() };
    return { status: 200, jsonBody: body };
  } catch (error) {
    return internalServerError(context, error, "Failed to list brands", "brands-admin.list");
  }
}

async function createBrand(
  request: HttpRequest,
  context: InvocationContext,
  adminUserId: number
): Promise<HttpResponseInit> {
  context.log("POST /api/brands-admin");
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { status: 400, jsonBody: { error: "Request body must be valid JSON" } };
  }
  const input = body as { name?: unknown; profile?: unknown } | null;
  if (!input || typeof input !== "object" || typeof input.name !== "string") {
    return { status: 400, jsonBody: { error: "name is required" } };
  }
  const name = normalizeBrandName(input.name);
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
    return { status: 400, jsonBody: { error: `name must be 1-${MAX_NAME_LENGTH} characters` } };
  }
  let profile: AdminBrandProfileRequest | undefined;
  if (input.profile !== undefined) {
    const parsed = parseBrandProfileRequest(input.profile);
    if (!parsed.ok) return { status: 400, jsonBody: { error: parsed.error } };
    profile = parsed.value;
  }

  try {
    const brandId = await transaction(async (client) => {
      // Serialize creates of the same name (any case) so two requests cannot both pass the
      // duplicate check; the lock is released at commit or rollback.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('brands-admin:create:' || lower($1)))`, [name]);
      const rejectDuplicate = async () => {
        const duplicate = await client.query<{ brandId: number | string }>(BRAND_DUPLICATE_SQL, [name]);
        if (duplicate.rows[0]) {
          throw new Rejected(409, { code: "brand_exists", brandId: Number(duplicate.rows[0].brandId) });
        }
      };
      await rejectDuplicate();
      if (profile?.ownDataSourceId) await ensureDataSourceExists(client, profile.ownDataSourceId);

      // Another writer (ingestion, a polish create) may insert the same name meanwhile: that is a
      // 409 with its id, never a 500.
      const inserted = await client.query<{ brandId: number | string }>(
        `INSERT INTO brand (name_canonical) VALUES ($1)
         ON CONFLICT (name_canonical) DO NOTHING
         RETURNING brand_id AS "brandId"`,
        [name]
      );
      if (!inserted.rows[0]) {
        await rejectDuplicate();
        throw new Error(`Brand insert for ${name} conflicted but no duplicate was found`);
      }
      const id = Number(inserted.rows[0].brandId);
      const profileChanges = profile ? await writeProfile(client, adminUserId, id, EMPTY_PROFILE, profile) : {};
      await recordAdminAuditEvent(client, {
        actorUserId: adminUserId,
        targetUserId: null,
        action: "brand.create",
        changes: { brandId: id, name, ...profileChanges },
      });
      return id;
    });

    trackEvent("admin.brand_create", { brandId, actorUserId: adminUserId });
    const [brand] = await loadBrands(brandId);
    const response: AdminBrandCreateResponse = { brand };
    return { status: 201, jsonBody: response };
  } catch (error) {
    if (error instanceof Rejected) return { status: error.status, jsonBody: error.payload };
    return internalServerError(context, error, "Failed to create brand", "brands-admin.create");
  }
}

async function updateProfile(
  request: HttpRequest,
  context: InvocationContext,
  adminUserId: number
): Promise<HttpResponseInit> {
  const brandId = parseBrandId(request.params.id);
  if (!brandId) return { status: 400, jsonBody: { error: "Brand id must be a positive integer" } };
  context.log(`PUT /api/brands-admin/${brandId}/profile`);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { status: 400, jsonBody: { error: "Request body must be valid JSON" } };
  }
  const parsed = parseBrandProfileRequest(body);
  if (!parsed.ok) return { status: 400, jsonBody: { error: parsed.error } };
  const req = parsed.value;

  try {
    const found = await transaction(async (client) => {
      const brand = await client.query(`SELECT brand_id FROM brand WHERE brand_id = $1 FOR UPDATE`, [brandId]);
      if (brand.rows.length === 0) return false;
      if (req.ownDataSourceId) await ensureDataSourceExists(client, req.ownDataSourceId);

      const current = await client.query<{
        websiteUrl: string | null;
        platform: string | null;
        blocker: string | null;
        notes: string | null;
        ownDataSourceId: number | string | null;
      }>(
        `SELECT website_url AS "websiteUrl", platform, blocker, notes, own_data_source_id AS "ownDataSourceId"
         FROM brand_ingest_profile
         WHERE brand_id = $1
         FOR UPDATE`,
        [brandId]
      );
      const row = current.rows[0];
      const stored: ProfileValues = row
        ? {
            ...row,
            ownDataSourceId: row.ownDataSourceId === null ? null : Number(row.ownDataSourceId),
          }
        : EMPTY_PROFILE;

      const changes = await writeProfile(client, adminUserId, brandId, stored, req);
      if (Object.keys(changes).length > 0) {
        await recordAdminAuditEvent(client, {
          actorUserId: adminUserId,
          targetUserId: null,
          action: "brand.profile_update",
          changes: { brandId, ...changes },
        });
      }
      return true;
    });

    if (!found) return { status: 404, jsonBody: { error: "Brand not found" } };
    trackEvent("admin.brand_profile_update", { brandId, actorUserId: adminUserId });
    const [brand] = await loadBrands(brandId);
    if (!brand) return { status: 404, jsonBody: { error: "Brand not found" } };
    const response: AdminBrandCreateResponse = { brand };
    return { status: 200, jsonBody: response };
  } catch (error) {
    if (error instanceof Rejected) return { status: error.status, jsonBody: error.payload };
    return internalServerError(context, error, "Failed to update brand profile", "brands-admin.profile");
  }
}

app.http("brands-admin-list", {
  methods: ["GET", "POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "brands-admin",
  handler: withCors(
    withAdmin(async (request, context, adminUserId) =>
      request.method === "POST" ? createBrand(request, context, adminUserId) : listBrands(context)
    )
  ),
});

app.http("brands-admin-profile", {
  methods: ["PUT", "OPTIONS"],
  authLevel: "anonymous",
  route: "brands-admin/{id}/profile",
  handler: withCors(
    withAdmin(async (request, context, adminUserId) => updateProfile(request, context, adminUserId))
  ),
});
