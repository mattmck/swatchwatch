const IMAGE_PROXY_ROUTE_PREFIX = "/api/images/";

function toBase64Url(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(input: string): string {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + "=".repeat(padding);
  return Buffer.from(padded, "base64").toString("utf8");
}

export function toImageProxyUrl(requestUrl: string, sourceImageUrl: string): string {
  const origin = new URL(requestUrl).origin;
  return `${origin}${IMAGE_PROXY_ROUTE_PREFIX}${toBase64Url(sourceImageUrl)}`;
}

export function decodeImageProxyId(id: string): string {
  const decoded = fromBase64Url(id);
  const parsed = new URL(decoded);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Invalid proxied image URL protocol");
  }
  return parsed.toString();
}

