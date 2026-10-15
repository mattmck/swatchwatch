/**
 * Runtime environment detection used to fail closed on dev-only features.
 *
 * `AUTH_DEV_BYPASS` (accepting `Bearer dev:<userId>` for any user, including admins) and the
 * image-proxy ephemeral signing key are strictly local-development conveniences. A deployed
 * Function App must never honour them, even if the app setting is accidentally flipped on, so
 * both are gated on {@link isDevBypassEnabled} rather than the raw env var.
 */
import { trackEvent } from "./telemetry";

type Env = Record<string, string | undefined>;

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function hostPart(value: string): string {
  const trimmed = value.trim().toLowerCase();
  // "[::1]:7071" → "[::1]"; "localhost:7071" → "localhost"; "app.azurewebsites.net" unchanged.
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end >= 0 ? trimmed.slice(0, end + 1) : trimmed;
  }
  return trimmed.split(":")[0];
}

/**
 * True when the process is running inside Azure App Service / Functions hosting.
 *
 * - `WEBSITE_INSTANCE_ID` is set by App Service on every hosted instance and never by Core Tools.
 * - `WEBSITE_HOSTNAME` is set when hosted, but Azure Functions Core Tools also sets it to
 *   `localhost:7071` locally, so loopback hosts do not count.
 * - `WEBSITE_SITE_NAME` is deliberately not used: it is not guaranteed to be absent under Core Tools,
 *   and `WEBSITE_HOSTNAME` already covers every hosted instance.
 */
export function isHostedInAzure(env: Env = process.env): boolean {
  if (env.WEBSITE_INSTANCE_ID?.trim()) return true;
  const hostname = env.WEBSITE_HOSTNAME?.trim();
  if (hostname && !LOCAL_HOSTNAMES.has(hostPart(hostname))) return true;
  return false;
}

/**
 * Dev bypass is enabled only when `AUTH_DEV_BYPASS === "true"` AND the process is not hosted in
 * Azure. There is intentionally no override that re-enables it in Azure (fail closed).
 */
export function isDevBypassEnabled(env: Env = process.env): boolean {
  return env.AUTH_DEV_BYPASS === "true" && !isHostedInAzure(env);
}

let refusalLogged = false;

/**
 * Log (once per process) and emit telemetry when `AUTH_DEV_BYPASS=true` was requested but refused
 * because the app is hosted in Azure. Safe to call on every request.
 */
export function reportDevBypassRefusedIfNeeded(env: Env = process.env): void {
  if (env.AUTH_DEV_BYPASS !== "true" || !isHostedInAzure(env) || refusalLogged) return;
  refusalLogged = true;
  console.error(
    "[auth] AUTH_DEV_BYPASS=true is set but this app is hosted in Azure; refusing to enable dev bypass. " +
      "Remove the AUTH_DEV_BYPASS app setting (or set it to false)."
  );
  trackEvent("auth.dev_bypass_refused", { reason: "hosted_in_azure" });
}

/** Test hook: forget that the refusal was already logged. */
export function resetRuntimeEnvStateForTests(): void {
  refusalLogged = false;
}
