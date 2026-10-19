import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { AccountSuspendedError, authenticateRequest, AuthError } from "../lib/auth";
import { withCors } from "../lib/http";

interface TokenValidationResult {
  valid: boolean;
  userId?: number;
  email?: string;
  role?: string;
  error?: string;
  /** `account_suspended` when an admin suspended the account (issue #45; status 403). */
  code?: string;
}

async function validateToken(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log("POST /api/auth/validate - Validating auth token");

  try {
    const auth = await authenticateRequest(request, context);

    return {
      status: 200,
      jsonBody: {
        valid: true,
        userId: auth.userId,
        email: auth.email,
        role: auth.role,
      } satisfies TokenValidationResult,
    };
  } catch (error) {
    if (error instanceof AccountSuspendedError) {
      return {
        status: 403,
        jsonBody: {
          valid: false,
          error: error.message,
          code: error.code,
        } satisfies TokenValidationResult,
      };
    }
    const message = error instanceof AuthError
      ? error.message
      : "Token validation failed";

    return {
      status: 401,
      jsonBody: {
        valid: false,
        error: message,
      } satisfies TokenValidationResult,
    };
  }
}

async function getAuthConfig(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log("GET /api/auth/config - Returning auth configuration");

  // Return non-sensitive auth configuration for the frontend
  const tenant = process.env.AZURE_AD_B2C_TENANT || "";
  const clientId = process.env.AZURE_AD_B2C_CLIENT_ID || "";

  if (!tenant || !clientId) {
    return {
      status: 503,
      jsonBody: { error: "Auth configuration not available" },
    };
  }

  return {
    status: 200,
    jsonBody: {
      authority: `https://${tenant}.b2clogin.com/${tenant}.onmicrosoft.com`,
      clientId,
      knownAuthorities: [`${tenant}.b2clogin.com`],
    },
  };
}

app.http("auth-validate", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "auth/validate",
  handler: withCors(validateToken),
});

app.http("auth-config", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "auth/config",
  handler: withCors(getAuthConfig),
});
