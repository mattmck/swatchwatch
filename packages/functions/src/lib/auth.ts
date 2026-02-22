import { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { createRemoteJWKSet, jwtVerify } from "jose";
import * as stytch from "stytch";
import { query, transaction } from "./db";

type AuthProvider = "auth0" | "stytch";

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
 * - **Production**: validates token with configured identity provider
 *   (Auth0 or Stytch), then resolves the local user by linked identity.
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

  const provider = resolveAuthProvider();
  if (provider === "auth0") {
    return handleAuth0Token(token, context);
  }
  return handleStytchToken(token, context);
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
let stytchClient: stytch.Client | null = null;

function getStytchClient(): stytch.Client {
  const projectId = process.env.STYTCH_PROJECT_ID;
  const secret = process.env.STYTCH_SECRET;

  if (!projectId || !secret) {
    throw new AuthError("Stytch not configured");
  }

  if (!stytchClient) {
    stytchClient = new stytch.Client({
      project_id: projectId,
      secret,
    });
  }

  return stytchClient;
}

function resolveAuthProvider(): AuthProvider {
  const configured = process.env.AUTH_PROVIDER?.trim().toLowerCase();
  const hasAuth0 = Boolean(process.env.AUTH0_DOMAIN && process.env.AUTH0_AUDIENCE);
  const hasStytch = Boolean(process.env.STYTCH_PROJECT_ID && process.env.STYTCH_SECRET);

  if (configured) {
    if (configured !== "auth0" && configured !== "stytch") {
      throw new AuthError("AUTH_PROVIDER must be either 'auth0' or 'stytch'");
    }
    if (configured === "auth0" && !hasAuth0) {
      throw new AuthError("Auth0 not configured");
    }
    if (configured === "stytch" && !hasStytch) {
      throw new AuthError("Stytch not configured");
    }
    return configured;
  }

  if (hasAuth0 && hasStytch) {
    throw new AuthError("Both Auth0 and Stytch are configured. Set AUTH_PROVIDER to select one.");
  }
  if (hasAuth0) {
    return "auth0";
  }
  if (hasStytch) {
    return "stytch";
  }

  throw new AuthError("No auth provider configured");
}

async function handleAuth0Token(
  token: string,
  context: InvocationContext
): Promise<AuthResult> {
  const domain = process.env.AUTH0_DOMAIN;
  const audience = process.env.AUTH0_AUDIENCE;
  const issuerBaseUrl = (process.env.AUTH0_ISSUER_BASE_URL || (domain ? `https://${domain}/` : ""))
    .replace(/([^/])$/, "$1/");

  if (!domain || !audience || !issuerBaseUrl) {
    throw new AuthError("Auth0 not configured");
  }

  if (!jwks) {
    const jwksUrl = new URL(".well-known/jwks.json", issuerBaseUrl);
    jwks = createRemoteJWKSet(jwksUrl);
  }

  const { payload } = await jwtVerify(token, jwks, {
    issuer: issuerBaseUrl,
    audience,
  });

  const externalId = payload.sub as string | undefined;
  if (!externalId) {
    throw new AuthError("Token missing sub claim");
  }

  const email = payload.email as string | undefined;
  const emailVerified = payload.email_verified === true;

  context.log(`Auth auth0: sub=${externalId}`);

  const userId = await getOrCreateUserFromIdentity({
    provider: "auth0",
    providerUserId: externalId,
    email,
    emailVerified,
  });

  return { userId, externalId, email, role: "user" };
}

/**
 * Validate a Stytch session JWT and resolve local identity.
 */
async function handleStytchToken(
  token: string,
  context: InvocationContext
): Promise<AuthResult> {
  const client = getStytchClient();

  const { session } = await client.sessions.authenticateJwt({
    session_jwt: token,
  });

  const user = await client.users.get({ user_id: session.user_id });
  const verifiedEmail = user.emails.find((entry) => entry.verified)?.email;
  const fallbackEmail = user.emails[0]?.email;
  const email = verifiedEmail || fallbackEmail;
  const emailVerified = Boolean(verifiedEmail);

  context.log(`Auth stytch: user_id=${session.user_id}`);

  const userId = await getOrCreateUserFromIdentity({
    provider: "stytch",
    providerUserId: session.user_id,
    email,
    emailVerified,
  });

  return { userId, externalId: session.user_id, email, role: "user" };
}

interface IdentityInput {
  provider: AuthProvider;
  providerUserId: string;
  email?: string;
  emailVerified: boolean;
}

/**
 * Resolve or create one local app_user row for an external identity.
 *
 * Resolution order:
 * 1) existing provider identity
 * 2) verified email match
 * 3) create new local user
 */
async function getOrCreateUserFromIdentity(identity: IdentityInput): Promise<number> {
  return transaction(async (client) => {
    const existingIdentity = await client.query<{ user_id: number }>(
      `SELECT user_id
       FROM user_identity
       WHERE provider = $1 AND provider_user_id = $2
       LIMIT 1`,
      [identity.provider, identity.providerUserId]
    );

    if (existingIdentity.rows.length > 0) {
      const existingUserId = existingIdentity.rows[0].user_id;
      await client.query(
        `UPDATE user_identity
         SET email_at_provider = COALESCE($3, email_at_provider),
             email_verified = (email_verified OR $4),
             updated_at = now()
         WHERE provider = $1 AND provider_user_id = $2`,
        [
          identity.provider,
          identity.providerUserId,
          identity.email || null,
          identity.emailVerified,
        ]
      );
      if (identity.email) {
        await client.query(
          `UPDATE app_user
           SET email = COALESCE(email, $2)
           WHERE user_id = $1`,
          [existingUserId, identity.email]
        );
      }
      return existingUserId;
    }

    let userId: number | null = null;

    if (identity.email && identity.emailVerified) {
      const existingByEmail = await client.query<{ user_id: number }>(
        `SELECT user_id
         FROM app_user
         WHERE lower(email) = lower($1)
         LIMIT 1`,
        [identity.email]
      );
      if (existingByEmail.rows.length > 0) {
        userId = existingByEmail.rows[0].user_id;
      }
    }

    if (!userId) {
      const fallbackExternalId = `${identity.provider}:${identity.providerUserId}`;
      const createdUser = await client.query<{ user_id: number }>(
        `INSERT INTO app_user (external_id, email, handle)
         VALUES ($1, $2, $3)
         RETURNING user_id`,
        [
          fallbackExternalId,
          identity.email || null,
          identity.email || fallbackExternalId,
        ]
      );
      userId = createdUser.rows[0].user_id;
    } else if (identity.email) {
      await client.query(
        `UPDATE app_user
         SET email = COALESCE(email, $2)
         WHERE user_id = $1`,
        [userId, identity.email]
      );
    }

    await client.query(
      `INSERT INTO user_identity (
         user_id, provider, provider_user_id, email_at_provider, email_verified
       ) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (provider, provider_user_id) DO UPDATE
       SET user_id = EXCLUDED.user_id,
           email_at_provider = COALESCE(EXCLUDED.email_at_provider, user_identity.email_at_provider),
           email_verified = (user_identity.email_verified OR EXCLUDED.email_verified),
           updated_at = now()`,
      [
        userId,
        identity.provider,
        identity.providerUserId,
        identity.email || null,
        identity.emailVerified,
      ]
    );

    return userId;
  });
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
