import { LogLevel, type Configuration } from "@azure/msal-browser";

/**
 * Build MSAL configuration from environment variables.
 * Returns null if B2C is not configured (dev bypass or unconfigured mode).
 * Returns null during server-side builds to avoid "window is not defined" errors.
 */
export function buildMsalConfig(): Configuration | null {
  // Skip during server-side rendering/builds
  if (typeof window === "undefined") {
    return null;
  }

  const tenant = process.env.NEXT_PUBLIC_B2C_TENANT;
  const clientId = process.env.NEXT_PUBLIC_B2C_CLIENT_ID;
  const policy =
    process.env.NEXT_PUBLIC_B2C_SIGNUP_SIGNIN_POLICY || "B2C_1_signupsignin";

  if (!tenant || !clientId) {
    return null;
  }

  return {
    auth: {
      clientId,
      authority: `https://${tenant}.b2clogin.com/${tenant}.onmicrosoft.com/${policy}`,
      knownAuthorities: [`${tenant}.b2clogin.com`],
      redirectUri: window.location.origin + "/",
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
