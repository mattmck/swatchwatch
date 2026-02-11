import { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";

type HttpHandler = (request: HttpRequest, context: InvocationContext) => Promise<HttpResponseInit>;

const DEFAULT_ALLOWED_ORIGINS = ["http://localhost:3000", "https://*.azurestaticapps.net"];
const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? DEFAULT_ALLOWED_ORIGINS.join(","))
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const ALLOW_HEADERS = process.env.CORS_ALLOWED_HEADERS ?? "Content-Type, Authorization";
const ALLOW_METHODS = process.env.CORS_ALLOWED_METHODS ?? "GET,POST,PUT,DELETE,OPTIONS";
const SUPPORT_CREDENTIALS = process.env.CORS_SUPPORT_CREDENTIALS === "true";

function originMatches(origin: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.includes("*")) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`^${escaped.replace(/\*/g, ".*")}$`, "i");
    return regex.test(origin);
  }
  return origin === pattern;
}

function resolveAllowedOrigin(origin: string | null): string | null {
  if (!origin) return null;
  for (const pattern of allowedOrigins) {
    if (originMatches(origin, pattern)) {
      return pattern === "*" ? "*" : origin;
    }
  }
  return allowedOrigins.includes("*") ? "*" : null;
}

function applyCorsHeaders(headers: Headers, allowedOrigin: string) {
  headers.set("Access-Control-Allow-Origin", allowedOrigin);
  headers.set("Access-Control-Allow-Headers", ALLOW_HEADERS);
  headers.set("Access-Control-Allow-Methods", ALLOW_METHODS);
  headers.set("Vary", "Origin");
  if (SUPPORT_CREDENTIALS && allowedOrigin !== "*") {
    headers.set("Access-Control-Allow-Credentials", "true");
  }
}

export function withCors(handler: HttpHandler): HttpHandler {
  return async (request, context) => {
    const origin = request.headers.get("origin");
    const allowedOrigin = resolveAllowedOrigin(origin);

    if (request.method?.toUpperCase() === "OPTIONS") {
      if (!allowedOrigin) {
        return { status: 204 };
      }
      const headers = new Headers();
      applyCorsHeaders(headers, allowedOrigin);
      return { status: 204, headers };
    }

    const response = await handler(request, context);
    if (!allowedOrigin) return response;

    const headers = new Headers(response.headers ?? {});
    applyCorsHeaders(headers, allowedOrigin);
    return { ...response, headers };
  };
}

export type { HttpHandler };
