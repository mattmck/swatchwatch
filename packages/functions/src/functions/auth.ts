import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { authenticateRequest, AuthError } from "../lib/auth";

interface TokenValidationResult {
  valid: boolean;
  userId?: number;
  email?: string;
  error?: string;
}

type AuthProvider = "auth0" | "stytch";

interface Auth0FrontendConfig {
  issuerBaseUrl: string;
  audience: string;
  clientId?: string;
}

interface StytchFrontendConfig {
  projectId: string;
  publicToken?: string;
}

interface AuthConfigResponse {
  provider: AuthProvider;
  auth0?: Auth0FrontendConfig;
  stytch?: StytchFrontendConfig;
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
      } satisfies TokenValidationResult,
    };
  } catch (error) {
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

  const configuredProvider = process.env.AUTH_PROVIDER?.trim().toLowerCase();
  const hasAuth0 = Boolean(process.env.AUTH0_DOMAIN && process.env.AUTH0_AUDIENCE);
  const hasStytch = Boolean(process.env.STYTCH_PROJECT_ID);

  let provider: AuthProvider | null = null;

  if (configuredProvider) {
    if (configuredProvider !== "auth0" && configuredProvider !== "stytch") {
      return {
        status: 503,
        jsonBody: { error: "Invalid AUTH_PROVIDER. Expected 'auth0' or 'stytch'" },
      };
    }
    provider = configuredProvider;
  } else if (hasAuth0 && !hasStytch) {
    provider = "auth0";
  } else if (hasStytch && !hasAuth0) {
    provider = "stytch";
  }

  if (!provider) {
    return {
      status: 503,
      jsonBody: { error: "Auth configuration not available" },
    };
  }

  if (provider === "auth0") {
    const domain = process.env.AUTH0_DOMAIN || "";
    const audience = process.env.AUTH0_AUDIENCE || "";
    const issuerBaseUrl = (process.env.AUTH0_ISSUER_BASE_URL || (domain ? `https://${domain}/` : ""))
      .replace(/([^/])$/, "$1/");
    const clientId = process.env.AUTH0_CLIENT_ID;

    if (!domain || !audience || !issuerBaseUrl) {
      return {
        status: 503,
        jsonBody: { error: "Auth0 configuration not available" },
      };
    }

    return {
      status: 200,
      jsonBody: {
        provider: "auth0",
        auth0: {
          issuerBaseUrl,
          audience,
          clientId,
        },
      } satisfies AuthConfigResponse,
    };
  }

  const projectId = process.env.STYTCH_PROJECT_ID || "";
  const publicToken = process.env.STYTCH_PUBLIC_TOKEN;

  if (!projectId) {
    return {
      status: 503,
      jsonBody: { error: "Stytch configuration not available" },
    };
  }

  return {
    status: 200,
    jsonBody: {
      provider: "stytch",
      stytch: {
        projectId,
        publicToken,
      },
    } satisfies AuthConfigResponse,
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
