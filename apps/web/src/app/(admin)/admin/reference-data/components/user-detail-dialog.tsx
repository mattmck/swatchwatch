"use client";

import { useEffect, useState } from "react";
import type { AdminAuditEvent, AdminUserDetailResponse, AdminUserUpdateRequest } from "swatchwatch-shared";
import { toast } from "sonner";
import { getAdminUser, updateAdminUser } from "@/lib/api";
import { configuredEntraTenantId, entraUserAdminUrl, passwordResetInstructions } from "@/lib/entra-admin-links";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

/** Editable fields of the detail form. */
export interface UserEditForm {
  handle: string;
  suspended: boolean;
  suspendedReason: string;
  note: string;
}

export function toUserEditForm(detail: AdminUserDetailResponse): UserEditForm {
  return {
    handle: detail.user.handle ?? "",
    suspended: detail.user.state === "suspended",
    suspendedReason: detail.suspendedReason ?? "",
    note: "",
  };
}

/**
 * Build the `PATCH /api/users-admin/{id}` body from the form, sending only changed fields.
 *
 * @param detail The loaded user (the "before" state).
 * @param form Current form values.
 * @returns The request body, or `null` when nothing changed.
 */
export function buildUserUpdateRequest(
  detail: AdminUserDetailResponse,
  form: UserEditForm
): AdminUserUpdateRequest | null {
  const before = toUserEditForm(detail);
  const request: AdminUserUpdateRequest = {};
  const handle = form.handle.trim();
  const reason = form.suspendedReason.trim();

  if (handle && handle !== before.handle) request.handle = handle;
  if (form.suspended !== before.suspended) {
    request.suspended = form.suspended;
    if (form.suspended && reason) request.suspendedReason = reason;
  } else if (form.suspended && reason !== before.suspendedReason) {
    request.suspendedReason = reason || null;
  }

  if (Object.keys(request).length === 0) return null;
  if (form.note.trim()) request.note = form.note.trim();
  return request;
}

const ACTION_LABELS: Record<AdminAuditEvent["action"], string> = {
  "user.update": "Updated",
  "user.suspend": "Suspended",
  "user.unsuspend": "Reactivated",
  "user.merge": "Merged account into this one",
};

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

/**
 * One-line summary of an audit event's changes, e.g. `handle: old → new`.
 *
 * @param event Audit row from the detail response.
 */
export function describeAuditChanges(event: AdminAuditEvent): string {
  if (event.action === "user.merge") {
    const source = event.changes.sourceUserId;
    const email = event.changes.sourceEmail;
    return `from user #${formatValue(source)}${email ? ` (${String(email)})` : ""}`;
  }
  return Object.entries(event.changes)
    .map(([field, change]) => {
      if (change && typeof change === "object" && "from" in change && "to" in change) {
        const { from, to } = change as { from: unknown; to: unknown };
        return `${field}: ${formatValue(from)} → ${formatValue(to)}`;
      }
      return `${field}: ${formatValue(change)}`;
    })
    .join("; ");
}

export function formatDateTime(value: string | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/**
 * Admin detail panel for one user (issue #45): state, auth linkage, edit form (handle,
 * suspend / reactivate with reason, audit note), linked identities and audit history.
 * Role is read-only (assigned in Entra). Password reset hands off to the sign-in provider: copyable
 * instructions for the user, plus an Entra admin center link per linked identity.
 */
export function UserDetailDialog({
  userId,
  currentUserId,
  onClose,
  onUpdated,
}: {
  userId: number | null;
  currentUserId: number | null;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const [detail, setDetail] = useState<AdminUserDetailResponse | null>(null);
  const [form, setForm] = useState<UserEditForm | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const entraTenantId = configuredEntraTenantId();

  async function copyResetInstructions() {
    try {
      await navigator.clipboard.writeText(passwordResetInstructions());
      toast.success("Reset instructions copied");
    } catch {
      toast.error("Couldn't copy. Try again, or tell the user to choose “Forgot password?” on the sign-in page.");
    }
  }

  useEffect(() => {
    // The parent keys this component by user id, so state starts empty for every user.
    if (userId === null) return;
    let active = true;
    getAdminUser(userId)
      .then((response) => {
        if (!active) return;
        setDetail(response);
        setForm(toUserEditForm(response));
      })
      .catch((error: unknown) => {
        if (active) setLoadError(error instanceof Error ? error.message : "Failed to load user");
      });
    return () => {
      active = false;
    };
  }, [userId]);

  const isSelf = detail !== null && currentUserId !== null && detail.user.userId === currentUserId;
  const pendingRequest = detail && form ? buildUserUpdateRequest(detail, form) : null;

  async function handleSave() {
    if (!detail || !form || !pendingRequest) return;
    if (pendingRequest.suspended === true) {
      const label = detail.user.email ?? detail.user.handle ?? `#${detail.user.userId}`;
      if (!window.confirm(`Suspend ${label}? They will be blocked from the app until reactivated.`)) return;
    }
    try {
      setSaving(true);
      setSaveError(null);
      setSaveMessage(null);
      const response = await updateAdminUser(detail.user.userId, pendingRequest);
      setDetail(response);
      setForm(toUserEditForm(response));
      setSaveMessage("Saved.");
      onUpdated();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={userId !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>User #{userId}</DialogTitle>
          <DialogDescription>
            {detail ? (detail.user.email ?? detail.user.handle ?? "No email on file") : "Loading…"}
          </DialogDescription>
        </DialogHeader>

        {loadError && <p className="text-sm text-destructive">{loadError}</p>}

        {detail && form && (
          <div className="space-y-5 text-sm">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              <dt className="text-muted-foreground">State</dt>
              <dd>
                {detail.user.state === "suspended" ? (
                  <span>
                    <Badge variant="destructive">Suspended</Badge>{" "}
                    {formatDateTime(detail.user.suspendedAt)}
                    {detail.suspendedByUserId ? ` by #${detail.suspendedByUserId}` : ""}
                    {detail.suspendedReason ? ` — ${detail.suspendedReason}` : ""}
                  </span>
                ) : (
                  <Badge variant="secondary">Active</Badge>
                )}
              </dd>
              <dt className="text-muted-foreground">Role</dt>
              <dd>
                <Badge variant="outline">{detail.user.role}</Badge>{" "}
                <span className="text-xs text-muted-foreground">Assigned in Entra (app role “admin”), synced on sign-in</span>
              </dd>
              <dt className="text-muted-foreground">Auth</dt>
              <dd>
                {detail.user.externalId ? "Subject linked" : "No subject"} · {detail.identities.length} linked{" "}
                {detail.identities.length === 1 ? "identity" : "identities"}
              </dd>
              <dt className="text-muted-foreground">Created</dt>
              <dd>{formatDateTime(detail.user.createdAt)}</dd>
              <dt className="text-muted-foreground">Last seen</dt>
              <dd>{formatDateTime(detail.user.lastSeenAt)}</dd>
              <dt className="text-muted-foreground">Activity</dt>
              <dd>
                {detail.user.inventoryCount} inventory · {detail.user.submissionCount} submissions ·{" "}
                {detail.user.captureSessionCount} captures
              </dd>
            </dl>

            <section className="space-y-3 rounded-md border p-3">
              <h4 className="font-medium">Edit</h4>
              <label className="block space-y-1">
                <span className="text-muted-foreground">Handle</span>
                <Input
                  value={form.handle}
                  maxLength={64}
                  onChange={(event) => setForm({ ...form, handle: event.target.value })}
                />
              </label>
              <div className="flex items-center gap-3">
                <Switch
                  id="user-suspended"
                  checked={form.suspended}
                  disabled={isSelf}
                  onCheckedChange={(checked) => setForm({ ...form, suspended: checked })}
                />
                <label htmlFor="user-suspended">Suspended</label>
                {isSelf && <span className="text-xs text-muted-foreground">You can’t suspend your own account.</span>}
              </div>
              {form.suspended && (
                <label className="block space-y-1">
                  <span className="text-muted-foreground">Suspension reason (optional)</span>
                  <Input
                    value={form.suspendedReason}
                    maxLength={500}
                    onChange={(event) => setForm({ ...form, suspendedReason: event.target.value })}
                  />
                </label>
              )}
              <label className="block space-y-1">
                <span className="text-muted-foreground">Audit note (optional)</span>
                <Input
                  value={form.note}
                  maxLength={500}
                  placeholder="Why this change? Stored in the audit log."
                  onChange={(event) => setForm({ ...form, note: event.target.value })}
                />
              </label>
              {saveError && <p className="text-destructive">{saveError}</p>}
              {saveMessage && <p className="text-muted-foreground">{saveMessage}</p>}
            </section>

            <section className="space-y-2">
              <h4 className="font-medium">Password</h4>
              <p className="text-xs text-muted-foreground">
                SwatchWatch doesn’t store passwords. Each sign-in uses one method and that method’s own reset: email +
                password accounts use “Forgot password?” on the Microsoft sign-in page (Microsoft emails a code); Google
                and Facebook accounts reset with Google or Facebook. To lock someone out, use Suspend.
              </p>
              <Button type="button" variant="outline" size="sm" onClick={() => void copyResetInstructions()}>
                Copy reset instructions for the user
              </Button>
              <p className="text-xs text-muted-foreground">
                To reset an email + password account yourself, open it in the Entra admin center and choose Reset
                password: Entra creates a temporary password for you to pass on, and records the reset in its own audit
                log (not the SwatchWatch history below). Google and Facebook sign-ins have nothing to reset there.
              </p>
            </section>

            <section className="space-y-2">
              <h4 className="font-medium">Linked identities</h4>
              {detail.identities.length === 0 ? (
                <p className="text-muted-foreground">None.</p>
              ) : (
                <ul className="space-y-1">
                  {detail.identities.map((identity) => (
                    <li key={identity.externalId} className="rounded border px-2 py-1">
                      <div className="break-all font-mono text-xs">{identity.externalId}</div>
                      <div className="text-xs text-muted-foreground">
                        {identity.email ?? "no email"} · linked {formatDateTime(identity.createdAt)} · last seen{" "}
                        {formatDateTime(identity.lastSeenAt)}
                      </div>
                      {(() => {
                        const adminUrl = entraUserAdminUrl(entraTenantId, identity.externalId);
                        return adminUrl ? (
                          <a
                            href={adminUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs underline underline-offset-2"
                          >
                            Open in Entra admin center
                          </a>
                        ) : null;
                      })()}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="space-y-2">
              <h4 className="font-medium">Audit history</h4>
              {detail.auditEvents.length === 0 ? (
                <p className="text-muted-foreground">No admin actions recorded.</p>
              ) : (
                <ul className="space-y-1">
                  {detail.auditEvents.map((event) => (
                    <li key={event.auditEventId} className="rounded border px-2 py-1">
                      <div>
                        <span className="font-medium">{ACTION_LABELS[event.action] ?? event.action}</span>{" "}
                        <span className="text-muted-foreground">
                          by {event.actorLabel ?? `#${event.actorUserId}`} · {formatDateTime(event.createdAt)}
                        </span>
                      </div>
                      <div className="text-xs text-muted-foreground">{describeAuditChanges(event)}</div>
                      {event.note && <div className="text-xs">Note: {event.note}</div>}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button onClick={() => void handleSave()} disabled={!pendingRequest || saving}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
