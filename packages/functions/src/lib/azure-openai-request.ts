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

/** `AZURE_OPENAI_REASONING_DEPLOYMENTS`: comma list of deployment names, lower-cased. */
export function parseReasoningDeploymentList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0);
}

/**
 * True when the deployment serves a reasoning model: its name starts with `gpt-5`, `o1`, `o3` or
 * `o4` (any case), or it is listed in `AZURE_OPENAI_REASONING_DEPLOYMENTS` for names that do not
 * reveal the model.
 */
export function isReasoningDeployment(deployment: string | null | undefined, env: Env = process.env): boolean {
  const name = deployment?.trim().toLowerCase();
  if (!name) return false;
  if (REASONING_DEPLOYMENT_PREFIXES.some((prefix) => name.startsWith(prefix))) return true;
  return parseReasoningDeploymentList(env.AZURE_OPENAI_REASONING_DEPLOYMENTS).includes(name);
}

/** `AZURE_OPENAI_REASONING_EFFORT` (trimmed, any case); unset or unknown → `minimal`. */
export function resolveReasoningEffort(env: Env = process.env): ReasoningEffort {
  const raw = env.AZURE_OPENAI_REASONING_EFFORT?.trim().toLowerCase();
  return (REASONING_EFFORTS as readonly string[]).includes(raw ?? "")
    ? (raw as ReasoningEffort)
    : DEFAULT_REASONING_EFFORT;
}

/**
 * The `reasoning_effort` to send, or null to omit it. `minimal` is gpt-5 only: the o-series
 * accept `low` / `medium` / `high`, so `minimal` becomes `low` there, and `o1-preview` /
 * `o1-mini` take no `reasoning_effort` at all. A deployment known only from
 * `AZURE_OPENAI_REASONING_DEPLOYMENTS` is treated like gpt-5 (the configured value as is).
 */
export function reasoningEffortForDeployment(
  deployment: string | null | undefined,
  env: Env = process.env
): ReasoningEffort | null {
  const name = deployment?.trim().toLowerCase() ?? "";
  if (/^o1-(preview|mini)/.test(name)) return null;
  const effort = resolveReasoningEffort(env);
  if (/^o[134]/.test(name) && effort === "minimal") return "low";
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
