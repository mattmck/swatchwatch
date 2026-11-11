import {
  SOURCE_PERMISSION_CHANNELS,
  deriveSourcePermission,
  isPermissionOk,
  sourceDisplayName,
  type AdminAuditAction,
  type AdminSourceEnabledRequest,
  type AdminSourcePermissionRequest,
  type SourcePermission,
  type SourcePermissionChannel,
} from "swatchwatch-shared";
import { isRunnableProtocol, protocolOfName } from "./connectors/registry";

export interface SourceState {
  name: string;
  enabled: boolean;
  metadata: Record<string, unknown>;
}

export type PlanResult =
  | {
      ok: true;
      metadata: Record<string, unknown>;
      enabled: boolean;
      action: AdminAuditAction;
      changes: Record<string, unknown>;
    }
  | { ok: false; status: 400 | 409; code: string; error: string };

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TEXT_LENGTH = 500;
const TRACKED_KEYS = ["permission", "enabled", "imagesPermitted", "pendingApproval", "notes"] as const;

export function isFetchableSource(name: string): boolean {
  return isRunnableProtocol(protocolOfName(name));
}

export function grantNoteSentence(p: {
  grantedBy: string;
  displayName: string;
  decidedAt: string;
  channel: string;
  summary: string;
}): string {
  return `Acceptable use confirmed by ${p.grantedBy} at ${p.displayName} on ${p.decidedAt} via ${p.channel}: ${p.summary}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dateField(value: unknown, label: string): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
    return { ok: false, error: `${label} must be a date as YYYY-MM-DD` };
  }
  return { ok: true, value };
}

function textField(
  value: unknown,
  label: string,
  required: boolean,
): { ok: true; value: string | undefined } | { ok: false; error: string } {
  if (value === undefined || value === null) {
    return required ? { ok: false, error: `${label} is required` } : { ok: true, value: undefined };
  }
  if (typeof value !== "string") return { ok: false, error: `${label} must be a string` };
  const trimmed = value.trim();
  if (trimmed === "") {
    return required ? { ok: false, error: `${label} is required` } : { ok: true, value: undefined };
  }
  if (trimmed.length > MAX_TEXT_LENGTH) {
    return { ok: false, error: `${label} must be at most ${MAX_TEXT_LENGTH} characters` };
  }
  return { ok: true, value: trimmed };
}

function channelField(
  value: unknown,
): { ok: true; value: SourcePermissionChannel } | { ok: false; error: string } {
  if ((SOURCE_PERMISSION_CHANNELS as readonly unknown[]).includes(value)) {
    return { ok: true, value: value as SourcePermissionChannel };
  }
  return { ok: false, error: `channel must be one of ${SOURCE_PERMISSION_CHANNELS.join(", ")}` };
}

export function parsePermissionRequest(
  body: unknown,
): { ok: true; value: AdminSourcePermissionRequest } | { ok: false; error: string } {
  if (!isRecord(body)) return { ok: false, error: "Request body must be a JSON object" };

  switch (body.action) {
    case "asked": {
      const askedAt = dateField(body.askedAt, "askedAt");
      if (!askedAt.ok) return askedAt;
      return { ok: true, value: { action: "asked", askedAt: askedAt.value } };
    }
    case "granted": {
      const decidedAt = dateField(body.decidedAt, "decidedAt");
      if (!decidedAt.ok) return decidedAt;
      const grantedBy = textField(body.grantedBy, "grantedBy", true);
      if (!grantedBy.ok) return grantedBy;
      const channel = channelField(body.channel);
      if (!channel.ok) return channel;
      const summary = textField(body.summary, "summary", true);
      if (!summary.ok) return summary;
      if (typeof body.imagesGranted !== "boolean") {
        return { ok: false, error: "imagesGranted must be a boolean" };
      }
      return {
        ok: true,
        value: {
          action: "granted",
          decidedAt: decidedAt.value,
          grantedBy: grantedBy.value as string,
          channel: channel.value,
          summary: summary.value as string,
          imagesGranted: body.imagesGranted,
        },
      };
    }
    case "declined": {
      const decidedAt = dateField(body.decidedAt, "decidedAt");
      if (!decidedAt.ok) return decidedAt;
      const channel = channelField(body.channel);
      if (!channel.ok) return channel;
      const summary = textField(body.summary, "summary", false);
      if (!summary.ok) return summary;
      const value: AdminSourcePermissionRequest = {
        action: "declined",
        decidedAt: decidedAt.value,
        channel: channel.value,
      };
      if (summary.value !== undefined) value.summary = summary.value;
      return { ok: true, value };
    }
    case "images": {
      if (typeof body.imagesGranted !== "boolean") {
        return { ok: false, error: "imagesGranted must be a boolean" };
      }
      return { ok: true, value: { action: "images", imagesGranted: body.imagesGranted } };
    }
    default:
      return { ok: false, error: "action must be one of asked, granted, declined, images" };
  }
}

function notFetchable(): PlanResult {
  return {
    ok: false,
    status: 409,
    code: "not_fetchable",
    error: "This source has no automated connector, so permission and on/off do not apply",
  };
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** `{ field: { from, to } }` for every tracked key whose value differs between the two states. */
function diffChanges(
  before: { enabled: boolean; metadata: Record<string, unknown> },
  after: { enabled: boolean; metadata: Record<string, unknown> },
): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  for (const key of TRACKED_KEYS) {
    const from = key === "enabled" ? before.enabled : (before.metadata[key] ?? null);
    const to = key === "enabled" ? after.enabled : (after.metadata[key] ?? null);
    if (!sameValue(from, to)) changes[key] = { from, to };
  }
  return changes;
}

function currentStatus(state: SourceState) {
  return deriveSourcePermission({
    metadata: state.metadata,
    enabled: state.enabled,
    fetchable: true,
  });
}

export function planPermissionChange(
  state: SourceState,
  req: AdminSourcePermissionRequest,
  actorUserId: number,
  nowIso: string,
): PlanResult {
  if (!isFetchableSource(state.name)) return notFetchable();

  const current = currentStatus(state);
  const recorded = { recordedByUserId: actorUserId, recordedAt: nowIso };
  const metadata: Record<string, unknown> = { ...state.metadata };
  let enabled = state.enabled;
  let action: AdminAuditAction = "data_source.permission";

  switch (req.action) {
    case "asked": {
      metadata.permission = { status: "asked", askedAt: req.askedAt, ...recorded } satisfies SourcePermission;
      break;
    }
    case "declined": {
      const permission: SourcePermission = {
        status: "declined",
        decidedAt: req.decidedAt,
        channel: req.channel,
        ...recorded,
      };
      if (req.summary !== undefined) permission.summary = req.summary;
      if (current.permission.askedAt !== undefined) permission.askedAt = current.permission.askedAt;
      metadata.permission = permission;
      enabled = false;
      break;
    }
    case "granted": {
      const permission: SourcePermission = {
        status: "granted",
        decidedAt: req.decidedAt,
        grantedBy: req.grantedBy,
        channel: req.channel,
        summary: req.summary,
        imagesGranted: req.imagesGranted,
        ...recorded,
      };
      if (current.permission.askedAt !== undefined) permission.askedAt = current.permission.askedAt;
      const alreadyGranted = current.permission.status === "granted";
      metadata.permission = permission;
      metadata.imagesPermitted = req.imagesGranted;
      if (!alreadyGranted) {
        enabled = true;
        delete metadata.pendingApproval;
        const sentence = grantNoteSentence({
          grantedBy: req.grantedBy,
          displayName: sourceDisplayName(state.name),
          decidedAt: req.decidedAt,
          channel: req.channel,
          summary: req.summary,
        });
        const existing = typeof state.metadata.notes === "string" ? state.metadata.notes.trim() : "";
        metadata.notes = existing === "" ? sentence : `${existing} ${sentence}`;
      }
      break;
    }
    case "images": {
      if (current.permission.status !== "granted") {
        return {
          ok: false,
          status: 409,
          code: "not_granted",
          error: "Images can be switched only on a source whose permission is granted",
        };
      }
      metadata.permission = { ...current.permission, imagesGranted: req.imagesGranted, ...recorded };
      metadata.imagesPermitted = req.imagesGranted;
      action = "data_source.images";
      break;
    }
  }

  return {
    ok: true,
    metadata,
    enabled,
    action,
    changes: diffChanges(state, { enabled, metadata }),
  };
}

export function planEnabledChange(state: SourceState, req: AdminSourceEnabledRequest): PlanResult {
  if (!isFetchableSource(state.name)) return notFetchable();

  if (!req.enabled) {
    return {
      ok: true,
      metadata: { ...state.metadata },
      enabled: false,
      action: "data_source.disable",
      changes: diffChanges(state, { enabled: false, metadata: state.metadata }),
    };
  }

  const { permission } = currentStatus(state);
  const needsOverride = !isPermissionOk(permission.status);
  if (needsOverride && req.override !== true) {
    return {
      ok: false,
      status: 409,
      code: "permission_required",
      error: `This source has no recorded OK (permission: ${permission.status}); confirm to turn it on anyway`,
    };
  }

  const metadata: Record<string, unknown> = { ...state.metadata };
  delete metadata.pendingApproval;
  const changes = diffChanges(state, { enabled: true, metadata });
  if (needsOverride) {
    changes.override = true;
    changes.permissionStatus = permission.status;
  }
  return { ok: true, metadata, enabled: true, action: "data_source.enable", changes };
}
