export const PRECACHE_ROUTES: string[];
export const PRECACHE_FILES: string[];
export const MAX_PRECACHE_FILE_BYTES: number;
export function isExcluded(urlPath: string): boolean;
export function extractStaticAssetUrls(html: string): string[];
export function listFiles(dir: string, base?: string): string[];
export function buildPrecache(outDir: string): { urls: string[]; version: string; skipped: string[] };
