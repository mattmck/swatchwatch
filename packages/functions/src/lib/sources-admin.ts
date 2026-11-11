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
import type {
  AdminSourceListItem,
  IngestionJobStatus,
} from "swatchwatch-shared";
import { isRunnableProtocol, materializesShadeProductsByName, protocolOfName } from "./connectors/registry";
import { sourceKindFromMetadata } from "./source-settings";

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
      /** The request changes nothing: the handler skips the UPDATE and the audit row. */
      noop?: boolean;
    }
  | { ok: false; status: 400 | 409; code: string; error: string };

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TEXT_LENGTH = 500;
const TRACKED_KEYS = ["permission", "enabled", "imagesPermitted", "pendingApproval", "notes"] as const;

export function isFetchableSource(name: string): boolean {
  return isRunnableProtocol(protocolOfName(name));
}

/**
 * Whether a store's OK applies: open-data sources (MakeupAPI, OpenBeautyFacts) are fetchable but are not
 * a store's catalog, so they need none.
 */
export function needsStoreOk(name: string): boolean {
  return isFetchableSource(name) && materializesShadeProductsByName(name);
}

/** The name shown for a source: a non-empty `metadata.brand`, else the connector name without its suffix. */
export function sourceListName(name: string, metadata: Record<string, unknown> | null): string {
  const brand = metadata?.brand;
  return typeof brand === "string" && brand.trim() !== "" ? brand.trim() : sourceDisplayName(name);
}

/** ISO-8601 UTC text of a timestamptz column, for the Sources/Brands API responses. */
export function isoUtcSql(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
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
    case "not_needed": {
      const checkedAt = dateField(body.checkedAt, "checkedAt");
      if (!checkedAt.ok) return checkedAt;
      const summary = textField(body.summary, "summary", false);
      if (!summary.ok) return summary;
      const value: AdminSourcePermissionRequest = { action: "not_needed", checkedAt: checkedAt.value };
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
      return { ok: false, error: "action must be one of asked, granted, declined, not_needed, images" };
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
    kind: sourceKindFromMetadata(state.metadata),
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
      permission.imagesGranted = false;
      metadata.permission = permission;
      metadata.imagesPermitted = false;
      enabled = false;
      break;
    }
    case "not_needed": {
      const permission: SourcePermission = { status: "not_needed", decidedAt: req.checkedAt, ...recorded };
      if (req.summary !== undefined) permission.summary = req.summary;
      metadata.permission = permission;
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

  if (state.enabled === req.enabled) {
    return {
      ok: true,
      metadata: { ...state.metadata },
      enabled: state.enabled,
      action: req.enabled ? "data_source.enable" : "data_source.disable",
      changes: {},
      noop: true,
    };
  }

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

export interface SourceAdminRow {
  dataSourceId: number | string;
  name: string;
  baseUrl: string | null;
  enabled: boolean;
  metadata: Record<string, unknown> | null;
  lastJobId: number | string | null;
  lastJobStatus: IngestionJobStatus | null;
  lastJobStartedAt: string | null;
  lastJobFinishedAt: string | null;
  lastJobProcessed: number | string | null;
  liveListings: number | string | null;
  shades: number | string | null;
}

/** One query for every source (ordered by name), or one source when `byId`. */
export function sourcesAdminSql(byId: boolean): string {
  return `SELECT ds.data_source_id AS "dataSourceId",
       ds.name,
       ds.base_url AS "baseUrl",
       ds.enabled,
       ds.metadata,
       lj.ingestion_job_id AS "lastJobId",
       lj.status AS "lastJobStatus",
       ${isoUtcSql("lj.started_at")} AS "lastJobStartedAt",
       ${isoUtcSql("lj.finished_at")} AS "lastJobFinishedAt",
       (lj.metrics_json->>'processed')::int AS "lastJobProcessed",
       (SELECT count(*) FROM external_product ep
         WHERE ep.data_source_id = ds.data_source_id AND ep.missing_since IS NULL) AS "liveListings",
       (SELECT count(DISTINCT s.shade_id)
          FROM external_product ep
          JOIN shade_source_product ssp ON ssp.external_product_id = ep.external_product_id
          JOIN shade s ON s.shade_id = ssp.shade_id AND s.merged_into_shade_id IS NULL
         WHERE ep.data_source_id = ds.data_source_id) AS shades
     FROM data_source ds
     LEFT JOIN LATERAL (
       SELECT j.ingestion_job_id, j.status, j.started_at, j.finished_at, j.metrics_json
       FROM ingestion_job j
       WHERE j.data_source_id = ds.data_source_id
       ORDER BY j.started_at DESC, j.ingestion_job_id DESC
       LIMIT 1
     ) lj ON true
     ${byId ? "WHERE ds.data_source_id = $1" : ""}
     ORDER BY ds.name ASC`;
}

export const SOURCES_ADMIN_LIST_SQL = sourcesAdminSql(false);

export function toAdminSourceListItem(row: SourceAdminRow): AdminSourceListItem {
  const metadata = row.metadata ?? {};
  const kind = sourceKindFromMetadata(metadata);
  const fetchable = isFetchableSource(row.name);
  const derived = deriveSourcePermission({
    metadata,
    enabled: row.enabled,
    fetchable: needsStoreOk(row.name),
    kind,
  });
  const verification = isRecord(metadata.verification) ? metadata.verification : {};
  const processed = row.lastJobProcessed;
  return {
    dataSourceId: Number(row.dataSourceId),
    name: row.name,
    displayName: sourceListName(row.name, metadata),
    baseUrl: row.baseUrl,
    kind,
    connector: protocolOfName(row.name),
    fetchable,
    enabled: row.enabled,
    permission: derived.permission,
    permissionStored: derived.stored,
    onWithoutOk: row.enabled && needsStoreOk(row.name) && !isPermissionOk(derived.permission.status),
    imagesPermitted:
      typeof metadata.imagesPermitted === "boolean" ? metadata.imagesPermitted : kind === "brand",
    currency: typeof metadata.currency === "string" ? metadata.currency : null,
    termsScrapingClause:
      typeof verification.termsScrapingClause === "boolean" ? verification.termsScrapingClause : null,
    termsCheckedAt: typeof verification.checkedAt === "string" ? verification.checkedAt : null,
    lastJob:
      row.lastJobId === null
        ? null
        : {
            jobId: String(row.lastJobId),
            status: row.lastJobStatus as IngestionJobStatus,
            startedAt: row.lastJobStartedAt,
            finishedAt: row.lastJobFinishedAt,
            recordsProcessed: processed === null || processed === undefined ? null : Number(processed),
          },
    liveListings: Number(row.liveListings ?? 0),
    shades: Number(row.shades ?? 0),
  };
}
