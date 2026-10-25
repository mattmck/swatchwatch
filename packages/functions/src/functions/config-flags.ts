import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { FeatureFlagsResponse } from "swatchwatch-shared";
import { withCors } from "../lib/http";
import { listPublicFeatureFlags } from "../lib/feature-flags";

/** Anonymous: public flags only (never the internal ones or env var names). */
async function getFeatureFlags(_request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  const body: FeatureFlagsResponse = { flags: listPublicFeatureFlags() };
  return {
    status: 200,
    headers: { "Cache-Control": "public, max-age=60" },
    jsonBody: body,
  };
}

app.http("config-flags", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "config/flags",
  handler: withCors(getFeatureFlags),
});
