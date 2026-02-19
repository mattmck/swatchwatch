import { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { query } from "./db";

export interface AuthResult {
  userId: number;
  externalId: string;
  email?: string;
  role?: string;
}

/**
 * Authenticate an incoming request.
 *
 * - **Dev bypass** (`AUTH_DEV_BYPASS=true`): accepts `Bearer dev:<userId>` tokens.
 *   Looks up the user by user_id directly — meant for local development only.
 * - **Production** (B2C configured): validates JWT against Azure AD B2C JWKS,
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

  const result = await query<{ user_id: number; external_id: string; email: string | null }>(
    `SELECT user_id, external_id, email FROM app_user WHERE user_id = $1`,
    [userId]
  );

  if (result.rows.length === 0) {
    throw new AuthError(`Dev user ${userId} not found`);
  }

  const user = result.rows[0];
  return {
    userId: user.user_id,
    externalId: user.external_id || `dev-user-${userId}`,
    email: user.email || undefined,
  };
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

async function handleB2CToken(
  token: string,
  context: InvocationContext
): Promise<AuthResult> {
  const tenant = process.env.AZURE_AD_B2C_TENANT;
  const clientId = process.env.AZURE_AD_B2C_CLIENT_ID;

  if (!tenant || !clientId) {
    throw new AuthError("Azure AD B2C not configured");
  }

  if (!jwks) {
    const jwksUrl = new URL(
      `https://${tenant}.b2clogin.com/${tenant}.onmicrosoft.com/discovery/v2.0/keys`
    );
    jwks = createRemoteJWKSet(jwksUrl);
  }

  const { payload } = await jwtVerify(token, jwks, {
    issuer: `https://${tenant}.b2clogin.com/${tenant}.onmicrosoft.com/v2.0/`,
    audience: clientId,
  });

  const externalId = payload.oid as string | undefined;
  if (!externalId) {
    throw new AuthError("Token missing oid claim");
  }

  const email = (payload.emails as string[] | undefined)?.[0]
    || (payload.email as string | undefined);

  context.log(`Auth B2C: oid=${externalId}`);

  const userId = await getOrCreateUser(externalId, email);

  return { userId, externalId, email, role: "user" };
}

/**
 * Upsert a user by external_id. Returns the local user_id.
 */
async function getOrCreateUser(
  externalId: string,
  email?: string
): Promise<number> {
  const result = await query<{ user_id: number }>(
    `INSERT INTO app_user (external_id, email, handle)
     VALUES ($1, $2, $3)
     ON CONFLICT (external_id) DO UPDATE SET email = COALESCE(EXCLUDED.email, app_user.email)
     RETURNING user_id`,
    [externalId, email || null, email || externalId]
  );
  return result.rows[0].user_id;
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
