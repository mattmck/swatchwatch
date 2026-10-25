import { Platform } from "react-native";

/**
 * Runtime configuration from `EXPO_PUBLIC_*` variables (`apps/mobile/.env.local`, see
 * `.env.example`). Expo inlines them at bundle time, so each must be read as a literal
 * `process.env.EXPO_PUBLIC_…` expression (no dynamic lookups).
 */

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * The Android emulator reaches the host machine at 10.0.2.2, not localhost; the iOS
 * simulator shares the host's network, so localhost works there as-is.
 */
export function resolveApiBaseUrl(raw: string | undefined, os: string = Platform.OS): string {
  const url = (clean(raw) ?? "http://localhost:7071/api").replace(/\/+$/, "");
  if (os === "android") {
    return url.replace(/^(https?:\/\/)(localhost|127\.0\.0\.1)(?=[:/]|$)/, "$110.0.2.2");
  }
  return url;
}

export const API_BASE_URL = resolveApiBaseUrl(process.env.EXPO_PUBLIC_API_URL);

/** Entra External ID (CIAM) or legacy Azure AD B2C settings, mirroring `NEXT_PUBLIC_B2C_*`. */
export interface EntraSettings {
  tenant: string;
  tenantId?: string;
  clientId: string;
  policy?: string;
  apiScope?: string;
}

export const ENTRA_SETTINGS: Partial<EntraSettings> = {
  tenant: clean(process.env.EXPO_PUBLIC_B2C_TENANT),
  tenantId: clean(process.env.EXPO_PUBLIC_B2C_TENANT_ID),
  clientId: clean(process.env.EXPO_PUBLIC_B2C_CLIENT_ID),
  policy: clean(process.env.EXPO_PUBLIC_B2C_SIGNUP_SIGNIN_POLICY),
  apiScope: clean(process.env.EXPO_PUBLIC_B2C_API_SCOPE),
};

export type AuthMode = "dev-bypass" | "entra" | "unconfigured";

/**
 * The same three modes as the web (`apps/web/src/lib/api.ts` / `auth-provider.tsx`):
 * - `dev-bypass`: `Authorization: Bearer dev:<userId>` against a local Functions host with
 *   `AUTH_DEV_BYPASS=true`. On when `EXPO_PUBLIC_AUTH_DEV_BYPASS=true`, and by default in a
 *   development build that has no sign-in settings (so a fresh checkout just works).
 * - `entra`: interactive sign-in (authorization code + PKCE) against the External ID tenant.
 * - `unconfigured`: neither; the sign-in screen explains what is missing.
 */
export function resolveAuthMode(input: {
  devBypass: string | undefined;
  entra: Partial<EntraSettings>;
  isDev: boolean;
}): AuthMode {
  const flag = clean(input.devBypass)?.toLowerCase();
  if (flag === "true") return "dev-bypass";
  if (isEntraConfigured(input.entra)) return "entra";
  if (flag === undefined && input.isDev) return "dev-bypass";
  return "unconfigured";
}

/** Legacy B2C user flows are named `B2C_1_…` and live in the authority path. */
export function isLegacyB2CPolicy(policy: string | undefined): boolean {
  return Boolean(policy && /^B2C_1/i.test(policy));
}

/**
 * External ID needs the tenant GUID (the authority is keyed on it, like the web's MSAL
 * config); legacy B2C needs a `B2C_1_…` policy instead.
 */
export function isEntraConfigured(entra: Partial<EntraSettings>): entra is EntraSettings {
  if (!entra.tenant || !entra.clientId) return false;
  return isLegacyB2CPolicy(entra.policy) || Boolean(entra.tenantId);
}

export const AUTH_MODE: AuthMode = resolveAuthMode({
  devBypass: process.env.EXPO_PUBLIC_AUTH_DEV_BYPASS,
  entra: ENTRA_SETTINGS,
  isDev: typeof __DEV__ !== "undefined" ? __DEV__ : false,
});

/** Dev-bypass user id (`Bearer dev:<id>`); the web uses `1` for normal calls. */
export const DEV_USER_ID = clean(process.env.EXPO_PUBLIC_AUTH_DEV_USER_ID) ?? "1";
