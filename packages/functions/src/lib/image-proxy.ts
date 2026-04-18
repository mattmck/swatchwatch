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

export function encodeImageProxyId(sourceImageUrl: string): string {
  const parsed = new URL(sourceImageUrl);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Invalid proxied image URL protocol");
  }
  return toBase64Url(parsed.toString());
}

export function toImageProxyUrlFromOrigin(origin: string, sourceImageUrl: string): string {
  const parsedOrigin = new URL(origin);
  if (!["http:", "https:"].includes(parsedOrigin.protocol)) {
    throw new Error("Invalid image proxy origin protocol");
  }
  const normalizedOrigin = `${parsedOrigin.protocol}//${parsedOrigin.host}`;
  return `${normalizedOrigin}${IMAGE_PROXY_ROUTE_PREFIX}${encodeImageProxyId(sourceImageUrl)}`;
}

export function toImageProxyUrl(requestUrl: string, sourceImageUrl: string): string {
  const origin = new URL(requestUrl).origin;
  return toImageProxyUrlFromOrigin(origin, sourceImageUrl);
}

export function decodeImageProxyId(id: string): string {
  const decoded = fromBase64Url(id);
  const parsed = new URL(decoded);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Invalid proxied image URL protocol");
  }
  return parsed.toString();
}
