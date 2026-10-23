import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import {
  lookSharePath,
  LOOK_SHARE_FEATURE_DISABLED_CODE,
  LOOK_SHARE_REVOKED_CODE,
  type LookShareListResponse,
  type LookShareStatus,
} from "swatchwatch-shared";
import { withAuth } from "../lib/auth";
import { query } from "../lib/db";
import { internalServerError } from "../lib/errors";
import { withCors, type HttpHandler } from "../lib/http";
import {
  deriveLookShareToken,
  hashLookShareToken,
  isShareableLooksEnabled,
  recoverLookShareToken,
  shadeIdsForShare,
  storedStepsForShare,
  toPublicLook,
  type PublicShadeRow,
} from "../lib/look-share";
import { clientIpFromHeaders, TokenBucketLimiter } from "../lib/rate-limit";
import { trackEvent } from "../lib/telemetry";
import { generateShareTokenSalt, normalizeShareDisplayName, parseShareToken } from "../lib/wishlist-share";

/**
 * Shareable looks: one public, read-only link per saved look, behind `SHAREABLE_LOOKS_ENABLED`
 * (off by default). Modeled on the shareable wishlist (#268, `functions/wishlist-share.ts`).
 *
 * Owner routes (withAuth, every statement keyed by the caller's user_id):
 *   GET    /api/look-share              the caller's live links (re-derives each token)
 *   POST   /api/look-share              share a saved look `{ lookKey, displayName? }`: idempotent
 *                                       while live, a new token after a revoke
 *   DELETE /api/look-share?key=...      revoke (the link answers 410 immediately)
 *
 * Public route (anonymous, rate-limited):
 *   GET    /api/look/{token}            display name, template, vibe and steps (explicit allowlist,
 *                                       `toPublicLook` in lib/look-share.ts)
 *
 * While the flag is off every route answers 404 `{ code: "feature_disabled" }`, before auth.
 */

/** Browser-only caching; shared caches must not keep a page that may be revoked at any time. */
const PUBLIC_CACHE_CONTROL = "private, max-age=60";
const PUBLIC_HEADERS = {
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Referrer-Policy": "no-referrer",
};
const NO_STORE_HEADERS = { "Cache-Control": "no-store", ...PUBLIC_HEADERS };

/** Longest raw token string we bother to hash for the per-token bucket (valid tokens are 43). */
const MAX_TOKEN_PARAM_LENGTH = 128;
/** Longest look key accepted (the `user_look.look_key` CHECK allows 160). */
const MAX_LOOK_KEY_LENGTH = 160;
const MAX_BODY_BYTES = 2_000;

/**
 * Best-effort per-instance limits (see src/lib/rate-limit.ts), the same budgets as the public
 * wishlist but separate buckets: each client IP gets a burst of 30 then 1 request / 2 s; each
 * token gets a burst of 60 then 1 request / s across all clients.
 */
export const publicLookIpLimiter = new TokenBucketLimiter({ capacity: 30, refillPerSecond: 0.5 });
export const publicLookTokenLimiter = new TokenBucketLimiter({ capacity: 60, refillPerSecond: 1 });

function featureDisabledResponse(): HttpResponseInit {
  return {
    status: 404,
    headers: { "Cache-Control": "no-store" },
    jsonBody: { error: "Shareable looks are not enabled", code: LOOK_SHARE_FEATURE_DISABLED_CODE },
  };
}

/** Answer 404 (feature disabled) for every request while the flag is off, before auth runs. */
function requireShareableLooks(handler: HttpHandler): HttpHandler {
  return async (request, context) => {
    if (!isShareableLooksEnabled()) return featureDisabledResponse();
    return handler(request, context);
  };
}

// ---------------------------------------------------------------------------
// Owner routes
// ---------------------------------------------------------------------------

interface ShareRow {
  userLookId: number | string;
  lookKey: string;
  tokenSalt: string;
  tokenHash: string;
  displayName: string | null;
  createdAt: string | Date;
  revokedAt: string | Date | null;
}

const SHARE_COLUMNS = `
  ls.user_look_id AS "userLookId",
  ul.look_key     AS "lookKey",
  ls.token_salt   AS "tokenSalt",
  ls.token_hash   AS "tokenHash",
  ls.display_name AS "displayName",
  ls.created_at   AS "createdAt",
  ls.revoked_at   AS "revokedAt"`;

function toIso(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function toStatus(userId: number, row: ShareRow): LookShareStatus {
  const revoked = row.revokedAt !== null && row.revokedAt !== undefined;
  const token = revoked ? null : recoverLookShareToken(userId, Number(row.userLookId), row.tokenSalt, row.tokenHash);
  return {
    lookKey: row.lookKey,
    enabled: !revoked,
    token,
    path: token ? lookSharePath(token) : null,
    displayName: row.displayName ?? null,
    createdAt: toIso(row.createdAt),
    revokedAt: toIso(row.revokedAt),
  };
}

function offStatus(lookKey: string): LookShareStatus {
  return { lookKey, enabled: false, token: null, path: null, displayName: null, createdAt: null, revokedAt: null };
}

function readLookKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim();
  return key && key.length <= MAX_LOOK_KEY_LENGTH ? key : null;
}

async function readJsonBody(request: HttpRequest): Promise<Record<string, unknown> | null> {
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function listLookShares(
  _request: HttpRequest,
  context: InvocationContext,
  userId: number
): Promise<HttpResponseInit> {
  try {
    const result = await query<ShareRow>(
      `SELECT ${SHARE_COLUMNS}
       FROM look_share ls
       JOIN user_look ul ON ul.user_look_id = ls.user_look_id AND ul.user_id = ls.user_id
       WHERE ls.user_id = $1
         AND ul.user_id = $1
         AND ls.revoked_at IS NULL
       ORDER BY ls.created_at DESC`,
      [userId]
    );
    const body: LookShareListResponse = { shares: result.rows.map((row) => toStatus(userId, row)) };
    return { status: 200, headers: { "Cache-Control": "no-store" }, jsonBody: body };
  } catch (error) {
    return internalServerError(context, error, "Failed to load look shares", "look-share.list");
  }
}

export async function createLookShare(
  request: HttpRequest,
  context: InvocationContext,
  userId: number
): Promise<HttpResponseInit> {
  const body = await readJsonBody(request);
  if (!body) return { status: 400, jsonBody: { error: "Request body must be a JSON object" } };
  const lookKey = readLookKey(body.lookKey);
  if (!lookKey) return { status: 400, jsonBody: { error: "lookKey is required" } };
  const hasDisplayName = Object.prototype.hasOwnProperty.call(body, "displayName");
  const displayName = normalizeShareDisplayName(body.displayName);
  if (!displayName.ok) return { status: 400, jsonBody: { error: displayName.error } };

  try {
    const lookResult = await query<{ userLookId: number | string }>(
      `SELECT user_look_id AS "userLookId"
       FROM user_look
       WHERE user_id = $1
         AND look_key = $2`,
      [userId, lookKey]
    );
    const userLookId = Number(lookResult.rows[0]?.userLookId);
    if (!Number.isSafeInteger(userLookId) || userLookId <= 0) {
      return { status: 404, jsonBody: { error: "Save this look first, then share it" } };
    }

    // A fresh salt/hash is used for a new link or after a revoke; a live link keeps its token.
    const salt = generateShareTokenSalt();
    const tokenHash = hashLookShareToken(deriveLookShareToken(userId, userLookId, salt));
    const result = await query<ShareRow>(
      `WITH upserted AS (
         INSERT INTO look_share (user_look_id, user_id, token_hash, token_salt, display_name)
         SELECT ul.user_look_id, ul.user_id, $3, $4, $5
         FROM user_look ul
         WHERE ul.user_look_id = $2
           AND ul.user_id = $1
         ON CONFLICT (user_look_id) DO UPDATE
         SET token_hash   = CASE WHEN look_share.revoked_at IS NULL THEN look_share.token_hash ELSE EXCLUDED.token_hash END,
             token_salt   = CASE WHEN look_share.revoked_at IS NULL THEN look_share.token_salt ELSE EXCLUDED.token_salt END,
             created_at   = CASE WHEN look_share.revoked_at IS NULL THEN look_share.created_at ELSE now() END,
             display_name = CASE WHEN $6 THEN EXCLUDED.display_name ELSE look_share.display_name END,
             revoked_at   = NULL,
             updated_at   = now()
         WHERE look_share.user_id = $1
         RETURNING *
       )
       SELECT ${SHARE_COLUMNS}
       FROM upserted ls
       JOIN user_look ul ON ul.user_look_id = ls.user_look_id AND ul.user_id = ls.user_id
       WHERE ls.user_id = $1
         AND ul.user_id = $1`,
      [userId, userLookId, tokenHash, salt, displayName.value, hasDisplayName]
    );
    const row = result.rows[0];
    if (!row) return { status: 404, jsonBody: { error: "Save this look first, then share it" } };
    trackEvent("look_share.enabled");
    return { status: 200, headers: { "Cache-Control": "no-store" }, jsonBody: toStatus(userId, row) };
  } catch (error) {
    return internalServerError(context, error, "Failed to share look", "look-share.create");
  }
}

export async function revokeLookShare(
  request: HttpRequest,
  context: InvocationContext,
  userId: number
): Promise<HttpResponseInit> {
  const lookKey = readLookKey(request.query.get("key"));
  if (!lookKey) return { status: 400, jsonBody: { error: "key is required" } };
  try {
    const result = await query<ShareRow>(
      `UPDATE look_share ls
       SET revoked_at = now(),
           updated_at = now()
       FROM user_look ul
       WHERE ul.user_look_id = ls.user_look_id
         AND ul.user_id = $1
         AND ls.user_id = $1
         AND ul.look_key = $2
         AND ls.revoked_at IS NULL
       RETURNING ${SHARE_COLUMNS}`,
      [userId, lookKey]
    );
    const row = result.rows[0];
    if (row) trackEvent("look_share.revoked");
    return {
      status: 200,
      headers: { "Cache-Control": "no-store" },
      jsonBody: row ? toStatus(userId, row) : offStatus(lookKey),
    };
  } catch (error) {
    return internalServerError(context, error, "Failed to revoke look share", "look-share.revoke");
  }
}

// ---------------------------------------------------------------------------
// Public route
// ---------------------------------------------------------------------------

interface PublicShareRow {
  displayName: string | null;
  revoked: boolean;
  templateId: string;
  vibe: unknown;
  steps: unknown;
}

/**
 * The step shades the public page may name: shared-catalog shades only. The owner's private
 * `user_submitted` shades (and anyone else's), excluded/accessory shades and shades retired by an
 * admin merge are not returned, so those steps fall back to plain color chips. The image is the
 * shade's catalog product swatch, exposed only as a public v2 proxy id (`publicCatalogImageUrl`).
 */
const PUBLIC_SHADES_SQL = `
  SELECT
    s.shade_id                            AS "shadeId",
    COALESCE(b.name_canonical, '')        AS brand,
    COALESCE(s.shade_name_canonical, '')  AS name,
    s.finish                              AS finish,
    s.finishes                            AS finishes,
    s.vendor_hex                          AS "vendorHex",
    s.detected_hex                        AS "detectedHex",
    s.name_hex                            AS "nameHex",
    swatch_img.storage_url                AS "imageUrl"
  FROM shade s
  JOIN brand b ON b.brand_id = s.brand_id
  LEFT JOIN LATERAL (
    SELECT ia.storage_url
    FROM swatch sw
    JOIN image_asset ia ON ia.image_id = sw.image_id_original
    WHERE sw.shade_id = s.shade_id
    ORDER BY COALESCE(sw.swatch_type = 'source_product', false) DESC, sw.swatch_id DESC
    LIMIT 1
  ) AS swatch_img ON true
  WHERE s.shade_id = ANY($1::bigint[])
    AND s.status <> 'user_submitted'
    AND s.status <> 'excluded'
    AND s.product_category <> 'accessory'
    AND s.merged_into_shade_id IS NULL`;

function notFound(): HttpResponseInit {
  return { status: 404, headers: NO_STORE_HEADERS, jsonBody: { error: "Look not found" } };
}

function revokedResponse(): HttpResponseInit {
  return {
    status: 410,
    headers: NO_STORE_HEADERS,
    jsonBody: { error: "This look is no longer shared", code: LOOK_SHARE_REVOKED_CODE },
  };
}

function tooManyRequests(retryAfterSeconds: number): HttpResponseInit {
  return {
    status: 429,
    headers: { ...NO_STORE_HEADERS, "Retry-After": String(retryAfterSeconds) },
    jsonBody: { error: "Too many requests" },
  };
}

export async function getPublicLook(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  // Rate-limit by client IP first (also covers malformed/guessed tokens), then by token.
  const ipDecision = publicLookIpLimiter.take(`ip:${clientIpFromHeaders(request.headers)}`);
  if (!ipDecision.allowed) {
    trackEvent("look_share.rate_limited", { scope: "ip" });
    return tooManyRequests(ipDecision.retryAfterSeconds);
  }

  const rawToken = request.params.token ?? "";
  if (rawToken.length > MAX_TOKEN_PARAM_LENGTH) return notFound();
  const tokenDecision = publicLookTokenLimiter.take(`token:${hashLookShareToken(rawToken)}`);
  if (!tokenDecision.allowed) {
    trackEvent("look_share.rate_limited", { scope: "token" });
    return tooManyRequests(tokenDecision.retryAfterSeconds);
  }

  const token = parseShareToken(rawToken);
  if (!token) return notFound();

  try {
    const shareResult = await query<PublicShareRow>(
      // A suspended owner's look is not served (#45). Read via to_jsonb so the query stays valid
      // before the suspension migration has run.
      `SELECT ls.display_name             AS "displayName",
              (ls.revoked_at IS NOT NULL) AS revoked,
              ul.template_id              AS "templateId",
              ul.vibe,
              ul.steps
       FROM look_share ls
       JOIN user_look ul ON ul.user_look_id = ls.user_look_id AND ul.user_id = ls.user_id
       JOIN app_user u ON u.user_id = ls.user_id
       WHERE ls.token_hash = $1
         AND (to_jsonb(u.*) ->> 'suspended_at') IS NULL`,
      [hashLookShareToken(token)]
    );
    const share = shareResult.rows[0];
    if (!share) return notFound();
    if (share.revoked) return revokedResponse();

    const shadeIds = shadeIdsForShare(storedStepsForShare(share.steps));
    const shades = new Map<string, PublicShadeRow>();
    if (shadeIds.length > 0) {
      const shadeResult = await query<PublicShadeRow>(PUBLIC_SHADES_SQL, [shadeIds]);
      for (const row of shadeResult.rows) shades.set(String(row.shadeId), row);
    }
    const body = toPublicLook(share, share.displayName, shades, request.url);
    if (!body) return notFound();
    trackEvent("look_share.viewed", { stepCount: body.steps.length });
    return {
      status: 200,
      headers: { "Cache-Control": PUBLIC_CACHE_CONTROL, ...PUBLIC_HEADERS },
      jsonBody: body,
    };
  } catch (error) {
    return internalServerError(context, error, "Failed to load look", "look-share.public");
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

async function ownerRoute(
  request: HttpRequest,
  context: InvocationContext,
  userId: number
): Promise<HttpResponseInit> {
  switch (request.method?.toUpperCase()) {
    case "GET":
      return listLookShares(request, context, userId);
    case "POST":
      return createLookShare(request, context, userId);
    case "DELETE":
      return revokeLookShare(request, context, userId);
    default:
      return { status: 405, jsonBody: { error: "Method not allowed" } };
  }
}

app.http("look-share", {
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  authLevel: "anonymous",
  route: "look-share",
  handler: withCors(requireShareableLooks(withAuth(ownerRoute))),
});

app.http("look-public", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "look/{token}",
  handler: withCors(requireShareableLooks(getPublicLook)),
});
