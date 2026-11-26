import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { FeatureFlagsResponse } from "swatchwatch-shared";
import { withCors } from "../lib/http";
import { listPublicFeatureFlags } from "../lib/feature-flags";
import { resolveAiReplayMode } from "../lib/ai-replay";

/**
 * Anonymous: public flags only (never the internal ones or env var names). `aiReplayMode` is added
 * only when a local host runs the AI record/replay harness (always off when hosted in Azure).
 */
async function getFeatureFlags(_request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  const aiReplayMode = resolveAiReplayMode();
  const body: FeatureFlagsResponse = {
    flags: listPublicFeatureFlags(),
    ...(aiReplayMode !== "off" ? { aiReplayMode } : {}),
  };
  return {
    status: 200,
    headers: { "Cache-Control": aiReplayMode !== "off" ? "no-store" : "public, max-age=60" },
    jsonBody: body,
  };
}

app.http("config-flags", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "config/flags",
  handler: withCors(getFeatureFlags),
});
