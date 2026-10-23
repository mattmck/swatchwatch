export const SW_CACHE_PREFIX: string;
export const SW_FALLBACK_ROUTE: string;
export function normalizeRoutePath(pathname: string): string;
export interface SwRequestInfo {
  method: string;
  url: string;
  origin: string;
  mode?: string;
  hasAuthorization?: boolean;
  hasRange?: boolean;
}
export type SwRequestClass = "passthrough" | "precache" | "static" | "navigation";
export function classifyRequest(req: SwRequestInfo, precacheUrls: ReadonlySet<string>): SwRequestClass;
export function navigationFallback(pathname: string, precacheUrls: ReadonlySet<string>): string | null;
