"use client";

import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import { toast } from "sonner";
import {
  SOURCE_PERMISSION_CHANNELS,
  SOURCE_RUN_DEFAULTS,
  isPermissionOk,
  type AdminSourceDetailResponse,
  type AdminSourceListItem,
  type AdminSourcePermissionRequest,
  type IngestionSourceName,
  type SourcePermissionChannel,
} from "swatchwatch-shared";
import { ApiError, getAdminSource, runIngestionJob, setAdminSourceEnabled, updateAdminSourcePermission } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { historyDetail } from "@/lib/sources-admin-view";
import { CONNECTOR_LABELS, KIND_LABELS, PermissionChip, relativeTime, todayIso } from "./sites-table";

type Mode = "asked" | "granted" | "declined" | "not_needed" | null;
type Confirm = "turn-on" | "turn-off" | null;

const CHANNEL_LABELS: Record<SourcePermissionChannel, string> = {
  email: "Email",
  dm: "DM",
  form: "Contact form",
  phone: "Phone",
  other: "Other",
};

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function runErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body as { message?: string; error?: string } | undefined;
    return body?.message ?? body?.error ?? errorMessage(err, "Could not start the run.");
  }
  return errorMessage(err, "Could not start the run.");
}

function errorCode(err: unknown): string | undefined {
  return err instanceof ApiError ? (err.body as { code?: string } | undefined)?.code : undefined;
}

const isActive = (status: string | undefined) => status === "queued" || status === "running";

/** Side panel for one data source. Remount (key = source id) when another source opens. */
export function SitePanel({
  source,
  onClose,
  onChange,
}: {
  source: AdminSourceListItem;
  onClose: () => void;
  onChange: (source: AdminSourceListItem) => void;
}) {
  const [detail, setDetail] = useState<AdminSourceDetailResponse | null>(null);
  const [mode, setMode] = useState<Mode>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  const [showNotes, setShowNotes] = useState(false);

  const perm = source.permission;
  const [date, setDate] = useState(todayIso());
  const [grantedBy, setGrantedBy] = useState(perm.grantedBy ?? "");
  const [channel, setChannel] = useState<SourcePermissionChannel>(perm.channel ?? "email");
  const [summary, setSummary] = useState(perm.summary ?? "");
  const [imagesGranted, setImagesGranted] = useState(perm.imagesGranted ?? source.kind === "brand");

  const apply = useCallback(
    (res: AdminSourceDetailResponse) => {
      setDetail(res);
      onChange(res.source);
    },
    [onChange]
  );

  useEffect(() => {
    let cancelled = false;
    getAdminSource(source.dataSourceId)
      .then((res) => { if (!cancelled) setDetail(res); })
      .catch((err) => { if (!cancelled) setError(errorMessage(err, "Could not load the source history.")); });
    return () => { cancelled = true; };
  }, [source.dataSourceId]);

  // After Run, and while the latest job is queued/running, refresh every 5 s; stops on unmount.
  const jobActive = isActive(source.lastJob?.status);
  useEffect(() => {
    if (!polling && !jobActive) return;
    const timer = setInterval(() => {
      getAdminSource(source.dataSourceId)
        .then((res) => {
          apply(res);
          if (!isActive(res.source.lastJob?.status)) setPolling(false);
        })
        .catch(() => undefined);
    }, 5000);
    return () => clearInterval(timer);
  }, [polling, jobActive, source.dataSourceId, apply]);

  const write = async (fn: () => Promise<AdminSourceDetailResponse>, success: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      apply(await fn());
      toast.success(success);
      return true;
    } catch (err) {
      setError(errorMessage(err, "The change failed."));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const savePermission = async (body: AdminSourcePermissionRequest, success: string) => {
    if (await write(() => updateAdminSourcePermission(source.dataSourceId, body), success)) setMode(null);
  };

  const turnOn = async (override: boolean) => {
    setConfirm(null);
    setBusy(true);
    setError(null);
    try {
      apply(await setAdminSourceEnabled(source.dataSourceId, { enabled: true, ...(override ? { override: true } : {}) }));
      toast.success(`${source.displayName} is on`);
    } catch (err) {
      if (errorCode(err) === "permission_required") setConfirm("turn-on");
      else setError(errorMessage(err, "Could not turn the source on."));
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async () => {
    setConfirm(null);
    await write(() => setAdminSourceEnabled(source.dataSourceId, { enabled: false }), `${source.displayName} is off`);
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await runIngestionJob({ source: source.name as IngestionSourceName, ...SOURCE_RUN_DEFAULTS });
      toast.success(`Queued ${source.displayName}`);
      setPolling(true);
      apply(await getAdminSource(source.dataSourceId));
    } catch (err) {
      setError(runErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const openMode = (next: Mode) => {
    setError(null);
    setMode(next);
    setDate(todayIso());
    setGrantedBy("");
    setChannel("email");
    setSummary("");
    setImagesGranted(source.kind === "brand");
    if (next === "granted" && perm.status === "granted") {
      setGrantedBy(perm.grantedBy ?? "");
      setChannel(perm.channel ?? "email");
      setSummary(perm.summary ?? "");
      setImagesGranted(perm.imagesGranted ?? source.imagesPermitted);
      if (perm.decidedAt) setDate(perm.decidedAt);
    }
  };

  const turnOnPrompt =
    perm.status === "declined"
      ? `${source.displayName} declined on ${perm.decidedAt ?? "an unrecorded date"}. Turn on anyway?`
      : `No OK on record for ${source.displayName}. Turn on anyway?`;

  const grantedAlready = perm.status === "granted";

  return (
    <aside aria-label={`${source.displayName} details`} className="w-full shrink-0 space-y-4 rounded-lg border p-4 text-sm lg:w-80">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-base font-semibold">{source.displayName}</h3>
          <p className="break-all text-xs text-muted-foreground">{source.name}</p>
          <p className="text-muted-foreground">
            {KIND_LABELS[source.kind]} · {CONNECTOR_LABELS[source.connector] ?? source.connector}
            {source.currency ? ` · ${source.currency}` : ""}
            {source.fetchable ? ` · ${source.enabled ? "on" : "off"}` : ""}
          </p>
          {source.baseUrl && (
            <a href={source.baseUrl} target="_blank" rel="noopener noreferrer" className="break-all text-primary underline-offset-2 hover:underline">
              {source.baseUrl}
            </a>
          )}
          <p className="mt-1 text-muted-foreground">
            Terms:{" "}
            {source.termsScrapingClause === null ? "not checked" : source.termsScrapingClause ? "has an automated-access clause" : "no automated-access clause"}
            {source.termsCheckedAt ? ` (checked ${source.termsCheckedAt.slice(0, 10)})` : ""}
          </p>
        </div>
        <Button variant="ghost" size="icon" aria-label="Close panel" onClick={onClose}><X /></Button>
      </div>

      {!source.fetchable ? (
        <p className="text-muted-foreground">This source is not a store we fetch from, so it has no permission or on/off setting.</p>
      ) : (
        <>
          <div className="space-y-2 border-t pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">Permission</span>
              <PermissionChip permission={perm} />
            </div>
            {perm.status === "granted" && (
              <p className="text-muted-foreground">
                {perm.grantedBy ? `${perm.grantedBy}, ` : ""}{perm.decidedAt ?? ""}{perm.channel ? ` via ${CHANNEL_LABELS[perm.channel]}` : ""}
                {perm.summary ? `: ${perm.summary}` : ""}
              </p>
            )}
            {perm.status === "declined" && (
              <p className="text-muted-foreground">{perm.decidedAt ?? ""}{perm.summary ? `: ${perm.summary}` : ""}</p>
            )}

            {mode === null && (
              <div className="flex flex-wrap gap-2">
                {!grantedAlready && <Button size="sm" variant="outline" onClick={() => openMode("asked")}>Mark asked</Button>}
                <Button size="sm" variant={grantedAlready ? "outline" : "default"} onClick={() => openMode("granted")}>
                  {grantedAlready ? "Edit OK" : "Record OK"}
                </Button>
                <Button size="sm" variant="outline" onClick={() => openMode("declined")}>Record decline</Button>
                {perm.status !== "not_needed" && (
                  <Button size="sm" variant="outline" onClick={() => openMode("not_needed")}>No OK needed</Button>
                )}
              </div>
            )}

            {mode === "asked" && (
              <div className="space-y-2">
                <label className="block space-y-1">
                  <span className="text-muted-foreground">Date asked</span>
                  <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                </label>
                <div className="flex gap-2">
                  <Button size="sm" disabled={busy || !date} onClick={() => savePermission({ action: "asked", askedAt: date }, "Marked asked")}>Mark asked</Button>
                  <Button size="sm" variant="outline" onClick={() => setMode(null)}>Cancel</Button>
                </div>
              </div>
            )}

            {mode === "granted" && (
              <div className="space-y-2">
                <label className="block space-y-1">
                  <span className="text-muted-foreground">Who said yes</span>
                  <Input value={grantedBy} onChange={(e) => setGrantedBy(e.target.value)} placeholder="Anna, owner" />
                </label>
                <label className="block space-y-1">
                  <span className="text-muted-foreground">Date</span>
                  <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                </label>
                <div className="space-y-1">
                  <span className="text-muted-foreground">How</span>
                  <Select value={channel} onValueChange={(v) => setChannel(v as SourcePermissionChannel)}>
                    <SelectTrigger aria-label="Channel"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {SOURCE_PERMISSION_CHANNELS.map((c) => <SelectItem key={c} value={c}>{CHANNEL_LABELS[c]}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <label className="block space-y-1">
                  <span className="text-muted-foreground">What they agreed to</span>
                  <Input value={summary} onChange={(e) => setSummary(e.target.value)} />
                </label>
                <label className="flex items-center gap-2">
                  <Switch checked={imagesGranted} onCheckedChange={setImagesGranted} aria-label="Images allowed too" />
                  <span>Images allowed too</span>
                </label>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={busy || !grantedBy.trim() || !summary.trim() || !date}
                    onClick={() =>
                      savePermission(
                        { action: "granted", decidedAt: date, grantedBy: grantedBy.trim(), channel, summary: summary.trim(), imagesGranted },
                        grantedAlready ? "Saved" : "Recorded the OK"
                      )
                    }
                  >
                    {grantedAlready ? "Save" : "Record OK & turn on"}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setMode(null)}>Cancel</Button>
                </div>
              </div>
            )}

            {mode === "not_needed" && (
              <div className="space-y-2">
                <label className="block space-y-1">
                  <span className="text-muted-foreground">Date checked</span>
                  <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                </label>
                <label className="block space-y-1">
                  <span className="text-muted-foreground">Note</span>
                  <Input value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="e.g. terms checked, no automated-access clause" />
                </label>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={busy || !date}
                    onClick={() =>
                      savePermission(
                        { action: "not_needed", checkedAt: date, ...(summary.trim() ? { summary: summary.trim() } : {}) },
                        "Recorded: no OK needed"
                      )
                    }
                  >
                    No OK needed
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setMode(null)}>Cancel</Button>
                </div>
              </div>
            )}

            {mode === "declined" && (
              <div className="space-y-2">
                <label className="block space-y-1">
                  <span className="text-muted-foreground">Date</span>
                  <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                </label>
                <div className="space-y-1">
                  <span className="text-muted-foreground">How</span>
                  <Select value={channel} onValueChange={(v) => setChannel(v as SourcePermissionChannel)}>
                    <SelectTrigger aria-label="Channel"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {SOURCE_PERMISSION_CHANNELS.map((c) => <SelectItem key={c} value={c}>{CHANNEL_LABELS[c]}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <label className="block space-y-1">
                  <span className="text-muted-foreground">Note</span>
                  <Input value={summary} onChange={(e) => setSummary(e.target.value)} />
                </label>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={busy || !date}
                    onClick={() =>
                      savePermission(
                        { action: "declined", decidedAt: date, channel, ...(summary.trim() ? { summary: summary.trim() } : {}) },
                        "Recorded the decline"
                      )
                    }
                  >
                    Record decline
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setMode(null)}>Cancel</Button>
                </div>
              </div>
            )}

            {grantedAlready && (
              <label className="flex items-center gap-2">
                <Switch
                  checked={source.imagesPermitted}
                  disabled={busy}
                  aria-label="Images allowed"
                  onCheckedChange={(checked) => { void write(() => updateAdminSourcePermission(source.dataSourceId, { action: "images", imagesGranted: checked }), checked ? "Images allowed" : "Images not allowed"); }}
                />
                <span>Images allowed</span>
              </label>
            )}
          </div>

          <div className="flex flex-wrap gap-2 border-t pt-3">
            {source.enabled ? (
              <>
                <Button size="sm" disabled={busy || isActive(source.lastJob?.status)} onClick={run}>
                  {isActive(source.lastJob?.status) ? `Job ${source.lastJob?.status}…` : "Run ingestion"}
                </Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirm("turn-off")}>Turn off</Button>
              </>
            ) : (
              <Button size="sm" disabled={busy} onClick={() => (isPermissionOk(perm.status) ? turnOn(false) : setConfirm("turn-on"))}>Turn on</Button>
            )}
          </div>
        </>
      )}

      {error && <p role="alert" className="text-destructive">{error}</p>}

      {detail?.notes && (
        <div className="border-t pt-3">
          <button type="button" className="font-medium" aria-expanded={showNotes} onClick={() => setShowNotes((v) => !v)}>
            Notes {showNotes ? "▾" : "▸"}
          </button>
          {showNotes && <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{detail.notes}</p>}
        </div>
      )}

      <div className="border-t pt-3">
        <p className="font-medium">History</p>
        {!detail ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : detail.history.length === 0 ? (
          <p className="text-muted-foreground">No changes recorded.</p>
        ) : (
          <ul className="space-y-1">
            {[...detail.history]
              .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
              .map((h) => (
                <li key={h.auditEventId} className="text-muted-foreground">
                  {h.createdAt.slice(0, 10)} {h.action.replace("data_source.", "")} by {h.actorLabel ?? `#${h.actorUserId}`} ({relativeTime(h.createdAt)}){historyDetail(h.changes)}
                </li>
              ))}
          </ul>
        )}
      </div>

      <Dialog open={confirm === "turn-on"} onOpenChange={(open) => !open && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Turn on {source.displayName}?</DialogTitle>
            <DialogDescription>{turnOnPrompt}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)}>Cancel</Button>
            <Button onClick={() => turnOn(true)}>Turn on anyway</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirm === "turn-off"} onOpenChange={(open) => !open && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Turn off {source.displayName}?</DialogTitle>
            <DialogDescription>
              Listings from {source.displayName} stop counting for buy links and prices until it is turned on again. Shades and images stay.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)}>Cancel</Button>
            <Button variant="destructive" onClick={turnOff}>Turn off</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
