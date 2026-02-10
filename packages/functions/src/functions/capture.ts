import { randomUUID } from "node:crypto";
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import {
  CaptureAnswerRequest,
  CaptureAnswerResponse,
  CaptureFinalizeResponse,
  CaptureFrameRequest,
  CaptureFrameResponse,
  CaptureQuestion,
  CaptureStartRequest,
  CaptureStartResponse,
  CaptureStatus,
  CaptureStatusResponse,
} from "swatchwatch-shared";
import { query, transaction } from "../lib/db";
import { withAuth } from "../lib/auth";

const GUIDANCE_CONFIG = {
  recommendedFrameTypes: ["barcode", "label", "color"],
  maxFrames: 6,
} as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface CaptureSessionRow {
  id: number;
  captureId: string;
  status: CaptureStatus;
  topConfidence: string | number | null;
  acceptedEntityType: "shade" | "sku" | null;
  acceptedEntityId: string | null;
  metadata: Record<string, unknown> | null;
}

interface CaptureQuestionRow {
  id: string;
  key: string;
  prompt: string;
  type: CaptureQuestion["type"];
  options: unknown;
  status: CaptureQuestion["status"];
  createdAt: string;
}

interface CaptureFrameEvidenceRow {
  frameType: "barcode" | "label" | "color" | "other";
  quality: Record<string, unknown> | null;
}

interface CaptureEvidence {
  gtin?: string;
  brand?: string;
  shadeName?: string;
  finish?: string;
}

interface CaptureMatchCandidate {
  entityType: "shade" | "sku";
  entityId: number;
  display: string;
  confidence: number;
}

interface CaptureQuestionSpec {
  key: string;
  prompt: string;
  type: CaptureQuestion["type"];
  options?: string[];
}

type ResolverOutcome =
  | {
      status: "matched";
      confidence: number;
      entityType: "shade" | "sku";
      entityId: number;
      metadataPatch: Record<string, unknown>;
    }
  | {
      status: "needs_question";
      confidence: number;
      question: CaptureQuestionSpec;
      metadataPatch: Record<string, unknown>;
    }
  | {
      status: "unmatched";
      confidence: number;
      metadataPatch: Record<string, unknown>;
    };

function isValidUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function parseNumeric(value: string | number | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toCaptureQuestion(row: CaptureQuestionRow | undefined): CaptureQuestion | undefined {
  if (!row) return undefined;

  return {
    id: row.id,
    key: row.key,
    prompt: row.prompt,
    type: row.type,
    options: Array.isArray(row.options) ? row.options.filter((v): v is string => typeof v === "string") : undefined,
    status: row.status,
    createdAt: row.createdAt,
  };
}

function getStringField(
  source: Record<string, unknown> | null | undefined,
  ...keys: string[]
): string | undefined {
  if (!source) return undefined;

  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return undefined;
}

async function getCaptureFrameEvidence(sessionId: number): Promise<CaptureFrameEvidenceRow[]> {
  const result = await query<CaptureFrameEvidenceRow>(
    `SELECT
       frame_type   AS "frameType",
       quality_json AS quality
     FROM capture_frame
     WHERE capture_session_id = $1
     ORDER BY created_at DESC`,
    [sessionId]
  );

  return result.rows;
}

function collectCaptureEvidence(
  metadata: Record<string, unknown> | null,
  frames: CaptureFrameEvidenceRow[]
): CaptureEvidence {
  const answers = (metadata?.answers as Record<string, unknown> | undefined) ?? {};
  const brandFromAnswers =
    getStringField(answers.brand_shade as Record<string, unknown>, "brand")
    || getStringField(answers, "brand");
  const shadeFromAnswers =
    getStringField(answers.brand_shade as Record<string, unknown>, "shadeName", "name")
    || getStringField(answers, "shadeName", "name");
  const finishFromAnswers =
    getStringField(answers.brand_shade as Record<string, unknown>, "finish")
    || getStringField(answers, "finish");

  const evidence: CaptureEvidence = {
    gtin: getStringField(metadata, "gtin"),
    brand: brandFromAnswers || getStringField(metadata, "brand"),
    shadeName: shadeFromAnswers || getStringField(metadata, "shadeName", "name"),
    finish: finishFromAnswers || getStringField(metadata, "finish"),
  };

  for (const frame of frames) {
    const quality = frame.quality;
    if (!quality) continue;

    if (!evidence.gtin) {
      evidence.gtin = getStringField(quality, "gtin", "upc", "ean");
    }
    if (!evidence.brand) {
      evidence.brand = getStringField(quality, "brand");
    }
    if (!evidence.shadeName) {
      evidence.shadeName = getStringField(quality, "shadeName", "name");
    }
    if (!evidence.finish) {
      evidence.finish = getStringField(quality, "finish");
    }
  }

  return evidence;
}

function extractSelectedEntityId(answer: unknown): number | null {
  if (typeof answer === "number" && Number.isInteger(answer) && answer > 0) {
    return answer;
  }

  if (typeof answer === "string") {
    const trimmed = answer.trim();
    const parsedPrefixed = parseInt(trimmed.split(":")[0], 10);
    if (Number.isInteger(parsedPrefixed) && parsedPrefixed > 0) {
      return parsedPrefixed;
    }
    const parsed = parseInt(trimmed, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  if (typeof answer === "object" && answer !== null) {
    const shadeId = (answer as Record<string, unknown>).shadeId;
    if (typeof shadeId === "number" && Number.isInteger(shadeId) && shadeId > 0) {
      return shadeId;
    }
    if (typeof shadeId === "string") {
      const parsed = parseInt(shadeId, 10);
      if (Number.isInteger(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }

  return null;
}

function normalizeBrandShadeAnswer(answer: unknown): Record<string, unknown> {
  if (typeof answer === "object" && answer !== null) {
    const record = answer as Record<string, unknown>;
    return {
      brand: getStringField(record, "brand"),
      shadeName: getStringField(record, "shadeName", "name"),
      finish: getStringField(record, "finish"),
      raw: record.raw ?? answer,
    };
  }

  if (typeof answer === "string") {
    const raw = answer.trim();
    const split = raw
      .split(/\s+(?:-|—)\s+|\s*\|\s*|\s*,\s*/)
      .filter(Boolean);

    if (split.length >= 2) {
      return {
        brand: split[0],
        shadeName: split.slice(1).join(" "),
        raw,
      };
    }

    return {
      shadeName: raw || undefined,
      raw,
    };
  }

  return { raw: answer };
}

function normalizeAnswerForQuestion(questionKey: string, answer: unknown): unknown {
  if (questionKey === "brand_shade") {
    return normalizeBrandShadeAnswer(answer);
  }
  return answer;
}

async function resolveByBarcode(gtin: string): Promise<CaptureMatchCandidate | null> {
  const result = await query<{
    skuId: string;
    shadeId: string | null;
    brand: string | null;
    productName: string | null;
    shadeName: string | null;
  }>(
    `SELECT
       s.sku_id::text              AS "skuId",
       s.shade_id::text            AS "shadeId",
       b.name_canonical            AS brand,
       s.product_name              AS "productName",
       sh.shade_name_canonical     AS "shadeName"
     FROM barcode bc
     JOIN sku s ON bc.sku_id = s.sku_id
     LEFT JOIN brand b ON s.brand_id = b.brand_id
     LEFT JOIN shade sh ON s.shade_id = sh.shade_id
     WHERE bc.gtin = $1
     LIMIT 1`,
    [gtin]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  const display = [row.brand, row.productName || row.shadeName || `SKU ${row.skuId}`]
    .filter(Boolean)
    .join(" — ");

  return {
    entityType: "sku",
    entityId: parseInt(row.skuId, 10),
    display,
    confidence: 1,
  };
}

async function resolveShadeCandidates(evidence: CaptureEvidence): Promise<CaptureMatchCandidate[]> {
  if (!evidence.shadeName) {
    return [];
  }

  if (evidence.brand) {
    const result = await query<{
      shadeId: string;
      brand: string;
      shadeName: string;
      score: number;
    }>(
      `SELECT
         s.shade_id::text AS "shadeId",
         b.name_canonical AS brand,
         s.shade_name_canonical AS "shadeName",
         similarity(s.shade_name_canonical, $2) AS score
       FROM shade s
       JOIN brand b ON s.brand_id = b.brand_id
       WHERE s.status = 'active'
         AND b.name_canonical ILIKE $1
         AND (
           s.shade_name_canonical % $2
           OR similarity(s.shade_name_canonical, $2) >= 0.20
         )
       ORDER BY score DESC
       LIMIT 5`,
      [evidence.brand, evidence.shadeName]
    );

    return result.rows.map((row) => ({
      entityType: "shade",
      entityId: parseInt(row.shadeId, 10),
      display: `${row.brand} — ${row.shadeName}`,
      confidence: Math.max(0, Math.min(1, row.score)),
    }));
  }

  const result = await query<{
    shadeId: string;
    brand: string;
    shadeName: string;
    score: number;
  }>(
    `SELECT
       s.shade_id::text AS "shadeId",
       b.name_canonical AS brand,
       s.shade_name_canonical AS "shadeName",
       GREATEST(
         similarity(s.shade_name_canonical, $1),
         similarity(b.name_canonical, $1)
       ) AS score
     FROM shade s
     JOIN brand b ON s.brand_id = b.brand_id
     WHERE s.status = 'active'
       AND (
         s.shade_name_canonical % $1
         OR b.name_canonical % $1
         OR similarity(s.shade_name_canonical, $1) >= 0.20
       )
     ORDER BY score DESC
     LIMIT 5`,
    [evidence.shadeName]
  );

  return result.rows.map((row) => ({
    entityType: "shade",
    entityId: parseInt(row.shadeId, 10),
    display: `${row.brand} — ${row.shadeName}`,
    confidence: Math.max(0, Math.min(1, row.score)),
  }));
}

function buildNeedsFrameQuestion(): CaptureQuestionSpec {
  return {
    key: "capture_frame",
    prompt: "Upload at least one barcode or label frame so we can continue matching.",
    type: "single_select",
    options: ["scan_barcode", "upload_label_photo", "skip"],
  };
}

function buildBrandShadeQuestion(): CaptureQuestionSpec {
  return {
    key: "brand_shade",
    prompt: "Tell us the brand and shade name (or upload a clearer label frame) to improve matching.",
    type: "free_text",
    options: ["brand + shade", "upload_label_photo", "skip"],
  };
}

function buildCandidateQuestion(candidates: CaptureMatchCandidate[]): CaptureQuestionSpec {
  return {
    key: "candidate_select",
    prompt: "We found close shade matches. Reply with a shade ID from the options below, or skip.",
    type: "single_select",
    options: [
      ...candidates.map((candidate) => `${candidate.entityId}: ${candidate.display}`),
      "skip",
    ],
  };
}

async function resolveCaptureSession(session: CaptureSessionRow): Promise<ResolverOutcome> {
  const frames = await getCaptureFrameEvidence(session.id);
  const evidence = collectCaptureEvidence(session.metadata, frames);

  if (frames.length === 0) {
    return {
      status: "needs_question",
      confidence: 0,
      question: buildNeedsFrameQuestion(),
      metadataPatch: { resolver: { step: "awaiting_frames" } },
    };
  }

  if (evidence.gtin) {
    const barcodeMatch = await resolveByBarcode(evidence.gtin);
    if (barcodeMatch) {
      return {
        status: "matched",
        confidence: barcodeMatch.confidence,
        entityType: barcodeMatch.entityType,
        entityId: barcodeMatch.entityId,
        metadataPatch: {
          resolver: {
            step: "matched_by_barcode",
            gtin: evidence.gtin,
            display: barcodeMatch.display,
          },
        },
      };
    }
  }

  const shadeCandidates = await resolveShadeCandidates(evidence);
  const topCandidate = shadeCandidates[0];

  if (topCandidate && topCandidate.confidence >= 0.92) {
    return {
      status: "matched",
      confidence: topCandidate.confidence,
      entityType: topCandidate.entityType,
      entityId: topCandidate.entityId,
      metadataPatch: {
        resolver: {
          step: "matched_by_shade_similarity",
          topCandidate: topCandidate.display,
          candidateCount: shadeCandidates.length,
        },
      },
    };
  }

  if (topCandidate && topCandidate.confidence >= 0.75) {
    return {
      status: "needs_question",
      confidence: topCandidate.confidence,
      question: buildCandidateQuestion(shadeCandidates),
      metadataPatch: {
        resolver: {
          step: "needs_user_candidate_selection",
          candidateCount: shadeCandidates.length,
          topCandidate: topCandidate.display,
        },
      },
    };
  }

  if (!evidence.brand || !evidence.shadeName) {
    return {
      status: "needs_question",
      confidence: topCandidate?.confidence ?? 0,
      question: buildBrandShadeQuestion(),
      metadataPatch: {
        resolver: {
          step: "needs_brand_and_shade",
          brand: evidence.brand || null,
          shadeName: evidence.shadeName || null,
        },
      },
    };
  }

  return {
    status: "unmatched",
    confidence: topCandidate?.confidence ?? 0,
    metadataPatch: {
      resolver: {
        step: "unmatched_after_resolver",
        brand: evidence.brand,
        shadeName: evidence.shadeName,
      },
    },
  };
}

async function getCaptureSession(captureId: string, userId: number): Promise<CaptureSessionRow | null> {
  const result = await query<CaptureSessionRow>(
    `SELECT
       capture_session_id          AS id,
       capture_uuid::text          AS "captureId",
       status,
       top_confidence              AS "topConfidence",
       accepted_entity_type        AS "acceptedEntityType",
       accepted_entity_id::text    AS "acceptedEntityId",
       metadata
     FROM capture_session
     WHERE capture_uuid = $1::uuid
       AND user_id = $2`,
    [captureId, userId]
  );

  return result.rows[0] ?? null;
}

async function getOpenQuestion(sessionId: number): Promise<CaptureQuestionRow | undefined> {
  const result = await query<CaptureQuestionRow>(
    `SELECT
       capture_question_id::text AS id,
       question_key              AS key,
       prompt,
       question_type             AS type,
       options_json              AS options,
       status,
       created_at::text          AS "createdAt"
     FROM capture_question
     WHERE capture_session_id = $1
       AND status = 'open'
     ORDER BY created_at ASC
     LIMIT 1`,
    [sessionId]
  );

  return result.rows[0];
}

async function startCapture(
  request: HttpRequest,
  context: InvocationContext,
  userId: number
): Promise<HttpResponseInit> {
  context.log("POST /api/capture/start");

  try {
    let body: CaptureStartRequest = {};
    try {
      body = ((await request.json()) ?? {}) as CaptureStartRequest;
    } catch {
      body = {};
    }

    const captureId = randomUUID();

    const result = await query<{ captureId: string; status: CaptureStatus }>(
      `INSERT INTO capture_session (capture_uuid, user_id, status, metadata)
       VALUES ($1::uuid, $2, 'processing', $3::jsonb)
       RETURNING capture_uuid::text AS "captureId", status`,
      [captureId, userId, body.metadata ?? {}]
    );

    const response: CaptureStartResponse = {
      captureId: result.rows[0].captureId,
      status: result.rows[0].status,
      uploadUrls: [],
      guidanceConfig: {
        recommendedFrameTypes: [...GUIDANCE_CONFIG.recommendedFrameTypes],
        maxFrames: GUIDANCE_CONFIG.maxFrames,
      },
    };

    return { status: 201, jsonBody: response };
  } catch (error: any) {
    context.error("Error starting capture:", error);
    return { status: 500, jsonBody: { error: "Failed to start capture", details: error.message } };
  }
}

async function addCaptureFrame(
  request: HttpRequest,
  context: InvocationContext,
  userId: number
): Promise<HttpResponseInit> {
  context.log("POST /api/capture/{captureId}/frame");

  const captureId = request.params.captureId;
  if (!captureId) {
    return { status: 400, jsonBody: { error: "Capture id is required" } };
  }
  if (!isValidUuid(captureId)) {
    return { status: 400, jsonBody: { error: "Capture id must be a valid UUID" } };
  }

  try {
    let body: CaptureFrameRequest;
    try {
      body = (await request.json()) as CaptureFrameRequest;
    } catch {
      return { status: 400, jsonBody: { error: "Invalid JSON body" } };
    }

    if (!body?.frameType) {
      return { status: 400, jsonBody: { error: "frameType is required" } };
    }

    const validFrameTypes = new Set(["barcode", "label", "color", "other"]);
    if (!validFrameTypes.has(body.frameType)) {
      return { status: 400, jsonBody: { error: "frameType must be one of: barcode, label, color, other" } };
    }

    if (!body.imageId && !body.imageBlobUrl) {
      return { status: 400, jsonBody: { error: "Either imageId or imageBlobUrl is required" } };
    }

    const session = await getCaptureSession(captureId, userId);
    if (!session) {
      return { status: 404, jsonBody: { error: "Capture session not found" } };
    }

    if (session.status === "cancelled") {
      return { status: 409, jsonBody: { error: "Cannot add frames to a cancelled session" } };
    }

    const result = await transaction(async (client) => {
      let imageId = body.imageId ?? null;

      if (!imageId && body.imageBlobUrl) {
        const imageResult = await client.query<{ imageId: string }>(
          `INSERT INTO image_asset (owner_type, owner_id, storage_url, captured_at)
           VALUES ('user', $1, $2, now())
           RETURNING image_id::text AS "imageId"`,
          [userId, body.imageBlobUrl]
        );
        imageId = parseInt(imageResult.rows[0].imageId, 10);
      }

      const frameResult = await client.query<{ frameId: string }>(
        `INSERT INTO capture_frame (capture_session_id, image_id, frame_type, quality_json)
         VALUES ($1, $2, $3, $4::jsonb)
         RETURNING capture_frame_id::text AS "frameId"`,
        [session.id, imageId, body.frameType, body.quality ?? null]
      );

      await client.query(
        `UPDATE capture_session
         SET updated_at = now()
         WHERE capture_session_id = $1`,
        [session.id]
      );

      return frameResult.rows[0];
    });

    const response: CaptureFrameResponse = {
      received: true,
      captureId: session.captureId,
      frameId: result.frameId,
      status: session.status,
    };

    return { status: 201, jsonBody: response };
  } catch (error: any) {
    context.error("Error adding capture frame:", error);
    return { status: 500, jsonBody: { error: "Failed to save capture frame", details: error.message } };
  }
}

async function finalizeCapture(
  request: HttpRequest,
  context: InvocationContext,
  userId: number
): Promise<HttpResponseInit> {
  context.log("POST /api/capture/{captureId}/finalize");

  const captureId = request.params.captureId;
  if (!captureId) {
    return { status: 400, jsonBody: { error: "Capture id is required" } };
  }
  if (!isValidUuid(captureId)) {
    return { status: 400, jsonBody: { error: "Capture id must be a valid UUID" } };
  }

  try {
    const session = await getCaptureSession(captureId, userId);
    if (!session) {
      return { status: 404, jsonBody: { error: "Capture session not found" } };
    }

    if (session.status === "matched" || session.status === "unmatched" || session.status === "cancelled") {
      const existingQuestion = await getOpenQuestion(session.id);
      const response: CaptureFinalizeResponse = {
        captureId: session.captureId,
        status: session.status,
        question: toCaptureQuestion(existingQuestion),
      };
      return { status: 200, jsonBody: response };
    }
    const outcome = await resolveCaptureSession(session);

    if (outcome.status === "matched") {
      await transaction(async (client) => {
        await client.query(
          `UPDATE capture_question
           SET status = 'expired'
           WHERE capture_session_id = $1
             AND status = 'open'`,
          [session.id]
        );

        await client.query(
          `UPDATE capture_session
           SET status = 'matched',
               top_confidence = $2,
               accepted_entity_type = $3,
               accepted_entity_id = $4,
               metadata = COALESCE(metadata, '{}'::jsonb) || $5::jsonb,
               updated_at = now()
           WHERE capture_session_id = $1`,
          [session.id, outcome.confidence, outcome.entityType, outcome.entityId, outcome.metadataPatch]
        );
      });

      const response: CaptureFinalizeResponse = {
        captureId: session.captureId,
        status: "matched",
      };
      return { status: 200, jsonBody: response };
    }

    if (outcome.status === "needs_question") {
      const question = await transaction(async (client) => {
        await client.query(
          `UPDATE capture_question
           SET status = 'expired'
           WHERE capture_session_id = $1
             AND status = 'open'`,
          [session.id]
        );

        await client.query(
          `UPDATE capture_session
           SET status = 'needs_question',
               top_confidence = $2,
               accepted_entity_type = NULL,
               accepted_entity_id = NULL,
               metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
               updated_at = now()
           WHERE capture_session_id = $1`,
          [session.id, outcome.confidence, outcome.metadataPatch]
        );

        const inserted = await client.query<CaptureQuestionRow>(
          `INSERT INTO capture_question
             (capture_session_id, question_key, prompt, question_type, options_json, status)
           VALUES ($1, $2, $3, $4, $5::jsonb, 'open')
           RETURNING
             capture_question_id::text AS id,
             question_key              AS key,
             prompt,
             question_type             AS type,
             options_json              AS options,
             status,
             created_at::text          AS "createdAt"`,
          [
            session.id,
            outcome.question.key,
            outcome.question.prompt,
            outcome.question.type,
            outcome.question.options ?? null,
          ]
        );

        return inserted.rows[0];
      });

      const response: CaptureFinalizeResponse = {
        captureId: session.captureId,
        status: "needs_question",
        question: toCaptureQuestion(question),
      };
      return { status: 200, jsonBody: response };
    }

    await transaction(async (client) => {
      await client.query(
        `UPDATE capture_question
         SET status = 'expired'
         WHERE capture_session_id = $1
           AND status = 'open'`,
        [session.id]
      );

      await client.query(
        `UPDATE capture_session
         SET status = 'unmatched',
             top_confidence = $2,
             accepted_entity_type = NULL,
             accepted_entity_id = NULL,
             metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
             updated_at = now()
         WHERE capture_session_id = $1`,
        [session.id, outcome.confidence, outcome.metadataPatch]
      );
    });

    const response: CaptureFinalizeResponse = {
      captureId: session.captureId,
      status: "unmatched",
    };
    return { status: 200, jsonBody: response };
  } catch (error: any) {
    context.error("Error finalizing capture:", error);
    return { status: 500, jsonBody: { error: "Failed to finalize capture", details: error.message } };
  }
}

async function getCaptureStatus(
  request: HttpRequest,
  context: InvocationContext,
  userId: number
): Promise<HttpResponseInit> {
  context.log("GET /api/capture/{captureId}/status");

  const captureId = request.params.captureId;
  if (!captureId) {
    return { status: 400, jsonBody: { error: "Capture id is required" } };
  }
  if (!isValidUuid(captureId)) {
    return { status: 400, jsonBody: { error: "Capture id must be a valid UUID" } };
  }

  try {
    const session = await getCaptureSession(captureId, userId);
    if (!session) {
      return { status: 404, jsonBody: { error: "Capture session not found" } };
    }

    const question = await getOpenQuestion(session.id);

    const response: CaptureStatusResponse = {
      captureId: session.captureId,
      status: session.status,
      topConfidence: parseNumeric(session.topConfidence),
      acceptedEntityType: session.acceptedEntityType || undefined,
      acceptedEntityId: session.acceptedEntityId || undefined,
      metadata: session.metadata || undefined,
      question: toCaptureQuestion(question),
    };

    return { status: 200, jsonBody: response };
  } catch (error: any) {
    context.error("Error fetching capture status:", error);
    return { status: 500, jsonBody: { error: "Failed to fetch capture status", details: error.message } };
  }
}

async function answerCaptureQuestion(
  request: HttpRequest,
  context: InvocationContext,
  userId: number
): Promise<HttpResponseInit> {
  context.log("POST /api/capture/{captureId}/answer");

  const captureId = request.params.captureId;
  if (!captureId) {
    return { status: 400, jsonBody: { error: "Capture id is required" } };
  }
  if (!isValidUuid(captureId)) {
    return { status: 400, jsonBody: { error: "Capture id must be a valid UUID" } };
  }

  try {
    let body: CaptureAnswerRequest;
    try {
      body = (await request.json()) as CaptureAnswerRequest;
    } catch {
      return { status: 400, jsonBody: { error: "Invalid JSON body" } };
    }
    if (body?.answer === undefined) {
      return { status: 400, jsonBody: { error: "answer is required" } };
    }
    let requestedQuestionId: number | null = null;
    if (body.questionId !== undefined) {
      requestedQuestionId = parseInt(body.questionId, 10);
      if (!Number.isInteger(requestedQuestionId) || requestedQuestionId <= 0) {
        return { status: 400, jsonBody: { error: "questionId must be a positive integer when provided" } };
      }
    }

    const session = await getCaptureSession(captureId, userId);
    if (!session) {
      return { status: 404, jsonBody: { error: "Capture session not found" } };
    }

    const openQuestion = await (async () => {
      if (body.questionId) {
        const result = await query<CaptureQuestionRow>(
          `SELECT
             capture_question_id::text AS id,
             question_key              AS key,
             prompt,
             question_type             AS type,
             options_json              AS options,
             status,
             created_at::text          AS "createdAt"
           FROM capture_question
           WHERE capture_question_id = $1
             AND capture_session_id = $2
             AND status = 'open'`,
          [requestedQuestionId, session.id]
        );
        return result.rows[0];
      }
      return getOpenQuestion(session.id);
    })();

    if (!openQuestion) {
      return { status: 404, jsonBody: { error: "No open question found for this capture session" } };
    }

    const normalizedAnswer = normalizeAnswerForQuestion(openQuestion.key, body.answer);
    const answerJson = JSON.stringify(normalizedAnswer);

    let updatedStatus: CaptureStatus = "processing";

    await transaction(async (client) => {
      await client.query(
        `INSERT INTO capture_answer (capture_question_id, user_id, answer_json)
         VALUES ($1, $2, $3::jsonb)`,
        [parseInt(openQuestion.id, 10), userId, answerJson]
      );

      await client.query(
        `UPDATE capture_question
         SET status = CASE WHEN $2::jsonb = '"skip"'::jsonb THEN 'skipped' ELSE 'answered' END
         WHERE capture_question_id = $1`,
        [parseInt(openQuestion.id, 10), answerJson]
      );

      const selectedShadeId =
        openQuestion.key === "candidate_select"
          ? extractSelectedEntityId(normalizedAnswer)
          : null;

      if (selectedShadeId && body.answer !== "skip") {
        updatedStatus = "matched";
        await client.query(
          `UPDATE capture_session
           SET status = 'matched',
               top_confidence = 1,
               accepted_entity_type = 'shade',
               accepted_entity_id = $2,
               metadata = COALESCE(metadata, '{}'::jsonb)
                 || jsonb_build_object(
                      'answers',
                      COALESCE(metadata->'answers', '{}'::jsonb)
                        || jsonb_build_object($3::text, $4::jsonb)
                    ),
               updated_at = now()
           WHERE capture_session_id = $1`,
          [session.id, selectedShadeId, openQuestion.key, answerJson]
        );

        await client.query(
          `UPDATE capture_question
           SET status = 'expired'
           WHERE capture_session_id = $1
             AND status = 'open'`,
          [session.id]
        );
        return;
      }

      await client.query(
        `UPDATE capture_session
         SET status = 'processing',
             metadata = COALESCE(metadata, '{}'::jsonb)
               || jsonb_build_object(
                    'answers',
                    COALESCE(metadata->'answers', '{}'::jsonb)
                      || jsonb_build_object($2::text, $3::jsonb)
                  ),
             updated_at = now()
         WHERE capture_session_id = $1`,
        [session.id, openQuestion.key, answerJson]
      );
    });

    const nextQuestion = await getOpenQuestion(session.id);
    const response: CaptureAnswerResponse = {
      captureId: session.captureId,
      status: updatedStatus,
      question: toCaptureQuestion(nextQuestion),
    };

    return { status: 200, jsonBody: response };
  } catch (error: any) {
    context.error("Error answering capture question:", error);
    return { status: 500, jsonBody: { error: "Failed to answer capture question", details: error.message } };
  }
}

app.http("capture-start", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "capture/start",
  handler: withAuth(startCapture),
});

app.http("capture-frame", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "capture/{captureId}/frame",
  handler: withAuth(addCaptureFrame),
});

app.http("capture-finalize", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "capture/{captureId}/finalize",
  handler: withAuth(finalizeCapture),
});

app.http("capture-status", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "capture/{captureId}/status",
  handler: withAuth(getCaptureStatus),
});

app.http("capture-answer", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "capture/{captureId}/answer",
  handler: withAuth(answerCaptureQuestion),
});
