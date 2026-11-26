/**
 * Model-specific chat-completions body fields for Azure OpenAI.
 *
 * gpt-4o / gpt-4.1 deployments take `max_tokens` and any `temperature`. The gpt-5 family and the
 * o-series reasoning models reject both: they need `max_completion_tokens` (which also counts the
 * model's hidden reasoning tokens) and accept only the default temperature, plus an optional
 * `reasoning_effort`. Every request builder keeps writing `max_tokens` / `temperature` as its
 * intent; `applyChatCompletionModelParams` rewrites them once the deployment is known (sync
 * requests in `requestAzureOpenAIChatCompletion`, batch JSONL lines, the direct-fetch callers).
 * Non-reasoning deployments get the payload back unchanged.
 */

export const REASONING_EFFORTS = ["minimal", "low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** Short vision picks need little thinking; `minimal` keeps latency and reasoning tokens low. */
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "minimal";

/** Reasoning tokens count against `max_completion_tokens`: cap = max(this × intended, the floor). */
export const REASONING_MAX_TOKENS_MULTIPLIER = 4;
export const REASONING_MIN_MAX_COMPLETION_TOKENS = 1024;

/**
 * Chat-completions `api-version` for reasoning deployments: older versions (the
 * `2024-05-01-preview` / `2024-06-01` the gpt-4o calls pin) reject `max_completion_tokens` and
 * `reasoning_effort` as unrecognized arguments. gpt-4o / gpt-4.1 calls keep their own version.
 */
export const REASONING_CHAT_API_VERSION = "2025-04-01-preview";

/** `api-version` for a chat-completions call to `deployment`: reasoning → `REASONING_CHAT_API_VERSION`. */
export function chatCompletionsApiVersion(
  deployment: string | null | undefined,
  defaultVersion: string,
  env: Env = process.env
): string {
  return isReasoningDeployment(deployment, env) ? REASONING_CHAT_API_VERSION : defaultVersion;
}

/** Deployment-name prefixes that reveal a reasoning model (case-insensitive). */
const REASONING_DEPLOYMENT_PREFIXES = ["gpt-5", "o1", "o3", "o4"];

type Env = NodeJS.ProcessEnv | Record<string, string | undefined>;

function parseDeploymentEntries(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0);
}

/** Splits a listed entry `alias=model` into its deployment name and model (null without `=`). */
function splitAliasEntry(entry: string): { name: string; model: string | null } {
  const eq = entry.indexOf("=");
  if (eq < 0) return { name: entry, model: null };
  const model = entry.slice(eq + 1).trim();
  return { name: entry.slice(0, eq).trim(), model: model || null };
}

/** `AZURE_OPENAI_REASONING_DEPLOYMENTS`: the listed (reasoning) deployment names, lower-cased. */
export function parseReasoningDeploymentList(raw: string | undefined): string[] {
  return parseDeploymentEntries(raw)
    .filter((entry) => !entry.startsWith("!"))
    .map((entry) => splitAliasEntry(entry).name)
    .filter((name) => name.length > 0);
}

/**
 * The model a listed alias serves (`alias=model`, e.g. `vision-prod=o3-mini`), lower-cased, or
 * null when the deployment is not listed with a model. Used only for the effort rules.
 */
export function reasoningAliasModel(deployment: string | null | undefined, env: Env = process.env): string | null {
  const name = deployment?.trim().toLowerCase();
  if (!name) return null;
  for (const entry of parseDeploymentEntries(env.AZURE_OPENAI_REASONING_DEPLOYMENTS)) {
    if (entry.startsWith("!")) continue;
    const alias = splitAliasEntry(entry);
    if (alias.name === name) return alias.model;
  }
  return null;
}

/** `AZURE_OPENAI_REASONING_DEPLOYMENTS` entries written `!name`: forced non-reasoning, lower-cased. */
export function parseNonReasoningDeploymentList(raw: string | undefined): string[] {
  return parseDeploymentEntries(raw)
    .filter((name) => name.startsWith("!"))
    .map((name) => name.slice(1).trim())
    .filter((name) => name.length > 0);
}

/**
 * True when the deployment serves a reasoning model: it is listed in
 * `AZURE_OPENAI_REASONING_DEPLOYMENTS` (for names that do not reveal the model), or its name
 * starts with `gpt-5`, `o1`, `o3` or `o4` (any case) and the list does not exclude it with
 * `!name` (for a non-reasoning deployment whose name happens to match, e.g. `o3-vision-4o`).
 */
export function isReasoningDeployment(deployment: string | null | undefined, env: Env = process.env): boolean {
  const name = deployment?.trim().toLowerCase();
  if (!name) return false;
  const raw = env.AZURE_OPENAI_REASONING_DEPLOYMENTS;
  if (parseNonReasoningDeploymentList(raw).includes(name)) return false;
  if (parseReasoningDeploymentList(raw).includes(name)) return true;
  return REASONING_DEPLOYMENT_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** `AZURE_OPENAI_REASONING_EFFORT` (trimmed, any case); unset or unknown → `minimal`. */
export function resolveReasoningEffort(env: Env = process.env): ReasoningEffort {
  const raw = env.AZURE_OPENAI_REASONING_EFFORT?.trim().toLowerCase();
  return (REASONING_EFFORTS as readonly string[]).includes(raw ?? "")
    ? (raw as ReasoningEffort)
    : DEFAULT_REASONING_EFFORT;
}

/**
 * The `reasoning_effort` to send, or null to omit it. `minimal` is original-gpt-5 only: the
 * o-series and gpt-5.1+ accept `low` / `medium` / `high`, so `minimal` becomes `low` there, and
 * `o1-preview` / `o1-mini` take no `reasoning_effort` at all. The rules read the model name: the
 * deployment name, or for an `alias=model` entry in `AZURE_OPENAI_REASONING_DEPLOYMENTS` the
 * model it names. A bare alias (no `=model`) is treated like gpt-5 (the configured value as is).
 */
export function reasoningEffortForDeployment(
  deployment: string | null | undefined,
  env: Env = process.env
): ReasoningEffort | null {
  const name = reasoningAliasModel(deployment, env) ?? deployment?.trim().toLowerCase() ?? "";
  if (/^o1-(preview|mini)/.test(name)) return null;
  const effort = resolveReasoningEffort(env);
  // `minimal` exists only on the original gpt-5 models: the o-series and gpt-5.1+ (`gpt-5.1`,
  // `gpt-5.2-…`) reject it, so they get `low`. Explicit low/medium/high pass through.
  if (effort === "minimal" && (/^o[134]/.test(name) || /^gpt-5\.\d/.test(name))) return "low";
  return effort;
}

/** The `max_completion_tokens` cap for a call that would send `max_tokens: maxTokens` to gpt-4o. */
export function reasoningMaxCompletionTokens(maxTokens: number): number {
  const base = Number.isFinite(maxTokens) && maxTokens > 0 ? Math.ceil(maxTokens) : 0;
  return Math.max(REASONING_MIN_MAX_COMPLETION_TOKENS, base * REASONING_MAX_TOKENS_MULTIPLIER);
}

export interface ChatCompletionModelParamsInput {
  /** What the caller would send as `max_tokens` to a gpt-4o / gpt-4.1 deployment. */
  maxTokens: number;
  /** Intended sampling temperature; omitted → no `temperature` field. */
  temperature?: number;
}

export interface ChatCompletionModelParams {
  /** Body fields to merge into the request. */
  fields: Record<string, unknown>;
  reasoning: boolean;
  /**
   * A non-zero temperature the caller asked for that a reasoning model cannot take (dropped).
   * `0`, the production default, is dropped silently because it carries no intent.
   */
  droppedTemperature: number | null;
}

/**
 * Token / sampling body fields for one deployment. Reasoning models: `max_completion_tokens`
 * (scaled, see `reasoningMaxCompletionTokens`), `reasoning_effort`, no `temperature`.
 * Everything else: `max_tokens` and `temperature` exactly as given.
 */
export function chatCompletionModelParams(
  deployment: string | null | undefined,
  input: ChatCompletionModelParamsInput,
  env: Env = process.env
): ChatCompletionModelParams {
  const hasTemperature = typeof input.temperature === "number";
  if (!isReasoningDeployment(deployment, env)) {
    return {
      fields: {
        ...(hasTemperature ? { temperature: input.temperature } : {}),
        max_tokens: input.maxTokens,
      },
      reasoning: false,
      droppedTemperature: null,
    };
  }
  const effort = reasoningEffortForDeployment(deployment, env);
  return {
    fields: {
      max_completion_tokens: reasoningMaxCompletionTokens(input.maxTokens),
      ...(effort ? { reasoning_effort: effort } : {}),
    },
    reasoning: true,
    droppedTemperature: hasTemperature && input.temperature !== 0 ? (input.temperature as number) : null,
  };
}

export interface AppliedChatCompletionPayload<T> {
  payload: T | Record<string, unknown>;
  reasoning: boolean;
  droppedTemperature: number | null;
}

/**
 * Rewrites a request body written for gpt-4o (`max_tokens`, `temperature`) for `deployment`.
 * Non-reasoning deployments and non-object payloads come back as the same object; a reasoning
 * deployment gets a copy without `max_tokens` / `temperature` and with the fields from
 * `chatCompletionModelParams`. Field order is kept otherwise (tokens fields go first).
 */
export function applyChatCompletionModelParams<T>(
  payload: T,
  deployment: string | null | undefined,
  env: Env = process.env
): AppliedChatCompletionPayload<T> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !isReasoningDeployment(deployment, env)) {
    return { payload, reasoning: false, droppedTemperature: null };
  }
  const { max_tokens: maxTokens, temperature, ...rest } = payload as Record<string, unknown>;
  const params = chatCompletionModelParams(
    deployment,
    {
      maxTokens: typeof maxTokens === "number" ? maxTokens : 0,
      ...(typeof temperature === "number" ? { temperature } : {}),
    },
    env
  );
  return {
    payload: { ...params.fields, ...rest },
    reasoning: true,
    droppedTemperature: params.droppedTemperature,
  };
}

/** One-line warning for a temperature a reasoning deployment cannot take. */
export function droppedTemperatureWarning(deployment: string, temperature: number): string {
  return `[azure-openai] Deployment "${deployment}" is a reasoning model; temperature ${temperature} dropped (only the default is supported)`;
}

const warnedDroppedTemperatures = new Set<string>();

/**
 * Logs `droppedTemperatureWarning` once per deployment + temperature per process (an eval run
 * or a label-OCR worker would otherwise repeat it on every call). Returns true when it logged.
 * Goes to `console.warn` directly so callers that silence per-call logs still see it.
 */
export function warnDroppedTemperatureOnce(
  deployment: string,
  temperature: number,
  warn: (message: string) => void = (message) => console.warn(message)
): boolean {
  const key = `${deployment.trim().toLowerCase()}|${temperature}`;
  if (warnedDroppedTemperatures.has(key)) return false;
  warnedDroppedTemperatures.add(key);
  warn(droppedTemperatureWarning(deployment, temperature));
  return true;
}
