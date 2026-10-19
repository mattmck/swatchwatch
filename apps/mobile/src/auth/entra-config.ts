import { makeRedirectUri } from "expo-auth-session";
import { isLegacyB2CPolicy, type EntraSettings } from "@/config/env";

/**
 * Entra External ID / legacy B2C endpoints and scopes, built the same way as the web's
 * `apps/web/src/lib/msal-config.ts` so both clients get the same access token shape
 * (audience `api://<client-id>`, scope `access_as_user`) for `/api/auth/validate`.
 */

/** OIDC issuer; discovery is `<issuer>/.well-known/openid-configuration`. */
export function entraIssuer(settings: EntraSettings): string {
  if (isLegacyB2CPolicy(settings.policy)) {
    return `https://${settings.tenant}.b2clogin.com/${settings.tenant}.onmicrosoft.com/${settings.policy}/v2.0`;
  }
  // External ID metadata reports its issuer keyed on the tenant GUID, so the authority is too.
  return `https://${settings.tenantId}.ciamlogin.com/${settings.tenantId}/v2.0`;
}

/** CIAM user-flow selection (`p=`); legacy B2C carries the policy in the path instead. */
export function entraExtraParams(settings: EntraSettings): Record<string, string> | undefined {
  if (!settings.policy || isLegacyB2CPolicy(settings.policy)) return undefined;
  return { p: settings.policy };
}

export const LOGIN_SCOPES = ["openid", "profile", "offline_access"];

/** `EXPO_PUBLIC_B2C_API_SCOPE` (space-separated) or `api://<client-id>/access_as_user`. */
export function entraApiScopes(settings: Pick<EntraSettings, "clientId" | "apiScope">): string[] {
  if (settings.apiScope) return settings.apiScope.split(/\s+/).filter(Boolean);
  return [`api://${settings.clientId}/access_as_user`];
}

export function entraLoginScopes(settings: EntraSettings): string[] {
  return Array.from(new Set([...LOGIN_SCOPES, ...entraApiScopes(settings)]));
}

/**
 * Redirect URI for the native app: `swatchwatch://auth` in development and store builds
 * (the `scheme` in app.json). Register it in the tenant on the web app registration's
 * "Mobile and desktop applications" platform (see apps/mobile/README.md). Expo Go uses an
 * `exp://<lan-ip>:8081/--/auth` URI that changes per network, so sign-in needs a dev build.
 */
export function entraRedirectUri(): string {
  return makeRedirectUri({ scheme: "swatchwatch", path: "auth" });
}
