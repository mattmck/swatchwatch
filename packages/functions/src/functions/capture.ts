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

    const frameCountResult = await query<{ totalFrames: string }>(
      `SELECT COUNT(*)::text AS "totalFrames"
       FROM capture_frame
       WHERE capture_session_id = $1`,
      [session.id]
    );

    const totalFrames = parseInt(frameCountResult.rows[0]?.totalFrames || "0", 10);

    if (totalFrames === 0) {
      const questionResult = await transaction(async (client) => {
        const inserted = await client.query<CaptureQuestionRow>(
          `INSERT INTO capture_question
             (capture_session_id, question_key, prompt, question_type, options_json, status)
           SELECT
             $1,
             'capture_frame',
             'Upload at least one barcode or label frame so we can continue matching.',
             'single_select',
             '["scan_barcode","upload_label_photo","skip"]'::jsonb,
             'open'
           WHERE NOT EXISTS (
             SELECT 1 FROM capture_question
             WHERE capture_session_id = $1
               AND status = 'open'
               AND question_key = 'capture_frame'
           )
           RETURNING
             capture_question_id::text AS id,
             question_key              AS key,
             prompt,
             question_type             AS type,
             options_json              AS options,
             status,
             created_at::text          AS "createdAt"`,
          [session.id]
        );

        const question = inserted.rows[0] ?? (await client.query<CaptureQuestionRow>(
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
          [session.id]
        )).rows[0];

        await client.query(
          `UPDATE capture_session
           SET status = 'needs_question',
               top_confidence = 0,
               updated_at = now()
           WHERE capture_session_id = $1`,
          [session.id]
        );

        return question;
      });

      const response: CaptureFinalizeResponse = {
        captureId: session.captureId,
        status: "needs_question",
        question: toCaptureQuestion(questionResult),
      };

      return { status: 200, jsonBody: response };
    }

    await query(
      `UPDATE capture_session
       SET status = 'processing',
           updated_at = now()
       WHERE capture_session_id = $1`,
      [session.id]
    );

    const response: CaptureFinalizeResponse = {
      captureId: session.captureId,
      status: "processing",
    };

    return { status: 202, jsonBody: response };
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
    const answerJson = JSON.stringify(body.answer);

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

      await client.query(
        `UPDATE capture_session
         SET status = 'processing',
             updated_at = now()
         WHERE capture_session_id = $1`,
        [session.id]
      );
    });

    const nextQuestion = await getOpenQuestion(session.id);
    const response: CaptureAnswerResponse = {
      captureId: session.captureId,
      status: "processing",
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
