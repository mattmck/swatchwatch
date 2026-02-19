import { LogLevel, type Configuration } from "@azure/msal-browser";

/**
 * Build MSAL configuration from environment variables.
 * Returns null if B2C is not configured (no env vars).
 * Only safe to call on the client side (has access to window).
 */
export function buildMsalConfig(): Configuration | null {
  const tenant = process.env.NEXT_PUBLIC_B2C_TENANT;
  const clientId = process.env.NEXT_PUBLIC_B2C_CLIENT_ID;
  const policy =
    process.env.NEXT_PUBLIC_B2C_SIGNUP_SIGNIN_POLICY || "B2C_1_signupsignin";

  if (!tenant || !clientId) {
    return null;
  }

  // Use a fixed redirect URI during build time, actual URI on client
  const redirectUri =
    typeof window !== "undefined" ? window.location.origin + "/" : "/";

  // External ID (CIAM) tenants use ciamlogin.com without a policy segment.
  // Legacy Azure AD B2C uses b2clogin.com with policy in the authority path.
  const isLegacyB2CPolicy = isLegacyB2CPolicyName(policy);
  const authorityHost = isLegacyB2CPolicy
    ? `${tenant}.b2clogin.com`
    : `${tenant}.ciamlogin.com`;
  const authority = isLegacyB2CPolicy
    ? `https://${authorityHost}/${tenant}.onmicrosoft.com/${policy}`
    : `https://${authorityHost}/${tenant}.onmicrosoft.com`;

  return {
    auth: {
      clientId,
      authority,
      knownAuthorities: [authorityHost],
      redirectUri,
    },
    cache: {
      cacheLocation: "localStorage",
    },
    system: {
      loggerOptions: {
        loggerCallback: (level: LogLevel, message: string) => {
          if (level === LogLevel.Error || level === LogLevel.Warning) {
            console.warn(`[MSAL] ${message}`);
          }
        },
      },
    },
  };
}

function isLegacyB2CPolicyName(policy: string): boolean {
  return /^B2C_1/i.test(policy);
}

/**
 * Additional query params for CIAM user-flow selection.
 * Legacy B2C encodes policy in authority path and doesn't use `p`.
 */
export function buildPolicyQueryParameters(): Record<string, string> | undefined {
  const policy =
    process.env.NEXT_PUBLIC_B2C_SIGNUP_SIGNIN_POLICY || "B2C_1_signupsignin";

  if (isLegacyB2CPolicyName(policy)) {
    return undefined;
  }

  return { p: policy };
}

/** Scopes used for login and token acquisition. */
export const LOGIN_SCOPES = ["openid", "profile", "offline_access"];

/**
 * API scopes requested for backend calls.
 *
 * Priority:
 * 1. Explicit `NEXT_PUBLIC_B2C_API_SCOPE` (space-delimited list supported)
 * 2. Default to `api://<client-id>/access_as_user`
 */
export function buildApiTokenScopes(): string[] {
  const configuredApiScopes = process.env.NEXT_PUBLIC_B2C_API_SCOPE?.trim();
  if (configuredApiScopes) {
    return configuredApiScopes.split(/\s+/).filter(Boolean);
  }

  const clientId = process.env.NEXT_PUBLIC_B2C_CLIENT_ID;
  if (!clientId) {
    return [];
  }

  return [`api://${clientId}/access_as_user`];
}

/** Full interactive login scopes (OIDC + API). */
export function buildLoginRequestScopes(): string[] {
  return Array.from(new Set([...LOGIN_SCOPES, ...buildApiTokenScopes()]));
}
