/**
 * Record/replay harness for the outbound AI HTTP calls of the capture pipeline (Azure OpenAI chat
 * completions and Azure AI Document Intelligence `prebuilt-read`), so `npm run eval:bottle`, the
 * capture e2e tests and local reruns can run without Azure credentials or spend.
 *
 * `aiReplayFetch` is a drop-in for the global `fetch`, used by the AI call sites only
 * (`ai-color-detection.ts` for every chat completion — sticker read, glass pick, hex detection,
 * palette pick —, `ocr-parser.ts` for the label parse and `ocr.ts` for Document Intelligence).
 * The batch pipeline and vendor image downloads keep the global `fetch`.
 *
 * Modes (`AI_REPLAY_MODE`, see {@link resolveAiReplayMode}):
 * - `off` (default, and forced on a hosted Azure instance): plain pass-through.
 * - `record`: the real call is made and its response stored (overwriting an existing fixture), or,
 *   with `AI_REPLAY_RECORD_MISSING_ONLY=true`, a stored fixture is reused and only misses call out.
 * - `replay`: answered from the store only; a miss throws {@link AiReplayMissError} (and logs the
 *   key and request summary) — never a silent network fallback.
 *
 * Fixtures live under `AI_REPLAY_DIR` (default `packages/functions/eval/ai-replay`), one JSON file
 * per request key: `<service>/<sha256>.json`. The key is a sha256 over the canonical request
 * (method, URL path without host, query without credential parameters and sorted, JSON body with
 * keys sorted and every image payload replaced by `sha256:<hash of its bytes>`). Fixtures hold
 * that canonical request (no image bytes, only allowlisted headers) and the response; credential
 * headers (`api-key`, `Ocp-Apim-Subscription-Key`, `Authorization`) are never read into them.
 *
 * Document Intelligence is asynchronous (POST → 202 + `Operation-Location` → GET polls). In record
 * and replay mode the `Operation-Location` handed to the caller is a synthetic
 * `https://ai-replay.invalid/ai-replay/poll/<submitKey>` URL, so polls key deterministically; in
 * record mode the wrapper maps it back to the real one. Polls still `running`/`notStarted` are not
 * stored, so the stored poll is always the final one.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { isHostedInAzure } from "./runtime-env";

type Env = Record<string, string | undefined>;

export type AiReplayMode = "off" | "record" | "replay";

export const AI_REPLAY_FIXTURE_VERSION = 1;

/** Default store root: `packages/functions/eval/ai-replay` (same depth from `src/lib` and `dist/lib`). */
export const DEFAULT_AI_REPLAY_DIR = path.resolve(__dirname, "..", "..", "eval", "ai-replay");

/** Host of the synthetic Document Intelligence poll URLs (`.invalid` never resolves). */
export const AI_REPLAY_POLL_ORIGIN = "https://ai-replay.invalid";
const POLL_PATH_PREFIX = "/ai-replay/poll/";

/** Query parameters that may carry credentials; never part of a key or a fixture. */
const SECRET_QUERY_PARAMS = new Set([
  "api-key",
  "apikey",
  "key",
  "code",
  "sig",
  "token",
  "access_token",
  "subscription-key",
  "ocp-apim-subscription-key",
]);

/** The only request headers written to a fixture (and part of the key). */
const REQUEST_HEADER_ALLOWLIST = ["content-type"];
/** The only response headers written to a fixture. */
const RESPONSE_HEADER_ALLOWLIST = ["content-type", "operation-location"];

/** A base64 string this long without a `data:` prefix is treated as image bytes (e.g. `base64Source`). */
const BARE_BASE64_MIN_LENGTH = 256;
const BARE_BASE64_PATTERN = /^[A-Za-z0-9+/=\r\n]+$/;
const DATA_URI_PATTERN = /^data:([^;,]*)(;[^,]*)?;base64,/i;

// ── Mode ─────────────────────────────────────────────────────────────────────

let hostedRefusalLogged = false;

function parseRequestedMode(env: Env): AiReplayMode {
  const raw = env.AI_REPLAY_MODE?.trim().toLowerCase();
  if (raw === "record" || raw === "replay") return raw;
  return "off";
}

/**
 * The effective mode. Anything other than `record` / `replay` (any case) is `off`. On a hosted
 * Azure instance (`isHostedInAzure`) the mode is always `off` and the refusal is logged once:
 * like `AUTH_DEV_BYPASS`, there is no override (fail closed).
 */
export function resolveAiReplayMode(env: Env = process.env): AiReplayMode {
  const requested = parseRequestedMode(env);
  if (requested === "off") return "off";
  if (isHostedInAzure(env)) {
    if (!hostedRefusalLogged) {
      hostedRefusalLogged = true;
      console.warn(
        `[ai-replay] AI_REPLAY_MODE=${requested} is set but this app is hosted in Azure; forcing it off. ` +
          "Remove the AI_REPLAY_MODE app setting."
      );
    }
    return "off";
  }
  return requested;
}

export function resolveAiReplayDir(env: Env = process.env): string {
  const configured = env.AI_REPLAY_DIR?.trim();
  return configured ? path.resolve(configured) : DEFAULT_AI_REPLAY_DIR;
}

function recordMissingOnly(env: Env): boolean {
  return env.AI_REPLAY_RECORD_MISSING_ONLY?.trim().toLowerCase() === "true";
}

// ── Canonical request + key ──────────────────────────────────────────────────

export type AiReplayService = "azure-openai" | "document-intelligence" | "other";

export interface CanonicalAiRequest {
  method: string;
  path: string;
  /** Sorted `[name, value]` pairs, credential parameters removed. */
  query: Array<[string, string]>;
  headers: Record<string, string>;
  /** JSON body with sorted keys and hashed image payloads, raw text, or null. */
  body: unknown;
}

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function hashImageString(value: string): string | null {
  const dataUri = DATA_URI_PATTERN.exec(value);
  if (dataUri) {
    return `sha256:${sha256Hex(Buffer.from(value.slice(dataUri[0].length), "base64"))}`;
  }
  if (value.length >= BARE_BASE64_MIN_LENGTH && BARE_BASE64_PATTERN.test(value)) {
    return `sha256:${sha256Hex(Buffer.from(value, "base64"))}`;
  }
  return null;
}

/** Sort object keys recursively and replace image payloads by `sha256:<hash of bytes>`. */
export function canonicalizeJsonValue(value: unknown): unknown {
  if (typeof value === "string") return hashImageString(value) ?? value;
  if (Array.isArray(value)) return value.map(canonicalizeJsonValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalizeJsonValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function headerValue(headers: RequestInit["headers"], name: string): string | null {
  if (!headers) return null;
  const lower = name.toLowerCase();
  if (headers instanceof Headers) return headers.get(lower);
  if (Array.isArray(headers)) {
    const entry = headers.find(([k]) => k.toLowerCase() === lower);
    return entry ? entry[1] : null;
  }
  for (const [k, v] of Object.entries(headers as Record<string, string>)) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
}

function bodyText(body: RequestInit["body"]): string | null {
  if (body === undefined || body === null) return null;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (Buffer.isBuffer(body)) return body.toString("utf8");
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString("utf8");
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("utf8");
  throw new Error("[ai-replay] unsupported request body type (string, Buffer or ArrayBuffer only)");
}

export function canonicalizeAiRequest(url: string, init: RequestInit = {}): CanonicalAiRequest {
  const parsed = new URL(url);
  const query = [...parsed.searchParams.entries()]
    .filter(([name]) => !SECRET_QUERY_PARAMS.has(name.toLowerCase()))
    .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  const headers: Record<string, string> = {};
  for (const name of REQUEST_HEADER_ALLOWLIST) {
    const value = headerValue(init.headers, name);
    if (value !== null) headers[name] = value.trim().toLowerCase();
  }
  const text = bodyText(init.body);
  let body: unknown = null;
  if (text !== null) {
    try {
      body = canonicalizeJsonValue(JSON.parse(text));
    } catch {
      body = hashImageString(text) ?? text;
    }
  }
  return {
    method: (init.method ?? "GET").toUpperCase(),
    path: parsed.pathname.replace(/\/{2,}/g, "/"),
    query,
    headers,
    body,
  };
}

export function aiReplayKey(request: CanonicalAiRequest): string {
  return sha256Hex(JSON.stringify(request));
}

export function classifyAiService(requestPath: string): AiReplayService {
  if (requestPath.startsWith("/openai/")) return "azure-openai";
  if (requestPath.startsWith("/documentintelligence/") || requestPath.startsWith(POLL_PATH_PREFIX)) {
    return "document-intelligence";
  }
  return "other";
}

function deploymentFromPath(requestPath: string): string | null {
  const match = /^\/openai\/deployments\/([^/]+)\//.exec(requestPath);
  return match ? decodeURIComponent(match[1]) : null;
}

/** A short, secret-free description of a request for logs and miss errors. */
export function describeAiRequest(request: CanonicalAiRequest): string {
  const query = request.query.map(([k, v]) => `${k}=${v}`).join("&");
  const body = request.body as Record<string, unknown> | null;
  const parts = [`${request.method} ${request.path}${query ? `?${query}` : ""}`];
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const messages = Array.isArray(body.messages) ? body.messages : null;
    if (messages) parts.push(`${messages.length} messages`);
    const model = body.model;
    if (typeof model === "string") parts.push(`model=${model}`);
    if (typeof body.base64Source === "string") parts.push(`image=${body.base64Source}`);
    if (typeof body.urlSource === "string") parts.push(`url=${body.urlSource}`);
  }
  return parts.join(", ");
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

export interface AiReplayFixture {
  version: number;
  key: string;
  service: AiReplayService;
  recordedAt: string;
  /** Azure OpenAI deployment from the request path (null for other services). */
  deployment: string | null;
  /** `model` reported by the response body, when there is one. */
  model: string | null;
  request: CanonicalAiRequest;
  response: {
    status: number;
    headers: Record<string, string>;
    /** Parsed JSON body, or null when `bodyText` holds it. */
    bodyJson: unknown;
    bodyText: string | null;
  };
}

export class AiReplayMissError extends Error {
  readonly key: string;
  readonly summary: string;
  constructor(key: string, summary: string, file: string) {
    super(
      `[ai-replay] no recorded response for ${summary} (key ${key}, expected ${file}). ` +
        "Record it with AI_REPLAY_MODE=record (Azure credentials needed)."
    );
    this.name = "AiReplayMissError";
    this.key = key;
    this.summary = summary;
  }
}

export function isAiReplayMissError(error: unknown): error is AiReplayMissError {
  return error instanceof AiReplayMissError;
}

export function fixturePath(dir: string, service: AiReplayService, key: string): string {
  return path.join(dir, service, `${key}.json`);
}

function readFixture(file: string): AiReplayFixture | null {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as AiReplayFixture;
}

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

function responseFromFixture(fixture: AiReplayFixture): Response {
  const { status, headers, bodyJson, bodyText: text } = fixture.response;
  const body = NULL_BODY_STATUSES.has(status) ? null : text ?? JSON.stringify(bodyJson);
  return new Response(body, { status, headers });
}

function pollUrlFor(submitKey: string): string {
  return `${AI_REPLAY_POLL_ORIGIN}${POLL_PATH_PREFIX}${submitKey}`;
}

/** Synthetic poll URL → real `Operation-Location`, learned while recording (this process only). */
const recordedPollTargets = new Map<string, string>();

function isPendingPoll(method: string, bodyJson: unknown): boolean {
  if (method !== "GET" || !bodyJson || typeof bodyJson !== "object") return false;
  const status = (bodyJson as { status?: unknown }).status;
  return status === "running" || status === "notStarted";
}

async function recordResponse(
  real: Response,
  request: CanonicalAiRequest,
  key: string,
  service: AiReplayService,
  file: string
): Promise<Response> {
  const text = NULL_BODY_STATUSES.has(real.status) ? "" : await real.text();
  const headers: Record<string, string> = {};
  for (const name of RESPONSE_HEADER_ALLOWLIST) {
    const value = real.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  const operationLocation = headers["operation-location"];
  if (operationLocation) {
    const synthetic = pollUrlFor(key);
    recordedPollTargets.set(synthetic, operationLocation);
    headers["operation-location"] = synthetic;
  }

  let bodyJson: unknown = null;
  let storedText: string | null = text;
  if (text && (headers["content-type"] ?? "").includes("json")) {
    try {
      bodyJson = JSON.parse(text);
      storedText = null;
    } catch {
      bodyJson = null;
    }
  }

  if (!isPendingPoll(request.method, bodyJson)) {
    const model =
      bodyJson && typeof bodyJson === "object" && typeof (bodyJson as { model?: unknown }).model === "string"
        ? (bodyJson as { model: string }).model
        : null;
    const fixture: AiReplayFixture = {
      version: AI_REPLAY_FIXTURE_VERSION,
      key,
      service,
      recordedAt: new Date().toISOString(),
      deployment: deploymentFromPath(request.path),
      model,
      request,
      response: { status: real.status, headers, bodyJson, bodyText: storedText },
    };
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
  }

  return new Response(NULL_BODY_STATUSES.has(real.status) ? null : text, { status: real.status, headers });
}

/** Test hook: forget the hosted-refusal log and the recorded poll targets. */
export function resetAiReplayStateForTests(): void {
  hostedRefusalLogged = false;
  recordedPollTargets.clear();
}

export interface AiReplayFetchOptions {
  env?: Env;
  /** The real fetch (defaults to the global one); injectable for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * `fetch`-compatible wrapper for the AI call sites. `url` must be a string (all call sites build
 * one). Off mode calls the real fetch untouched.
 */
export async function aiReplayFetch(
  url: string,
  init: RequestInit = {},
  options: AiReplayFetchOptions = {}
): Promise<Response> {
  const env = options.env ?? process.env;
  const realFetch = options.fetchImpl ?? fetch;
  const mode = resolveAiReplayMode(env);
  if (mode === "off") return realFetch(url, init);

  const request = canonicalizeAiRequest(url, init);
  const key = aiReplayKey(request);
  const service = classifyAiService(request.path);
  const file = fixturePath(resolveAiReplayDir(env), service, key);

  if (mode === "replay" || recordMissingOnly(env)) {
    const fixture = readFixture(file);
    if (fixture) return responseFromFixture(fixture);
    if (mode === "replay") {
      const error = new AiReplayMissError(key, describeAiRequest(request), file);
      console.error(error.message);
      throw error;
    }
  }

  // record: a synthetic poll URL goes to the real Operation-Location learned at submit time.
  let target = url;
  if (url.startsWith(`${AI_REPLAY_POLL_ORIGIN}${POLL_PATH_PREFIX}`)) {
    const real = recordedPollTargets.get(url);
    if (!real) {
      const error = new AiReplayMissError(key, `${describeAiRequest(request)} (poll of a submit not recorded in this process)`, file);
      console.error(error.message);
      throw error;
    }
    target = real;
  }
  const response = await realFetch(target, init);
  return recordResponse(response, request, key, service, file);
}
