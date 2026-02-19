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

  return {
    auth: {
      clientId,
      authority: `https://${tenant}.b2clogin.com/${tenant}.onmicrosoft.com/${policy}`,
      knownAuthorities: [`${tenant}.b2clogin.com`],
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

/** Scopes used for login and token acquisition. */
export const LOGIN_SCOPES = ["openid", "profile", "offline_access"];
