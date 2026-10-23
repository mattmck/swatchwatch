import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import {
  resolveDisplayHex,
  wishlistSharePath,
  WISHLIST_SHARE_FEATURE_DISABLED_CODE,
  type PublicWishlistItem,
  type PublicWishlistResponse,
  type WishlistShareStatus,
} from "swatchwatch-shared";
import { withAuth } from "../lib/auth";
import { query } from "../lib/db";
import { internalServerError } from "../lib/errors";
import { withCors, type HttpHandler } from "../lib/http";
import { publicCatalogImageUrl } from "../lib/public-catalog-image";
import { clientIpFromHeaders, TokenBucketLimiter } from "../lib/rate-limit";
import { trackEvent } from "../lib/telemetry";
import {
  deriveShareToken,
  generateShareTokenSalt,
  hashShareToken,
  isShareableWishlistEnabled,
  normalizeShareDisplayName,
  parseShareToken,
  recoverShareToken,
} from "../lib/wishlist-share";

/**
 * Shareable wishlist (issue #268), behind `SHAREABLE_WISHLIST_ENABLED` (off by default).
 *
 * Owner routes (withAuth, every statement keyed by the caller's user_id):
 *   GET    /api/wishlist-share          current link status (re-derives the token)
 *   POST   /api/wishlist-share          enable (idempotent) / set the public display name
 *   POST   /api/wishlist-share/rotate   new token; the old link stops working immediately
 *   DELETE /api/wishlist-share          revoke (deletes the row; the link 404s immediately)
 *
 * Public route (anonymous, rate-limited):
 *   GET    /api/wishlist/{token}        owner display name + wishlist items (explicit allowlist)
 *
 * While the flag is off every route answers 404 `{ code: "feature_disabled" }`, before auth.
 */

/** Hard cap on items returned by the public page. */
export const PUBLIC_WISHLIST_MAX_ITEMS = 500;
/** Browser-only caching; shared caches must not keep a page that may be revoked at any time. */
const PUBLIC_CACHE_CONTROL = "private, max-age=60";
const PUBLIC_HEADERS = {
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Referrer-Policy": "no-referrer",
};
const NO_STORE_HEADERS = { "Cache-Control": "no-store", ...PUBLIC_HEADERS };

/** Longest raw token string we bother to hash for the per-token bucket (valid tokens are 43). */
const MAX_TOKEN_PARAM_LENGTH = 128;

/**
 * Best-effort per-instance limits (see src/lib/rate-limit.ts): each client IP gets a burst of 30
 * then 1 request / 2 s; each token gets a burst of 60 then 1 request / s across all clients.
 */
export const publicWishlistIpLimiter = new TokenBucketLimiter({ capacity: 30, refillPerSecond: 0.5 });
export const publicWishlistTokenLimiter = new TokenBucketLimiter({ capacity: 60, refillPerSecond: 1 });

function featureDisabledResponse(): HttpResponseInit {
  return {
    status: 404,
    headers: { "Cache-Control": "no-store" },
    jsonBody: { error: "Shareable wishlists are not enabled", code: WISHLIST_SHARE_FEATURE_DISABLED_CODE },
  };
}

/** Answer 404 (feature disabled) for every request while the flag is off, before auth runs. */
function requireShareableWishlist(handler: HttpHandler): HttpHandler {
  return async (request, context) => {
    if (!isShareableWishlistEnabled()) return featureDisabledResponse();
    return handler(request, context);
  };
}

// ---------------------------------------------------------------------------
// Owner routes
// ---------------------------------------------------------------------------

interface ShareRow {
  tokenSalt: string;
  tokenHash: string;
  displayName: string | null;
  createdAt: string | Date;
  rotatedAt: string | Date;
}

const SHARE_RETURNING = `
  token_salt   AS "tokenSalt",
  token_hash   AS "tokenHash",
  display_name AS "displayName",
  created_at   AS "createdAt",
  rotated_at   AS "rotatedAt"`;

function toIso(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

/** Wishlist counts for the owner: items the public page shows vs. private submissions it hides. */
async function wishlistCounts(userId: number): Promise<{ visible: number; hidden: number }> {
  const result = await query<{ visible: number | string; hidden: number | string }>(
    `SELECT COUNT(*) FILTER (WHERE s.status <> 'user_submitted')::int AS visible,
            COUNT(*) FILTER (WHERE s.status = 'user_submitted')::int  AS hidden
     FROM user_inventory_item ui
     JOIN shade s ON s.shade_id = ui.shade_id
     WHERE ui.user_id = $1
       AND ui.status = 'wishlist'`,
    [userId]
  );
  const row = result.rows[0];
  return { visible: Number(row?.visible ?? 0), hidden: Number(row?.hidden ?? 0) };
}

async function buildStatus(userId: number, row: ShareRow | null): Promise<WishlistShareStatus> {
  const counts = await wishlistCounts(userId);
  if (!row) {
    return {
      enabled: false,
      token: null,
      path: null,
      displayName: null,
      wishlistCount: counts.visible,
      hiddenCount: counts.hidden,
      createdAt: null,
      rotatedAt: null,
    };
  }
  const token = recoverShareToken(userId, row.tokenSalt, row.tokenHash);
  return {
    enabled: true,
    token,
    path: token ? wishlistSharePath(token) : null,
    displayName: row.displayName ?? null,
    wishlistCount: counts.visible,
    hiddenCount: counts.hidden,
    createdAt: toIso(row.createdAt),
    rotatedAt: toIso(row.rotatedAt),
  };
}

async function readJsonBody(request: HttpRequest): Promise<Record<string, unknown> | null> {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function getWishlistShare(
  _request: HttpRequest,
  context: InvocationContext,
  userId: number
): Promise<HttpResponseInit> {
  try {
    const result = await query<ShareRow>(
      `SELECT ${SHARE_RETURNING}
       FROM wishlist_share
       WHERE user_id = $1`,
      [userId]
    );
    return {
      status: 200,
      headers: { "Cache-Control": "no-store" },
      jsonBody: await buildStatus(userId, result.rows[0] ?? null),
    };
  } catch (error) {
    return internalServerError(context, error, "Failed to load wishlist share", "wishlist-share.get");
  }
}

export async function enableWishlistShare(
  request: HttpRequest,
  context: InvocationContext,
  userId: number
): Promise<HttpResponseInit> {
  const body = await readJsonBody(request);
  if (!body) {
    return { status: 400, jsonBody: { error: "Request body must be a JSON object" } };
  }
  const hasDisplayName = Object.prototype.hasOwnProperty.call(body, "displayName");
  const displayName = normalizeShareDisplayName(body.displayName);
  if (!displayName.ok) {
    return { status: 400, jsonBody: { error: displayName.error } };
  }

  try {
    // A fresh salt/hash is used only when the row is created; an existing link keeps its token.
    const salt = generateShareTokenSalt();
    const tokenHash = hashShareToken(deriveShareToken(userId, salt));
    const result = await query<ShareRow>(
      `INSERT INTO wishlist_share (user_id, token_hash, token_salt, display_name)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE
       SET display_name = CASE WHEN $5 THEN EXCLUDED.display_name ELSE wishlist_share.display_name END,
           updated_at = now()
       WHERE wishlist_share.user_id = $1
       RETURNING ${SHARE_RETURNING}`,
      [userId, tokenHash, salt, displayName.value, hasDisplayName]
    );
    trackEvent("wishlist_share.enabled");
    return {
      status: 200,
      headers: { "Cache-Control": "no-store" },
      jsonBody: await buildStatus(userId, result.rows[0] ?? null),
    };
  } catch (error) {
    return internalServerError(context, error, "Failed to enable wishlist share", "wishlist-share.enable");
  }
}

export async function rotateWishlistShare(
  _request: HttpRequest,
  context: InvocationContext,
  userId: number
): Promise<HttpResponseInit> {
  try {
    const salt = generateShareTokenSalt();
    const tokenHash = hashShareToken(deriveShareToken(userId, salt));
    const result = await query<ShareRow>(
      `UPDATE wishlist_share
       SET token_salt = $2,
           token_hash = $3,
           rotated_at = now(),
           updated_at = now()
       WHERE user_id = $1
       RETURNING ${SHARE_RETURNING}`,
      [userId, salt, tokenHash]
    );
    if (result.rows.length === 0) {
      return { status: 404, jsonBody: { error: "No wishlist share link to rotate" } };
    }
    trackEvent("wishlist_share.rotated");
    return {
      status: 200,
      headers: { "Cache-Control": "no-store" },
      jsonBody: await buildStatus(userId, result.rows[0]),
    };
  } catch (error) {
    return internalServerError(context, error, "Failed to rotate wishlist share", "wishlist-share.rotate");
  }
}

export async function revokeWishlistShare(
  _request: HttpRequest,
  context: InvocationContext,
  userId: number
): Promise<HttpResponseInit> {
  try {
    const result = await query(`DELETE FROM wishlist_share WHERE user_id = $1`, [userId]);
    if ((result.rowCount ?? 0) > 0) trackEvent("wishlist_share.revoked");
    return {
      status: 200,
      headers: { "Cache-Control": "no-store" },
      jsonBody: await buildStatus(userId, null),
    };
  } catch (error) {
    return internalServerError(context, error, "Failed to revoke wishlist share", "wishlist-share.revoke");
  }
}

// ---------------------------------------------------------------------------
// Public route
// ---------------------------------------------------------------------------

interface PublicItemRow {
  brand: string | null;
  name: string | null;
  finish: string | null;
  finishes: string[] | null;
  vendorHex: string | null;
  detectedHex: string | null;
  nameHex: string | null;
  imageUrl: string | null;
}

/**
 * Only the owner's status = 'wishlist' rows, and only shared-catalog shades: the owner's private
 * `user_submitted` shades stay hidden (private by default). The image is the shade's catalog
 * product swatch; it is exposed only as a public v2 proxy id (see `publicCatalogImageUrl`).
 */
const PUBLIC_ITEMS_SQL = `
  SELECT
    COALESCE(b.name_canonical, '')        AS brand,
    COALESCE(s.shade_name_canonical, '')  AS name,
    s.finish                              AS finish,
    s.finishes                            AS finishes,
    s.vendor_hex                          AS "vendorHex",
    s.detected_hex                        AS "detectedHex",
    s.name_hex                            AS "nameHex",
    swatch_img.storage_url                AS "imageUrl"
  FROM user_inventory_item ui
  JOIN shade s ON s.shade_id = ui.shade_id
  JOIN brand b ON b.brand_id = s.brand_id
  LEFT JOIN LATERAL (
    SELECT ia.storage_url
    FROM swatch sw
    JOIN image_asset ia ON ia.image_id = sw.image_id_original
    WHERE sw.shade_id = s.shade_id
    ORDER BY COALESCE(sw.swatch_type = 'source_product', false) DESC, sw.swatch_id DESC
    LIMIT 1
  ) AS swatch_img ON true
  WHERE ui.user_id = $1
    AND ui.status = 'wishlist'
    AND s.status <> 'user_submitted'
  ORDER BY lower(b.name_canonical), lower(s.shade_name_canonical), s.shade_id
  LIMIT ${PUBLIC_WISHLIST_MAX_ITEMS}`;

/** Map a row to the public allowlist. Nothing outside these five fields can leak. */
export function toPublicWishlistItem(row: PublicItemRow, requestUrl: string): PublicWishlistItem {
  const finishes = Array.isArray(row.finishes)
    ? row.finishes.filter((f): f is string => typeof f === "string" && f.trim().length > 0)
    : [];
  if (finishes.length === 0 && row.finish?.trim()) finishes.push(row.finish.trim());
  return {
    brand: row.brand ?? "",
    name: row.name ?? "",
    finishes,
    hex: resolveDisplayHex({
      vendorHex: row.vendorHex ?? undefined,
      detectedHex: row.detectedHex ?? undefined,
      nameHex: row.nameHex ?? undefined,
    }) ?? null,
    imageUrl: publicCatalogImageUrl(row.imageUrl, requestUrl),
  };
}

function notFound(): HttpResponseInit {
  return { status: 404, headers: NO_STORE_HEADERS, jsonBody: { error: "Wishlist not found" } };
}

function tooManyRequests(retryAfterSeconds: number): HttpResponseInit {
  return {
    status: 429,
    headers: { ...NO_STORE_HEADERS, "Retry-After": String(retryAfterSeconds) },
    jsonBody: { error: "Too many requests" },
  };
}

export async function getPublicWishlist(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  // Rate-limit by client IP first (also covers malformed/guessed tokens), then by token.
  const ipDecision = publicWishlistIpLimiter.take(`ip:${clientIpFromHeaders(request.headers)}`);
  if (!ipDecision.allowed) {
    trackEvent("wishlist_share.rate_limited", { scope: "ip" });
    return tooManyRequests(ipDecision.retryAfterSeconds);
  }

  const rawToken = request.params.token ?? "";
  if (rawToken.length > MAX_TOKEN_PARAM_LENGTH) return notFound();
  const tokenDecision = publicWishlistTokenLimiter.take(`token:${hashShareToken(rawToken)}`);
  if (!tokenDecision.allowed) {
    trackEvent("wishlist_share.rate_limited", { scope: "token" });
    return tooManyRequests(tokenDecision.retryAfterSeconds);
  }

  const token = parseShareToken(rawToken);
  if (!token) return notFound();

  try {
    const shareResult = await query<{ userId: number | string; displayName: string | null }>(
      // A suspended owner's page is not served (#45). Read via to_jsonb so the query stays valid
      // before the suspension migration has run.
      `SELECT ws.user_id AS "userId", ws.display_name AS "displayName"
       FROM wishlist_share ws
       JOIN app_user u ON u.user_id = ws.user_id
       WHERE ws.token_hash = $1
         AND (to_jsonb(u.*) ->> 'suspended_at') IS NULL`,
      [hashShareToken(token)]
    );
    const share = shareResult.rows[0];
    if (!share) return notFound();
    const ownerId = Number(share.userId);
    if (!Number.isSafeInteger(ownerId) || ownerId <= 0) return notFound();

    const itemsResult = await query<PublicItemRow>(PUBLIC_ITEMS_SQL, [ownerId]);
    const body: PublicWishlistResponse = {
      displayName: share.displayName ?? null,
      items: itemsResult.rows.map((row) => toPublicWishlistItem(row, request.url)),
    };
    trackEvent("wishlist_share.viewed", { itemCount: body.items.length });
    return {
      status: 200,
      headers: { "Cache-Control": PUBLIC_CACHE_CONTROL, ...PUBLIC_HEADERS },
      jsonBody: body,
    };
  } catch (error) {
    return internalServerError(context, error, "Failed to load wishlist", "wishlist-share.public");
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
      return getWishlistShare(request, context, userId);
    case "POST":
      return enableWishlistShare(request, context, userId);
    case "DELETE":
      return revokeWishlistShare(request, context, userId);
    default:
      return { status: 405, jsonBody: { error: "Method not allowed" } };
  }
}

app.http("wishlist-share", {
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  authLevel: "anonymous",
  route: "wishlist-share",
  handler: withCors(requireShareableWishlist(withAuth(ownerRoute))),
});

app.http("wishlist-share-rotate", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "wishlist-share/rotate",
  handler: withCors(requireShareableWishlist(withAuth(rotateWishlistShare))),
});

app.http("wishlist-public", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "wishlist/{token}",
  handler: withCors(requireShareableWishlist(getPublicWishlist)),
});
