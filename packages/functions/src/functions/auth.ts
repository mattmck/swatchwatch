import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";

interface TokenValidationResult {
  valid: boolean;
  userId?: string;
  email?: string;
  roles?: string[];
  error?: string;
}

async function validateToken(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log("POST /api/auth/validate - Validating auth token");

  const authHeader = request.headers.get("authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return {
      status: 401,
      jsonBody: {
        valid: false,
        error: "Missing or malformed Authorization header. Expected: Bearer <token>",
      } satisfies TokenValidationResult,
    };
  }

  const token = authHeader.substring(7);

  if (!token) {
    return {
      status: 401,
      jsonBody: {
        valid: false,
        error: "Empty token",
      } satisfies TokenValidationResult,
    };
  }

  try {
    // TODO: Validate JWT against Azure AD B2C
    // const tenant = process.env.AZURE_AD_B2C_TENANT;
    // const clientId = process.env.AZURE_AD_B2C_CLIENT_ID;
    //
    // Steps:
    // 1. Fetch JWKS from Azure AD B2C discovery endpoint
    // 2. Decode and verify the JWT signature
    // 3. Validate claims (issuer, audience, expiration)
    // 4. Extract user info from claims

    context.log("Token validation stub - returning placeholder response");

    const result: TokenValidationResult = {
      valid: false,
      error: "Token validation not yet implemented",
    };

    return {
      status: 501,
      jsonBody: result,
    };
  } catch {
    context.error("Token validation failed");
    return {
      status: 401,
      jsonBody: {
        valid: false,
        error: "Token validation failed",
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
  methods: ["POST"],
  authLevel: "anonymous",
  route: "auth/validate",
  handler: validateToken,
});

app.http("auth-config", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "auth/config",
  handler: getAuthConfig,
});
