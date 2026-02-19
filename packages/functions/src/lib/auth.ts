import { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { query } from "./db";

export interface AuthResult {
  userId: number;
  externalId: string;
  email?: string;
  role: string;
}

/**
 * Authenticate an incoming request.
 *
 * - **Dev bypass** (`AUTH_DEV_BYPASS=true`): accepts `Bearer dev:<userId>` tokens.
 *   Looks up the user by user_id directly — meant for local development only.
 * - **Production** (Entra/B2C configured): validates JWT against tenant JWKS,
 *   extracts `oid` claim, and upserts the user by external_id.
 */
export async function authenticateRequest(
  request: HttpRequest,
  context: InvocationContext
): Promise<AuthResult> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new AuthError("Missing or malformed Authorization header");
  }

  const token = authHeader.substring(7);
  if (!token) {
    throw new AuthError("Empty token");
  }

  // Dev bypass mode
  if (process.env.AUTH_DEV_BYPASS === "true") {
    return handleDevBypass(token, context);
  }

  // Production B2C JWT validation
  return handleB2CToken(token, context);
}

async function handleDevBypass(
  token: string,
  context: InvocationContext
): Promise<AuthResult> {
  const match = token.match(/^dev:(\d+)$/);
  if (!match) {
    throw new AuthError("Invalid dev token format. Expected: dev:<userId>");
  }

  const userId = parseInt(match[1], 10);
  context.log(`Auth dev bypass: userId=${userId}`);

  const result = await (async () => {
    try {
      return await query<{
        user_id: number;
        external_id: string;
        email: string | null;
        role: string | null;
      }>(
        `SELECT user_id, external_id, email, role FROM app_user WHERE user_id = $1`,
        [userId]
      );
    } catch (error: any) {
      // Backward-compatible fallback when role column doesn't exist yet.
      if (error?.code === "42703") {
        return query<{
          user_id: number;
          external_id: string;
          email: string | null;
          role: string | null;
        }>(
          `SELECT user_id, external_id, email, 'user'::text AS role FROM app_user WHERE user_id = $1`,
          [userId]
        );
      }
      throw error;
    }
  })();

  if (result.rows.length === 0) {
    throw new AuthError(`Dev user ${userId} not found`);
  }

  const user = result.rows[0];
  return {
    userId: user.user_id,
    externalId: user.external_id || `dev-user-${userId}`,
    email: user.email || undefined,
    role: user.role || "user",
  };
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksUri: string | null = null;
let oidcConfigPromise: Promise<OidcConfig> | null = null;

interface OidcConfig {
  issuer: string;
  jwksUri: string;
}

const toLegacyB2CConfig = (tenant: string): OidcConfig => ({
  issuer: `https://${tenant}.b2clogin.com/${tenant}.onmicrosoft.com/v2.0`,
  jwksUri: `https://${tenant}.b2clogin.com/${tenant}.onmicrosoft.com/discovery/v2.0/keys`,
});

const toIssuerCandidates = (issuer: string): string[] => {
  const normalized = issuer.endsWith("/") ? issuer.slice(0, -1) : issuer;
  return [normalized, `${normalized}/`];
};

async function discoverOidcConfig(
  tenant: string,
  context: InvocationContext
): Promise<OidcConfig> {
  const ciamWellKnownUrl = `https://${tenant}.ciamlogin.com/${tenant}.onmicrosoft.com/v2.0/.well-known/openid-configuration`;

  try {
    const response = await fetch(ciamWellKnownUrl);
    if (response.ok) {
      const body = (await response.json()) as {
        issuer?: string;
        jwks_uri?: string;
      };
      if (body.issuer && body.jwks_uri) {
        context.log("Auth OIDC: using ciamlogin.com metadata");
        return { issuer: body.issuer, jwksUri: body.jwks_uri };
      }
    } else {
      context.log(`Auth OIDC: ciam metadata unavailable (${response.status}), falling back`);
    }
  } catch (error) {
    context.log(`Auth OIDC: ciam metadata lookup failed, falling back (${String(error)})`);
  }

  context.log("Auth OIDC: using legacy b2clogin.com metadata");
  return toLegacyB2CConfig(tenant);
}

async function getOidcConfig(
  tenant: string,
  context: InvocationContext
): Promise<OidcConfig> {
  if (!oidcConfigPromise) {
    oidcConfigPromise = discoverOidcConfig(tenant, context);
  }
  return oidcConfigPromise;
}

async function handleB2CToken(
  token: string,
  context: InvocationContext
): Promise<AuthResult> {
  const tenant = process.env.AZURE_AD_B2C_TENANT;
  const clientId = process.env.AZURE_AD_B2C_CLIENT_ID;

  if (!tenant || !clientId) {
    throw new AuthError("Azure AD B2C not configured");
  }

  const oidcConfig = await getOidcConfig(tenant, context);
  if (!jwks || jwksUri !== oidcConfig.jwksUri) {
    jwks = createRemoteJWKSet(new URL(oidcConfig.jwksUri));
    jwksUri = oidcConfig.jwksUri;
  }

  const { payload } = await jwtVerify(token, jwks, {
    issuer: toIssuerCandidates(oidcConfig.issuer),
    audience: clientId,
  });

  const externalId = (payload.oid as string | undefined) || (payload.sub as string | undefined);
  if (!externalId) {
    throw new AuthError("Token missing oid/sub claim");
  }

  const email = (payload.emails as string[] | undefined)?.[0]
    || (payload.email as string | undefined);

  context.log(`Auth B2C: oid=${externalId}`);

  const user = await getOrCreateUser(externalId, email);

  return { userId: user.userId, externalId, email, role: user.role };
}

/**
 * Upsert a user by external_id. Returns the local user_id.
 */
async function getOrCreateUser(
  externalId: string,
  email?: string
): Promise<{ userId: number; role: string }> {
  const result = await (async () => {
    try {
      return await query<{ user_id: number; role: string | null }>(
        `INSERT INTO app_user (external_id, email, handle)
         VALUES ($1, $2, $3)
         ON CONFLICT (external_id) DO UPDATE SET email = COALESCE(EXCLUDED.email, app_user.email)
         RETURNING user_id, role`,
        [externalId, email || null, email || externalId]
      );
    } catch (error: any) {
      if (error?.code === "42703") {
        return query<{ user_id: number; role: string | null }>(
          `INSERT INTO app_user (external_id, email, handle)
           VALUES ($1, $2, $3)
           ON CONFLICT (external_id) DO UPDATE SET email = COALESCE(EXCLUDED.email, app_user.email)
           RETURNING user_id, 'user'::text AS role`,
          [externalId, email || null, email || externalId]
        );
      }
      throw error;
    }
  })();
  return {
    userId: result.rows[0].user_id,
    role: result.rows[0].role || "user",
  };
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

/**
 * Higher-order wrapper that authenticates the request before calling the handler.
 * The handler receives the resolved userId as a third parameter.
 *
 * Returns 401 JSON if authentication fails.
 */
export type AuthenticatedHandler = (
  request: HttpRequest,
  context: InvocationContext,
  userId: number
) => Promise<HttpResponseInit>;

export type AdminHandler = AuthenticatedHandler;

export function withAuth(
  handler: AuthenticatedHandler
): (request: HttpRequest, context: InvocationContext) => Promise<HttpResponseInit> {
  return async (request, context) => {
    try {
      const auth = await authenticateRequest(request, context);
      return handler(request, context, auth.userId);
    } catch (error) {
      if (error instanceof AuthError) {
        return {
          status: 401,
          jsonBody: { error: error.message },
        };
      }
      context.error("Unexpected auth error:", error);
      return {
        status: 401,
        jsonBody: { error: "Authentication failed" },
      };
    }
  };
}

export function withAdmin(
  handler: AdminHandler
): (request: HttpRequest, context: InvocationContext) => Promise<HttpResponseInit> {
  return async (request, context) => {
    try {
      const auth = await authenticateRequest(request, context);
      if (auth.role !== "admin") {
        return {
          status: 403,
          jsonBody: { error: "Admin role required" },
        };
      }
      return handler(request, context, auth.userId);
    } catch (error) {
      if (error instanceof AuthError) {
        return {
          status: 401,
          jsonBody: { error: error.message },
        };
      }
      context.error("Unexpected auth error:", error);
      return {
        status: 401,
        jsonBody: { error: "Authentication failed" },
      };
    }
  };
}
