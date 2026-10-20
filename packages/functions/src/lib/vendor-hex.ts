import type { PoolClient } from "pg";
import type { HexLabelPromoteResponse, VendorHexSource } from "swatchwatch-shared";
import { recordAdminAuditEvent } from "./admin-users";

/**
 * `shade.vendor_hex` provenance (#321, decision D12; migration
 * 20261020024540860_shade-vendor-hex-provenance).
 *
 * An admin may promote a shade's manual ground-truth label (`color_training_sample`,
 * `source_type = 'manual'`) to its `vendor_hex`. The promoted value is marked
 * `vendor_hex_source = 'manual_label'` and **ingestion never overwrites it**: re-ingesting the
 * product only records the vendor's latest hex in `vendor_hex_previous`, which Undo restores.
 * Deleting the promoted label keeps the hex (the FK is ON DELETE SET NULL).
 */

export const VENDOR_HEX_SOURCE_VENDOR: VendorHexSource = "vendor";
export const VENDOR_HEX_SOURCE_MANUAL_LABEL: VendorHexSource = "manual_label";

export interface ShadeVendorHexState {
  vendorHex: string | null;
  vendorHexSource: VendorHexSource | null;
  vendorHexPrevious: string | null;
}

export interface IngestedVendorHexPlan extends ShadeVendorHexState {
  /** True when `vendor_hex` itself changes (the ingest stamps `vendor_hex_set_at`). */
  vendorHexChanged: boolean;
}

function asSource(value: unknown): VendorHexSource | null {
  return value === "vendor" || value === "manual_label" ? value : null;
}

/**
 * What an ingest writes to the vendor hex columns. Pure.
 *
 * `overwrite` is the connector's rule for vendor data: true replaces a stored hex with a new
 * non-null one, false only fills an empty one. A `manual_label` hex is never replaced; the
 * incoming vendor hex goes to `vendor_hex_previous` under the same rule, so Undo restores
 * current vendor data.
 */
export function planIngestedVendorHex(
  current: ShadeVendorHexState | null,
  incoming: string | null,
  overwrite: boolean
): IngestedVendorHexPlan {
  const state: ShadeVendorHexState = current
    ? { ...current, vendorHexSource: asSource(current.vendorHexSource) }
    : { vendorHex: null, vendorHexSource: null, vendorHexPrevious: null };

  if (state.vendorHexSource === VENDOR_HEX_SOURCE_MANUAL_LABEL) {
    const previous =
      incoming && (overwrite || state.vendorHexPrevious === null) ? incoming : state.vendorHexPrevious;
    return { ...state, vendorHexPrevious: previous, vendorHexChanged: false };
  }

  const vendorHex = incoming && (overwrite || state.vendorHex === null) ? incoming : state.vendorHex;
  const vendorHexSource = incoming && vendorHex === incoming ? VENDOR_HEX_SOURCE_VENDOR : state.vendorHexSource;
  return {
    vendorHex,
    vendorHexSource,
    vendorHexPrevious: state.vendorHexPrevious,
    vendorHexChanged: vendorHex !== state.vendorHex,
  };
}

/** Columns an ingest reads (inside its transaction, `FOR UPDATE`) before planning. */
export const SHADE_VENDOR_HEX_COLUMNS = `vendor_hex AS "vendorHex",
       vendor_hex_source AS "vendorHexSource",
       vendor_hex_previous AS "vendorHexPrevious"`;

/**
 * SET fragment for an ingest's shade UPDATE, writing a `planIngestedVendorHex` result:
 * `vendorHexParam` (e.g. `$3`) holds `plan.vendorHex`; `$first`, `$first+1`, `$first+2` hold
 * `ingestedVendorHexParams(plan)` (source, previous, changed flag).
 */
export function ingestedVendorHexSetSql(vendorHexParam: string, firstParam: number): string {
  const p = (offset: number) => `$${firstParam + offset}`;
  return `vendor_hex = ${vendorHexParam}::text,
         vendor_hex_source = ${p(0)}::text,
         vendor_hex_previous = ${p(1)}::text,
         vendor_hex_set_at = CASE WHEN ${p(2)}::boolean THEN now() ELSE vendor_hex_set_at END`;
}

/** The `$first…$first+2` values for `ingestedVendorHexSetSql` (vendor_hex itself goes in its own param). */
export function ingestedVendorHexParams(plan: IngestedVendorHexPlan): [string | null, string | null, boolean] {
  return [plan.vendorHexSource, plan.vendorHexPrevious, plan.vendorHexChanged];
}

// ── Promote / undo (admin) ──────────────────────────────────────────────────

interface LockedLabelRow {
  labelId: string;
  shadeId: string;
  hex: string | null;
  trainingStatus: string | null;
}

interface LockedShadeRow {
  shadeId: string;
  status: string | null;
  vendorHex: string | null;
  vendorHexSource: string | null;
  vendorHexLabelId: string | null;
  vendorHexPrevious: string | null;
}

export type PromotionResult =
  | { ok: true; body: HexLabelPromoteResponse }
  | { ok: false; status: 404 | 409; error: string };

const LOCK_SHADE_SQL = `SELECT shade_id::text AS "shadeId",
         status,
         vendor_hex AS "vendorHex",
         vendor_hex_source AS "vendorHexSource",
         vendor_hex_label_id::text AS "vendorHexLabelId",
         vendor_hex_previous AS "vendorHexPrevious"
       FROM shade
       WHERE shade_id = $1
       FOR UPDATE`;

const PROMOTION_RETURNING = `shade_id::text AS "shadeId",
         vendor_hex AS "vendorHex",
         vendor_hex_source AS "vendorHexSource",
         vendor_hex_label_id::text AS "vendorHexLabelId",
         vendor_hex_previous AS "vendorHexPrevious"`;

function toResponse(row: Omit<LockedShadeRow, "status">, changed: boolean): HexLabelPromoteResponse {
  const source = asSource(row.vendorHexSource);
  const promoted = source === VENDOR_HEX_SOURCE_MANUAL_LABEL;
  return {
    shadeId: row.shadeId,
    vendorHex: row.vendorHex,
    vendorHexSource: source,
    promotedLabelId: promoted ? row.vendorHexLabelId : null,
    vendorHexPrevious: promoted ? row.vendorHexPrevious : null,
    changed,
  };
}

async function lockManualLabel(client: Pick<PoolClient, "query">, labelId: number): Promise<LockedLabelRow | null> {
  const result = await client.query<LockedLabelRow>(
    `SELECT training_sample_id::text AS "labelId",
            shade_id::text AS "shadeId",
            hex,
            training_status AS "trainingStatus"
     FROM color_training_sample
     WHERE training_sample_id = $1
       AND source_type = 'manual'
       AND shade_id IS NOT NULL
     FOR UPDATE`,
    [labelId]
  );
  return result.rows[0] ?? null;
}

/**
 * Promote a manual label's hex to its shade's `vendor_hex`, inside the caller's transaction.
 * 404: not a manual label. 409: the label is flagged unreliable (`rejected`), has no hex, or the
 * shade is a private `user_submitted` one. Idempotent: promoting the already-promoted label with
 * an unchanged hex changes nothing and writes no audit row. Promoting again after the label was
 * re-saved with a new hex updates `vendor_hex` and keeps the original `vendor_hex_previous`.
 */
export async function promoteManualLabel(
  client: Pick<PoolClient, "query">,
  labelId: number,
  adminUserId: number
): Promise<PromotionResult> {
  const label = await lockManualLabel(client, labelId);
  if (!label) return { ok: false, status: 404, error: "Label not found" };
  if (label.trainingStatus === "rejected") {
    return { ok: false, status: 409, error: "Label is flagged unreliable and cannot be promoted" };
  }
  if (label.trainingStatus !== "approved" || !label.hex) {
    return { ok: false, status: 409, error: "Label has no approved hex to promote" };
  }

  const shade = (await client.query<LockedShadeRow>(LOCK_SHADE_SQL, [label.shadeId])).rows[0];
  if (!shade) return { ok: false, status: 404, error: "Shade not found" };
  if (shade.status === "user_submitted") {
    return { ok: false, status: 409, error: "Private user-submitted shades cannot be promoted" };
  }

  const alreadyPromoted = shade.vendorHexSource === VENDOR_HEX_SOURCE_MANUAL_LABEL;
  if (alreadyPromoted && shade.vendorHexLabelId === label.labelId && shade.vendorHex === label.hex) {
    return { ok: true, body: toResponse(shade, false) };
  }
  // A repeat promotion keeps the vendor hex the first one replaced.
  const previous = alreadyPromoted ? shade.vendorHexPrevious : shade.vendorHex;

  const updated = await client.query<Omit<LockedShadeRow, "status">>(
    `UPDATE shade
     SET vendor_hex = $2,
         vendor_hex_source = 'manual_label',
         vendor_hex_label_id = $3,
         vendor_hex_set_by_user_id = $4,
         vendor_hex_set_at = now(),
         vendor_hex_previous = $5,
         updated_at = now()
     WHERE shade_id = $1
     RETURNING ${PROMOTION_RETURNING}`,
    [shade.shadeId, label.hex, label.labelId, adminUserId, previous]
  );

  await recordAdminAuditEvent(client, {
    actorUserId: adminUserId,
    targetUserId: null,
    action: "shade.vendor_hex_promote",
    changes: {
      shadeId: shade.shadeId,
      labelId: label.labelId,
      vendorHex: { from: shade.vendorHex, to: label.hex },
      vendorHexSource: { from: shade.vendorHexSource, to: VENDOR_HEX_SOURCE_MANUAL_LABEL },
    },
  });

  return { ok: true, body: toResponse(updated.rows[0], true) };
}

/**
 * Undo a promotion on a shade, inside the caller's transaction: restore `vendor_hex_previous`
 * (`vendor_hex_source` back to `vendor`, or NULL when there was no vendor hex) and clear the
 * provenance. A no-op (changed: false, no audit row) when the shade is not promoted.
 */
export async function demoteShadeVendorHex(
  client: Pick<PoolClient, "query">,
  shadeId: number | string,
  adminUserId: number
): Promise<PromotionResult> {
  const shade = (await client.query<LockedShadeRow>(LOCK_SHADE_SQL, [shadeId])).rows[0];
  if (!shade) return { ok: false, status: 404, error: "Shade not found" };
  if (shade.vendorHexSource !== VENDOR_HEX_SOURCE_MANUAL_LABEL) {
    return { ok: true, body: toResponse(shade, false) };
  }

  const restoredSource = shade.vendorHexPrevious ? VENDOR_HEX_SOURCE_VENDOR : null;
  const updated = await client.query<Omit<LockedShadeRow, "status">>(
    `UPDATE shade
     SET vendor_hex = $2,
         vendor_hex_source = $3,
         vendor_hex_label_id = NULL,
         vendor_hex_set_by_user_id = NULL,
         vendor_hex_set_at = now(),
         vendor_hex_previous = NULL,
         updated_at = now()
     WHERE shade_id = $1
     RETURNING ${PROMOTION_RETURNING}`,
    [shade.shadeId, shade.vendorHexPrevious, restoredSource]
  );

  await recordAdminAuditEvent(client, {
    actorUserId: adminUserId,
    targetUserId: null,
    action: "shade.vendor_hex_demote",
    changes: {
      shadeId: shade.shadeId,
      labelId: shade.vendorHexLabelId,
      vendorHex: { from: shade.vendorHex, to: shade.vendorHexPrevious },
      vendorHexSource: { from: shade.vendorHexSource, to: restoredSource },
    },
  });

  return { ok: true, body: toResponse(updated.rows[0], true) };
}

/** Undo the promotion of a manual label (404 when it is not a manual label). */
export async function demoteManualLabel(
  client: Pick<PoolClient, "query">,
  labelId: number,
  adminUserId: number
): Promise<PromotionResult> {
  const label = await lockManualLabel(client, labelId);
  if (!label) return { ok: false, status: 404, error: "Label not found" };
  return demoteShadeVendorHex(client, label.shadeId, adminUserId);
}
