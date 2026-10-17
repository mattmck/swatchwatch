import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import {
  findDupes,
  prepareDupeCandidates,
  prepareDupeShade,
  resolvePolishFinishes,
  summarizeDupes,
  type PolishDupeHint,
  type PolishDupesBatchResponse,
  type PolishDupesResponse,
} from "swatchwatch-shared";
import { withAuth } from "../lib/auth";
import { withCors } from "../lib/http";
import { internalServerError } from "../lib/errors";
import { trackEvent } from "../lib/telemetry";
import {
  DupesInputError,
  loadOwnedDupeShades,
  loadVisibleDupeTargets,
  parseDupesBatchRequest,
  parseDupesLimit,
  parseShadeId,
} from "../lib/dupes";

/**
 * Dupe finder (issue #265): the caller's owned shades that are likely dupes of a shade.
 *
 * Grading (shared `findDupes`, documented in packages/shared/src/color/dupes.ts): OKLAB distance
 * between display hexes graded with the match-image HIGH/MEDIUM thresholds, then a finish rule
 * (a clearly different finish family drops the grade one step). Only HIGH/MEDIUM are returned.
 *
 * Cost: one query for the target(s) and one for the caller's owned shades; the OKLAB scan is
 * O(N) per target in TypeScript (N = owned shades with a hex, a few thousand at most).
 */

/** GET /api/polishes/{id}/dupes?limit= — dupes of one shade among the caller's owned shades. */
export async function getPolishDupes(
  request: HttpRequest,
  context: InvocationContext,
  userId: number
): Promise<HttpResponseInit> {
  const shadeId = parseShadeId(request.params.id);
  if (shadeId === null) {
    return { status: 400, jsonBody: { error: "Invalid polish id" } };
  }

  let limit: number;
  try {
    limit = parseDupesLimit(new URL(request.url).searchParams.get("limit"));
  } catch (error) {
    if (error instanceof DupesInputError) {
      return { status: 400, jsonBody: { error: error.message } };
    }
    throw error;
  }

  try {
    const [targets, owned] = await Promise.all([
      loadVisibleDupeTargets(userId, [shadeId]),
      loadOwnedDupeShades(userId),
    ]);
    const targetRow = targets.find((row) => String(row.shadeId) === String(shadeId));
    if (!targetRow) {
      return { status: 404, jsonBody: { error: "Polish not found" } };
    }

    const candidates = prepareDupeCandidates(owned);
    const target = prepareDupeShade(targetRow);
    const targetId = String(shadeId);

    if (!target) {
      const body: PolishDupesResponse = {
        target: {
          shadeId: targetId,
          displayHex: null,
          displayHexSource: "none",
          finishes: resolvePolishFinishes(targetRow),
        },
        dupes: [],
        dupeCount: 0,
        highCount: 0,
        candidateCount: candidates.filter((candidate) => candidate.shadeId !== targetId).length,
      };
      return { status: 200, jsonBody: body };
    }

    const { dupes, candidateCount } = findDupes(target, candidates);
    const summary = summarizeDupes(targetId, dupes);
    const body: PolishDupesResponse = {
      target: {
        shadeId: target.shadeId,
        displayHex: target.displayHex,
        displayHexSource: target.displayHexSource,
        finishes: target.finishes,
      },
      dupes: dupes.slice(0, limit),
      dupeCount: summary.dupeCount,
      highCount: summary.highCount,
      candidateCount,
    };

    trackEvent("polish.dupes", {
      userId,
      candidateCount,
      dupeCount: summary.dupeCount,
      highCount: summary.highCount,
    });
    return { status: 200, jsonBody: body };
  } catch (error: unknown) {
    return internalServerError(context, error, "Failed to find dupes", "polishes.dupes");
  }
}

/** POST /api/polishes/dupes — best owned dupe per shade, for list-row hints without N+1 calls. */
export async function batchPolishDupes(
  request: HttpRequest,
  context: InvocationContext,
  userId: number
): Promise<HttpResponseInit> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { status: 400, jsonBody: { error: "Request body must be valid JSON" } };
  }

  let shadeIds: number[];
  try {
    shadeIds = parseDupesBatchRequest(body);
  } catch (error) {
    if (error instanceof DupesInputError) {
      return { status: 400, jsonBody: { error: error.message } };
    }
    throw error;
  }

  if (shadeIds.length === 0) {
    const empty: PolishDupesBatchResponse = { results: {}, candidateCount: 0 };
    return { status: 200, jsonBody: empty };
  }

  try {
    const [targets, owned] = await Promise.all([
      loadVisibleDupeTargets(userId, shadeIds),
      loadOwnedDupeShades(userId),
    ]);
    const candidates = prepareDupeCandidates(owned);

    const results: Record<string, PolishDupeHint> = {};
    for (const row of targets) {
      const shadeId = String(row.shadeId);
      const target = prepareDupeShade(row);
      results[shadeId] = target
        ? summarizeDupes(shadeId, findDupes(target, candidates).dupes)
        : { shadeId, best: null, dupeCount: 0, highCount: 0 };
    }

    trackEvent("polish.dupes_batch", {
      userId,
      requested: shadeIds.length,
      resolved: targets.length,
      candidateCount: candidates.length,
      withDupes: Object.values(results).filter((hint) => hint.best !== null).length,
    });

    const responseBody: PolishDupesBatchResponse = { results, candidateCount: candidates.length };
    return { status: 200, jsonBody: responseBody };
  } catch (error: unknown) {
    return internalServerError(context, error, "Failed to find dupes", "polishes.dupes-batch");
  }
}

app.http("polishes-dupes", {
  methods: ["GET", "OPTIONS"],
  authLevel: "anonymous",
  route: "polishes/{id}/dupes",
  handler: withCors(withAuth(getPolishDupes)),
});

app.http("polishes-dupes-batch", {
  methods: ["POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "polishes/dupes",
  handler: withCors(withAuth(batchPolishDupes)),
});
