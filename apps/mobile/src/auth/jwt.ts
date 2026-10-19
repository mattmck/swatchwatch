/** Decode a JWT payload for display only (never trusted: the API validates every token). */
export function decodeJwtPayload(token: string | undefined): Record<string, unknown> | null {
  const part = token?.split(".")[1];
  if (!part || typeof globalThis.atob !== "function") return null;
  try {
    const base64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const binary = globalThis.atob(base64);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    const json = new TextDecoder().decode(bytes);
    const payload = JSON.parse(json) as unknown;
    return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function claimString(claims: Record<string, unknown> | null, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = claims?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  }
  return undefined;
}
