import type { HttpResponseInit, InvocationContext } from "@azure/functions";
import { trackException } from "./telemetry";

/**
 * Build a generic 500 response for an unexpected error.
 *
 * The full error is logged server-side (`context.error`) and reported to telemetry; the client
 * only receives the generic `message` plus a `requestId` (the function invocation id) that
 * support can use to find the logged error. Internal error text (Postgres messages, stack
 * traces, upstream service responses) is never included in the response body.
 */
export function internalServerError(
  context: InvocationContext,
  error: unknown,
  message: string,
  handler: string,
  properties?: Record<string, unknown>
): HttpResponseInit {
  context.error(`[${handler}] ${message}:`, error);
  trackException(error, { handler, invocationId: context.invocationId, ...properties });
  return {
    status: 500,
    jsonBody: { error: message, requestId: context.invocationId },
  };
}
