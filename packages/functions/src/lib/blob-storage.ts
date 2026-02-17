import { createHash, createHmac } from "node:crypto";

const AZURE_STORAGE_API_VERSION = "2023-11-03";
const DEFAULT_SOURCE_IMAGE_CONTAINER = "source-images";
const REQUEST_TIMEOUT_MS = 20000;

interface StorageAccountConfig {
  accountName: string;
  accountKey?: Buffer;
  sasToken?: string;
  blobEndpoint: string;
}

export interface UploadedBlobImage {
  storageUrl: string;
  checksumSha256: string;
  contentType: string;
  sizeBytes: number;
  imageBase64DataUri: string;
}

interface UploadSourceImageOptions {
  sourceImageUrl: string;
  source: string;
  externalId: string;
}

function asNonEmpty(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseStorageConnectionString(raw: string): StorageAccountConfig {
  if (raw.trim().toLowerCase() === "usedevelopmentstorage=true") {
    throw new Error("UseDevelopmentStorage=true is not supported for source image uploads");
  }

  const parts = raw.split(";").map((segment) => segment.trim()).filter(Boolean);
  const map = new Map<string, string>();
  for (const part of parts) {
    const separator = part.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = part.slice(0, separator);
    const value = part.slice(separator + 1);
    map.set(key, value);
  }

  const accountName = asNonEmpty(map.get("AccountName") || undefined);
  if (!accountName) {
    throw new Error("AZURE_STORAGE_CONNECTION is missing AccountName");
  }

  const endpointProtocol = asNonEmpty(map.get("DefaultEndpointsProtocol") || undefined) || "https";
  const endpointSuffix = asNonEmpty(map.get("EndpointSuffix") || undefined) || "core.windows.net";
  const blobEndpoint =
    asNonEmpty(map.get("BlobEndpoint") || undefined) ||
    `${endpointProtocol}://${accountName}.blob.${endpointSuffix}`;

  const accountKeyRaw = asNonEmpty(map.get("AccountKey") || undefined);
  const sasTokenRaw = asNonEmpty(map.get("SharedAccessSignature") || undefined);

  if (!accountKeyRaw && !sasTokenRaw) {
    throw new Error("AZURE_STORAGE_CONNECTION must include AccountKey or SharedAccessSignature");
  }

  return {
    accountName,
    accountKey: accountKeyRaw ? Buffer.from(accountKeyRaw, "base64") : undefined,
    sasToken: sasTokenRaw || undefined,
    blobEndpoint: blobEndpoint.replace(/\/+$/, ""),
  };
}

function mergeSas(url: URL, sasToken?: string): URL {
  if (!sasToken) {
    return url;
  }
  const token = sasToken.startsWith("?") ? sasToken.slice(1) : sasToken;
  const merged = new URL(url.toString());
  const params = new URLSearchParams(token);
  for (const [key, value] of params.entries()) {
    if (!merged.searchParams.has(key)) {
      merged.searchParams.append(key, value);
    }
  }
  return merged;
}

function canonicalizedHeaders(headers: Record<string, string>): string {
  const entries = Object.entries(headers)
    .map(([key, value]) => [key.toLowerCase(), value.replace(/\s+/g, " ").trim()] as const)
    .filter(([key]) => key.startsWith("x-ms-"))
    .sort(([a], [b]) => a.localeCompare(b));

  if (entries.length === 0) {
    return "";
  }

  return `${entries.map(([key, value]) => `${key}:${value}`).join("\n")}\n`;
}

function canonicalizedResource(accountName: string, url: URL): string {
  let result = `/${accountName}${decodeURIComponent(url.pathname)}`;

  const query = new Map<string, string[]>();
  for (const [key, value] of url.searchParams.entries()) {
    const lowerKey = key.toLowerCase();
    const bucket = query.get(lowerKey) || [];
    bucket.push(value);
    query.set(lowerKey, bucket);
  }

  const keys = [...query.keys()].sort((a, b) => a.localeCompare(b));
  for (const key of keys) {
    const values = (query.get(key) || []).sort((a, b) => a.localeCompare(b));
    result += `\n${key}:${values.join(",")}`;
  }

  return result;
}

function authorizationHeader(
  method: string,
  accountName: string,
  accountKey: Buffer,
  url: URL,
  headers: Record<string, string>
): string {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
  const contentLengthRaw = lower["content-length"] || "";
  const contentLength =
    contentLengthRaw === "0" || contentLengthRaw === "" ? "" : contentLengthRaw;

  const stringToSign = [
    method.toUpperCase(),
    lower["content-encoding"] || "",
    lower["content-language"] || "",
    contentLength,
    lower["content-md5"] || "",
    lower["content-type"] || "",
    lower.date || "",
    lower["if-modified-since"] || "",
    lower["if-match"] || "",
    lower["if-none-match"] || "",
    lower["if-unmodified-since"] || "",
    lower.range || "",
    canonicalizedHeaders(headers) + canonicalizedResource(accountName, url),
  ].join("\n");

  const signature = createHmac("sha256", accountKey).update(stringToSign, "utf8").digest("base64");
  return `SharedKey ${accountName}:${signature}`;
}

async function runWithTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

async function sendStorageRequest(
  config: StorageAccountConfig,
  method: "PUT" | "GET",
  url: URL,
  headers: Record<string, string>,
  body?: Buffer
): Promise<Response> {
  const finalizedUrl = mergeSas(url, config.sasToken);
  const requestHeaders: Record<string, string> = {
    ...headers,
    "x-ms-date": new Date().toUTCString(),
    "x-ms-version": AZURE_STORAGE_API_VERSION,
  };

  if (!config.sasToken) {
    if (!config.accountKey) {
      throw new Error("Account key missing for storage request");
    }
    requestHeaders.Authorization = authorizationHeader(
      method,
      config.accountName,
      config.accountKey,
      finalizedUrl,
      requestHeaders
    );
  }

  const requestBody = body ? new Uint8Array(body) : undefined;

  const response = await runWithTimeout(
    fetch(finalizedUrl.toString(), {
      method,
      headers: requestHeaders,
      body: requestBody,
    }),
    REQUEST_TIMEOUT_MS,
    "Azure Blob Storage request"
  );

  return response;
}

function normalizeContainerName(value: string | undefined): string {
  const fallback = DEFAULT_SOURCE_IMAGE_CONTAINER;
  const normalized = (value || fallback).trim().toLowerCase();
  return normalized.length > 0 ? normalized : fallback;
}

function inferExtension(contentType: string, sourceUrl: string): string {
  if (contentType.includes("png")) return "png";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("gif")) return "gif";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpg";

  const path = new URL(sourceUrl).pathname;
  const dot = path.lastIndexOf(".");
  if (dot >= 0 && dot < path.length - 1) {
    const ext = path.slice(dot + 1).toLowerCase();
    if (/^[a-z0-9]{2,5}$/.test(ext)) {
      return ext;
    }
  }
  return "jpg";
}

function buildBlobName(source: string, externalId: string, checksumSha256: string, extension: string): string {
  const safeSource = source.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const safeExternal = externalId.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return `${safeSource}/${safeExternal}-${checksumSha256.slice(0, 12)}.${extension}`;
}

function encodeBlobPath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function parseStorageUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Invalid blob storage URL");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Unsupported blob storage URL protocol");
  }

  return parsed;
}

function assertStorageHostMatches(config: StorageAccountConfig, storageUrl: URL): void {
  const configuredHost = new URL(config.blobEndpoint).host.toLowerCase();
  const storageHost = storageUrl.host.toLowerCase();

  if (configuredHost !== storageHost) {
    throw new Error(`Blob storage URL host mismatch: expected ${configuredHost}, got ${storageHost}`);
  }
}

export interface ReadBlobResult {
  bytes: Buffer;
  contentType: string;
  cacheControl: string | null;
  etag: string | null;
  lastModified: string | null;
}

export class BlobReadError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "BlobReadError";
  }
}

export async function readBlobFromStorageUrl(storageUrl: string): Promise<ReadBlobResult> {
  const connectionString = asNonEmpty(process.env.AZURE_STORAGE_CONNECTION);
  if (!connectionString) {
    throw new Error("AZURE_STORAGE_CONNECTION is required for source image reads");
  }

  const config = parseStorageConnectionString(connectionString);
  const parsedStorageUrl = parseStorageUrl(storageUrl);
  assertStorageHostMatches(config, parsedStorageUrl);

  const response = await sendStorageRequest(config, "GET", parsedStorageUrl, {});
  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new BlobReadError(
      `Blob read failed: ${response.status} ${response.statusText} ${details}`.trim(),
      response.status
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  const bytes = Buffer.from(arrayBuffer);
  if (bytes.length === 0) {
    throw new Error("Blob read returned empty body");
  }

  return {
    bytes,
    contentType: response.headers.get("content-type") || "application/octet-stream",
    cacheControl: response.headers.get("cache-control"),
    etag: response.headers.get("etag"),
    lastModified: response.headers.get("last-modified"),
  };
}

export async function uploadSourceImageToBlob(params: UploadSourceImageOptions): Promise<UploadedBlobImage> {
  console.log(`[blob-storage] Downloading image from ${params.sourceImageUrl}`);
  const sourceResponse = await runWithTimeout(
    fetch(params.sourceImageUrl, {
      method: "GET",
      headers: { "User-Agent": "SwatchWatch/source-image-ingestion" },
    }),
    REQUEST_TIMEOUT_MS,
    "Source image download"
  );

  if (!sourceResponse.ok) {
    throw new Error(
      `Failed to download source image: ${sourceResponse.status} ${sourceResponse.statusText}`
    );
  }

  const contentType = sourceResponse.headers.get("content-type") || "image/jpeg";
  const arrayBuffer = await sourceResponse.arrayBuffer();
  const bytes = Buffer.from(arrayBuffer);
  if (bytes.length === 0) {
    throw new Error("Source image download returned empty body");
  }

  const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
  const imageBase64DataUri = `data:${contentType};base64,${bytes.toString("base64")}`;
  const connectionString = asNonEmpty(process.env.AZURE_STORAGE_CONNECTION);

  // If storage isn't configured (e.g., local dev), fall back to the source URL so we can still
  // associate images with records and run AI detection using the downloaded bytes.
  if (!connectionString) {
    console.warn("[blob-storage] AZURE_STORAGE_CONNECTION not configured; using source image URL directly");
    return {
      storageUrl: params.sourceImageUrl,
      checksumSha256,
      contentType,
      sizeBytes: bytes.length,
      imageBase64DataUri,
    };
  }

  const config = parseStorageConnectionString(connectionString);
  const containerName = normalizeContainerName(process.env.SOURCE_IMAGE_CONTAINER);
  const extension = inferExtension(contentType, params.sourceImageUrl);
  const blobName = buildBlobName(params.source, params.externalId, checksumSha256, extension);

  console.log(`[blob-storage] Image downloaded: ${bytes.length} bytes, checksum=${checksumSha256}, extension=${extension}`);

  const containerUrl = new URL(`${config.blobEndpoint}/${containerName}`);
  console.log(`[blob-storage] Ensuring container exists: ${containerName}`);
  const createContainerResponse = await sendStorageRequest(
    config,
    "PUT",
    new URL(`${containerUrl.toString()}?restype=container`),
    {
      "Content-Length": "0",
    }
  );
  if (![201, 202, 409].includes(createContainerResponse.status)) {
    const details = await createContainerResponse.text().catch(() => "");
    throw new Error(
      `Failed to ensure blob container '${containerName}': ${createContainerResponse.status} ${details}`
    );
  }

  const blobUrl = new URL(`${containerUrl.toString()}/${encodeBlobPath(blobName)}`);
  console.log(`[blob-storage] Uploading blob: ${blobName}`);
  const uploadResponse = await sendStorageRequest(
    config,
    "PUT",
    blobUrl,
    {
      "Content-Type": contentType,
      "Content-Length": String(bytes.length),
      "x-ms-blob-type": "BlockBlob",
    },
    bytes
  );

  if (uploadResponse.status !== 201) {
    const details = await uploadResponse.text().catch(() => "");
    throw new Error(`Blob upload failed: ${uploadResponse.status} ${details}`);
  }

  console.log(`[blob-storage] Blob uploaded successfully: ${blobUrl.toString()}`);

  return {
    storageUrl: blobUrl.toString(),
    checksumSha256,
    contentType,
    sizeBytes: bytes.length,
    imageBase64DataUri,
  };
}
